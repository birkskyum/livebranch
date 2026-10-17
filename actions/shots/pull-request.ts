// What the two steps of the pictures share: the livebranch link of a pull request, and the comment.
import {demoFiles} from '../../src/engine/sources/pull.ts';
import {encodeSpec} from '../../src/engine/spec.ts';

/** The fields of a pull request, as GitHub's API and its events give it, that the link needs. */
export interface Pull {
    number: number;
    body: string | null;
    head: {sha: string};
    base: {sha: string; ref: string; repo: {full_name: string}};
}

/** What the step that takes the pictures found. */
export interface Summary {
    head: string;
    failure: string;
    sides: {name: 'base' | 'head'; commit: string; picture: boolean; errors: string[]; problems: string[]}[];
}

export const MARKER = '<!-- livebranch -->';

/**
 * The link that runs the pull request next to its base, at the commits of the event, with the demo
 * of its description and the gesture of the newest livebranch link in it that has one.
 */
export async function linkOf(pull: Pull, site: string): Promise<{link: string; gesture: boolean; demo: boolean}> {
    const body = pull.body ?? '';
    const files = demoFiles(body);
    const gesture = [...body.matchAll(/[#&?]gesture=([\w-]+)/g)].at(-1)?.[1];
    const repository = pull.base.repo.full_name;
    const pinned = await encodeSpec({
        gh: `${repository}@${pull.head.sha}`,
        base: `${repository}@${pull.base.sha}`,
        files: Object.keys(files).length ? files : undefined,
    });
    return {link: `${site}#${gesture ? `gesture=${gesture}&` : ''}${pinned}`, gesture: Boolean(gesture), demo: Object.keys(files).length > 0};
}

/** Lines that repeat, once each, with how often they came. */
function counted(lines: string[]): string[] {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return [...counts].map(([line, count]) => count > 1 ? `${line} (${count} times)` : line);
}

/**
 * The comment of the pictures. The lines that the pages logged go in a code block, where nothing
 * of them renders, as they come from the pull request's code.
 */
export function comment(pull: Pull, found: {link: string; gesture: boolean; demo: boolean}, summary: Summary, pictures: Partial<Record<'base' | 'head', string>>): string {
    const link = `[livebranch](${found.link})`;
    if (summary.failure) return `${MARKER}\nlivebranch could not open this pull request.\n\n\`\`\`text\n${summary.failure.replaceAll('```', "'''")}\n\`\`\`\n\nTry it on ${link}.\n`;
    const what = `${found.demo ? 'the demo of the description' : 'the stock demo'}${found.gesture ? ', after playing the recorded gesture' : ''}`;
    const side = (name: 'base' | 'head') => summary.sides.find(item => item.name === name);
    const label = (name: 'base' | 'head') => `${name === 'base' ? pull.base.ref : `#${pull.number}`} ${(side(name)?.commit ?? '').slice(0, 7)}`.trim();
    const picture = (name: 'base' | 'head') => pictures[name] ? `<img src="${pictures[name]}" width="420">` : 'No picture';
    const logged = (name: 'base' | 'head') => {
        const errors = side(name)?.errors.length ?? 0;
        return errors === 0 ? 'No errors in the console' : `${errors} ${errors === 1 ? 'error' : 'errors'} in the console`;
    };
    const details = summary.sides.filter(item => item.errors.length || item.problems.length).map(item => {
        const lines = [...counted(item.problems).map(text => `Problem. ${text}`), ...counted(item.errors).slice(0, 5)];
        const text = lines.join('\n').replaceAll('```', "'''");
        return `<details><summary>${item.name === 'base' ? 'Base' : 'This pull request'}</summary>\n\n\`\`\`text\n${text}\n\`\`\`\n\n</details>`;
    });
    return [
        MARKER,
        `The base and this pull request, running ${what} on ${link}.`,
        '',
        `| ${label('base')} | ${label('head')} |`,
        '| --- | --- |',
        `| ${picture('base')} | ${picture('head')} |`,
        `| ${logged('base')} | ${logged('head')} |`,
        '',
        ...details,
        '',
    ].join('\n');
}
