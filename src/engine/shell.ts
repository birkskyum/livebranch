import {Bash, MountableFs, defineCommand, type IFileSystem} from 'just-bash/browser';
import {loadClosure, resolveContext} from './build.ts';
import {runNodeScript} from './node-run.ts';
import {dirname, normalize, resolve} from './path.ts';
import type {Env, Project, ScriptIo} from './project.ts';
import {tsc} from './tsc.ts';
import type {FileData, Vfs} from './vfs.ts';

/** Where the project is mounted in the shell. The shell keeps its own `/bin`, `/tmp` and so on. */
export const MOUNT = '/project';

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface Shell {
    exec(command: string, io?: ScriptIo): Promise<ExecResult>;
}

function fail(code: string, call: string, path: string): Error {
    const text = {ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory', ENOSYS: 'function not implemented'}[code];
    return Object.assign(new Error(`${code}: ${text}, ${call} '${path}'`), {code});
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (data: FileData) => typeof data === 'string' ? encoder.encode(data) : data;
const string = (data: FileData) => typeof data === 'string' ? data : decoder.decode(data);

/** The project's files as a just-bash file system. A file that is not loaded is fetched on first read. */
function projectFs(vfs: Vfs): IFileSystem {
    const epoch = new Date(0);
    async function read(target: string): Promise<FileData> {
        const path = normalize(target);
        if (vfs.isDirectory(path)) throw fail('EISDIR', 'read', path);
        await vfs.load([path]);
        const data = vfs.read(path);
        if (data === undefined) throw fail('ENOENT', 'open', path);
        return data;
    }
    async function stat(target: string) {
        const path = normalize(target);
        const isFile = vfs.isFile(path);
        if (!isFile && !vfs.isDirectory(path)) throw fail('ENOENT', 'stat', path);
        const data = isFile ? vfs.read(path) : undefined;
        return {isFile, isDirectory: !isFile, isSymbolicLink: false, mode: isFile ? 0o644 : 0o755, size: data === undefined ? 0 : bytes(data).length, mtime: epoch};
    }
    async function copy(from: string, to: string): Promise<void> {
        const [source, target] = [normalize(from), normalize(to)];
        if (vfs.isFile(source)) return vfs.write(target, await read(source));
        if (!vfs.isDirectory(source)) throw fail('ENOENT', 'cp', source);
        for (const path of vfs.paths()) {
            if (path.startsWith(`${source}/`)) vfs.write(target + path.slice(source.length), await read(path));
        }
    }
    return {
        readFile: async path => string(await read(path)),
        readFileBuffer: async path => bytes(await read(path)),
        async writeFile(path, content) {
            vfs.write(normalize(path), content);
        },
        async appendFile(path, content) {
            const before = vfs.isFile(normalize(path)) ? await read(path) : '';
            vfs.write(normalize(path), typeof before === 'string' && typeof content === 'string' ? before + content : new Uint8Array([...bytes(before), ...bytes(content)]));
        },
        exists: async path => vfs.isFile(normalize(path)) || vfs.isDirectory(normalize(path)),
        stat,
        lstat: stat,
        async mkdir(target, options) {
            const path = normalize(target);
            if (vfs.isFile(path)) throw fail('ENOTDIR', 'mkdir', path);
            if (!options?.recursive && !vfs.isDirectory(dirname(path))) throw fail('ENOENT', 'mkdir', path);
            vfs.makeDirectory(path);
        },
        async readdir(target) {
            const entries = vfs.readDirectory(normalize(target));
            if (!entries) throw fail(vfs.isFile(normalize(target)) ? 'ENOTDIR' : 'ENOENT', 'scandir', target);
            return entries.map(entry => entry.name).sort();
        },
        async readdirWithFileTypes(target) {
            const entries = vfs.readDirectory(normalize(target));
            if (!entries) throw fail('ENOENT', 'scandir', target);
            return entries.map(entry => ({name: entry.name, isFile: entry.kind === 'file', isDirectory: entry.kind === 'directory', isSymbolicLink: false}))
                .sort((a, b) => a.name < b.name ? -1 : 1);
        },
        async rm(target, options) {
            const path = normalize(target);
            if (!vfs.isFile(path) && !vfs.isDirectory(path)) {
                if (options?.force) return;
                throw fail('ENOENT', 'rm', path);
            }
            vfs.remove(path);
        },
        cp: copy,
        async mv(from, to) {
            await copy(from, to);
            vfs.remove(normalize(from));
        },
        resolvePath: (base, path) => resolve(base, path),
        getAllPaths: () => vfs.paths(),
        async chmod() {},
        async utimes() {},
        async symlink(_target, path) {
            throw fail('ENOSYS', 'symlink', path);
        },
        async link(_existing, path) {
            throw fail('ENOSYS', 'link', path);
        },
        async readlink(path) {
            throw fail('ENOSYS', 'readlink', path);
        },
        realpath: async path => normalize(path),
    };
}

/** The project path of a shell path. A path outside the mount has none. */
function projectPath(shellPath: string): string | undefined {
    if (shellPath === MOUNT) return '/';
    return shellPath.startsWith(`${MOUNT}/`) ? shellPath.slice(MOUNT.length) : undefined;
}

/** A bash over the project, with `node`, `tsc` and `npm run` backed by the engine. */
export function createShell(project: Project, env: Env): Shell {
    const {vfs} = project;
    let io: ScriptIo | undefined;

    /** Collects a command's output and also streams it to the caller of `exec`. */
    function output() {
        let stdout = '';
        let stderr = '';
        return {
            io: {
                stdout(text: string) {
                    stdout += text;
                    io?.stdout(text);
                },
                stderr(text: string) {
                    stderr += text;
                    io?.stderr(text);
                },
            },
            result: (exitCode: number) => ({stdout, stderr, exitCode}),
        };
    }

    const outside = (name: string) => ({stdout: '', stderr: `${name}: the working directory is outside ${MOUNT}\n`, exitCode: 1});

    const node = defineCommand('node', async (args, ctx) => {
        const cwd = projectPath(ctx.cwd);
        if (cwd === undefined) return outside('node');
        const script = args.find(arg => !arg.startsWith('-'));
        if (!script) return {stdout: '', stderr: 'node: a script path is required\n', exitCode: 1};
        const out = output();
        return out.result(await runNodeScript(project, env, script, args.slice(args.indexOf(script) + 1), cwd, out.io));
    });

    const typescript = defineCommand('tsc', async (args, ctx) => {
        const cwd = projectPath(ctx.cwd);
        if (cwd === undefined) return outside('tsc');
        const module = await env.wasm();
        const context = resolveContext(project, env);
        let run = await tsc(module, vfs, args, {cwd, writeToProject: true});
        for (let round = 0; run.misses.size && round < 8; round++) {
            await loadClosure(project, [...run.misses], context);
            run = await tsc(module, vfs, args, {cwd, writeToProject: true});
        }
        return {stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode};
    });

    const npm = defineCommand('npm', async (args, ctx) => {
        const name = args[0] === 'run' ? args[1] : args[0] === 'test' || args[0] === 'start' ? args[0] : undefined;
        if (!name) return {stdout: '', stderr: 'npm: only `npm run <script>` is supported here\n', exitCode: 1};
        const script = project.packageJson.scripts?.[name];
        if (typeof script !== 'string') return {stdout: '', stderr: `npm error Missing script: "${name}"\n`, exitCode: 1};
        const result = await ctx.exec!(script, {cwd: ctx.cwd});
        return {stdout: `\n> ${script}\n\n${result.stdout}`, stderr: result.stderr, exitCode: result.exitCode};
    });

    const npx = defineCommand('npx', async (args, ctx) => ctx.exec!(args.join(' '), {cwd: ctx.cwd}));

    const fs = new MountableFs({mounts: [{mountPoint: MOUNT, filesystem: projectFs(vfs)}]});
    const bash = new Bash({fs, cwd: MOUNT, customCommands: [node, typescript, npm, npx]});
    return {
        async exec(command, streams) {
            io = streams;
            try {
                const result = await bash.exec(command);
                return {stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode};
            } finally {
                io = undefined;
            }
        },
    };
}
