// The app as a Worker: the static build from dist, and the engine behind an HTTP API, for agents
// and scripts that have no browser. It is the same compile and type check as in the tab. It runs
// on Cloudflare, and on workerd or celld for self-hosting.
import tscModule from '../public/tsc/ts_rust.wasm';
import {checkProject} from '../src/engine/check.ts';
import {openProject, type Env as EngineEnv} from '../src/engine/project.ts';
import {listTree, resolveRef} from '../src/engine/sources/git.ts';
import {resolveSource, type GitReader} from '../src/engine/sources/github.ts';
import {baseSource, decodeSpec, encodeSpec, isEmptySpec, normalizeGithubSource, parseGithubRef, type LinkSpec} from '../src/engine/spec.ts';
import {TooLargeError} from '../src/engine/tsc.ts';

interface Env {
    ASSETS: {fetch(request: Request): Promise<Response>};
    /** Counts requests to the API per address. */
    API_LIMIT?: {limit(options: {key: string}): Promise<{success: boolean}>};
    /** The same for the GitHub reader, which a page asks several times and which is cheap. */
    GITHUB_LIMIT?: {limit(options: {key: string}): Promise<{success: boolean}>};
    /** Optional secret. Without it, a caller sends a GitHub token of their own to read from GitHub. */
    GITHUB_TOKEN?: string;
}

const MAX_BODY_BYTES = 1_000_000;
/**
 * The most source that a check compiles here, in characters. A Worker has little memory. Checks
 * for which the compiler took 120 to 135 MB went through: maplibre-style-spec with the types of
 * its dependencies, and 0.9 MB of dense code, which is about what a request body can hold.
 * maplibre-gl-js, with 2.8 MB of source and 200 MB, ran for 30 seconds and then failed.
 */
const SOURCE_BUDGET = 1_400_000;
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(`${JSON.stringify(body, null, 2)}\n`, {status, headers: {'content-type': 'application/json; charset=utf-8', ...CORS, ...headers}});
}

const git: GitReader = {
    resolve: (owner, repo, ref) => resolveRef((url, init) => fetch(url, init), owner, repo, ref),
    tree: (owner, repo, commit) => listTree((url, init) => fetch(url, init), owner, repo, commit),
};

/**
 * Reads a ref or a commit's file list from GitHub's git endpoint, for browsers, which may not ask
 * it themselves. The answers are kept at the edge: a commit's files for good, a ref for half a minute.
 */
