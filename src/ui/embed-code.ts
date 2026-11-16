import {parseGithubRef, type LinkSpec} from '../engine/spec.ts';

/** What a link runs, as a reader of the page around an embed knows it: the repository and its folder. */
export function sourceName(spec: LinkSpec): string {
    if (!spec.gh) return spec.gist ? `gist ${spec.gist.slice(0, 8)}` : 'a demo';
    try {
        const {owner, repo, subdir} = parseGithubRef(spec.gh);
        return `${owner}/${repo}${subdir ? `/${subdir}` : ''}`;
    } catch {
        return spec.gh;
    }
}

const attribute = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/**
 * An iframe that runs a link on another page, as a compact embed. It loads once it nears the
 * view, and with `click` only on the reader's click.
 */
export function embedCode(link: string, title: string, click: boolean): string {
    const src = link.replace('#', `#embed=1&${click ? 'run=click&' : ''}`);
    return `<iframe src="${attribute(src)}" title="${attribute(title)}" loading="lazy" allow="clipboard-write; fullscreen" style="width: 100%; height: 540px; border: 1px solid #ddd; border-radius: 8px;"></iframe>`;
}
