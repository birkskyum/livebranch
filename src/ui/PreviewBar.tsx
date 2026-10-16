import {ArrowLeftRight, Check, ChevronDown, Link, RotateCw, Unlink, X} from 'lucide-react';
import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {useShallow} from 'zustand/react/shallow';
import {Button} from '@/components/ui/button.tsx';
import {Input} from '@/components/ui/input.tsx';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover.tsx';
import {cn} from '@/lib/utils.ts';
import {baseSource, parseGithubRef} from '../engine/spec.ts';
import {RefLinks} from './RefLinks.tsx';
import {compareWith, defaultBranch, setState, setSyncViews, useStore} from './store.ts';

interface Target {
    ref: string;
    /** Why it is offered. */
    note: string;
}

/**
 * The refs that the open source is mostly held against: the branch that a pull request goes into,
 * and the repository's default branch. The source's own branch is left out.
 */
function useTargets(): Target[] {
    const {gh, pull} = useStore(useShallow(state => ({gh: state.spec.gh, pull: state.pull})));
    const [found, setFound] = useState<string>();
    useEffect(() => {
        let live = true;
        if (gh && !pull) void defaultBranch(gh).then(branch => { if (live) setFound(branch); });
        return () => {
            live = false;
        };
    }, [gh, pull]);
    if (!gh) return [];
    const {ref} = parseGithubRef(gh);
    const number = /^pull\/(\d+)/.exec(ref)?.[1];
    const branch = pull?.defaultBranch ?? found;
    const targets: Target[] = [];
    if (pull?.base) targets.push({ref: pull.base, note: pull.base === branch ? `default branch, where #${number} goes` : `where #${number} goes`});
    if (branch && branch !== pull?.base) targets.push({ref: branch, note: 'default branch'});
    return targets.filter(target => target.ref !== ref && !(ref === 'HEAD' && target.ref === branch));
}

/** A small button of the bar. One that toggles shows whether it is on. */
function BarButton(props: {label: string; title?: string; pressed?: boolean; onClick(): void; children: ReactNode}) {
    return (
        <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground aria-pressed:text-foreground"
            title={props.title ?? props.label}
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
        >
            {props.children}
        </Button>
    );
}

/** Names the ref to compare with: one that is typed, or one of the usual targets. */
function RefPicker(props: {trigger: ReactNode; label: string}) {
    const [open, setOpen] = useState(false);
    const current = useStore(state => state.spec.base);
    const targets = useTargets();
    const input = useRef<HTMLInputElement>(null);
    const apply = (ref: string) => {
        setOpen(false);
        if (ref.trim()) void compareWith(ref);
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        apply(input.current?.value ?? '');
    };
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="xs" className="font-mono" aria-label={props.label}>{props.trigger}</Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 gap-1 p-1.5" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
                <form onSubmit={submit}>
                    <Input ref={input} className="font-mono" aria-label="Ref to compare with" placeholder="branch, tag, commit or #123" spellCheck={false} defaultValue={current ?? ''} />
                </form>
                {targets.map(target => (
                    <button key={target.ref} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted" onClick={() => apply(target.ref)}>
                        <span className="font-mono text-xs">{target.ref}</span>
                        <span className="text-xs text-muted-foreground">{target.note}</span>
                        {target.ref === current && <Check className="ml-auto size-3.5" />}
                    </button>
                ))}
                <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">Or a branch, a tag, a commit or #123.</p>
            </PopoverContent>
        </Popover>
    );
}

/**
 * The bar over the previews. It names each side over its own preview, as the console columns
 * under them do, and starts, changes and stops the comparison. The previews themselves stay clear.
 */
export function PreviewBar() {
    const {spec, session, compared, baseError, pull, syncViews, syncable} = useStore(useShallow(state => ({
        spec: state.spec,
        session: state.session,
        compared: state.base,
        baseError: state.baseError,
        pull: state.pull,
        syncViews: state.syncViews,
        syncable: state.syncable,
    })));
    const targets = useTargets();
    const against = baseSource(spec);
    // Both sides have the same padding, which counts toward their widths, so that they line up with the previews.
    const side = 'flex min-w-0 flex-1 items-center gap-1.5 bg-background px-1 font-mono text-xs whitespace-nowrap';
    const reload = (
        <BarButton label={against ? 'Reload both' : 'Reload'} onClick={() => setState(draft => { draft.runs++; })}>
            <RotateCw />
        </BarButton>
    );
    // The address of a pull request compares with the default branch, which is not where every one goes.
    const goesInto = pull?.base && spec.base === pull.defaultBranch && pull.base !== spec.base ? pull.base : undefined;
    return (
        <div role="toolbar" aria-label="Previews" className="flex h-7 shrink-0 gap-px border-b bg-border">
            {against !== undefined && (
                <div className={side} data-side="base">
                    <RefLinks gh={against} session={compared} name={text => <RefPicker label="Change the ref to compare with" trigger={<>{text || spec.base}<ChevronDown /></>} />} />
                    {!compared && (
                        <span className={cn('truncate font-sans', baseError ? 'text-destructive' : 'text-muted-foreground')} title={baseError || undefined}>
                            {baseError || 'building…'}
                        </span>
                    )}
                    <span className="flex-1" />
                    {goesInto && (
                        <Button variant="ghost" size="xs" className="font-sans" title={`This pull request goes into ${goesInto}, not into ${spec.base}.`} onClick={() => void compareWith(goesInto)}>
                            Goes into {goesInto}
                        </Button>
                    )}
                    <BarButton label="Stop comparing" onClick={() => void compareWith('')}><X /></BarButton>
                </div>
            )}
            <div className={side} data-side="head">
                {session && <span className="pl-2"><RefLinks gh={spec.gh} session={session} fallback={session.label} /></span>}
                <span className="flex-1" />
                {against === undefined && spec.gh && (targets[0]
                    ? (
                        <Button variant="ghost" size="xs" className="font-sans" onClick={() => void compareWith(targets[0].ref)}>
                            <ArrowLeftRight />Compare with {targets[0].ref}
                        </Button>
                    )
                    : <RefPicker label="Compare with another ref" trigger={<span className="flex items-center gap-1 font-sans"><ArrowLeftRight />Compare with…</span>} />)}
                {against !== undefined && syncable && (
                    <BarButton
                        label="Move the views together"
                        title={syncViews ? 'The views move together. Click to move them apart.' : 'The views move apart. Click to move them together.'}
                        pressed={syncViews}
                        onClick={() => setSyncViews(!syncViews)}
                    >
                        {syncViews ? <Link /> : <Unlink />}
                    </BarButton>
                )}
                {reload}
            </div>
        </div>
    );
}
