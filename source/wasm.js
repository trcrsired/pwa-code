// pwa-code WebAssembly engine bridge.
//
// The C++ core only reports failures through herbceptions.  At the wasm C ABI
// boundary the failure is copied into pwa_error_* buffers; this wrapper turns
// that into a thrown JavaScript Error so browser callers can use ordinary
// try/catch.  No engine function returns a boolean status or errno-style code.

export class EngineError extends Error {
  constructor(message, kind, code) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
    this.code = code;
  }
}

export const ENCODINGS = [
  "UTF-8",
  "UTF-16LE",
  "UTF-16BE",
  "UTF-32LE",
  "UTF-32BE",
  "GB18030",
  "UTF-EBCDIC",
  "UTF-8LE",
];

export class Engine {
  constructor() {
    this.instance = null;
    this.exports = null;
  }

  async init(url = "pwacode.wasm") {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Could not fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const imports = {};
    if (WebAssembly.instantiateStreaming) {
      try {
        this.instance = (await WebAssembly.instantiateStreaming(response, imports)).instance;
      } catch {
        // Some static hosts serve wasm with the wrong MIME type; fall back.
        const bytes = await fetch(url, { cache: "no-cache" }).then((r) => r.arrayBuffer());
        this.instance = (await WebAssembly.instantiate(bytes, imports)).instance;
      }
    } else {
      const bytes = await response.arrayBuffer();
      this.instance = (await WebAssembly.instantiate(bytes, imports)).instance;
    }
    this.exports = this.instance.exports;
    if (this.exports.__wasm_call_ctors) this.exports.__wasm_call_ctors();
    return this.exports.pwa_version();
  }

  // ---- memory helpers -------------------------------------------------

