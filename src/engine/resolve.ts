import {dirname, resolve} from './path.ts';
import type {Vfs} from './vfs.ts';

export interface ResolveContext {
    vfs: Vfs;
    /** Bare specifiers that point at a project file (`./src/index.ts`) or a URL. */
    alias: Record<string, string>;
    /** The installed version or the wanted range of an npm package. */
    version(name: string): string | undefined;
    cdn: 'esm.sh' | 'jsdelivr';
    /** The URL of the app, ending with a slash. The Node shims are served from it. */
    runtimeBase: string;
    /** Specifiers that the page's own import map takes care of. */
    keep?: Set<string>;
}

export type Resolved =
    | {kind: 'file'; path: string}
    | {kind: 'url'; url: string}
    | {kind: 'keep'}
    | {kind: 'missing'};

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SWAPS: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
};
const APPENDED = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'];
const INDEXES = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/** Modules of Node, and `glob`, that have a shim over the virtual file system. */
const NODE_SHIMS: Record<string, string> = {
    'fs': 'fs.js',
    'fs/promises': 'fs-promises.js',
    'path': 'path.js',
    'path/posix': 'path.js',
    'url': 'url.js',
    'process': 'process.js',
    'glob': 'glob.js',
};

export function isSourcePath(path: string): boolean {
    return SOURCE.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

/** The file that an import of `path` loads: the path itself, or with a TypeScript or index ending. */
export function resolveFile(vfs: Vfs, path: string): string | undefined {
    if (vfs.isFile(path)) return path;
    const dot = path.lastIndexOf('.');
    const swaps = dot > path.lastIndexOf('/') ? SWAPS[path.slice(dot)] : undefined;
    for (const ext of swaps ?? []) {
        const candidate = path.slice(0, dot) + ext;
        if (vfs.isFile(candidate)) return candidate;
    }
    for (const ext of APPENDED) if (vfs.isFile(path + ext)) return path + ext;
    for (const index of INDEXES) if (vfs.isFile(path + index)) return path + index;
    return undefined;
}

function packageName(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function cdnUrl(specifier: string, ctx: ResolveContext): string {
    const name = packageName(specifier);
    const subpath = specifier.slice(name.length);
    const version = ctx.version(name);
    const versioned = version ? `${name}@${version}` : name;
    return ctx.cdn === 'jsdelivr'
        ? `https://cdn.jsdelivr.net/npm/${versioned}${subpath}/+esm`
        : `https://esm.sh/${versioned}${subpath}`;
}

function aliased(specifier: string, alias: Record<string, string>): string | undefined {
    if (specifier in alias) return alias[specifier];
    for (const [key, target] of Object.entries(alias)) {
        if (specifier.startsWith(`${key}/`)) return target.replace(/\/$/, '') + specifier.slice(key.length);
    }
    return undefined;
}

/** Where an import of `specifier` in the file `importer` loads from. */
export function resolveSpecifier(specifier: string, importer: string, ctx: ResolveContext): Resolved {
    if (/^(?:https?|data|blob):/.test(specifier)) return {kind: 'url', url: specifier};
    const [bare] = specifier.split('?');
    if (bare.startsWith('.') || bare.startsWith('/')) {
        const path = resolveFile(ctx.vfs, resolve(dirname(importer), bare));
        return path ? {kind: 'file', path} : {kind: 'missing'};
    }
    if (ctx.keep?.has(specifier)) return {kind: 'keep'};
    const target = aliased(specifier, ctx.alias);
    if (target !== undefined) {
        if (/^https?:/.test(target)) return {kind: 'url', url: target};
        const path = resolveFile(ctx.vfs, resolve('/', target));
        return path ? {kind: 'file', path} : {kind: 'missing'};
    }
    const shim = NODE_SHIMS[specifier.replace(/^node:/, '')];
    if (shim) return {kind: 'url', url: `${ctx.runtimeBase}rt/node/${shim}`};
    if (specifier.startsWith('node:')) return {kind: 'keep'};
    return {kind: 'url', url: cdnUrl(specifier, ctx)};
}

const FROM = /\bfrom\s*(['"])([^'"\n]+)\1/g;
const OTHER_IMPORTS = [
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"\n]+)\1/g,
];
/** `import type ... from` and `export type ... from`, which leave no import in the output. */
const TYPE_FROM = /(?:^|[;\n}])\s*(?:import|export)\s+type\s+(?:[\w$]+\s*,?\s*)?(?:[{*][^'"`;]*?)?\bfrom\s*(['"])([^'"\n]+)\1/g;
const URLS = /\bnew\s+URL\(\s*(['"])(\.[^'"\n]+)\1\s*,\s*import\.meta\.url/g;

function count(code: string, pattern: RegExp, into: Map<string, number>): void {
    for (const match of code.matchAll(pattern)) into.set(match[2], (into.get(match[2]) ?? 0) + 1);
}

/**
 * The specifiers that a TypeScript or JavaScript source loads at run time, found by pattern:
 * its imports except the ones written as type-only, and the files it names by a URL relative to
 * `import.meta.url`. It may name a few things that are not imports (a `from '...'` in a comment).
 * It decides what to fetch and compile. The compiler's output says what is really imported.
 * `withTypes` adds the type-only imports, which a type check reads too.
 */
export function scanImports(code: string, withTypes = false): {imports: string[]; urls: string[]} {
    const all = new Map<string, number>();
    const typeOnly = new Map<string, number>();
    count(code, FROM, all);
    count(code, TYPE_FROM, typeOnly);
    const imports = new Set<string>();
    for (const [specifier, times] of all) if (withTypes || times > (typeOnly.get(specifier) ?? 0)) imports.add(specifier);
    for (const pattern of OTHER_IMPORTS) for (const match of code.matchAll(pattern)) imports.add(match[2]);
    const urls = new Set<string>();
    for (const match of code.matchAll(URLS)) urls.add(match[2]);
    return {imports: [...imports], urls: [...urls]};
}
