import {useEffect, useRef, type RefObject} from 'react';
import {useShallow} from 'zustand/react/shallow';
import type {SessionInfo} from '../engine/protocol.ts';
import {baseSource} from '../engine/spec.ts';
import {PreviewBar} from './PreviewBar.tsx';
import {refLabel} from './RefLinks.tsx';
import {current, setState, useStore, type ConsoleEntry} from './store.ts';

const MAX_ENTRIES = 500;

type Side = 'base' | 'head';
const other = (side: Side): Side => side === 'base' ? 'head' : 'base';

function Frame(props: {session: SessionInfo; gh: string | undefined; labelled: boolean; frame: RefObject<HTMLIFrameElement | null>}) {
    const runs = useStore(state => state.runs);
    return (
        <div className="relative min-w-0 flex-1">
            {/* A new run gets a new frame, so that no state of the old page survives. */}
            <iframe
                key={`${props.session.url}#${runs}`}
                ref={props.frame}
                className="h-full w-full border-0 bg-white"
                title={props.labelled ? `Preview of ${refLabel(props.gh, props.session)}` : 'Preview'}
                src={props.session.url}
                allow="geolocation; fullscreen; clipboard-write; xr-spatial-tracking"
            />
        </div>
    );
}

/**
 * The built page in a frame, or two frames when the link compares two refs, under the bar that
 * names them. The console of a page arrives as messages from the script that the build put into
 * it, and each frame has its own.
 */
export function Preview() {
    const head = useRef<HTMLIFrameElement>(null);
    const base = useRef<HTMLIFrameElement>(null);
    const {session, baseSession, baseError, spec, step, runs, syncViews} = useStore(useShallow(state => ({
        session: state.session,
        baseSession: state.base,
        baseError: state.baseError,
        spec: state.spec,
        step: state.step,
        runs: state.runs,
        syncViews: state.syncViews,
    })));
    const comparing = baseSource(spec) !== undefined;
    const frames = {base, head};
    // The view that each thing of a side last offered, and the things of a side that can show one.
    // A page that loads after the other side moved is given that view.
    const views = useRef({base: new Map<number, unknown>(), head: new Map<number, unknown>()});
    const able = useRef({base: new Set<number>(), head: new Set<number>()});
    const show = (side: Side, index: number, view: unknown) => frames[side].current?.contentWindow?.postMessage({livebranch: 'view', index, view}, '*');

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            const side: Side | undefined = event.source === base.current?.contentWindow ? 'base' : event.source === head.current?.contentWindow ? 'head' : undefined;
            const data = event.data;
            if (!side) return;
            if (data?.livebranch === 'console') {
                const entry: ConsoleEntry = {level: data.level, text: (data.args as string[]).join(' ')};
                setState(draft => {
                    const logged = side === 'base' ? draft.baseConsole : draft.console;
                    logged.push(entry);
                    if (logged.length > MAX_ENTRIES) logged.shift();
                });
            } else if (data?.livebranch === 'view') {
                views.current[side].set(data.index, data.view);
                if (current().syncViews) show(other(side), data.index, data.view);
            } else if (data?.livebranch === 'follow') {
                able.current[side].add(data.index);
                const view = views.current[other(side)].get(data.index);
                if (view !== undefined && current().syncViews) show(side, data.index, view);
                setState({syncable: able.current.base.size > 0 && able.current.head.size > 0});
            }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, []);

    // A page that loads again starts from its own view, and says again what it can follow.
    const forget = (side: Side) => {
        views.current[side].clear();
        able.current[side].clear();
        setState({syncable: false});
    };
    useEffect(() => forget('head'), [session?.url, runs]);
    useEffect(() => forget('base'), [baseSession?.url, runs]);
    // Views that moved apart come together when syncing is turned on, to the view of the link's own side.
    useEffect(() => {
        if (!syncViews) return;
        const [from, to]: Side[] = views.current.head.size ? ['head', 'base'] : ['base', 'head'];
        for (const [index, view] of views.current[from]) show(to, index, view);
    }, [syncViews]);

    // The padding is inside, as padding of the side itself would count toward its width and move the previews off the bar.
    const waiting = (text: string) => (
        <div className="flex min-w-0 flex-1 items-center justify-center bg-background text-muted-foreground">
            <p className="p-4 whitespace-pre-wrap">{text}</p>
        </div>
    );
    if (!session) return <div className="flex h-full">{waiting(`${step || 'starting'}…`)}</div>;
    return (
        <div className="flex h-full flex-col">
            <PreviewBar />
            <div className="flex min-h-0 flex-1 gap-px bg-border">
                {comparing && (baseSession
                    ? <Frame session={baseSession} gh={baseSource(spec)} labelled frame={base} />
                    : waiting(baseError || `building ${spec.base}…`))}
                <Frame session={session} gh={spec.gh} labelled={comparing} frame={head} />
            </div>
        </div>
    );
}
