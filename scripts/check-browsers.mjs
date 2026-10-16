// Opens a small page and a maplibre-gl-js pull request on a livebranch site in Firefox, WebKit and
// Chromium, and fails when one of them does not come up clean. The pull request is also opened by
// its GitHub address, which compares it with the default branch, and the comparison is stopped.
// Before that, what each side logs has to show in the console of that side, which is under it.
// Each ref has to be named once there: on its own side in a comparison, in the header without one.
// A commit that is opened by its hash has to say which branch it is the head of. Its build is then
// reused for the branch, which has to keep its own name.
// The last page stands in for GitHub's answer about the pull request, to give its description a demo.
// The small page is edited after its type check, and has to build again with the edit.
//
// usage: node scripts/check-browsers.mjs [site] [browser ...]
//   site     the site to check, https://livebranch.dev/ by default
//   browser  firefox, webkit or chromium. All three by default.
// needs: pnpm exec playwright install firefox webkit chromium
import * as engines from 'playwright';

const args = process.argv.slice(2);
const site = args.find(arg => /^https?:/.test(arg)) ?? 'https://livebranch.dev/';
const wanted = args.filter(arg => !/^https?:/.test(arg));
const names = wanted.length ? wanted : ['firefox', 'webkit', 'chromium'];

const files = {
    'index.html': '<h1 id="out"></h1>\n<script type="module">\nimport {area} from "./shape.ts";\nimport earcut from "earcut";\nconst n: number = area(3);\ndocument.querySelector("#out")!.textContent = `area ${n}, ${earcut([0, 0, 10, 0, 10, 10, 0, 10]).length / 3} triangles`;\n</script>',
    'shape.ts': 'export function area(side: number): number { return side ** 2; }\n',
};
const small = await (await fetch(`${site}api/link`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({files})})).json();
const {commit: head} = await (await fetch(`${site}api/github/resolve?repo=maplibre/maplibre-gl-js&ref=main`)).json();
if (!head) throw new Error('The site did not say where main of maplibre-gl-js is.');
const described = '```ts livebranch\nimport {Map} from "maplibre-gl";\ndocument.body.dataset.described = typeof Map;\n```\n';
const pages = {
    // A local Worker names the live site in its links, so only the link's parameters are taken.
    'small page': {
        url: `${site}${new URL(small.url).hash}`,
        ok: found => found.out === 'area 9, 2 triangles' && found.edited === 'area 12, 2 triangles',
        async after(page) {
            await page.evaluate(() => window.__livebranch.edit('/shape.ts', 'export function area(side: number): number { return side * 4; }\n'));
            // The page of the new build, or what went wrong.
            await page.waitForFunction(() => window.__livebranch.state.error || document.querySelector('iframe')?.contentDocument?.querySelector('#out')?.textContent === 'area 12, 2 triangles', undefined, {timeout: 30000}).catch(() => {});
            return {edited: await page.evaluate(() => window.__livebranch.state.error || document.querySelector('iframe')?.contentDocument?.querySelector('#out')?.textContent)};
        },
    },
    'maplibre pull request': {url: `${site}#gh=maplibre/maplibre-gl-js@pull/8628`, ok: found => found.canvas > 0},
    'pull request address': {
        url: `${site}maplibre/maplibre-gl-js/pull/8628`,
        ok: found => found.canvas > 0 && found.frames === 2 && found.named === 2 && found.sides === 'side 0|side 1' && found.aligned && found.alone === 1 && found.namedAlone === 1,
        async after(page) {
            await page.locator('nav button', {hasText: 'Console'}).click();
            await page.evaluate(() => document.querySelectorAll('iframe').forEach((frame, index) => frame.contentWindow.console.log(`side ${index}`)));
            const consoles = page.locator('section[aria-label^="Console of"]');
            await consoles.locator('li', {hasText: 'side 1'}).waitFor({timeout: 5000}).catch(() => {});
            const logged = await consoles.evaluateAll(columns => columns.map(column => [...column.querySelectorAll('li')].map(item => item.textContent).filter(text => text.startsWith('side ')).join()));
            const aligned = await consoles.evaluateAll(columns => {
                const frames = [...document.querySelectorAll('iframe')].map(frame => frame.getBoundingClientRect());
                return columns.length === 2 && columns.map(column => column.getBoundingClientRect()).every((column, index) => Math.abs(column.left - frames[index].left) <= 1 && Math.abs(column.right - frames[index].right) <= 1);
            });
            await page.getByRole('button', {name: 'Compare with…'}).click();
            await page.getByRole('button', {name: 'Stop comparing'}).click();
            await page.waitForFunction(() => !location.hash.includes('base=') && document.documentElement.dataset.livebranch === 'ready', undefined, {timeout: 90000});
            return {sides: logged.join('|'), aligned, alone: await page.locator('iframe').count(), namedAlone: await page.locator('a[title="Open on GitHub"]').count()};
        },
    },
    'commit at the head of a branch': {
        url: `${site}#gh=maplibre/maplibre-gl-js@${head}`,
        ok: found => found.canvas > 0 && found.label === `${head.slice(0, 7)} (main)` && found.reused === `main ${head.slice(0, 7)}`,
        async after(page) {
            const label = page.locator('header span', {has: page.locator('a[title="Open the commit on GitHub"]')}).last();
            const text = async () => (await label.innerText()).replace(/\s+/g, ' ');
            await label.getByText('main').waitFor({timeout: 15000});
            const found = {label: await text()};
            await page.goto(`${site}#gh=maplibre/maplibre-gl-js@main`);
            await page.waitForFunction(() => window.__livebranch.state.phase === 'ready' && window.__livebranch.state.session?.cached, undefined, {timeout: 90000});
            return {...found, reused: await text()};
        },
    },
    'demo in the description': {
        url: `${site}maplibre/maplibre-gl-js/pull/8628`,
        ok: found => found.described.join() === 'function,function',
        // The page asks for the description before the service worker controls it, which is as long as a test can answer in WebKit.
        before: context => context.route('https://api.github.com/repos/maplibre/maplibre-gl-js/pulls/8628', route => route.fulfill({
            contentType: 'application/json',
            headers: {'access-control-allow-origin': '*'},
            body: JSON.stringify({title: 'A pull request', body: `Fixes a thing.\r\n\r\n${described}`, base: {ref: 'main', repo: {default_branch: 'main'}}}),
        })),
    },
};

