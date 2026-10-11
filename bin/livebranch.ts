#!/usr/bin/env node
// The command line of livebranch, for people and agents. It makes share links and checks a project
// with the same compiler and pipeline as the browser, without one.
import {readFile, readdir} from 'node:fs/promises';
import {basename, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import type {Problem} from '../src/engine/build.ts';
import {checkProject} from '../src/engine/check.ts';
import {nodeEnv} from '../src/engine/node-env.ts';
import {openProject, type LocalSource} from '../src/engine/project.ts';
import {resolveSource} from '../src/engine/sources/github.ts';
import {encodeSpec, normalizeGithubSource, parseGithubRef, type LinkSpec} from '../src/engine/spec.ts';
import {isBinaryPath} from '../src/engine/vfs.ts';

const USAGE = `usage:
  livebranch link  [--gh owner/repo@ref] [--gist id] [--entry page] [--preset name] [--result] [--follow] [--base url] [file ...]
  livebranch check [--gh owner/repo@ref | --dir path] [--gist id] [--entry page] [--preset name] [--json] [file ...]

A file is a path, or name=path to give it another name in the project. Files are laid over the
GitHub source, the gist or the directory.

--gh takes owner/repo@branch, owner/repo@pull/123, or a github.com URL of a branch, a commit, a
pull request or a file.

link   prints the link that opens the project. A branch, tag or pull request is pinned to its commit.
       With --follow the link keeps the name and so always shows the latest push.
check  compiles and type checks the project under Node and prints the problems. Setup commands of
       the project do not run under Node, so check a project that has them from a directory
       where they have run (--dir), or open the link in a browser.

LIVEBRANCH_BASE sets the default for --base.`;

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        gh: {type: 'string'},
        gist: {type: 'string'},
        dir: {type: 'string'},
        entry: {type: 'string'},
        preset: {type: 'string'},
        base: {type: 'string', default: process.env.LIVEBRANCH_BASE ?? 'http://localhost:5173/'},
        result: {type: 'boolean', default: false},
        follow: {type: 'boolean', default: false},
        json: {type: 'boolean', default: false},
        help: {type: 'boolean', short: 'h', default: false},
    },
});
const [command, ...fileArgs] = positionals;

async function overlay(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const arg of fileArgs) {
        const split = arg.indexOf('=');
        const path = split < 0 ? arg : arg.slice(split + 1);
        files[split < 0 ? basename(arg) : arg.slice(0, split)] = await readFile(path, 'utf8');
    }
    return files;
}

async function spec(): Promise<LinkSpec> {
    const source = values.gh ? normalizeGithubSource(values.gh) : undefined;
    return {gh: source?.gh, gist: values.gist, entry: values.entry ?? source?.entry, preset: values.preset, files: await overlay()};
}

function directorySource(dir: string): LocalSource {
    const root = resolve(dir);
    const walk = async (at: string, out: string[]): Promise<string[]> => {
        for (const entry of await readdir(at, {withFileTypes: true})) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const path = join(at, entry.name);
            if (entry.isDirectory()) await walk(path, out);
            else if (entry.isFile()) out.push(relative(root, path));
        }
        return out;
    };
    const fetch = async (path: string) => isBinaryPath(path) ? new Uint8Array(await readFile(join(root, path))) : readFile(join(root, path), 'utf8');
    return {
        label: root,
        source: {list: () => walk(root, []), fetch, probe: path => fetch(path).catch(() => undefined), url: path => `file://${join(root, path)}`},
    };
}

function print(problem: Problem): string {
    const place = problem.file ? `${problem.file.slice(1)}${problem.line ? `:${problem.line}:${problem.column ?? 1}` : ''} - ` : '';
    return `${place}${problem.category}${problem.code ? ` TS${problem.code}` : ''}: ${problem.text}`;
}

if (values.help || !command) {
    console.log(USAGE);
} else if (command === 'link') {
    const wanted = await spec();
    if (wanted.gh && !values.follow) {
        const {source, commit, entry} = await resolveSource((url, init) => fetch(url, init), parseGithubRef(wanted.gh), wanted.entry);
        wanted.gh = `${source.owner}/${source.repo}@${commit}${source.subdir ? `:${source.subdir}` : ''}`;
        wanted.entry = entry;
    }
    const base = values.base.endsWith('/') ? values.base : `${values.base}/`;
    console.log(`${base}#${values.result ? 'view=result&' : ''}${await encodeSpec(wanted)}`);
} else if (command === 'check') {
    const env = nodeEnv();
    const project = await openProject(await spec(), env, undefined, values.dir ? directorySource(values.dir) : undefined);
    const result = await checkProject(project, env, values.dir !== undefined);
    const errors = result.problems.filter(problem => problem.category === 'error').length;
    if (values.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        for (const problem of result.problems) console.log(print(problem));
        if (result.skippedSetup.length) console.log(`note: ${result.skippedSetup.length} setup commands did not run, so only the page and the given files are reported.`);
        console.log(`${result.source}: ${result.modules} modules, ${errors} ${errors === 1 ? 'error' : 'errors'}`);
    }
    process.exitCode = errors ? 1 : 0;
} else {
    console.error(USAGE);
    process.exitCode = 2;
}
