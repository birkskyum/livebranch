import {produce} from 'immer';
import {create} from 'zustand';
import {createEngine, type Engine} from '../engine/client.ts';
import type {Problem} from '../engine/build.ts';
import type {FileEntry, SessionInfo} from '../engine/protocol.ts';
import {forkedFrom} from '../engine/sources/github.ts';
import {demoSection, fetchPullRequest, type PullRequest} from '../engine/sources/pull.ts';
import {baseSource, decodeSpec, encodeSpec, isEmptySpec, isPullRequest, normalizeBase, parseGithubRef, unpack, type LinkSpec} from '../engine/spec.ts';

export type Phase = 'landing' | 'loading' | 'ready' | 'failed';
export type Tab = 'problems' | 'console' | 'terminal' | 'build';

export interface ConsoleEntry {
    level: 'log' | 'info' | 'warn' | 'error' | 'debug';
    text: string;
}

export interface State {
    phase: Phase;
    spec: LinkSpec;
    step: string;
    error: string;
    session: SessionInfo | undefined;
    /** The same page built against the ref that the link compares with. */
    base: SessionInfo | undefined;
    baseError: string;
    /** The open pull request as GitHub describes it, when its description was asked for a demo. */
    pull: PullRequest | undefined;
    /** Why the description could not be read, when it could not. */
    pullProblem: string;
    /** What the page logged. In a comparison, the page of the link's own ref. */
    console: ConsoleEntry[];
    /** What the page of the ref that the link compares with logged. */
    baseConsole: ConsoleEntry[];
    /** Counts reloads of the preview. */
    runs: number;
    tab: Tab;
    /** The files and the editor, left of the preview. */
    showCode: boolean;
    /** The problems, the console, the terminal and the build log, below the preview. */
    showPanel: boolean;
    file: string | undefined;
    /** Files edited in the app and not in the link yet. */
    edits: Record<string, string>;
    building: boolean;
    /** Type errors of the page and the link's files. They arrive after the preview. */
    typeProblems: Problem[];
    checking: boolean;
    /** Whether input on one page of a comparison is given to the other page too. The link says so. */
    mirror: boolean;
    /** A recorded gesture, which plays on every page. The link carries it. */
    gesture: Gesture | undefined;
    /** Whether a gesture is being recorded: `loading` while the pages start afresh, then `on`. */
    recording: false | 'loading' | 'on';
    /** Whether a gesture is playing, the same way. */
    playing: false | 'loading' | 'on';
}

/**
 * One event of a recorded gesture, as `public/rt/preview.js` reports it, when it came after the
 * pages started. Its place is a share of the page's width and height.
 */
export interface RecordedInput {
    t: number;
    kind: string;
    type: string;
    init: Record<string, unknown>;
}

export interface Gesture {
    events: RecordedInput[];
    /** The events as the `gesture` parameter of a link. */
    packed: string;
}

export const useStore = create<State>()(() => ({
    phase: 'landing',
    spec: {},
    step: '',
    error: '',
    session: undefined,
    base: undefined,
    baseError: '',
    pull: undefined,
    pullProblem: '',
    console: [],
    baseConsole: [],
    runs: 0,
    tab: 'console',
    showCode: true,
    showPanel: true,
    file: undefined,
    edits: {},
    building: false,
    typeProblems: [],
    checking: false,
    mirror: false,
    gesture: undefined,
    recording: false,
    playing: false,
}));

/** The state now, for code outside the components. */
export const current = useStore.getState;

/** Changes the state, with the changed fields or with a recipe that changes a draft of it. */
export function setState(change: Partial<State> | ((draft: State) => void)): void {
    useStore.setState(typeof change === 'function' ? produce(change) : change);
}

/** Where the code of livebranch is. */
export const REPOSITORY = 'https://github.com/birkskyum/livebranch';

/** The URL of the app's directory. The service worker's scope and the engine's assets hang off it. */
export const base = new URL('./', location.href.split(/[?#]/)[0]).href;

let engine: Engine | undefined;
let baseEngine: Engine | undefined;

export function getEngine(): Engine {
    if (!engine) {
        engine = createEngine();
        engine.events.step = (name, detail) => setState({step: detail ? `${name}: ${detail}` : name});
    }
    return engine;
}

/** A second engine, for the ref that a link compares with. The two build at the same time. */
function getBaseEngine(): Engine {
    baseEngine ??= createEngine();
    return baseEngine;
}

/** Registers the service worker that serves previews, and waits until it controls this page. */
async function ensureServiceWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) throw new Error('This browser has no service workers, which the preview needs.');
    await navigator.serviceWorker.register(`${base}sw.js`, {scope: base});
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {once: true});
        setTimeout(resolve, 2000);
    });
    if (navigator.serviceWorker.controller) return;
    // A forced reload leaves the page without its service worker. A normal reload brings it back.
    if (!sessionStorage.getItem('livebranch-reloaded')) {
        sessionStorage.setItem('livebranch-reloaded', '1');
        location.reload();
        await new Promise(() => {});
    }
    throw new Error('The service worker does not control this page. Reload it without holding shift.');
}

