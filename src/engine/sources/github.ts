import {isBinaryPath, type FileData, type RemoteSource} from '../vfs.ts';
import type {GithubRef} from '../spec.ts';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';

async function ok(response: Response, what: string): Promise<Response> {
    if (response.ok) return response;
    const limited = response.status === 403 || response.status === 429;
    const hint = limited && response.headers.get('x-ratelimit-remaining') === '0'
        ? ' GitHub allows 60 anonymous API requests per hour from one address. Try again later.'
        : '';
    throw Object.assign(new Error(`${what} failed with ${response.status}.${hint}`), {status: response.status});
}

/**
 * Answers from GitHub's git endpoint instead of its API (./git.ts), directly or through this site's
 * server. The API allows an anonymous address 60 requests an hour, and this has no such allowance.
 */
export interface GitReader {
    /** The commit of a branch, a tag, `HEAD` or `pull/123/head`. Undefined when there is no such ref. */
    resolve(owner: string, repo: string, ref: string): Promise<string | undefined>;
    /** Every file path of a commit. */
    tree(owner: string, repo: string, commit: string): Promise<string[]>;
}

/** The commit that a branch, tag or abbreviated hash names. */
export async function resolveCommit(fetch: Fetch, source: GithubRef, git?: GitReader): Promise<string> {
    if (/^[0-9a-f]{40}$/.test(source.ref)) return source.ref;
    if (git) {
        let commit: string | undefined;
        let answered = true;
        try {
            commit = await git.resolve(source.owner, source.repo, source.ref);
        } catch {
            answered = false;
        }
        if (commit) return commit;
        // Only the API knows an abbreviated hash. Anything else that git does not know is not there.
        if (answered && !/^[0-9a-f]{7,39}$/.test(source.ref)) {
            throw Object.assign(new Error(`${source.owner}/${source.repo} has no branch, tag or pull request named ${source.ref}.`), {status: 404});
        }
    }
    const url = `${API}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
    const response = await ok(await fetch(url, {headers: {accept: 'application/vnd.github.sha'}}), `Resolving ${source.ref}`);
    return (await response.text()).trim();
}

/**
 * The commit of a source, and where its ref ends. A pasted file URL does not say where the branch
 * name ends and the path of the page begins. When the ref is unknown, the leading segments of the
 * page's path are tried as part of it.
 */
export async function resolveSource(fetch: Fetch, source: GithubRef, entry: string | undefined, git?: GitReader): Promise<{source: GithubRef; commit: string; entry: string | undefined}> {
    let first: unknown;
    for (let moved = 0; ; moved++) {
        try {
            return {source, commit: await resolveCommit(fetch, source, git), entry};
        } catch (error) {
            first ??= error;
            const status = (error as {status?: number}).status;
            const [head, ...rest] = (entry ?? '').split('/');
            if ((status !== 404 && status !== 422) || !rest.length || moved === 4) throw first;
            source = {...source, ref: `${source.ref}/${head}`};
            entry = rest.join('/');
        }
    }
}

/**
 * A repository at one commit. The file list is one API request. File contents come from the raw
 * host, and from jsDelivr when that fails.
 */
export function githubSource(fetch: Fetch, source: GithubRef, commit: string, git?: GitReader): RemoteSource {
    const {owner, repo, subdir} = source;
    const prefix = subdir ? `${subdir}/` : '';
    const raw = (path: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${prefix}${path}`;
    const mirror = (path: string) => `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commit}/${prefix}${path}`;

    async function read(url: string, binary: boolean): Promise<FileData | undefined> {
        try {
            const response = await fetch(url);
            if (!response.ok) return undefined;
            return binary ? new Uint8Array(await response.arrayBuffer()) : await response.text();
        } catch {
            return undefined;
        }
    }

    return {
        async list() {
            const inProject = (all: string[]) => all.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
            if (git) {
                try {
                    return inProject(await git.tree(owner, repo, commit));
                } catch {
                    // The API is asked instead.
                }
            }
            const url = `${API}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
            const response = await ok(await fetch(url), `Listing ${owner}/${repo}`);
            const body = await response.json() as {tree: {path: string; type: string}[]; truncated: boolean};
            if (body.truncated) console.warn(`The file list of ${owner}/${repo} is truncated by GitHub.`);
            return inProject(body.tree.filter(entry => entry.type === 'blob').map(entry => entry.path));
        },
        async fetch(path) {
            const binary = isBinaryPath(path);
            const data = await read(raw(path), binary) ?? await read(mirror(path), binary);
            if (data === undefined) throw new Error(`Cannot fetch ${path} from ${owner}/${repo}@${commit.slice(0, 7)}.`);
            return data;
        },
        probe: path => read(raw(path), isBinaryPath(path)),
        url: raw,
    };
}

/** The files of a gist, optionally at one revision. */
export async function fetchGist(fetch: Fetch, gist: string): Promise<Record<string, string>> {
    const [id, revision] = gist.split('@');
    const url = `${API}/gists/${id}${revision ? `/${revision}` : ''}`;
    const response = await ok(await fetch(url), `Loading gist ${id}`);
    const body = await response.json() as {files: Record<string, {content: string; truncated: boolean; raw_url: string}>};
    const files: Record<string, string> = {};
    await Promise.all(Object.entries(body.files).map(async ([name, file]) => {
        files[name] = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    }));
    return files;
}
