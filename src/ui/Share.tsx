import {Share as ShareIcon} from 'lucide-react';
import {useEffect, useState} from 'react';
import {useShallow} from 'zustand/react/shallow';
import {Button} from '@/components/ui/button.tsx';
import {Input} from '@/components/ui/input.tsx';
import {Label} from '@/components/ui/label.tsx';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover.tsx';
import {Switch} from '@/components/ui/switch.tsx';
import {baseSource} from '../engine/spec.ts';
import {describeRef} from './RefLinks.tsx';
import {demoBlock, isCommit, isResultOnly, shareLink, useStore} from './store.ts';

/** Joins names as a sentence does: `a`, `a and b`, `a, b and c`. */
function list(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function Option(props: {id: string; label: string; detail: string; checked: boolean; onChange(checked: boolean): void}) {
    return (
        <div className="flex items-start gap-2.5">
            <Switch id={props.id} className="mt-0.5" checked={props.checked} onCheckedChange={props.onChange} />
            <Label htmlFor={props.id} className="flex flex-col items-start gap-0.5 font-normal">
                {props.label}
                <span className="text-xs text-muted-foreground">{props.detail}</span>
            </Label>
        </div>
    );
}

/**
 * Shares the open project: its link, with the options of the link, and the demo as a block for
 * the description of a pull request, which is a different thing to copy.
 */
export function Share() {
    const [open, setOpen] = useState(false);
    const [resultOnly, setResultOnly] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [link, setLink] = useState('');
    const [copied, setCopied] = useState<'link' | 'block'>();
    const {spec, session, compared, edits, pull} = useStore(useShallow(state => ({spec: state.spec, session: state.session, compared: state.base, edits: state.edits, pull: state.pull})));

    useEffect(() => {
        if (!open) return;
        let live = true;
        void shareLink(resultOnly, {}, pinned).then(found => { if (live) setLink(found); });
        return () => {
            live = false;
        };
    }, [open, resultOnly, pinned, spec, session, compared, edits, pull]);

    const copy = async (what: 'link' | 'block') => {
        await navigator.clipboard.writeText(what === 'link' ? link : await demoBlock());
        setCopied(what);
        setTimeout(() => setCopied(undefined), 1500);
    };

    const against = baseSource(spec);
    const sources: [string | undefined, typeof session][] = [[against, compared], [spec.gh, session]];
    // The refs that later pushes change, as the bar names them. A link of commits only has none.
    const moving = sources.filter(([gh, built]) => gh && built?.commit && !isCommit(gh)).map(([gh, built]) => describeRef(gh, built).name);
    const edited = Object.keys(edits).map(path => path.split('/').pop()!);

    return (
        <Popover open={open} onOpenChange={next => { if (next) setResultOnly(isResultOnly()); setOpen(next); }}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="aria-expanded:bg-muted"><ShareIcon />Share</Button>
            </PopoverTrigger>
            {/* The link is there to read. Focus stays where it was, as the field would take the keyboard otherwise. */}
            <PopoverContent align="end" className="w-88 gap-3.5 p-4" onOpenAutoFocus={event => event.preventDefault()}>
                <h2 className="font-semibold">Share</h2>
                <div className="flex gap-2">
                    <Input readOnly className="font-mono text-xs text-muted-foreground md:text-xs" aria-label="Link" value={link} onFocus={event => event.currentTarget.select()} />
                    <Button onClick={() => void copy('link')}>{copied === 'link' ? 'Copied' : 'Copy'}</Button>
                </div>
                <Option
                    id="share-result"
                    label={against ? 'Only the previews' : 'Only the preview'}
                    detail="Opens without the code and the panel"
                    checked={resultOnly}
                    onChange={setResultOnly}
                />
                {moving.length > 0 && (
                    <Option
                        id="share-pinned"
                        label={against ? 'At these commits' : 'At this commit'}
                        detail={`Later pushes to ${list(moving)} don't change it`}
                        checked={pinned}
                        onChange={setPinned}
                    />
                )}
                {edited.length > 0 && <p className="text-xs text-muted-foreground">Includes your {edited.length === 1 ? 'edit' : 'edits'} to {list(edited)}.</p>}
                {spec.gh && (
                    <div className="flex items-center gap-3 border-t pt-3.5">
                        <div className="flex flex-1 flex-col gap-0.5">
                            Demo for a pull request
                            <span className="text-xs text-muted-foreground">Paste it in the description, and the address runs it</span>
                        </div>
                        <Button variant="outline" aria-label="Copy the demo for a pull request" onClick={() => void copy('block')}>{copied === 'block' ? 'Copied' : 'Copy'}</Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
