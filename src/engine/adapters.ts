import type {Fetch} from './sources/github.ts';
import type {ProjectConfig} from './spec.ts';

/**
 * Where the adapters are: configs for projects that do not carry a `livebranch.json` of their own,
 * one JSON file per package name, in a public repository that anyone can add to.
 */
const SOURCES = [
    'https://raw.githubusercontent.com/birkskyum/livebranch-adapters/main/adapters/',
    'https://cdn.jsdelivr.net/gh/birkskyum/livebranch-adapters@main/adapters/',
];

type Text = string | string[];

/** A config as a file has it. Long texts may be arrays of lines, which JSON keeps readable. */
export interface ConfigFile extends Omit<ProjectConfig, 'files' | 'template'> {
    /** What the config is for. Only people read it. */
    about?: string;
    files?: Record<string, Text>;
    template?: Text;
}

const text = (value: Text): string => typeof value === 'string' ? value : `${value.join('\n')}\n`;

/** The config that a `livebranch.json` or an adapter file holds. */
export function readConfig(file: ConfigFile | undefined): ProjectConfig {
    if (!file || typeof file !== 'object') return {};
    const {about: _about, files, template, ...rest} = file;
    return {
        ...rest,
        ...(files ? {files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, text(value)]))} : {}),
        ...(template === undefined ? {} : {template: text(template)}),
    };
}

/** The adapter for a package name, if there is one. */
export async function fetchAdapter(fetch: Fetch, name: string): Promise<ProjectConfig | undefined> {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return undefined;
    for (const source of SOURCES) {
        try {
            const response = await fetch(`${source}${name}.json`);
            if (response.status === 404) return undefined;
            if (response.ok) return readConfig(await response.json() as ConfigFile);
        } catch {
            // The next source is tried.
        }
    }
    return undefined;
}
