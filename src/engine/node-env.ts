import {readFile} from 'node:fs/promises';
import type {Env} from './project.ts';
import {listTree, resolveRef} from './sources/git.ts';
import type {Fetch} from './sources/github.ts';
import type {WasmModule} from './tsc.ts';

let module: Promise<WasmModule> | undefined;

/** The engine's environment under Node, for the command line and the tests. */
export function nodeEnv(runtimeBase = 'https://livebranch.invalid/', request: Fetch = (url, init) => fetch(url, init)): Env {
    return {
        fetch: request,
        // Node has no CORS, so it reads GitHub's git endpoint itself.
        git: {resolve: (owner, repo, ref) => resolveRef(request, owner, repo, ref), tree: (owner, repo, commit) => listTree(request, owner, repo, commit)},
        runtimeBase,
        wasm() {
            module ??= readFile(new URL(import.meta.resolve('@tsrs/wasm/tsrs.wasm'))).then(bytes => WebAssembly.compile(bytes));
            return module;
        },
    };
}
