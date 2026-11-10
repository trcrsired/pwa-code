// pwa-code application shell.
//
// The editor is a real textarea for native selection/IME/accessibility; the
// syntax layer underneath is rendered by the fast_io/wasm engine and only for
// the visible line window (refterm-style partial view).  Scrolling the
// textarea re-renders just that window, so very large files stay responsive.

import { Engine, EngineError, ENCODINGS } from "./wasm.js";
import { Volumes, ExternalVolume, baseName, parentPath } from "./storage.js";
import { Terminal, keyToBytes } from "./terminal.js";

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  theme: "dark",
  fontSize: 13,
  lineHeight: 20,
  lineNumbers: true,
  softKeyboard: false,
  indent: 0,
  autoSave: false,
  wrap: false,
  bracketColor: true,
  encoding: 0,
  eol: 0,
  remoteBase: "",
  termUrl: "",
  termLocalEcho: false,
  sidebarWidth: 0,
};

const EOL_LABELS = ["Preserve", "LF", "CRLF"];

const state = {
  engine: new Engine(),
  volumes: new Volumes(),
  settings: { ...DEFAULT_SETTINGS },
  path: "",
  volume: "internal",
  dirty: false,
  prevText: "",
  highlightFrame: 0,
  hexMode: false,
  hexOffset: 0,
  hexSelected: -1,
  term: null,
  ws: null,
  softMods: { ctrl: false, alt: false },
  autoSaveTimer: 0,
  engineReady: false,
  wrapRows: null,
  wrapLines: null,
  wrapKey: "",
  wrapOffsets: null,
  wrapDirty: true,
};

/* --------------------------------------------------------------- helpers */

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = String(message);
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), isError ? 5200 : 2400);
}

function fail(context, error) {
  const message = error instanceof EngineError
    ? `${context}: ${error.message}`
    : `${context}: ${error && error.message ? error.message : error}`;
  console.error(context, error);
  toast(message, true);
}

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function saveSettings() {
  try {
    localStorage.setItem("pwacode.settings.v1", JSON.stringify(state.settings));
  } catch {
    /* private mode */
  }
}

function readSettings() {
  try {
    const raw = localStorage.getItem("pwacode.settings.v1");
    if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
}

function applySettings() {
  const s = state.settings;
  document.body.dataset.theme = s.theme === "light" ? "light" : "dark";
  document.body.classList.toggle("no-bracket-color", !s.bracketColor);
  document.body.classList.toggle("wrap-mode", !!s.wrap);
  document.documentElement.style.setProperty("--font-size", `${s.fontSize}px`);
  document.documentElement.style.setProperty("--line-height", `${s.lineHeight}px`);
  document.documentElement.style.setProperty("--gutter-w", s.lineNumbers ? "" : "0px");
  $("gutter").hidden = !s.lineNumbers;
  const kb = $("softKeyboard");
  if (kb) kb.hidden = !s.softKeyboard;
  const editor = $("editor");
  editor.wrap = s.wrap ? "soft" : "off";
  const wrapBtn = $("statusWrap");
  wrapBtn.textContent = s.wrap ? "Wrap: on" : "Wrap: off";
  wrapBtn.classList.toggle("on", !!s.wrap);
  wrapBtn.setAttribute("aria-pressed", String(!!s.wrap));
  if (!s.wrap) {
    state.wrapRows = null;
    state.wrapLines = null;
    state.wrapOffsets = null;
    $("highlight").style.width = "";
  }
  state.wrapDirty = true;
  $("statusEncoding").textContent = ENCODINGS[
    state.engineReady ? state.engine.encoding : s.encoding
  ] || "UTF-8";
  $("statusEol").textContent = EOL_LABELS[s.eol] || "Preserve";
  applySidebarWidth();
  updateHighlight();
  if (state.hexMode) renderHex();
  if (state.term) resizeTerminal();
}

const SIDEBAR_MIN = 180;
const EDITOR_MIN = 320;

function clampSidebarWidth(width) {
  const max = Math.max(SIDEBAR_MIN, Math.min(560, window.innerWidth - EDITOR_MIN));
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(max, Number(width) || 0)));
}

