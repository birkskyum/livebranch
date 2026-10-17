// Opens a small page and a maplibre-gl-js pull request on a livebranch site in Firefox, WebKit and
// Chromium, and fails when one of them does not come up clean. The pull request is also opened by
// its GitHub address, which compares it with the default branch, and the comparison is stopped.
// Before that, what each side logs has to show in the console of that side, which is under it, and
// the lines between the files, the code, the previews and the panel have to move, also across a
// preview. The files start 192 pixels wide and keep their width when the code panel is made wider.
// The address asks for input to be mirrored, in its fragment, which has to survive the redirect.
// Mirrored, a drag on the map of the pull request has to move the map of main the same way, and
// once the bar turns mirroring off, not at all. The icon of the panel has to count an error of the
// console, and the bar's buttons have to say on hover what they do. Shared at the commits as
// previews alone, the link has to name both commits, and the demo has to copy as a block for a
// pull request.
// Each ref has to be named once, in the bar over its own preview, which lines up with it. The
// comparison is stopped from that bar.
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
        url: `${site}maplibre/maplibre-gl-js/pull/8628#mirror=1`,
        ok: found => found.canvas > 0 && found.frames === 2 && found.named === 2 && found.bars && found.sides === 'side 0|side 1' && found.aligned && found.badge === 1 && found.tip === 'Reload both' && found.mirrors && found.shared && found.files === 192 && found.resized === '80,200,100' && found.alone === 1 && found.namedAlone === 1,
        async after(page) {
            await page.getByRole('tab', {name: /^Console/}).click();
            await page.evaluate(() => document.querySelectorAll('iframe').forEach((frame, index) => frame.contentWindow.console.log(`side ${index}`)));
            await page.evaluate(() => document.querySelector('iframe').contentWindow.console.error('broken on purpose'));
            const consoles = page.locator('section[aria-label^="Console of"]');
            await consoles.locator('li', {hasText: 'side 1'}).waitFor({timeout: 5000}).catch(() => {});
            const logged = await consoles.evaluateAll(columns => columns.map(column => [...column.querySelectorAll('li')].map(item => item.textContent).filter(text => text.startsWith('side ')).join()));
            const lineUp = columns => {
                const frames = [...document.querySelectorAll('iframe')].map(frame => frame.getBoundingClientRect());
                return columns.length === 2 && columns.map(column => column.getBoundingClientRect()).every((column, index) => Math.abs(column.left - frames[index].left) <= 1 && Math.abs(column.right - frames[index].right) <= 1);
            };
            const aligned = await consoles.evaluateAll(lineUp);
            const bars = await page.locator('[data-side]').evaluateAll(lineUp);
            const badge = await page.getByRole('button', {name: 'Panel, 1 error'}).count();
            await page.getByRole('button', {name: 'Reload both'}).hover();
            const tip = await page.getByRole('tooltip').innerText({timeout: 3000}).catch(() => '');
            await page.mouse.move(0, 0);
            // The demo keeps its camera in the address of its page. With input mirrored, a drag on the
            // pull request's map moves main's the same way. Without, main's stays where it is.
            const cameras = () => page.evaluate(() => [...document.querySelectorAll('iframe')].map(frame => frame.contentWindow.location.hash));
            const dragMap = async () => {
                const map = await page.locator('iframe').nth(1).boundingBox();
                await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
                await page.mouse.down();
                await page.mouse.move(map.x + map.width / 2 - 120, map.y + map.height / 2 + 60, {steps: 12});
                await page.mouse.up();
                await page.waitForTimeout(1500);
                return cameras();
            };
            const start = await cameras();
            const mirroredLink = await page.evaluate(() => window.__livebranch.state.mirror && location.hash.includes('mirror=1'));
            const mirrored = await dragMap();
            await page.getByRole('button', {name: 'Mirror input'}).click({timeout: 5000}).catch(() => {});
            const plainLink = await page.evaluate(() => !window.__livebranch.state.mirror && !location.hash.includes('mirror='));
            const alone = await dragMap();
            const mirrors = mirroredLink && plainLink && mirrored[0] === mirrored[1] && mirrored[1] !== start[1] && alone[0] === mirrored[0] && alone[1] !== mirrored[1];
            // What the page copies is kept, so that this runs where the browser may not write to the clipboard.
            await page.evaluate(() => {
                window.copied = [];
                navigator.clipboard.writeText = text => Promise.resolve(void window.copied.push(text));
            });
            const shared = await (async () => {
                await page.getByRole('button', {name: 'Share'}).click();
                await page.getByRole('switch', {name: /^Only the previews/}).click();
                await page.getByRole('switch', {name: /^At these commits/}).click();
                await page.waitForFunction(() => /#view=result&.*@[0-9a-f]{40}/.test(document.querySelector('input[aria-label="Link"]')?.value), undefined, {timeout: 10000});
                await page.getByRole('button', {name: 'Copy', exact: true}).click();
                await page.getByRole('button', {name: 'Copy the demo for a pull request'}).click();
                await page.waitForFunction(() => window.copied.length === 2, undefined, {timeout: 10000});
                const [link, block] = await page.evaluate(() => window.copied);
                await page.keyboard.press('Escape');
                return /[#&]gh=maplibre\/maplibre-gl-js@[0-9a-f]{40}(&|$)/.test(link) && /&base=maplibre\/maplibre-gl-js@[0-9a-f]{40}(&|$)/.test(link) && block.includes('<details>');
            })().catch(error => String(error).split('\n')[0]);
            const drag = async (name, dx, dy) => {
                const box = await page.getByRole('separator', {name}).boundingBox({timeout: 5000});
                const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
                await page.mouse.move(x, y);
                await page.mouse.down();
                await page.mouse.move(x + dx, y + dy, {steps: 10});
                await page.mouse.up();
            };
            const [files, frame] = [page.getByRole('navigation', {name: 'Files'}), page.locator('iframe').first()];
            const before = {files: await files.boundingBox(), frame: await frame.boundingBox()};
            const resized = await drag('Width of the files', 80, 0).then(() => drag('Width of the code', 200, 0)).then(() => drag('Height of the panel', 0, -100)).then(async () => {
                const after = {files: await files.boundingBox(), frame: await frame.boundingBox()};
                return [after.files.width - before.files.width, after.frame.x - before.frame.x, before.frame.height - after.frame.height].map(Math.round).join();
            }, error => String(error).split('\n')[0]);
            await page.getByRole('button', {name: 'Stop comparing'}).click();
            await page.waitForFunction(() => !location.hash.includes('base=') && document.documentElement.dataset.livebranch === 'ready', undefined, {timeout: 90000});
            return {sides: logged.join('|'), aligned, bars, badge, tip, mirrors, shared, files: Math.round(before.files?.width), resized, alone: await page.locator('iframe').count(), namedAlone: await page.locator('a[title="Open on GitHub"]').count()};
        },
    },
    'commit at the head of a branch': {
        url: `${site}#gh=maplibre/maplibre-gl-js@${head}`,
        ok: found => found.canvas > 0 && found.label === `${head.slice(0, 7)} (main)` && found.reused === `main ${head.slice(0, 7)}`,
        async after(page) {
            const label = page.getByRole('toolbar', {name: 'Previews'}).locator('span', {has: page.locator('a[title="Open the commit on GitHub"]')}).last();
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
                    named: document.querySelectorAll('a[title="Open on GitHub"], [aria-label="Change the ref to compare with"]').length,
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
