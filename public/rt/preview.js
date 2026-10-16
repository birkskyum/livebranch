// Runs first in the preview page. Reports its console output and uncaught errors to the app, and
// carries the views that a comparison keeps the same.
(() => {
    // WebKit loads the imports of a module worker through the service worker only for the first of
    // several workers that start at the same moment from one URL. The others fail to load. A
    // parameter of its own makes each worker's URL different, and the service worker ignores it.
    const NativeWorker = window.Worker;
    let workers = 0;
    window.Worker = class extends NativeWorker {
        constructor(url, options) {
            let target = url;
            try {
                const parsed = new URL(url, location.href);
                if (options?.type === 'module' && parsed.origin === location.origin) {
                    parsed.searchParams.set('livebranch-worker', String(++workers));
                    target = parsed;
                }
            } catch {
                // The browser reports a URL that does not parse.
            }
            super(target, options);
        }
    };

    if (window.parent === window) return;
    const send = (level, args) => {
        try {
            window.parent.postMessage({livebranch: 'console', level, args: args.map(format)}, '*');
        } catch {
            // The message is only for display.
        }
    };
    const format = value => {
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (typeof value === 'string') return value;
        if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
        if (value instanceof Node) return value.nodeName.toLowerCase();
        try {
            const seen = new WeakSet();
            const text = JSON.stringify(value, (key, item) => {
                if (typeof item === 'bigint') return `${item}n`;
                if (typeof item === 'object' && item !== null) {
                    if (seen.has(item)) return '[Circular]';
                    seen.add(item);
                }
                return item;
            });
            return text === undefined ? String(value) : text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
        } catch {
            return String(value);
        }
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level];
        console[level] = (...args) => {
            send(level, args);
            original.apply(console, args);
        };
    }
    window.addEventListener('error', event => {
        if (event.error || event.message) send('error', [event.error ?? `${event.message} (${event.filename}:${event.lineno})`]);
        else if (event.target?.src || event.target?.href) send('error', [`Failed to load ${event.target.src || event.target.href}`]);
    }, true);
    window.addEventListener('unhandledrejection', event => send('error', [event.reason]));
    window.addEventListener('load', () => window.parent.postMessage({livebranch: 'load', title: document.title}, '*'));

    // Keeps the views of a comparison the same, such as the cameras of two maps. A library's adapter
    // says how its views are shown and offers the ones that input gives them. The app carries each
    // view to the same thing on the other side, the first map to the first map.
    const followers = [];
    let following = false;
    window.livebranch = {
        sync: {
            /** Says how the next thing on the page shows a view, and returns its number. */
            follow(show) {
                followers.push(show);
                window.parent.postMessage({livebranch: 'follow', index: followers.length - 1}, '*');
                return followers.length - 1;
            },
            /** Offers a view of a thing to the other side. A view that came from there is not sent back. */
            publish(index, view) {
                if (!following) window.parent.postMessage({livebranch: 'view', index, view}, '*');
            },
        },
    };
    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.data?.livebranch !== 'view') return;
        following = true;
        try {
            followers[event.data.index]?.(event.data.view);
        } finally {
            following = false;
        }
    });
})();
