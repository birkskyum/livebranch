import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultBranch} from './git.ts';

const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;

test('reads the default branch from what HEAD points at', async () => {
    const asked: string[] = [];
    const answer = (lines: string[]) => async (url: string, init?: RequestInit) => {
        asked.push(`${url} ${init?.body}`);
        return new Response(`${lines.map(pkt).join('')}0000`);
    };
    const sha = '72927301aa0a1ff4a2b4b3c3fbd2ad9cf2e2b0d1';

    assert.equal(await defaultBranch(answer([`${sha} HEAD symref-target:refs/heads/trunk\n`, `${sha} refs/heads/HEAD-backup\n`]), 'some', 'lib'), 'trunk');
    assert.match(asked[0], /^https:\/\/github\.com\/some\/lib\.git\/git-upload-pack .*command=ls-refs\n.*symrefs\n.*ref-prefix HEAD\n/s);
    // A detached HEAD and an empty repository name no branch.
    assert.equal(await defaultBranch(answer([`${sha} HEAD\n`]), 'some', 'lib'), undefined);
    assert.equal(await defaultBranch(answer([]), 'some', 'lib'), undefined);
});