  _put(bytes) {
    const ptr = this.exports.pwa_alloc(bytes.length || 1);
    if (!ptr && bytes.length !== 0) throw new Error("wasm allocation failed");
    if (bytes.length) new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  _putString(text) {
    return this._put(new TextEncoder().encode(text));
  }

  _bytes(ptr, len) {
    if (!len) return new Uint8Array();
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  _utf8(ptr, len) {
    if (!len) return "";
    return new TextDecoder().decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
  }

  _outBytes() {
    return this._bytes(this.exports.pwa_out_ptr(), this.exports.pwa_out_len());
  }

  _outText() {
    return this._utf8(this.exports.pwa_out_ptr(), this.exports.pwa_out_len());
  }

  _viewText() {
    return this._utf8(this.exports.pwa_view_ptr(), this.exports.pwa_view_len());
  }

  _check() {
    if (!this.exports.pwa_error_pending()) return;
    const message = this._utf8(this.exports.pwa_error_ptr(), this.exports.pwa_error_len());
    const kind = this.exports.pwa_error_kind();
    const code = this.exports.pwa_error_code();
    this.exports.pwa_error_clear();
    throw new EngineError(message || "engine failure", kind, code);
  }

  // ---- encoding -------------------------------------------------------

  probe(bytes) {
    const input = this._put(bytes);
    try {
      const packed = this.exports.pwa_probe(input.ptr, input.len);
      return {
        encoding: packed & 0xff,
        encodingName: ENCODINGS[packed & 0xff] || "unknown",
        hasBom: !!(packed & 0x100),
        sourceCrlf: !!(packed & 0x200),
        bomLength: packed >>> 10,
      };
    } finally {
      this.exports.pwa_free(input.ptr);
    }
  }

  transcode(bytes, from = -1) {
    const input = this._put(bytes);
    try {
      this.exports.pwa_transcode_to_utf8(input.ptr, input.len, from);
      this._check();
      return this._outBytes();
    } finally {
      this.exports.pwa_free(input.ptr);
    }
  }

  // ---- document -------------------------------------------------------

  load(bytes, path, forcedEncoding = -1) {
    const input = this._put(bytes);
    const remotePath = this._putString(path || "");
    try {
      const encoding = this.exports.pwa_doc_load(
        input.ptr,
        input.len,
        remotePath.ptr,
        remotePath.len,
        forcedEncoding,
      );
      this._check();
      if (encoding === 255 || encoding === 0xffffffff) {
        throw new EngineError("the file could not be decoded", 1, 0);
      }
      return {
        encoding,
        encodingName: ENCODINGS[encoding] || "unknown",
        bom: !!this.exports.pwa_doc_bom(),
        sourceCrlf: !!this.exports.pwa_doc_source_crlf(),
        lineCount: this.exports.pwa_doc_line_count(),
        size: this.exports.pwa_doc_size(),
      };
    } finally {
      this.exports.pwa_free(input.ptr);
      this.exports.pwa_free(remotePath.ptr);
    }
  }

  get text() {
    this.exports.pwa_doc_get_text();
    this._check();
    return this._outText();
  }

  setText(text) {
    const input = this._put(new TextEncoder().encode(text));
    try {
      this.exports.pwa_doc_set_text(input.ptr, input.len);
      this._check();
    } finally {
      this.exports.pwa_free(input.ptr);
    }
  }

  replace(beginByte, endByte, text) {
    const input = this._put(new TextEncoder().encode(text));
    try {
      this.exports.pwa_doc_replace(beginByte, endByte, input.ptr, input.len);
      this._check();
    } finally {
      this.exports.pwa_free(input.ptr);
    }
  }

  insert(offsetByte, text) {
    const input = this._put(new TextEncoder().encode(text));
    try {
      this.exports.pwa_doc_insert(offsetByte, input.ptr, input.len);
      this._check();
    } finally {
      this.exports.pwa_free(input.ptr);
    }
  }

  get encoding() {
    return this.exports.pwa_doc_encoding();
  }

  get bom() {
    return !!this.exports.pwa_doc_bom();
  }

  get sourceCrlf() {
    return !!this.exports.pwa_doc_source_crlf();
  }

  get lineCount() {
    return this.exports.pwa_doc_line_count();
  }

  get size() {
    return this.exports.pwa_doc_size();
  }

  get language() {
    this.exports.pwa_doc_language();
    this._check();
    return this._outText();
  }

  setEncoding(encoding, bom) {
    this.exports.pwa_doc_set_encoding(encoding, bom ? 1 : 0);
    this._check();
  }

  setEol(mode) {
    this.exports.pwa_doc_set_eol(mode);
    this._check();
  }

  saveText() {
    this.exports.pwa_doc_save_text();
    this._check();
    return this._outBytes();
  }

  // ---- view / editing -------------------------------------------------

  view(firstLine, count, lineNumbers = true) {
    this.exports.pwa_view(firstLine, count, lineNumbers ? 1 : 0);
    this._check();
    return this._viewText();
  }

  bracketMatch(offset) {
    return this.exports.pwa_bracket_match(offset);
  }

  indent(begin, end, mode, outdent) {
    this.exports.pwa_indent(begin, end, mode, outdent ? 1 : 0);
    this._check();
  }

  lineStart(line) {
    return this.exports.pwa_line_start(line);
  }

  lineOfOffset(offset) {
    return this.exports.pwa_line_of_offset(offset);
  }

  // ---- hex ------------------------------------------------------------

  get hexSize() {
    return this.exports.pwa_hex_size();
  }

  hexRender(offset, rows, columns) {
    this.exports.pwa_hex_render(offset, rows, columns);
    this._check();
    return this._viewText();
  }

  hexPatch(offset, value) {
    this.exports.pwa_hex_patch(offset, value & 0xff);
    this._check();
  }

  hexBytes() {
    this.exports.pwa_hex_bytes();
    this._check();
    return this._outBytes();
  }

  hexFromText() {
    // The bytes stay in the engine; callers that need them use hexBytes().
    this.exports.pwa_hex_from_text();
    this._check();
  }
}
