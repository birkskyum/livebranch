import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire, SourceMap} from 'node:module';
import {test} from 'node:test';
import {build} from './build.ts';
import {nodeEnv} from './node-env.ts';
import {openProject} from './project.ts';
import {loadSolidCompiler} from './solid.ts';

// No test reaches the network.
const env = nodeEnv('https://app.test/', async () => new Response('', {status: 404}));

/** A Solid 2 app as the client mode of @solidjs/vite-plugin has it, with no index.html. */
const app = {
    'package.json': JSON.stringify({
        dependencies: {'@solidjs/web': '^2.0.0-rc.21', 'solid-js': '^2.0.0-rc.21'},
        devDependencies: {'@solidjs/vite-plugin': '^3.0.0-next.57', vite: '^8.3.5'},
    }),
    'tsconfig.json': '{"compilerOptions": {"jsx": "preserve", "jsxImportSource": "@solidjs/web", "strict": true}}',
    'src/App.tsx': "import {createSignal} from 'solid-js';\n\nexport default function App() {\n  const [count, setCount] = createSignal(0);\n  return <button class=\"increment\" onClick={() => setCount(count() + 1)}>Clicks: {count()}</button>;\n}\n",
    'src/Document.tsx': "import type {ParentProps} from 'solid-js';\nimport {HydrationScript} from '@solidjs/web';\n\nexport default function Document(props: ParentProps) {\n  return (\n    <html lang=\"en\">\n      <head>\n        <meta charset=\"utf-8\" />\n        <link rel=\"icon\" href=\"/favicon.ico\" />\n        <title>Solid App</title>\n        <HydrationScript />\n      </head>\n      <body>{props.children}</body>\n    </html>\n  );\n}\n",
    'public/favicon.ico': '',
};

test('makes the page of a Solid app in client mode, as its Vite plugin does', async () => {
    const project = await openProject({files: app}, env);
    assert.equal(project.entry, '/index.html');
    assert.equal(project.shown, '/src/App.tsx');
    const page = project.vfs.readText('/index.html') ?? '';
    assert.match(page, /<meta charset="utf-8">/);
    // Vite serves public/ at the root. The preview serves the project from its own folder.
    assert.match(page, /<link rel="icon" href="\.\/public\/favicon\.ico">/);
    assert.match(page, /<title>Solid App<\/title>/);
    assert.doesNotMatch(page, /HydrationScript/);
    assert.match(page, /import App from '\.\/src\/App\.tsx';\n\nrender\(\(\) => createComponent\(App, \{\}\), document\.body\);/);

    const own = await openProject({files: {...app, 'index.html': '<p>own page</p>'}}, env);
    assert.equal(own.entry, '/index.html');
    assert.equal(own.shown, undefined);
    assert.equal(own.vfs.readText('/index.html'), '<p>own page</p>');
});

test("compiles JSX with Solid's compiler where the environment has it", async () => {
    const wasm = createRequire(import.meta.url).resolve('@solidjs/compiler-wasm32-wasi/compiler.wasm32-wasi.wasm');
    const compiler = loadSolidCompiler(await WebAssembly.compile(await readFile(wasm)));
    const withSolid = {...env, solid: () => compiler};
    const {problems, outputs} = await build(await openProject({files: app}, withSolid), withSolid);
    assert.deepEqual(problems, []);
    const code = String(outputs.get('/src/App.tsx')?.body);
    assert.match(code, /template\(`<button class=increment>Clicks: `\)/);
    assert.match(code, /from ['"]https:\/\/esm\.sh\/@solidjs\/web@\^2\.0\.0-rc\.21['"]/);
    assert.doesNotMatch(code, /onClick=\{|jsx-runtime/);
    // The source map maps the output to the file that tsrs read, line for line.
    const map = JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;base64,(\S+)/.exec(code)?.[1] ?? '', 'base64').toString());
    assert.deepEqual(map.sources.map((source: string) => source.replace(/^livebranch:\/\/\//, '')), ['src/App.tsx']);
    assert.equal(map.sourcesContent[0], app['src/App.tsx']);
    const lines = code.split('\n');
    const original = (text: string) => new SourceMap(map).findEntry(lines.findIndex(line => line.includes(text)), 1) as {originalLine?: number};
    assert.equal(original('createSignal(0)').originalLine, 3);
    assert.equal(original('_$insert(_el$, count').originalLine, 4);

    // Without the compiler, as on the server, the JSX compiles as React's, which is enough to check it.
    const {problems: checked} = await build(await openProject({files: app}, env), env);
    assert.deepEqual(checked, []);
});
