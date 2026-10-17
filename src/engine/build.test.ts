import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from './build.ts';
import {nodeEnv} from './node-env.ts';
import {openProject} from './project.ts';

// No test reaches the network. A project with a package name would ask for its adapter.
const env = nodeEnv('https://app.test/', async () => new Response('', {status: 404}));

function text(body: unknown): string {
    assert.equal(typeof body, 'string');
    return body as string;
}

test('compiles the TypeScript of a page and its imports', async () => {
    const project = await openProject({
        files: {
            'index.html': '<!doctype html>\n<title>t</title>\n<script type="module">\nimport {area} from \'./shape\';\nconst side: number = 2;\nconsole.log(area(side));\n</script>\n',
            'shape.ts': 'import type {Unit} from \'./unit.ts\';\nimport data from \'./data.json\';\nimport {scale} from \'earcut\';\nexport function area(side: number, unit?: Unit): number { return side * side * data.factor; }\nexport {scale};\n',
            'unit.ts': 'export type Unit = \'m\' | \'km\';\n',
            'data.json': '{"factor": 3}',
            'package.json': '{"dependencies": {"earcut": "^3.0.0"}}',
        },
    }, env);
    const result = await build(project, env);

    assert.deepEqual(result.problems, []);
    assert.equal(result.entry, '/index.html');
    const page = text(result.outputs.get('/index.html')?.body);
    assert.match(page, /<script src="https:\/\/app\.test\/rt\/preview\.js"><\/script>/);
    assert.match(page, /<script type="module" src="\.\/index\.html\.0\.ts"><\/script>/);

    const inline = text(result.outputs.get('/index.html.0.ts')?.body);
    assert.match(inline, /from '\.\/shape\.ts'/);
    assert.match(inline, /const side = 2;/);

    const shape = text(result.outputs.get('/shape.ts')?.body);
    assert.match(shape, /from '\.\/data\.json\.\$json\.js';/);
    assert.match(shape, /from 'https:\/\/esm\.sh\/earcut@\^3\.0\.0'/);
    assert.doesNotMatch(shape.split('//#')[0], /from '\.\/unit/);
    assert.equal(text(result.outputs.get('/data.json.$json.js')?.body), 'export default {"factor": 3};\n');
    assert.equal(result.outputs.get('/shape.ts')?.type, 'text/javascript; charset=utf-8');
    assert.equal(text(result.outputs.get('/data.json')?.body), '{"factor": 3}');
});

test('reports a syntax error at its line in the page', async () => {
    const project = await openProject({
        files: {'index.html': '<h1>x</h1>\n<script type="module">\nconst a = ;\n</script>\n'},
    }, env);
    const result = await build(project, env);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].file, '/index.html');
    assert.equal(result.problems[0].line, 3);
    assert.equal(result.problems[0].category, 'error');
});

test('reports an import that names no file', async () => {
    const project = await openProject({
        files: {'index.html': '<script type="module" src="./main.ts"></script>', 'main.ts': 'import \'./gone.ts\';\n'},
    }, env);
    const result = await build(project, env);
    assert.deepEqual(result.problems.map(found => found.text), ['Cannot find module \'./gone.ts\'.']);
});

test('compiles a module that the page reaches only through an alias', async () => {
    const project = await openProject({
        files: {
            'index.html': '<script type="module">import {answer} from \'my-lib\'; console.log(answer);</script>',
            'src/index.ts': 'export const answer: number = 42;\n',
            'package.json': '{"name": "my-lib"}',
        },
    }, env);
    const result = await build(project, env);
    assert.deepEqual(result.problems, []);
    assert.match(text(result.outputs.get('/index.html.0.ts')?.body), /from '\.\/src\/index\.ts'/);
    assert.match(text(result.outputs.get('/src/index.ts')?.body), /^export const answer = 42;/);
});