/**
 * What the code panel shows of the open project, asked for once per link. The engine answers one
 * call at a time, so a build asks for these before its type check, which can take seconds.
 */
let listing: Promise<FileEntry[]> | undefined;
const reads = new Map<string, Promise<string | undefined>>();

/** The project's files. Edits keep the list. */
export function listFiles(): Promise<FileEntry[]> {
    listing ??= getEngine().files();
    return listing;
}

/** The text of a project file as the link has it, without the edits. */
export function readFile(path: string): Promise<string | undefined> {
    let read = reads.get(path);
    if (!read) reads.set(path, read = getEngine().read(path));
    return read;
}

function finish(session: SessionInfo): void {
    const errors = session.problems.some(problem => problem.category === 'error');
    setState(draft => {
        draft.session = session;
        if (session.gh && session.gh !== draft.spec.gh) {
            draft.spec.gh = session.gh;
            if (draft.spec.entry) draft.spec.entry = session.file.slice(1);
        }
        draft.phase = 'ready';
        draft.building = false;
        draft.console = [];
        draft.baseConsole = [];
        draft.runs++;
        draft.file ??= session.file;
        draft.typeProblems = [];
        draft.checking = true;
        if (errors) draft.tab = 'problems';
        else if (draft.tab === 'problems') draft.tab = 'console';
    });
    const {file, edits} = current();
    void listFiles();
    if (file && !(file in edits)) void readFile(file);
    void checkTypes(session.id);
}

/** Type checks in the background. The preview does not wait for it. */
async function checkTypes(id: string): Promise<void> {
    let problems: Problem[] = [];
    try {
        problems = await getEngine().check();
    } catch (error) {
        console.warn('The type check failed.', error);
    }
    if (current().session?.id !== id) return;
    setState({typeProblems: problems, checking: false});
    if (problems.some(problem => problem.category === 'error')) setState({tab: 'problems'});
}

/** The problems of the build and of the type check, after a description that could not be read. */
export function allProblems(state: Pick<State, 'pullProblem' | 'session' | 'typeProblems'>): Problem[] {
    const unread: Problem[] = state.pullProblem ? [{file: undefined, line: undefined, column: undefined, code: 0, category: 'warning', text: state.pullProblem}] : [];
    return [...unread, ...state.session?.problems ?? [], ...state.typeProblems];
}

/**
 * A pull request that is opened without files of its own takes its demo from its description.
 * GitHub's API has the description, and allows an anonymous address 60 requests an hour. Past
 * that the project's stock demo runs, with a warning.
 */
async function readPull(spec: LinkSpec): Promise<{pull?: PullRequest; problem?: string}> {
    if (!spec.gh || !isPullRequest(spec.gh) || spec.files || spec.gist || spec.entry) return {};
    const {owner, repo, ref} = parseGithubRef(spec.gh);
    try {
        return {pull: await fetchPullRequest((url, init) => fetch(url, init), owner, repo, Number(ref.split('/')[1]))};
    } catch (error) {
        const status = (error as {status?: number}).status;
        // A pull request that does not exist fails where the project is opened, with a better message.
        if (status === 404) return {};
        const why = status === 403 || status === 429 ? 'GitHub allows 60 anonymous requests an hour from one address. Try again later.' : error instanceof Error ? error.message : String(error);
        return {problem: `The description of this pull request was not read, so a demo in it does not run. ${why}`};
    }
}

/** Counts calls of `openFromLocation`. A call that is no longer the latest drops its result. */
let openings = 0;

