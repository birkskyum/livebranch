import type {Vfs} from './vfs.ts';

/**
 * The page of a Solid 2 app in the client mode of @solidjs/vite-plugin (`solid({start: true})`),
 * which has no index.html. The plugin makes one at build time, around `src/App` and the document
 * shell of `src/Document`, and mounts the app into the body. This page does the same. Of the
 * document shell it takes the elements of the head that are plain markup, since in client mode
 * that is all the shell gives the page.
 */

const APP_FILES = ['App', 'app'].flatMap(name => ['.tsx', '.jsx', '.ts', '.js'].map(ext => `/src/${name}${ext}`));
const DOCUMENT_FILES = ['.tsx', '.jsx'].map(ext => `/src/Document${ext}`);
/** The head of the plugin's own shell, for an app without a document. */
const DEFAULT_HEAD = ['<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1.0">'];

/** Whether a project builds with Solid's Vite plugin. */
function usesPlugin(packageJson: any): boolean {
    return ['dependencies', 'devDependencies'].some(group => packageJson?.[group]?.['@solidjs/vite-plugin'] !== undefined);
}

/**
 * The head elements of a document component that are plain markup: `meta`, `link` and `base` with
 * literal attributes, and a literal `title`. A path from the root names a file of `public`, as
 * Vite serves that folder at the root, and the preview serves the project from its own folder.
 */
export function staticHead(source: string, vfs?: Vfs): string[] {
    const head = /<head>([\s\S]*?)<\/head>/.exec(source)?.[1] ?? '';
    const fromPublic = (attributes: string) => attributes.replace(/\b(href|src)="\/([^"]+)"/g, (whole, name: string, path: string) => vfs?.isFile(`/public/${path}`) ? `${name}="./public/${path}"` : whole);
    const elements: string[] = [];
    for (const match of head.matchAll(/<(meta|link|base)\b([^<>{}]*?)\s*\/?>|<title>([^<>{}]*)<\/title>/g)) {
        elements.push(match[3] !== undefined ? `<title>${match[3].trim()}</title>` : `<${match[1]}${fromPublic(match[2])}>`);
    }
    return elements;
}

/** The page for a Solid app in client mode and the path of its app, or undefined for a project that is not one. */
export async function solidClientPage(vfs: Vfs, packageJson: any): Promise<{html: string; app: string} | undefined> {
    if (!usesPlugin(packageJson)) return undefined;
    const app = APP_FILES.find(path => vfs.isFile(path));
    if (!app) return undefined;
    const document = DOCUMENT_FILES.find(path => vfs.isFile(path));
    if (document) await vfs.load([document]);
    const head = document ? staticHead(vfs.readText(document) ?? '', vfs) : DEFAULT_HEAD;
    const html = [
        '<!doctype html>',
        `<!-- @solidjs/vite-plugin makes this page in client mode, around ${app.slice(1)}${document ? ` and the head of ${document.slice(1)}` : ''}. livebranch makes it the same way. -->`,
        '<html lang="en">',
        '<head>',
        ...head,
        '<script type="module">',
        `import {createComponent, render} from '@solidjs/web';`,
        `import App from '.${app}';`,
        '',
        'render(() => createComponent(App, {}), document.body);',
        '</script>',
        '</head>',
        '<body></body>',
        '</html>',
        '',
    ].join('\n');
    return {html, app};
}
