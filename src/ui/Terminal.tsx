import {useRef, useState, type KeyboardEvent} from 'react';
import {create} from 'zustand';
import {cn} from '@/lib/utils.ts';
import {getEngine} from './store.ts';

interface Line {
    kind: 'command' | 'stdout' | 'stderr';
    text: string;
}

/** The terminal's output, kept while the panel shows another tab. */
const useLines = create<{lines: Line[]}>(() => ({lines: []}));
const print = (...lines: Line[]) => useLines.setState(({lines: all}) => ({lines: [...all, ...lines]}));
const history: string[] = [];

/** A bash over the project's files (just-bash), with `tsc`, `node` and `npm run` backed by the engine. */
export function Terminal() {
    const lines = useLines(state => state.lines);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const end = useRef<HTMLDivElement>(null);
    const cursor = useRef(0);

    const run = async (command: string) => {
        history.push(command);
        cursor.current = history.length;
        print({kind: 'command', text: command});
        setBusy(true);
        try {
            const result = await getEngine().exec(command);
            print(
                ...(result.stdout ? [{kind: 'stdout' as const, text: result.stdout}] : []),
                ...(result.stderr ? [{kind: 'stderr' as const, text: result.stderr}] : []),
            );
        } catch (error) {
            print({kind: 'stderr', text: String(error)});
        }
        setBusy(false);
        end.current?.scrollIntoView();
        input.current?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        const field = event.currentTarget;
        if (event.key === 'Enter' && field.value.trim() && !busy) {
            void run(field.value.trim());
            field.value = '';
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            cursor.current = Math.max(0, Math.min(history.length, cursor.current + (event.key === 'ArrowUp' ? -1 : 1)));
            field.value = history[cursor.current] ?? '';
            event.preventDefault();
        }
    };

    return (
        <div className="flex min-h-full flex-col px-3 py-2 font-mono text-xs" onClick={() => input.current?.focus()}>
            {lines.map((line, index) => (
                <pre key={index} className={cn('whitespace-pre-wrap', line.kind === 'stderr' && 'text-red-600 dark:text-red-400', line.kind === 'command' && 'font-semibold')}>
                    {line.kind === 'command' ? `$ ${line.text}` : line.text.replace(/\n$/, '')}
                </pre>
            ))}
            <div className="flex gap-2">
                <span>{busy ? '…' : '$'}</span>
                <input
                    ref={input}
                    className="min-w-0 flex-1 bg-transparent outline-none"
                    aria-label="Shell command"
                    placeholder="ls, cat, grep, tsc --noEmit, node build/script.ts"
                    spellCheck={false}
                    autoComplete="off"
                    onKeyDown={onKeyDown}
                />
            </div>
            <div ref={end} />
        </div>
    );
}
