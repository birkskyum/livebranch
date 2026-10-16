import {MarkGithubIcon} from '@primer/octicons-react';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {useDefaultLayout} from 'react-resizable-panels';
import {useShallow} from 'zustand/react/shallow';
import {Button} from '@/components/ui/button.tsx';
import {Input} from '@/components/ui/input.tsx';
import {ResizableHandle, ResizablePanel, ResizablePanelGroup} from '@/components/ui/resizable.tsx';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs.tsx';
import {cn} from '@/lib/utils.ts';
import {baseSource, parseGithubRef} from '../engine/spec.ts';
import {CodePanel} from './CodePanel.tsx';
import {Preview} from './Preview.tsx';
import {RefLinks, refLabel} from './RefLinks.tsx';
import {Terminal} from './Terminal.tsx';
import {REPOSITORY, allProblems, compareWith, current, defaultBranch, demoBlock, setState, setView, shareLink, useStore, type ConsoleEntry, type State, type Tab} from './store.ts';

/** The line takes the pointer a few pixels to both sides, also over a preview, which would otherwise take it first. */
const handle = 'z-10 after:w-2 aria-[orientation=horizontal]:after:h-2';

/** A header button that shows whether its part of the workbench is open. */
const toggle = 'aria-pressed:bg-muted aria-pressed:text-foreground';

/** What both pages of a comparison logged, or the one page. */
const useLogged = () => useStore(useShallow((state: State) => [...state.console, ...state.baseConsole]));
const useProblems = () => useStore(useShallow((state: State) => allProblems(state)));

