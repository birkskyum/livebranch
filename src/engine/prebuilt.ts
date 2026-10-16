import type {Problem} from './build.ts';
import type {Env, Project} from './project.ts';

async function text(env: Env, url: string): Promise<string | undefined> {
    try {
        const response = await env.fetch(url);
        return response.ok ? await response.text() : undefined;
    } catch {
        return undefined;
    }
}

/** Prebuilt files that may be out of date, and the command that makes them. */
export interface Stale {
    command: string;
    /** Writes the release's files after all, for when the command fails, and says that they may be out of date. */
    fallback(): Problem[];
}

export interface PrebuiltResult {
    problems: Problem[];
    stale: Stale[];
}

/**
 * Writes the project's prebuilt files from its published npm package. A generator source of the
 * project that differs from the release's may make the files out of date. Their command then makes
 * them, or else a warning says so.
 */
export async function fetchPrebuilt(project: Project, env: Env): Promise<PrebuiltResult> {
    const {vfs, packageJson, config} = project;
    const problems: Problem[] = [];
    const stale: Stale[] = [];
    const name: string | undefined = packageJson.name;
    const wanted = (config.prebuilt ?? []).filter(group => group.files.some(file => !vfs.isFile(`/${file}`)));
    if (!wanted.length) return {problems, stale};
    if (!name && wanted.some(group => !group.command)) throw new Error('The config names prebuilt files, but the project has no package name to take them from.');

    for (const group of wanted) {
        const inputs = group.inputs ?? [];
        const local = vfs.load(inputs.map(file => `/${file}`));
        let release = '';
        let found: (string | undefined)[] = [];
        for (const version of name ? [packageJson.version, 'latest'] : []) {
            if (!version) continue;
            release = `${name}@${version}`;
            found = await Promise.all([...group.files, ...inputs].map(file => text(env, `https://cdn.jsdelivr.net/npm/${release}/${file}`)));
            if (group.files.every((_, index) => found[index] !== undefined)) break;
            found = [];
        }
        await local;
        if (!found.length) {
            if (!group.command) throw new Error(`Cannot fetch ${group.files.join(', ')} from the npm package ${name}.`);
            stale.push({command: group.command, fallback: () => []});
            continue;
        }

        const changed = inputs.filter((input, index) => {
            const released = found[group.files.length + index];
            return released === undefined || released !== vfs.readText(`/${input}`);
        });
        const write = (): Problem[] => {
            group.files.forEach((file, index) => {
                if (!vfs.isFile(`/${file}`)) vfs.write(`/${file}`, found[index]!);
            });
            const text = (input: string) => `${group.files.join(', ')} comes from ${release}, but ${input} differs from that release, so it may be out of date.`;
            return changed.map(input => ({file: `/${group.files[0]}`, line: undefined, column: undefined, code: 0, category: 'warning', text: text(input)}));
        };
        if (changed.length && group.command) stale.push({command: group.command, fallback: write});
        else problems.push(...write());
    }
    return {problems, stale};
}
