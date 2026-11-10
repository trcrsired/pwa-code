#!/bin/sh
# Build pwacode-cli, the native portability demo for cpp/core.
#
# It uses the exact same header-only engine as the wasm module, but runs as a
# normal fast_io native program: view, hex dump, re-encode and save.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CXX=${CXX:-clang++}
CONFIG=${PWA_NATIVE_CONFIG:-$HOME/cfgs/x86_64-linux-gnu-libcxx.cfg}
OUT=${PWA_CLI_OUT:-$ROOT/pwacode-cli}

if [ ! -f "$CONFIG" ]; then
    echo "error: config $CONFIG not found (set PWA_NATIVE_CONFIG)" >&2
    exit 1
fi

"$CXX" --config="$CONFIG" \
    -fherbceptions -lherbceptions \
    -O2 -flto=thin -s \
    -fno-exceptions -fno-rtti \
    -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident \
    -I"$ROOT/cpp/core" \
    -o "$OUT" \
    "$ROOT/cpp/native/pwacode-cli.cpp"

ls -l "$OUT"
