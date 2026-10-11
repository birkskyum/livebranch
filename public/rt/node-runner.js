// A module worker that runs one compiled script the way `node script.ts` would: with a `process`
// global, `fs` over the project's files and a console that goes to the terminal. The engine sends
// one message with the files and the script's URL, and gets the output and the written files back.
import {state} from './node/state.js';

const SHIMS = {'fs': 'fs.js', 'fs/promises': 'fs-promises.js', 'path': 'path.js', 'path/posix': 'path.js', 'url': 'url.js', 'process': 'process.js', 'glob': 'glob.js'};

class Exit extends Error {}

let pending = 0;
let exitCode;
const timers = new Set();

function track(promise) {
    pending++;
    const done = () => { pending--; };
    promise.then(done, done);
    return promise;
}

const nativeSetTimeout = self.setTimeout.bind(self);
const nativeClearTimeout = self.clearTimeout.bind(self);
const nativeFetch = self.fetch.bind(self);
self.setTimeout = (callback, ms, ...args) => {
    const id = nativeSetTimeout(() => {
        timers.delete(id);
        callback(...args);
    }, ms);
    timers.add(id);
    return id;
};
self.clearTimeout = id => {
    timers.delete(id);
    nativeClearTimeout(id);
};
self.fetch = (...args) => track(nativeFetch(...args).then(response => {
    for (const method of ['text', 'json', 'arrayBuffer', 'blob', 'bytes']) {
        const read = response[method]?.bind(response);
        if (read) response[method] = () => track(read());
    }
    return response;
}));

/** Waits until the script has no timer, request or import left, as Node waits for its event loop. */
async function idle() {
    let quiet = 0;
    while (quiet < 3) {
        await new Promise(resolve => nativeSetTimeout(resolve, 15));
        quiet = pending === 0 && timers.size === 0 ? quiet + 1 : 0;
    }
}

function format(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || String(value);
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value, (key, item) => typeof item === 'bigint' ? `${item}n` : item, 2);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function installConsole() {
    const line = write => (...args) => write(`${args.map(format).join(' ')}\n`);
    console.log = console.info = console.debug = line(text => state.stdout(text));
    console.error = console.warn = console.trace = line(text => state.stderr(text));
}

self.onmessage = async ({data}) => {
    Object.assign(state, {
        files: data.files,
        remote: new Set(data.remote),
        remoteBase: data.remoteBase,
        root: data.root,
        cwd: data.cwd,
        argv: ['node', data.script, ...data.args],
        env: data.env,
        stdout: text => postMessage({type: 'stdout', text}),
        stderr: text => postMessage({type: 'stderr', text}),
        exit: code => {
            exitCode = code;
            throw new Exit();
        },
    });

    /** Resolves an import whose specifier the script computes at run time. */
    const locate = (specifier, base) => {
        if (/^(?:https?|data|blob):/.test(specifier)) return specifier;
        if (specifier.startsWith('file://')) return state.root + new URL(specifier).pathname;
        if (specifier.startsWith('/')) return state.root + specifier;
        if (specifier.startsWith('.')) return new URL(specifier, base).href;
        const shim = SHIMS[specifier.replace(/^node:/, '')];
        if (shim) return new URL(`./node/${shim}`, import.meta.url).href;
        const parts = specifier.split('/');
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const version = data.versions[name];
        return `https://esm.sh/${name}${version ? `@${version}` : ''}${specifier.slice(name.length)}`;
    };
    self.__livebranchImport = (specifier, base) => track(import(locate(String(specifier), base)));

    const fail = error => {
        if (error instanceof Exit || exitCode !== undefined) return;
        state.stderr(`${error?.stack || error}\n`);
        exitCode = 1;
    };
    self.addEventListener('error', event => fail(event.error ?? event.message));
    self.addEventListener('unhandledrejection', event => {
        event.preventDefault();
        fail(event.reason);
    });

    const {default: process} = await import('./node/process.js');
    self.process = process;
    self.global = self;
    installConsole();
    try {
        await import(data.entry);
        await idle();
    } catch (error) {
        fail(error);
    }
    postMessage({type: 'exit', code: exitCode ?? process.exitCode ?? 0, written: state.written, removed: [...state.removed]});
};
