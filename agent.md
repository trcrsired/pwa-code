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
- exactly two themes: black-on-white text and white-on-black text; the default
  choice follows the OS colour scheme.

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
  light = full white background + black text.  The default `system` setting
  follows `prefers-color-scheme` and repaints live when the OS changes.
- Indentation is either 2 spaces or a tab.  No other widths.
- Keyword lists are generated from Notepad++ defaults; `throws` and
  `return_failure` are added to C++.
- Bracket colouring follows VSCode depth colours (`t-b0..t-b2`), toggleable.
- Word completion follows Notepad++: the current file records every
  letters/digits/underscore run of two or more characters, and typing a prefix
  (from the configured minimum, default 1) opens a caret hint list.  Up/Down
  move, Tab/Enter accept, Esc dismisses, clicking/tapping selects, and
  `Ctrl+Space` forces the list.  It is enabled by default and configurable in
  Settings; the word list is rebuilt off the typing path.
- Build macros follow Notepad++'s Run command.  Settings holds a named list;
  each entry has a space/comma-separated extension set (`.cpp`, `*.h`, `cxx`,
  etc.) and an empty extension set means "any file".  `Ctrl+Shift+B` or the
  top-bar play button saves the active file, picks the first macro whose
  extension set matches (extension-specific entries beat catch-alls), expands
  `$(FULL_CURRENT_PATH)`, `$(CURRENT_DIRECTORY)`, `$(FILE_NAME)`,
  `$(NAME_PART)` and `$(EXT_PART)`, then sends the command to the active
  server-backed terminal (opening it if needed).  The ▾ picker runs a
  different macro once without changing the mappings.  The default C++ macro
  compiles and runs C/C++ files.  Internal, external and read-only HTTP
  volumes are rejected because they have no PTY workspace; the terminal is
  targeted at the active tab's remote mount, and a mismatched existing
  terminal gets a fresh shell rather than receiving the command on the wrong
  machine.
- Find/replace is literal.  It works in the open file or, from the explorer's
  folder menu (or `Ctrl+Shift+F`), across that folder with VSCode-style results
  grouped by file.  Replace one/all edits open buffers in memory and rewrites
  closed files through the encoding-preserving engine.
- The editor is a real `<textarea>` for selection/IME/accessibility, overlaid on
  a wasm-rendered highlighted underlay.  Only the visible line window is
  rendered (refterm-style partial view).
- Very large files (> 8 MiB or > 200k lines) open in a read-only virtual
  partial view.  The textarea is never given millions of lines to lay out; a
  transparent scroll proxy maps the whole document (scaled when it exceeds the
  browser's maximum scroll height) and the wasm engine paints the visible
  window.  Small files keep the editable textarea.
- Multiple external mounts and multiple remote mounts are supported.  Remote
  mounts can be a pwa-code server (read/write + terminal) or a plain HTTP
  directory index (read-only).
- Long file names wrap inside the sidebar row instead of being truncated; the
  row grows, the icon stays at the first line, and the full name is also in the
  row's `title` for desktop hover.
- The ⌨ button raises both keyboards: it shows the extra key row (Esc/Tab/
  Ctrl/Alt/arrows) and focuses the editor so the device's own on-screen
  keyboard appears.  `focus()` must run inside the tap gesture for iOS/Android
  to honour it.  The terminal has no editable element, so a rendered 1px
  textarea proxy receives the OS keyboard and forwards bytes to the PTY; taps
  on the terminal refocus it.  `visualViewport` keeps the extra row above the
  OS keyboard rather than behind it; `--softkb-h` carries its measured height
  so the app padding and a full-screen terminal shrink by exactly that much.
  Ctrl/Alt are sticky flags: a later soft key or a typed character folds them
  into the PTY bytes, so soft Ctrl+C is SIGINT (or copies a live selection)
  and Ctrl/Alt+arrows use the xterm modified-CSI form.  Real keyboards still
  report `ctrlKey`/`altKey` directly.
- The terminal toolbar's full-screen button (an SVG expand/collapse icon, so
  it renders on every desktop font stack) toggles a full-screen pane:
  `body.term-max` hides the top bar, document tabs, status bar and sidebar and
  pins `#termWrap` to the viewport.  The terminal's own session tabs, status
  text and every toolbar action except the floating restore button are hidden
  too, so only shell rows remain.  The pane also ends above the soft-key row
  and the OS keyboard, and the PTY is re-measured when they appear or go away.
  Focus returns to the shell, and hiding/closing the pane clears the state.
