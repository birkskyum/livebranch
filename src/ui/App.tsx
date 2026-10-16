import {useEffect} from 'react';
import {TooltipProvider} from '@/components/ui/tooltip.tsx';
import {Landing} from './Landing.tsx';
import {Workbench} from './Workbench.tsx';
import {current, demoBlock, edit, getEngine, openFromLocation, shareLink, useStore, type State} from './store.ts';

declare global {
    interface Window {
        /** For agents and tests that drive the page: the app's state and the project shell. */
        __livebranch: {
            /** The state at the moment it is read. */
            readonly state: State;
            exec(command: string): Promise<{stdout: string; stderr: string; exitCode: number}>;
            edit(path: string, text: string): void;
            /** The link with the edits in it, of the previews alone, or at the commits that run. */
            link(resultOnly?: boolean, pin?: boolean): Promise<string>;
            /** The demo as code blocks for a pull request's description. */
            block(): Promise<string>;
        };
    }
}

export function App() {
    const phase = useStore(state => state.phase);
    useEffect(() => {
        window.__livebranch = {
            get state() {
                return current();
            },
            exec: command => getEngine().exec(command),
            edit,
            link: (resultOnly, pin) => shareLink(resultOnly, {}, pin),
            block: demoBlock,
        };
        void openFromLocation();
        const reopen = () => void openFromLocation();
        window.addEventListener('hashchange', reopen);
        return () => window.removeEventListener('hashchange', reopen);
    }, []);
    useEffect(() => {
        document.documentElement.dataset.livebranch = phase;
    }, [phase]);

    return (
        <TooltipProvider delayDuration={400}>
            <div className="h-dvh bg-background text-sm text-foreground">
                {phase === 'landing' ? <Landing /> : <Workbench />}
            </div>
        </TooltipProvider>
    );
}
