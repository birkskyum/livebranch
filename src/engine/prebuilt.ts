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

/**
 * Writes the project's prebuilt files from its published npm package. Reports a warning when a
 * generator source of the project differs from the release's, since the file may then be stale.
 */
export async function fetchPrebuilt(project: Project, env: Env): Promise<Problem[]> {
    const {vfs, packageJson, config} = project;
    const problems: Problem[] = [];
    const warn = (file: string, message: string) => {
        problems.push({file: `/${file}`, line: undefined, column: undefined, code: 0, category: 'warning', text: message});
    };
    const name: string | undefined = packageJson.name;
    const wanted = (config.prebuilt ?? []).filter(group => group.files.some(file => !vfs.isFile(`/${file}`)));
    if (!wanted.length) return problems;
    if (!name) throw new Error('The config names prebuilt files, but the project has no package name to take them from.');

    for (const group of wanted) {
        const inputs = group.inputs ?? [];
        const local = vfs.load(inputs.map(file => `/${file}`));
        let release = '';
        let found: (string | undefined)[] = [];
        for (const version of [packageJson.version, 'latest']) {
            if (!version) continue;
            release = `${name}@${version}`;
            found = await Promise.all([...group.files, ...inputs].map(file => text(env, `https://cdn.jsdelivr.net/npm/${release}/${file}`)));
            if (group.files.every((_, index) => found[index] !== undefined)) break;
            found = [];
        }
        if (!found.length) throw new Error(`Cannot fetch ${group.files.join(', ')} from the npm package ${name}.`);
        group.files.forEach((file, index) => {
            if (!vfs.isFile(`/${file}`)) vfs.write(`/${file}`, found[index]!);
        });

        await local;
        inputs.forEach((input, index) => {
            const released = found[group.files.length + index];
            if (released !== undefined && released === vfs.readText(`/${input}`)) return;
            warn(group.files[0], `${group.files.join(', ')} comes from ${release}, but ${input} differs from that release, so it may be out of date.`);
        });
    }
    return problems;
}
