// Pictures of pull requests, which a GitHub Actions workflow takes and posts in a comment. GitHub
// takes no image into a comment, so they live here. A workflow proves its repository and its run
// with the OIDC token that GitHub gives it, and may store pictures for that run alone. No token is
// kept here.
import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';

const ISSUER = 'https://token.actions.githubusercontent.com';
/** The audience that a workflow asks its token for. */
export const AUDIENCE = 'https://livebranch.dev';
const NAMES = new Set(['base.png', 'head.png']);
const MAX_PICTURE_BYTES = 2_000_000;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const githubKeys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

/** What the Worker needs of an R2 bucket. */
export interface Bucket {
    put(key: string, value: ArrayBuffer, options: {httpMetadata: {contentType: string; cacheControl: string}}): Promise<unknown>;
    get(key: string): Promise<{body: ReadableStream} | null>;
}

export class PictureError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** The key of `/api/pictures/<owner>/<repo>/<run>/<base|head>.png`, or undefined for another path. */
export function pictureKey(pathname: string): {owner: string; repo: string; run: string; key: string} | undefined {
    const match = /^\/api\/pictures\/([\w.-]+)\/([\w.-]+)\/(\d+)\/([\w.-]+)$/.exec(pathname);
    if (!match || !NAMES.has(match[4])) return undefined;
    const [, owner, repo, run, name] = match;
    return {owner, repo, run, key: `${owner.toLowerCase()}/${repo.toLowerCase()}/${run}/${name}`};
}

/**
 * Stores a picture that a workflow run took. Its token has to come from GitHub for this site, and
 * name the repository and the run of the path. `owners` are the accounts whose repositories may
 * store pictures, `*` for any.
 */
export async function putPicture(request: Request, bucket: Bucket, owners: string[], keys: JWTVerifyGetKey = githubKeys): Promise<string> {
    const found = pictureKey(new URL(request.url).pathname);
    if (!found) throw new PictureError(404, 'A picture is /api/pictures/<owner>/<repo>/<run>/<base|head>.png.');
    if (!owners.includes('*') && !owners.includes(found.owner.toLowerCase())) throw new PictureError(403, `${found.owner} may not store pictures here.`);
    const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) throw new PictureError(401, 'Send the OIDC token of the workflow run as a bearer token.');
    let claims: Record<string, unknown>;
    try {
        claims = (await jwtVerify(token, keys, {issuer: ISSUER, audience: AUDIENCE})).payload;
    } catch (error) {
        throw new PictureError(401, `The token is not one of GitHub Actions for ${AUDIENCE}. ${error instanceof Error ? error.message : ''}`.trim());
    }
    if (String(claims.repository).toLowerCase() !== `${found.owner}/${found.repo}`.toLowerCase()) throw new PictureError(403, `The token is for ${claims.repository}.`);
    if (String(claims.run_id) !== found.run) throw new PictureError(403, `The token is for run ${claims.run_id}.`);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PICTURE_BYTES) throw new PictureError(413, `A picture may have ${MAX_PICTURE_BYTES / 1e6} MB at most.`);
    const head = new Uint8Array(body, 0, Math.min(PNG.length, body.byteLength));
    if (!PNG.every((byte, index) => head[index] === byte)) throw new PictureError(415, 'A picture has to be a PNG.');
    await bucket.put(found.key, body, {httpMetadata: {contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable'}});
    return found.key;
}

/** A stored picture. A run stores each of its pictures once, so it never changes. */
export async function getPicture(pathname: string, bucket: Bucket): Promise<Response> {
    const found = pictureKey(pathname);
    const stored = found && await bucket.get(found.key);
    if (!stored) return new Response('There is no such picture.', {status: 404});
    return new Response(stored.body, {headers: {'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable'}});
}
