import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SignJWT, createLocalJWKSet, exportJWK, generateKeyPair} from 'jose';
import {AUDIENCE, getPicture, putPicture, type Bucket} from './pictures.ts';

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const {privateKey, publicKey} = await generateKeyPair('RS256');
const keys = createLocalJWKSet({keys: [{...await exportJWK(publicKey), kid: 'test', alg: 'RS256'}]});

/** A token as GitHub Actions gives a run, with `claims` changed. */
function token(claims: Record<string, unknown> = {}, audience = AUDIENCE): Promise<string> {
    return new SignJWT({repository: 'birkskyum/maplibre-gl-js', run_id: '123', ...claims})
        .setProtectedHeader({alg: 'RS256', kid: 'test'})
        .setIssuer('https://token.actions.githubusercontent.com')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
}

function bucket(): Bucket & {stored: Map<string, ArrayBuffer>} {
    const stored = new Map<string, ArrayBuffer>();
    return {
        stored,
        put: async (key, value) => void stored.set(key, value),
        get: async key => stored.has(key) ? {body: new Blob([stored.get(key)!]).stream()} : null,
    };
}

async function upload(store: Bucket, bearer: string, path = '/api/pictures/birkskyum/maplibre-gl-js/123/head.png', body: Uint8Array<ArrayBuffer> = PNG, owners = ['birkskyum']) {
    const request = new Request(`https://livebranch.dev${path}`, {method: 'PUT', headers: {authorization: `Bearer ${bearer}`}, body});
    try {
        return {key: await putPicture(request, store, owners, keys)};
    } catch (error) {
        return {status: (error as {status?: number}).status};
    }
}

test('stores the picture of a run of an allowed repository, and serves it', async () => {
    const store = bucket();
    assert.deepEqual(await upload(store, await token()), {key: 'birkskyum/maplibre-gl-js/123/head.png'});
    const served = await getPicture('/api/pictures/birkskyum/maplibre-gl-js/123/head.png', store);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
});

test('refuses a token of another repository, of another run, or for another site', async () => {
    const store = bucket();
    assert.deepEqual(await upload(store, await token({repository: 'someone/else'})), {status: 403});
    assert.deepEqual(await upload(store, await token({run_id: '999'})), {status: 403});
    assert.deepEqual(await upload(store, await token({}, 'https://example.com')), {status: 401});
    assert.deepEqual(await upload(store, 'not-a-token'), {status: 401});
    assert.equal(store.stored.size, 0);
});

test('refuses owners that are not allowed, other files, and what is not a PNG', async () => {
    const store = bucket();
    assert.deepEqual(await upload(store, await token(), undefined, undefined, ['maplibre']), {status: 403});
    assert.deepEqual(await upload(store, await token(), '/api/pictures/birkskyum/maplibre-gl-js/123/other.png'), {status: 404});
    assert.deepEqual(await upload(store, await token(), undefined, new Uint8Array(new TextEncoder().encode('<svg>'))), {status: 415});
    assert.equal(store.stored.size, 0);
});
