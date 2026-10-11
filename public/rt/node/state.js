// The file system and process state that the Node shims share inside one script run. The runner
// (../node-runner.js) fills it in before it imports the script.

export const state = {
    /** Loaded files: absolute path to a string or a Uint8Array. */
    files: new Map(),
    /** Paths that the project's source has but that are not loaded. They are fetched on first read. */
    remote: new Set(),
    /** URL prefix of the project's source, for those fetches. */
    remoteBase: '',
    /** URL prefix that the project's files are served under, without a trailing slash. */
    root: '',
    cwd: '/',
    argv: [],
    env: {},
    written: new Map(),
    removed: new Set(),
    stdout: _text => {},
    stderr: _text => {},
    exit: _code => {},
};

let directories;

export function normalize(path) {
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
    }
    return `/${parts.join('/')}`;
}

/** The absolute path of a path, a `file:` URL or a URL of a served project file. */
export function toPath(value) {
    let path = value instanceof URL ? value.href : String(value);
    if (state.root && path.startsWith(`${state.root}/`)) path = decodeURIComponent(path.slice(state.root.length).split(/[?#]/)[0]);
    else if (path.startsWith('file://')) path = decodeURIComponent(new URL(path).pathname);
    return normalize(path.startsWith('/') ? path : `${state.cwd}/${path}`);
}

export function fail(code, syscall, path) {
    const text = {ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory'}[code];
    return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), {code, syscall, path});
}

function index() {
    if (directories) return directories;
    directories = new Map([['/', new Set()]]);
    const add = path => {
        let child = path;
        while (child !== '/') {
            const parent = child.slice(0, child.lastIndexOf('/')) || '/';
            let entries = directories.get(parent);
            const known = entries !== undefined;
            if (!entries) directories.set(parent, entries = new Set());
            entries.add(child.slice(child.lastIndexOf('/') + 1));
            if (known) return;
            child = parent;
        }
    };
    for (const path of state.files.keys()) add(path);
    for (const path of state.remote) add(path);
    return directories;
}

export function isFile(path) {
    return state.files.has(path) || state.remote.has(path);
}

export function isDirectory(path) {
    return index().has(path);
}

export function readDirectory(path) {
    const entries = index().get(path);
    return entries && [...entries].sort();
}

export function allFiles() {
    return [...state.files.keys(), ...state.remote];
}

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pbf|mvt|mlt|woff2?|ttf|otf|eot|wasm|zip|gz|tgz|pdf|mp[34]|webm|ogg|bin)$/i;

/** The content of a file. A file that is not loaded yet is fetched with a blocking request. */
export function readFile(path) {
    const loaded = state.files.get(path);
    if (loaded !== undefined) return loaded;
    if (!state.remote.has(path)) return undefined;
    const request = new XMLHttpRequest();
    request.open('GET', state.remoteBase + path.slice(1), false);
    const binary = BINARY.test(path);
    if (binary) request.responseType = 'arraybuffer';
    request.send();
    if (request.status !== 200) return undefined;
    const data = binary ? new Uint8Array(request.response) : request.responseText;
    state.files.set(path, data);
    state.remote.delete(path);
    return data;
}

export function writeFile(path, data) {
    state.files.set(path, data);
    state.remote.delete(path);
    state.written.set(path, data);
    state.removed.delete(path);
    directories = undefined;
}

export function makeDirectory(path) {
    index().set(path, index().get(path) ?? new Set());
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (path !== '/') {
        if (!index().has(parent)) makeDirectory(parent);
        index().get(parent).add(path.slice(path.lastIndexOf('/') + 1));
    }
}

export function remove(path) {
    const prefix = `${path}/`;
    for (const key of allFiles()) {
        if (key !== path && !key.startsWith(prefix)) continue;
        state.files.delete(key);
        state.remote.delete(key);
        state.written.delete(key);
        state.removed.add(key);
    }
    directories = undefined;
}
