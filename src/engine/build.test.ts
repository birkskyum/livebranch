import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from './build.ts';
import {nodeEnv} from './node-env.ts';
import {openProject} from './project.ts';

const env = nodeEnv('https://app.test/');

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