test('type checks the page against the project through an alias', async () => {
    const {typeCheck} = await import('./types.ts');
    const project = await openProject({
        files: {
            'index.html': '<script type="module">\nimport {area} from \'my-lib\';\nimport earcut from \'earcut\';\narea(\'two\');\nearcut([]);\n</script>',
            'src/index.ts': 'import type {Side} from \'./side.ts\';\nexport function area(side: Side): number { return side * side; }\nconst wrong: string = 1;\n',
            'src/side.ts': 'export type Side = number;\n',
            'package.json': '{"name": "my-lib"}',
        },
    }, env);
    const problems = await typeCheck(project, env, new Set(['/index.html']));
    assert.deepEqual(problems.map(found => `${found.file}:${found.line} TS${found.code}`), ['/index.html:4 TS2345']);
});

test('a script entry runs in a page made from the template', async () => {
    const project = await openProject({
        files: {
            'demo.ts': 'const n: number = 1;\ndocument.title = String(n);\n',
            'livebranch.json': '{"template": "<!doctype html><div id=\\"map\\"></div><!--entry-->"}',
        },
    }, env);
    assert.equal(project.entry, '/demo.ts');
    const result = await build(project, env);
    assert.deepEqual(result.problems, []);
    assert.equal(result.entry, '/index.html');
    assert.match(text(result.outputs.get('/index.html')?.body), /<div id="map"><\/div><script type="module" src="\.\/demo\.ts"><\/script>/);
    assert.match(text(result.outputs.get('/demo.ts')?.body), /^const n = 1;\ndocument.title = String\(n\);\n/);

    const {typeCheck} = await import('./types.ts');
    project.vfs.write('/demo.ts', 'const n: number = "one";\n');
    const problems = await typeCheck(project, env, new Set(['/demo.ts']));
    assert.deepEqual(problems.map(found => `${found.file}:${found.line} TS${found.code}`), ['/demo.ts:1 TS2322']);
});

test('a project gets the adapter of its package name, and its own config wins', async () => {
    const adapter = {about: 'x', repository: 'Some/Lib', entry: 'demo.ts', alias: {lib: './src/a.ts'}, template: ['<div id="map"></div>', '<!--entry-->'], files: {'demo.ts': ['import {a} from \'lib\';', 'console.log(a);']}};
    const asked: string[] = [];
    const withAdapter = nodeEnv('https://app.test/', async url => {
        asked.push(url);
        return url.endsWith('/adapters/some-lib.json') ? Response.json(adapter) : new Response('', {status: 404});
    });
    const project = await openProject({
        files: {'package.json': '{"name": "some-lib", "repository": {"url": "git+https://github.com/some/lib.git"}}', 'src/a.ts': 'export const a = 1;\n', '.github/livebranch.json': '{"alias": {"other": "./src/a.ts"}}'},
    }, withAdapter);
    assert.deepEqual(asked, ['https://raw.githubusercontent.com/birkskyum/livebranch-adapters/main/adapters/some-lib.json']);
    assert.equal(project.entry, '/demo.ts');
    assert.deepEqual(project.alias, {lib: './src/a.ts', other: './src/a.ts'});
    const result = await build(project, withAdapter);
    assert.deepEqual(result.problems, []);
    assert.match(text(result.outputs.get('/index.html')?.body), /<div id="map"><\/div>\n<script type="module" src="\.\/demo\.ts"><\/script>/);
    assert.match(text(result.outputs.get('/demo.ts')?.body), /from '\.\/src\/a\.ts'/);
});

test('an adapter for another repository with the same package name is not used', async () => {
    const adapter = {repository: 'some/lib', entry: 'demo.ts', files: {'demo.ts': 'console.log(1);'}};
    const withAdapter = nodeEnv('https://app.test/', async url => url.endsWith('/adapters/some-lib.json') ? Response.json(adapter) : new Response('', {status: 404}));
    const files = {'package.json': '{"name": "some-lib", "repository": "github:someone-else/unrelated"}', 'index.html': '<p>own page</p>'};
    assert.equal((await openProject({files}, withAdapter)).entry, '/index.html');
    assert.deepEqual((await openProject({files}, withAdapter)).config.files, {});
    assert.equal((await openProject({files: {'package.json': files['package.json']}, adapter: 'some-lib'}, withAdapter)).entry, '/demo.ts');
});

