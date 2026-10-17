import {build, warmUp, type Output, type Problem} from './build.ts';
import {plainNodeCommand, runNodeScript} from './node-run.ts';
import {fetchPrebuilt, type Stale} from './prebuilt.ts';
import {hash, openProject, type Env, type Project, type ScriptIo, type ScriptRequest, type ScriptResult} from './project.ts';
import type {EngineCalls, FileEntry, OpenOptions, Reply, Request, SandboxLink, SandboxReply, SandboxRequest, SessionInfo, Step} from './protocol.ts';
import type {Shell} from './shell.ts';
import type {LinkSpec} from './spec.ts';
import type {WasmModule} from './tsc.ts';
import {isBinaryPath} from './vfs.ts';
import tsrsWasm from '@tsrs/wasm/tsrs.wasm?url';

const KEPT_BUILDS = 12;
const SCRIPT_TIMEOUT_MS = 120_000;

const send = (reply: Reply) => postMessage(reply);
const io: ScriptIo = {
    stdout: text => send({event: 'output', stream: 'stdout', text}),
    stderr: text => send({event: 'output', stream: 'stderr', text}),
};

/** The port to the sandbox of the open link, and what waits for its answers. */
interface Sandbox {
    base: string;
    port: MessagePort;
    next: number;
    waiting: Map<number, (answer: SandboxReply) => void>;
}

let project: Project | undefined;
let env: Env | undefined;
let base = '';
let sandbox: Sandbox | undefined;
let opened: {id: string; label: string; log: string; setupProblems: Problem[]; prepared: boolean} | undefined;
let edits: Record<string, string> = {};
let shell: Shell | undefined;
let wasm: Promise<WasmModule> | undefined;

const buildCache = (id: string) => `livebranch-build-v2-${id}`;
// Builds from before previews had hosts of their own load the runtime from the app's host, which a sandbox does not allow.
void caches.keys().then(names => Promise.all(names.filter(name => /^livebranch-build-(?!v2-)/.test(name)).map(name => caches.delete(name))));

/** GitHub's file list of a commit never changes, and the anonymous API allows few requests, so it is kept. */
async function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/trees\/[0-9a-f]{40}\?/.test(url)) return fetch(url, init);
    const cache = await caches.open('livebranch-github');
    const hit = await cache.match(url);
    if (hit) return hit;
    const response = await fetch(url, init);
    if (response.ok) await cache.put(url, response.clone());
    return response;
}

function connect(link: SandboxLink): Sandbox {
    const connected: Sandbox = {base: link.base, port: link.port, next: 0, waiting: new Map()};
    link.port.onmessage = ({data}: MessageEvent<SandboxReply>) => connected.waiting.get('reply' in data ? data.reply : data.run)?.(data);
    return connected;
}

/** Sends files of a build to the sandbox, and waits until its service worker can serve them. */
function sendFiles(to: Sandbox, id: string, files: [string, string | Uint8Array, string][]): Promise<void> {
    const reply = to.next++;
    return new Promise((resolve, reject) => {
        to.waiting.set(reply, answer => {
            to.waiting.delete(reply);
            if (answer.error !== undefined) reject(new Error(answer.error));
            else resolve();
        });
        to.port.postMessage({type: 'publish', reply, id, files} satisfies SandboxRequest);
    });
}

/** Sends a build that this browser kept to the sandbox, which may not have it. */
async function resend(to: Sandbox, id: string): Promise<void> {
    const cache = await caches.open(buildCache(id));
    const root = `${base}~p/${id}`;
    const files = await Promise.all((await cache.keys()).map(async request => {
        const response = await cache.match(request);
        return [request.url.slice(root.length), new Uint8Array(await response!.arrayBuffer()), response!.headers.get('content-type') ?? ''] as [string, Uint8Array, string];
    }));
    await sendFiles(to, id, files);
}

/** Runs a script in a worker of the sandbox, so that the project's code does not run on the app's host. */
function runScript(to: Sandbox, request: ScriptRequest, streams: ScriptIo): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const run = to.next++;
        const finish = (settle: () => void) => {
            clearTimeout(timer);
            to.waiting.delete(run);
            to.port.postMessage({type: 'stop', run} satisfies SandboxRequest);
            settle();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`${request.script} did not finish in ${SCRIPT_TIMEOUT_MS / 1000} s.`))), SCRIPT_TIMEOUT_MS);
        to.waiting.set(run, answer => {
            if (!('run' in answer)) return;
            const {data, error} = answer;
            if (error !== undefined) finish(() => reject(new Error(error)));
            else if (data?.type === 'stdout') streams.stdout(data.text);
            else if (data?.type === 'stderr') streams.stderr(data.text);
            else if (data?.type === 'exit') finish(() => resolve({code: data.code, written: data.written, removed: data.removed}));
        });
        to.port.postMessage({type: 'run', run, request} satisfies SandboxRequest);
    });
}

