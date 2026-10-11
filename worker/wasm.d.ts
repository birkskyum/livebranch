declare module '*.wasm' {
    const module: WebAssembly.Module;
    export default module;
}

/** The part of a Worker's execution context that this Worker uses. */
interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

interface CacheStorage {
    /** The Worker's cache at the edge. */
    readonly default: Cache;
}
