import assert from 'node:assert/strict';
import {test} from 'node:test';
import {forkedFrom} from './github.ts';

test('names the repository that a fork was made from', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown) => async (url: string) => {
        asked.push(url);
        return Response.json(body, {status});
    };

    // A fork of a fork is traced to the root, which is where the branches that people mean are.
    assert.equal(await forkedFrom(answer(200, {fork: true, parent: {full_name: 'other/lib'}, source: {full_name: 'some/lib'}}), 'me', 'lib'), 'some/lib');
    assert.deepEqual(asked, ['https://api.github.com/repos/me/lib']);
    assert.equal(await forkedFrom(answer(200, {fork: true, parent: {full_name: 'some/lib'}}), 'me', 'lib'), 'some/lib');
    assert.equal(await forkedFrom(answer(200, {fork: false}), 'some', 'lib'), undefined);
    await assert.rejects(forkedFrom(answer(403, {message: 'rate limit'}), 'me', 'lib'), {status: 403});
});
