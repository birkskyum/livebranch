import {readFile} from 'node:fs/promises';
import type {Env} from './project.ts';
import type {Fetch} from './sources/github.ts';
import type {WasmModule} from './tsc.ts';

let module: Promise<WasmModule> | undefined;

/** The engine's environment under Node, for the command line and the tests. */
export function nodeEnv(runtimeBase = 'https://livebranch.invalid/', request: Fetch = (url, init) => fetch(url, init)): Env {
    return {
        fetch: request,
        runtimeBase,
        wasm() {
            module ??= readFile(new URL('../../public/tsc/ts_rust.wasm', import.meta.url)).then(bytes => WebAssembly.compile(bytes));
            return module;
        },
    };
}