function createEnv(base: string, to: Sandbox): Env {
    // The site's server reads GitHub's git endpoint for the browser, which may not. Where the site
    // has no server (the dev server, a static host), these fail and the engine asks GitHub's API.
    const ask = async (path: string) => {
        const response = await fetch(`${base}api/github/${path}`);
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('The site has no GitHub reader.');
        return response.json();
    };
    return {
        fetch: cachedFetch,
        git: {
            resolve: async (owner, repo, ref) => (await ask(`resolve?repo=${owner}/${repo}&ref=${encodeURIComponent(ref)}`)).commit ?? undefined,
            tree: async (owner, repo, commit) => (await ask(`tree?repo=${owner}/${repo}&commit=${commit}`)).paths,
        },
        // Pages and scripts run on the sandbox's host and load the runtime from there.
        runtimeBase: new URL(base).pathname,
        wasm() {
            wasm ??= WebAssembly.compileStreaming(fetch(tsrsWasm));
            return wasm;
        },
        // The app's host keeps the build, and the sandbox gets a copy to serve.
        async publish(id, files) {
            const cache = await caches.open(buildCache(id));
            const root = `${base}~p/${id}`;
            const encoded = [...files].map(([path, file]) => [encodeURI(path), file.body, file.type] as [string, string | Uint8Array, string]);
            await Promise.all([
                ...encoded.map(([path, body, type]) => cache.put(root + path, new Response(body as BodyInit, {headers: {'content-type': type, 'cache-control': 'no-store'}}))),
                sendFiles(to, id, encoded),
            ]);
        },
        runScript: (request, streams) => runScript(to, request, streams),
    };
}

/** Records the build as the most recent one and deletes the builds beyond the kept number. */
async function touch(id: string): Promise<void> {
    const index = await caches.open('livebranch-index');
    const stored = await index.match('/builds');
    const ids: string[] = [id, ...(stored ? await stored.json() as string[] : []).filter(other => other !== id)];
    await Promise.all(ids.slice(KEPT_BUILDS).map(old => caches.delete(buildCache(old))));
    await index.put('/builds', new Response(JSON.stringify(ids.slice(0, KEPT_BUILDS))));
}

async function getShell(): Promise<Shell> {
    if (!project || !env) throw new Error('No project is open.');
    shell ??= (await import('./shell.ts')).createShell(project, env);
    return shell;
}

/** Runs one setup command. A plain `node script` runs without loading the shell. */
async function runSetup(current: Project, command: string): Promise<{stdout: string; stderr: string; exitCode: number}> {
    const plain = plainNodeCommand(command);
    if (!plain) return (await getShell()).exec(command);
    let stdout = '';
    let stderr = '';
    const streams: ScriptIo = {stdout: text => { stdout += text; }, stderr: text => { stderr += text; }};
    const exitCode = await runNodeScript(current, env!, plain.script, plain.args, '/', streams);
    return {stdout, stderr, exitCode};
}

/** Fetches the prebuilt files and runs the setup commands, once for an opened project. */
async function prepare(steps: Step[]): Promise<void> {
    const current = project!;
    const state = opened!;
    if (state.prepared) return;
    const timed = stepTimer(steps);
    const problems: Problem[] = [];
    let log = '';
    // The sources of the page are fetched while the setup runs.
    const warm = warmUp(current, env!).catch(() => {});

    const run = async (command: string): Promise<boolean> => {
        const result = await timed('setup', command, () => runSetup(current, command));
        log += `$ ${command}\n${result.stdout}${result.stderr}`;
        if (result.exitCode === 0) return true;
        const text = `Setup command failed with exit code ${result.exitCode}: ${command}\n${result.stderr.trim()}`;
        problems.push({file: undefined, line: undefined, column: undefined, code: 0, category: 'error', text});
        return false;
    };
    const prebuilt = async (): Promise<Stale[]> => {
        if (!current.config.prebuilt?.length) return [];
        const count = current.config.prebuilt.flatMap(group => group.files).length;
        const result = await timed('prebuilt', `${count} ${count === 1 ? 'file' : 'files'} from npm`, () => fetchPrebuilt(current, env!));
        problems.push(...result.problems);
        return result.stale;
    };
    const setup = async () => {
        for (const command of current.config.setup ?? []) await run(command);
    };
    const [stale] = await Promise.all([prebuilt(), setup()]);
    // Prebuilt files that may be out of date are made by their command, one at a time as the setup commands are.
    for (const group of stale) if (!await run(group.command)) problems.push(...group.fallback());
    await warm;
    Object.assign(state, {log, setupProblems: problems, prepared: true});
}

