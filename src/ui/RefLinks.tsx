import {useEffect, useState, type ReactNode} from 'react';
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
 * not on GitHub. `name` shows the name, or the commit of a source that has none, in place of its
 * link.
 */
export function RefLinks(props: {gh: string | undefined; session: SessionInfo | undefined; fallback?: string; name?: (text: string) => ReactNode}) {
    const found = describeRef(props.gh, props.session);
    const sha = props.session?.commit;
    const unnamed = !found.name && found.repo && sha ? `${found.repo}@${sha}` : undefined;
    const [asked, setAsked] = useState<{about: string; branches: Branch[]}>();
    useEffect(() => {
        if (!unnamed) return;
        let live = true;
        void branchesAt(unnamed).then(branches => {
            if (live) setAsked({about: unnamed, branches});
        });
        return () => {
            live = false;
        };
    }, [unnamed]);
    // An answer about the commit before this one is not shown.
    const branches = unnamed && asked?.about === unnamed ? asked.branches : [];
    const branchName = (branch: Branch) => branch.repo === found.repo ? branch.name : `${branch.repo.split('/')[0]}:${branch.name}`;
    const link = 'hover:underline';
    if (!props.gh) return <span>{props.fallback}</span>;
    return (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
            {props.name
                ? props.name(found.name || found.commit)
                : found.name && <a className={link} href={found.nameUrl} target="_blank" rel="noreferrer" title="Open on GitHub">{found.name}</a>}
            {found.commit && (found.name || !props.name) && (
                <a className={`${link} text-muted-foreground`} href={found.commitUrl} target="_blank" rel="noreferrer" title="Open the commit on GitHub">{found.commit}</a>
            )}
            {branches.length > 0 && (
                <span title={`This commit is the head of ${branches.map(branchName).join(', ')}.`}>
                    (<a className={link} href={`https://github.com/${branches[0].repo}/tree/${branches[0].name}`} target="_blank" rel="noreferrer">{branchName(branches[0])}</a>
                    {branches.length > 1 ? ` +${branches.length - 1}` : ''})
                </span>
            )}
        </span>
    );
}