- A terminal socket that drops on an app switch, a network blip, or a
  background suspend is routine: the status text reports `reconnecting…` and
  the retry loop reopens it.  No toast is raised for connection failures or for
  keystrokes queued while reconnecting, so switching apps never buries the pane
  in warnings.

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
include `set_text`, `set_text_owned`, `insert`, `replace`, `line_count`,
`render_view`, `render_hex`, `patch_hex`, `bracket_match`, `indent`,
`save_bytes`, `set_encoding`, `set_eol_mode`.  Failures throw `::std::error`.

The newline index and the CRLF-normalisation check use
`fast_io::intrinsics::simd_vector` (16-byte lanes, scalar fallback).  The wasm
build enables `-msimd128`.  Syntax state is built lazily only up to the visible
window, so opening a huge file does not scan every line before the first paint.

### Wasm ABI (`cpp/wasm/main.cpp`)

Exports: `pwa_alloc`, `pwa_free`, `pwa_out_*`, `pwa_view_*`, `pwa_version`,
`pwa_probe`, `pwa_transcode_to_utf8`, `pwa_doc_*`, `pwa_view`,
`pwa_bracket_match`, `pwa_indent`, `pwa_line_*`, `pwa_hex_*` and the
`pwa_error_*` channel.  `source/wasm.js` wraps this as `Engine`.

### Server (`cpp/native/server.cpp`)

```
pwacode-server [docs-root] [-p port] [-w workspace] [--lna loopback|local|public] [--no-uring]
```

- Serves `docs/`, negotiating Brotli/Gzip.
- `GET /api/ping`
- `GET /api/list?path=...`
- `GET|PUT /api/file?path=...`
- `GET /ws/terminal` — RFC 6455 WebSocket PTY.
- LNA defaults to local addresses.
- Async I/O runs on io_uring where the kernel allows it.  When io_uring setup
  fails (Android, seccomp sandboxes) or `--no-uring` / `PWA_NO_IO_URING=1` is
  given, the server falls back to fast_io's POSIX thread-pool scheduler.  The
  PTY master is opened non-blocking on that backend so its timed reads still
  alternate shell and socket traffic.  No `std::thread` is used either way.
- File responses and the CLI map files with `fast_io::native_file_loader`
  (`mmap` on POSIX, mapping on Windows) and write the mapped bytes, rather than
  looping over `pread`.  The CLI maps the input directly, so the portable core
  reads the same bytes without a copy.

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
7. Terminal connects and echoes `FINAL_OK`.  On a remote server mount, the
   play button / `Ctrl+Shift+B` saves the file, opens the terminal, and runs the
   macro attached to the file extension; the ▾ picker runs any other macro.
8. Remote volume with a dead base URL shows a clean toast, not an unhandled
   rejection.
9. 390×844 layout has no horizontal overflow; the sidebar fills the space
   between the top and status bars, stays open when a directory is chosen, and
   closes only after a file is chosen.  The ⌨ toggle shows the extra key row
   and raises the OS keyboard; tapping the terminal raises it too, typing
   arrives at the PTY, and the extra row sits above the OS keyboard.
10. Offline reload is served by the service worker.
11. Native core: `pwacode-cli` view/hex/UTF-16 save.
12. Large file (the fast_io 76 MB `iobuf_file.txt`): opens in under a couple of
   seconds in the read-only partial view, the scrollbar reaches the end, and
   Ctrl+G maps to the requested line.
13. A string containing `/*`, `*/` or `//` is highlighted as a string, and code
   after `*/` on the same or later line is not tinted as a comment.
