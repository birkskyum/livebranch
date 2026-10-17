// Runs first in the preview page. Reports its console output and uncaught errors to the app, and
// mirrors input between the pages of a comparison.
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

    // Mirrors input between the pages of a comparison. Input that a person gives this page goes to
    // the app, which gives it to the other page when mirroring is on. There it arrives again, at the
    // same place and as the same events, and that page's own code handles it, so that the two can
    // end up apart. The pages are as large as each other, so a place in one is the same in the other.
    const MIRRORED = [
        'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
        'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'click', 'dblclick', 'contextmenu',
        'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
    ];
    const FIELDS = [
        'clientX', 'clientY', 'screenX', 'screenY', 'movementX', 'movementY', 'button', 'buttons', 'detail',
        'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'deltaX', 'deltaY', 'deltaZ', 'deltaMode',
        'key', 'code', 'location', 'repeat', 'pointerId', 'pointerType', 'isPrimary', 'width', 'height', 'pressure', 'tiltX', 'tiltY',
    ];
    // A subclass before its parent: a wheel event is a mouse event too.
    const KINDS = ['WheelEvent', 'PointerEvent', 'MouseEvent', 'KeyboardEvent', 'TouchEvent'].filter(name => name in window);
    const touches = list => [...list].map(({identifier, clientX, clientY, screenX, screenY}) => ({identifier, clientX, clientY, screenX, screenY}));
    for (const type of MIRRORED) {
        window.addEventListener(type, event => {
            // Input that this page was given from the other one is not sent back.
            if (!event.isTrusted) return;
            const kind = KINDS.find(name => event instanceof window[name]);
            if (!kind) return;
            const init = {};
            for (const field of FIELDS) if (field in event) init[field] = event[field];
            if (kind === 'TouchEvent') Object.assign(init, {touches: touches(event.touches), targetTouches: touches(event.targetTouches), changedTouches: touches(event.changedTouches)});
            window.parent.postMessage({livebranch: 'input', kind, type, init}, '*');
        }, {capture: true, passive: true});
    }

    // Keys go to what a click there would have focused. Focusing it would take the focus from the
    // page that the person is using.
    let focused = document.body;
    // A pointer that a mirrored event captured goes on to the element that captured it, as the
    // browser does for a real one, which it cannot capture.
    const captured = new Map();
    let mirroring = false;
    for (const name of ['setPointerCapture', 'releasePointerCapture']) {
        const original = Element.prototype[name];
        Element.prototype[name] = function (pointerId) {
            if (!mirroring) return original.call(this, pointerId);
            if (name === 'setPointerCapture') captured.set(pointerId, this);
            else captured.delete(pointerId);
        };
    }
    const FOCUSABLE = '[tabindex], a[href], button, input, select, textarea, [contenteditable]';
    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.data?.livebranch !== 'input') return;
        const {kind, type, init} = event.data;
        if (!KINDS.includes(kind)) return;
        const point = kind === 'TouchEvent' ? init.changedTouches[0] : init;
        let target;
        if (kind === 'KeyboardEvent') target = focused.isConnected ? focused : document.body;
        else if (kind === 'PointerEvent' && captured.has(init.pointerId)) target = captured.get(init.pointerId);
        else target = (point && document.elementFromPoint(point.clientX, point.clientY)) ?? document.documentElement;
        if (type === 'mousedown' || type === 'pointerdown' || type === 'touchstart') focused = target.closest(FOCUSABLE) ?? document.body;
        mirroring = true;
        try {
            if (kind === 'TouchEvent') {
                const touch = item => new Touch({...item, target});
                Object.assign(init, {touches: init.touches.map(touch), targetTouches: init.targetTouches.map(touch), changedTouches: init.changedTouches.map(touch)});
            }
            target.dispatchEvent(new window[kind](type, {...init, bubbles: true, cancelable: true, composed: true, view: window}));
        } catch {
            // An event that this browser cannot make, such as a touch where there is no touch screen.
        } finally {
            mirroring = false;
        }
        if (type === 'pointerup' || type === 'pointercancel') captured.delete(init.pointerId);
    });
})();
