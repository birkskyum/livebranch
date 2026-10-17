import {useState, type FormEvent} from 'react';
import {Button} from '@/components/ui/button.tsx';
import {Input} from '@/components/ui/input.tsx';
import {Textarea} from '@/components/ui/textarea.tsx';
import {encodeSpec, isPullRequest, normalizeGithubSource} from '../engine/spec.ts';
import {REPOSITORY, defaultBranch, navigate} from './store.ts';

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
    const [source, setSource] = useState('');
    const [page, setPage] = useState(STARTER);

    const open = async (event: FormEvent) => {
        event.preventDefault();
        const {gh, entry} = source.trim() ? normalizeGithubSource(source) : {gh: undefined, entry: undefined};
        const files = page.trim() && !(gh && page === STARTER) ? {'index.html': page} : undefined;
        // A pull request opens next to the default branch, as its address in the path does.
        const base = gh && isPullRequest(gh) ? await defaultBranch(gh) : undefined;
        navigate(await encodeSpec({gh, base, entry, files}));
    };

    const link = 'text-blue-600 underline dark:text-blue-400';
    return (
        <main className="mx-auto flex h-full max-w-2xl flex-col gap-6 overflow-auto px-6 py-12">
            <header className="flex flex-col gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">livebranch</h1>
                <p className="text-muted-foreground">
                    Runs a TypeScript project in the browser. The TypeScript compiler (tsrs, as WebAssembly) compiles the
                    sources here, straight from a GitHub commit, and the page loads the result. A link holds everything, so
                    there is no account and no server.
                </p>
            </header>
            <form className="flex flex-col gap-4" onSubmit={open}>
                <label className="flex flex-col gap-1">
                    <span className="font-medium">GitHub source (optional)</span>
                    <Input
                        className="font-mono"
                        placeholder="owner/repo@branch, or the URL of a branch, a pull request or an example file"
                        value={source}
                        onChange={event => setSource(event.currentTarget.value)}
                    />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="font-medium">Page</span>
                    <Textarea className="h-64 font-mono text-xs md:text-xs" spellCheck={false} value={page} onChange={event => setPage(event.currentTarget.value)} />
                </label>
                <Button className="self-start" type="submit">Open</Button>
            </form>
            <p className="text-muted-foreground">
                Try <a className={link} href="#gh=maplibre/maplibre-gl-js@main">maplibre/maplibre-gl-js@main</a>,
                built from source in this tab.
            </p>
            <p className="text-muted-foreground">
                Put <code className="font-mono">livebranch.dev/</code> in front of any GitHub URL of a branch, a pull request or an example
                file to open it here. The <a className={link} href="./llms.txt">guide</a> has the
                link format and the API, for people and for agents.
            </p>
            <p className="text-muted-foreground">
                The code of livebranch is on <a className={link} href={REPOSITORY} target="_blank" rel="noreferrer">GitHub</a>, under the MIT license.
            </p>
        </main>
    );
}
