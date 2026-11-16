import {ExternalLink, Play} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {useShallow} from 'zustand/react/shallow';
import {Button} from '@/components/ui/button.tsx';
import {sourceName} from './embed-code.ts';
import {Tip} from './Tip.tsx';
import {isResultOnly, runOnClick, shareLink, useStore} from './store.ts';

/**
 * The link of the open project in the app itself, with the edits in it, for an embed to open in a
 * tab of its own. It shows the code and the panel, which an embed may not.
 */
export function useFullLink(): string {
    const state = useStore(useShallow(state => ({spec: state.spec, session: state.session, base: state.base, edits: state.edits, gesture: state.gesture, mirror: state.mirror})));
    const [link, setLink] = useState('');
    useEffect(() => {
        let live = true;
        void shareLink(false).then(found => { if (live) setLink(found); });
        return () => {
            live = false;
        };
    }, [state]);
    return link;
}

/** A link of the header that opens the project in a tab of its own, out of the page around the embed. */
export function OpenFull(props: {className?: string; children: ReactNode; label?: string}) {
    const link = useFullLink();
    return (
        <a className={props.className} href={link || undefined} target="_blank" rel="noreferrer" aria-label={props.label}>
            {props.children}
        </a>
    );
}

/** The header's button that opens an embed in the app. */
export function OpenButton() {
    return (
        <Tip text="Open in livebranch, with the code and the panel">
            <Button variant="ghost" size="sm" asChild>
                <OpenFull label="Open in livebranch"><ExternalLink />Open</OpenFull>
            </Button>
        </Tip>
    );
}

/**
 * What a link that waits for a click (`run=click`) shows until the click: what it runs and a
 * button. Nothing is fetched before, so a page with many embeds loads only the ones that run.
 */
export function RunOnClick() {
    const spec = useStore(state => state.spec);
    const resultOnly = isResultOnly();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="font-mono text-xs text-muted-foreground">{sourceName(spec)}</p>
            <Button size="lg" onClick={runOnClick}><Play />Run</Button>
            <p className="text-xs text-muted-foreground">
                Compiles {resultOnly ? 'and shows the page' : 'the code and shows the page'} in this browser, with{' '}
                <a className="underline" href="https://livebranch.dev/" target="_blank" rel="noreferrer">livebranch</a>
            </p>
        </div>
    );
}
