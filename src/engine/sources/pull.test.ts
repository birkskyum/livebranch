import assert from 'node:assert/strict';
import {test} from 'node:test';
import {demoBlocks, demoFiles, fetchPullRequest} from './pull.ts';

const description = [
    'Fixes #1. The camera no longer drops.',
    '',
    '```ts',
    'const notTheDemo = true;',
    '```',
    '',
    '<details><summary>Demo</summary>',
    '',
    '```ts livebranch',
    'import {helper} from \'./helper.ts\';',
    '',
    'helper();',
    '```',
    '',
    '  ~~~~typescript livebranch helper.ts',
    '  export function helper() {}',
    '  ~~~',
    '  ~~~~',
    '',
    '```html',
    '<p>also not the demo</p>',
    '```',
    '</details>',
].join('\r\n');

test('reads the marked code blocks of a description as files', () => {
    assert.deepEqual(demoFiles(description), {
        'demo.ts': 'import {helper} from \'./helper.ts\';\n\nhelper();\n',
        'helper.ts': 'export function helper() {}\n~~~\n',
    });
    assert.deepEqual(demoFiles('```html livebranch\n<p>page</p>\n```\n'), {'index.html': '<p>page</p>\n'});
    assert.deepEqual(demoFiles('```livebranch\nlet a = 1;\n```'), {'demo.ts': 'let a = 1;\n'});
    // Of two blocks for one file the later counts, and a language without a default name needs a name.
    assert.deepEqual(demoFiles('```ts livebranch\n1;\n```\n```ts livebranch /demo.ts\n2;\n```\n```json livebranch\n{}\n```\n'), {'demo.ts': '2;\n'});
    assert.deepEqual(demoFiles('No demo here.\n\n```ts\nlet a = 1;\n```\n'), {});
});

test('writes files as blocks that read back the same', () => {
    const files = {
        'demo.ts': 'const fence = "```";\nconsole.log(fence);\n',
        'index.html': '<div id="map"></div>\n',
        'data/points.json': '{"points": []}\n',
    };
    const blocks = demoBlocks(files);
    assert.match(blocks, /^````ts livebranch\n/);
    assert.match(blocks, /\n```html livebranch\n/);
    assert.match(blocks, /\n```json livebranch data\/points\.json\n/);
    assert.deepEqual(demoFiles(blocks), files);
    assert.deepEqual(demoFiles(`Some words.\n\n${demoBlocks({'demo.ts': 'no newline at the end'})}`), {'demo.ts': 'no newline at the end\n'});
});

test('reads a pull request with its demo and the branch it goes into', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown) => async (url: string) => {
        asked.push(url);
        return Response.json(body, {status});
    };
    const pull = {title: 'Keep the elevation', body: '```ts livebranch\nlet a = 1;\n```', base: {ref: 'release-5', repo: {default_branch: 'main'}}};

    assert.deepEqual(await fetchPullRequest(answer(200, pull), 'some', 'lib', 12), {title: 'Keep the elevation', base: 'release-5', defaultBranch: 'main', files: {'demo.ts': 'let a = 1;\n'}});
    assert.deepEqual(asked, ['https://api.github.com/repos/some/lib/pulls/12']);
    assert.deepEqual((await fetchPullRequest(answer(200, {...pull, body: null}), 'some', 'lib', 12)).files, {});
    await assert.rejects(fetchPullRequest(answer(403, {message: 'rate limit'}), 'some', 'lib', 12), {status: 403});
});
