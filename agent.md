# Agent guide — pwa code

This document is the working brief for anyone (human or AI) changing this
repository.  It records the goal, the non-negotiable constraints and the map of
the code.  Keep it up to date when architecture changes.

## 1. Goal

Build **pwa code**, a complete installable code editor:

- a portable, header-only C++ core built with
  [fast_io](https://github.com/cppfastio/fast_io), compiled to WebAssembly for
  the browser and to native code for a desktop/terminal player;
- an async native coding server (fast_io + LNA) that serves the PWA, a remote
  filesystem volume, and a PTY terminal over WebSocket;
- a browser frontend that works on touch, mobile, desktop, tablet and VR;
- no third-party code inside the player (build tooling may use Node/npm);
- exactly two themes: black-on-white text and white-on-black text.

## 2. Hard constraints

### Error handling

All C++ failures use **herbceptions**, never C-style status codes:

```cpp
void f() throws;                  // may fail
int  g() noexcept;                // cannot fail
throw throws ::std::errc::no_such_file_or_directory;
try { ... } catch throws (::std::error e) { ... }
```

- Every function, including lambdas, is explicitly `noexcept` or `throws`.
- A function must not return `bool`/`int`/`errno` to signal failure.  Only
  queries/predicates may return values.
- On the wasm C ABI boundary (which cannot throw across the module) errors are
  marshalled into the `pwa_error_*` exports; the JavaScript wrapper immediately
  rethrows them as `EngineError`.  Internally the C++ still uses `::std::error`.

### Build flags

Native builds:

```
-fherbceptions -lherbceptions
-fno-exceptions -fno-rtti
-fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident
```

No legacy C++ exceptions, no RTTI, no unwind tables.  Do not add
`std::thread`; use fast_io async I/O.  If blocking is unavoidable, fix or use
fast_io's own thread facility instead.

Wasm builds use `$HOME/cfgs/wasm32-wasip1-noeh-nomtg.cfg` (the scripts fall back
to `wasm32-wasip1-noeh.cfg`).  The current module has **no imports**; the WASI
filesystem header is opt-in and is not linked into it.

### Text model

- Canonical buffer: **UTF-8 with LF**.
- On load, BOM/encoding are detected and the source EOL is remembered.
- On save, re-encode to the original encoding and BOM.
- CRLF is written back only when the source used CRLF or the user explicitly
  chose CRLF; everything else is LF regardless of host OS.

### UI

- Only `dark` and `light` themes.  Dark = full black background + white text;
  light = full white background + black text.
- Indentation is either 2 spaces or a tab.  No other widths.
- Keyword lists are generated from Notepad++ defaults; `throws` and
  `return_failure` are added to C++.
- Bracket colouring follows VSCode depth colours (`t-b0..t-b2`), toggleable.
- The editor is a real `<textarea>` for selection/IME/accessibility, overlaid on
  a wasm-rendered highlighted underlay.  Only the visible line window is
  rendered (refterm-style partial view).

## 3. Layout

```
cpp/core/          header-only portable engine
  encoding.h       BOM/EOL detection + fast_io codecvt (UTF-8/16/32, GB18030, UTF-EBCDIC)
  syntax.h         Notepad++ highlighting, brackets, comments/strings/numbers
  document.h       line index, editing, indent, partial view, hex, save policy
  keywords_data.inc generated keyword tables (36 languages)
  wasi_fs.h        optional WASI preview1 filesystem layer (herbceptions)
cpp/wasm/main.cpp  C ABI + pwa_error_* boundary
cpp/native/server.cpp     async HTTP/WS/PTY/LNA server
cpp/native/pwacode-cli.cpp native core demo (same headers)
source/            frontend, copied to docs/ by the build
build/             wasm/web/native/cli pipeline
docs/              built, deployable PWA (+ .gz/.br precompressed assets)
```

### Core APIs (`cpp/core/document.h`)

`document` owns the UTF-8 LF text, line offsets and hex bytes.  Public methods
include `set_text`, `insert`, `replace`, `line_count`, `render_view`,
`render_hex`, `patch_hex`, `bracket_match`, `indent`, `save_bytes`,
`set_encoding`, `set_eol_mode`.  Failures throw `::std::error`.

### Wasm ABI (`cpp/wasm/main.cpp`)

Exports: `pwa_alloc`, `pwa_free`, `pwa_out_*`, `pwa_view_*`, `pwa_version`,
`pwa_probe`, `pwa_transcode_to_utf8`, `pwa_doc_*`, `pwa_view`,
`pwa_bracket_match`, `pwa_indent`, `pwa_line_*`, `pwa_hex_*` and the
`pwa_error_*` channel.  `source/wasm.js` wraps this as `Engine`.

### Server (`cpp/native/server.cpp`)

```
pwacode-server [docs-root] [-p port] [-w workspace] [--lna loopback|local|public]
```

- Serves `docs/`, negotiating Brotli/Gzip.
- `GET /api/ping`
- `GET /api/list?path=...`
- `GET|PUT /api/file?path=...`
- `GET /ws/terminal` — RFC 6455 WebSocket PTY.
- LNA defaults to local addresses.
- Pure async: one coroutine pumps PTY and socket with timed async reads; no
  threads.

## 4. Build

```sh
npm install            # build-only minifiers (not shipped)
build/build-all.sh     # wasm -> minified docs/ -> native server + CLI
build/build-wasm.sh    # source/pwacode.wasm
node build/build-web.mjs
build/build-native.sh  # ./pwacode-server
build/build-cli.sh     # ./pwacode-cli (portable core demo)
```

`build-web.mjs` minifies HTML/CSS/JS into `docs/` (pwa-player style) and then
emits `.gz`/`.br` copies.  `source/` stays readable; never edit `docs/`.

Run locally:

```sh
./pwacode-server ./docs -p 8140 -w ./workspace
# open http://127.0.0.1:8140/
```

`pwacode-cli` proves native portability:

```sh
./pwacode-cli file.cpp --lines 80
./pwacode-cli file.cpp --hex 16
./pwacode-cli file.cpp --encoding 1 --save out.cpp
```

## 5. Regression checklist

1. Load the page; status shows `wasm v2`; file list appears.
2. Open a file: highlighting, gutter alignment, language and size correct.
3. Type, save, reload, reopen: content and CRLF/LF policy preserved.
4. Ctrl+F / Ctrl+H / Ctrl+G; replace-all; selection reveal.
5. Theme toggle stays black or white only.
6. Hex panel renders and patches bytes; save bytes.
7. Terminal connects and echoes `FINAL_OK`.
8. Remote volume with a dead base URL shows a clean toast, not an unhandled
   rejection.
9. 390×844 layout has no horizontal overflow; soft keyboard overlays.
10. Offline reload is served by the service worker.
11. Native core: `pwacode-cli` view/hex/UTF-16 save.
