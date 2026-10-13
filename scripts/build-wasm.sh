#!/usr/bin/env bash
# Builds the tsc-rs WebAssembly module (pingdotgg/ts-rust) at the pinned commit, with the fix in
# scripts/ts-rust.patch, and copies it, its JavaScript host and its license notices into this project.
#
# usage: scripts/build-wasm.sh
# env:   TS_RUST_REF  the commit to build (default: the pin below)
#        TS_RUST_DIR  where to keep the clone (default: .cache/ts-rust)
#        WASM_OPT     passed on to ts-rust's build script. The default "none" skips wasm-opt, which
#                     needs binaryen 132 or later. With wasm-opt the module is about 1.7 MB smaller.
#        CARGO_PROFILE_WASM_OPT_LEVEL, WASM_RUSTFLAGS
#                     how the module is optimized. The default is the faster of the two builds that
#                     ts-rust's script describes. Its smallest build is 1.5 MB smaller and takes 1.7
#                     times as long to check maplibre-gl-js. For that one, give
#                     CARGO_PROFILE_WASM_OPT_LEVEL=z WASM_RUSTFLAGS=
# needs: rustup with the wasm32-wasip1 target, git
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ref="${TS_RUST_REF:-a8c5b7063eed1ba2929ee78a7dd3508ebd43a6f8}"
src="${TS_RUST_DIR:-$here/.cache/ts-rust}"

if [[ ! -d "$src/.git" ]]; then
  git clone --filter=blob:none https://github.com/pingdotgg/ts-rust "$src"
fi
git -C "$src" fetch --quiet origin "$ref"
# --force drops the patch of an earlier build, so that it applies again.
git -C "$src" checkout --quiet --force "$ref"
echo "ts-rust at $(git -C "$src" rev-parse --short HEAD)"
git -C "$src" apply "$here/scripts/ts-rust.patch"

export CARGO_PROFILE_WASM_OPT_LEVEL="${CARGO_PROFILE_WASM_OPT_LEVEL:-s}"
export WASM_RUSTFLAGS="${WASM_RUSTFLAGS--C llvm-args=-inlinehint-threshold=150}"
# cargo looks for the workspace from the directory it runs in.
(cd "$src" && WASM_OPT="${WASM_OPT:-none}" scripts/wasm/build.sh "$here/public/tsc/ts_rust.wasm")
cp "$src/npm/wasm/core.js" "$src/npm/wasm/core.d.ts" "$here/src/vendor/tsc-rs/"
cp "$src/NOTICE.md" "$src/LICENSE" "$here/public/tsc/"
rm -rf "$here/public/tsc/licenses"
cp -R "$src/licenses" "$here/public/tsc/licenses"
