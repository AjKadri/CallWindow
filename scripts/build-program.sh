#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.tools/cargo"
export PATH="$ROOT/.tools/solana/active_release/bin:$CARGO_HOME/bin:$RUSTUP_HOME/toolchains/stable-aarch64-apple-darwin/bin:$PATH"

node "$ROOT/scripts/ensure-program-id.mjs"
cargo-build-sbf --manifest-path "$ROOT/programs/callwindow-escrow/Cargo.toml" --arch v3
