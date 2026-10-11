// Runs first in the preview page. Reports its console output and uncaught errors to the app.
(() => {
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
})();
