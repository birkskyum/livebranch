/** Posix path helpers for the virtual file system. Paths are absolute and use `/`. */

export function normalize(path: string): string {
    const absolute = path.startsWith('/');
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
            else if (!absolute) parts.push('..');
            continue;
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    return absolute ? `/${joined}` : joined || '.';
}

export function join(...parts: string[]): string {
    return normalize(parts.filter(Boolean).join('/'));
}

/** Resolves `path` against the directory `base`. */
export function resolve(base: string, path: string): string {
    return path.startsWith('/') ? normalize(path) : normalize(`${base}/${path}`);
}

export function dirname(path: string): string {
    const index = path.lastIndexOf('/');
    if (index < 0) return '.';
    return index === 0 ? '/' : path.slice(0, index);
}

export function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** The extension with its dot, or an empty string. */
export function extname(path: string): string {
    const name = basename(path);
    const index = name.lastIndexOf('.');
    return index <= 0 ? '' : name.slice(index);
}

/** The relative path from the directory `from` to `to`, always starting with `./` or `../`. */
export function relative(from: string, to: string): string {
    const a = normalize(from).split('/').filter(Boolean);
    const b = normalize(to).split('/').filter(Boolean);
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    const up = a.length - shared;
    const rest = b.slice(shared).join('/');
    return up ? `${'../'.repeat(up)}${rest}` : `./${rest}`;
}
