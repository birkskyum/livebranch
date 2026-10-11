import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lexerReady, rewriteModule} from './rewrite.ts';
import {Vfs} from './vfs.ts';

function context() {
    const vfs = new Vfs();
    vfs.write('/src/a.ts', '');
    vfs.write('/src/dir/index.ts', '');
    vfs.write('/src/style.css', '');
    vfs.write('/src/logo.svg', '');
    return {vfs, alias: {lib: './src/a.ts'}, version: (name: string) => name === 'pbf' ? '5.1.2' : undefined, cdn: 'esm.sh' as const, runtimeBase: 'https://app.test/'};
}

test('rewrites static, dynamic and computed imports', async () => {
    await lexerReady;
    const code = [
        'import {a} from \'./a.js\';',
        'import dir from "./dir";',
        'import \'./style.css\';',
        'import logo from \'./logo.svg\';',
        'import text from \'./logo.svg?raw\';',
        'import Pbf from \'pbf\';',
        'import sub from \'pbf/compile\';',
        'import lib from \'lib\';',
        'import fs from \'node:fs\';',
        'export * from \'https://example.com/x.js\';',
        'const lazy = import(\'./a.js\');',
        'const computed = import(`pkg/${name}.mjs`);',
        'const meta = import.meta.url;',
    ].join('\n');
    const {code: out, assets, missing} = rewriteModule(code, '/src/main.ts', context());
    assert.deepEqual(out.split('\n'), [
        'import {a} from \'./a.ts\';',
        'import dir from "./dir/index.ts";',
        'import \'./style.css.$css.js\';',
        'import logo from \'./logo.svg.$url.js\';',
        'import text from \'./logo.svg.$raw.js\';',
        'import Pbf from \'https://esm.sh/pbf@5.1.2\';',
        'import sub from \'https://esm.sh/pbf@5.1.2/compile\';',
        'import lib from \'./a.ts\';',
        'import fs from \'https://app.test/rt/node/fs.js\';',
        'export * from \'https://example.com/x.js\';',
        'const lazy = import("./a.ts");',
        'const computed = (globalThis.__reproImport ? globalThis.__reproImport(`pkg/${name}.mjs`, import.meta.url) : import(`pkg/${name}.mjs`));',
        'const meta = import.meta.url;',
    ]);
    assert.deepEqual(assets.map(asset => `${asset.path} ${asset.kind}`), ['/src/style.css css', '/src/logo.svg url', '/src/logo.svg raw']);
    assert.deepEqual(missing, []);
});

test('drops the import attributes of a JSON import', async () => {
    await lexerReady;
    const ctx = context();
    ctx.vfs.write('/package.json', '{}');
    const {code} = rewriteModule('import pkg from \'../package.json\' with { type: \'json\' };\nconsole.log(pkg);', '/src/main.ts', ctx);
    assert.equal(code, 'import pkg from \'../package.json.$json.js\';\nconsole.log(pkg);');
});
