import assert from 'node:assert/strict';
import {test} from 'node:test';
import {computedPackages, packageSpecifiers, scriptPackage, servedModules} from './packages.ts';
import type {Env} from './project.ts';
import {lexerReady, rewriteModule} from './rewrite.ts';
import {Vfs} from './vfs.ts';

const VERSIONS = {'@unicode/unicode-17.0.0': '2.0.8', '@unicode/unicode-16.0.0': '1.6.0', 'lodash': '4.17.21', 'regenerate': '^1.4.0'};

function compiled(code: string): string {
    const ctx = {vfs: new Vfs(), alias: {}, version: () => undefined, cdn: 'esm.sh' as const, runtimeBase: 'https://app.test/'};
    return rewriteModule(code, '/build/generate.ts', ctx).code;
}

test('finds the packages that a script imports by computed names', async () => {
    await lexerReady;
    const code = compiled([
        'const version = \'17.0.0\';',
        // As the compiler emits it with rewriteRelativeImportExtensions.
        'await import(__rewriteRelativeImportExtension(`@unicode/unicode-${version}/Script/${name}/code-points.mjs`));',
        'await import(`lodash/${name}.js`);',
        'await import(`./local/${name}.ts`);',
        'await import(`missing/${name}.js`);',
        'await import(`${name}`);',
        'await import(\'regenerate\');',
    ].join('\n'));
    assert.deepEqual(computedPackages([code], VERSIONS).sort(), ['@unicode/unicode-16.0.0', '@unicode/unicode-17.0.0', 'lodash']);
});

const FILES = new Map([
    ['package.json', '{"name": "data"}'],
    ['index.mjs', 'export default {Block: [\'A\']};'],
    ['Block/A/code-points.mjs', 'import ranges from \'./ranges.mjs\';\nexport default ranges.flat();'],
    ['Block/A/ranges.mjs', 'import decode from \'../../decode.mjs\';\nexport default decode(\'x\');'],
    ['decode.mjs', 'export default text => [text];'],
    ['Packed/A/code-points.mjs', 'import {gunzipSync} from \'node:zlib\';\nexport default gunzipSync(Buffer.from(\'\', \'base64\'));'],
    ['Packed/index.mjs', 'export {default} from \'./A/code-points.mjs\';'],
    ['Inflated/A/code-points.mjs', 'export default JSON.parse(Buffer.from(\'W10=\', \'base64\'));'],
    ['own-buffer.mjs', 'const Buffer = Uint8Array;\nexport default Buffer.of(1);'],
    ['common.js', 'module.exports = 1;'],
    ['plain.js', 'export const plain = 1;'],
    ['bare.mjs', 'import regenerate from \'regenerate\';\nexport default regenerate;'],
    ['computed.mjs', 'export const load = name => import(name);'],
    ['data.json', '[1]'],
]);

test('serves the modules that load in a browser, with the shims of Node, and leaves the rest to the CDN', async () => {
    await lexerReady;
    const served = servedModules(FILES, 'https://app.test/');
    assert.deepEqual([...served.keys()].sort(), [
        'Block/A/code-points.mjs',
        'Block/A/ranges.mjs',
        'Inflated/A/code-points.mjs',
        'Packed/A/code-points.mjs',
        'Packed/index.mjs',
        'data.json',
        'decode.mjs',
        'index.mjs',
        'own-buffer.mjs',
        'package.json',
        'plain.js',
    ]);
    assert.equal(served.get('Block/A/ranges.mjs'), FILES.get('Block/A/ranges.mjs'));
    assert.equal(served.get('Packed/A/code-points.mjs'), [
        'import {Buffer} from "https://app.test/rt/node/buffer.js";',
        'import {gunzipSync} from \'https://app.test/rt/node/zlib.js\';',
        'export default gunzipSync(Buffer.from(\'\', \'base64\'));',
    ].join('\n'));
    assert.equal(served.get('own-buffer.mjs'), FILES.get('own-buffer.mjs'));
});

test('maps the import specifiers of a package to its files', () => {
    const loadable = new Set(['index.mjs', 'Block/A/code-points.mjs', 'esm/index.js', 'esm/sub/a.js', 'cjs/index.js']);
    const plain = packageSpecifiers('data', {main: './index.mjs'}, loadable);
    assert.equal(plain['data'], 'index.mjs');
    assert.equal(plain['data/Block/A/code-points.mjs'], 'Block/A/code-points.mjs');

    const exported = packageSpecifiers('lib', {
        main: './cjs/index.js',
        exports: {
            '.': {node: './cjs/index.js', import: './esm/index.js', require: './cjs/index.js'},
            './sub/*': './esm/sub/*.js',
            './package.json': './package.json',
        },
    }, loadable);
    assert.deepEqual(exported, {'lib': 'esm/index.js', 'lib/sub/a': 'esm/sub/a.js'});
});

/** A gzipped tar archive with the files under `package/`, as npm packs them. */
async function tarball(files: Map<string, string>): Promise<Uint8Array> {
    const blocks: Uint8Array[] = [];
    for (const [path, text] of files) {
        const body = new TextEncoder().encode(text);
        const header = new Uint8Array(512);
        header.set(new TextEncoder().encode(`package/${path}`), 0);
        header.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0')), 124);
        header.set(new TextEncoder().encode('0'), 156);
        blocks.push(header, body, new Uint8Array((512 - body.length % 512) % 512));
    }
    blocks.push(new Uint8Array(1024));
    const stream = new Blob(blocks as BlobPart[]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('fetches a package as one tarball, at the version that a range resolves to', async () => {
    const archive = await tarball(FILES);
    const asked: string[] = [];
    const env = {
        runtimeBase: 'https://app.test/',
        fetch: async (url: string) => {
            asked.push(url);
            if (url === 'https://data.jsdelivr.com/v1/packages/npm/data/resolved?specifier=%5E1.0.0') return Response.json({version: '1.2.0'});
            if (url === 'https://registry.npmjs.org/data/-/data-1.2.0.tgz') return new Response(archive as BodyInit);
            return new Response('', {status: 404});
        },
    } as unknown as Env;
    const found = await scriptPackage(env, 'data', '^1.0.0');
    assert.ok(found);
    assert.equal(found.files.get('decode.mjs'), FILES.get('decode.mjs'));
    assert.equal(found.files.has('common.js'), false);
    assert.equal(found.specifiers['data'], 'index.mjs');
    assert.equal(found.specifiers['data/Block/A/ranges.mjs'], 'Block/A/ranges.mjs');
    assert.equal(found.specifiers['data/bare.mjs'], undefined);

    // The package is fetched once.
    await scriptPackage(env, 'data', '^1.0.0');
    assert.equal(asked.length, 2);
});
