import {pack} from '../engine/spec.ts';
import {current, setGesture, setState, type RecordedInput} from './store.ts';

export type Side = 'base' | 'head';
type Frames = Record<Side, {current: HTMLIFrameElement | null}>;

/** The fields of an event that are places in the page, and are kept as shares of its size. */
const PLACES: [string, 'width' | 'height'][] = [['clientX', 'width'], ['clientY', 'height']];

let frames: Frames | undefined;
let loaded = new Set<Side>();
let whenLoaded: (() => void) | undefined;
let events: RecordedInput[] = [];
let zero = 0;
let timers: ReturnType<typeof setTimeout>[] = [];

/** The frames of the previews, which the preview hands over. */
export function attach(found: Frames): void {
    frames = found;
}

/** The sides whose pages run: both in a comparison whose base has built, else the link's own. */
function sides(): Side[] {
    return current().base ? ['base', 'head'] : ['head'];
}

/** Starts every page afresh, and calls `then` once all of them have loaded. */
function restart(then: () => void): void {
    loaded = new Set();
    whenLoaded = then;
    setState(draft => { draft.runs++; });
}

/** Called for each page that has loaded. */
export function pageLoaded(side: Side): void {
    loaded.add(side);
    if (whenLoaded && sides().every(other => loaded.has(other))) {
        const then = whenLoaded;
        whenLoaded = undefined;
        then();
    }
}

function scaled(init: Record<string, unknown>, frame: HTMLIFrameElement, toShare: boolean): Record<string, unknown> {
    const size = {width: frame.clientWidth || 1, height: frame.clientHeight || 1};
    const convert = (item: Record<string, unknown>) => {
        const out = {...item};
        for (const [field, dimension] of PLACES) {
            const value = item[field];
            if (typeof value !== 'number') continue;
            out[field] = toShare ? Math.round(value / size[dimension] * 1e4) / 1e4 : value * size[dimension];
        }
        delete out.screenX;
        delete out.screenY;
        return out;
    };
    const out = convert(init);
    for (const list of ['touches', 'targetTouches', 'changedTouches']) {
        if (Array.isArray(init[list])) out[list] = (init[list] as Record<string, unknown>[]).map(convert);
    }
    return out;
}

/**
 * Records a gesture. Every page starts afresh first, so that the gesture can start from the same
 * place each time it plays. A place is kept as a share of the page's size, so that the gesture
 * lands on the same spot of a page of another size.
 */
export function record(): void {
    cancel();
    events = [];
    setGesture(undefined);
    setState({recording: 'loading'});
    restart(() => {
        zero = performance.now();
        setState({recording: 'on'});
    });
}

/** Called with the input that a page reports, which a recording keeps. */
export function input(side: Side, data: {kind: string; type: string; init: Record<string, unknown>}): void {
    const frame = frames?.[side].current;
    if (current().recording !== 'on' || !frame) return;
    events.push({t: Math.round(performance.now() - zero), kind: data.kind, type: data.type, init: scaled(data.init, frame, true)});
}

/** Ends the recording and puts the gesture in the link. */
export async function stop(): Promise<void> {
    const recorded = events;
    events = [];
    whenLoaded = undefined;
    setState({recording: false});
    if (recorded.length) setGesture({events: recorded, packed: await pack(recorded)});
}

/** Starts every page afresh and gives each the recorded gesture, at the times it was recorded. */
export function play(): void {
    const gesture = current().gesture;
    if (!gesture) return;
    cancel();
    setState({playing: 'loading'});
    restart(() => {
        setState({playing: 'on'});
        for (const event of gesture.events) {
            timers.push(setTimeout(() => {
                for (const side of sides()) {
                    const frame = frames?.[side].current;
                    frame?.contentWindow?.postMessage({livebranch: 'input', kind: event.kind, type: event.type, init: scaled(event.init, frame, false)}, '*');
                }
            }, event.t));
        }
        timers.push(setTimeout(() => setState({playing: false}), (gesture.events.at(-1)?.t ?? 0) + 100));
    });
}

/** Stops a gesture that is playing. */
export function cancel(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    whenLoaded = undefined;
    if (current().playing) setState({playing: false});
}
