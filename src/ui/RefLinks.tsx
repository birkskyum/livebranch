import {Show, createResource} from 'solid-js';
import type {SessionInfo} from '../engine/protocol.ts';
import {branchesAt, type Branch} from './store.ts';

interface Ref {
    /** The repository as `owner/name`. */
    repo: string | undefined;
    /** The branch or tag, or `#123` for a pull request. Empty when the source names a commit. */
    name: string;
    nameUrl: string | undefined;
    commit: string;
    commitUrl: string | undefined;
}

/** A short name for a source and for its commit, with their pages on GitHub. */
export function describeRef(gh: string | undefined, session: SessionInfo | undefined): Ref {
    const match = /^([^@:]+)(?:@([^:]+))?/.exec(gh ?? '');
    const repo = match?.[1];
    const page = `https://github.com/${repo}`;
    const ref = match?.[2] ?? '';
    const pull = /^pull\/(\d+)/.exec(ref);
    const sha = session?.commit;
    const commit = sha?.slice(0, 7) ?? '';
    if (pull) return {repo, name: `#${pull[1]}`, nameUrl: `${page}/pull/${pull[1]}`, commit, commitUrl: sha && `${page}/pull/${pull[1]}/commits/${sha}`};
    const commitUrl = repo && sha ? `${page}/commit/${sha}` : undefined;
    if (!ref || /^[0-9a-f]{7,40}$/.test(ref)) return {repo, name: '', nameUrl: undefined, commit, commitUrl};
    return {repo, name: ref, nameUrl: `${page}/tree/${ref}`, commit, commitUrl};
}

export function refLabel(gh: string | undefined, session: SessionInfo | undefined): string {
    const {name, commit} = describeRef(gh, session);
    return [name, commit].filter(Boolean).join(' ');
}

/**
 * The name of a ref and its commit, as links to GitHub. A source that names only a commit gets the
 * branch that the commit is the head of, in parentheses. A branch of the repository that a fork
 * was made from reads as GitHub writes it, `owner:branch`. `fallback` shows for a source that is
 * not on GitHub.
 */
export function RefLinks(props: {gh: string | undefined; session: SessionInfo | undefined; fallback?: string}) {
    const found = () => describeRef(props.gh, props.session);
    const unnamed = () => {
        const {name, repo} = found();
        const sha = props.session?.commit;
        return !name && repo && sha ? `${repo}@${sha}` : undefined;
    };
    const [asked] = createResource(unnamed, branchesAt);
    // An answer about the commit before this one is not shown.
    const branches = () => unnamed() && !asked.loading ? asked() ?? [] : [];
    const branchName = (branch: Branch) => branch.repo === found().repo ? branch.name : `${branch.repo.split('/')[0]}:${branch.name}`;
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
                <Show when={branches().length}>
                    <span title={`This commit is the head of ${branches().map(branchName).join(', ')}.`}>
                        (<a class={link} href={`https://github.com/${branches()[0].repo}/tree/${branches()[0].name}`} target="_blank" rel="noreferrer">{branchName(branches()[0])}</a>
                        {branches().length > 1 ? ` +${branches().length - 1}` : ''})
                    </span>
                </Show>
            </span>
        </Show>
    );
}
