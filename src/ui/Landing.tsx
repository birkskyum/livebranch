import {createSignal} from 'solid-js';
import {encodeSpec, isPullRequest, normalizeGithubSource} from '../engine/spec.ts';
import {defaultBranch, navigate} from './store.ts';

const STARTER = `<!doctype html>
<meta charset="utf-8">
<title>Page</title>
<pre id="out"></pre>
<script type="module">
interface Point { x: number; y: number }

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

document.querySelector('#out')!.textContent = String(distance({x: 0, y: 0}, {x: 3, y: 4}));
</script>
`;

export function Landing() {
    const [source, setSource] = createSignal('');
    const [page, setPage] = createSignal(STARTER);

    const open = async (event: SubmitEvent) => {
        event.preventDefault();
        const {gh, entry} = source().trim() ? normalizeGithubSource(source()) : {gh: undefined, entry: undefined};
        const files = page().trim() && !(gh && page() === STARTER) ? {'index.html': page()} : undefined;
        // A pull request opens next to the default branch, as its address in the path does.
        const base = gh && isPullRequest(gh) ? await defaultBranch(gh) : undefined;
        navigate(await encodeSpec({gh, base, entry, files}));
    };

    return (
        <main class="mx-auto flex h-full max-w-2xl flex-col gap-6 overflow-auto px-6 py-12">
            <header class="flex flex-col gap-2">
                <h1 class="text-2xl font-semibold tracking-tight">livebranch</h1>
                <p class="text-neutral-600 dark:text-neutral-400">
                    Runs a TypeScript project in the browser. The TypeScript compiler (tsc-rs, as WebAssembly) compiles the
                    sources here, straight from a GitHub commit, and the page loads the result. A link holds everything, so
                    there is no account and no server.
                </p>
            </header>
            <form class="flex flex-col gap-4" onSubmit={open}>
                <label class="flex flex-col gap-1">
                    <span class="font-medium">GitHub source (optional)</span>
                    <input
                        class="rounded border border-neutral-300 bg-transparent px-3 py-2 font-mono dark:border-neutral-700"
                        placeholder="owner/repo@branch, or the URL of a branch, a pull request or an example file"
                        value={source()}
                        onInput={event => setSource(event.currentTarget.value)}
                    />
                </label>
                <label class="flex flex-col gap-1">
                    <span class="font-medium">Page</span>
                    <textarea
                        class="h-64 rounded border border-neutral-300 bg-transparent px-3 py-2 font-mono text-xs dark:border-neutral-700"
                        spellcheck={false}
                        value={page()}
                        onInput={event => setPage(event.currentTarget.value)}
                    />
                </label>
                <button class="self-start rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700" type="submit">Open</button>
            </form>
            <p class="text-neutral-600 dark:text-neutral-400">
                Try <a class="text-blue-600 underline dark:text-blue-400" href="#gh=maplibre/maplibre-gl-js@main">maplibre/maplibre-gl-js@main</a>,
                built from source in this tab.
            </p>
            <p class="text-neutral-600 dark:text-neutral-400">
                Put <code class="font-mono">livebranch.dev/</code> in front of any GitHub URL of a branch, a pull request or an example
                file to open it here. The <a class="text-blue-600 underline dark:text-blue-400" href="./llms.txt">guide</a> has the
                link format and the API, for people and for agents.
            </p>
        </main>
    );
}
