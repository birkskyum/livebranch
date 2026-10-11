import {Show, onCleanup, onMount} from 'solid-js';
import {produce} from 'solid-js/store';
import {setState, state, type ConsoleEntry} from './store.ts';

const MAX_ENTRIES = 500;

/** The built page in a frame. Its console arrives as messages from the script that the build put into the page. */
export function Preview() {
    let frame: HTMLIFrameElement | undefined;

    onMount(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== frame?.contentWindow || event.data?.repro !== 'console') return;
            const entry: ConsoleEntry = {level: event.data.level, text: (event.data.args as string[]).join(' ')};
            setState(produce(draft => {
                draft.console.push(entry);
                if (draft.console.length > MAX_ENTRIES) draft.console.shift();
            }));
        };
        window.addEventListener('message', receive);
        onCleanup(() => window.removeEventListener('message', receive));
    });

    // A new run gets a new frame, so that no state of the old page survives.
    const key = () => `${state.session?.url}#${state.runs}`;
    return (
        <Show when={state.session} fallback={<div class="flex h-full items-center justify-center text-neutral-500">{state.step || 'starting'}…</div>}>
            <Show when={key()} keyed>
                <iframe
                    ref={frame}
                    class="h-full w-full border-0 bg-white"
                    title="Preview"
                    src={state.session!.url}
                    allow="geolocation; fullscreen; clipboard-write; xr-spatial-tracking"
                />
            </Show>
        </Show>
    );
}
