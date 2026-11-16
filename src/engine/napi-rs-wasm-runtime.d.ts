// @napi-rs/wasm-runtime has no types of its own. These are the parts that src/engine/solid.ts uses.
declare module '@napi-rs/wasm-runtime' {
    export function createContext(): unknown;
    export class WASI {
        constructor(options: {version: 'preview1'});
    }
    export const emnapiAsyncWorkPlugin: unknown;
    export const emnapiTSFNPlugin: unknown;
    export function instantiateNapiModule(module: WebAssembly.Module | BufferSource, options: Record<string, unknown>): Promise<{instance: WebAssembly.Instance; napiModule: {exports: Record<string, unknown>}}>;
}
