// `node:fs` over the project's files: the synchronous calls, their promise forms and callbacks for
// the common ones.
import {allFiles, fail, isDirectory, isFile, makeDirectory, readDirectory, readFile, remove, toPath, writeFile} from './state.js';
import {globSync as matchGlob} from './glob.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A Uint8Array that prints as text, as a Buffer does. */
class Bytes extends Uint8Array {
    toString(encoding = 'utf8') {
        if (encoding === 'base64') return btoa(String.fromCharCode(...this));
        if (encoding === 'hex') return [...this].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return decoder.decode(this);
    }
}

function encodingOf(options) {
    return typeof options === 'string' ? options : options?.encoding;
}

function toBytes(data) {
    return typeof data === 'string' ? encoder.encode(data) : data;
}

function stats(path) {
    const file = isFile(path);
    if (!file && !isDirectory(path)) return undefined;
    const data = file ? readFile(path) : undefined;
    const size = data === undefined ? 0 : typeof data === 'string' ? encoder.encode(data).length : data.length;
    const epoch = new Date(0);
    return {
        isFile: () => file,
        isDirectory: () => !file,
        isSymbolicLink: () => false,
        size,
        mode: file ? 0o100644 : 0o40755,
        mtime: epoch, atime: epoch, ctime: epoch, birthtime: epoch,
        mtimeMs: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    };
}

export function existsSync(target) {
    const path = toPath(target);
    return isFile(path) || isDirectory(path);
}

export function readFileSync(target, options) {
    const path = toPath(target);
    if (isDirectory(path)) throw fail('EISDIR', 'read', path);
    const data = readFile(path);
    if (data === undefined) throw fail('ENOENT', 'open', path);
    const encoding = encodingOf(options);
    if (encoding) return typeof data === 'string' ? data : new Bytes(data).toString(encoding);
    return new Bytes(toBytes(data));
}

export function writeFileSync(target, data) {
    const path = toPath(target);
    if (isDirectory(path)) throw fail('EISDIR', 'open', path);
    writeFile(path, typeof data === 'string' ? data : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
}

export function appendFileSync(target, data) {
    const path = toPath(target);
    const before = readFile(path) ?? '';
    if (typeof before === 'string' && typeof data === 'string') return writeFile(path, before + data);
    const a = toBytes(before);
    const b = toBytes(data);
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    writeFile(path, joined);
}

export function mkdirSync(target, options) {
    const path = toPath(target);
    if (isFile(path)) throw fail('ENOTDIR', 'mkdir', path);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!options?.recursive && !isDirectory(parent)) throw fail('ENOENT', 'mkdir', path);
    makeDirectory(path);
    return undefined;
}

export function readdirSync(target, options) {
    const path = toPath(target);
    const names = readDirectory(path);
    if (!names) throw fail(isFile(path) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
    const prefix = path === '/' ? '/' : `${path}/`;
    let entries = names.map(name => ({name, path: prefix + name}));
    if (options?.recursive) {
        entries = allFiles().filter(file => file.startsWith(prefix)).sort().map(file => ({name: file.slice(prefix.length), path: file}));
    }
    if (!options?.withFileTypes) return entries.map(entry => entry.name);
    return entries.map(entry => {
        const file = isFile(entry.path);
        return {name: entry.name, parentPath: path, path, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false};
    });
}

export function statSync(target, options) {
    const path = toPath(target);
    const found = stats(path);
    if (!found && options?.throwIfNoEntry !== false) throw fail('ENOENT', 'stat', path);
    return found;
}

export const lstatSync = statSync;

export function accessSync(target) {
    const path = toPath(target);
    if (!isFile(path) && !isDirectory(path)) throw fail('ENOENT', 'access', path);
}

export function rmSync(target, options) {
    const path = toPath(target);
    if (!isFile(path) && !isDirectory(path)) {
        if (options?.force) return;
        throw fail('ENOENT', 'rm', path);
    }
    remove(path);
}

export const unlinkSync = rmSync;
export const rmdirSync = rmSync;

export function copyFileSync(from, to) {
    const data = readFile(toPath(from));
    if (data === undefined) throw fail('ENOENT', 'copyfile', toPath(from));
    writeFile(toPath(to), data);
}

export function renameSync(from, to) {
    copyFileSync(from, to);
    remove(toPath(from));
}

export function realpathSync(target) {
    return toPath(target);
}

export function globSync(pattern, options) {
    return matchGlob(pattern, options);
}

const sync = {
    access: accessSync, appendFile: appendFileSync, copyFile: copyFileSync, lstat: lstatSync, mkdir: mkdirSync,
    readFile: readFileSync, readdir: readdirSync, realpath: realpathSync, rename: renameSync, rm: rmSync,
    rmdir: rmdirSync, stat: statSync, unlink: unlinkSync, writeFile: writeFileSync,
};

export const promises = {};
const callbacks = {};
for (const [name, call] of Object.entries(sync)) {
    promises[name] = async (...args) => call(...args);
    callbacks[name] = (...args) => {
        const done = args.pop();
        let result;
        try {
            result = call(...args);
        } catch (error) {
            return queueMicrotask(() => done(error));
        }
        queueMicrotask(() => done(null, result));
    };
}

export const {access, appendFile, copyFile, lstat, mkdir, readFile: readFileCallback, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile: writeFileCallback} = callbacks;
export {readFileCallback as readFile, writeFileCallback as writeFile};
export const constants = {F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1};

export default {
    ...callbacks, promises, constants, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync,
    statSync, lstatSync, accessSync, rmSync, unlinkSync, rmdirSync, copyFileSync, renameSync, realpathSync, globSync,
};