async function github(request: Request, url: URL, context: ExecutionContext): Promise<Response> {
    const hit = await caches.default.match(request);
    if (hit) return hit;
    const [owner, repo, more] = (url.searchParams.get('repo') ?? '').split('/');
    if (!owner || !repo || more !== undefined || !/^[\w.-]+$/.test(owner + repo)) throw new ApiError(400, 'Name the repository as repo=owner/name.');
    let response: Response;
    try {
        if (url.pathname === '/api/github/resolve') {
            const ref = url.searchParams.get('ref') ?? '';
            if (!ref) throw new ApiError(400, 'Name a ref.');
            response = json({commit: await git.resolve(owner, repo, ref) ?? null}, 200, {'cache-control': 'public, max-age=30'});
        } else if (url.pathname === '/api/github/tree') {
            const commit = url.searchParams.get('commit') ?? '';
            if (!/^[0-9a-f]{40}$/.test(commit)) throw new ApiError(400, 'Name a commit by its full hash.');
            const body = JSON.stringify({paths: await git.tree(owner, repo, commit)});
            response = new Response(body, {headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', ...CORS}});
        } else {
            throw new ApiError(404, `There is no ${url.pathname}.`);
        }
    } catch (error) {
        const status = (error as {status?: number}).status;
        if (error instanceof ApiError || status === undefined) throw error;
        throw new ApiError(status === 404 || status === 401 ? 404 : 502, status === 404 || status === 401 ? `There is no public repository ${owner}/${repo}.` : `GitHub answered ${status}.`);
    }
    context.waitUntil(caches.default.put(request, response.clone()));
    return response;
}

/** A failure that the caller can do something about, with the status to answer with. */
class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/**
 * The engine's environment in a Worker. Requests to GitHub's API carry the caller's token, or the
 * Worker's own if it has one. A token is only passed on to api.github.com and is not kept.
 */
function engineEnv(env: Env, origin: string, token: string | undefined): EngineEnv {
    return {
        git,
        async fetch(url, init) {
            // GitHub answers only requests that name a user agent, which a Worker does not do by itself.
            const headers = new Headers(init?.headers);
            headers.set('user-agent', 'livebranch');
            const api = url.startsWith('https://api.github.com/');
            if (api && token) headers.set('authorization', `Bearer ${token}`);
            const response = await fetch(url, {...init, headers});
            if (api && !token && (response.status === 403 || response.status === 429)) {
                throw new ApiError(401, 'Reading from GitHub needs a token here, because this server shares GitHub\'s anonymous limit with many others. Send one of your own in an Authorization header (Bearer). A token without any permission is enough for public repositories. Or open the link in a browser, which needs none.');
            }
            return response;
        },
        runtimeBase: `${origin}/`,
        wasm: async () => tscModule,
        sourceBudget: SOURCE_BUDGET,
    };
}

function tokenOf(request: Request, env: Env): string | undefined {
    const header = request.headers.get('authorization');
    return header?.replace(/^(?:bearer|token)\s+/i, '').trim() || env.GITHUB_TOKEN;
}

/** The spec of a request: the link parameters in the query string, or a JSON body. */
async function specOf(request: Request, url: URL): Promise<LinkSpec & {result?: boolean; pin?: boolean}> {
    if (request.method === 'GET') {
        const spec: LinkSpec & {result?: boolean; pin?: boolean} = await decodeSpec(url.search, '');
        spec.result = url.searchParams.get('view') === 'result';
        spec.pin = url.searchParams.has('pin');
        return spec;
    }
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) throw new ApiError(413, 'The request is too large.');
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new ApiError(400, 'The body is not JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null) throw new ApiError(400, 'The body has to be a JSON object.');
    const spec = parsed as LinkSpec & {result?: boolean; pin?: boolean};
    if (spec.files && Object.values(spec.files).some(text => typeof text !== 'string')) throw new ApiError(400, 'Each file has to be a string.');
    if (spec.gh) {
        const source = normalizeGithubSource(spec.gh);
        spec.gh = source.gh;
        spec.entry ??= source.entry;
    }
    return spec;
}

/** Compiles and type checks a project and reports its problems. */
async function check(spec: LinkSpec, engine: EngineEnv): Promise<Response> {
    if (isEmptySpec(spec)) throw new ApiError(400, 'Name a source: gh, gist or files.');
    try {
        return json(await checkProject(await openProject(spec, engine), engine));
    } catch (error) {
        if (!(error instanceof TooLargeError)) throw error;
        throw new ApiError(422, `This is too large to check on the server, which compiles up to ${SOURCE_BUDGET / 1e6} MB of source. Open the link in a browser instead. It runs the same check without that limit, and /llms.txt says how to read the result.`);
    }
}

/** Makes the link for a spec. With `pin`, a branch or pull request becomes its commit. */
async function link(spec: LinkSpec & {result?: boolean; pin?: boolean}, engine: EngineEnv, origin: string): Promise<Response> {
    if (isEmptySpec(spec)) throw new ApiError(400, 'Name a source: gh, gist or files.');
    const {result, pin, ...wanted} = spec;
    if (pin && wanted.gh) {
        const pinned = await resolveSource(engine.fetch, parseGithubRef(wanted.gh), wanted.entry, git);
        wanted.gh = `${pinned.source.owner}/${pinned.source.repo}@${pinned.commit}${pinned.source.subdir ? `:${pinned.source.subdir}` : ''}`;
        wanted.entry = pinned.entry;
        const against = baseSource(spec);
        if (against) {
            const base = await resolveSource(engine.fetch, parseGithubRef(against), undefined, git);
            wanted.base = `${base.source.owner}/${base.source.repo}@${base.commit}`;
        }
    }
    return json({url: `${origin}/#${result ? 'view=result&' : ''}${await encodeSpec(wanted)}`});
}

const ENDPOINTS = {
    docs: '/llms.txt',
    endpoints: {
        'POST /api/link': 'Makes a link. Body: {gh?, base?, entry?, gist?, adapter?, files?, result?, pin?}. Answers {url}.',
        'POST /api/check': `Compiles and type checks without a browser, up to ${SOURCE_BUDGET / 1e6} MB of source. Body: {gh?, entry?, gist?, adapter?, files?}. Answers {problems, ...}.`,
    },
};

async function api(request: Request, env: Env, url: URL, context: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    if (request.method !== 'GET' && request.method !== 'POST') return json({error: 'Use GET or POST.'}, 405);
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const reader = url.pathname.startsWith('/api/github/');
    const limit = reader ? env.GITHUB_LIMIT : env.API_LIMIT;
    if (limit && !(await limit.limit({key: address})).success) {
        return json({error: 'Too many requests. Try again in a minute.'}, 429);
    }
    try {
        if (reader) {
            if (request.method !== 'GET') throw new ApiError(405, 'Use GET.');
            return await github(request, url, context);
        }
        const path = url.pathname.replace(/\/$/, '');
        if (path === '/api') return json(ENDPOINTS);
        const engine = engineEnv(env, url.origin, tokenOf(request, env));
        if (path === '/api/check') return await check(await specOf(request, url), engine);
        if (path === '/api/link') return await link(await specOf(request, url), engine, url.origin);
        return json({error: `There is no ${url.pathname}.`, ...ENDPOINTS}, 404);
    } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        return json({error: error instanceof Error ? error.message : String(error)}, status);
    }
}

const OWN_PATHS = /^(?:assets|tsc|rt|api|cdn-cgi)$/;

/**
 * The app link for a GitHub address in the path. People get there by putting this site's address
 * in front of a GitHub URL, or by swapping `github.com` for it: `/github.com/owner/repo/pull/1`,
 * `/https://github.com/owner/repo/tree/branch` and `/owner/repo/pull/1` all work.
 */
export function linkForPath(pathname: string): string | undefined {
    let path: string;
    try {
        path = decodeURIComponent(pathname.slice(1));
    } catch {
        return undefined;
    }
    path = path.replace(/^https?:\/+/, '').replace(/^(?:www\.)?github\.com\//, '');
    const match = /^([A-Za-z0-9-]+)\/[\w.-]+(?:\/|$)/.exec(path);
    if (!match || OWN_PATHS.test(match[1])) return undefined;
    const {gh, entry} = normalizeGithubSource(`https://github.com/${path}`);
    return `/#gh=${gh}${entry ? `&entry=${entry}` : ''}`;
}

export default {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(request, env, url, context);
        const target = request.method === 'GET' ? linkForPath(url.pathname) : undefined;
        return target ? Response.redirect(url.origin + target, 302) : env.ASSETS.fetch(request);
    },
};
