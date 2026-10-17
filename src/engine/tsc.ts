import {EXIT_CRASHED, NotFoundError, makeRequest, parseReply, runTscAsync, type Diagnostic, type HostFileSystem, type WasmModule} from '@tsrs/wasm/core';
import {isSourcePath} from './resolve.ts';
import type {Vfs} from './vfs.ts';

export type {Diagnostic, WasmModule};

export interface TscRun {
    exitCode: number;
    /** What the compiler printed when it gave up in the middle of the run. What it wrote and reported is then not all. */
    crash: string | undefined;
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
const encoder = new TextEncoder();
/** What V8 says when it has no memory left for a buffer. */
const OUT_OF_MEMORY = /Invalid array buffer length|Array buffer allocation failed/;

/**
 * Runs tsrs once over the project's files. The compiler cannot wait for a fetch, so a file that is
 * not loaded is a miss. tsrs takes an error of the host for a failed read and goes on, so a run
 * past its budget finds no more files, and ends with a `TooLargeError` after. So does a run that
 * had no memory left to write its output.
 */
export async function tsc(module: WasmModule, vfs: Vfs, args: string[], options: TscOptions = {}): Promise<TscRun> {
    const {cwd = '/', extra = new Map<string, string>(), json = false, writeToProject = false, visible = () => true, budget = Infinity} = options;
    const written = new Map<string, string>();
    const read = new Set<string>();
    const misses = new Set<string>();
    let spent = 0;
    let tooLarge = false;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const extraDirs = new Set<string>();
    for (const path of extra.keys()) {
        for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) extraDirs.add(path.slice(0, at));
    }

    const bytes = (data: string | Uint8Array) => typeof data === 'string' ? encoder.encode(data) : data;
    const fs: HostFileSystem = {
        readFile(path) {
            const own = written.get(path) ?? extra.get(path);
            if (own !== undefined) return encoder.encode(own);
            if (tooLarge || !visible(path)) throw new NotFoundError(path);
            const data = vfs.read(path);
            if (data === undefined) {
                if (vfs.remote.has(path)) misses.add(path);
                throw new NotFoundError(path);
            }
            if (!read.has(path)) {
                read.add(path);
                spent += sourceCost(path, data.length);
                if (spent > budget) {
                    tooLarge = true;
                    throw new NotFoundError(path);
                }
            }
            return bytes(data);
        },
        stat(path) {
            if (written.has(path) || extra.has(path) || (vfs.isFile(path) && visible(path))) return {kind: 'f', size: 0, mtimeNs: 0n};
            if (vfs.isDirectory(path) || extraDirs.has(path)) return {kind: 'd', size: 0, mtimeNs: 0n};
            throw new NotFoundError(path);
        },
        readDir(path) {
            const entries = vfs.readDirectory(path) ?? (extraDirs.has(path) ? [] : undefined);
            if (!entries) throw new NotFoundError(path);
            const prefix = path === '/' ? '/' : `${path}/`;
            for (const key of extra.keys()) {
                if (!key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                const name = rest.split('/')[0];
                if (!entries.some(entry => entry.name === name)) entries.push({name, kind: rest.includes('/') ? 'directory' : 'file'});
            }
            return entries.map(entry => [entry.kind === 'directory' ? 'd' : entry.kind === 'file' ? 'f' : 'o', entry.name]);
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
        chtimes() {},
    };

    const {exitCode, reply} = await runTscAsync(module, makeRequest(args, {cwd, json}), fs, {
        stdout: chunk => stdout.push(chunk),
        stderr: chunk => stderr.push(chunk),
    });
    if (tooLarge) throw new TooLargeError();
    const diagnostics = json ? parseReply(reply) : [];
    // tsrs reports each failed write and goes on, so a run out of memory would report hundreds.
    if (diagnostics.some(diagnostic => OUT_OF_MEMORY.test(diagnostic.text))) throw new TooLargeError();
    const text = (chunks: Uint8Array[]) => chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    const errors = text(stderr);
    // A panic or a trap, such as a stack overflow or running out of memory, ends the run with its own exit code.
    const crash = exitCode === EXIT_CRASHED ? errors.trim().split('\n')[0].replace(/^error:\s*/, '') || 'The compiler crashed.' : undefined;
    return {exitCode, crash, diagnostics, written, read, misses, stdout: text(stdout), stderr: errors};
}
