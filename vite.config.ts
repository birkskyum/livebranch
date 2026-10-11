import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig, type Plugin} from 'vite';
import solid from 'vite-plugin-solid';

/** The directory of the npm package that a module file belongs to. */
function packageRoot(file: string): string | undefined {
    for (let dir = dirname(file); dir.includes('node_modules'); dir = dirname(dir)) {
        if (existsSync(join(dir, 'package.json')) && /node_modules\/(?:@[^/]+\/)?[^/]+$/.test(dir)) return dir;
    }
    return undefined;
}

const bundled = new Set<string>();

/**
 * Writes THIRD-PARTY-NOTICES.txt with the license files of every npm package whose code is in the
 * build, as their licenses ask. The worker is bundled inside the build of the page, so its
 * packages are only collected, and the page's build writes the file for both. The notices of the
 * compiler module are in public/tsc.
 */
function notices(write: boolean): Plugin {
    return {
        name: 'third-party-notices',
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk') continue;
                for (const id of chunk.moduleIds) {
                    const root = packageRoot(id.split('?')[0]);
                    if (root) bundled.add(root);
                }
            }
            if (!write) return;
            const sections = [...bundled].map(root => {
                const {name, version, license} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
                const files = readdirSync(root).filter(file => /^(?:licen[cs]e|notice|third)/i.test(file)).sort();
                const texts = files.map(file => readFileSync(join(root, file), 'utf8').trim());
                return {name: String(name), text: `${name} ${version} (${license})\n\n${texts.join('\n\n')}`};
            });
            sections.sort((a, b) => a.name.localeCompare(b.name));
            const rule = `\n\n${'-'.repeat(80)}\n\n`;
            const head = 'This app includes code of the following open source packages.';
            this.emitFile({type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: `${head}${rule}${sections.map(section => section.text).join(rule)}\n`});
        },
    };
}

// The app is served from any directory: the service worker's scope is the directory of the page.
export default defineConfig({
    base: './',
    plugins: [solid(), tailwindcss(), notices(true)],
    worker: {format: 'es', plugins: () => [notices(false)]},
    build: {target: 'es2022'},
});
