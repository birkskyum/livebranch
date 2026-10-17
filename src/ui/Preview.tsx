import {useEffect, useRef, type RefObject} from 'react';
import {useShallow} from 'zustand/react/shallow';
import type {SessionInfo} from '../engine/protocol.ts';
import {baseSource} from '../engine/spec.ts';
import * as gesture from './gesture.ts';
import {PreviewBar} from './PreviewBar.tsx';
import {refLabel} from './RefLinks.tsx';
import {current, setState, useStore, type ConsoleEntry} from './store.ts';

const MAX_ENTRIES = 500;

const other = (side: gesture.Side): gesture.Side => side === 'base' ? 'head' : 'base';

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
    const {session, baseSession, baseError, spec, step} = useStore(useShallow(state => ({
        session: state.session,
        baseSession: state.base,
        baseError: state.baseError,
        spec: state.spec,
        step: state.step,
    })));
    const comparing = baseSource(spec) !== undefined;

    useEffect(() => {
        const frames = {base, head};
        gesture.attach(frames);
        const receive = (event: MessageEvent) => {
            const side: gesture.Side | undefined = event.source === base.current?.contentWindow ? 'base' : event.source === head.current?.contentWindow ? 'head' : undefined;
            const data = event.data;
            if (!side) return;
            if (data?.livebranch === 'console') {
                const entry: ConsoleEntry = {level: data.level, text: (data.args as string[]).join(' ')};
                setState(draft => {
                    const logged = side === 'base' ? draft.baseConsole : draft.console;
                    logged.push(entry);
                    if (logged.length > MAX_ENTRIES) logged.shift();
                });
            } else if (data?.livebranch === 'load') {
                gesture.pageLoaded(side);
            } else if (data?.livebranch === 'input') {
                gesture.input(side, data);
                // The other page gets the same input, and its own code handles it.
                if (current().mirror) frames[other(side)].current?.contentWindow?.postMessage(data, '*');
            }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, []);

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
