// A pull request's description can carry the demo that shows what it changes, as fenced code blocks
// whose info string says `livebranch` after the language:
//
//     ```ts livebranch
//     import * as maplibregl from 'maplibre-gl';
//     ```
//
// GitHub highlights such a block by the first word and shows nothing of the rest. A further word
// names the file (`ts livebranch helper.ts`). Without one the language does: a page is
// `index.html` and a script is `demo.ts`.
import type {Fetch} from './github.ts';

const MARK = 'livebranch';
const DEFAULT_NAMES: Record<string, string> = {html: 'index.html', ts: 'demo.ts', typescript: 'demo.ts', tsx: 'demo.tsx', js: 'demo.js', javascript: 'demo.js', jsx: 'demo.jsx', css: 'style.css'};
const LANGUAGES: Record<string, string> = {html: 'html', ts: 'ts', mts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', jsx: 'jsx', css: 'css', json: 'json'};

/** The files in the marked code blocks of a Markdown text, by their path. Of two blocks for one file the later counts. */
export function demoFiles(markdown: string): Record<string, string> {
    const files: Record<string, string> = {};
    const lines = markdown.split(/\r?\n/);
    for (let at = 0; at < lines.length; at++) {
        const open = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/.exec(lines[at]);
        if (!open) continue;
        const [, indent, fence, info] = open;
        const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
        const body: string[] = [];
        for (at++; at < lines.length && !close.test(lines[at]); at++) {
            body.push(lines[at].replace(new RegExp(`^ {0,${indent.length}}`), ''));
        }
        const [language = '', ...rest] = info.trim().split(/\s+/);
        if (language !== MARK && !rest.includes(MARK)) continue;
        const path = (rest.find(word => word !== MARK) ?? DEFAULT_NAMES[language === MARK ? 'ts' : language.toLowerCase()])?.replace(/^(?:\.?\/)+/, '');
        if (path) files[path] = `${body.join('\n')}\n`;
    }
    return files;
}

/** Files as marked code blocks, to paste into a description. `demoFiles` reads them back. */
export function demoBlocks(files: Record<string, string>): string {
    return Object.entries(files).map(([path, text]) => {
        const language = LANGUAGES[path.slice(path.lastIndexOf('.') + 1)] ?? 'text';
        // A fence has to be longer than every run of backticks in what it holds.
        const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
        const fence = '`'.repeat(longest + 1);
        const name = DEFAULT_NAMES[language] === path ? '' : ` ${path}`;
        return `${fence}${language} ${MARK}${name}\n${text.replace(/\n?$/, '\n')}${fence}\n`;
    }).join('\n');
}

export interface PullRequest {
    title: string;
    /** The branch that the pull request goes into. */
    base: string;
    /** The default branch of the repository that it goes into. */
    defaultBranch: string;
    /** The demo in its description. Empty when the description has none. */
    files: Record<string, string>;
}

/** Reads a pull request from GitHub's API, which is the only place that has its description. */
export async function fetchPullRequest(fetch: Fetch, owner: string, repo: string, number: number): Promise<PullRequest> {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`);
    if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status} for pull request ${number} of ${owner}/${repo}.`), {status: response.status});
    const pull = await response.json();
    return {title: pull.title ?? '', base: pull.base?.ref ?? '', defaultBranch: pull.base?.repo?.default_branch ?? '', files: demoFiles(pull.body ?? '')};
}
