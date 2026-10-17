/** A host of one link, p-<16 hex digits> in front of the app's host, where its previews and scripts run (src/ui/sandbox.ts). */
const LINK_HOST = /^p-[0-9a-f]{16}\./;

export interface Assets {
    fetch(request: Request): Promise<Response>;
}

export function isLinkHost(hostname: string): boolean {
    return LINK_HOST.test(hostname);
}

/**
 * Answers on a link's host. It has the service worker and the runtime that pages and scripts load,
 * and the service worker serves the builds from the browser. The app and its API are only on the
 * app's host, so that no page of a link runs where they keep their data.
 */
export async function serveLinkHost(request: Request, assets: Assets): Promise<Response> {
    const {pathname} = new URL(request.url);
    if (pathname === '/sw.js' || pathname.startsWith('/rt/')) return assets.fetch(request);
    return new Response('This preview is not built in this browser. Open the link that it belongs to.', {status: 404, headers: {'content-type': 'text/plain; charset=utf-8'}});
}
