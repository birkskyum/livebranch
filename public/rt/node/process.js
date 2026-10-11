// `node:process`. The runner also installs it as the global `process`.
import {state} from './state.js';

const start = performance.now();

function stream(write) {
    return {write: text => (write(typeof text === 'string' ? text : new TextDecoder().decode(text)), true), isTTY: false, columns: 80};
}

const process = {
    get argv() { return state.argv; },
    get env() { return state.env; },
    cwd: () => state.cwd,
    chdir: path => { state.cwd = path; },
    exit: code => state.exit(code ?? process.exitCode ?? 0),
    exitCode: undefined,
    platform: 'linux',
    arch: 'wasm32',
    pid: 1,
    version: 'v24.0.0',
    versions: {node: '24.0.0'},
    execPath: '/usr/bin/node',
    stdout: stream(text => state.stdout(text)),
    stderr: stream(text => state.stderr(text)),
    hrtime: Object.assign(() => {
        const ms = performance.now() - start;
        return [Math.floor(ms / 1000), Math.floor((ms % 1000) * 1e6)];
    }, {bigint: () => BigInt(Math.round((performance.now() - start) * 1e6))}),
    uptime: () => (performance.now() - start) / 1000,
    nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
    on: () => process,
    once: () => process,
    off: () => process,
    emitWarning: message => console.warn(message),
    memoryUsage: () => ({rss: 0, heapTotal: 0, heapUsed: 0, external: 0}),
};

export const {argv, env, cwd, exit, platform, stdout, stderr, hrtime, nextTick, versions} = process;
export default process;
