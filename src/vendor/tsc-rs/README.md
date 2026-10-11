# tsc-rs host

`core.js` and `core.d.ts` are copied without change from `npm/wasm` of
[pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) at commit
`5c64ac8a8eaf44d90b0ecd4cf0b0f2f68da71d26`. They load `public/tsc/ts_rust.wasm`, which
`scripts/build-wasm.sh` builds from the same commit.

ts-rust is licensed under MIT, and the TypeScript parts it ports under Apache-2.0. The license and
notice files are in `public/tsc`, next to the module, so that they ship with it.
