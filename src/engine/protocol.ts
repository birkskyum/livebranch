import type {Problem} from './build.ts';
import type {LinkSpec} from './spec.ts';

export interface Step {
    name: string;
    detail: string | undefined;
    ms: number;
}

/** What the app shows about an opened project. */
export interface SessionInfo {
    id: string;
    /** The URL of the built page. */
    url: string;
    label: string;
    /** The GitHub source as the link should name it. A pasted URL may have needed sorting out. */
    gh: string | undefined;
    commit: string | undefined;
    entry: string;
    problems: Problem[];
    steps: Step[];
    /** The time from opening to the published build. Steps overlap, so it is less than their sum. */
    ms: number;
    /** Source files that were compiled. */
    sources: number;
    /** The output of the setup commands. */
    log: string;
    /** The build was already in this browser's cache. */
    cached: boolean;
}

export interface OpenOptions {
    /** The URL of the app, ending with a slash. */
    base: string;
    /** Reuse a finished build of the same inputs. */
    cache: boolean;
}

export interface FileEntry {
    path: string;
    loaded: boolean;
}

/** The calls that the app makes into the engine worker. */
export interface EngineCalls {
    open(spec: LinkSpec, options: OpenOptions): SessionInfo;
    /** Writes edited files into the open project and builds it again, without the setup commands. */
    update(files: Record<string, string>): SessionInfo;
    /** Type checks the page and the link's files against the project. */
    check(): Problem[];
    files(): FileEntry[];
    read(path: string): string | undefined;
    exec(command: string): {stdout: string; stderr: string; exitCode: number};
}

export type Request = {[K in keyof EngineCalls]: {id: number; call: K; args: Parameters<EngineCalls[K]>}}[keyof EngineCalls];

export type Reply =
    | {id: number; result: unknown}
    | {id: number; error: string}
    | {event: 'step'; name: string; detail: string | undefined}
    | {event: 'output'; stream: 'stdout' | 'stderr'; text: string};
