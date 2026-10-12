import {createStore, produce} from 'solid-js/store';
import {createEngine, type Engine} from '../engine/client.ts';
import type {Problem} from '../engine/build.ts';
import type {SessionInfo} from '../engine/protocol.ts';
import {demoSection, fetchPullRequest, type PullRequest} from '../engine/sources/pull.ts';
import {baseSource, decodeSpec, encodeSpec, isEmptySpec, isPullRequest, normalizeBase, parseGithubRef, type LinkSpec} from '../engine/spec.ts';

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
    console: ConsoleEntry[];
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
}

export const [state, setState] = createStore<State>({
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
    runs: 0,
    tab: 'console',
    showCode: true,
    showPanel: true,
    file: undefined,
    edits: {},
    building: false,
    typeProblems: [],
    checking: false,
});

/** The URL of the app's directory. The service worker's scope and the engine's assets hang off it. */
export const base = new URL('./', location.href.split(/[?#]/)[0]).href;

let engine: Engine | undefined;
let baseEngine: Engine | undefined;

export function getEngine(): Engine {
    if (!engine) {
        engine = createEngine();
        engine.events.step = (name, detail) => setState('step', detail ? `${name}: ${detail}` : name);
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

function finish(session: SessionInfo): void {
    const errors = session.problems.some(problem => problem.category === 'error');
    setState(produce(draft => {
        draft.session = session;
        if (session.gh && session.gh !== draft.spec.gh) {
            draft.spec.gh = session.gh;
            if (draft.spec.entry) draft.spec.entry = session.file.slice(1);
        }
        draft.phase = 'ready';
        draft.building = false;
        draft.console = [];
        draft.runs++;
        draft.file ??= session.file;
        draft.typeProblems = [];
        draft.checking = true;
        if (errors) draft.tab = 'problems';
        else if (draft.tab === 'problems') draft.tab = 'console';
    }));
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
    if (state.session?.id !== id) return;
    setState({typeProblems: problems, checking: false});
    if (problems.some(problem => problem.category === 'error')) setState('tab', 'problems');
}

/** The problems of the build and of the type check, after a description that could not be read. */
export function allProblems(): Problem[] {
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
    setState({spec, showCode: !resultOnly, showPanel: !resultOnly, edits: {}, file: undefined, session: undefined, base: undefined, baseError: '', pull: undefined, pullProblem: '', error: ''});
    if (isEmptySpec(spec)) {
        setState('phase', 'landing');
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
            if (opening === openings) setState('baseError', error instanceof Error ? error.message : String(error));
            return undefined;
        });
        const session = await getEngine().open(opened, options);
        if (opening === openings) finish(session);
        const built = await baseSession;
        if (opening === openings) setState('base', built);
    } catch (error) {
        if (opening === openings) setState({phase: 'failed', error: error instanceof Error ? error.message : String(error)});
    }
}

let editTimer: ReturnType<typeof setTimeout> | undefined;

/** Records an edit and rebuilds shortly after the last keystroke. */
export function edit(path: string, text: string): void {
    setState('edits', path, text);
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
        setState('building', true);
        try {
            const comparing = state.base !== undefined;
            const [session, built] = await Promise.all([
                getEngine().update({...state.edits}),
                comparing ? getBaseEngine().update({...state.edits}) : undefined,
            ]);
            finish(session);
            if (comparing) setState('base', built);
        } catch (error) {
            setState({building: false, error: error instanceof Error ? error.message : String(error)});
        }
    }, 350);
}

/** Whether only the preview shows. */
export function isResultOnly(): boolean {
    return !state.showCode && !state.showPanel;
}

/** Shows or hides a part of the workbench, and keeps the address in step so that it can be copied. */
export function setView(change: Partial<Pick<State, 'showCode' | 'showPanel' | 'tab'>>): void {
    setState(change);
    const params = new URLSearchParams(location.hash.slice(1));
    params.delete('view');
    const rest = params.toString().replaceAll('%2F', '/').replaceAll('%40', '@').replaceAll('%3A', ':');
    history.replaceState(null, '', `#${isResultOnly() ? 'view=result&' : ''}${rest}`);
}

/** The files that the open project runs on top of its source: the link's, or else the description's, with the edits. */
function demoFiles(): Record<string, string> {
    const files: Record<string, string> = {...state.pull?.files, ...state.spec.files};
    for (const [path, text] of Object.entries(state.edits)) files[path.slice(1)] = text;
    return files;
}

/**
 * The link of the open project with the edits in it, and with `change` applied. A demo from a
 * pull request's description stays out of the link until it is edited, so that the link keeps
 * following the description.
 */
export async function shareLink(resultOnly = isResultOnly(), change: Partial<LinkSpec> = {}): Promise<string> {
    const edited = Object.keys(state.edits).length > 0;
    const params = await encodeSpec({...state.spec, files: edited ? demoFiles() : state.spec.files, ...change});
    return `${base}#${resultOnly ? 'view=result&' : ''}${params}`;
}

/**
 * The demo of the open project as code blocks for a pull request's description, folded away under
 * a line that says where it runs. Opened by its address, the pull request then runs it. Without a
 * demo of its own the project's stock demo is what a new one starts from.
 */
export async function demoBlock(): Promise<string> {
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

/** The default branch of a source's repository, or undefined where the site has no reader to ask. */
export async function defaultBranch(gh: string): Promise<string | undefined> {
    try {
        const {owner, repo} = parseGithubRef(gh);
        const response = await fetch(`${base}api/github/default-branch?repo=${owner}/${repo}`);
        return response.ok ? (await response.json()).branch ?? undefined : undefined;
    } catch {
        return undefined;
    }
}

/** The branches whose head is the commit that `gh` names, the default branch first. None where the site has no reader to ask. */
export async function branchesAt(gh: string): Promise<string[]> {
    try {
        const {owner, repo, ref} = parseGithubRef(gh);
        const response = await fetch(`${base}api/github/branches?repo=${owner}/${repo}&commit=${ref}`);
        return response.ok ? (await response.json()).branches ?? [] : [];
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
