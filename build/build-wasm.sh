#!/bin/sh
# Build source/pwacode.wasm from cpp/wasm/main.cpp.
#
# The canonical config is wasm32-wasip1-noeh-nomtg.cfg (no exception handling,
# no memory tagging).  Older installations may only provide
# wasm32-wasip1-noeh.cfg.  Override with PWA_WASM_CONFIG=... if needed.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CXX=${CXX:-clang++}

CONFIG=${PWA_WASM_CONFIG:-}
if [ -z "$CONFIG" ]; then
    for candidate in \
        "$HOME/cfgs/wasm32-wasip1-noeh-nomtg.cfg" \
        "$HOME/cfgs/wasm32-wasip1-noeh.cfg" \
        "$HOME/cfgs/wasm32-wasip1-nomtg.cfg"
    do
        if [ -f "$candidate" ]; then
            CONFIG=$candidate
            break
        fi
    done
fi

if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo "error: no wasm32-wasip1 config found" >&2
    echo "set PWA_WASM_CONFIG=/path/to/wasm32-wasip1-noeh-nomtg.cfg" >&2
    exit 1
fi

EXPORTS="
-Wl,--export=__wasm_call_ctors
-Wl,--export=pwa_alloc
-Wl,--export=pwa_free
-Wl,--export=pwa_out_ptr
-Wl,--export=pwa_out_len
-Wl,--export=pwa_view_ptr
-Wl,--export=pwa_view_len
-Wl,--export=pwa_version
-Wl,--export=pwa_error_pending
-Wl,--export=pwa_error_kind
-Wl,--export=pwa_error_code
-Wl,--export=pwa_error_ptr
-Wl,--export=pwa_error_len
-Wl,--export=pwa_error_clear
-Wl,--export=pwa_probe
-Wl,--export=pwa_transcode_to_utf8
-Wl,--export=pwa_doc_load
-Wl,--export=pwa_doc_encoding
-Wl,--export=pwa_doc_bom
-Wl,--export=pwa_doc_source_crlf
-Wl,--export=pwa_doc_line_count
-Wl,--export=pwa_doc_size
-Wl,--export=pwa_doc_get_text
-Wl,--export=pwa_doc_set_text
-Wl,--export=pwa_doc_insert
-Wl,--export=pwa_doc_replace
-Wl,--export=pwa_doc_set_encoding
-Wl,--export=pwa_doc_set_eol
-Wl,--export=pwa_doc_language
-Wl,--export=pwa_doc_save_text
-Wl,--export=pwa_view
-Wl,--export=pwa_bracket_match
-Wl,--export=pwa_indent
-Wl,--export=pwa_line_start
-Wl,--export=pwa_line_of_offset
-Wl,--export=pwa_hex_size
-Wl,--export=pwa_hex_render
-Wl,--export=pwa_hex_patch
-Wl,--export=pwa_hex_bytes
-Wl,--export=pwa_hex_from_text
-Wl,--export=pwa_hex_save
"

mkdir -p "$ROOT/source"

# shellcheck disable=SC2086
"$CXX" --config="$CONFIG" \
    -fherbceptions -lherbceptions \
    -O3 -flto=thin -s \
    -fno-exceptions -fno-rtti \
    -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident \
    -nostartfiles -Wl,--no-entry \
    -I"$ROOT/cpp/core" \
    $EXPORTS \
    -o "$ROOT/source/pwacode.wasm" \
    "$ROOT/cpp/wasm/main.cpp"

ls -l "$ROOT/source/pwacode.wasm"
