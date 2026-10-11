import {Show} from 'solid-js';
import type {SessionInfo} from '../engine/protocol.ts';

interface Ref {
    /** The branch or tag, or `#123` for a pull request. Empty when the source names a commit. */
    name: string;
    nameUrl: string | undefined;
    commit: string;
    commitUrl: string | undefined;
}

/** A short name for a source and for its commit, with their pages on GitHub. */
export function describeRef(gh: string | undefined, session: SessionInfo | undefined): Ref {
    const match = /^([^@:]+)(?:@([^:]+))?/.exec(gh ?? '');
    const repo = match ? `https://github.com/${match[1]}` : undefined;
    const ref = match?.[2] ?? '';
    const pull = /^pull\/(\d+)/.exec(ref);
    const sha = session?.commit;
    const commit = sha?.slice(0, 7) ?? '';
    if (pull) return {name: `#${pull[1]}`, nameUrl: `${repo}/pull/${pull[1]}`, commit, commitUrl: sha && `${repo}/pull/${pull[1]}/commits/${sha}`};
    const commitUrl = repo && sha ? `${repo}/commit/${sha}` : undefined;
    if (!ref || /^[0-9a-f]{7,40}$/.test(ref)) return {name: '', nameUrl: undefined, commit, commitUrl};
    return {name: ref, nameUrl: `${repo}/tree/${ref}`, commit, commitUrl};
}

export function refLabel(gh: string | undefined, session: SessionInfo | undefined): string {
    const {name, commit} = describeRef(gh, session);
    return [name, commit].filter(Boolean).join(' ');
}

/** The name of a ref and its commit, as links to GitHub. `fallback` shows for a source that is not on GitHub. */
export function RefLinks(props: {gh: string | undefined; session: SessionInfo | undefined; fallback?: string}) {
    const found = () => describeRef(props.gh, props.session);
    const link = 'hover:underline';
    return (
        <Show when={props.gh} fallback={<span>{props.fallback}</span>}>
            <span class="flex items-center gap-1.5 whitespace-nowrap">
                <Show when={found().name}>
                    <a class={link} href={found().nameUrl} target="_blank" rel="noreferrer" title="Open on GitHub">{found().name}</a>
                </Show>
                <Show when={found().commit}>
                    <a class={link} href={found().commitUrl} target="_blank" rel="noreferrer" title="Open the commit on GitHub">{found().commit}</a>
                </Show>
            </span>
        </Show>
    );
}