/** Opens the project that the page URL names, or shows the landing page when it names none. */
export async function openFromLocation(): Promise<void> {
    const opening = ++openings;
    const params = new URLSearchParams(location.search);
    for (const [key, value] of new URLSearchParams(location.hash.slice(1))) params.set(key, value);
    const spec = await decodeSpec(location.search, location.hash);
    // A result link starts with only the preview. The code and the console are one click away.
    const resultOnly = params.get('view') === 'result';
    const mirror = params.has('mirror') && params.get('mirror') !== '0';
    const packed = params.get('gesture');
    if (packed) void unpack<RecordedInput[]>(packed).then(events => { if (opening === openings) setState({gesture: {events, packed}}); }, () => {});
    setState({spec, showCode: !resultOnly, showPanel: !resultOnly, mirror, gesture: undefined, recording: false, playing: false, edits: {}, file: undefined, session: undefined, base: undefined, baseError: '', pull: undefined, pullProblem: '', error: ''});
    listing = undefined;
    reads.clear();
    if (isEmptySpec(spec)) {
        setState({phase: 'landing'});
        return;
    }
    setState({phase: 'loading', step: 'starting'});
    try {
        const [{pull, problem = ''}] = await Promise.all([readPull(spec), ensureServiceWorker()]);
        if (opening !== openings) return;
        sessionStorage.removeItem('livebranch-reloaded');
        setState({pull, pullProblem: problem});
        const opened = pull && Object.keys(pull.files).length ? {...spec, files: pull.files} : spec;
        const options = {base, cache: !params.has('nocache') && !import.meta.env.DEV};
        const against = baseSource(spec);
        const baseSession = against === undefined ? undefined : getBaseEngine().open({...opened, gh: against, base: undefined}, options).catch((error: unknown) => {
            if (opening === openings) setState({baseError: error instanceof Error ? error.message : String(error)});
            return undefined;
        });
        const session = await getEngine().open(opened, options);
        if (opening === openings) finish(session);
        const built = await baseSession;
        if (opening === openings) setState({base: built});
    } catch (error) {
        if (opening === openings) setState({phase: 'failed', error: error instanceof Error ? error.message : String(error)});
    }
}

let editTimer: ReturnType<typeof setTimeout> | undefined;

/** Records an edit and rebuilds shortly after the last keystroke. */
export function edit(path: string, text: string): void {
    setState(draft => { draft.edits[path] = text; });
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
        setState({building: true});
        try {
            const {base, edits} = current();
            const [session, built] = await Promise.all([
                getEngine().update({...edits}),
                base !== undefined ? getBaseEngine().update({...edits}) : undefined,
            ]);
            finish(session);
            if (base !== undefined) setState({base: built});
        } catch (error) {
            setState({building: false, error: error instanceof Error ? error.message : String(error)});
        }
    }, 350);
}

/** Whether only the preview shows. */
export function isResultOnly(): boolean {
    return !current().showCode && !current().showPanel;
}

/** The parameters of a link that say how it shows and what it plays, apart from what it runs. */
function viewParams(resultOnly: boolean): string {
    const {mirror, gesture} = current();
    return `${resultOnly ? 'view=result&' : ''}${mirror ? 'mirror=1&' : ''}${gesture ? `gesture=${gesture.packed}&` : ''}`;
}

/** Keeps the address in step with how the link shows, so that it can be copied. */
function writeAddress(): void {
    const params = new URLSearchParams(location.hash.slice(1));
    for (const key of ['view', 'mirror', 'gesture']) params.delete(key);
    const rest = params.toString().replaceAll('%2F', '/').replaceAll('%40', '@').replaceAll('%3A', ':');
    history.replaceState(null, '', `#${viewParams(isResultOnly())}${rest}`);
}

/** Shows or hides a part of the workbench. */
export function setView(change: Partial<Pick<State, 'showCode' | 'showPanel' | 'tab'>>): void {
    setState(change);
    writeAddress();
}

/** Gives input on one page of a comparison to the other page too, or stops. */
export function setMirror(on: boolean): void {
    setState({mirror: on});
    writeAddress();
}

/** Keeps a recorded gesture, or drops it, and puts it in the address. */
export function setGesture(gesture: Gesture | undefined): void {
    setState({gesture});
    writeAddress();
}

/** The files that the open project runs on top of its source: the link's, or else the description's, with the edits. */
function demoFiles(): Record<string, string> {
    const state = current();
    const files: Record<string, string> = {...state.pull?.files, ...state.spec.files};
    for (const [path, text] of Object.entries(state.edits)) files[path.slice(1)] = text;
    return files;
}

/** A source at a commit, in the same directory of the repository. */
function atCommit(gh: string, commit: string): string {
    const {owner, repo, subdir} = parseGithubRef(gh);
    return `${owner}/${repo}@${commit}${subdir ? `:${subdir}` : ''}`;
}

