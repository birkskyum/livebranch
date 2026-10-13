import {build, type Problem} from './build.ts';
import type {Env, Project} from './project.ts';
import {typeCheck} from './types.ts';

export interface CheckResult {
    source: string;
    commit: string | undefined;
    entry: string;
    /** Source files that were compiled. */
    modules: number;
    /** Setup commands of the project that did not run, because only a browser runs them. */
    skippedSetup: string[];
    problems: Problem[];
}

/**
 * Compiles and type checks a project where no browser is at hand: under Node and in a Worker.
 * The project's setup commands do not run there, so its generated files may be missing. Problems
 * are then reported only for the page and the link's files, since the others may be false.
 * `ranSetup` says that the files are from a directory where the setup has run.
 */
export async function checkProject(project: Project, env: Env, ranSetup = false): Promise<CheckResult> {
    const skippedSetup = ranSetup ? [] : project.config.setup ?? [];
    const built = await build(project, env);
    const own = new Set([project.entry, ...project.overlay]);
    // A problem without a file, as a crash of the compiler is, does not come from files that the setup would have made.
    const compiled = skippedSetup.length ? built.problems.filter(problem => problem.file === undefined || own.has(problem.file)) : built.problems;
    return {
        source: project.label,
        commit: project.commit,
        entry: project.entry,
        modules: built.sources,
        skippedSetup,
        problems: [...compiled, ...await typeCheck(project, env, own)],
    };
}
