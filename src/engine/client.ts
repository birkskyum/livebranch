import type {EngineCalls, Reply, Request} from './protocol.ts';

export interface EngineEvents {
    step?(name: string, detail: string | undefined): void;
    output?(stream: 'stdout' | 'stderr', text: string): void;
}

export type Engine = {[K in keyof EngineCalls]: (...args: Parameters<EngineCalls[K]>) => Promise<ReturnType<EngineCalls[K]>>} & {
    events: EngineEvents;
};

/** Starts the engine worker and returns its calls as promises. */
export function createEngine(): Engine {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module', name: 'engine'});
    const pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void}>();
    const events: EngineEvents = {};
    let nextId = 0;

    worker.onmessage = ({data}: MessageEvent<Reply>) => {
        if ('event' in data) {
            if (data.event === 'step') events.step?.(data.name, data.detail);
            else events.output?.(data.stream, data.text);
            return;
        }
        const waiting = pending.get(data.id);
        pending.delete(data.id);
        if ('error' in data) waiting?.reject(new Error(data.error));
        else waiting?.resolve(data.result);
    };

    const call = (name: keyof EngineCalls) => (...args: unknown[]) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve, reject});
        worker.postMessage({id, call: name, args} as Request);
    });
    return {events, open: call('open'), update: call('update'), check: call('check'), files: call('files'), read: call('read'), exec: call('exec')} as Engine;
}
