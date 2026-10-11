import {For, Match, Show, Switch, createMemo, createSignal} from 'solid-js';
import {CodePanel} from './CodePanel.tsx';
import {Preview} from './Preview.tsx';
import {Terminal} from './Terminal.tsx';
import {allProblems, setState, shareLink, state, type Tab} from './store.ts';

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
    const [copied, setCopied] = createSignal('');
    const copy = async (resultOnly: boolean) => {
        await navigator.clipboard.writeText(await shareLink(resultOnly));
        setCopied(resultOnly ? 'result' : 'full');
        setTimeout(() => setCopied(''), 1500);
    };
    const commitUrl = () => {
        const match = /^([^@:]+)(?:@pull\/(\d+))?/.exec(state.spec.gh ?? '');
        if (!match || !state.session?.commit) return undefined;
        return match[2] ? `https://github.com/${match[1]}/pull/${match[2]}` : `https://github.com/${match[1]}/tree/${state.session.commit}`;
    };
    return (
        <header class="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-200 px-3 dark:border-neutral-800">
            <a class="font-semibold" href="#">tscrs repro</a>
            <Show when={state.session}>
                {session => (
                    <Show when={commitUrl()} fallback={<span class="font-mono text-xs">{session().label}</span>}>
                        <a class="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400" href={commitUrl()} target="_blank" rel="noreferrer">{session().label}</a>
                    </Show>
                )}
            </Show>
            <Status />
            <div class="ml-auto flex items-center gap-1">
                <button class={button} onClick={() => setState('showCode', !state.showCode)}>{state.showCode ? 'Hide code' : 'Show code'}</button>
                <button class={button} onClick={() => setState('runs', state.runs + 1)}>Reload</button>
                <button class={button} onClick={() => copy(false)}>{copied() === 'full' ? 'Copied' : 'Copy link'}</button>
                <button class={button} onClick={() => copy(true)}>{copied() === 'result' ? 'Copied' : 'Copy result link'}</button>
            </div>
        </header>
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
                            <button class="shrink-0 text-blue-600 hover:underline dark:text-blue-400" onClick={() => setState({file: problem.file, showCode: true})}>
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
            <h2 class="text-lg font-semibold">The repro could not be opened</h2>
            <pre class="whitespace-pre-wrap font-mono text-xs text-red-600 dark:text-red-400">{state.error}</pre>
            <a class="text-blue-600 underline dark:text-blue-400" href="#">Start over</a>
        </div>
    );
}

export function Workbench() {
    return (
        <Show when={!state.resultOnly} fallback={<ResultOnly />}>
            <div class="flex h-full flex-col">
                <Header />
                <Show when={state.phase !== 'failed'} fallback={<Failure />}>
                    <div class="flex min-h-0 flex-1">
                        <Show when={state.showCode && state.session}>
                            <div class="flex w-1/2 min-w-0 border-r border-neutral-200 dark:border-neutral-800"><CodePanel /></div>
                        </Show>
                        <div class="min-w-0 flex-1"><Preview /></div>
                    </div>
                    <BottomPanel />
                </Show>
            </div>
        </Show>
    );
}

/** The built page alone. A small link opens the workbench for the same repro. */
function ResultOnly() {
    const full = () => `#${location.hash.slice(1).replace(/(^|&)view=result(&|$)/, '$1').replace(/&$/, '')}`;
    const errors = () => allProblems().filter(problem => problem.category === 'error').length;
    return (
        <div class="relative h-full">
            <Show when={state.phase !== 'failed'} fallback={<Failure />}><Preview /></Show>
            <a
                class="absolute bottom-2 left-2 rounded bg-neutral-900/80 px-2 py-1 text-xs text-white hover:bg-neutral-900"
                href={full()}
                data-testid="status"
            >
                <Switch fallback="tscrs repro">
                    <Match when={state.phase === 'loading'}>{state.step || 'building'}…</Match>
                    <Match when={errors()}>{errors()} {errors() === 1 ? 'error' : 'errors'}</Match>
                </Switch>
            </a>
        </div>
    );
}