function seconds(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Status() {
    const {phase, building, step, session, pull} = useStore(useShallow(state => ({phase: state.phase, building: state.building, step: state.step, session: state.session, pull: state.pull})));
    let text = '';
    if (phase === 'loading' || building) text = `${step || 'building'}…`;
    else if (phase === 'failed') text = 'failed';
    else if (phase === 'ready' && session) {
        const built = session.cached ? `from cache, ${seconds(session.ms)}` : `${session.sources} modules in ${seconds(session.ms)}`;
        text = pull && Object.keys(pull.files).length ? `${built}, demo from the description` : built;
    }
    return <span className="truncate text-muted-foreground" data-testid="status">{text}</span>;
}

function Header() {
    const [copied, setCopied] = useState<'link' | 'block'>();
    const {gh, session, showCode, showPanel, tab} = useStore(useShallow(state => ({gh: state.spec.gh, session: state.session, showCode: state.showCode, showPanel: state.showPanel, tab: state.tab})));
    const problems = useProblems();
    const logged = useLogged();
    const copy = async (what: 'link' | 'block') => {
        await navigator.clipboard.writeText(await (what === 'link' ? shareLink() : demoBlock()));
        setCopied(what);
        setTimeout(() => setCopied(undefined), 1500);
    };
    const errors = problems.some(problem => problem.category === 'error');
    const loggedErrors = logged.some(entry => entry.level === 'error');
    /** Opens the panel on a tab, or closes it when that tab already shows. */
    const toggleTab = (next: Tab) => {
        if (showPanel && tab === next) setView({showPanel: false});
        else setView({showPanel: true, tab: next});
    };
    return (
        <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
            <a className="font-semibold" href="#">livebranch</a>
            <Sources />
            {session && gh && <Compare />}
            <Status />
            <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className={toggle} aria-pressed={showCode} onClick={() => setView({showCode: !showCode})}>Code</Button>
                <Button variant="ghost" size="sm" className={cn(toggle, errors && 'text-destructive aria-pressed:text-destructive')} aria-pressed={showPanel && tab === 'problems'} onClick={() => toggleTab('problems')}>
                    Problems{problems.length ? ` (${problems.length})` : ''}
                </Button>
                <Button variant="ghost" size="sm" className={cn(toggle, loggedErrors && 'text-destructive aria-pressed:text-destructive')} aria-pressed={showPanel && tab === 'console'} onClick={() => toggleTab('console')}>
                    Console{logged.length ? ` (${logged.length})` : ''}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setState(draft => { draft.runs++; })}>Reload</Button>
                <Button variant="ghost" size="sm" onClick={() => copy('link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</Button>
                {gh && (
                    <Button
                        variant="ghost"
                        size="sm"
                        title="Copies the demo as a code block for the description of a pull request. Opened here by its address, the pull request then runs it."
                        onClick={() => copy('block')}
                    >
                        {copied === 'block' ? 'Copied' : 'Copy for PR'}
                    </Button>
                )}
                <Button variant="ghost" size="icon-sm" asChild>
                    <a href={REPOSITORY} target="_blank" rel="noreferrer" title="livebranch on GitHub" aria-label="livebranch on GitHub"><MarkGithubIcon /></a>
                </Button>
            </div>
        </header>
    );
}

/**
 * The ref that is running, linked to its page on GitHub and to its commit. In a comparison each
 * side names its own ref, so the header does not name them again.
 */
function Sources() {
    const {gh, session, comparing} = useStore(useShallow(state => ({gh: state.spec.gh, session: state.session, comparing: baseSource(state.spec) !== undefined})));
    if (session && comparing) return null;
    return (
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
            {session ? <RefLinks gh={gh} session={session} fallback={session.label} /> : <span>{gh ?? ''}</span>}
        </span>
    );
}

/** The field that names the ref to compare with. */
function CompareForm(props: {close(): void}) {
    const input = useRef<HTMLInputElement>(null);
    const base = useStore(state => state.spec.base);
    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);
    const apply = (ref: string) => {
        props.close();
        void compareWith(ref);
    };
    return (
        <form
            className="flex shrink-0 items-center gap-1"
            onSubmit={event => { event.preventDefault(); apply(input.current?.value ?? ''); }}
            onKeyDown={event => { if (event.key === 'Escape') props.close(); }}
        >
            <Input
                ref={input}
                className="h-7 w-44 font-mono text-xs md:text-xs"
                aria-label="Ref to compare with"
                placeholder="branch, tag, commit or #123"
                spellCheck={false}
                defaultValue={base ?? ''}
            />
            <Button variant="ghost" size="sm" type="submit">Compare</Button>
            {base && <Button variant="ghost" size="sm" type="button" onClick={() => apply('')}>Stop comparing</Button>}
            <Button variant="ghost" size="sm" type="button" onClick={props.close}>Cancel</Button>
        </form>
    );
}

/**
 * Starts, changes and stops the comparison with another ref. The first click compares with the
 * repository's default branch, which is what a branch or a pull request is mostly held against.
 */
function Compare() {
    const [editing, setEditing] = useState(false);
    const {pull, spec} = useStore(useShallow(state => ({pull: state.pull, spec: state.spec})));
    const start = async () => {
        const {spec, pull} = current();
        const gh = spec.gh!;
        const branch = spec.base ? undefined : pull?.base || await defaultBranch(gh);
        // The default branch next to itself shows nothing, so then the ref is asked for.
        if (branch && !['HEAD', branch].includes(parseGithubRef(gh).ref)) void compareWith(branch);
        else setEditing(true);
    };
    // The address of a pull request compares with the default branch, which is not where every one goes.
    const target = pull?.base && spec.base === pull.defaultBranch && pull.base !== spec.base ? pull.base : undefined;
    return (
        <>
            {editing
                ? <CompareForm close={() => setEditing(false)} />
                : <Button variant="ghost" size="sm" className="shrink-0" onClick={start}>{spec.base ? 'Compare with…' : 'Compare'}</Button>}
            {!editing && target && (
                <Button variant="ghost" size="sm" className="shrink-0" title={`This pull request goes into ${target}, not into ${spec.base}.`} onClick={() => void compareWith(target)}>
                    Goes into {target}
                </Button>
            )}
        </>
    );
}

const row = 'border-b border-border/50 px-3 py-1';

function Problems() {
    const problems = useProblems();
    const checking = useStore(state => state.checking);
    return (
        <ul className="flex flex-col font-mono text-xs">
            {checking && <li className="px-3 py-1 text-muted-foreground">Checking types…</li>}
            {!checking && !problems.length && <li className="px-3 py-2 text-muted-foreground">No problems.</li>}
            {problems.map((problem, index) => (
                <li key={index} className={cn(row, 'flex gap-3')}>
                    <span className={cn(problem.category === 'error' && 'text-red-600 dark:text-red-400', problem.category === 'warning' && 'text-amber-600 dark:text-amber-400')}>
                        {problem.category}
                    </span>
                    {problem.file && (
                        <button className="shrink-0 text-blue-600 hover:underline dark:text-blue-400" onClick={() => { setState({file: problem.file}); setView({showCode: true}); }}>
                            {problem.file.slice(1)}{problem.line ? `:${problem.line}` : ''}
                        </button>
                    )}
                    <span className="whitespace-pre-wrap">{problem.code ? `TS${problem.code}: ` : ''}{problem.text}</span>
                </li>
            ))}
        </ul>
    );
}

function Entries(props: {entries: ConsoleEntry[]}) {
    return (
        <ul className="flex flex-col font-mono text-xs">
            {!props.entries.length && <li className="px-3 py-2 text-muted-foreground">The page has logged nothing.</li>}
            {props.entries.map((entry, index) => (
                <li
                    key={index}
                    className={cn(row, 'whitespace-pre-wrap', entry.level === 'error' && 'text-red-600 dark:text-red-400', entry.level === 'warn' && 'text-amber-600 dark:text-amber-400')}
                >
                    {entry.text}
                </li>
            ))}
        </ul>
    );
}

function ConsoleColumn(props: {label: string; entries: ConsoleEntry[]}) {
    return (
        <section className="flex min-w-0 flex-1 flex-col" aria-label={`Console of ${props.label}`}>
            <h3 className="shrink-0 border-b px-3 py-1 font-mono text-xs text-muted-foreground">{props.label}</h3>
            <div className="min-h-0 flex-1 overflow-auto"><Entries entries={props.entries} /></div>
        </section>
    );
}

/** What the page logged. In a comparison each page has a console of its own, in the order of the previews. */
function Console() {
    const state = useStore(useShallow(state => ({spec: state.spec, session: state.session, base: state.base, console: state.console, baseConsole: state.baseConsole})));
    const against = baseSource(state.spec);
    if (against === undefined) return <Entries entries={state.console} />;
    return (
        <div className="flex h-full divide-x">
            <ConsoleColumn label={refLabel(against, state.base) || state.spec.base!} entries={state.baseConsole} />
            <ConsoleColumn label={refLabel(state.spec.gh, state.session) || state.session?.label || ''} entries={state.console} />
        </div>
    );
}

function Build() {
    const session = useStore(state => state.session);
    return (
        <div className="flex flex-col gap-2 px-3 py-2 font-mono text-xs">
            <table className="self-start">
                <tbody>
                    {session?.steps.map((step, index) => (
                        <tr key={index}>
                            <td className="pr-4 text-muted-foreground">{step.name}</td>
                            <td className="pr-4 text-right tabular-nums">{seconds(step.ms)}</td>
                            <td className="text-muted-foreground">{step.detail}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {session?.log && <pre className="whitespace-pre-wrap text-muted-foreground">{session.log}</pre>}
        </div>
    );
}

function BottomPanel() {
    const tab = useStore(state => state.tab);
    const problems = useProblems().length;
    const logged = useLogged().length;
    const tabs: {id: Tab; label: string; content: ReactNode}[] = [
        {id: 'problems', label: problems ? `Problems (${problems})` : 'Problems', content: <Problems />},
        {id: 'console', label: logged ? `Console (${logged})` : 'Console', content: <Console />},
        {id: 'terminal', label: 'Terminal', content: <Terminal />},
        {id: 'build', label: 'Build', content: <Build />},
    ];
    return (
        <Tabs value={tab} onValueChange={value => setState({tab: value as Tab})} className="h-full gap-0">
            <TabsList variant="line" className="w-full shrink-0 justify-start rounded-none border-b px-2">
                {/* Radix focuses a pressed tab from script, which Chrome rings as if the keyboard had moved there. */}
                {tabs.map(({id, label}) => (
                    <TabsTrigger
                        key={id}
                        value={id}
                        className="flex-none"
                        onMouseDown={event => {
                            if (event.button !== 0 || event.ctrlKey) return;
                            event.preventDefault();
                            setState({tab: id});
                        }}
                    >
                        {label}
                    </TabsTrigger>
                ))}
            </TabsList>
            {tabs.map(({id, content}) => <TabsContent key={id} value={id} className="min-h-0 overflow-auto">{content}</TabsContent>)}
        </Tabs>
    );
}

function Failure() {
    const error = useStore(state => state.error);
    return (
        <div className="flex h-full flex-col items-start gap-3 p-6">
            <h2 className="text-lg font-semibold">This link could not be opened</h2>
            <pre className="font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">{error}</pre>
            <a className="text-blue-600 underline dark:text-blue-400" href="#">Start over</a>
        </div>
    );
}

/**
 * The header over the code on the left and the preview on the right, with the panel under the
 * preview only, so that in a comparison each console is under its page. The lines between them
 * move, and where they were is kept for the next visit. While one moves the previews do not take
 * the pointer, which they would otherwise keep once it is over them.
 */
export function Workbench() {
    const {phase, showCode, showPanel, opened} = useStore(useShallow(state => ({phase: state.phase, showCode: state.showCode, showPanel: state.showPanel, opened: state.session !== undefined})));
    const code = showCode && opened;
    const across = useDefaultLayout({id: 'livebranch-code', panelIds: code ? ['code', 'page'] : ['page'], storage: localStorage});
    const down = useDefaultLayout({id: 'livebranch-panel', panelIds: showPanel ? ['preview', 'panel'] : ['preview'], storage: localStorage});
    return (
        <div className="flex h-full flex-col [&:has([data-separator=active])_iframe]:pointer-events-none">
            <Header />
            {phase === 'failed' ? <Failure /> : (
                <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={across.defaultLayout} onLayoutChanged={across.onLayoutChanged}>
                    {code && (
                        <>
                            <ResizablePanel id="code" defaultSize="50%" minSize={240}><CodePanel /></ResizablePanel>
                            <ResizableHandle className={handle} aria-label="Width of the code" />
                        </>
                    )}
                    <ResizablePanel id="page" minSize={240}>
                        <ResizablePanelGroup orientation="vertical" defaultLayout={down.defaultLayout} onLayoutChanged={down.onLayoutChanged}>
                            <ResizablePanel id="preview" minSize={80}><Preview /></ResizablePanel>
                            {showPanel && (
                                <>
                                    <ResizableHandle className={handle} aria-label="Height of the panel" />
                                    <ResizablePanel id="panel" defaultSize={224} minSize={64} groupResizeBehavior="preserve-pixel-size"><BottomPanel /></ResizablePanel>
                                </>
                            )}
                        </ResizablePanelGroup>
                    </ResizablePanel>
                </ResizablePanelGroup>
            )}
        </div>
    );
}
