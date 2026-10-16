import {useEffect, useRef, type RefObject} from 'react';
import {useShallow} from 'zustand/react/shallow';
import type {SessionInfo} from '../engine/protocol.ts';
import {baseSource} from '../engine/spec.ts';
import {RefLinks, refLabel} from './RefLinks.tsx';
import {setState, useStore, type ConsoleEntry} from './store.ts';

const MAX_ENTRIES = 500;

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
            {props.labelled && (
                <span className="absolute top-2 left-2 rounded bg-neutral-900/80 px-2 py-0.5 font-mono text-xs text-white">
                    <RefLinks gh={props.gh} session={props.session} />
                </span>
            )}
        </div>
    );
}

/**
 * The built page in a frame, or two frames when the link compares two refs. The console of a page
 * arrives as messages from the script that the build put into it, and each frame has its own.
 */
export function Preview() {
    const head = useRef<HTMLIFrameElement>(null);
    const base = useRef<HTMLIFrameElement>(null);
    const {session, baseSession, baseError, spec, step} = useStore(useShallow(state => ({session: state.session, baseSession: state.base, baseError: state.baseError, spec: state.spec, step: state.step})));
    const comparing = baseSource(spec) !== undefined;

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            const fromBase = base.current !== null && event.source === base.current.contentWindow;
            if ((!fromBase && event.source !== head.current?.contentWindow) || event.data?.livebranch !== 'console') return;
            const entry: ConsoleEntry = {level: event.data.level, text: (event.data.args as string[]).join(' ')};
            setState(draft => {
                const logged = fromBase ? draft.baseConsole : draft.console;
                logged.push(entry);
                if (logged.length > MAX_ENTRIES) logged.shift();
            });
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, []);

    const waiting = (text: string) => <div className="flex min-w-0 flex-1 items-center justify-center p-4 whitespace-pre-wrap text-muted-foreground">{text}</div>;
    if (!session) return <div className="flex h-full">{waiting(`${step || 'starting'}…`)}</div>;
    return (
        <div className="flex h-full gap-px bg-border">
            {comparing && (baseSession
                ? <Frame session={baseSession} gh={baseSource(spec)} labelled frame={base} />
                : waiting(baseError || `building ${spec.base}…`))}
            <Frame session={session} gh={spec.gh} labelled={comparing} frame={head} />
        </div>
    );
}
