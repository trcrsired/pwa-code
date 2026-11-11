# pwa code

A portable code editor written in C++ with
[fast_io](https://github.com/cppfastio/fast_io), compiled to WebAssembly and
shipped as an installable PWA, plus an async native coding server.

- **Portable engine** — header-only `cpp/core/` works in wasm and natively.
- **Browser editor** — touch/mobile/desktop/tablet/VR, real textarea input with
  a wasm-rendered, refterm-style partial-view highlighting underlay.
- **Volumes** — browser OPFS (internal), any number of File System Access
  mounts (external), and any number of remote mounts (pwa-code server with
  read/write + terminal, or a plain HTTP directory index read-only), plus an
  optional WASI preview1 filesystem layer.
- **Large files** — above 8 MiB or 200k lines the editor switches to a
  read-only virtual partial view, so opening a 76 MB / 10M-line file does not
  stall the textarea.  Small files stay fully editable.
- **SIMD** — the wasm build uses `-msimd128`; the newline index and CRLF scan
  use `fast_io::intrinsics::simd_vector`, with a scalar fallback.
- **Encodings** — UTF-8, UTF-8LE, UTF-16LE/BE, UTF-32LE/BE, GB18030,
  UTF-EBCDIC, BOM detection.  Internally always UTF-8 + LF; save re-encodes with
  the source policy.
- **Editing** — Notepad++ keyword sets (36 languages), C++ `throws` /
  `return_failure`, VSCode-style bracket depth colours, find/replace, go to
  line, hex editor, extra-key row (Esc/Tab/Ctrl/Alt/arrows) that also raises
  the device's on-screen keyboard.
- **Terminal** — native async PTY over WebSocket.
- **Errors** — herbceptions only (`throws` / `catch throws (::std::error e)`);
  no errno-style status returns.  Native builds use `-fno-exceptions -fno-rtti
  -fno-unwind-tables -fno-asynchronous-unwind-tables -fno-ident`.
- **Themes** — dark (black/white) and light (white/black) only.

## Quick start

```sh
build/build-all.sh
./pwacode-server ./docs -p 8140 -w ./workspace
# open http://127.0.0.1:8140/
```

Requirements: `clang++` with herbceptions, fast_io headers, the wasm/native
configs referenced by the scripts, and Node.js for the web build step.  Run
`npm install` once for the build-only minifiers (`html-minifier-terser`,
`clean-css`, `terser`); nothing from `node_modules` is shipped.  Override paths
with `PWA_WASM_CONFIG`, `PWA_NATIVE_CONFIG`, `PWA_SERVER_OUT`, `PWA_CLI_OUT`.

`docs/` contains minified HTML/CSS/JS, like pwa-player, plus precompressed
`.gz`/`.br` copies alongside each text asset.

Individual targets:

```sh
build/build-wasm.sh     # source/pwacode.wasm
node build/build-web.mjs
build/build-native.sh   # ./pwacode-server
build/build-cli.sh      # ./pwacode-cli
```

## Server

```
pwacode-server [docs-root] [-p port] [-w workspace] [--lna loopback|local|public]
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/ping` | health check |
| `GET /api/list?path=...` | list a workspace directory |
| `GET/PUT /api/file?path=...` | read/write a workspace file |
| `GET /ws/terminal` | WebSocket PTY |

Static assets are served from `docs/` with Brotli/Gzip negotiation.  LNA
defaults to loopback/local peers; the terminal and HTTP server are fully async
and use no `std::thread`.  File responses use `fast_io::native_file_loader`
(memory-mapped I/O) instead of a `pread` loop, and the CLI maps its input the
same way.

## Native core demo

`pwacode-cli` runs the same headers as the wasm engine:

```sh
./pwacode-cli file.cpp --lines 80
./pwacode-cli file.cpp --hex 16
./pwacode-cli file.cpp --encoding 1 --save out.cpp
```

## Layout

```
cpp/core/       portable header-only engine
cpp/wasm/       wasm C ABI
cpp/native/     async server + CLI
source/         frontend source
docs/           built PWA (deploy this directory)
build/          build scripts
```

See [agent.md](agent.md) for architecture, error policy and the regression
checklist.

## License

See [LICENSE](LICENSE).
