// The app as a Worker: the static build from dist, and the engine behind an HTTP API, for agents
// and scripts that have no browser. It is the same compile and type check as in the tab. It runs
// on Cloudflare, and on workerd or celld for self-hosting.
import tscModule from '../public/tsc/ts_rust.wasm';
import {checkProject} from '../src/engine/check.ts';
import {openProject, type Env as EngineEnv} from '../src/engine/project.ts';
import {decodeSpec, isEmptySpec, normalizeGithubSource, type LinkSpec} from '../src/engine/spec.ts';

interface Env {
    ASSETS: {fetch(request: Request): Promise<Response>};
    /** Optional secret. With it GitHub allows 5000 API requests an hour instead of 60. */
    GITHUB_TOKEN?: string;
}

const MAX_BODY_BYTES = 1_000_000;

function json(body: unknown, status = 200): Response {
    const headers = {'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*'};
    return new Response(JSON.stringify(body, null, 2), {status, headers});
}

function engineEnv(env: Env, origin: string): EngineEnv {
    return {
        // GitHub answers only requests that name a user agent, which a Worker does not do by itself.
        fetch(url, init) {
            const headers = new Headers(init?.headers);
            headers.set('user-agent', 'livebranch');
            if (env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) headers.set('authorization', `Bearer ${env.GITHUB_TOKEN}`);
            return fetch(url, {...init, headers});
        },
        runtimeBase: `${origin}/`,
        wasm: async () => tscModule,
    };
}

/** Compiles and type checks a project and reports its problems. */
async function check(spec: LinkSpec, env: Env, origin: string): Promise<Response> {
    if (isEmptySpec(spec)) return json({error: 'Name a source: gh, gist or files.'}, 400);
    const engine = engineEnv(env, origin);
    return json(await checkProject(await openProject(spec, engine), engine));
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
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== '/api/check') {
            const link = request.method === 'GET' ? linkForPath(url.pathname) : undefined;
            return link ? Response.redirect(url.origin + link, 302) : env.ASSETS.fetch(request);
        }
        try {
            if (request.method === 'GET') return await check(await decodeSpec(url.search, ''), env, url.origin);
            if (request.method !== 'POST') return json({error: 'Use GET or POST.'}, 405);
            const body = await request.text();
            if (body.length > MAX_BODY_BYTES) return json({error: 'The request is too large.'}, 413);
            return await check(JSON.parse(body) as LinkSpec, env, url.origin);
        } catch (error) {
            return json({error: error instanceof Error ? error.message : String(error)}, 500);
        }
    },
};
