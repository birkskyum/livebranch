import {dirname} from './path.ts';

export type FileData = string | Uint8Array;

/** Where the files of a project come from when they are not held in memory yet. */
export interface RemoteSource {
    /** Every file path of the project, relative to its root. */
    list(): Promise<string[]>;
    fetch(path: string): Promise<FileData>;
    /** The content of a file that may not exist, in one attempt and without the file list. */
    probe(path: string): Promise<FileData | undefined>;
    /** A URL that a browser can load the file from, for files the build never touched. */
    url(path: string): string;
}

type EntryKind = 'file' | 'directory';

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pbf|mvt|mlt|woff2?|ttf|otf|eot|wasm|zip|gz|tgz|pdf|mp[34]|webm|ogg|bin)$/i;

/** Hosts serve many HTTP/2 streams at once. More than this many only queue up in the browser. */
const MAX_FETCHES = 64;

export function isBinaryPath(path: string): boolean {
    return BINARY.test(path);
}

/**
 * The project's files. Loaded files are in `files`. Paths in `remote` are known to exist at the
 * source and are fetched by `load` when something needs them.
 */
export class Vfs {
    readonly files = new Map<string, FileData>();
    readonly remote = new Set<string>();
    source: RemoteSource | undefined;
    private readonly directories = new Map<string, Map<string, EntryKind>>([['/', new Map()]]);
    /** Fetches that are under way, so that two callers share one. */
    private readonly loading = new Map<string, Promise<void>>();
    private readonly queue: (() => void)[] = [];
    private active = 0;

    private index(path: string, leaf: EntryKind = 'file'): void {
        let child = path;
        let kind = leaf;
        while (child !== '/') {
            const parent = dirname(child);
            let entries = this.directories.get(parent);
            const known = entries !== undefined;
            if (!entries) {
                entries = new Map();
                this.directories.set(parent, entries);
            }
            entries.set(child.slice(parent === '/' ? 1 : parent.length + 1), kind);
            if (known) return;
            child = parent;
            kind = 'directory';
        }
    }

    makeDirectory(path: string): void {
        if (this.directories.has(path)) return;
        this.directories.set(path, new Map());
        this.index(path, 'directory');
    }

    /** Registers paths that the remote source has, without fetching them. */
    addRemote(paths: Iterable<string>): void {
        for (const path of paths) {
            if (this.files.has(path)) continue;
            this.remote.add(path);
            this.index(path);
        }
    }

    write(path: string, data: FileData): void {
        this.files.set(path, data);
        this.remote.delete(path);
        this.index(path);
    }

    remove(path: string): void {
        const prefix = `${path}/`;
        for (const key of [...this.files.keys(), ...this.remote]) {
            if (key !== path && !key.startsWith(prefix)) continue;
            this.files.delete(key);
            this.remote.delete(key);
        }
        for (const key of [...this.directories.keys()]) {
            if (key === path || key.startsWith(prefix)) this.directories.delete(key);
        }
        const parent = this.directories.get(dirname(path));
        parent?.delete(path.slice(path.lastIndexOf('/') + 1));
    }

    /** The content of a loaded file. */
    read(path: string): FileData | undefined {
        return this.files.get(path);
    }

    readText(path: string): string | undefined {
        const data = this.files.get(path);
        return data === undefined || typeof data === 'string' ? data : new TextDecoder().decode(data);
    }

    isFile(path: string): boolean {
        return this.files.has(path) || this.remote.has(path);
    }

    isDirectory(path: string): boolean {
        return this.directories.has(path);
    }

    readDirectory(path: string): {name: string; kind: EntryKind}[] | undefined {
        const entries = this.directories.get(path);
        return entries && [...entries].map(([name, kind]) => ({name, kind}));
    }

    /** Every file path, loaded or not, sorted. */
    paths(): string[] {
        return [...this.files.keys(), ...this.remote].sort();
    }

    /** Fetches the given files from the remote source. Paths that are loaded or unknown are skipped. */
    async load(paths: Iterable<string>): Promise<void> {
        const source = this.source;
        if (!source) return;
        const waiting: Promise<void>[] = [];
        for (const path of new Set(paths)) {
            if (!this.remote.has(path)) continue;
            let fetching = this.loading.get(path);
            if (!fetching) {
                fetching = this.slot().then(() => source.fetch(path.slice(1))).then(data => {
                    if (this.remote.has(path)) this.write(path, data);
                }).finally(() => {
                    this.loading.delete(path);
                    this.release();
                });
                this.loading.set(path, fetching);
            }
            waiting.push(fetching);
        }
        await Promise.all(waiting);
    }

    /** Waits for one of the limited number of concurrent fetches. */
    private slot(): Promise<void> {
        if (this.active < MAX_FETCHES) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise(resolve => this.queue.push(resolve));
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) next();
        else this.active--;
    }
}
