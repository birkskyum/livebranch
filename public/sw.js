// Serves the preview of a build on the host of its link. The sandbox page (rt/sandbox.js) puts every
// file of a build into one cache, named by the build's id, under `~p/<id>/`. A file that the build
// did not touch comes from the project's source, whose URL the build's meta entry holds.

const PREFIX = '~p/';
const TYPES = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    geojson: 'application/geo+json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    wasm: 'application/wasm',
    woff2: 'font/woff2',
    pbf: 'application/x-protobuf',
    txt: 'text/plain; charset=utf-8',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// The sandbox page asks for it when it loaded without a service worker (public/rt/sandbox.js).
self.addEventListener('message', event => {
    if (event.data === 'claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + PREFIX)) return;
    event.respondWith(serve(url, scope));
});

function notFound(text) {
    return new Response(text, {status: 404, headers: {'content-type': 'text/plain; charset=utf-8'}});
}

async function serve(url, scope) {
    const rest = url.pathname.slice((scope.pathname + PREFIX).length);
    const slash = rest.indexOf('/');
    const id = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '/' : rest.slice(slash);
    const name = `livebranch-build-${id}`;
    if (!await caches.has(name)) {
        return notFound('This preview is not built in this browser. Open its share link instead.');
    }
    const cache = await caches.open(name);
    const base = `${scope.href}${PREFIX}${id}`;
    const hit = await cache.match(base + path) ?? (path.endsWith('/') ? await cache.match(`${base}${path}index.html`) : undefined);
    if (hit) return hit;

    const meta = await cache.match(`${base}/__meta__.json`);
    const remote = meta && (await meta.json()).remote;
    if (remote && path.length > 1) {
        try {
            const response = await fetch(remote + path.slice(1));
            if (response.ok) {
                const type = TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
                return new Response(response.body, {headers: {'content-type': type, 'cache-control': 'no-store'}});
            }
        } catch {
            // Falls through to the 404 below.
        }
    }
    return notFound(`Not found: ${path}`);
}
