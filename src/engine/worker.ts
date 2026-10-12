import {build, warmUp, type Output, type Problem} from './build.ts';
import {plainNodeCommand, runNodeScript} from './node-run.ts';
import {fetchPrebuilt} from './prebuilt.ts';
import {hash, openProject, type Env, type Project, type ScriptIo, type ScriptRequest, type ScriptResult} from './project.ts';
import type {EngineCalls, FileEntry, OpenOptions, Reply, Request, SessionInfo, Step} from './protocol.ts';
import type {Shell} from './shell.ts';
import type {LinkSpec} from './spec.ts';
import type {WasmModule} from './tsc.ts';
import {isBinaryPath} from './vfs.ts';

const KEPT_BUILDS = 12;
const SCRIPT_TIMEOUT_MS = 120_000;

const send = (reply: Reply) => postMessage(reply);
const io: ScriptIo = {
    stdout: text => send({event: 'output', stream: 'stdout', text}),
    stderr: text => send({event: 'output', stream: 'stderr', text}),
};

let project: Project | undefined;
let env: Env | undefined;
let base = '';
let opened: {id: string; label: string; log: string; setupProblems: Problem[]; prepared: boolean} | undefined;
let edits: Record<string, string> = {};
let shell: Shell | undefined;
let wasm: Promise<WasmModule> | undefined;

const buildCache = (id: string) => `livebranch-build-${id}`;

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

function runScript(base: string, request: ScriptRequest, streams: ScriptIo): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        // A URL of its own, for the same reason as in client.ts: two engines may run a script at once.
        const worker = new Worker(`${base}rt/node-runner.js?run=${crypto.randomUUID()}`, {type: 'module', name: request.script});
        const finish = (settle: () => void) => {
            clearTimeout(timer);
            worker.terminate();
            settle();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`${request.script} did not finish in ${SCRIPT_TIMEOUT_MS / 1000} s.`))), SCRIPT_TIMEOUT_MS);
        worker.onmessage = ({data}) => {
            if (data.type === 'stdout') streams.stdout(data.text);
            else if (data.type === 'stderr') streams.stderr(data.text);
            else if (data.type === 'exit') finish(() => resolve({code: data.code, written: data.written, removed: data.removed}));
        };
        worker.onerror = event => finish(() => reject(new Error(event.message || `${request.script} could not start.`)));
        worker.postMessage(request);
    });
}

function createEnv(base: string): Env {
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
        runtimeBase: base,
        wasm() {
            wasm ??= WebAssembly.compileStreaming(fetch(`${base}tsc/ts_rust.wasm`));
            return wasm;
        },
        async publish(id, files) {
            const cache = await caches.open(buildCache(id));
            const root = `${base}~p/${id}`;
            await Promise.all([...files].map(([path, file]) => {
                const headers = {'content-type': file.type, 'cache-control': 'no-store'};
                return cache.put(root + encodeURI(path), new Response(file.body as BodyInit, {headers}));
            }));
        },
        runScript: (request, streams) => runScript(base, request, streams),
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

    const prebuilt = async () => {
        if (!current.config.prebuilt?.length) return;
        const count = current.config.prebuilt.flatMap(group => group.files).length;
        problems.push(...await timed('prebuilt', `${count} ${count === 1 ? 'file' : 'files'} from npm`, () => fetchPrebuilt(current, env!)));
    };
    const setup = async () => {
        for (const command of current.config.setup ?? []) {
            const result = await timed('setup', command, () => runSetup(current, command));
            log += `$ ${command}\n${result.stdout}${result.stderr}`;
            if (result.exitCode === 0) continue;
            const text = `Setup command failed with exit code ${result.exitCode}: ${command}\n${result.stderr.trim()}`;
            problems.push({file: undefined, line: undefined, column: undefined, code: 0, category: 'error', text});
        }
    };
    await Promise.all([prebuilt(), setup()]);
    await warm;
    Object.assign(state, {log, setupProblems: problems, prepared: true});
}

/** Builds the open project's page and puts the result where the service worker serves it from. */
async function buildAndPublish(steps: Step[], start: number): Promise<SessionInfo> {
    const current = project!;
    const timed = stepTimer(steps);
    const result = await timed('build', undefined, () => build(current, env!, (name, detail) => send({event: 'step', name, detail})));
    const root = `${base}~p/${current.id}`;
    const info: SessionInfo = {
        id: current.id,
        url: root + encodeURI(result.entry),
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
        env = createEnv(base);
        shell = undefined;
        opened = undefined;
        const current = project = await timed('source', spec.gh ?? spec.gist ?? 'files in the link', () => openProject(spec, env!));

        if (options.cache && await caches.has(buildCache(current.id))) {
            const meta = await (await caches.open(buildCache(current.id))).match(`${base}~p/${current.id}/__meta__.json`);
            const info: SessionInfo | undefined = meta && (await meta.json()).info;
            if (info) {
                await touch(current.id);
                opened = {id: current.id, label: current.label, log: info.log, setupProblems: [], prepared: false};
                edits = {};
                // A commit builds the same under every ref and in every fork, so the stored build says who made it and not who asks.
                return {...info, gh: current.spec.gh, label: current.label, steps, ms: performance.now() - start, cached: true};
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
