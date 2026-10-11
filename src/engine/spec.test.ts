import assert from 'node:assert/strict';
import {test} from 'node:test';
import {baseSource, decodeSpec, encodeSpec, normalizeGithubSource, parseGithubRef} from './spec.ts';

test('parses GitHub sources', () => {
    assert.deepEqual(parseGithubRef('o/r@main'), {owner: 'o', repo: 'r', ref: 'main', subdir: ''});
    assert.deepEqual(parseGithubRef('o/r'), {owner: 'o', repo: 'r', ref: 'HEAD', subdir: ''});
    assert.deepEqual(parseGithubRef('o/r@feature/x:packages/a'), {owner: 'o', repo: 'r', ref: 'feature/x', subdir: 'packages/a'});
    assert.deepEqual(parseGithubRef('o/r@pull/12'), {owner: 'o', repo: 'r', ref: 'pull/12/head', subdir: ''});
    const sha = 'a'.repeat(40);
    assert.deepEqual(parseGithubRef(`o/r@${sha}/docs`), {owner: 'o', repo: 'r', ref: sha, subdir: 'docs'});
});

test('turns github.com URLs into sources', () => {
    assert.deepEqual(normalizeGithubSource('o/r@main'), {gh: 'o/r@main'});
    assert.deepEqual(normalizeGithubSource('https://github.com/o/r'), {gh: 'o/r'});
    assert.deepEqual(normalizeGithubSource('https://github.com/o/r/pull/12/files'), {gh: 'o/r@pull/12'});
    assert.deepEqual(normalizeGithubSource('https://github.com/o/r/tree/feature/x'), {gh: 'o/r@feature/x'});
    assert.deepEqual(normalizeGithubSource('github.com/o/r/commit/abc1234'), {gh: 'o/r@abc1234'});
    assert.deepEqual(normalizeGithubSource('https://github.com/o/r/blob/dev/test/examples/a.html#L3'), {gh: 'o/r@dev', entry: 'test/examples/a.html'});
});

test('a spec survives its link', async () => {
    const spec = {gh: 'o/r@pull/12', entry: 'demo.html', files: {'demo.html': '<p>æøå</p>\n'.repeat(40)}};
    const params = await encodeSpec(spec);
    assert.match(params, /^gh=o\/r@pull\/12&entry=demo.html&code=[\w-]+$/);
    assert.deepEqual(await decodeSpec('', `#${params}`), spec);
    assert.deepEqual(await decodeSpec('?gh=https://github.com/o/r/blob/dev/a.html', ''), {gh: 'o/r@dev', entry: 'a.html'});
});

test('the ref to compare with is a ref of the same repository or a full source', () => {
    assert.equal(baseSource({gh: 'o/r@pull/12', base: 'main'}), 'o/r@main');
    assert.equal(baseSource({gh: 'fork/r@feature', base: 'o/r@main'}), 'o/r@main');
    assert.equal(baseSource({gh: 'o/r@feature', base: 'https://github.com/o/r/tree/release/1.x'}), 'o/r@release/1.x');
    assert.equal(baseSource({gh: 'o/r@feature'}), undefined);
});
