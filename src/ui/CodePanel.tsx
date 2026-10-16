import {useEffect, useMemo, useRef, useState} from 'react';
import {cn} from '@/lib/utils.ts';
import type {FileEntry} from '../engine/protocol.ts';
import {current, edit, listFiles, readFile, setState, useStore} from './store.ts';

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
    const file = useStore(state => state.file);
    const edits = useStore(state => state.edits);
    const [open, setOpen] = useState(() => props.depth === 0 || (file ?? '').startsWith(`${props.node.path}/`));
    const row = 'block w-full truncate py-0.5 text-left hover:bg-muted';
    return (
        <>
            {props.depth > 0 && (
                <button className={row} style={{paddingLeft: `${props.depth * 12}px`}} onClick={() => setOpen(!open)}>
                    {open ? '▾' : '▸'} {props.node.name}
                </button>
            )}
            {open && sorted(props.node).map(child => child.children
                ? <Directory key={child.path} node={child} depth={props.depth + 1} />
                : (
                    <button
                        key={child.path}
                        className={cn(row, file === child.path && 'bg-blue-100 dark:bg-blue-950', child.path in edits && 'italic')}
                        style={{paddingLeft: `${(props.depth + 1) * 12}px`}}
                        onClick={() => setState({file: child.path})}
                    >
                        {child.name}
                    </button>
                ))}
        </>
    );
}

/** The project's files and an editor for the selected one. An edit rebuilds the preview. */
export function CodePanel() {
    const file = useStore(state => state.file);
    const label = useStore(state => state.session?.label);
    const build = useStore(state => state.session?.id);
    const [files, setFiles] = useState<FileEntry[]>([]);
    const root = useMemo(() => tree(files), [files]);
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let live = true;
        void listFiles().then(found => {
            if (live) setFiles(found);
        });
        return () => {
            live = false;
        };
    }, [build]);

    useEffect(() => {
        let dispose: (() => void) | undefined;
        let live = true;
        void (async () => {
            if (!file || !host.current) return;
            const {edits} = current();
            const [text, {createEditor}] = await Promise.all([
                file in edits ? edits[file] : readFile(file),
                import('./editor.ts'),
            ]);
            if (!live || !host.current) return;
            host.current.textContent = '';
            if (text === undefined) {
                host.current.textContent = 'This file is not text.';
                return;
            }
            const view = createEditor(host.current, file, text, next => edit(file, next));
            dispose = () => view.destroy();
        })();
        return () => {
            live = false;
            dispose?.();
        };
    }, [file, label]);

    return (
        <div className="flex h-full min-w-0 flex-1">
            <nav className="w-48 shrink-0 overflow-auto border-r py-1 font-mono text-xs" aria-label="Files">
                <Directory node={root} depth={0} />
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="shrink-0 truncate border-b px-3 py-1 font-mono text-xs text-muted-foreground">{file?.slice(1)}</div>
                <div ref={host} className="min-h-0 flex-1 overflow-hidden p-0 font-mono text-xs text-muted-foreground" />
            </div>
        </div>
    );
}
