// The `glob` package, and `fs.globSync`, over the project's files.
import {allFiles, normalize, state} from './state.js';

function braces(pattern) {
    const match = /\{([^{}]*)\}/.exec(pattern);
    if (!match) return [pattern];
    const [before, after] = [pattern.slice(0, match.index), pattern.slice(match.index + match[0].length)];
    return match[1].split(',').flatMap(option => braces(before + option + after));
}

function toRegExp(pattern, dot) {
    const start = dot ? '' : '(?!\\.)';
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*' && pattern[i + 1] === '*') {
            const slash = pattern[i + 2] === '/';
            out += slash ? `(?:${start}[^/]+/)*` : '.*';
            i += slash ? 2 : 1;
        } else if (char === '*') {
            out += `${out === '' || out.endsWith('/') ? start : ''}[^/]*`;
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '[') {
            const close = pattern.indexOf(']', i + 1);
            if (close < 0) out += '\\[';
            else {
                out += `[${pattern.slice(i + 1, close).replace(/^!/, '^')}]`;
                i = close;
            }
        } else {
            out += char.replace(/[.+^$()|\\{}]/, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

/** The project files that match a pattern, as paths relative to the working directory. */
export function globSync(patterns, options = {}) {
    const cwd = normalize(options.cwd ? (String(options.cwd).startsWith('/') ? String(options.cwd) : `${state.cwd}/${options.cwd}`) : state.cwd);
    const prefix = cwd === '/' ? '/' : `${cwd}/`;
    const expand = list => [list].flat().filter(Boolean).flatMap(braces).map(pattern => {
        const absolute = pattern.startsWith('/');
        return {absolute, test: toRegExp(absolute ? pattern.slice(1) : pattern.replace(/^(?:\.\/)+/, ''), options.dot)};
    });
    const wanted = expand(patterns);
    const ignored = expand(options.ignore);
    const found = [];
    for (const file of allFiles()) {
        const relative = file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
        const matches = list => list.some(({absolute, test}) => absolute ? test.test(file.slice(1)) : relative !== undefined && test.test(relative));
        if (!matches(wanted) || matches(ignored)) continue;
        found.push(options.absolute || relative === undefined ? file : relative);
    }
    return found.sort();
}

export async function glob(patterns, options) {
    return globSync(patterns, options);
}

export const sync = globSync;
glob.sync = globSync;
export default glob;
