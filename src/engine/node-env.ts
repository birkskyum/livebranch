import {readFile} from 'node:fs/promises';
import type {Env} from './project.ts';
import type {WasmModule} from './tsc.ts';

let module: Promise<WasmModule> | undefined;

/** The engine's environment under Node, for the command line and the tests. */
export function nodeEnv(runtimeBase = 'https://livebranch.invalid/'): Env {
    return {
        fetch: (url, init) => fetch(url, init),
        runtimeBase,
        wasm() {
            module ??= readFile(new URL('../../public/tsc/ts_rust.wasm', import.meta.url)).then(bytes => WebAssembly.compile(bytes));
            return module;
        },
    };
}
