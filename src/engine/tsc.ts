import {runTscAsync, type Diagnostic, type HostFileSystem, type WasmModule} from '../vendor/tsc-rs/core.js';
import {isSourcePath} from './resolve.ts';
import type {Vfs} from './vfs.ts';

export type {Diagnostic, WasmModule};

export interface TscRun {
    exitCode: number;
    diagnostics: Diagnostic[];
    /** Files that the compiler wrote. */
    written: Map<string, string>;
    /** Files that the compiler read. */
    read: Set<string>;
    /** Files that the compiler asked for and that the source has, but that are not loaded yet. */
    misses: Set<string>;
    stdout: string;
    stderr: string;
}

export interface TscOptions {
    cwd?: string;
    /** Files that exist for this run only, such as a generated tsconfig. */
    extra?: Map<string, string>;
    /** Return the diagnostics as objects instead of printing them. */
    json?: boolean;
    /** Write emitted files into the project instead of only returning them. */
    writeToProject?: boolean;
    /** Project files for which this returns false do not exist for the run. */
    visible?(path: string): boolean;
    /** The most source, by `sourceCost`, that the run may read. Past it the run stops with a `TooLargeError`. */
    budget?: number;
}

/** A program that is larger than the environment has memory for. */
export class TooLargeError extends Error {
    constructor() {
        super('The program is too large to compile here.');
    }
}

/**
 * What a file adds to a program, in characters of source. The compiler's memory grows with it. A
 * declaration file has no bodies to compile and counts for a quarter. Other files count for nothing.
 */
export function sourceCost(path: string, length: number): number {
    if (isSourcePath(path)) return length;
    return /\.d\.[cm]?ts$/.test(path) ? length / 4 : 0;
}

const fileDecoder = new TextDecoder('utf-8', {ignoreBOM: true});

/** Runs tsc-rs once over the project's files. The compiler cannot wait for a fetch, so a file that is not loaded is a miss. */
export async function tsc(module: WasmModule, vfs: Vfs, args: string[], options: TscOptions = {}): Promise<TscRun> {
    const {cwd = '/', extra = new Map<string, string>(), json = false, writeToProject = false, visible = () => true, budget = Infinity} = options;
    const written = new Map<string, string>();
    const read = new Set<string>();
    const misses = new Set<string>();
    let spent = 0;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const extraDirs = new Set<string>();
    for (const path of extra.keys()) {
        for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) extraDirs.add(path.slice(0, at));
    }

    const fs: HostFileSystem = {
        readFile(path) {
            const own = written.get(path) ?? extra.get(path);
            if (own !== undefined) return own;
            if (!visible(path)) return undefined;
            const data = vfs.read(path);
            if (data === undefined) {
                if (vfs.remote.has(path)) misses.add(path);
            } else if (!read.has(path)) {
                read.add(path);
                spent += sourceCost(path, data.length);
                if (spent > budget) throw new TooLargeError();
            }
            return data;
        },
        stat(path) {
            if (written.has(path) || extra.has(path) || (vfs.isFile(path) && visible(path))) return {isDirectory: false, mtimeMs: 0};
            if (vfs.isDirectory(path) || extraDirs.has(path)) return {isDirectory: true, mtimeMs: 0};
            return undefined;
        },
        readDirectory(path) {
            const entries = vfs.readDirectory(path) ?? (extraDirs.has(path) ? [] : undefined);
            if (!entries) return undefined;
            const prefix = path === '/' ? '/' : `${path}/`;
            for (const key of extra.keys()) {
                if (!key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                const name = rest.split('/')[0];
                if (!entries.some(entry => entry.name === name)) entries.push({name, kind: rest.includes('/') ? 'directory' : 'file'});
            }
            return entries;
        },
        realpath: path => path,
        writeFile(path, data, append) {
            const text = fileDecoder.decode(data);
            const next = append ? (written.get(path) ?? vfs.readText(path) ?? '') + text : text;
            written.set(path, next);
            if (writeToProject) vfs.write(path, next);
        },
        remove(path) {
            written.delete(path);
            if (writeToProject) vfs.remove(path);
        },
    };

    const {exitCode, diagnostics} = await runTscAsync(module, {
        args,
        cwd,
        fs,
        diagnosticsJson: json,
        stdout: chunk => stdout.push(chunk),
        stderr: chunk => stderr.push(chunk),
    });
    const text = (chunks: Uint8Array[]) => chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    return {exitCode, diagnostics: diagnostics ?? [], written, read, misses, stdout: text(stdout), stderr: text(stderr)};
}
