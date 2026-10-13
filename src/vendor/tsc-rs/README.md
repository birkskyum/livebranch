# tsc-rs host

`core.js` and `core.d.ts` are copied without change from `npm/wasm` of
[pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) at commit
`a8c5b7063eed1ba2929ee78a7dd3508ebd43a6f8`, which is v0.6.0. They load `public/tsc/ts_rust.wasm`,
which `scripts/build-wasm.sh` builds from the same commit with the fix in `scripts/ts-rust.patch`.
Without that fix the module of v0.6.0 panics on maplibre-gl-js.

ts-rust is licensed under MIT, and the TypeScript parts it ports under Apache-2.0. The license and
notice files are in `public/tsc`, next to the module, so that they ship with it.
