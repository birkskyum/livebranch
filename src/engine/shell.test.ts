import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nodeEnv} from './node-env.ts';
import {openProject} from './project.ts';
import {createShell} from './shell.ts';

const env = nodeEnv('https://app.test/');

test('the shell works on the project files and keeps its working directory', async () => {
    const project = await openProject({
        files: {'index.html': '<p>hi</p>', 'src/a.ts': 'export const a: number = 1;\n', 'package.json': '{"scripts": {"count": "ls src | wc -l"}}'},
    }, env);
    const shell = createShell(project, env);

    assert.equal((await shell.exec('pwd')).stdout, '/project\n');
    assert.equal((await shell.exec('ls src')).stdout, 'a.ts\n');
    assert.equal((await shell.exec('cat src/a.ts | grep -c number')).stdout, '1\n');
    await shell.exec('mkdir -p out && echo hello > out/note.txt');
    assert.equal(project.vfs.readText('/out/note.txt'), 'hello\n');
    assert.match((await shell.exec('npm run count')).stdout, /\n1\n$/);
});

test('tsc in the shell type checks and emits into the project', async () => {
    const project = await openProject({
        files: {'index.html': '', 'a.ts': 'export const a: number = \'one\';\n', 'b.ts': 'export const b = 2;\n'},
    }, env);
    const shell = createShell(project, env);

    const failed = await shell.exec('tsc --noEmit --pretty false a.ts');
    assert.equal(failed.exitCode, 2);
    assert.match(failed.stdout, /a\.ts\(1,14\): error TS2322/);

    const emitted = await shell.exec('tsc --target es2022 b.ts');
    assert.equal(emitted.exitCode, 0);
    assert.equal(project.vfs.readText('/b.js'), 'export const b = 2;\n');
});
