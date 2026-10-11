// Reads a repository on GitHub through git's own protocol (smart HTTP, version 2): which commit a
// ref points at, and which files a commit has. GitHub's REST API answers the same questions, but
// allows an anonymous address only 60 requests an hour. The git endpoint has no such allowance and
// needs no token. It sends no CORS headers, so this runs on a server, not in a browser.
import {ZStream, Z_FINISH, Z_STREAM_END, zlibInflate, zlibInflateEnd, zlibInflateInit2} from 'pako';
import type {Fetch} from './github.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FLUSH = '0000';
const DELIMITER = '0001';

const COMMIT = 1;
const TREE = 2;
const OFFSET_DELTA = 6;
const REF_DELTA = 7;
const TYPE_NAMES: Record<number, string> = {1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag'};

function pkt(line: string): string {
    return (encoder.encode(line).length + 4).toString(16).padStart(4, '0') + line;
}

/** The payloads of the pkt-lines in a response. Flush and delimiter packets are skipped. */
function* pktLines(data: Uint8Array): Generator<Uint8Array> {
    for (let at = 0; at + 4 <= data.length;) {
        const length = parseInt(decoder.decode(data.subarray(at, at + 4)), 16);
        if (Number.isNaN(length)) throw new Error('GitHub sent something that is not a git response.');
        if (length < 4) {
            at += 4;
            continue;
        }
        yield data.subarray(at + 4, at + length);
        at += length;
    }
}

async function uploadPack(fetch: Fetch, owner: string, repo: string, command: string, args: string[]): Promise<Uint8Array> {
    const body = pkt(`command=${command}\n`) + pkt('agent=livebranch\n') + pkt('object-format=sha1\n') + DELIMITER + args.map(arg => pkt(`${arg}\n`)).join('') + FLUSH;
    const response = await fetch(`https://github.com/${owner}/${repo}.git/git-upload-pack`, {
        method: 'POST',
        headers: {'content-type': 'application/x-git-upload-pack-request', 'accept': 'application/x-git-upload-pack-result', 'git-protocol': 'version=2', 'user-agent': 'git/livebranch'},
        body,
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status} for ${owner}/${repo}.`), {status: response.status});
    return new Uint8Array(await response.arrayBuffer());
}

/** The commit that a branch, a tag, `HEAD` or `pull/123/head` points at, or undefined when there is no such ref. */
export async function resolveRef(fetch: Fetch, owner: string, repo: string, ref: string): Promise<string | undefined> {
    const candidates = ref === 'HEAD' ? ['HEAD'] : /^pull\/\d+\/head$/.test(ref) ? [`refs/${ref}`] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
    const data = await uploadPack(fetch, owner, repo, 'ls-refs', ['peel', ...candidates.map(name => `ref-prefix ${name}`)]);
    const found = new Map<string, string>();
    for (const line of pktLines(data)) {
        const [sha, name, ...attributes] = decoder.decode(line).trim().split(' ');
        // An annotated tag points at a tag object. Its commit is the peeled value.
        const peeled = attributes.find(attribute => attribute.startsWith('peeled:'))?.slice(7);
        found.set(name, peeled ?? sha);
    }
    for (const name of candidates) {
        const commit = found.get(name);
        if (commit) return commit;
    }
    return undefined;
}

interface PackObject {
    type: number;
    data: Uint8Array;
    baseOffset: number | undefined;
    baseSha: string | undefined;
}

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The objects of a packfile, by their offset in it. */
function readPack(pack: Uint8Array): Map<number, PackObject> {
    if (decoder.decode(pack.subarray(0, 4)) !== 'PACK') throw new Error('GitHub sent no packfile.');
    const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
    const objects = new Map<number, PackObject>();
    let at = 12;
    for (let index = 0; index < count; index++) {
        const start = at;
        let byte = pack[at++];
        const type = (byte >> 4) & 7;
        let size = byte & 15;
        for (let shift = 4; byte & 0x80; shift += 7) {
            byte = pack[at++];
            size += (byte & 0x7f) * 2 ** shift;
        }
        let baseOffset: number | undefined;
        let baseSha: string | undefined;
        if (type === OFFSET_DELTA) {
            byte = pack[at++];
            let back = byte & 0x7f;
            while (byte & 0x80) {
                byte = pack[at++];
                back = (back + 1) * 128 + (byte & 0x7f);
            }
            baseOffset = start - back;
        } else if (type === REF_DELTA) {
            baseSha = hex(pack.subarray(at, at + 20));
            at += 20;
        }
        // The compressed data has no length of its own, so the inflater says how much it took.
        const stream = new ZStream();
        zlibInflateInit2(stream, 15);
        stream.input = pack;
        stream.next_in = at;
        stream.avail_in = pack.length - at;
        stream.output = new Uint8Array(size);
        stream.next_out = 0;
        stream.avail_out = size;
        if (zlibInflate(stream, Z_FINISH) !== Z_STREAM_END) throw new Error('A git object did not decompress.');
        objects.set(start, {type, data: stream.output, baseOffset, baseSha});
        at = stream.next_in;
        zlibInflateEnd(stream);
    }
    return objects;
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
    let at = 0;
    const size = () => {
        let value = 0;
        for (let shift = 0; ; shift += 7) {
            const byte = delta[at++];
            value += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) return value;
        }
    };
    size();
    const out = new Uint8Array(size());
    let written = 0;
    while (at < delta.length) {
        const op = delta[at++];
        if (op & 0x80) {
            let offset = 0;
            let length = 0;
            if (op & 1) offset = delta[at++];
            if (op & 2) offset += delta[at++] * 2 ** 8;
            if (op & 4) offset += delta[at++] * 2 ** 16;
            if (op & 8) offset += delta[at++] * 2 ** 24;
            if (op & 16) length = delta[at++];
            if (op & 32) length += delta[at++] * 2 ** 8;
            if (op & 64) length += delta[at++] * 2 ** 16;
            if (!length) length = 0x10000;
            out.set(base.subarray(offset, offset + length), written);
            written += length;
        } else {
            out.set(delta.subarray(at, at + op), written);
            at += op;
            written += op;
        }
    }
    return out;
}

async function sha1(type: number, data: Uint8Array): Promise<string> {
    const header = encoder.encode(`${TYPE_NAMES[type]} ${data.length}\0`);
    const whole = new Uint8Array(header.length + data.length);
    whole.set(header);
    whole.set(data, header.length);
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole)));
}

/**
 * Every file path of a commit. It fetches the commit without its history and without file
 * contents, which leaves the directory listings, and walks them.
 */
export async function listTree(fetch: Fetch, owner: string, repo: string, commit: string): Promise<string[]> {
    const response = await uploadPack(fetch, owner, repo, 'fetch', [`want ${commit}`, 'deepen 1', 'filter blob:none', 'ofs-delta', 'no-progress', 'done']);
    const chunks: Uint8Array[] = [];
    let inPack = false;
    for (const line of pktLines(response)) {
        if (!inPack) {
            inPack = decoder.decode(line).trim() === 'packfile';
        } else if (line[0] === 1) {
            chunks.push(line.subarray(1));
        } else if (line[0] === 3) {
            throw new Error(`GitHub: ${decoder.decode(line.subarray(1)).trim()}`);
        }
    }
    const pack = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let filled = 0;
    for (const chunk of chunks) {
        pack.set(chunk, filled);
        filled += chunk.length;
    }
    if (!pack.length) throw new Error(`GitHub sent nothing for ${commit.slice(0, 7)} of ${owner}/${repo}.`);

    // Objects stored as a difference to another object are rebuilt, a base before what builds on it.
    const objects = readPack(pack);
    const bySha = new Map<string, PackObject>();
    const resolved = new Set<PackObject>();
    for (let progress = true; progress && resolved.size < objects.size;) {
        progress = false;
        for (const object of objects.values()) {
            if (resolved.has(object)) continue;
            const base = object.baseOffset !== undefined ? objects.get(object.baseOffset) : object.baseSha !== undefined ? bySha.get(object.baseSha) : undefined;
            if (object.type === OFFSET_DELTA || object.type === REF_DELTA) {
                if (!base || !resolved.has(base)) continue;
                object.data = applyDelta(base.data, object.data);
                object.type = base.type;
            }
            bySha.set(await sha1(object.type, object.data), object);
            resolved.add(object);
            progress = true;
        }
    }

    const root = /^tree ([0-9a-f]{40})/.exec(decoder.decode(bySha.get(commit)?.type === COMMIT ? bySha.get(commit)!.data : new Uint8Array()))?.[1];
    if (!root) throw new Error(`${commit.slice(0, 7)} is not a commit of ${owner}/${repo}.`);
    const paths: string[] = [];
    const walk = (sha: string, prefix: string) => {
        const tree = bySha.get(sha);
        if (!tree || tree.type !== TREE) return;
        const {data} = tree;
        for (let at = 0; at < data.length;) {
            const space = data.indexOf(32, at);
            const end = data.indexOf(0, space);
            const mode = decoder.decode(data.subarray(at, space));
            const name = decoder.decode(data.subarray(space + 1, end));
            const child = hex(data.subarray(end + 1, end + 21));
            at = end + 21;
            if (mode === '40000') walk(child, `${prefix}${name}/`);
            else if (mode !== '160000') paths.push(prefix + name);
        }
    };
    walk(root, '');
    return paths;
}
