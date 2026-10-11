/** What a share link says: where the project comes from and what to run. */
export interface LinkSpec {
    /** A GitHub source, `owner/repo@ref` or `owner/repo@ref/sub/dir`. */
    gh?: string;
    /** A gist id, optionally `id@revision`. Its files are laid over the GitHub source. */
    gist?: string;
    /** Files carried in the link itself, laid over everything else. */
    files?: Record<string, string>;
    /** The HTML page to open. */
    entry?: string;
    /** The adapter to use, by name, or `none` to turn off the lookup by package name. */
    adapter?: string;
    /**
     * A second ref to run the same page against, shown next to the first: a ref of the same
     * repository (`main`) or a full source (`owner/repo@ref`).
     */
    base?: string;
}

/** A project's `livebranch.json` (at its root or in `.github`), or its adapter. */
export interface ProjectConfig {
    /** The HTML page to open, `index.html` by default. */
    entry?: string;
    /** Shell commands that run before the build, for example code generators. */
    setup?: string[];
    /** Bare import specifiers that point at a project file or a URL. */
    alias?: Record<string, string>;
    /** Modules that nothing imports statically but the page loads, such as worker scripts. */
    entries?: string[];
    /** Extra files, written when the project does not have them. */
    files?: Record<string, string>;
    /**
     * The page for an entry that is a script instead of a page. `<!--entry-->` marks where the
     * script goes.
     */
    template?: string;
    /** Where bare imports of npm packages load from. */
    cdn?: 'esm.sh' | 'jsdelivr';
    /** Generated files that are taken from the project's published npm package. */
    prebuilt?: Prebuilt[];
}

/**
 * Files that a generator makes and that the browser cannot make, for example because the generator
 * downloads from a host without CORS. They come from the release that the project's package.json
 * names, or else from the latest one.
 */
export interface Prebuilt {
    files: string[];
    /** The generator's sources. A warning is reported when they differ from the release's. */
    inputs?: string[];
}

export interface GithubRef {
    owner: string;
    repo: string;
    ref: string;
    /** A directory inside the repository to use as the project root, without slashes at the ends. */
    subdir: string;
}

/**
 * Parses `owner/repo@ref`. `owner/repo@pull/123` is the head of a pull request, also one from a
 * fork. A directory of the repository follows a commit hash after a slash, or any ref after a
 * colon (`owner/repo@ref:sub/dir`).
 */
export function parseGithubRef(text: string): GithubRef {
    const match = /^([^/@\s]+)\/([^/@\s]+?)(?:@([^:\s]+?))?(?::(.*))?$/.exec(text.trim());
    if (!match) throw new Error(`Not a GitHub source: ${text}. Expected owner/repo@ref.`);
    const [, owner, repo, rest = 'HEAD', explicitSubdir] = match;
    let ref = rest;
    let subdir = explicitSubdir ?? '';
    if (explicitSubdir === undefined && /^[0-9a-f]{40}\//.test(rest)) {
        ref = rest.slice(0, 40);
        subdir = rest.slice(41);
    }
    const pull = /^pull\/(\d+)(?:\/head)?$/.exec(ref);
    if (pull) ref = `pull/${pull[1]}/head`;
    return {owner, repo, ref, subdir: subdir.replace(/^\/+|\/+$/g, '')};
}

/**
 * Turns what people paste into a source: `owner/repo@ref` as it is, or the URL of a repository, a
 * branch, a commit, a pull request or a file on github.com. A file URL also names the page to
 * open. In a file URL the ref is taken to be one path segment.
 */
export function normalizeGithubSource(text: string): {gh: string; entry?: string} {
    const url = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/([^?#]*))?(?:[?#].*)?$/.exec(text.trim());
    if (!url) return {gh: text.trim()};
    const [, owner, repo, rest = ''] = url;
    const base = `${owner}/${repo}`;
    const pull = /^pull\/(\d+)/.exec(rest);
    if (pull) return {gh: `${base}@pull/${pull[1]}`};
    const commit = /^commit\/([0-9a-f]{7,40})/.exec(rest);
    if (commit) return {gh: `${base}@${commit[1]}`};
    const tree = /^tree\/(.+?)\/?$/.exec(rest);
    if (tree) return {gh: `${base}@${tree[1]}`};
    const blob = /^blob\/([^/]+)\/(.+)$/.exec(rest);
    if (blob) return {gh: `${base}@${blob[1]}`, entry: blob[2]};
    return {gh: base};
}

/** The full source of the ref that a link compares against, if it names one. */
export function baseSource(spec: LinkSpec): string | undefined {
    if (!spec.base) return undefined;
    if (/^(?:https?:\/\/)?github\.com\//.test(spec.base) || /^[^/@\s]+\/[^/@\s]+@/.test(spec.base)) return normalizeGithubSource(spec.base).gh;
    if (!spec.gh) return undefined;
    const {owner, repo} = parseGithubRef(spec.gh);
    return `${owner}/${repo}@${spec.base}`;
}

const PARAMS = ['gh', 'base', 'gist', 'entry', 'adapter'] as const;

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const blob = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(blob).arrayBuffer());
}

/** Packs files into the `code` parameter of a link: JSON, deflate, base64url. */
export async function encodeFiles(files: Record<string, string>): Promise<string> {
    const json = new TextEncoder().encode(JSON.stringify(files));
    return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeFiles(code: string): Promise<Record<string, string>> {
    const json = await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(json));
}

/** The link parameters of a spec, for the fragment of the app URL. */
export async function encodeSpec(spec: LinkSpec): Promise<string> {
    const params = new URLSearchParams();
    for (const key of PARAMS) {
        const value = spec[key];
        if (value) params.set(key, value);
    }
    if (spec.files && Object.keys(spec.files).length) params.set('code', await encodeFiles(spec.files));
    return params.toString().replaceAll('%2F', '/').replaceAll('%40', '@').replaceAll('%3A', ':');
}

/** Reads a spec from the query string and the fragment of a URL. The fragment wins. */
export async function decodeSpec(search: string, hash: string): Promise<LinkSpec> {
    const params = new URLSearchParams(search);
    for (const [key, value] of new URLSearchParams(hash.replace(/^#/, ''))) params.set(key, value);
    const spec: LinkSpec = {};
    for (const key of PARAMS) {
        const value = params.get(key);
        if (value) spec[key] = value;
    }
    if (spec.gh) {
        const source = normalizeGithubSource(spec.gh);
        spec.gh = source.gh;
        spec.entry ??= source.entry;
    }
    const code = params.get('code');
    if (code) spec.files = await decodeFiles(code);
    return spec;
}

export function isEmptySpec(spec: LinkSpec): boolean {
    return !spec.gh && !spec.gist && !(spec.files && Object.keys(spec.files).length);
}
