import {transformHtml} from './html.ts';
import {extname} from './path.ts';
import type {Env, Progress, Project} from './project.ts';
import {parseJsonc} from './project.ts';
import {isSourcePath, resolveSpecifier, scanImports, type ResolveContext} from './resolve.ts';
import {assetModuleCode, assetModulePath, lexerReady, rewriteModule, type AssetModule} from './rewrite.ts';
import {tsc, type Diagnostic, type TscOptions} from './tsc.ts';
import type {FileData} from './vfs.ts';

export interface Output {
    body: FileData;
    type: string;
}

export interface Problem {
    file: string | undefined;
    line: number | undefined;
    column: number | undefined;
    code: number;
    category: 'error' | 'warning' | 'message';
    text: string;
}

export interface Compiled {
    /** Compiled modules and their asset modules, by the path they are served at. */
    modules: Map<string, string>;
    problems: Problem[];
    /** Source files that went into the program. */
    sources: number;
}

export interface BuildResult {
    /** Every file of the preview, by the path it is served at. */
    outputs: Map<string, Output>;
    problems: Problem[];
    entry: string;
    sources: number;
}

const OUT = '/.livebranch/out';
/** TS2318, which `noLib` gives for each global type. */
const MISSING_GLOBAL_TYPE = 2318;
const TSCONFIG = '/.livebranch/tsconfig.json';

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.geojson': 'application/geo+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.pbf': 'application/x-protobuf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.glsl': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
};

