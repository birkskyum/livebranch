/** Expands `{a,b}` groups of a glob pattern. */
function braces(pattern: string): string[] {
    const match = /\{([^{}]*)\}/.exec(pattern);
    if (!match) return [pattern];
    const before = pattern.slice(0, match.index);
    const after = pattern.slice(match.index + match[0].length);
    return match[1].split(',').flatMap(option => braces(before + option + after));
}

function toRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*' && pattern[i + 1] === '*') {
            const slash = pattern[i + 2] === '/';
            out += slash ? '(?:[^/]+/)*' : '.*';
            i += slash ? 2 : 1;
        } else if (char === '*') {
            out += '[^/]*';
        } else if (char === '?') {
            out += '[^/]';
        } else {
            out += char.replace(/[.+^$()|\\[\]{}]/, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

/** The paths that a glob pattern matches. The pattern and the paths are absolute. */
export function matchGlob(pattern: string, paths: Iterable<string>): string[] {
    const tests = braces(pattern).map(toRegExp);
    const found: string[] = [];
    for (const path of paths) if (tests.some(test => test.test(path))) found.push(path);
    return found;
}
