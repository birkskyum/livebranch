#!/usr/bin/env node
// Posts the pictures that actions/shots took as a comment on the pull request, and keeps that one
// comment up to date. The pictures go to livebranch.dev, which the run's OIDC token lets it store
// for this run alone. After a fork's pull request, the run that took the pictures may have run code
// of the fork, so only the pictures, checked to be PNGs, and the lines the pages logged come from
// it. The link and the comment are made here, from the pull request as GitHub's API gives it, and
// that pull request has to have the commit that the pictures were taken of.
//
// usage: node actions/comment/comment.ts [--dir livebranch-shots] [--site https://livebranch.dev/]
// needs: GITHUB_TOKEN that may write to pull requests, and the id-token: write permission
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {MARKER, comment, linkOf, type Pull, type Summary} from '../shots/pull-request.ts';

const AUDIENCE = 'https://livebranch.dev';
const MAX_PICTURE_BYTES = 2_000_000;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const {values} = parseArgs({options: {
    dir: {type: 'string', default: 'livebranch-shots'},
    site: {type: 'string', default: 'https://livebranch.dev/'},
}});
const {GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run, GITHUB_EVENT_PATH: eventPath} = process.env;
if (!token || !repository || !run || !eventPath) throw new Error('Run this in GitHub Actions, with GITHUB_TOKEN.');
const event = JSON.parse(await readFile(eventPath, 'utf8'));

async function github<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json'},
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}: ${await response.text()}`);
    return response.json() as Promise<T>;
}

/** The pull request of the event, or of the run that took the pictures, whose head it built. */
async function pullRequest(): Promise<Pull | undefined> {
    if (event.pull_request) return github<Pull>(`/repos/${repository}/pulls/${event.pull_request.number}`);
    const built = event.workflow_run;
    if (!built) throw new Error('Run this on pull_request, or on workflow_run after the workflow that takes the pictures.');
    // GitHub names no pull request in the run of a fork's, so it is found by the fork's branch.
    const head = `${built.head_repository.owner.login}:${built.head_branch}`;
    const open = await github<Pull[]>(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(head)}`);
    return open.find(pull => pull.head.sha === built.head_sha);
}

/** What the run that took the pictures found, kept to its shape and to a sane length. */
function checked(found: unknown, head: string): Summary {
    const text = (value: unknown, length: number) => String(value ?? '').slice(0, length);
    const lines = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, 50).map(line => text(line, 300));
    const summary = (found ?? {}) as Record<string, unknown>;
    const sides = (Array.isArray(summary.sides) ? summary.sides : []).filter(side => side?.name === 'base' || side?.name === 'head');
    return {
        head,
        failure: text(summary.failure, 500),
        sides: sides.map(side => ({
            name: side.name,
            commit: /^[0-9a-f]{40}$/.test(side.commit) ? side.commit : '',
            picture: false,
            errors: lines(side.errors),
            problems: lines(side.problems),
        })),
    };
}

/** The OIDC token of this run, which tells livebranch.dev its repository and its run. */
async function idToken(): Promise<string> {
    const {ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer} = process.env;
    if (!url || !bearer) throw new Error('The job needs the id-token: write permission.');
    const response = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {headers: {authorization: `Bearer ${bearer}`}});
    if (!response.ok) throw new Error(`GitHub gave no OIDC token: ${response.status}`);
    return ((await response.json()) as {value: string}).value;
}

/** Stores the pictures that are PNGs, and gives their addresses. */
async function store(summary: Summary): Promise<Partial<Record<'base' | 'head', string>>> {
    const stored: Partial<Record<'base' | 'head', string>> = {};
    const oidc = await idToken();
    for (const side of summary.sides) {
        const bytes = await readFile(join(values.dir, `${side.name}.png`)).catch(() => undefined);
        if (!bytes || bytes.byteLength > MAX_PICTURE_BYTES || !PNG.every((byte, index) => bytes[index] === byte)) continue;
        const response = await fetch(`${values.site}api/pictures/${repository}/${run}/${side.name}.png`, {
            method: 'PUT',
            headers: {authorization: `Bearer ${oidc}`, 'content-type': 'image/png'},
            body: new Uint8Array(bytes),
        });
        if (!response.ok) throw new Error(`livebranch.dev did not store ${side.name}.png: ${response.status} ${await response.text()}`);
        stored[side.name] = ((await response.json()) as {url: string}).url;
        side.picture = true;
    }
    return stored;
}

const pull = await pullRequest();
if (!pull) {
    console.log('No open pull request has the commit that the pictures were taken of. A newer push takes its own.');
    process.exit(0);
}
const summary = checked(JSON.parse(await readFile(join(values.dir, 'summary.json'), 'utf8')), pull.head.sha);
const body = comment(pull, await linkOf(pull, values.site), summary, await store(summary));

// One comment, which each run brings up to date.
type Comment = {id: number; body: string; user: {type: string}};
let mine: Comment | undefined;
for (let page = 1; !mine; page++) {
    const comments = await github<Comment[]>(`/repos/${repository}/issues/${pull.number}/comments?per_page=100&page=${page}`);
    mine = comments.find(found => found.user.type === 'Bot' && found.body.startsWith(MARKER));
    if (comments.length < 100) break;
}
if (mine) await github(`/repos/${repository}/issues/comments/${mine.id}`, {method: 'PATCH', body: JSON.stringify({body})});
else await github(`/repos/${repository}/issues/${pull.number}/comments`, {method: 'POST', body: JSON.stringify({body})});
console.log(`${mine ? 'Updated' : 'Posted'} the pictures on #${pull.number}.`);
