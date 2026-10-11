// `node:path` for posix paths.
import {state} from './state.js';

export const sep = '/';
export const delimiter = ':';

export function normalize(path) {
    if (path === '') return '.';
    const absolute = path.startsWith('/');
    const trailing = path.endsWith('/');
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
            else if (!absolute) parts.push('..');
        } else {
            parts.push(part);
        }
    }
    let out = parts.join('/');
    if (trailing && out) out += '/';
    return absolute ? `/${out}` : out || '.';
}

export function join(...parts) {
    return normalize(parts.filter(part => part !== '').join('/'));
}

export function isAbsolute(path) {
    return path.startsWith('/');
}

export function resolve(...parts) {
    let out = '';
    for (let i = parts.length - 1; i >= 0 && !out.startsWith('/'); i--) {
        if (parts[i]) out = out ? `${parts[i]}/${out}` : parts[i];
    }
    if (!out.startsWith('/')) out = `${state.cwd}/${out}`;
    const normal = normalize(out);
    return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

export function dirname(path) {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const index = trimmed.lastIndexOf('/');
    if (index < 0) return '.';
    return index === 0 ? '/' : trimmed.slice(0, index);
}

export function basename(path, suffix) {
    const name = path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1);
    return suffix && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
}

export function extname(path) {
    const name = basename(path);
    const index = name.lastIndexOf('.');
    return index <= 0 ? '' : name.slice(index);
}

export function relative(from, to) {
    const a = resolve(from).split('/').filter(Boolean);
    const b = resolve(to).split('/').filter(Boolean);
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    return [...Array(a.length - shared).fill('..'), ...b.slice(shared)].join('/');
}

export function parse(path) {
    const base = basename(path);
    const ext = extname(path);
    const dir = dirname(path);
    return {root: path.startsWith('/') ? '/' : '', dir: dir === '.' && !path.includes('/') ? '' : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base};
}

export function format(parts) {
    const base = parts.base ?? `${parts.name ?? ''}${parts.ext ?? ''}`;
    const dir = parts.dir ?? parts.root ?? '';
    return dir ? (dir.endsWith('/') ? dir + base : `${dir}/${base}`) : base;
}

const path = {sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format};
path.posix = path;
export const posix = path;
export default path;
