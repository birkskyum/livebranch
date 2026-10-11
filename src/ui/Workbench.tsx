import {For, Match, Show, Switch, createMemo, createSignal} from 'solid-js';
import {CodePanel} from './CodePanel.tsx';
import {Preview} from './Preview.tsx';
import {Terminal} from './Terminal.tsx';
import {baseSource} from '../engine/spec.ts';
import {RefLinks} from './RefLinks.tsx';
import {allProblems, setState, setView, shareLink, state, type Tab} from './store.ts';

const button = 'rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-800';

function seconds(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Status() {
    const summary = createMemo(() => {
        const session = state.session;
        if (!session) return '';
        return session.cached ? `from cache, ${seconds(session.ms)}` : `${session.sources} modules in ${seconds(session.ms)}`;
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
    const [copied, setCopied] = createSignal(false);
    const copy = async () => {
        await navigator.clipboard.writeText(await shareLink());
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    const errors = () => allProblems().filter(problem => problem.category === 'error').length;
    const logged = () => state.console.length;
    const loggedErrors = () => state.console.some(entry => entry.level === 'error');
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
                <button class={button} onClick={copy}>{copied() ? 'Copied' : 'Copy link'}</button>
            </div>
        </header>
    );
}

/** The refs that are running, each linked to its page on GitHub and to its commit. */
function Sources() {
    return (
        <span class="flex min-w-0 items-center gap-2 font-mono text-xs">
            <Show when={state.session} fallback={<span>{state.spec.gh ?? ''}</span>}>
                <Show when={baseSource(state.spec)}>
                    <RefLinks gh={baseSource(state.spec)} session={state.base} />
                    <span class="text-neutral-400">and</span>
                </Show>
                <RefLinks gh={state.spec.gh} session={state.session} fallback={state.session!.label} />
            </Show>
        </span>
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

function Console() {
    return (
        <ul class="flex flex-col font-mono text-xs">
            <For each={state.console} fallback={<li class="px-3 py-2 text-neutral-500">The page has logged nothing.</li>}>
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
        {id: 'console', label: state.console.length ? `Console (${state.console.length})` : 'Console'},
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