/** Builds the open project's page and puts the result where the service worker serves it from. */
async function buildAndPublish(steps: Step[], start: number): Promise<SessionInfo> {
    const current = project!;
    const timed = stepTimer(steps);
    const result = await timed('build', undefined, () => build(current, env!, (name, detail) => send({event: 'step', name, detail})));
    const info: SessionInfo = {
        id: current.id,
        url: `${sandbox!.base}~p/${current.id}${encodeURI(result.entry)}`,
        label: current.label,
        gh: current.spec.gh,
        commit: current.commit,
        entry: result.entry,
        file: current.entry,
        problems: [...opened!.setupProblems, ...result.problems],
        steps,
        ms: 0,
        sources: result.sources,
        log: opened!.log,
        cached: false,
    };
    await timed('publish', `${result.outputs.size} files`, async () => {
        const meta: Output = {body: JSON.stringify({remote: current.vfs.source?.url('') ?? '', info}), type: 'application/json'};
        await env!.publish!(current.id, new Map([...result.outputs, ['/__meta__.json', meta]]));
        await touch(current.id);
    });
    info.ms = performance.now() - start;
    return info;
}

function stepTimer(steps: Step[]) {
    return async <T>(name: string, detail: string | undefined, run: () => Promise<T>): Promise<T> => {
        send({event: 'step', name, detail});
        const start = performance.now();
        try {
            return await run();
        } finally {
            steps.push({name, detail, ms: performance.now() - start});
        }
    };
}

const calls: {[K in keyof EngineCalls]: (...args: Parameters<EngineCalls[K]>) => Promise<ReturnType<EngineCalls[K]>>} = {
    async open(spec: LinkSpec, options: OpenOptions): Promise<SessionInfo> {
        const steps: Step[] = [];
        const timed = stepTimer(steps);
        const start = performance.now();

        base = options.base;
        sandbox?.port.close();
        sandbox = connect(options.sandbox);
        env = createEnv(base, sandbox);
        shell = undefined;
        opened = undefined;
        const current = project = await timed('source', spec.gh ?? spec.gist ?? 'files in the link', () => openProject(spec, env!));

        if (options.cache && await caches.has(buildCache(current.id))) {
            const meta = await (await caches.open(buildCache(current.id))).match(`${base}~p/${current.id}/__meta__.json`);
            const info: SessionInfo | undefined = meta && (await meta.json()).info;
            if (info) {
                await Promise.all([touch(current.id), resend(sandbox, current.id)]);
                opened = {id: current.id, label: current.label, log: info.log, setupProblems: [], prepared: false};
                edits = {};
                // A commit builds the same under every ref and in every fork, so the stored build says who made it and not who asks.
                return {...info, url: `${sandbox.base}~p/${current.id}${encodeURI(info.entry)}`, gh: current.spec.gh, label: current.label, steps, ms: performance.now() - start, cached: true};
            }
        }

        opened = {id: current.id, label: current.label, log: '', setupProblems: [], prepared: false};
        edits = {};
        await prepare(steps);
        return buildAndPublish(steps, start);
    },

    async update(files: Record<string, string>): Promise<SessionInfo> {
        if (!project || !opened) throw new Error('No project is open.');
        const steps: Step[] = [];
        const start = performance.now();
        await prepare(steps);
        Object.assign(edits, files);
        for (const [path, text] of Object.entries(files)) project.vfs.write(path, text);
        // Edits skip the setup commands, so their builds are kept apart from the ones a link gives.
        project.id = `e${await hash([opened.id, edits])}`;
        return buildAndPublish(steps, start);
    },

    async check(): Promise<Problem[]> {
        if (!project || !opened) throw new Error('No project is open.');
        const current = project;
        const cache = await caches.open(buildCache(current.id));
        const key = `${base}~p/${current.id}/__types__.json`;
        const stored = await cache.match(key);
        if (stored) return stored.json();
        // The generated sources carry types too, so a build that came from the cache is set up first.
        await prepare([]);
        const {typeCheck} = await import('./types.ts');
        const own = new Set([current.entry, ...current.overlay, ...Object.keys(edits)]);
        const problems = await typeCheck(current, env!, own);
        await cache.put(key, new Response(JSON.stringify(problems), {headers: {'content-type': 'application/json'}}));
        return problems;
    },

    async files(): Promise<FileEntry[]> {
        if (!project) return [];
        const {vfs} = project;
        // The declarations that the type check installs are not the project's own files.
        return vfs.paths().filter(path => !path.startsWith('/node_modules/')).map(path => ({path, loaded: vfs.files.has(path)}));
    },

    async read(path: string): Promise<string | undefined> {
        if (!project || isBinaryPath(path)) return undefined;
        await project.vfs.load([path]);
        return project.vfs.readText(path);
    },

    async exec(command: string) {
        return (await getShell()).exec(command, io);
    },
};

// Calls run one after the other, since they share the open project.
let queue: Promise<void> = Promise.resolve();

addEventListener('message', ({data}: MessageEvent<Request>) => {
    queue = queue.then(async () => {
        try {
            const call = calls[data.call] as (...args: unknown[]) => Promise<unknown>;
            send({id: data.id, result: await call(...data.args)});
        } catch (error) {
            console.error(error);
            send({id: data.id, error: error instanceof Error ? error.message : String(error)});
        }
    });
});
