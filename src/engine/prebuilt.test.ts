import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nodeEnv} from './node-env.ts';
import {fetchPrebuilt} from './prebuilt.ts';
import {openProject} from './project.ts';

const GENERATOR = 'export const version = 1;\n';
const GENERATED = 'export const generated = 1;\n';

/** The release `lib@1.0.0` on jsDelivr, with its generator and the file that it made. */
const release = nodeEnv('https://app.test/', async url => {
    if (url === 'https://cdn.jsdelivr.net/npm/lib@1.0.0/src/data.g.ts') return new Response(GENERATED);
    if (url === 'https://cdn.jsdelivr.net/npm/lib@1.0.0/build/generate.ts') return new Response(GENERATOR);
    return new Response('', {status: 404});
});

function project(generator: string, command?: string) {
    const config = {prebuilt: [{files: ['src/data.g.ts'], inputs: ['build/generate.ts'], ...command ? {command} : {}}]};
    return openProject({
        files: {
            'demo.ts': 'import {generated} from \'./src/data.g.ts\';\nconsole.log(generated);\n',
            'build/generate.ts': generator,
            'package.json': '{"name": "lib", "version": "1.0.0"}',
            'livebranch.json': JSON.stringify(config),
        },
    }, release);
}

test('takes a prebuilt file from the release when its generator is the same', async () => {
    const opened = await project(GENERATOR, 'node build/generate.ts');
    const result = await fetchPrebuilt(opened, release);
    assert.deepEqual(result, {problems: [], stale: []});
    assert.equal(opened.vfs.readText('/src/data.g.ts'), GENERATED);
});

test('leaves a prebuilt file to its command when the generator changed since the release', async () => {
    const opened = await project('export const version = 2;\n', 'node build/generate.ts');
    const result = await fetchPrebuilt(opened, release);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stale.map(stale => stale.command), ['node build/generate.ts']);
    assert.equal(opened.vfs.isFile('/src/data.g.ts'), false);

    // When the command fails, the release's file is used after all.
    const warnings = result.stale[0].fallback();
    assert.equal(opened.vfs.readText('/src/data.g.ts'), GENERATED);
    assert.deepEqual(warnings.map(warning => [warning.category, warning.text]), [
        ['warning', 'src/data.g.ts comes from lib@1.0.0, but build/generate.ts differs from that release, so it may be out of date.'],
    ]);
});

test('warns about a changed generator that has no command', async () => {
    const opened = await project('export const version = 2;\n');
    const result = await fetchPrebuilt(opened, release);
    assert.deepEqual(result.stale, []);
    assert.equal(result.problems.length, 1);
    assert.equal(opened.vfs.readText('/src/data.g.ts'), GENERATED);
});
