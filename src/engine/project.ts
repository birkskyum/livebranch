import {normalize} from './path.ts';
import {adapterFits, fetchAdapter, readConfig} from './adapters.ts';
import {isSourcePath} from './resolve.ts';
import {fetchGist, githubSource, resolveSource, type Fetch} from './sources/github.ts';
import {parseGithubRef, type ProjectConfig, type LinkSpec} from './spec.ts';
import type {WasmModule} from './tsc.ts';
import {Vfs, type FileData, type RemoteSource} from './vfs.ts';

/** Bump when a change to the engine makes cached builds stale. */
export const ENGINE_VERSION = 1;

/** What the engine needs from where it runs: a browser worker or Node. */
export interface Env {
    fetch: Fetch;
    /** The URL of the app, ending with a slash. */
    runtimeBase: string;
    wasm(): Promise<WasmModule>;
    /** Puts files where the preview and script runs load them from. Only a browser has it. */
    publish?(id: string, files: Map<string, {body: FileData; type: string}>): Promise<void>;
    /** Runs a compiled script in a worker with the Node shims. Only a browser has it. */
    runScript?(request: ScriptRequest, io: ScriptIo): Promise<ScriptResult>;
}

export interface ScriptIo {
    stdout(text: string): void;
    stderr(text: string): void;
}

export interface ScriptRequest {
    /** The URL that the compiled script is served at. */
    entry: string;
    /** The script's path in the project. */
    script: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    files: Map<string, FileData>;
    remote: string[];
    remoteBase: string;
    /** The URL prefix that the project's files are served under. */
    root: string;
    versions: Record<string, string>;
}

export interface ScriptResult {
    code: number;
    written: Map<string, FileData>;
    removed: string[];
}

export type Progress = (step: string, detail?: string) => void;

export interface Project {
    spec: LinkSpec;
    vfs: Vfs;
    config: ProjectConfig;
    /** The HTML page to open. */
    entry: string;
    /** A short name for the source, such as `owner/repo@1a2b3c4`. */
    label: string;
    /** The commit of the GitHub source. */
    commit: string | undefined;
    /** Identifies the inputs of the build. Equal ids give equal output. */
    id: string;
    alias: Record<string, string>;
    /** The files that the link and the gist bring, as project paths. */
    overlay: string[];
    /** The project's package.json, or an empty object. */
    packageJson: Record<string, any>;
    /** The installed version, or else the wanted range, of each npm package the project names. */
    versions: Record<string, string>;
}

const CONFIG_FILES = ['/package.json', '/package-lock.json', '/tsconfig.json', '/livebranch.json', '/.github/livebranch.json'];

/** A source that is not a link parameter, such as a directory on disk. */
export interface LocalSource {
    source: RemoteSource;
    label: string;
}

