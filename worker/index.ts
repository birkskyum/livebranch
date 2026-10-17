// The app as a Worker: the static build from dist, and the engine behind an HTTP API, for agents
// and scripts that have no browser. It is the same compile and type check as in the tab. It runs
// on Cloudflare, and on workerd or celld for self-hosting.
import tscModule from '@tsrs/wasm/tsrs.wasm';
import {checkProject} from '../src/engine/check.ts';
import {openProject, type Env as EngineEnv} from '../src/engine/project.ts';
import {branchesAt, defaultBranch, listTree, resolveRef} from '../src/engine/sources/git.ts';
import {resolveSource, type GitReader} from '../src/engine/sources/github.ts';
import {baseSource, decodeSpec, encodeSpec, isEmptySpec, isPullRequest, normalizeGithubSource, parseGithubRef, type LinkSpec} from '../src/engine/spec.ts';
import {TooLargeError} from '../src/engine/tsc.ts';
import {getPicture, PictureError, putPicture, type Bucket} from './pictures.ts';

interface Env {
    ASSETS: {fetch(request: Request): Promise<Response>};
    /** Counts requests to the API per address. */
    API_LIMIT?: {limit(options: {key: string}): Promise<{success: boolean}>};
    /** The same for the GitHub reader, which a page asks several times and which is cheap. */
    GITHUB_LIMIT?: {limit(options: {key: string}): Promise<{success: boolean}>};
    /** Optional secret. Without it, a caller sends a GitHub token of their own to read from GitHub. */
    GITHUB_TOKEN?: string;
    /** The pictures of pull requests that workflows post (worker/pictures.ts). */
    PICTURES?: Bucket;
    /** The accounts whose repositories may store pictures, separated by commas, or `*`. */
    PICTURE_OWNERS?: string;
}

const MAX_BODY_BYTES = 1_000_000;
/**
 * The most source that a check compiles here, in characters. A Worker has 128 MB. tsrs ran out of
 * it on 2.1 MB of the Angular compiler and 2.2 MB of three.js, and parts of them with 1.7 MB and
 * 2.0 MB went through. A program that runs out of memory below this is too large as well.
 */
const SOURCE_BUDGET = 1_800_000;
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
 * Reads a ref, a commit's file list, the default branch or the branches at a commit from GitHub's
 * git endpoint, for browsers, which may not ask it themselves. The answers are kept at the edge: a
 * commit's files for good, a ref and the branches at a commit for half a minute, the default
 * branch for five minutes.
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
        } else if (url.pathname === '/api/github/branches') {
            const commit = url.searchParams.get('commit') ?? '';
            if (!/^[0-9a-f]{40}$/.test(commit)) throw new ApiError(400, 'Name a commit by its full hash.');
            response = json({branches: await branchesAt((asked, init) => fetch(asked, init), owner, repo, commit)}, 200, {'cache-control': 'public, max-age=30'});
        } else if (url.pathname === '/api/github/default-branch') {
            response = json({branch: await defaultBranch((asked, init) => fetch(asked, init), owner, repo) ?? null}, 200, {'cache-control': 'public, max-age=300'});
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
        'PUT /api/pictures/<owner>/<repo>/<run>/<base|head>.png': 'Stores a picture of a pull request for a GitHub Actions run, with its OIDC token as the bearer. GET serves it.',
    },
};

/** Serves the pictures of pull requests, and stores the ones that a workflow run took. */
async function pictures(request: Request, env: Env, url: URL): Promise<Response> {
    if (!env.PICTURES) return json({error: 'This site keeps no pictures.'}, 404);
    if (request.method === 'GET' || request.method === 'HEAD') return getPicture(url.pathname, env.PICTURES);
    if (request.method !== 'PUT') return json({error: 'Use GET or PUT.'}, 405);
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (env.API_LIMIT && !(await env.API_LIMIT.limit({key: address})).success) return json({error: 'Too many requests. Try again in a minute.'}, 429);
    try {
        const owners = (env.PICTURE_OWNERS ?? '').split(',').map(owner => owner.trim().toLowerCase()).filter(Boolean);
        return json({url: `${url.origin}/api/pictures/${await putPicture(request, env.PICTURES, owners)}`}, 201);
    } catch (error) {
        return json({error: error instanceof Error ? error.message : String(error)}, error instanceof PictureError ? error.status : 500);
    }
}

async function api(request: Request, env: Env, url: URL, context: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    if (url.pathname.startsWith('/api/pictures/')) return pictures(request, env, url);
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
 * The source that a GitHub address in the path names. People get there by putting this site's
 * address in front of a GitHub URL, or by swapping `github.com` for it:
 * `/github.com/owner/repo/pull/1`, `/https://github.com/owner/repo/tree/branch` and
 * `/owner/repo/pull/1` all work.
 */
export function sourceForPath(pathname: string): {gh: string; entry?: string} | undefined {
    let path: string;
    try {
        path = decodeURIComponent(pathname.slice(1));
    } catch {
        return undefined;
    }
    path = path.replace(/^https?:\/+/, '').replace(/^(?:www\.)?github\.com\//, '');
    const match = /^([A-Za-z0-9-]+)\/[\w.-]+(?:\/|$)/.exec(path);
    if (!match || OWN_PATHS.test(match[1])) return undefined;
    return normalizeGithubSource(`https://github.com/${path}`);
}

/** The default branch of a source's repository, or undefined when GitHub does not tell. */
async function defaultBranchOf(gh: string, url: URL, context: ExecutionContext): Promise<string | undefined> {
    try {
        const {owner, repo} = parseGithubRef(gh);
        const asked = new URL(`/api/github/default-branch?repo=${owner}/${repo}`, url);
        const response = await github(new Request(asked), asked, context);
        return (await response.json() as {branch: string | null}).branch ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Sends the browser on to the link of a pasted address. The page does it, because a server never
 * sees the fragment of an address, and its own redirect would drop it. The parameters of that
 * fragment win over the ones that the path gives, as later ones do in a link, so that
 * `/owner/repo/pull/1#base=v1.0.0&mirror=1` keeps both.
 */
function sendOn(origin: string, fragment: string): Response {
    const script = `const params = new URLSearchParams(${JSON.stringify(fragment)});
for (const [key, value] of new URLSearchParams(location.hash.slice(1))) if (value) params.set(key, value);
location.replace('/#' + params.toString().replaceAll('%2F', '/').replaceAll('%40', '@').replaceAll('%3A', ':'));`;
    const target = `${origin}/#${fragment}`.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const html = `<!doctype html>\n<meta charset="utf-8">\n<title>livebranch</title>\n<script>${script.replaceAll('<', '\\u003c')}</script>\n<noscript><a href="${target}">Open the link</a></noscript>\n`;
    return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
}

export default {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(request, env, url, context);
        const source = request.method === 'GET' ? sourceForPath(url.pathname) : undefined;
        if (!source) return env.ASSETS.fetch(request);
        // A pull request opens next to the branch that most of them go into, which shows what it changes.
        const base = isPullRequest(source.gh) ? await defaultBranchOf(source.gh, url, context) : undefined;
        return sendOn(url.origin, await encodeSpec({...source, base}));
    },
};