let failed = false;
for (const name of names) {
    const browser = await engines[name].launch();
    for (const [label, {url, ok, before, after}] of Object.entries(pages)) {
        const context = await browser.newContext();
        await before?.(context);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        let found = {};
        try {
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.waitForFunction(() => ['ready', 'failed'].includes(document.documentElement.dataset.livebranch), undefined, {timeout: 90000});
            // A comparison is up when its second build is there too, or has failed.
            await page.waitForFunction(() => !window.__livebranch.state.spec.base || window.__livebranch.state.base || window.__livebranch.state.baseError, undefined, {timeout: 90000});
            await page.waitForFunction(() => !window.__livebranch.state.checking, undefined, {timeout: 60000});
            await page.waitForTimeout(3000);
            found = await page.evaluate(() => {
                const {phase, error, session, typeProblems, console: logged, baseConsole} = window.__livebranch.state;
                const preview = document.querySelector('iframe')?.contentDocument;
                return {
                    phase,
                    error,
                    seconds: session && (session.ms / 1000).toFixed(1),
                    problems: [...session?.problems ?? [], ...typeProblems].map(problem => problem.text),
                    logged: [...logged, ...baseConsole ?? []].filter(entry => entry.level === 'error').map(entry => entry.text),
                    out: preview?.querySelector('#out')?.textContent,
                    canvas: preview?.querySelector('canvas')?.width,
                    frames: document.querySelectorAll('iframe').length,
                    named: document.querySelectorAll('a[title="Open on GitHub"]').length,
                    described: [...document.querySelectorAll('iframe')].map(frame => frame.contentDocument?.body.dataset.described),
                };
            });
            if (after && found.phase === 'ready') Object.assign(found, await after(page));
        } catch (error) {
            found = {error: String(error)};
        }
        const clean = found.phase === 'ready' && !found.problems?.length && !found.logged?.length && !errors.length && ok(found);
        failed ||= !clean;
        console.log(`${clean ? 'ok  ' : 'FAIL'} ${name}, ${label}${found.seconds ? `, ${found.seconds} s` : ''}`);
        if (!clean) console.log(JSON.stringify({...found, pageErrors: errors}, null, 2));
        await context.close();
    }
    await browser.close();
}
process.exitCode = failed ? 1 : 0;
