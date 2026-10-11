import {dirname, resolve} from './path.ts';
import {isSourcePath} from './resolve.ts';

export interface HtmlPage {
    html: string;
    /** Inline module scripts, moved to files next to the page so that they compile as TypeScript. */
    inline: Map<string, string>;
    /** Module scripts of the page that are project files. */
    entries: string[];
    /** Specifiers that the page's own import map resolves. */
    importMap: string[];
    /** For each inline script file, the number of page lines above its first line. */
    inlineLines: Map<string, number>;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function attribute(attributes: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
    return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function isLocal(src: string): boolean {
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

/**
 * Prepares a page for the preview. Inline module scripts may hold TypeScript, so each one becomes a
 * file (`page.html.0.ts`) that the page loads by `src`. `runtime` is the URL of a script that goes
 * first in the page and reports its console to the app.
 */
export function transformHtml(html: string, path: string, runtime: string): HtmlPage {
    const inline = new Map<string, string>();
    const entries: string[] = [];
    const importMap: string[] = [];
    const inlineLines = new Map<string, number>();
    const dir = dirname(path);
    const name = path.slice(path.lastIndexOf('/') + 1);

    let out = html.replace(SCRIPT, (tag: string, attributes: string, body: string, offset: number) => {
        const type = attribute(attributes, 'type')?.toLowerCase();
        const src = attribute(attributes, 'src');
        if (type === 'importmap') {
            try {
                importMap.push(...Object.keys(JSON.parse(body).imports ?? {}));
            } catch {
                // A broken import map is the page's own problem, and the browser reports it.
            }
            return tag;
        }
        if (type !== 'module') return tag;
        if (src !== undefined) {
            const file = resolve(dir, src.split(/[?#]/)[0]);
            if (isLocal(src) && isSourcePath(file)) entries.push(file);
            return tag;
        }
        if (!body.trim()) return tag;
        const file = `${path}.${inline.size}.ts`;
        inline.set(file, body);
        const bodyStart = offset + tag.indexOf('>') + 1;
        inlineLines.set(file, html.slice(0, bodyStart).split('\n').length - 1);
        entries.push(file);
        const kept = attributes.replace(/\s+$/, '');
        return `<script${kept} src="./${name}.${inline.size - 1}.ts"></script>`;
    });

    const script = `<script src="${runtime}"></script>`;
    const head = /<head\b[^>]*>/i.exec(out);
    if (head) out = out.slice(0, head.index + head[0].length) + script + out.slice(head.index + head[0].length);
    else out = out.replace(/^(\s*<!doctype[^>]*>)?/i, start => `${start}${script}`);
    return {html: out, inline, entries, importMap, inlineLines};
}
