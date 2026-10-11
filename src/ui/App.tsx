import {Match, Switch, createEffect, onCleanup, onMount} from 'solid-js';
import {Landing} from './Landing.tsx';
import {Workbench} from './Workbench.tsx';
import {edit, getEngine, openFromLocation, shareLink, state} from './store.ts';

declare global {
    interface Window {
        /** For agents and tests that drive the page: the app's state and the project shell. */
        __repro: {
            state: typeof state;
            exec(command: string): Promise<{stdout: string; stderr: string; exitCode: number}>;
            edit(path: string, text: string): void;
            link(resultOnly?: boolean): Promise<string>;
        };
    }
}

export function App() {
    onMount(() => {
        window.__repro = {state, exec: command => getEngine().exec(command), edit, link: resultOnly => shareLink(resultOnly ?? false)};
        void openFromLocation();
        const reopen = () => void openFromLocation();
        window.addEventListener('hashchange', reopen);
        onCleanup(() => window.removeEventListener('hashchange', reopen));
    });
    createEffect(() => {
        document.documentElement.dataset.repro = state.phase;
    });

    return (
        <div class="h-dvh bg-white text-sm text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
            <Switch>
                <Match when={state.phase === 'landing'}><Landing /></Match>
                <Match when={state.phase !== 'landing'}><Workbench /></Match>
            </Switch>
        </div>
    );
}
