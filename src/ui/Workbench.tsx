import {For, Match, Show, Switch, createMemo, createSignal, onMount} from 'solid-js';
import {CodePanel} from './CodePanel.tsx';
import {Preview} from './Preview.tsx';
import {Terminal} from './Terminal.tsx';
import {baseSource, parseGithubRef} from '../engine/spec.ts';
import {RefLinks, refLabel} from './RefLinks.tsx';
import {allProblems, compareWith, defaultBranch, demoBlock, setState, setView, shareLink, state, type ConsoleEntry, type Tab} from './store.ts';

const button = 'rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-800';

/** What both pages of a comparison logged, or the one page. */
const allLogged = () => [...state.console, ...state.baseConsole];

function seconds(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Status() {
    const summary = createMemo(() => {
        const session = state.session;
        if (!session) return '';
        const built = session.cached ? `from cache, ${seconds(session.ms)}` : `${session.sources} modules in ${seconds(session.ms)}`;
        return state.pull && Object.keys(state.pull.files).length ? `${built}, demo from the description` : built;
    });
    return (
        <span class="truncate text-neutral-500" data-testid="status">
            <Switch>
                <Match when={state.phase === 'loading' || state.building}>{state.step || 'building'}…</Match>
                <Match when={state.phase === 'failed'}>failed</Match>
                <Match when={state.phase === 'ready'}>{summary()}</Match>
            </Switch>
        </span>
    );
}

function Header() {
    const [copied, setCopied] = createSignal<'link' | 'block'>();
    const copy = async (what: 'link' | 'block') => {
        await navigator.clipboard.writeText(await (what === 'link' ? shareLink() : demoBlock()));
        setCopied(what);
        setTimeout(() => setCopied(), 1500);
    };
    const errors = () => allProblems().filter(problem => problem.category === 'error').length;
    const logged = () => allLogged().length;
    const loggedErrors = () => allLogged().some(entry => entry.level === 'error');
    /** Opens the panel on a tab, or closes it when that tab already shows. */
    const toggleTab = (tab: Tab) => {
        if (state.showPanel && state.tab === tab) setView({showPanel: false});
        else setView({showPanel: true, tab});
    };
    const on = 'bg-neutral-200 dark:bg-neutral-800';
    return (
        <header class="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-200 px-3 dark:border-neutral-800">
            <a class="font-semibold" href="#">livebranch</a>
            <Sources />
            <Show when={state.session && state.spec.gh}><Compare /></Show>
            <Status />
            <div class="ml-auto flex items-center gap-1">
                <button class={button} classList={{[on]: state.showCode}} aria-pressed={state.showCode} onClick={() => setView({showCode: !state.showCode})}>Code</button>
                <button class={button} classList={{[on]: state.showPanel && state.tab === 'problems', 'text-red-600 dark:text-red-400': errors() > 0}} onClick={() => toggleTab('problems')}>
                    Problems{allProblems().length ? ` (${allProblems().length})` : ''}
                </button>
                <button class={button} classList={{[on]: state.showPanel && state.tab === 'console', 'text-red-600 dark:text-red-400': loggedErrors()}} onClick={() => toggleTab('console')}>
                    Console{logged() ? ` (${logged()})` : ''}
                </button>
                <button class={button} onClick={() => setState('runs', state.runs + 1)}>Reload</button>
                <button class={button} onClick={() => copy('link')}>{copied() === 'link' ? 'Copied' : 'Copy link'}</button>
                <Show when={state.spec.gh}>
                    <button
                        class={button}
                        title="Copies the demo as a code block for the description of a pull request. Opened here by its address, the pull request then runs it."
                        onClick={() => copy('block')}
                    >
                        {copied() === 'block' ? 'Copied' : 'Copy for PR'}
                    </button>
                </Show>
            </div>
        </header>
    );
}

/**
 * The ref that is running, linked to its page on GitHub and to its commit. In a comparison each
 * side names its own ref, so the header does not name them again.
 */
function Sources() {
    return (
        <Show when={!state.session || !baseSource(state.spec)}>
            <span class="flex min-w-0 items-center gap-2 font-mono text-xs">
                <Show when={state.session} fallback={<span>{state.spec.gh ?? ''}</span>}>
                    <RefLinks gh={state.spec.gh} session={state.session} fallback={state.session!.label} />
                </Show>
            </span>
        </Show>
    );
}

/** The field that names the ref to compare with. */
function CompareForm(props: {close(): void}) {
    let input!: HTMLInputElement;
    onMount(() => {
        input.focus();
        input.select();
    });
    const apply = (ref: string) => {
        props.close();
        void compareWith(ref);
    };
    return (
        <form class="flex shrink-0 items-center gap-1" onSubmit={event => { event.preventDefault(); apply(input.value); }} onKeyDown={event => { if (event.key === 'Escape') props.close(); }}>
            <input
                ref={input}
                class="w-44 rounded border border-neutral-300 bg-transparent px-2 py-0.5 font-mono text-xs dark:border-neutral-700"
                aria-label="Ref to compare with"
                placeholder="branch, tag, commit or #123"
                spellcheck={false}
                value={state.spec.base ?? ''}
            />
            <button class={button} type="submit">Compare</button>
            <Show when={state.spec.base}><button class={button} type="button" onClick={() => apply('')}>Stop comparing</button></Show>
            <button class={button} type="button" onClick={props.close}>Cancel</button>
        </form>
    );
}

/**
 * Starts, changes and stops the comparison with another ref. The first click compares with the
 * repository's default branch, which is what a branch or a pull request is mostly held against.
 */
function Compare() {
    const [editing, setEditing] = createSignal(false);
    const start = async () => {
        const gh = state.spec.gh!;
        const branch = state.spec.base ? undefined : state.pull?.base || await defaultBranch(gh);
        // The default branch next to itself shows nothing, so then the ref is asked for.
        if (branch && !['HEAD', branch].includes(parseGithubRef(gh).ref)) void compareWith(branch);
        else setEditing(true);
    };
    // The address of a pull request compares with the default branch, which is not where every one goes.
    const target = () => {
        const {pull, spec} = state;
        return pull?.base && spec.base === pull.defaultBranch && pull.base !== spec.base ? pull.base : undefined;
    };
    return (
        <>
            <Show when={editing()} fallback={<button class={`${button} shrink-0`} onClick={start}>{state.spec.base ? 'Compare with…' : 'Compare'}</button>}>
                <CompareForm close={() => setEditing(false)} />
            </Show>
            <Show when={!editing() && target()}>
                <button class={`${button} shrink-0`} title={`This pull request goes into ${target()}, not into ${state.spec.base}.`} onClick={() => void compareWith(target()!)}>Goes into {target()}</button>
            </Show>
        </>
    );
}

function Problems() {
    return (
        <ul class="flex flex-col font-mono text-xs">
            <Show when={state.checking}><li class="px-3 py-1 text-neutral-500">Checking types…</li></Show>
            <For each={allProblems()} fallback={<Show when={!state.checking}><li class="px-3 py-2 text-neutral-500">No problems.</li></Show>}>
                {problem => (
                    <li class="flex gap-3 border-b border-neutral-100 px-3 py-1 dark:border-neutral-900">
                        <span classList={{'text-red-600 dark:text-red-400': problem.category === 'error', 'text-amber-600 dark:text-amber-400': problem.category === 'warning'}}>
                            {problem.category}
                        </span>
                        <Show when={problem.file}>
                            <button class="shrink-0 text-blue-600 hover:underline dark:text-blue-400" onClick={() => { setState('file', problem.file); setView({showCode: true}); }}>
                                {problem.file!.slice(1)}{problem.line ? `:${problem.line}` : ''}
                            </button>
                        </Show>
                        <span class="whitespace-pre-wrap">{problem.code ? `TS${problem.code}: ` : ''}{problem.text}</span>
                    </li>
                )}
            </For>
        </ul>
    );
}

function Entries(props: {entries: ConsoleEntry[]}) {
    return (
        <ul class="flex flex-col font-mono text-xs">
            <For each={props.entries} fallback={<li class="px-3 py-2 text-neutral-500">The page has logged nothing.</li>}>
                {entry => (
                    <li
                        class="whitespace-pre-wrap border-b border-neutral-100 px-3 py-1 dark:border-neutral-900"
                        classList={{'text-red-600 dark:text-red-400': entry.level === 'error', 'text-amber-600 dark:text-amber-400': entry.level === 'warn'}}
                    >
                        {entry.text}
                    </li>
                )}
            </For>
        </ul>
    );
}

function ConsoleColumn(props: {label: string; entries: ConsoleEntry[]}) {
    return (
        <section class="flex min-w-0 flex-1 flex-col" aria-label={`Console of ${props.label}`}>
            <h3 class="shrink-0 border-b border-neutral-200 px-3 py-1 font-mono text-xs text-neutral-500 dark:border-neutral-800">{props.label}</h3>
            <div class="min-h-0 flex-1 overflow-auto"><Entries entries={props.entries} /></div>
        </section>
    );
}

/** What the page logged. In a comparison each page has a console of its own, in the order of the previews. */
function Console() {
    return (
        <Show when={baseSource(state.spec)} fallback={<Entries entries={state.console} />}>
            <div class="flex h-full divide-x divide-neutral-200 dark:divide-neutral-800">
                <ConsoleColumn label={refLabel(baseSource(state.spec), state.base) || state.spec.base!} entries={state.baseConsole} />
                <ConsoleColumn label={refLabel(state.spec.gh, state.session) || state.session?.label || ''} entries={state.console} />
            </div>
        </Show>
    );
}

function Build() {
    return (
        <div class="flex flex-col gap-2 px-3 py-2 font-mono text-xs">
            <table class="self-start">
                <tbody>
                    <For each={state.session?.steps}>
                        {step => (
                            <tr>
                                <td class="pr-4 text-neutral-500">{step.name}</td>
                                <td class="pr-4 text-right tabular-nums">{seconds(step.ms)}</td>
                                <td class="text-neutral-500">{step.detail}</td>
                            </tr>
                        )}
                    </For>
                </tbody>
            </table>
            <Show when={state.session?.log}><pre class="whitespace-pre-wrap text-neutral-500">{state.session!.log}</pre></Show>
        </div>
    );
}

function BottomPanel() {
    const errors = () => allProblems().length;
    const tabs = (): {id: Tab; label: string}[] => [
        {id: 'problems', label: errors() ? `Problems (${errors()})` : 'Problems'},
        {id: 'console', label: allLogged().length ? `Console (${allLogged().length})` : 'Console'},
        {id: 'terminal', label: 'Terminal'},
        {id: 'build', label: 'Build'},
    ];
    return (
        <section class="flex h-56 shrink-0 flex-col border-t border-neutral-200 dark:border-neutral-800">
            <nav class="flex shrink-0 gap-1 border-b border-neutral-200 px-2 dark:border-neutral-800">
                <For each={tabs()}>
                    {tab => (
                        <button
                            class="border-b-2 px-2 py-1.5"
                            classList={{'border-blue-600': state.tab === tab.id, 'border-transparent text-neutral-500': state.tab !== tab.id}}
                            onClick={() => setState('tab', tab.id)}
                        >
                            {tab.label}
                        </button>
                    )}
                </For>
            </nav>
            <div class="min-h-0 flex-1 overflow-auto">
                <Switch>
                    <Match when={state.tab === 'problems'}><Problems /></Match>
                    <Match when={state.tab === 'console'}><Console /></Match>
                    <Match when={state.tab === 'terminal'}><Terminal /></Match>
                    <Match when={state.tab === 'build'}><Build /></Match>
                </Switch>
            </div>
        </section>
    );
}

function Failure() {
    return (
        <div class="flex h-full flex-col items-start gap-3 p-6">
            <h2 class="text-lg font-semibold">This link could not be opened</h2>
            <pre class="whitespace-pre-wrap font-mono text-xs text-red-600 dark:text-red-400">{state.error}</pre>
            <a class="text-blue-600 underline dark:text-blue-400" href="#">Start over</a>
        </div>
    );
}

export function Workbench() {
    return (
        <div class="flex h-full flex-col">
            <Header />
            <Show when={state.phase !== 'failed'} fallback={<Failure />}>
                <div class="flex min-h-0 flex-1">
                    <Show when={state.showCode && state.session}>
                        <div class="flex w-1/2 min-w-0 border-r border-neutral-200 dark:border-neutral-800"><CodePanel /></div>
                    </Show>
                    <div class="min-w-0 flex-1"><Preview /></div>
                </div>
                <Show when={state.showPanel}><BottomPanel /></Show>
            </Show>
        </div>
    );
}
