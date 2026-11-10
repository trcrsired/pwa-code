#!/bin/sh
# Full pwa-code build: wasm engine -> static PWA (docs/) -> native binaries.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$ROOT/build/build-wasm.sh"
node "$ROOT/build/build-web.mjs"
"$ROOT/build/build-native.sh"
"$ROOT/build/build-cli.sh"
