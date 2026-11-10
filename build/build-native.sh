#!/bin/sh
# Build the native pwa-code server.  The server serves docs/ and exposes the
# remote-volume API plus the async PTY WebSocket terminal.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CXX=${CXX:-clang++}
CONFIG=${PWA_NATIVE_CONFIG:-$HOME/cfgs/x86_64-linux-gnu-libcxx.cfg}
OUT=${PWA_SERVER_OUT:-$ROOT/pwacode-server}

if [ ! -f "$CONFIG" ]; then
    echo "error: config $CONFIG not found (set PWA_NATIVE_CONFIG)" >&2
    exit 1
fi

# Herbceptions only: no C++ exceptions, no RTTI, no unwind tables.  std::thread
# is never used; the terminal and HTTP server are driven by fast_io async I/O.
"$CXX" --config="$CONFIG" \
    -fherbceptions -lherbceptions \
    -O3 -flto=thin -s -pthread \
    -fno-exceptions -fno-rtti \
    -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident \
    -I"$ROOT/cpp/core" \
    -o "$OUT" \
    "$ROOT/cpp/native/server.cpp"

ls -l "$OUT"
