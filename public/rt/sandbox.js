// Runs in a hidden frame on the host of one link, p-<hash>.livebranch.dev, where the previews and
// scripts of that link run apart from the app and from other links. The engine sends the files of
// each build, which the service worker then serves, and the scripts to run. Messages count only
// from the app, which gives this page a port of its own once the service worker is ready.

const KEPT_BUILDS = 3;
const CONTROL_MS = 5000;
// The app is on the host without the link's part: livebranch.dev for p-<hash>.livebranch.dev.
const app = location.origin.replace(/\/\/p-[0-9a-f]+\./, '//');
const root = new URL('../', location.href).href;
const buildCache = id => `livebranch-build-${id}`;

/** Registers the service worker and waits until it controls this page, and so the workers that it starts. */
async function control() {
    const registration = await navigator.serviceWorker.register(new URL('sw.js', root), {scope: root});
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve, reject) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true});
        // A page that a forced reload left without it asks to be taken.
        registration.active?.postMessage('claim');
        setTimeout(() => reject(new Error('The service worker of the preview does not start. Reload the page without holding shift.')), CONTROL_MS);
    });
}

/** Puts the files of a build where the service worker serves them, and keeps only the newest builds. */
async function publish(id, files) {
    const cache = await caches.open(buildCache(id));
    const base = `${root}~p/${id}`;
    await Promise.all(files.map(([path, body, type]) => cache.put(base + path, new Response(body, {headers: {'content-type': type, 'cache-control': 'no-store'}}))));
    const index = await caches.open('livebranch-index');
    const stored = await index.match('/builds');
    const ids = [id, ...(stored ? await stored.json() : []).filter(other => other !== id)];
    await Promise.all(ids.slice(KEPT_BUILDS).map(old => caches.delete(buildCache(old))));
    await index.put('/builds', new Response(JSON.stringify(ids.slice(0, KEPT_BUILDS))));
}

/** Answers the engine on its port. */
function serve(port) {
    const runs = new Map();
    port.onmessage = async ({data}) => {
        if (data.type === 'publish') {
            try {
                await publish(data.id, data.files);
                port.postMessage({reply: data.reply});
            } catch (error) {
                port.postMessage({reply: data.reply, error: String(error?.message ?? error)});
            }
        } else if (data.type === 'run') {
            // A URL of its own for each run: WebKit loads the imports of a module worker through the
            // service worker only for the first of several that start at once from one URL.
            const worker = new Worker(new URL(`node-runner.js?run=${crypto.randomUUID()}`, location.href), {type: 'module', name: data.request.script});
            runs.set(data.run, worker);
            worker.onmessage = event => port.postMessage({run: data.run, data: event.data});
            worker.onerror = event => port.postMessage({run: data.run, error: event.message || `${data.request.script} could not start.`});
            worker.postMessage(data.request);
        } else if (data.type === 'stop') {
            runs.get(data.run)?.terminate();
            runs.delete(data.run);
        }
    };
}

if (window.parent !== window) {
    control().then(() => {
        addEventListener('message', event => {
            if (event.origin !== app || event.source !== window.parent || event.data?.livebranch !== 'sandbox' || !event.ports[0]) return;
            serve(event.ports[0]);
        });
        window.parent.postMessage({livebranch: 'sandbox'}, app);
    }, error => window.parent.postMessage({livebranch: 'sandbox', error: String(error?.message ?? error)}, app));
}
