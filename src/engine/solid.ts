// Solid's JSX compiler (@solidjs/compiler, built on Oxc) as WebAssembly. Its own browser loader
// starts a pool of workers and hands them its shared memory, which a page that is not cross-origin
// isolated may not do. Its transform is synchronous and needs none of them, so this instantiates
// the module on the thread that asks, with the least memory the module takes.
import remapping from '@jridgewell/remapping';
import {createContext, emnapiAsyncWorkPlugin, emnapiTSFNPlugin, instantiateNapiModule, WASI} from '@napi-rs/wasm-runtime';

/** The pages of memory that the module of the pinned version asks for at least. A newer version may ask for more, which fails its load with a LinkError. */
const MEMORY_PAGES = 988;
/** 1 GiB. Shared memory reserves its maximum up front, and one module takes a few MB. */
const MAX_MEMORY_PAGES = 16384;

/** An inline source map at the end of a module, as tsrs writes it. */
const INLINE_MAP = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;

export interface SolidOptions {
    filename?: string;
    /** The package that compiled templates import their runtime from. */
    moduleName?: string;
    generate?: 'dom' | 'ssr' | 'universal' | 'dynamic';
    hydratable?: boolean;
    dev?: boolean;
}

export interface SolidCompiler {
    /**
     * Compiles the JSX of a module that tsrs wrote. The module's source map, which tsrs made of
     * the file it read, goes on mapping to that file. It throws on a syntax error.
     */
    compile(code: string, options: SolidOptions): string;
}

interface Transform {
    transform(code: string, options: SolidOptions & {sourceMap?: boolean}): {code: string; map?: string | null};
}

function fromBase64(text: string): string {
    return new TextDecoder().decode(Uint8Array.from(atob(text), char => char.charCodeAt(0)));
}

function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(binary);
}

/** Solid's map of its output, laid over the map of the module that it compiled. */
function compileWithMap(binding: Transform, code: string, options: SolidOptions): string {
    const inline = INLINE_MAP.exec(code);
    if (!inline) return binding.transform(code, options).code;
    const {code: out, map} = binding.transform(code.slice(0, inline.index), {...options, sourceMap: true});
    if (!map) return out;
    const combined = remapping([map, fromBase64(inline[1])], () => null);
    return `${out}\n//# sourceMappingURL=data:application/json;base64,${toBase64(JSON.stringify(combined))}\n`;
}

/** Instantiates the compiler from its module (compiler.wasm32-wasi.wasm). */
export async function loadSolidCompiler(module: WebAssembly.Module): Promise<SolidCompiler> {
    const memory = new WebAssembly.Memory({initial: MEMORY_PAGES, maximum: MAX_MEMORY_PAGES, shared: true});
    const {napiModule} = await instantiateNapiModule(module, {
        context: createContext(),
        asyncWorkPoolSize: 0,
        wasi: new WASI({version: 'preview1'}),
        plugins: [emnapiAsyncWorkPlugin, emnapiTSFNPlugin],
        overwriteImports(imports: Record<string, Record<string, unknown>>) {
            imports.env = {...imports.env, ...imports.napi, ...imports.emnapi, memory};
            return imports;
        },
        beforeInit({instance}: {instance: WebAssembly.Instance}) {
            for (const name of Object.keys(instance.exports)) {
                if (name.startsWith('__napi_register__')) (instance.exports[name] as () => void)();
            }
        },
    });
    const binding = napiModule.exports as unknown as Transform;
    return {compile: (code, options) => compileWithMap(binding, code, options)};
}
