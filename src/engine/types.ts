import {crashProblems, entryPage, inPage, loadClosure, pageEntries, problem, resolveContext, type Problem} from './build.ts';
import {tarballUrl, untar} from './npm.ts';
import type {Env, Project} from './project.ts';
import {parseJsonc} from './project.ts';
import {isSourcePath} from './resolve.ts';
import {tsc} from './tsc.ts';

const TSCONFIG = '/.livebranch/tsconfig.check.json';
const DECLARATION = /(?:\.d\.[cm]?ts|(?:^|\/)package\.json)$/;
/** Cannot find module, and no declaration file for module: the answer when a package's types are not installed. */
const MISSING_MODULE = new Set([2307, 7016, 2792]);

interface Package {
    name: string;
    url: string;
}

/** The npm packages whose declarations a type check of the project needs, with their tarballs. */
function typePackages(project: Project): Package[] {
    const {vfs, packageJson} = project;
    const lockText = vfs.readText('/package-lock.json');
    let wantedTypes: string[] = [];
    try {
        wantedTypes = parseJsonc(vfs.readText('/tsconfig.json') ?? '{}').compilerOptions?.types ?? [];
    } catch {
        // tsc reports a tsconfig that does not parse.
    }
    const packages: Package[] = [];
    if (lockText) {
        const entries = Object.entries<any>(JSON.parse(lockText).packages ?? {})
            .filter(([key]) => key.startsWith('node_modules/') && !key.slice(13).includes('node_modules/'))
            .map(([key, entry]) => ({name: key.slice(13), entry}));
        const production = new Set(entries.filter(({entry}) => !entry.dev).map(({name}) => name));
        for (const {name, entry} of entries) {
            const typed = name.startsWith('@types/') ? name.slice(7).replace('__', '/') : undefined;
            const wanted = production.has(name) || (typed !== undefined && (production.has(typed) || production.has(`@${typed}`) || wantedTypes.includes(typed)));
            if (wanted && entry.version) packages.push({name, url: entry.resolved ?? tarballUrl(name, entry.version)});
        }
        return packages;
    }
    for (const [name, version] of Object.entries<string>(packageJson.dependencies ?? {})) {
        if (/^\d/.test(version)) packages.push({name, url: tarballUrl(name, version)});
    }
    return packages;
}

/** Writes the declaration files of the project's npm dependencies under `/node_modules`. */
export async function installTypes(project: Project, env: Env): Promise<number> {
    const {vfs} = project;
    await vfs.load(['/package-lock.json', '/tsconfig.json']);
    const packages = typePackages(project).filter(({name}) => !vfs.isDirectory(`/node_modules/${name}`));
    await Promise.all(packages.map(async ({name, url}) => {
        try {
            const response = await env.fetch(url);
            if (!response.ok || !response.body) return;
            const files = await untar(response.body, path => DECLARATION.test(path));
            for (const [path, text] of files) vfs.write(`/node_modules/${name}/${path}`, text);
        } catch {
            // The check then reports the package's imports as untyped, which is filtered out below.
        }
    }));
    return packages.length;
}

function tsconfig(project: Project, files: string[]): string {
    const hasBase = project.vfs.isFile('/tsconfig.json');
    const paths: Record<string, string[]> = {};
    for (const [key, target] of Object.entries(project.alias)) {
        if (/^https?:/.test(target)) continue;
        const path = `/${target.replace(/^\.?\//, '')}`;
        paths[key] = [path];
        if (project.vfs.isDirectory(path)) paths[`${key}/*`] = [`${path}/*`];
    }
    return JSON.stringify({
        ...(hasBase ? {extends: '../tsconfig.json'} : {}),
        compilerOptions: {
            ...(hasBase ? {} : {target: 'es2022', strict: true, jsx: 'react-jsx', lib: ['esnext', 'dom', 'dom.iterable']}),
            module: 'esnext',
            moduleResolution: 'bundler',
            moduleDetection: 'force',
            noEmit: true,
            declaration: false,
            isolatedDeclarations: false,
            composite: false,
            incremental: false,
            skipLibCheck: true,
            allowJs: true,
            checkJs: false,
            resolveJsonModule: true,
            allowImportingTsExtensions: true,
            paths,
        },
        include: [],
        exclude: [],
        files,
    });
}

/**
 * Type checks the page's scripts against the project and the declarations of its npm
 * dependencies. Only problems in `own` files are reported: the page and the files of the link. The
 * rest of the project is the business of its own CI.
 */
export async function typeCheck(project: Project, env: Env, own: Set<string>): Promise<Problem[]> {
    const {vfs} = project;
    const found = await entryPage(project);
    if (!found) return [];
    const {page, entries} = pageEntries(project, env, found);
    const roots = [...new Set([...entries, ...[...own].filter(isSourcePath)])].filter(path => page.inline.has(path) || vfs.isFile(path));
    if (!roots.length) return [];

    const [module] = await Promise.all([env.wasm(), installTypes(project, env)]);
    for (const [path, code] of page.inline) vfs.write(path, code);
    try {
        await loadClosure(project, roots, resolveContext(project, env), true, env.sourceBudget);
        const options = {extra: new Map([[TSCONFIG, tsconfig(project, roots)]]), json: true, budget: env.sourceBudget};
        let run = await tsc(module, vfs, ['-p', TSCONFIG], options);
        for (let round = 0; run.misses.size && round < 8; round++) {
            await vfs.load(run.misses);
            run = await tsc(module, vfs, ['-p', TSCONFIG], options);
        }
        const reported = (file: string | undefined) => file !== undefined && (own.has(file) || page.inline.has(file));
        const found = run.diagnostics
            .filter(diagnostic => reported(diagnostic.fileName) && !(MISSING_MODULE.has(diagnostic.code) && !/'\.{0,2}\//.test(diagnostic.text)))
            .map(diagnostic => inPage(problem(diagnostic), page.inlineLines));
        return [...crashProblems(run, 'the types are not checked'), ...found];
    } finally {
        for (const path of page.inline.keys()) vfs.remove(path);
    }
}
