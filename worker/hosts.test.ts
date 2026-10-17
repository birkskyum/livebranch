import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isLinkHost, serveLinkHost} from './hosts.ts';

test('knows the hosts of links', () => {
    assert.equal(isLinkHost('p-0123456789abcdef.livebranch.dev'), true);
    assert.equal(isLinkHost('p-0123456789abcdef.localhost'), true);
    assert.equal(isLinkHost('livebranch.dev'), false);
    assert.equal(isLinkHost('www.livebranch.dev'), false);
    assert.equal(isLinkHost('p-0123.livebranch.dev'), false);
});

test('serves only the service worker and the runtime on the host of a link', async () => {
    const assets = {fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`)};
    const status = async (path: string) => (await serveLinkHost(new Request(`https://p-0123456789abcdef.livebranch.dev${path}`), assets)).status;
    assert.equal(await status('/sw.js'), 200);
    assert.equal(await status('/rt/sandbox.html'), 200);
    assert.equal(await status('/rt/node/fs.js'), 200);
    for (const path of ['/', '/index.html', '/assets/index-a1b2c3d4.js', '/api/check', '/~p/0123/index.html']) assert.equal(await status(path), 404, path);
});
