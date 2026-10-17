#!/usr/bin/env node
// Takes a picture of each side of a pull request on livebranch.dev: the base and the head, at the
// commits of the event, running the demo of its description. A gesture that a livebranch link in the
// description recorded plays on both first. It writes base.png, head.png and summary.json for the
// step that posts them (actions/comment), and comment.md to look at, with the pictures as files.
// It runs no code of the pull request outside the browser, and needs no token.
//
// usage: node actions/shots/shots.ts [--event file] [--out dir] [--site url] [--channel chrome]
//   --event    a pull_request event of GitHub Actions, $GITHUB_EVENT_PATH by default
//   --out      where the pictures go, livebranch-shots by default
//   --site     https://livebranch.dev/ by default
//   --channel  a browser that is installed, such as chrome, instead of Playwright's Chromium
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {chromium, type Page} from 'playwright';
import {comment, linkOf, type Pull, type Summary} from './pull-request.ts';

const {values} = parseArgs({options: {
    event: {type: 'string', default: process.env.GITHUB_EVENT_PATH},
    out: {type: 'string', default: 'livebranch-shots'},
    site: {type: 'string', default: 'https://livebranch.dev/'},
    channel: {type: 'string'},
}});
if (!values.event) throw new Error('No pull_request event. Pass --event or run in GitHub Actions.');
const pull: Pull | undefined = JSON.parse(await readFile(values.event, 'utf8')).pull_request;
if (!pull) throw new Error(`${values.event} is not a pull_request event.`);

const found = await linkOf(pull, values.site);
await mkdir(values.out, {recursive: true});
const summary: Summary = {head: pull.head.sha, failure: '', sides: []};

// Headless Chromium draws WebGL in software, which it only allows when asked.
const browser = await chromium.launch({channel: values.channel, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist']});
const page = await browser.newPage({viewport: {width: 1280, height: 720}});
try {
    // Only the previews show, so that they are as large as the window lets them be.
    await page.goto(found.link.replace('#', '#view=result&'));
    await page.waitForFunction(() => ['ready', 'failed'].includes(document.documentElement.dataset.livebranch ?? ''), undefined, {timeout: 300_000});
    summary.failure = await page.evaluate(() => window.__livebranch.state.error);
    if (!summary.failure) {
        await page.waitForFunction(() => window.__livebranch.state.base || window.__livebranch.state.baseError, undefined, {timeout: 300_000});
        await page.waitForFunction(() => !window.__livebranch.state.checking, undefined, {timeout: 120_000}).catch(() => {});
        await settle(page);
        if (found.gesture) await play(page);
        summary.sides = await pictures(page, values.out);
    }
} catch (error) {
    summary.failure = error instanceof Error ? error.message.split('\n')[0] : String(error);
} finally {
    await browser.close();
}

await writeFile(join(values.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(values.out, 'comment.md'), comment(pull, found, summary, {base: 'base.png', head: 'head.png'}));
console.log(summary.failure ? `livebranch could not open the pull request. ${summary.failure}` : `Wrote the pictures to ${values.out}.`);

/** Waits for the pages to fetch what they draw, such as the tiles of a map. */
async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', {timeout: 15_000}).catch(() => {});
    await page.waitForTimeout(2000);
}

/** Plays the recorded gesture on every page, from a fresh start of them. */
async function play(page: Page): Promise<void> {
    await page.waitForFunction(() => window.__livebranch.state.gesture, undefined, {timeout: 10_000});
    await page.getByRole('button', {name: 'Play'}).click();
    await page.waitForFunction(() => window.__livebranch.state.playing === 'on', undefined, {timeout: 120_000});
    await page.waitForFunction(() => window.__livebranch.state.playing === false, undefined, {timeout: 300_000});
    await settle(page);
}

/** Takes a picture of each page, and keeps what each logged. The base stands left of the head. */
async function pictures(page: Page, out: string): Promise<Summary['sides']> {
    const found = await page.evaluate(() => {
        const {state} = window.__livebranch;
        const errors = (entries: typeof state.console) => entries.filter(entry => entry.level === 'error').map(entry => entry.text.split('\n')[0]);
        return {
            base: {commit: state.base?.commit ?? '', errors: state.baseError ? [state.baseError] : errors(state.baseConsole)},
            head: {commit: state.session?.commit ?? '', errors: errors(state.console), problems: [...state.session?.problems ?? [], ...state.typeProblems].map(problem => problem.text.split('\n')[0])},
        };
    });
    // The hidden frames of the sandboxes, where the previews' hosts are set up, are not previews.
    const frames = page.locator('iframe[title^="Preview"]');
    const comparing = Boolean(found.base.commit) && await frames.count() > 1;
    if (comparing) await frames.nth(0).screenshot({path: join(out, 'base.png')});
    await frames.nth(comparing ? 1 : 0).screenshot({path: join(out, 'head.png')});
    return [
        {name: 'base', commit: found.base.commit, picture: comparing, errors: found.base.errors, problems: []},
        {name: 'head', commit: found.head.commit, picture: true, errors: found.head.errors, problems: found.head.problems},
    ];
}