/** Whether a source names a commit, which later pushes do not change. */
export function isCommit(gh: string): boolean {
    return /^[0-9a-f]{40}$/.test(parseGithubRef(gh).ref);
}

/**
 * The link of the open project with the edits in it, and with `change` applied. A demo from a
 * pull request's description stays out of the link until it is edited, so that the link keeps
 * following the description. A pinned link names the commits that run now instead of their
 * branches, and carries the description's demo, which could change too.
 */
export async function shareLink(resultOnly = isResultOnly(), change: Partial<LinkSpec> = {}, pin = false): Promise<string> {
    const {edits, spec, session, base: compared} = current();
    const edited = Object.keys(edits).length > 0;
    let link: LinkSpec = {...spec, files: edited ? demoFiles() : spec.files};
    if (pin && spec.gh && session?.commit) {
        const against = baseSource(spec);
        const files = demoFiles();
        link = {
            ...link,
            gh: atCommit(spec.gh, session.commit),
            base: against && compared?.commit ? atCommit(against, compared.commit) : spec.base,
            files: Object.keys(files).length ? files : undefined,
        };
    }
    const params = await encodeSpec({...link, ...change});
    return `${base}#${viewParams(resultOnly)}${params}`;
}

/**
 * The demo of the open project as code blocks for a pull request's description, folded away under
 * a line that says where it runs. Opened by its address, the pull request then runs it. Without a
 * demo of its own the project's stock demo is what a new one starts from.
 */
export async function demoBlock(): Promise<string> {
    const state = current();
    const files = demoFiles();
    const stock = state.session?.file;
    if (!Object.keys(files).length && stock) files[stock.slice(1)] = await getEngine().read(stock) ?? '';
    const {gh} = state.spec;
    if (!gh || !isPullRequest(gh)) return demoSection(files);
    const {owner, repo, ref} = parseGithubRef(gh);
    const against = state.pull?.base || state.spec.base;
    const where = `${base}${owner}/${repo}/${ref.replace(/\/head$/, '')}`;
    return demoSection(files, `The demo runs ${against ? `on ${against} and ` : ''}on this pull request at ${where}`);
}

const defaultBranches = new Map<string, Promise<string | undefined>>();

/** The default branch of a source's repository, or undefined where the site has no reader to ask. It is asked once per repository. */
export function defaultBranch(gh: string): Promise<string | undefined> {
    let repository: string;
    try {
        const {owner, repo} = parseGithubRef(gh);
        repository = `${owner}/${repo}`;
    } catch {
        return Promise.resolve(undefined);
    }
    if (!defaultBranches.has(repository)) {
        defaultBranches.set(repository, (async () => {
            try {
                const response = await fetch(`${base}api/github/default-branch?repo=${repository}`);
                return response.ok ? (await response.json()).branch ?? undefined : undefined;
            } catch {
                return undefined;
            }
        })());
    }
    return defaultBranches.get(repository)!;
}

export interface Branch {
    /** The repository as `owner/name`. */
    repo: string;
    name: string;
}

/** What each fork that was looked up was made from. It costs a request of the visitor's allowance, so it is asked once. */
const forks = new Map<string, Promise<string | undefined>>();

/**
 * The branches whose head is the commit that `gh` names, the default branch first. A fork is
 * mostly held against the repository it was made from, so when the fork has no such branch, that
 * repository is asked. None where the site has no reader to ask.
 */
export async function branchesAt(gh: string): Promise<Branch[]> {
    try {
        const {owner, repo, ref} = parseGithubRef(gh);
        const own = `${owner}/${repo}`;
        const read = async (from: string): Promise<Branch[]> => {
            const response = await fetch(`${base}api/github/branches?repo=${from}&commit=${ref}`);
            const names: string[] = response.ok ? (await response.json()).branches ?? [] : [];
            return names.map(name => ({repo: from, name}));
        };
        const found = await read(own);
        if (found.length) return found;
        if (!forks.has(own)) forks.set(own, forkedFrom((url, init) => fetch(url, init), owner, repo).catch(() => undefined));
        const upstream = await forks.get(own);
        return upstream ? await read(upstream) : [];
    } catch {
        return [];
    }
}

/** Runs the same page against `ref` next to the open project, or stops comparing when `ref` is empty. The edits stay. */
export async function compareWith(ref: string): Promise<void> {
    const link = await shareLink(isResultOnly(), {base: normalizeBase(ref)});
    navigate(link.slice(link.indexOf('#')));
}

export function navigate(hash: string): void {
    location.hash = hash;
}
