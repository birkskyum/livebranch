import {init, parse} from 'es-module-lexer';
import {basename, dirname, relative} from './path.ts';
import {isSourcePath, resolveSpecifier, type ResolveContext} from './resolve.ts';

export type AssetKind = 'json' | 'css' | 'raw' | 'url';

/** A module that stands in for a file that is not JavaScript, served at `path` + `.$kind.js`. */
export interface AssetModule {
    path: string;
    kind: AssetKind;
}

export interface Rewritten {
    code: string;
    assets: AssetModule[];
    /** Relative imports and aliases that name no file. */
    missing: string[];
    /** Project source files that the module imports. */
    sources: string[];
}

export const lexerReady: Promise<void> = init();

export function assetModulePath(asset: AssetModule): string {
    return `${asset.path}.$${asset.kind}.js`;
}

export function assetModuleCode(asset: AssetModule, text: string): string {
    switch (asset.kind) {
        case 'json':
            return `export default ${text.trim() || 'null'};\n`;
        case 'css':
            return `const style = document.createElement('style');\nstyle.textContent = ${JSON.stringify(text)};\ndocument.head.append(style);\nexport default style.textContent;\n`;
        case 'raw':
            return `export default ${JSON.stringify(text)};\n`;
        case 'url':
            return `export default new URL(${JSON.stringify(`./${basename(asset.path)}`)}, import.meta.url).href;\n`;
    }
}

function assetKind(path: string, query: string): AssetKind | undefined {
    if (query === 'raw') return 'raw';
    if (query === 'url') return 'url';
    if (isSourcePath(path)) return undefined;
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.css')) return 'css';
    return 'url';
}

/**
 * Makes the imports of a compiled module loadable by a browser as they are. Relative imports get
 * the path of the source file they name, since the compiled module is served at its source path.
 * Bare imports become CDN URLs, because a worker has no import map.
 */
export function rewriteModule(code: string, importer: string, ctx: ResolveContext): Rewritten {
    const [imports] = parse(code, importer);
    const assets: AssetModule[] = [];
    const missing: string[] = [];
    const sources: string[] = [];
    const edits: {start: number; end: number; text: string}[] = [];
    const from = dirname(importer);

    for (const record of imports) {
        if (record.type === 'import-meta') continue;
        if (record.specifier === undefined || (record.type === 'dynamic' && record.glob)) {
            // A specifier computed at run time. A script run resolves it (public/rt/node-runner.js).
            const expression = code.slice(record.start, record.end);
            const text = `(globalThis.__reproImport ? globalThis.__reproImport(${expression}, import.meta.url) : import(${expression}))`;
            edits.push({start: record.importStart, end: record.importEnd, text});
            continue;
        }
        const specifier = record.specifier;
        const resolved = resolveSpecifier(specifier, importer, ctx);
        if (resolved.kind === 'keep') continue;
        if (resolved.kind === 'missing') {
            missing.push(specifier);
            continue;
        }
        let target: string;
        if (resolved.kind === 'url') {
            target = resolved.url;
        } else {
            const kind = assetKind(resolved.path, specifier.split('?')[1] ?? '');
            let path = resolved.path;
            if (!kind) sources.push(path);
            if (kind) {
                const asset = {path, kind};
                assets.push(asset);
                path = assetModulePath(asset);
                if (record.attributesStart > 0) {
                    const close = code.indexOf('}', record.attributesStart);
                    edits.push({start: record.end + 1, end: close + 1, text: ''});
                }
            }
            target = relative(from, path);
        }
        const quoted = code[record.start] === '"' || code[record.start] === '\'';
        edits.push({start: record.start, end: record.end, text: quoted ? JSON.stringify(target) : target});
    }

    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    for (const edit of edits) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    return {code, assets, missing, sources};
}
