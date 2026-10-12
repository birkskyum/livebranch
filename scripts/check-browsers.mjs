// Opens a small page and a maplibre-gl-js pull request on a livebranch site in Firefox, WebKit and
// Chromium, and fails when one of them does not come up clean. The pull request is also opened by
// its GitHub address, which compares it with the default branch, and the comparison is stopped.
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
const pages = {
    // A local Worker names the live site in its links, so only the link's parameters are taken.
    'small page': {url: `${site}${new URL(small.url).hash}`, ok: found => found.out === 'area 9, 2 triangles'},
    'maplibre pull request': {url: `${site}#gh=maplibre/maplibre-gl-js@pull/8628`, ok: found => found.canvas > 0},
    'pull request address': {
        url: `${site}maplibre/maplibre-gl-js/pull/8628`,
        ok: found => found.canvas > 0 && found.frames === 2 && found.alone === 1,
        async after(page) {
            await page.getByRole('button', {name: 'Compare with…'}).click();
            await page.getByRole('button', {name: 'Stop comparing'}).click();
            await page.waitForFunction(() => !location.hash.includes('base=') && document.documentElement.dataset.livebranch === 'ready', undefined, {timeout: 90000});
            return {alone: await page.locator('iframe').count()};
        },
    },
};

let failed = false;
for (const name of names) {
    const browser = await engines[name].launch();
    for (const [label, {url, ok, after}] of Object.entries(pages)) {
        const page = await (await browser.newContext()).newPage();
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
                const {phase, error, session, typeProblems, console: logged} = window.__livebranch.state;
                const preview = document.querySelector('iframe')?.contentDocument;
                return {
                    phase,
                    error,
                    seconds: session && (session.ms / 1000).toFixed(1),
                    problems: [...session?.problems ?? [], ...typeProblems].map(problem => problem.text),
                    logged: logged.filter(entry => entry.level === 'error').map(entry => entry.text),
                    out: preview?.querySelector('#out')?.textContent,
                    canvas: preview?.querySelector('canvas')?.width,
                    frames: document.querySelectorAll('iframe').length,
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
        await page.close();
    }
    await browser.close();
}
process.exitCode = failed ? 1 : 0;
