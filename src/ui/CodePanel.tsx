import {For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup} from 'solid-js';
import type {FileEntry} from '../engine/protocol.ts';
import {edit, getEngine, setState, state} from './store.ts';

interface Node {
    name: string;
    path: string;
    children: Map<string, Node> | undefined;
}

function tree(files: FileEntry[]): Node {
    const root: Node = {name: '', path: '', children: new Map()};
    for (const file of files) {
        let node = root;
        const parts = file.path.slice(1).split('/');
        parts.forEach((name, index) => {
            const last = index === parts.length - 1;
            let child = node.children!.get(name);
            if (!child) {
                child = {name, path: `${node.path}/${name}`, children: last ? undefined : new Map()};
                node.children!.set(name, child);
            }
            node = child;
        });
    }
    return root;
}

function sorted(node: Node): Node[] {
    return [...node.children!.values()].sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
}

function Directory(props: {node: Node; depth: number}) {
    const [open, setOpen] = createSignal(props.depth === 0 || (state.file ?? '').startsWith(`${props.node.path}/`));
    return (
        <>
            <Show when={props.depth > 0}>
                <button class="block w-full truncate py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900" style={{'padding-left': `${props.depth * 12}px`}} onClick={() => setOpen(!open())}>
                    {open() ? '▾' : '▸'} {props.node.name}
                </button>
            </Show>
            <Show when={open()}>
                <For each={sorted(props.node)}>
                    {child => (
                        <Show when={child.children} fallback={
                            <button
                                class="block w-full truncate py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                                classList={{'bg-blue-100 dark:bg-blue-950': state.file === child.path, 'italic': child.path in state.edits}}
                                style={{'padding-left': `${(props.depth + 1) * 12}px`}}
                                onClick={() => setState('file', child.path)}
                            >
                                {child.name}
                            </button>
                        }>
                            <Directory node={child} depth={props.depth + 1} />
                        </Show>
                    )}
                </For>
            </Show>
        </>
    );
}

/** The project's files and an editor for the selected one. An edit rebuilds the preview. */
export function CodePanel() {
    const [files] = createResource(() => state.session?.id.replace(/^e.*/, 'edited') ?? '', () => getEngine().files());
    const root = createMemo(() => tree(files() ?? []));
    let host: HTMLDivElement | undefined;
    let dispose: (() => void) | undefined;

    createEffect(on(() => [state.file, state.session?.label] as const, async ([path]) => {
        dispose?.();
        dispose = undefined;
        if (!path || !host) return;
        const [text, {createEditor}] = await Promise.all([
            path in state.edits ? state.edits[path] : getEngine().read(path),
            import('./editor.ts'),
        ]);
        if (state.file !== path || !host) return;
        host.textContent = '';
        if (text === undefined) {
            host.textContent = 'This file is not text.';
            return;
        }
        const view = createEditor(host, path, text, next => edit(path, next));
        dispose = () => view.destroy();
    }));
    onCleanup(() => dispose?.());

    return (
        <div class="flex min-w-0 flex-1">
            <nav class="w-48 shrink-0 overflow-auto border-r border-neutral-200 py-1 font-mono text-xs dark:border-neutral-800" aria-label="Files">
                <Directory node={root()} depth={0} />
            </nav>
            <div class="flex min-w-0 flex-1 flex-col">
                <div class="shrink-0 truncate border-b border-neutral-200 px-3 py-1 font-mono text-xs text-neutral-500 dark:border-neutral-800">{state.file?.slice(1)}</div>
                <div ref={host} class="min-h-0 flex-1 overflow-hidden p-0 font-mono text-xs text-neutral-500" />
            </div>
        </div>
    );
}
