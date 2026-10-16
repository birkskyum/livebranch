import {useEffect, useMemo, useRef, useState} from 'react';
import {useDefaultLayout} from 'react-resizable-panels';
import {ResizableHandle, ResizablePanel, ResizablePanelGroup} from '@/components/ui/resizable.tsx';
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

/**
 * The project's files and an editor for the selected one. An edit rebuilds the preview. The line
 * between them moves, and the list keeps its width when the code panel is resized.
 */
export function CodePanel() {
    const file = useStore(state => state.file);
    const label = useStore(state => state.session?.label);
    const build = useStore(state => state.session?.id);
    const [files, setFiles] = useState<FileEntry[]>([]);
    const root = useMemo(() => tree(files), [files]);
    const host = useRef<HTMLDivElement>(null);
    const layout = useDefaultLayout({id: 'livebranch-files', storage: localStorage});
    // The list's width is in pixels, which only come out right once the code panel has a width. It
    // has none for a moment after it opens.
    const [box, setBox] = useState<HTMLDivElement | null>(null);
    const [measured, setMeasured] = useState(false);
    useEffect(() => {
        if (!box || measured) return;
        const observer = new ResizeObserver(([entry]) => setMeasured(entry.contentRect.width > 0));
        observer.observe(box);
        return () => observer.disconnect();
    }, [box, measured]);

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
    }, [file, label, measured]);

    return (
        <div ref={setBox} className="h-full">
            {measured && (
                <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
                    <ResizablePanel id="files" defaultSize={192} minSize={96} groupResizeBehavior="preserve-pixel-size">
                        <nav className="h-full overflow-auto py-1 font-mono text-xs" aria-label="Files">
                            <Directory node={root} depth={0} />
                        </nav>
                    </ResizablePanel>
                    <ResizableHandle aria-label="Width of the files" />
                    <ResizablePanel id="editor" minSize={120}>
                        <div className="flex h-full min-w-0 flex-col">
                            <div className="shrink-0 truncate border-b px-3 py-1 font-mono text-xs text-muted-foreground">{file?.slice(1)}</div>
                            <div ref={host} className="min-h-0 flex-1 overflow-hidden p-0 font-mono text-xs text-muted-foreground" />
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            )}
        </div>
    );
}
