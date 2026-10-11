import {For, createSignal} from 'solid-js';
import {getEngine} from './store.ts';

interface Line {
    kind: 'command' | 'stdout' | 'stderr';
    text: string;
}

const [lines, setLines] = createSignal<Line[]>([]);
const history: string[] = [];

/** A bash over the project's files (just-bash), with `tsc`, `node` and `npm run` backed by the engine. */
export function Terminal() {
    const [busy, setBusy] = createSignal(false);
    let input: HTMLInputElement | undefined;
    let end: HTMLDivElement | undefined;
    let cursor = 0;

    const run = async (command: string) => {
        history.push(command);
        cursor = history.length;
        setLines(all => [...all, {kind: 'command', text: command}]);
        setBusy(true);
        try {
            const result = await getEngine().exec(command);
            setLines(all => [
                ...all,
                ...(result.stdout ? [{kind: 'stdout' as const, text: result.stdout}] : []),
                ...(result.stderr ? [{kind: 'stderr' as const, text: result.stderr}] : []),
            ]);
        } catch (error) {
            setLines(all => [...all, {kind: 'stderr', text: String(error)}]);
        }
        setBusy(false);
        end?.scrollIntoView();
        input?.focus();
    };

    const onKeyDown = (event: KeyboardEvent & {currentTarget: HTMLInputElement}) => {
        const field = event.currentTarget;
        if (event.key === 'Enter' && field.value.trim() && !busy()) {
            void run(field.value.trim());
            field.value = '';
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            cursor = Math.max(0, Math.min(history.length, cursor + (event.key === 'ArrowUp' ? -1 : 1)));
            field.value = history[cursor] ?? '';
            event.preventDefault();
        }
    };

    return (
        <div class="flex min-h-full flex-col px-3 py-2 font-mono text-xs" onClick={() => input?.focus()}>
            <For each={lines()}>
                {line => (
                    <pre class="whitespace-pre-wrap" classList={{'text-red-600 dark:text-red-400': line.kind === 'stderr', 'font-semibold': line.kind === 'command'}}>
                        {line.kind === 'command' ? `$ ${line.text}` : line.text.replace(/\n$/, '')}
                    </pre>
                )}
            </For>
            <div class="flex gap-2">
                <span>{busy() ? '…' : '$'}</span>
                <input
                    ref={input}
                    class="min-w-0 flex-1 bg-transparent outline-none"
                    aria-label="Shell command"
                    placeholder="ls, cat, grep, tsc --noEmit, node build/script.ts"
                    spellcheck={false}
                    autocomplete="off"
                    onKeyDown={onKeyDown}
                />
            </div>
            <div ref={end} />
        </div>
    );
}
