import {createStore, produce} from 'solid-js/store';
import {createEngine, type Engine} from '../engine/client.ts';
import type {Problem} from '../engine/build.ts';
import type {SessionInfo} from '../engine/protocol.ts';
import {decodeSpec, encodeSpec, isEmptySpec, type ReproSpec} from '../engine/spec.ts';

export type Phase = 'landing' | 'loading' | 'ready' | 'failed';
export type Tab = 'problems' | 'console' | 'terminal' | 'build';

export interface ConsoleEntry {
    level: 'log' | 'info' | 'warn' | 'error' | 'debug';
    text: string;
}

export interface State {
    phase: Phase;
    spec: ReproSpec;
    /** Only the built page, without the workbench around it. */
    resultOnly: boolean;
    step: string;
    error: string;
    session: SessionInfo | undefined;
    console: ConsoleEntry[];
    /** Counts reloads of the preview. */
    runs: number;
    tab: Tab;
    showCode: boolean;
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
    resultOnly: false,
    step: '',
    error: '',
    session: undefined,
    console: [],
    runs: 0,
    tab: 'console',
    showCode: true,
    file: undefined,
    edits: {},
    building: false,
    typeProblems: [],
    checking: false,
});

/** The URL of the app's directory. The service worker's scope and the engine's assets hang off it. */
export const base = new URL('./', location.href.split(/[?#]/)[0]).href;

let engine: Engine | undefined;

export function getEngine(): Engine {
    if (!engine) {
        engine = createEngine();
        engine.events.step = (name, detail) => setState('step', detail ? `${name}: ${detail}` : name);
    }
    return engine;
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
    if (!sessionStorage.getItem('repro-reloaded')) {
        sessionStorage.setItem('repro-reloaded', '1');
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
            if (draft.spec.entry) draft.spec.entry = session.entry.slice(1);
        }
        draft.phase = 'ready';
        draft.building = false;
        draft.console = [];
        draft.runs++;
        draft.file ??= session.entry;
        draft.typeProblems = [];
        draft.checking = true;
        if (errors) draft.tab = 'problems';
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

/** The problems of the build and of the type check. */
export function allProblems(): Problem[] {
    return [...state.session?.problems ?? [], ...state.typeProblems];
}

/** Counts calls of `openFromLocation`. A call that is no longer the latest drops its result. */
let openings = 0;

/** Opens the repro that the page URL names, or shows the landing page when it names none. */
export async function openFromLocation(): Promise<void> {
    const opening = ++openings;
    const params = new URLSearchParams(location.search);
    for (const [key, value] of new URLSearchParams(location.hash.slice(1))) params.set(key, value);
    const spec = await decodeSpec(location.search, location.hash);
    setState({spec, resultOnly: params.get('view') === 'result', edits: {}, file: undefined, session: undefined, error: ''});
    if (isEmptySpec(spec)) {
        setState('phase', 'landing');
        return;
    }
    setState({phase: 'loading', step: 'starting'});
    try {
        await ensureServiceWorker();
        sessionStorage.removeItem('repro-reloaded');
        const session = await getEngine().open(spec, {base, cache: !params.has('nocache') && !import.meta.env.DEV});
        if (opening === openings) finish(session);
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
            finish(await getEngine().update({...state.edits}));
        } catch (error) {
            setState({building: false, error: error instanceof Error ? error.message : String(error)});
        }
    }, 350);
}

/** The link of the open repro with the edits in it. */
export async function shareLink(resultOnly: boolean): Promise<string> {
    const files: Record<string, string> = {...state.spec.files};
    for (const [path, text] of Object.entries(state.edits)) files[path.slice(1)] = text;
    const params = await encodeSpec({...state.spec, files});
    return `${base}#${resultOnly ? 'view=result&' : ''}${params}`;
}

export function navigate(hash: string): void {
    location.hash = hash;
}