// 0 means "use the stylesheet default", which keeps the responsive widths the
// media queries pick on narrow screens.
function applySidebarWidth() {
  const width = Number(state.settings.sidebarWidth) || 0;
  if (width > 0) {
    document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(width)}px`);
  } else {
    document.documentElement.style.removeProperty("--sidebar-w");
  }
}

function updateDirty(dirty) {
  state.dirty = dirty;
  $("dirtyDot").hidden = !dirty;
}

function updateStatus() {
  const editor = $("editor");
  const text = editor.value;
  const cursor = editor.selectionStart;
  const before = text.slice(0, cursor);
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const col = cursor - lastNl;
  $("statusLine").textContent = `Ln ${line}, Col ${col}`;
  const selected = editor.selectionEnd - editor.selectionStart;
  $("statusSel").textContent = selected ? `Sel ${selected}` : "";
  $("statusLang").textContent = state.engineReady ? (state.engine.language || "plain") : "plain";
  $("statusSize").textContent = formatBytes(state.engineReady ? state.engine.size : new TextEncoder().encode(text).length);
  if (state.engineReady) {
    $("statusEncoding").textContent = ENCODINGS[state.engine.encoding] || "UTF-8";
  }
  $("statusWasm").textContent = state.engineReady ? "wasm" : "engine…";
  $("docName").textContent = state.path || "untitled";
  updateGutterCursor(line);
}

function updateGutterCursor(line) {
  if (!state.settings.lineNumbers) return;
  for (const el of $("gutter").querySelectorAll(".gl")) {
    el.classList.toggle("current", Number(el.dataset.line) === line - 1);
  }
}

/* ------------------------------------------------------- editor renderer */

function fontSizeMetrics() {
  const s = state.settings;
  return { size: s.fontSize, lineHeight: s.lineHeight };
}

function renderGutter(first, count) {
  if (!state.settings.lineNumbers) {
    $("gutter").textContent = "";
    return;
  }
  const { lineHeight } = fontSizeMetrics();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const n = first + i;
    if (n >= state.engine.lineCount) break;
    const div = document.createElement("div");
    div.className = "gl";
    div.dataset.line = String(n);
    div.textContent = String(n + 1);
    // In wrap mode a logical line owns as many visual rows as it wraps into,
    // so the number sits at the top of its block.
    div.style.height = `${(state.settings.wrap ? wrapRowsOf(n) : 1) * lineHeight}px`;
    div.style.lineHeight = `${lineHeight}px`;
    frag.appendChild(div);
  }
  const gutter = $("gutter");
  gutter.textContent = "";
  gutter.appendChild(frag);
  const digits = Math.max(2, String(state.engine.lineCount).length);
  const width = Math.max(38, digits * (state.settings.fontSize * 0.62) + 20);
  document.documentElement.style.setProperty("--gutter-w", `${width}px`);
}

function updateHighlight() {
  if (!state.engineReady) return;
  if (state.highlightFrame) return;
  state.highlightFrame = requestAnimationFrame(() => {
    state.highlightFrame = 0;
    renderWindow();
  });
}

/* ------------------------------------------------------------ wrap layout */

// In wrap mode one logical line can occupy several visual rows, so the
// highlight offset and the gutter heights need a per-line row count.  Every
// line wraps on its own, so the table is rebuilt by re-measuring only the
// lines an edit actually touched.
const WRAP_MAP_LIMIT = 20000;

function wrapMeasureEl() {
  let el = $("wrapMeasure");
  if (!el) {
    el = document.createElement("div");
    el.id = "wrapMeasure";
    el.className = "wrap-measure";
    el.setAttribute("aria-hidden", "true");
    $("editorWrap").appendChild(el);
  }
  return el;
}

function measureWrapRows(lines) {
  const { lineHeight } = fontSizeMetrics();
  const editor = $("editor");
  const el = wrapMeasureEl();
  // The textarea loses 11px to its scrollbar when the document overflows, so
  // the mirror has to use the textarea's real content width, not 100%.
  if (editor.clientWidth > 0) el.style.width = `${editor.clientWidth}px`;
  el.textContent = "";
  const frag = document.createDocumentFragment();
  for (const text of lines) {
    // An empty line still needs a line box, hence the nbsp.
    const div = document.createElement("div");
    div.textContent = text.length ? text : "\u00a0";
    frag.appendChild(div);
  }
  el.appendChild(frag);
  const rows = new Uint16Array(lines.length);
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const height = children[i].getBoundingClientRect().height;
    rows[i] = Math.max(1, Math.round(height / lineHeight) || 1);
  }
  el.textContent = "";
  return rows;
}

function refreshWrapRows() {
  const editor = $("editor");
  // A hidden editor has no layout to measure; stay dirty until it comes back.
  if (!editor.clientWidth || !editor.clientHeight) return;
  const lines = editor.value.split("\n");
  if (lines.length > WRAP_MAP_LIMIT) {
    state.wrapRows = null;
    state.wrapLines = null;
    state.wrapOffsets = null;
    state.wrapDirty = false;
    return;
  }
  const old = state.wrapLines;
  // Wrapping depends on the text, the width and the font metrics; a change to
  // any of them invalidates the whole table, not just the edited lines.
  const key = `${editor.clientWidth}x${state.settings.fontSize}x${state.settings.lineHeight}`;
  const sameLayout = state.wrapKey === key;
  let rows;
  if (!old || !state.wrapRows || !sameLayout) {
    rows = measureWrapRows(lines);
  } else {
    const min = Math.min(old.length, lines.length);
    let prefix = 0;
    while (prefix < min && old[prefix] === lines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < min - prefix && old[old.length - 1 - suffix] === lines[lines.length - 1 - suffix]) {
      suffix++;
    }
    if (old.length === lines.length && prefix === min) {
      state.wrapDirty = false;
      return; // same text and layout, the table is still valid
    }
    const middle = measureWrapRows(lines.slice(prefix, lines.length - suffix));
    rows = new Uint16Array(lines.length);
    rows.set(state.wrapRows.subarray(0, prefix), 0);
    rows.set(middle, prefix);
    rows.set(state.wrapRows.subarray(old.length - suffix), lines.length - suffix);
  }
  state.wrapRows = rows;
  state.wrapLines = lines;
  state.wrapKey = key;
  const offsets = new Int32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + rows[i];
  state.wrapOffsets = offsets;
  state.wrapDirty = false;
}

// Greatest logical line whose first visual row is at or above `row`.
function wrapLineAtRow(row) {
  const offsets = state.wrapOffsets;
  const last = Math.max(0, state.engine.lineCount - 1);
  if (!offsets) return Math.min(last, Math.max(0, Math.floor(row)));
  let lo = 0;
  let hi = Math.min(offsets.length - 1, last);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function wrapRowsOf(line) {
  const offsets = state.wrapOffsets;
  if (!offsets || line + 1 >= offsets.length) return 1;
  return Math.max(1, offsets[line + 1] - offsets[line]);
}

function renderWindow() {
  if (!state.engineReady) return;
  const editor = $("editor");
  const { lineHeight } = fontSizeMetrics();
  const wrap = !!state.settings.wrap;
  if (wrap && (state.wrapDirty || !state.wrapOffsets)) refreshWrapRows();
  const scrollTop = editor.scrollTop;
  const scrollLeft = editor.scrollLeft;
  const rowsTop = scrollTop / lineHeight;
  const rowsVisible = Math.ceil(editor.clientHeight / lineHeight) + 2;
  const first = wrap ? wrapLineAtRow(rowsTop) : Math.max(0, Math.floor(rowsTop));
  let count;
  if (wrap && state.wrapOffsets) {
    const last = wrapLineAtRow(rowsTop + rowsVisible);
    count = Math.max(1, Math.min(last - first + 1, state.engine.lineCount - first));
  } else {
    count = Math.max(1, Math.min(rowsVisible, state.engine.lineCount - first));
  }
  let html;
  try {
    html = state.engine.view(first, count, false);
  } catch (error) {
    fail("render", error);
    return;
  }
  const hl = $("highlight");
  if (wrap && editor.clientWidth > 0) hl.style.width = `${editor.clientWidth}px`;
  hl.innerHTML = html;
  const top =
    wrap && state.wrapOffsets && state.wrapOffsets[first] !== undefined
      ? state.wrapOffsets[first] * lineHeight
      : first * lineHeight;
  const offsetY = scrollTop - top;
  hl.style.transform = `translate(${-scrollLeft}px, ${-offsetY}px)`;
  renderGutter(first, count);
  const gutterInner = $("gutter");
  gutterInner.style.transform = "";
  // Shift the small rendered gutter window by the same sub-line amount.
  const wrapEl = document.createElement("div");
  while (gutterInner.firstChild) wrapEl.appendChild(gutterInner.firstChild);
  wrapEl.style.transform = `translateY(${-offsetY}px)`;
  gutterInner.appendChild(wrapEl);
  updateStatus();
  if (state.hexMode) return;
}

/* ------------------------------------------------------------- doc sync */

function syncEditorToEngine() {
  const editor = $("editor");
  const value = editor.value;
  const old = state.prevText;
  if (value === old) return;
  let prefix = 0;
  const min = Math.min(old.length, value.length);
  while (prefix < min && old.charCodeAt(prefix) === value.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < min - prefix &&
    old.charCodeAt(old.length - 1 - suffix) === value.charCodeAt(value.length - 1 - suffix)
  ) {
    suffix++;
  }
  const removed = old.slice(prefix, old.length - suffix);
  const inserted = value.slice(prefix, value.length - suffix);
  try {
    const begin = utf8Length(value.slice(0, prefix));
    const end = begin + utf8Length(removed);
    state.engine.replace(begin, end, inserted);
    state.prevText = value;
  } catch (error) {
    fail("edit", error);
    // Put the engine back in sync rather than leaving a half-applied edit.
    try {
      state.engine.setText(value);
      state.prevText = value;
    } catch (inner) {
      fail("resync", inner);
    }
  }
  updateStatus();
}

function setEditorText(text) {
  const editor = $("editor");
  editor.value = text;
  state.prevText = text;
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  state.wrapDirty = true;
  updateHighlight();
  updateStatus();
}

/* -------------------------------------------------------------- volumes UI */

function setVolTab(kind) {
  state.volumes.current = kind;
  state.volumes.path = "";
  document.querySelectorAll(".vol-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.vol === kind),
  );
  renderMountBar();
}

// -------------------------------------------------------------- path bar

// The path bar doubles as an address box: it always shows "/<path>" inside the
// active mount, and typing a path plus Enter navigates there (or opens the file
// when the last segment is one).
function setPathDisplay() {
  $("pathBar").value = `/${state.volumes.path}`;
}

function normalizeVolumePath(text) {
  const parts = [];
  // Paths are relative to the mount root, so a leading "/" and a ".." above the
  // root are both silent no-ops rather than errors.
  for (const part of String(text || "").trim().split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

async function goToTypedPath(text) {
  const target = normalizeVolumePath(text === undefined ? $("pathBar").value : text);
  if (target === state.volumes.path) {
    setPathDisplay();
    return;
  }
  try {
    const volume = state.volumes.active();
    try {
      await volume.list(target);
      state.volumes.path = target;
      await refreshFiles();
      return;
    } catch {
      // Not a directory: treat it as a file inside the parent we can show.
    }
    state.volumes.path = parentPath(target);
    await refreshFiles();
    await openPath(target);
  } catch (error) {
    fail("path", error);
    setPathDisplay();
  }
}

function renderMountBar() {
  const bar = $("mountBar");
  bar.textContent = "";
  const kind = state.volumes.current;
  if (kind === "internal") {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  for (const mount of state.volumes.mounts(kind)) {
    const chip = document.createElement("span");
    chip.className = "mount-chip";
    chip.classList.toggle("active", mount.id === state.volumes.mount);
    chip.title = mount.detail ? `${mount.label} — ${mount.detail}` : mount.label;
    const name = document.createElement("span");
    name.className = "mount-name";
    name.textContent = mount.label;
    const off = document.createElement("span");
    off.className = "mount-x";
    off.textContent = "×";
    off.setAttribute("role", "button");
    off.title = "Unmount";
    off.addEventListener("click", (event) => {
      event.stopPropagation();
      unmount(kind, mount);
    });
    chip.append(name, off);
    chip.addEventListener("click", () => selectMount(kind, mount.id));
    bar.appendChild(chip);
  }
  const add = document.createElement("span");
  add.className = "mount-chip add";
  add.setAttribute("role", "button");
  add.textContent = "+";
  add.title = kind === "external" ? "Mount another folder" : "Add remote mount";
  add.addEventListener("click", () => (kind === "external" ? mountExternal() : openMountModal()));
  bar.appendChild(add);
}

async function selectMount(kind, id) {
  setVolTab(kind);
  state.volumes.mount = id;
  renderMountBar();
  await refreshFiles();
}

async function unmount(kind, mount) {
  if (!confirm(`Unmount ${mount.label}?`)) return;
  try {
    await state.volumes.removeMount(kind, mount.id);
    renderMountBar();
    await refreshFiles();
    toast(`unmounted ${mount.label}`);
  } catch (error) {
    fail("unmount", error);
  }
}

async function mountExternal() {
  if (!ExternalVolume.supported()) {
    toast("This browser cannot mount folders (File System Access API missing).", true);
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const id = await state.volumes.addExternalMount(handle);
    setVolTab("external");
    state.volumes.mount = id;
    renderMountBar();
    await refreshFiles();
    toast(`mounted ${handle.name}`);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    fail("mount folder", error);
  }
}

function openMountModal() {
  $("mountName").value = "";
  $("mountUrl").value = "";
  $("mountMode").value = "auto";
  $("mountModal").hidden = false;
  $("mountName").focus();
}

async function addMountFromForm() {
  const name = $("mountName").value;
  const url = $("mountUrl").value;
  const mode = $("mountMode").value;
  try {
    const id = await state.volumes.addRemoteMount(name, url, mode);
    $("mountModal").hidden = true;
    setVolTab("remote");
    state.volumes.mount = id;
    renderMountBar();
    await refreshFiles();
    toast(`mounted ${name}`);
  } catch (error) {
    fail("add mount", error);
  }
}

/* ---------------------------------------------------------------- loading */

async function openPath(path) {
  try {
    const volume = state.volumes.active();
    const bytes = await volume.read(path);
    const info = state.engine.load(bytes, path, -1);
    state.path = path;
    state.volume = state.volumes.ref();
    setEditorText(state.engine.text);
    // Keep the buffer LF.  Preserve means a CRLF source is written back as
    // CRLF and an LF source stays LF; explicit LF/CRLF remains a user choice.
    state.engine.setEol(1);
    state.settings.eol = 0;
    state.engine.setEol(0);
    $("statusEol").textContent = EOL_LABELS[0];
    updateDirty(false);
    state.hexMode = false;
    $("hexWrap").hidden = true;
    $("editorWrap").hidden = false;
    $("docName").textContent = path;
    toast(`${path} • ${info.encodingName}${info.sourceCrlf ? " • CRLF" : ""}`);
    renderWindow();
    $("editor").focus();
  } catch (error) {
    fail("open", error);
  }
}

async function refreshFiles() {
  const list = $("fileList");
  list.textContent = "";
  setPathDisplay();
  let volume = null;
  try {
    volume = state.volumes.active();
  } catch {
    volume = null;
  }
  if (!volume) {
    const kind = state.volumes.current;
    $("volStatus").textContent = kind === "internal" ? "internal storage" : `no ${kind} mount yet`;
    const hint = document.createElement("div");
    hint.className = "file-empty";
    hint.textContent = kind === "external"
      ? "No external folder mounted. Use + to mount one."
      : "No remote mount yet. Use + to add an HTTP directory or pwa-code server.";
    list.appendChild(hint);
    return;
  }
  $("volStatus").textContent =
    `${volume.label} • ${volume.kind}${volume.readOnly ? " • read-only" : ""}`;
  try {
    const entries = await volume.list(state.volumes.path);
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "file-empty";
      empty.textContent = "Empty folder. Create a file or choose another volume.";
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.setAttribute("role", "option");
      row.dataset.name = entry.name;
      row.dataset.dir = entry.dir ? "1" : "0";
      const icon = document.createElement("span");
      icon.className = "ficon";
      icon.textContent = entry.dir ? "▸" : "·";
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = entry.name;
      row.append(icon, name);
      if (!volume.readOnly) {
        const del = document.createElement("button");
        del.className = "fdel";
        del.title = entry.dir ? "Remove folder" : "Remove file";
        del.textContent = "×";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          removeEntry(entry);
        });
        row.appendChild(del);
      }
      row.addEventListener("click", () => {
        if (entry.dir) {
          state.volumes.path = state.volumes.path
            ? `${state.volumes.path}/${entry.name}`
            : entry.name;
          setPathDisplay();
          refreshFiles();
        } else {
          const path = state.volumes.path
            ? `${state.volumes.path}/${entry.name}`
            : entry.name;
          openPath(path);
        }
      });
      const full = state.volumes.path ? `${state.volumes.path}/${entry.name}` : entry.name;
      row.classList.toggle("active", !entry.dir && full === state.path);
      list.appendChild(row);
    }
  } catch (error) {
    $("volStatus").textContent = `${volume.label} unavailable`;
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = error.message || String(error);
    list.appendChild(empty);
    if (state.volumes.current === "remote") {
      toast("Remote mount is not reachable. Check its URL, or add a new mount.", true);
    }
  }
  setPathDisplay();
}

async function removeEntry(entry) {
  const path = state.volumes.path ? `${state.volumes.path}/${entry.name}` : entry.name;
  if (!confirm(`Remove ${path}?`)) return;
  try {
    await state.volumes.active().remove(path, entry.dir);
    if (state.path === path) {
      state.path = "";
      updateDirty(false);
    }
    await refreshFiles();
    toast(`removed ${path}`);
  } catch (error) {
    fail("remove", error);
  }
}

async function newFile() {
  const name = prompt("New file name");
  if (!name) return;
  const path = state.volumes.path ? `${state.volumes.path}/${name}` : name;
  try {
    await state.volumes.active().write(path, new Uint8Array());
    await refreshFiles();
    await openPath(path);
  } catch (error) {
    fail("create file", error);
  }
}

async function newFolder() {
  const name = prompt("New folder name");
  if (!name) return;
  const path = state.volumes.path ? `${state.volumes.path}/${name}` : name;
  try {
    await state.volumes.active().mkdir(path);
    await refreshFiles();
  } catch (error) {
    fail("create folder", error);
  }
}

/* ------------------------------------------------------------------ save */

async function saveDocument(saveAs = false) {
  if (!state.engineReady) return;
  if (!state.path || saveAs) {
    const suggested = state.path || "untitled.txt";
    const name = prompt("Save as (path inside the current volume)", suggested);
    if (!name) return;
    state.path = name;
    state.volume = state.volumes.ref();
  }
  try {
    syncEditorToEngine();
    state.engine.setEncoding(state.engine.encoding, state.engine.bom);
    state.engine.setEol(state.settings.eol);
    const bytes = state.engine.saveText();
    await state.volumes.get(state.volume).write(state.path, bytes);
    updateDirty(false);
    $("docName").textContent = state.path;
    toast(`saved ${state.path} • ${formatBytes(bytes.length)}`);
    await refreshFiles();
  } catch (error) {
    fail("save", error);
  }
}

/* ------------------------------------------------------------------ close */

// Ctrl+W asks for a tab to go away, not for the whole installed app to be
// torn down with its session, mounts and terminal.  The document is the one
// tab here, so closing it drops the buffer back to an empty "untitled".
function closeDocument() {
  if (!state.engineReady) return;
  const name = state.path || "untitled";
  if (state.dirty && !confirm(`Discard unsaved changes to ${name}?`)) return;
  if (state.hexMode) {
    state.hexMode = false;
    $("hexWrap").hidden = true;
    $("editorWrap").hidden = false;
  }
  try {
    state.engine.setText("");
  } catch (error) {
    fail("close", error);
    return;
  }
  state.path = "";
  state.volume = state.volumes.ref();
  setEditorText("");
  state.settings.eol = 0;
  $("statusEol").textContent = EOL_LABELS[0];
  $("docName").textContent = "untitled";
  updateDirty(false);
  toast(`closed ${name}`);
}

/* ------------------------------------------------------------ open files */

async function openFromFileInput(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = state.engine.load(bytes, file.name, -1);
    state.path = "";
    state.volume = state.volumes.ref();
    setEditorText(state.engine.text);
    state.settings.eol = 0;
    $("statusEol").textContent = EOL_LABELS[0];
    updateDirty(true);
    toast(`${file.name} • ${info.encodingName} • unsaved buffer`);
  } catch (error) {
    fail("open file", error);
  }
}

/* ------------------------------------------------------------------- hex */

function parseOffset(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^0x/i.test(text)) return parseInt(text.slice(2), 16) || 0;
  return parseInt(text, 10) || 0;
}

function openHex() {
  if (!state.engineReady) return;
  syncEditorToEngine();
  try {
    if (!state.hexMode) {
      state.engine.hexFromText();
      state.hexMode = true;
      state.hexOffset = 0;
      $("hexWrap").hidden = false;
      $("editorWrap").hidden = true;
      $("hexView").scrollTop = 0;
    }
    $("hexInfo").textContent = `${formatBytes(state.engine.hexSize)} • ${state.engine.hexSize} bytes`;
    renderHex();
  } catch (error) {
    fail("hex", error);
  }
}

function closeHex() {
  state.hexMode = false;
  $("hexWrap").hidden = true;
  $("editorWrap").hidden = false;
  state.wrapDirty = true;
  renderWindow();
}

function renderHex() {
  if (!state.hexMode) return;
  const columns = Number($("hexColumns").value) || 16;
  const view = $("hexView");
  const rowHeight = 20;
  const firstRow = Math.max(0, Math.floor(view.scrollTop / rowHeight));
  const rows = Math.ceil(view.clientHeight / rowHeight) + 2;
  const offset = firstRow * columns;
  state.hexOffset = offset;
  try {
    const body = state.engine.hexRender(offset, rows, columns);
    const totalRows = Math.ceil(state.engine.hexSize / columns);
    const top = firstRow * rowHeight;
    const bottom = Math.max(0, (totalRows - firstRow - rows) * rowHeight);
    view.innerHTML = `<div style="height:${top}px"></div>${body}<div style="height:${bottom}px"></div>`;
    $("hexOffset").value = String(offset);
    $("hexInfo").textContent = `${formatBytes(state.engine.hexSize)} • ${state.engine.hexSize} bytes`;
  } catch (error) {
    fail("render hex", error);
  }
}

function hexSelect(offset) {
  state.hexSelected = offset;
  for (const el of document.querySelectorAll(".hb")) el.classList.remove("hex-byte-sel");
  const target = document.querySelector(`.hb[data-o="${offset}"]`);
  if (target) {
    target.classList.add("hex-byte-sel");
    $("hexByte").value = target.textContent.trim();
  }
  $("hexByte").focus();
  $("hexByte").select();
}

function hexApply() {
  let offset = state.hexSelected;
  if (offset < 0) offset = parseOffset($("hexOffset").value);
  const value = parseInt($("hexByte").value, 16);
  if (Number.isNaN(value)) {
    toast("byte must be hex, e.g. 4A", true);
    return;
  }
  try {
    state.engine.hexPatch(offset, value);
    state.hexSelected = offset + 1;
    state.wrapDirty = true;
    renderHex();
    toast(`byte ${offset.toString(16).padStart(8, "0")} = ${(value & 0xff).toString(16).toUpperCase().padStart(2, "0")}`);
  } catch (error) {
    fail("patch byte", error);
  }
}

async function saveHex() {
  try {
    const bytes = state.engine.hexBytes();
    let path = state.path;
    if (!path) {
      path = prompt("Save bytes as", "untitled.bin");
      if (!path) return;
    }
    await state.volumes.get(state.volume).write(path, bytes);
    toast(`saved ${path} • ${formatBytes(bytes.length)}`);
    await refreshFiles();
  } catch (error) {
    fail("save hex", error);
  }
}

/* -------------------------------------------------------------- terminal */

function terminalUrl() {
  if (state.settings.termUrl) return state.settings.termUrl;
  // A remote mount of the pwa-code server family also carries the PTY
  // terminal, so "connect" targets the machine whose files are open.
  if (state.volumes.current === "remote") {
    let volume = null;
    try {
      volume = state.volumes.get(state.volumes.ref());
    } catch {
      volume = null;
    }
    if (volume && volume.server && volume.base) {
      try {
        const url = new URL(volume.base);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws/term`;
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        /* fall through to same origin */
      }
    }
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/term`;
}

function connectTerminal() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    state.ws.close();
  }
  if (!state.term) {
    state.term = new Terminal($("term"), {
      onData: (data) => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(data);
      },
    });
  }
  const url = terminalUrl();
  $("termStatus").textContent = "connecting…";
  try {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.onopen = () => {
      $("termStatus").textContent = "connected";
      $("term").focus();
      resizeTerminal();
    };
    ws.onclose = () => {
      $("termStatus").textContent = "disconnected";
    };
    ws.onerror = () => {
      $("termStatus").textContent = "error";
      toast("Terminal WebSocket failed. Start the native server or set a URL in Settings.", true);
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        state.term.feed(event.data);
      } else {
        state.term.feedBytes(new Uint8Array(event.data));
      }
    };
  } catch (error) {
    fail("terminal", error);
  }
}

function resizeTerminal() {
  if (!state.term) return;
  const el = $("term");
  const meas = document.createElement("span");
  meas.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  meas.textContent = "M".repeat(40);
  el.appendChild(meas);
  const charWidth = meas.getBoundingClientRect().width / 40 || 8;
  meas.remove();
  const lineHeight = state.settings.lineHeight * 1.25 || 20;
  const cols = Math.max(20, Math.floor((el.clientWidth - 18) / charWidth));
  const rows = Math.max(5, Math.floor((el.clientHeight - 14) / lineHeight));
  state.term.resize(cols, rows);
}

function toggleTerminal(show) {
  const wrap = $("termWrap");
  const visible = show ?? wrap.hidden;
  wrap.hidden = !visible;
  if (visible && state.hexMode) {
    closeHex();
  }
  $("editorWrap").hidden = visible || state.hexMode;
  if (!visible) {
    if (state.ws) {
      try { state.ws.close(); } catch { /* already closed */ }
      state.ws = null;
    }
    $("termStatus").textContent = "disconnected";
    $("editorWrap").hidden = state.hexMode;
    if (state.hexMode) $("hexWrap").hidden = false;
    return;
  }
  if (!state.ws) connectTerminal();
  requestAnimationFrame(resizeTerminal);
}

function sendTerminalKey(key, mods) {
  if (!state.term) return;
  let bytes = keyToBytes({
    key,
    ctrlKey: mods.ctrl,
    altKey: mods.alt,
    metaKey: false,
  });
  if (key.length === 1 && mods.ctrl) bytes = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
  if (!bytes) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(bytes);
  } else {
    toast("Terminal is not connected", true);
  }
}

/* --------------------------------------------------------- soft keyboard */

function toggleWrap() {
  state.settings.wrap = !state.settings.wrap;
  saveSettings();
  applySettings();
  updateHighlight();
  toast(`line wrap: ${state.settings.wrap ? "on" : "off"}`);
}

function toggleSoftKeyboard(show) {
  const kb = $("softKeyboard");
  const visible = show ?? kb.hidden;
  kb.hidden = !visible;
  document.body.classList.toggle("softkb", visible);
  state.settings.softKeyboard = visible;
  saveSettings();
}

function editorKeyCommand(key, mods) {
  const editor = $("editor");
  if (document.activeElement !== editor && mods.ctrl) editor.focus();
  switch (key) {
    case "Tab":
      insertAtCursor(state.settings.indent === 1 ? "\t" : "  ");
      return true;
    case "Enter":
      insertNewline();
      return true;
    case "Backspace":
      deleteBackward();
      return true;
    case "Delete":
      deleteForward();
      return true;
    case "Escape":
      editor.blur();
      return true;
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
      return false; // let native handling run
    default:
      return false;
  }
}

function insertAtCursor(text) {
  const editor = $("editor");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(text, start, end, "end");
  editor.dispatchEvent(new Event("input"));
}

function insertNewline() {
  const editor = $("editor");
  const start = editor.selectionStart;
  const value = editor.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const indent = (value.slice(lineStart, start).match(/^[ \t]*/) || [""])[0];
  insertAtCursor(`\n${indent}`);
}

function deleteBackward() {
  const editor = $("editor");
  if (editor.selectionStart === editor.selectionEnd && editor.selectionStart > 0) {
    editor.setRangeText("", editor.selectionStart - 1, editor.selectionStart, "end");
    editor.dispatchEvent(new Event("input"));
  } else {
    insertAtCursor("");
  }
}

function deleteForward() {
  const editor = $("editor");
  if (editor.selectionStart === editor.selectionEnd && editor.selectionStart < editor.value.length) {
    editor.setRangeText("", editor.selectionStart, editor.selectionStart + 1, "end");
    editor.dispatchEvent(new Event("input"));
  }
}

/* ------------------------------------------------------------- find/replace */

function openFind(replace) {
  const bar = $("findBar");
  bar.hidden = false;
  const editor = $("editor");
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selected && !selected.includes("\n")) $("findText").value = selected;
  ($("findText") || {}).focus?.();
  $("findText").focus();
  $("findText").select();
  if (replace) $("replaceText").focus();
}

function closeFind() {
  $("findBar").hidden = true;
  $("editor").focus();
}

function findNext(direction = 1) {
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const haystack = $("findCase").checked ? editor.value : editor.value.toLowerCase();
  const target = $("findCase").checked ? needle : needle.toLowerCase();
  let from;
  if (direction > 0) {
    from = editor.selectionEnd;
    let at = haystack.indexOf(target, from);
    if (at < 0) at = haystack.indexOf(target, 0);
    if (at < 0) {
      toast("not found");
      return;
    }
    editor.setSelectionRange(at, at + needle.length);
  } else {
    from = editor.selectionStart;
    let at = haystack.lastIndexOf(target, Math.max(0, from - 1));
    if (at < 0) at = haystack.lastIndexOf(target);
    if (at < 0) {
      toast("not found");
      return;
    }
    editor.setSelectionRange(at, at + needle.length);
  }
  editor.focus();
  revealSelection();
  updateStatus();
}

function revealSelection() {
  const editor = $("editor");
  const value = editor.value;
  const before = value.slice(0, editor.selectionStart);
  const line = before.split("\n").length - 1;
  const lineHeight = state.settings.lineHeight;
  if (state.settings.wrap && state.wrapOffsets) {
    if (state.wrapDirty) refreshWrapRows();
  }
  const top =
    state.settings.wrap && state.wrapOffsets
      ? state.wrapOffsets[Math.min(line, state.wrapOffsets.length - 1)] * lineHeight
      : line * lineHeight;
  if (top < editor.scrollTop || top + lineHeight > editor.scrollTop + editor.clientHeight) {
    editor.scrollTop = Math.max(0, top - editor.clientHeight / 3);
    updateHighlight();
  }
}

function replaceOne() {
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const current = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const equal = $("findCase").checked
    ? current === needle
    : current.toLowerCase() === needle.toLowerCase();
  if (!equal) {
    findNext(1);
    return;
  }
  insertAtCursor($("replaceText").value);
  findNext(1);
}

function replaceAll() {
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const replacement = $("replaceText").value;
  let value = editor.value;
  let count = 0;
  if ($("findCase").checked) {
    while (value.includes(needle)) {
      value = value.replace(needle, replacement);
      count++;
    }
  } else {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    value = value.replace(re, () => {
      count++;
      return replacement;
    });
  }
  if (!count) {
    toast("not found");
    return;
  }
  editor.value = value;
  editor.dispatchEvent(new Event("input"));
  toast(`replaced ${count}`);
}

function goToLine() {
  const text = prompt("Go to line", String($("editor").value.slice(0, $("editor").selectionStart).split("\n").length));
  if (!text) return;
  const wanted = Math.max(1, parseInt(text, 10) || 1);
  const lines = $("editor").value.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(wanted - 1, lines.length); i++) offset += lines[i].length + 1;
  $("editor").focus();
  $("editor").setSelectionRange(offset, offset);
  revealSelection();
  updateStatus();
}

/* ---------------------------------------------------------------- settings */

function populateSettingsForm() {
  const s = state.settings;
  $("setTheme").value = s.theme;
  $("setFontSize").value = String(s.fontSize);
  $("setLineHeight").value = String(s.lineHeight);
  $("setLineNumbers").checked = s.lineNumbers;
  $("setWrap").checked = s.wrap;
  $("setSoftKeyboard").checked = s.softKeyboard;
  $("setIndent").value = String(s.indent);
  $("setAutoSave").checked = s.autoSave;
  $("setBracketColor").checked = s.bracketColor;
  $("setEncoding").value = String(s.encoding);
  $("setEol").value = String(s.eol);
  $("setRemoteBase").value = s.remoteBase;
  $("setTermUrl").value = s.termUrl;
  $("setTermLocalEcho").checked = s.termLocalEcho;
}

function fillEncodingOptions() {
  const select = $("setEncoding");
  select.textContent = "";
  ENCODINGS.forEach((name, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = name;
    select.appendChild(option);
  });
}

async function applySettingsForm() {
  const s = state.settings;
  s.theme = $("setTheme").value;
  s.fontSize = Math.max(9, Math.min(32, Number($("setFontSize").value) || 13));
  s.lineHeight = Math.max(s.fontSize + 2, Math.min(48, Number($("setLineHeight").value) || 20));
  s.lineNumbers = $("setLineNumbers").checked;
  s.wrap = $("setWrap").checked;
  s.softKeyboard = $("setSoftKeyboard").checked;
  s.indent = Number($("setIndent").value) || 0;
  s.autoSave = $("setAutoSave").checked;
  s.bracketColor = $("setBracketColor").checked;
  s.encoding = Number($("setEncoding").value) || 0;
  s.eol = Number($("setEol").value) || 0;
  s.remoteBase = $("setRemoteBase").value.trim();
  s.termUrl = $("setTermUrl").value.trim();
  s.termLocalEcho = $("setTermLocalEcho").checked;
  saveSettings();
  applySettings();
  updateHighlight();
  if (s.remoteBase) {
    try {
      await state.volumes.syncDefaultRemote(s.remoteBase);
    } catch {
      /* invalid legacy URL */
    }
  }
  if (state.engineReady) {
    state.engine.setEncoding(s.encoding, state.engine.bom);
    state.engine.setEol(s.eol);
  }
  $("statusEol").textContent = EOL_LABELS[s.eol];
  renderMountBar();
  if (state.volumes.current !== "internal") await refreshFiles();
  toast("settings saved");
}

/* ------------------------------------------------------------------ init */

async function init() {
  readSettings();
  fillEncodingOptions();
  applySettings();
  $("statusWasm").textContent = "loading…";

  try {
    const version = await state.engine.init("pwacode.wasm");
    state.engineReady = true;
    $("statusWasm").textContent = `wasm v${version}`;
  } catch (error) {
    fail("engine", error);
    $("statusWasm").textContent = "engine failed";
  }

  await state.volumes.init(state.settings.remoteBase);
  setVolTab("internal");
  document.querySelectorAll(".vol-tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      setVolTab(tab.dataset.vol);
      await refreshFiles();
    });
  });

  if (state.engineReady) {
    await seedInternal();
    await refreshFiles();
    if (!state.path) {
      setEditorText("");
      updateDirty(false);
    }
  } else {
    await refreshFiles();
  }

  if (state.settings.softKeyboard) toggleSoftKeyboard(true);
  bindEvents();
  updateStatus();
  renderWindow();
  registerServiceWorker();
}

async function seedInternal() {
  try {
    const entries = await state.volumes.internal.list("");
    if (entries.length) return;
    const sample = `// pwa code — fast_io + WebAssembly edition
