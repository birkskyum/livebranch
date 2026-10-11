#!/usr/bin/env bash
# Builds the tsc-rs WebAssembly module (pingdotgg/ts-rust) at the pinned commit and copies it, its
# JavaScript host and its license notices into this project.
#
# usage: scripts/build-wasm.sh
# env:   TS_RUST_REF  the commit to build (default: the pin below)
#        TS_RUST_DIR  where to keep the clone (default: .cache/ts-rust)
#        WASM_OPT     passed on to ts-rust's build script. The default "none" skips wasm-opt, which
#                     needs binaryen 132 or later. With wasm-opt the module is about 1.7 MB smaller.
# needs: rustup with the wasm32-wasip1 target, git
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ref="${TS_RUST_REF:-5c64ac8a8eaf44d90b0ecd4cf0b0f2f68da71d26}"
src="${TS_RUST_DIR:-$here/.cache/ts-rust}"

if [[ ! -d "$src/.git" ]]; then
  git clone --filter=blob:none https://github.com/pingdotgg/ts-rust "$src"
fi
git -C "$src" fetch --quiet origin "$ref"
git -C "$src" checkout --quiet "$ref"
echo "ts-rust at $(git -C "$src" rev-parse --short HEAD)"

WASM_OPT="${WASM_OPT:-none}" "$src/scripts/wasm/build.sh" "$here/public/tsc/ts_rust.wasm"
cp "$src/npm/wasm/core.js" "$src/npm/wasm/core.d.ts" "$here/src/vendor/tsc-rs/"
cp "$src/NOTICE.md" "$src/LICENSE" "$here/public/tsc/"
rm -rf "$here/public/tsc/licenses"
cp -R "$src/licenses" "$here/public/tsc/licenses"
