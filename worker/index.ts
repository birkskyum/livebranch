// The app as a Worker: the static build from dist, and the engine behind an HTTP API, for agents
// and scripts that have no browser. It is the same compile and type check as in the tab. It runs
// on Cloudflare, and on workerd or celld for self-hosting.
import tscModule from '../public/tsc/ts_rust.wasm';
import {checkProject} from '../src/engine/check.ts';
import {openProject, type Env as EngineEnv} from '../src/engine/project.ts';
import {decodeSpec, isEmptySpec, type LinkSpec} from '../src/engine/spec.ts';

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

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== '/api/check') return env.ASSETS.fetch(request);
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
