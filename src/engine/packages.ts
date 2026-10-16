import {parse} from 'es-module-lexer';
import {tarballUrl, untar} from './npm.ts';
import {dirname, resolve} from './path.ts';
import type {Env} from './project.ts';
import {nodeShim, packageName} from './resolve.ts';
import {lexerReady} from './rewrite.ts';

/**
 * An npm package that a script imports by names it computes, such as
 * `@unicode/unicode-${version}/Script/${script}/code-points.mjs`. The CDN builds each such file on
 * its first request, and a script that loads hundreds of them one after the other waits a second
 * for each. So the package comes from npm as one tarball, and its modules are served with the build.
 */
export interface ScriptPackage {
    name: string;
    /** The modules that load from the build, as they are served, by their path in the package. */
    files: Map<string, string>;
    /** The module that each import specifier of the package loads, by its path in the package. */
    specifiers: Record<string, string>;
}

/** A computed import that starts with fewer letters than a package name may be meant for any of these many. */
const MOST_PER_PREFIX = 3;
/**
 * The fixed start of a computed import in a compiled module. rewrite.ts wraps the import in
 * `__livebranchImport`, and the compiler may have wrapped its specifier in a helper of its own.
 */
const COMPUTED = /__livebranchImport\(\s*(?:__rewriteRelativeImportExtension\(\s*)?(?:(['"])([^'"\n]*)\1|`([^`$]*))/g;
/** What a CommonJS module of Node uses. The CDN turns such a module into an ES module, so it loads from there. */
const NODE_ONLY = /\b(?:require\s*\(|module\.exports\b|exports\.[\w$]|__dirname\b|__filename\b|setImmediate\b)/;
/** A declaration or import of a binding named `Buffer`, which a module that has one needs no import of. */
const OWN_BUFFER = /\b(?:const|let|var|function|class)\s+Buffer\b|\bas\s+Buffer\b|[{,]\s*Buffer\s*[,}]/;
/** The conditions of a package's `exports` that a browser takes, as the CDN does. */
const CONDITIONS = new Set(['browser', 'worker', 'import', 'module', 'default']);
const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;

/**
 * The packages that the compiled modules of a script import by computed names. The name is taken
 * from the fixed start of the import, or the project's packages that start with it are.
 */
export function computedPackages(modules: Iterable<string>, versions: Record<string, string>): string[] {
    const names = new Set<string>();
    for (const code of modules) {
        for (const match of code.matchAll(COMPUTED)) {
            const start = match[2] ?? match[3];
            if (!start || /^(?:[./]|[a-z]+:)/.test(start)) continue;
            const name = packageName(start);
            const found = start.length > name.length
                ? [name].filter(known => known in versions)
                : Object.keys(versions).filter(known => known.startsWith(start));
            if (found.length <= MOST_PER_PREFIX) for (const known of found) names.add(known);
        }
    }
    return [...names];
}

/**
 * The modules of a package that load from the build: ES modules that import only modules of this
 * kind by relative paths, and modules of Node that have a shim, and JSON files. An import of a
 * module of Node becomes the URL of its shim, and a module that uses Node's `Buffer` gets an import
 * of it, as the CDN does. The rest of the package loads from the CDN.
 */
export function servedModules(files: Map<string, string>, runtimeBase: string): Map<string, string> {
    const served = new Map<string, {code: string; targets: string[]}>();
    for (const [path, source] of files) {
        if (path.endsWith('.json')) {
            served.set(path, {code: source, targets: []});
            continue;
        }
        if (!/\.m?js$/.test(path) || NODE_ONLY.test(source)) continue;
        try {
            const [records, , , hasModuleSyntax] = parse(source, path);
            if (!hasModuleSyntax && !path.endsWith('.mjs')) continue;
            const targets: string[] = [];
            const edits: {start: number; end: number; text: string}[] = [];
            let loads = true;
            for (const record of records) {
                if (record.type === 'import-meta') continue;
                const specifier = record.specifier;
                const shim = specifier === undefined ? undefined : nodeShim(specifier, runtimeBase);
                if (specifier?.startsWith('.')) {
                    targets.push(resolve(dirname(`/${path}`), specifier).slice(1));
                } else if (shim) {
                    const quoted = source[record.start] === '"' || source[record.start] === '\'';
                    edits.push({start: record.start, end: record.end, text: quoted ? JSON.stringify(shim) : shim});
                } else {
                    loads = false;
                }
            }
            if (!loads) continue;
            let code = source;
            for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
            if (/\bBuffer\b/.test(code) && !OWN_BUFFER.test(code)) code = `import {Buffer} from ${JSON.stringify(`${runtimeBase}rt/node/buffer.js`)};\n${code}`;
            served.set(path, {code, targets});
        } catch {
            // A module that does not parse is left to the CDN.
        }
    }
    // A module that imports one that loads from the CDN loads from there as well.
    for (let changed = true; changed;) {
        changed = false;
        for (const [path, {targets}] of served) {
            if (targets.every(target => served.has(target))) continue;
            served.delete(path);
            changed = true;
        }
    }
    return new Map([...served].map(([path, {code}]) => [path, code]));
}

/** The target that a value of `exports` gives a browser, by the first condition in it that the browser has. */
function exportTarget(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    const options = Array.isArray(value) ? value : value && typeof value === 'object'
        ? Object.entries(value).filter(([condition]) => CONDITIONS.has(condition)).map(([, target]) => target)
        : [];
    for (const option of options) {
        const target = exportTarget(option);
        if (target !== undefined) return target;
    }
    return undefined;
}

/** The import specifiers of a package that load one of its `served` modules, with the module each loads. */
export function packageSpecifiers(name: string, packageJson: Record<string, any>, served: Set<string>): Record<string, string> {
    const specifiers: Record<string, string> = {};
    const exports: unknown = packageJson.exports;
    if (exports === undefined || exports === null) {
        for (const path of served) specifiers[`${name}/${path}`] = path;
        const mains = [packageJson.module, packageJson.main, 'index'].filter(main => typeof main === 'string').map(main => main.replace(/^\.\/|\/$/g, ''));
        const main = mains.flatMap(main => [main, `${main}.js`, `${main}.mjs`, `${main}/index.js`, `${main}/index.mjs`]).find(path => served.has(path));
        if (main) specifiers[name] = main;
        return specifiers;
    }
    const subpaths = typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'));
    const entries: [string, unknown][] = subpaths ? Object.entries(exports) : [['.', exports]];
    for (const [key, value] of entries) {
        const target = exportTarget(value);
        if (!target?.startsWith('./')) continue;
        const specifier = name + key.slice(1);
        const file = target.slice(2);
        if (!key.includes('*')) {
            if (served.has(file)) specifiers[specifier] = file;
            continue;
        }
        const [before, after = ''] = file.split('*');
        for (const path of served) {
            if (path.length < before.length + after.length || !path.startsWith(before) || !path.endsWith(after)) continue;
            specifiers[specifier.replace('*', path.slice(before.length, path.length - after.length))] = path;
        }
    }
    return specifiers;
}

/** The version that a range of the project names, as jsDelivr resolves it. */
async function exactVersion(env: Env, name: string, wanted: string): Promise<string | undefined> {
    if (EXACT.test(wanted)) return wanted;
    const response = await env.fetch(`https://data.jsdelivr.com/v1/packages/npm/${name}/resolved?specifier=${encodeURIComponent(wanted)}`);
    return response.ok ? (await response.json() as {version?: string}).version ?? undefined : undefined;
}

async function fetchPackage(env: Env, name: string, wanted: string): Promise<ScriptPackage | undefined> {
    const version = await exactVersion(env, name, wanted);
    if (!version) return undefined;
    const response = await env.fetch(tarballUrl(name, version));
    if (!response.ok || !response.body) return undefined;
    const files = await untar(response.body, path => /\.(?:m?js|json)$/.test(path));
    await lexerReady;
    const served = servedModules(files, env.runtimeBase);
    let packageJson: Record<string, any> = {};
    try {
        packageJson = JSON.parse(files.get('package.json') ?? '{}');
    } catch {
        // Then only the paths of its files import the package.
    }
    return {name, files: served, specifiers: packageSpecifiers(name, packageJson, new Set(served.keys()))};
}

const fetched = new Map<string, Promise<ScriptPackage | undefined>>();

/**
 * A package for script runs, fetched once for each version. A package that cannot be fetched gives
 * undefined, and the script then loads it from the CDN as before.
 */
export function scriptPackage(env: Env, name: string, wanted: string): Promise<ScriptPackage | undefined> {
    // The served modules name the shims by the URL of the app.
    const key = `${env.runtimeBase} ${name}@${wanted}`;
    let found = fetched.get(key);
    if (!found) {
        found = fetchPackage(env, name, wanted).catch(() => undefined);
        fetched.set(key, found);
        // A failed fetch is tried again by the next run.
        void found.then(result => result || fetched.delete(key));
    }
    return found;
}
