/** The tarball of a version of a package on the npm registry, which any origin may read. */
export function tarballUrl(name: string, version: string): string {
    return `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

/** The files of a gzipped tar archive, as an npm package is one, without the folder they are in. */
export async function untar(body: ReadableStream<Uint8Array>, keep: (path: string) => boolean): Promise<Map<string, string>> {
    const stream = body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const decoder = new TextDecoder();
    const text = (start: number, length: number) => decoder.decode(bytes.subarray(start, start + length)).replace(/\0.*$/, '');
    const files = new Map<string, string>();
    let longPath: string | undefined;
    for (let at = 0; at + 512 <= bytes.length;) {
        const name = text(at, 100);
        if (!name) break;
        const size = parseInt(text(at + 124, 12), 8) || 0;
        const type = text(at + 156, 1);
        const prefix = text(at + 345, 155);
        const data = bytes.subarray(at + 512, at + 512 + size);
        if (type === 'x') {
            longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(data))?.[1];
        } else {
            const path = (longPath ?? (prefix ? `${prefix}/${name}` : name)).replace(/^[^/]+\//, '');
            longPath = undefined;
            if ((type === '0' || type === '') && keep(path)) files.set(path, decoder.decode(data));
        }
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}