/** Parses JSON that may have comments and trailing commas, as tsconfig files do. */
export function parseJsonc(text: string): any {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (char === '"') {
            const start = i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            out += text.slice(start, ++i);
        } else if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (char === '/' && text[i + 1] === '*') {
            i = text.indexOf('*/', i + 2);
            i = i < 0 ? text.length : i + 2;
        } else {
            out += char;
            i++;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJson(vfs: Vfs, path: string): any {
    const text = vfs.readText(path);
    if (text === undefined) return undefined;
    try {
        return parseJsonc(text);
    } catch {
        return undefined;
    }
}

export async function hash(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest.subarray(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Aliases from the `paths` of the project's tsconfig: `@/*` to `./src/*` becomes `@` to `./src`. */
function pathAliases(tsconfig: any): Record<string, string> {
    const options = tsconfig?.compilerOptions ?? {};
    const alias: Record<string, string> = {};
    for (const [pattern, targets] of Object.entries<string[]>(options.paths ?? {})) {
        const target = targets[0];
        if (typeof target !== 'string') continue;
        const path = normalize(`/${options.baseUrl ?? '.'}/${target.replace(/\/?\*$/, '')}`);
        alias[pattern.replace(/\/?\*$/, '')] = `.${path}`;
    }
    return alias;
}

const DEMO_NAMES = ['/demo.ts', '/demo.tsx', '/index.ts', '/index.tsx', '/main.ts', '/main.tsx'];

/**
 * The page to open, or the script to run in a page made from the template. What the link carries
 * wins over what the project's config names.
 */
function pickEntry(spec: LinkSpec, config: ProjectConfig, overlay: string[], vfs: Vfs): string {
    if (spec.entry) return normalize(`/${spec.entry}`);
    const pages = overlay.filter(path => path.endsWith('.html'));
    const page = pages.find(path => path === '/index.html') ?? pages[0];
    if (page) return page;
    // A script at the root of the link's files is the demo. One further down replaces a project file.
    const scripts = overlay.filter(path => isSourcePath(path) && path.lastIndexOf('/') === 0);
    const script = DEMO_NAMES.find(name => scripts.includes(name)) ?? (scripts.length === 1 ? scripts[0] : undefined);
    if (script) return script;
    if (config.entry) return normalize(`/${config.entry}`);
    if (vfs.isFile('/index.html')) return '/index.html';
    throw new Error('The project has no page to open. Add an index.html or a demo.ts, or name one with the entry parameter.');
}

/** Lists the source, lays the gist and the link's files over it, and reads the project's config. */
export async function openProject(spec: LinkSpec, env: Env, progress: Progress = () => {}, local?: LocalSource): Promise<Project> {
    const vfs = new Vfs();
    let label = 'inline';
    let commit: string | undefined;
    let subdir = '';
    let repository: string | undefined;

    if (local) {
        label = local.label;
        vfs.source = local.source;
    } else if (spec.gh) {
        const wanted = parseGithubRef(spec.gh);
        progress('resolve', `${wanted.owner}/${wanted.repo}@${wanted.ref}`);
        const resolved = await resolveSource(env.fetch, wanted, spec.entry);
        const source = resolved.source;
        commit = resolved.commit;
        if (source.ref !== wanted.ref) spec = {...spec, gh: `${source.owner}/${source.repo}@${source.ref}`, entry: resolved.entry};
        subdir = source.subdir;
        repository = `${source.owner}/${source.repo}`;
        const pull = /^pull\/(\d+)\/head$/.exec(source.ref);
        label = `${source.owner}/${source.repo}${pull ? `#${pull[1]}` : ''}@${commit.slice(0, 7)}${subdir ? `/${subdir}` : ''}`;
        vfs.source = githubSource(env.fetch, source, commit);
        progress('list', label);
    }
    if (vfs.source) {
        // The config files are asked for next to the file list, to save a round trip.
        const source = vfs.source;
        const [paths, configs] = await Promise.all([source.list(), Promise.all(CONFIG_FILES.map(path => source.probe(path.slice(1))))]);
        vfs.addRemote(paths.map(path => `/${path}`));
        CONFIG_FILES.forEach((path, index) => {
            if (configs[index] !== undefined && vfs.remote.has(path)) vfs.write(path, configs[index]);
        });
    }

    const overlay: Record<string, string> = {};
    if (spec.gist) {
        progress('gist', spec.gist);
        Object.assign(overlay, await fetchGist(env.fetch, spec.gist));
        if (!spec.gh) label = `gist ${spec.gist.slice(0, 8)}`;
    }
    Object.assign(overlay, spec.files);
    const overlayPaths: string[] = [];
    for (const [name, text] of Object.entries(overlay)) {
        const path = normalize(`/${name}`);
        vfs.write(path, text);
        overlayPaths.push(path);
    }

    await vfs.load(CONFIG_FILES);
    const packageJson = readJson(vfs, '/package.json') ?? {};
    const lock = readJson(vfs, '/package-lock.json');

    // The project's own config wins over its adapter, field by field.
    const adapterName: string | undefined = spec.adapter === 'none' ? undefined : spec.adapter ?? packageJson.name;
    const found = adapterName ? await fetchAdapter(env.fetch, adapterName) : undefined;
    if (spec.adapter && spec.adapter !== 'none' && !found) throw new Error(`There is no adapter named ${spec.adapter}.`);
    // An adapter that the link names is used as it is. One found by package name has to fit.
    const adapter = found && (spec.adapter || adapterFits(found, repository, packageJson)) ? found : undefined;
    const own = readConfig(readJson(vfs, '/livebranch.json') ?? readJson(vfs, '/.github/livebranch.json'));
    const config: ProjectConfig = {
        ...adapter,
        ...own,
        alias: {...adapter?.alias, ...own.alias},
        files: {...adapter?.files, ...own.files},
        entries: [...adapter?.entries ?? [], ...own.entries ?? []],
    };
    for (const [name, text] of Object.entries(config.files ?? {})) {
        const path = normalize(`/${name}`);
        if (!vfs.isFile(path)) vfs.write(path, text);
    }

    const alias: Record<string, string> = {...pathAliases(readJson(vfs, '/tsconfig.json'))};
    if (packageJson.name) {
        const main = ['/src/index.ts', '/src/index.tsx', '/index.ts'].find(path => vfs.isFile(path));
        if (main) alias[packageJson.name] = `.${main}`;
    }
    Object.assign(alias, config.alias);

    const versions: Record<string, string> = {};
    const usable = (found: unknown): found is string => typeof found === 'string' && /^[\^~]?\d/.test(found);
    for (const group of [packageJson.peerDependencies, packageJson.devDependencies, packageJson.dependencies]) {
        for (const [name, range] of Object.entries(group ?? {})) if (usable(range)) versions[name] = range;
    }
    for (const [key, entry] of Object.entries<any>(lock?.packages ?? {})) {
        const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : '';
        if (name && !name.includes('node_modules/') && usable(entry?.version)) versions[name] = entry.version;
    }

    const entry = pickEntry(spec, config, overlayPaths, vfs);
    const id = await hash([ENGINE_VERSION, commit, subdir, overlay, adapter, entry]);
    return {spec, vfs, config, entry, label, commit, id, alias, overlay: overlayPaths, packageJson, versions};
}
