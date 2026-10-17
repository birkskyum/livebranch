import type {LinkSpec} from '../engine/spec.ts';

const ANSWER_MS = 15_000;

/**
 * A host of a link's own, p-<hash> in front of the app's host, where its previews and scripts run.
 * A browser keeps storage by host, so code of a link that ran on the app's host could change what
 * the app shows and the builds of other links. On a host of its own, it can only change its own.
 */
export interface Sandbox {
    /** The URL of the app on the link's host, ending with a slash. */
    base: string;
    /** The port to the sandbox page, for the engine. */
    port: MessagePort;
    close(): void;
}

/** The host of a link: the first 16 hex digits of the SHA-256 of its spec. */
async function hostOf(spec: LinkSpec): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(spec))));
    return `p-${[...digest.subarray(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Opens the sandbox page of a link in a hidden frame, once its service worker is ready. */
export async function openSandbox(spec: LinkSpec, appBase: string): Promise<Sandbox> {
    const app = new URL(appBase);
    const base = `${app.protocol}//${await hostOf(spec)}.${app.host}${app.pathname}`;
    const origin = new URL(base).origin;
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Sandbox';
    frame.src = `${base}rt/sandbox.html`;
    return new Promise((resolve, reject) => {
        const done = () => {
            clearTimeout(timer);
            removeEventListener('message', receive);
        };
        const fail = (error: Error) => {
            done();
            frame.remove();
            reject(error);
        };
        const timer = setTimeout(() => fail(new Error(`${origin} does not answer, so the preview cannot run.`)), ANSWER_MS);
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.livebranch !== 'sandbox') return;
            if (event.data.error) return fail(new Error(event.data.error));
            done();
            const channel = new MessageChannel();
            frame.contentWindow!.postMessage({livebranch: 'sandbox'}, origin, [channel.port2]);
            resolve({base, port: channel.port1, close: () => {
                channel.port1.close();
                frame.remove();
            }});
        };
        addEventListener('message', receive);
        document.body.append(frame);
    });
}
