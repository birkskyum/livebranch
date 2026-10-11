import {Show, onCleanup, onMount} from 'solid-js';
import {produce} from 'solid-js/store';
import type {SessionInfo} from '../engine/protocol.ts';
import {baseSource} from '../engine/spec.ts';
import {RefLinks, refLabel} from './RefLinks.tsx';
import {setState, state, type ConsoleEntry} from './store.ts';

const MAX_ENTRIES = 500;

function Frame(props: {session: SessionInfo; gh: string | undefined; labelled: boolean; ref: (frame: HTMLIFrameElement) => void}) {
    // A new run gets a new frame, so that no state of the old page survives.
    const key = () => `${props.session.url}#${state.runs}`;
    return (
        <div class="relative min-w-0 flex-1">
            <Show when={key()} keyed>
                <iframe
                    ref={props.ref}
                    class="h-full w-full border-0 bg-white"
                    title={props.labelled ? `Preview of ${refLabel(props.gh, props.session)}` : 'Preview'}
                    src={props.session.url}
                    allow="geolocation; fullscreen; clipboard-write; xr-spatial-tracking"
                />
            </Show>
            <Show when={props.labelled}>
                <span class="absolute left-2 top-2 rounded bg-neutral-900/80 px-2 py-0.5 font-mono text-xs text-white">
                    <RefLinks gh={props.gh} session={props.session} />
                </span>
            </Show>
        </div>
    );
}

/**
 * The built page in a frame, or two frames when the link compares two refs. The console of a page
 * arrives as messages from the script that the build put into it.
 */
export function Preview() {
    let head: HTMLIFrameElement | undefined;
    let base: HTMLIFrameElement | undefined;
    const comparing = () => baseSource(state.spec) !== undefined;

    onMount(() => {
        const receive = (event: MessageEvent) => {
            const fromBase = base !== undefined && event.source === base.contentWindow;
            if ((!fromBase && event.source !== head?.contentWindow) || event.data?.livebranch !== 'console') return;
            const text = (event.data.args as string[]).join(' ');
            const entry: ConsoleEntry = {level: event.data.level, text: fromBase ? `[${refLabel(baseSource(state.spec), state.base)}] ${text}` : text};
            setState(produce(draft => {
                draft.console.push(entry);
                if (draft.console.length > MAX_ENTRIES) draft.console.shift();
            }));
        };
        window.addEventListener('message', receive);
        onCleanup(() => window.removeEventListener('message', receive));
    });

    const waiting = (text: string) => <div class="flex min-w-0 flex-1 items-center justify-center whitespace-pre-wrap p-4 text-neutral-500">{text}</div>;
    return (
        <Show when={state.session} fallback={<div class="flex h-full">{waiting(`${state.step || 'starting'}…`)}</div>}>
            <div class="flex h-full gap-px bg-neutral-300 dark:bg-neutral-700">
                <Show when={comparing()}>
                    <Show when={state.base} fallback={waiting(state.baseError || `building ${state.spec.base}…`)}>
                        <Frame session={state.base!} gh={baseSource(state.spec)} labelled ref={frame => { base = frame; }} />
                    </Show>
                </Show>
                <Frame session={state.session!} gh={state.spec.gh} labelled={comparing()} ref={frame => { head = frame; }} />
            </div>
        </Show>
    );
}