export function contentType(path: string): string {
    return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function resolveContext(project: Project, env: Env, keep?: Set<string>): ResolveContext {
    return {
        vfs: project.vfs,
        alias: project.alias,
        version: name => project.versions[name],
        cdn: project.config.cdn ?? 'esm.sh',
        runtimeBase: env.runtimeBase,
        keep,
    };
}

/** Loads every file that the entries reach through imports, wave by wave, and returns the source files among them. */
export async function loadClosure(project: Project, entries: string[], ctx: ResolveContext, withTypes = false): Promise<Set<string>> {
    const {vfs} = project;
    const seen = new Set<string>(entries);
    let wave = entries;
    while (wave.length) {
        await vfs.load(wave);
        const next: string[] = [];
        for (const file of wave) {
            const code = isSourcePath(file) ? vfs.readText(file) : undefined;
            if (code === undefined) continue;
            const {imports, urls} = scanImports(code, withTypes);
            for (const specifier of [...imports, ...urls]) {
                const resolved = resolveSpecifier(specifier, file, ctx);
                if (resolved.kind !== 'file' || seen.has(resolved.path)) continue;
                seen.add(resolved.path);
                next.push(resolved.path);
            }
        }
        wave = next;
    }
    return seen;
}

function tsconfig(project: Project, files: string[]): string {
    const base = project.vfs.readText('/tsconfig.json');
    let jsx: unknown;
    try {
        jsx = base === undefined ? undefined : parseJsonc(base).compilerOptions?.jsx;
    } catch {
        // tsc reports a tsconfig that does not parse.
    }
    const compilerOptions: Record<string, unknown> = {
        module: 'esnext',
        moduleResolution: 'bundler',
        noEmit: false,
        emitDeclarationOnly: false,
        declaration: false,
        declarationMap: false,
        isolatedDeclarations: false,
        composite: false,
        incremental: false,
        noEmitOnError: false,
        noCheck: true,
        allowJs: true,
        checkJs: false,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        sourceMap: false,
        inlineSourceMap: true,
        inlineSources: true,
        // The compiled module is served at the path of its source. The source in the map gets a
        // URL of its own, or the devtools would take the two files for one.
        sourceRoot: 'livebranch:///',
        outDir: OUT,
        rootDir: '/',
        types: [],
        // Without type checking the default libs are only startup time.
        noLib: true,
        lib: null,
    };
    if (base === undefined) Object.assign(compilerOptions, {target: 'es2022', strict: true, jsx: 'react-jsx'});
    else if (jsx === 'preserve' || jsx === 'react-native') compilerOptions.jsx = 'react-jsx';
    return JSON.stringify({
        ...(base === undefined ? {} : {extends: '../tsconfig.json'}),
        compilerOptions,
        include: [],
        exclude: [],
        files,
    });
}

const CATEGORIES = ['warning', 'error', 'message', 'message'] as const;

export function problem(diagnostic: Diagnostic): Problem {
    const file = diagnostic.fileName === TSCONFIG ? '/tsconfig.json' : diagnostic.fileName;
    return {
        file,
        line: diagnostic.startPosition ? diagnostic.startPosition.line + 1 : undefined,
        column: diagnostic.startPosition ? diagnostic.startPosition.character + 1 : undefined,
        code: diagnostic.code,
        category: CATEGORIES[diagnostic.category],
        text: diagnostic.text,
    };
}

/** The source file that the compiler wrote `emitted` for. */
function sourceOf(emitted: string, read: Set<string>): string | undefined {
    const path = emitted.slice(OUT.length);
    const ext = extname(path);
    const stem = path.slice(0, -ext.length);
    const candidates: Record<string, string[]> = {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.jsx': ['.tsx', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
    };
    for (const candidate of candidates[ext] ?? []) if (read.has(stem + candidate)) return stem + candidate;
    return undefined;
}

/** The specifier as the source has it. The compiler turns a `.ts` ending into `.js`. */
function asWritten(specifier: string, source: string): string {
    const match = /^(.*)\.([cm]?)js(x?)$/.exec(specifier);
    if (!match || source.includes(specifier)) return specifier;
    const typed = `${match[1]}.${match[2]}ts${match[3]}`;
    return source.includes(typed) ? typed : specifier;
}

/**
 * Compiles the entries and everything they import with tsc-rs, without type checking, and makes
 * the output loadable as native modules. A compiled module is served at the path of its source.
 */
export async function compile(project: Project, env: Env, entries: string[], progress: Progress = () => {}, keep?: Set<string>): Promise<Compiled> {
    const {vfs} = project;
    const ctx = resolveContext(project, env, keep);
    const [module] = await Promise.all([env.wasm(), lexerReady]);
    const missingEntries = entries.filter(path => !vfs.isFile(path));
    const problems: Problem[] = [];
    const modules = new Map<string, string>();
    const assets = new Map<string, AssetModule>();
    let roots = entries;
    let sources = 0;

    // The program is the entries and what they import at run time, as the scan of the sources finds
    // it. Files outside of it do not exist for the compiler, so a type-only import costs nothing.
    // When the output imports a file that the scan missed, the file joins the roots and the
    // compiler runs again.
    for (let round = 0; round < 4; round++) {
        progress('fetch', 'sources');
        const closure = await loadClosure(project, roots, ctx);
        const files = [...closure].filter(path => isSourcePath(path) && vfs.isFile(path));
        progress('compile', `${files.length} modules`);
        const options: TscOptions = {
            extra: new Map([[TSCONFIG, tsconfig(project, files)]]),
            json: true,
            visible: path => !isSourcePath(path) || closure.has(path),
        };
        let run = await tsc(module, vfs, ['-p', TSCONFIG], options);
        for (let fetched = 0; run.misses.size && fetched < 8; fetched++) {
            await vfs.load(run.misses);
            run = await tsc(module, vfs, ['-p', TSCONFIG], options);
        }

        problems.length = 0;
        modules.clear();
        assets.clear();
        problems.push(...run.diagnostics.filter(diagnostic => diagnostic.code !== MISSING_GLOBAL_TYPE).map(problem));
        const imported = new Set<string>();
        for (const [emitted, code] of run.written) {
            const source = emitted.startsWith(`${OUT}/`) ? sourceOf(emitted, run.read) : undefined;
            if (!source) continue;
            const rewritten = rewriteModule(code, source, ctx);
            modules.set(source, rewritten.code);
            for (const asset of rewritten.assets) assets.set(assetModulePath(asset), asset);
            for (const path of rewritten.sources) imported.add(path);
            for (const specifier of rewritten.missing) {
                const written = asWritten(specifier, vfs.readText(source) ?? '');
                problems.push({file: source, line: undefined, column: undefined, code: 2307, category: 'error', text: `Cannot find module '${written}'.`});
            }
        }
        sources = modules.size;
        const unseen = [...imported].filter(path => !modules.has(path));
        if (!unseen.length) break;
        roots = [...roots, ...unseen];
    }

    for (const path of missingEntries) {
        problems.push({file: path, line: undefined, column: undefined, code: 0, category: 'error', text: `Entry file not found: ${path}`});
    }
    await vfs.load([...assets.values()].map(asset => asset.path));
    for (const [path, asset] of assets) modules.set(path, assetModuleCode(asset, vfs.readText(asset.path) ?? ''));
    return {modules, problems, sources};
}

export function pageEntries(project: Project, env: Env, html: string) {
    const page = transformHtml(html, project.entry, `${env.runtimeBase}rt/preview.js`);
    const extra = (project.config.entries ?? []).map(path => `/${path.replace(/^\.?\//, '')}`);
    return {page, entries: [...page.entries, ...extra]};
}

/** Moves a problem of an inline script to its place in the page. */
export function inPage(found: Problem, inlineLines: Map<string, number>): Problem {
    const inline = found.file ? /^(.*\.html)\.\d+\.ts$/.exec(found.file) : null;
    if (!inline) return found;
    const offset = inlineLines.get(found.file!) ?? 0;
    return {...found, file: inline[1], line: found.line === undefined ? undefined : found.line + offset};
}

/**
 * Fetches the sources that the build of the page will need. It runs next to the setup commands, so
 * that the build finds the files loaded.
 */
export async function warmUp(project: Project, env: Env): Promise<void> {
    const {vfs, entry} = project;
    await vfs.load([entry]);
    const html = vfs.readText(entry);
    if (html === undefined) return;
    const {page, entries} = pageEntries(project, env, html);
    const ctx = resolveContext(project, env, new Set(page.importMap));
    const seeds = entries.filter(path => !page.inline.has(path));
    for (const [path, code] of page.inline) {
        for (const specifier of scanImports(code).imports) {
            const resolved = resolveSpecifier(specifier, path, ctx);
            if (resolved.kind === 'file') seeds.push(resolved.path);
        }
    }
    await loadClosure(project, seeds, ctx);
}

/** Builds the preview of the project's page: the page, its compiled modules and the project's other loaded files. */
export async function build(project: Project, env: Env, progress: Progress = () => {}): Promise<BuildResult> {
    const {vfs, entry} = project;
    await vfs.load([entry]);
    const html = vfs.readText(entry);
    if (html === undefined) throw new Error(`Page not found: ${entry}`);
    const {page, entries} = pageEntries(project, env, html);
    for (const [path, code] of page.inline) vfs.write(path, code);

    const compiled = await compile(project, env, entries, progress, new Set(page.importMap));
    for (const path of page.inline.keys()) vfs.remove(path);

    const outputs = new Map<string, Output>();
    for (const [path, data] of vfs.files) {
        if (path === '/package-lock.json' || path.startsWith('/.livebranch/')) continue;
        outputs.set(path, {body: data, type: contentType(path)});
    }
    for (const [path, code] of compiled.modules) outputs.set(path, {body: code, type: TYPES['.js']});
    outputs.set(entry, {body: page.html, type: TYPES['.html']});

    return {outputs, problems: compiled.problems.map(found => inPage(found, page.inlineLines)), entry, sources: compiled.sources};
}
