import {compile} from './build.ts';
import {matchGlob} from './glob.ts';
import {resolve} from './path.ts';
import type {Env, Project, ScriptIo} from './project.ts';
import {resolveFile} from './resolve.ts';

const LITERAL = /(['"`])((?:\.{0,2}\/)?[\w@.\-/*{},?]+)\1/g;
const MAX_PRELOAD = 2000;

/**
 * Fetches the files that a script is likely to read: the ones that a glob or a directory in one of
 * its string literals names. A script reads files with blocking calls, and a file that is not
 * loaded then costs a blocking request each, one after the other. This guess saves most of them.
 */
async function preload(project: Project, sources: Iterable<string>, cwd: string): Promise<void> {
    const {vfs} = project;
    const wanted = new Set<string>();
    for (const source of sources) {
        for (const match of (vfs.readText(source) ?? '').matchAll(LITERAL)) {
            const path = resolve(cwd, match[2]);
            if (match[2].includes('*')) {
                const found = matchGlob(path, vfs.remote);
                if (found.length <= MAX_PRELOAD) for (const file of found) wanted.add(file);
            } else if (path !== '/' && vfs.isDirectory(path)) {
                for (const entry of vfs.readDirectory(path) ?? []) {
                    if (entry.kind === 'file') wanted.add(`${path}/${entry.name}`);
                }
            }
        }
    }
    await vfs.load(wanted);
}

/**
 * Runs a project script the way `node script.ts` would. The script and what it imports are
 * compiled with tsc-rs and run in a worker whose `fs` is the project. Files that the script writes
 * go back into the project.
 */
export async function runNodeScript(project: Project, env: Env, script: string, args: string[], cwd: string, io: ScriptIo): Promise<number> {
    if (!env.publish || !env.runScript) {
        io.stderr('node: scripts run only in the browser\n');
        return 1;
    }
    const {vfs} = project;
    const path = resolveFile(vfs, resolve(cwd, script));
    if (!path) {
        io.stderr(`node: cannot find module '${script}'\n`);
        return 1;
    }
    const compiled = await compile(project, env, [path]);
    const errors = compiled.problems.filter(problem => problem.category === 'error' && problem.code !== 2307);
    for (const problem of errors) io.stderr(`${problem.file ?? ''}${problem.line ? `:${problem.line}` : ''} ${problem.text}\n`);
    if (errors.length) return 1;

    const type = 'text/javascript; charset=utf-8';
    const root = `${env.runtimeBase}~p/${project.id}`;
    await Promise.all([
        env.publish(project.id, new Map([...compiled.modules].map(([file, body]) => [file, {body, type}]))),
        preload(project, compiled.modules.keys(), cwd),
    ]);
    const result = await env.runScript({
        entry: root + encodeURI(path),
        script: path,
        args,
        cwd,
        env: {},
        files: vfs.files,
        remote: [...vfs.remote],
        remoteBase: vfs.source?.url('') ?? '',
        root,
        versions: project.versions,
    }, io);
    for (const [file, data] of result.written) vfs.write(file, data);
    for (const file of result.removed) vfs.remove(file);
    return result.code;
}

const PLAIN = /^node((?:\s+[\w@.\-/=:,+]+)+)\s*$/;

/** The script and arguments of a command that is only `node script args`, which needs no shell. */
export function plainNodeCommand(command: string): {script: string; args: string[]} | undefined {
    const match = PLAIN.exec(command.trim());
    if (!match) return undefined;
    const words = match[1].trim().split(/\s+/);
    const at = words.findIndex(word => !word.startsWith('-'));
    return at < 0 ? undefined : {script: words[at], args: words.slice(at + 1)};
}