// Open the native server for the terminal (WebSocket PTY) and remote volume.

#include <fast_io.h>

namespace app {

struct point {
  int x{};
  int y{};

  constexpr point operator+(point other) const noexcept {
    return {x + other.x, y + other.y};
  }
};

} // namespace app

int main() {
  app::point a{1, 2};
  app::point b{3, 4};
  auto c{a + b};
  ::fast_io::io::println("sum = ", c.x, ", ", c.y);
}
`;
    await state.volumes.internal.write("welcome.cpp", new TextEncoder().encode(sample));
    await state.volumes.internal.write(
      "notes.md",
      new TextEncoder().encode(
        "# pwa code\n\n" +
          "- Dark theme is full black; light theme is full white.\n" +
          "- Internal, external and remote volumes.\n" +
          "- Notepad++ keyword tables and depth-coloured brackets.\n" +
          "- Hex editor and async PTY terminal.\n",
      ),
    );
  } catch (error) {
    console.warn("seed failed", error);
  }
}

/* ----------------------------------------------------------------- events */

function bindEvents() {
  const editor = $("editor");
  const rerender = () => updateHighlight();

  editor.addEventListener("input", () => {
    syncEditorToEngine();
    updateDirty(true);
    state.wrapDirty = true;
    rerender();
    if (state.settings.autoSave && state.path) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => saveDocument(false), 900);
    }
  });
  editor.addEventListener("scroll", rerender, { passive: true });
  editor.addEventListener("keyup", updateStatus);
  editor.addEventListener("click", updateStatus);
  editor.addEventListener("select", updateStatus);
  editor.addEventListener("selectionchange", updateStatus);

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        const value = editor.value;
        const start = editor.selectionStart;
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        if (value.startsWith("  ", lineStart)) {
          editor.setRangeText("", lineStart, lineStart + 2, "preserve");
        } else if (value[lineStart] === "\t") {
          editor.setRangeText("", lineStart, lineStart + 1, "preserve");
        }
        editor.dispatchEvent(new Event("input"));
      } else {
        insertAtCursor(state.settings.indent === 1 ? "\t" : "  ");
      }
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      insertNewline();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveDocument(false);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      $("fileInput").click();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind(false);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "h") {
      event.preventDefault();
      openFind(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
      event.preventDefault();
      goToLine();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      toggleWrap();
    } else if (event.key === "Escape" && !$("findBar").hidden) {
      closeFind();
    }
  });

  $("findText").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      findNext(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      closeFind();
    }
  });
  $("replaceText").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    } else if (event.key === "Escape") {
      closeFind();
    }
  });
  $("findNext").addEventListener("click", () => findNext(1));
  $("findPrev").addEventListener("click", () => findNext(-1));
  $("replaceOne").addEventListener("click", replaceOne);
  $("replaceAll").addEventListener("click", replaceAll);
  $("findClose").addEventListener("click", closeFind);

  $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("hidden"));

  // Sidebar drag strip.  The width is written straight to --sidebar-w while the
  // pointer moves and persisted once it is released; double-click forgets it.
  {
    const handle = $("sidebarHandle");
    const sidebar = $("sidebar");
    let drag = null;
    const refreshAfterResize = () => {
      updateHighlight();
      if (state.hexMode) renderHex();
      if (state.term && !$("termWrap").hidden) resizeTerminal();
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { x: event.clientX, width: sidebar.getBoundingClientRect().width };
      handle.classList.add("dragging");
      document.body.classList.add("sidebar-resizing");
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const width = clampSidebarWidth(drag.width + (event.clientX - drag.x));
      document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    });
    const finish = (event) => {
      if (!drag) return;
      drag = null;
      handle.classList.remove("dragging");
      document.body.classList.remove("sidebar-resizing");
      if (handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      state.settings.sidebarWidth = clampSidebarWidth(sidebar.getBoundingClientRect().width);
      saveSettings();
      refreshAfterResize();
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => {
      state.settings.sidebarWidth = 0;
      saveSettings();
      applySidebarWidth();
      refreshAfterResize();
    });
  }
  $("openBtn").addEventListener("click", () => $("fileInput").click());
  $("saveBtn").addEventListener("click", () => saveDocument(false));
  $("saveAsBtn").addEventListener("click", () => saveDocument(true));
  $("hexBtn").addEventListener("click", () => (state.hexMode ? closeHex() : openHex()));
  $("hexClose").addEventListener("click", closeHex);
  $("hexApply").addEventListener("click", hexApply);
  $("hexSave").addEventListener("click", saveHex);
  $("hexColumns").addEventListener("change", () => {
    $("hexView").scrollTop = 0;
    state.hexOffset = 0;
    renderHex();
  });
  $("hexOffset").addEventListener("change", () => {
    state.hexOffset = parseOffset($("hexOffset").value);
    const columns = Number($("hexColumns").value) || 16;
    const row = Math.floor(state.hexOffset / columns);
    $("hexView").scrollTop = row * 20;
    renderHex();
  });
  $("hexView").addEventListener("scroll", renderHex, { passive: true });
  $("hexView").addEventListener("click", (event) => {
    const target = event.target.closest(".hb[data-o]");
    if (target) hexSelect(Number(target.dataset.o));
  });

  $("termBtn").addEventListener("click", () => toggleTerminal());
  $("termClose").addEventListener("click", () => toggleTerminal(false));
  $("termConnect").addEventListener("click", connectTerminal);
  $("termClear").addEventListener("click", () => state.term && state.term.clearScreen());
  $("term").addEventListener("keydown", (event) => {
    if (event.key === "Tab") event.preventDefault();
    const bytes = keyToBytes(event);
    if (bytes) {
      event.preventDefault();
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(bytes);
    }
  });
  window.addEventListener("resize", () => {
    state.wrapDirty = true;
    updateHighlight();
    if (state.hexMode) renderHex();
    if (state.term && !$("termWrap").hidden) resizeTerminal();
  });
  if (window.ResizeObserver) {
    // A width change re-wraps every line, so the measured table is stale too.
    new ResizeObserver(() => {
      state.wrapDirty = true;
      updateHighlight();
    }).observe($("viewport"));
  }

  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files && $("fileInput").files[0];
    if (file) openFromFileInput(file);
    $("fileInput").value = "";
  });

  const wrap = $("editorWrap");
  wrap.addEventListener("dragover", (event) => {
    event.preventDefault();
    $("dropHint").hidden = false;
  });
  wrap.addEventListener("dragleave", () => {
    $("dropHint").hidden = true;
  });
  wrap.addEventListener("drop", (event) => {
    event.preventDefault();
    $("dropHint").hidden = true;
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openFromFileInput(file);
  });

  $("upBtn").addEventListener("click", async () => {
    state.volumes.path = parentPath(state.volumes.path);
    await refreshFiles();
  });
  $("refreshBtn").addEventListener("click", refreshFiles);

  // Path bar: Enter navigates (or opens the file it names), Esc and blur
  // discard the edit and put the canonical path back.  The typed text is
  // captured before blurring, because blur restores the display value.
  $("pathBar").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const typed = $("pathBar").value;
      $("pathBar").blur();
      goToTypedPath(typed);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPathDisplay();
      $("pathBar").blur();
    }
  });
  $("pathBar").addEventListener("blur", setPathDisplay);

  $("newFileBtn").addEventListener("click", newFile);
  $("newDirBtn").addEventListener("click", newFolder);
  $("pickExternalBtn").addEventListener("click", mountExternal);
  $("addRemoteBtn").addEventListener("click", openMountModal);
  $("mountClose").addEventListener("click", () => ($("mountModal").hidden = true));
  $("mountCancel").addEventListener("click", () => ($("mountModal").hidden = true));
  $("mountAdd").addEventListener("click", addMountFromForm);
  $("mountModal").addEventListener("click", (event) => {
    if (event.target === $("mountModal")) $("mountModal").hidden = true;
  });
  $("mountModal").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName !== "SELECT") {
      event.preventDefault();
      addMountFromForm();
    } else if (event.key === "Escape") {
      $("mountModal").hidden = true;
    }
  });

  $("keyboardBtn").addEventListener("click", () => toggleSoftKeyboard());
  $("skHide").addEventListener("click", () => toggleSoftKeyboard(false));
  for (const key of document.querySelectorAll("#softKeyboard [data-key]")) {
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const name = key.dataset.key;
      if (!$("termWrap").hidden) {
        sendTerminalKey(name, state.softMods);
      } else {
        const handled = editorKeyCommand(name, state.softMods);
        if (!handled) {
          // Native arrow/home/etc. handling for the focused textarea.
          const editor = $("editor");
          editor.focus();
          if (name === "ArrowLeft" || name === "ArrowRight" || name === "ArrowUp" || name === "ArrowDown") {
            const delta = name === "ArrowLeft" ? -1 : name === "ArrowRight" ? 1 : 0;
            if (delta) editor.setSelectionRange(editor.selectionStart + delta, editor.selectionStart + delta);
          }
        }
      }
      if (key.dataset.mod !== "ctrl" && key.dataset.mod !== "alt") {
        state.softMods.ctrl = state.softMods.alt = false;
        updateSoftMods();
      }
    });
  }
  for (const key of document.querySelectorAll("#softKeyboard [data-mod]")) {
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const mod = key.dataset.mod;
      state.softMods[mod] = !state.softMods[mod];
      updateSoftMods();
    });
  }

  $("settingsBtn").addEventListener("click", () => {
    populateSettingsForm();
    $("settingsModal").hidden = false;
  });
  $("settingsClose").addEventListener("click", () => ($("settingsModal").hidden = true));
  $("settingsModal").addEventListener("click", (event) => {
    if (event.target === $("settingsModal")) $("settingsModal").hidden = true;
  });
  $("settingsSave").addEventListener("click", async () => {
    await applySettingsForm();
    $("settingsModal").hidden = true;
  });
  $("settingsReset").addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    populateSettingsForm();
    applySettings();
    toast("settings reset");
  });

  $("themeBtn").addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    saveSettings();
    applySettings();
  });

  $("statusWrap").addEventListener("click", toggleWrap);

  $("statusEncoding").addEventListener("click", () => {
    if (!state.engineReady) return;
    const next = (state.engine.encoding + 1) % ENCODINGS.length;
    state.settings.encoding = next;
    saveSettings();
    state.engine.setEncoding(next, state.engine.bom);
    $("statusEncoding").textContent = ENCODINGS[next];
    updateDirty(true);
    toast(`save encoding: ${ENCODINGS[next]}`);
  });
  $("statusEol").addEventListener("click", () => {
    state.settings.eol = (state.settings.eol + 1) % 3;
    saveSettings();
    if (state.engineReady) state.engine.setEol(state.settings.eol);
    $("statusEol").textContent = EOL_LABELS[state.settings.eol];
    updateDirty(true);
    toast(`line endings: ${EOL_LABELS[state.settings.eol]}`);
  });

  // Close chords are captured before the browser sees them.  Inside an
  // installed PWA Ctrl+W would otherwise take the whole window down; here it
  // closes the frontmost thing instead, and the terminal keeps its ^W
  // word-delete because its own handler still receives the key.
  window.addEventListener(
    "keydown",
    (event) => {
      const closeChord =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (event.key === "w" || event.key === "W" || event.key === "F4");
      if (!closeChord) return;
      event.preventDefault();
      if (!$("settingsModal").hidden) {
        $("settingsModal").hidden = true;
        return;
      }
      if (!$("mountModal").hidden) {
        $("mountModal").hidden = true;
        return;
      }
      const term = $("term");
      if (!$("termWrap").hidden && term.contains(document.activeElement)) return;
      closeDocument();
    },
    true,
  );

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function updateSoftMods() {
  for (const key of document.querySelectorAll("#softKeyboard [data-mod]")) {
    key.classList.toggle("on", !!state.softMods[key.dataset.mod]);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("sw.js").catch((error) => {
      console.warn("service worker registration failed", error);
    });
  };
  // init() waits for the wasm load, so the page may already have reached
  // "complete" before this runs.  In that case a load listener never fires.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

init().catch((error) => fail("init", error));
