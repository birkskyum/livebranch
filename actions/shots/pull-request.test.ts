import assert from 'node:assert/strict';
import {test} from 'node:test';
import {comment, linkOf, type Pull} from './pull-request.ts';

const site = 'https://livebranch.dev/';
const pull = (body: string): Pull => ({
    number: 7,
    body,
    head: {sha: 'b'.repeat(40)},
    base: {sha: 'a'.repeat(40), ref: 'main', repo: {full_name: 'owner/repo'}},
});
const demo = '```ts livebranch\nconsole.log(1);\n```\n';

test('a link with a recorded gesture plays it on arrival, with input given to both pages', async () => {
    const found = await linkOf(pull(`${demo}\n[Try it](https://livebranch.dev/#gh=owner/repo@pull/7&gesture=AbC_1-x)`), site);
    assert.equal(found.gesture, true);
    assert.match(found.link, /^https:\/\/livebranch\.dev\/#play=1&mirror=1&gesture=AbC_1-x&/);
    const plain = await linkOf(pull(demo), site);
    assert.equal(plain.gesture, false);
    assert.doesNotMatch(plain.link, /play=|mirror=/);
});

test('the comment starts with the link to the comparison', async () => {
    const found = await linkOf(pull(`${demo}\nhttps://livebranch.dev/#gesture=AbC`), site);
    const summary = {head: 'b'.repeat(40), failure: '', sides: [
        {name: 'base' as const, commit: 'a'.repeat(40), picture: true, errors: [], problems: []},
        {name: 'head' as const, commit: 'b'.repeat(40), picture: true, errors: [], problems: []},
    ]};
    const [marker, first] = comment(pull(''), found, summary, {base: 'https://p/base.png', head: 'https://p/head.png'}).split('\n');
    assert.equal(marker, '<!-- livebranch -->');
    assert.ok(first.startsWith(`**[Open the base and this pull request side by side](${found.link})** on livebranch`), first);
    assert.match(first, /plays the recorded gesture on both/);
});