test('stops at the source budget of the environment', async () => {
    const {typeCheck} = await import('./types.ts');
    const {TooLargeError} = await import('./tsc.ts');
    const files = {
        'index.html': '<script type="module" src="./main.ts"></script>',
        'main.ts': 'import {pad} from \'./pad.ts\';\nimport type {Wide} from \'./wide\';\nconst wide: Wide = pad;\nconsole.log(wide);\n',
        'pad.ts': `export const pad = '${'x'.repeat(600)}';\n`,
        'wide.d.ts': `export type Wide = string;\n// ${'x'.repeat(2000)}\n`,
    };
    const sources = files['main.ts'].length + files['pad.ts'].length;
    // A declaration file counts for a quarter of its length.
    const program = sources + files['wide.d.ts'].length / 4;
    const run = async (sourceBudget: number) => {
        const limited = {...env, sourceBudget};
        const project = await openProject({files}, limited);
        const {problems} = await build(project, limited);
        return [...problems, ...await typeCheck(project, limited, new Set(['/main.ts']))];
    };

    assert.deepEqual(await run(program), []);
    await assert.rejects(run(program - 1), TooLargeError);
    await assert.rejects(run(sources - 1), TooLargeError);
});

test('takes a run that had no memory left to write for one that is too large', async () => {
    const {TooLargeError, tsc} = await import('./tsc.ts');
    const project = await openProject({files: {'main.ts': 'console.log(1);\n'}}, env);
    // Out of memory, V8 makes no buffer for the output, and tsrs reports the write as failed.
    project.vfs.write = () => {
        throw new RangeError('Invalid array buffer length');
    };
    await assert.rejects(tsc(await env.wasm(), project.vfs, ['--outDir', '/out', '/main.ts'], {json: true, writeToProject: true}), TooLargeError);
});

// A stand-in for tsrs.wasm whose run traps, as a panic of the compiler ends.
// (module
//   (memory (export "memory") 1)
//   (func (export "tsrs_input") (param i32) (result i32) (i32.const 1024))
//   (func (export "tsrs_run") (result i32) (unreachable))
//   (func (export "tsrs_output") (result i32) (i32.const 0))
//   (func (export "tsrs_output_len") (result i32) (i32.const 0)))
const PANICKING = 'AGFzbQEAAAABCgJgAX8Bf2AAAX8DBQQAAQEBBQMBAAEHQgUGbWVtb3J5AgAKdHNyc19pbnB1dAAACHRzcnNfcnVuAAELdHNyc19vdXRwdXQAAg90c3JzX291dHB1dF9sZW4AAwoVBAUAQYAICwMAAAsEAEEACwQAQQAL';

test('reports a crash of the compiler, also where the setup did not run', async () => {
    const {checkProject} = await import('./check.ts');
    const panicking = {...env, wasm: () => WebAssembly.compile(Buffer.from(PANICKING, 'base64'))};
    const project = await openProject({
        files: {
            'index.html': '<script type="module" src="./main.ts"></script>',
            'main.ts': 'console.log(1);\n',
            'livebranch.json': '{"setup": ["node make.ts"]}',
        },
    }, panicking);
    const {problems} = await checkProject(project, panicking);
    const said = 'tsrs.wasm trapped (RuntimeError: unreachable); a stack overflow on deeply nested code or running out of memory are the usual causes';
    assert.deepEqual(problems.map(problem => [problem.category, problem.text]), [
        ['error', `The compiler crashed, so modules are missing from this build. ${said}`],
        ['error', `The compiler crashed, so the types are not checked. ${said}`],
    ]);
});
