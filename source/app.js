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
  indent: -1,
  indentExplicit: false,
  autoSave: false,
  wrap: false,
  bracketColor: true,
  conflictDisplay: true,
  restoreSession: true,
  encoding: 0,
  eol: 0,
  remoteBase: "",
  termUrl: "",
  termLocalEcho: false,
  sidebarWidth: 0,
  termHeight: 0,
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
  wrapWidth: 0,
  wrapDirty: true,
  largeMode: false,
  largeFirst: 0,
  largeScaled: false,
  history: [],
  historyIndex: -1,
  historyTime: 0,
  applyingHistory: false,
  statusEditing: false,
  clipboard: null,
  fileMenuEntry: null,
  termQueue: [],
  termSession: "",
  termReplay: true,
  termRetry: 0,
  termRetryTimer: 0,
  softTarget: "editor",
  conflicts: [],
  conflictLines: new Map(),
  conflictTimer: 0,
  activeConflict: -1,
  conflictCount: 0,
  docIndent: 0,
};

// A textarea with tens of millions of lines takes minutes to lay out and
// stalls the whole tab.  Above these bounds the editor switches to the
// read-only partial view, which still scrolls through the whole file.
const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const LARGE_FILE_LINES = 200000;

// Chromium caps a scroll container at roughly 33.5M pixels.  When a document
// is taller than that, the virtual scrollbar maps its whole range instead of
// stopping after the first few million lines.
const MAX_SCROLL_PX = 30000000;

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
    if (raw) {
      const saved = JSON.parse(raw);
      state.settings = { ...DEFAULT_SETTINGS, ...saved };
      // Older builds always stored an explicit 0 (two spaces).  Unless the
      // user has touched the indent choice since, default that file to Auto.
      if (!saved.indentExplicit) state.settings.indent = -1;
    }
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
  refreshLargeSpacer();
  $("statusEncoding").textContent = ENCODINGS[
    state.engineReady ? state.engine.encoding : s.encoding
  ] || "UTF-8";
  $("statusEol").textContent = EOL_LABELS[s.eol] || "Preserve";
  applySidebarWidth();
  applyTerminalHeight();
  refreshConflicts();
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

// The terminal splitter changes only the editor/terminal panes.  0 means use
// the stylesheet's share of #main, which is what narrow screens want.
const TERM_MIN = 90;
const EDITOR_PANE_MIN = 120;

function clampTermHeight(height) {
  const main = $("main");
  const max = Math.max(TERM_MIN, (main ? main.clientHeight : 800) - EDITOR_PANE_MIN);
  return Math.round(Math.max(TERM_MIN, Math.min(max, Number(height) || 0)));
}

function applyTerminalHeight() {
  const main = $("main");
  if (!main) return;
  const height = Number(state.settings.termHeight) || 0;
  if (height > 0) {
    main.style.setProperty("--term-h", `${clampTermHeight(height)}px`);
  } else {
    main.style.removeProperty("--term-h");
  }
}

function updateDirty(dirty) {
  state.dirty = dirty;
  $("dirtyDot").hidden = !dirty;
}

function updateStatus() {
  const editor = $("editor");
  const large = state.largeMode;
  let line = 1;
  let col = 1;
  let selected = 0;
  if (large) {
    line = state.largeFirst + 1;
  } else {
    const text = editor.value;
    const cursor = editor.selectionStart;
    const before = text.slice(0, cursor);
    line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    col = cursor - lastNl;
    selected = editor.selectionEnd - editor.selectionStart;
  }
  $("statusLine").textContent = state.statusEditing
    ? $("statusLine").textContent
    : large
      ? `Ln ${line}`
      : `Ln ${line}, Col ${col}`;
  $("statusSel").textContent = selected ? `Sel ${selected}` : "";
  $("statusLang").textContent = state.engineReady ? (state.engine.language || "plain") : "plain";
  $("statusSize").textContent = formatBytes(
    state.engineReady ? state.engine.size : new TextEncoder().encode(editor.value).length,
  );
  if (state.engineReady) {
    $("statusEncoding").textContent = ENCODINGS[state.engine.encoding] || "UTF-8";
  }
  $("statusWasm").textContent = state.engineReady ? "wasm" : "engine…";
  $("docName").textContent = state.path ? `${state.path}${large ? " (view)" : ""}` : large ? "untitled (view)" : "untitled";
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
    div.style.height = `${(state.settings.wrap && !state.largeMode ? wrapRowsOf(n) : 1) * lineHeight}px`;
    div.style.lineHeight = `${lineHeight}px`;
    const conflict = state.conflictLines.get(n);
    if (conflict === "cf-ours") div.classList.add("cf-ours");
    else if (conflict === "cf-theirs") div.classList.add("cf-theirs");
    else if (conflict) div.classList.add("cf-marker");
    frag.appendChild(div);
  }
  const gutter = $("gutter");
  gutter.textContent = "";
  gutter.appendChild(frag);
  const digits = Math.max(2, String(state.engine.lineCount).length);
  const width = Math.max(38, digits * (state.settings.fontSize * 0.62) + 20);
  document.documentElement.style.setProperty("--gutter-w", `${width}px`);
}

/* -------------------------------------------------------- merge conflicts */

// Git conflict markers are fixed seven-character runs.  A marker may carry a
// label ("<<<<<<< HEAD"), but a longer run of '<' inside normal text is not a
// marker, so the character after the run must be a space/tab or end of line.
function isConflictMarker(line, ch) {
  return line.startsWith(ch.repeat(7)) &&
    (line.length === 7 || line[7] === " " || line[7] === "\t");
}

function scanConflicts(text) {
  const conflicts = [];
  let cur = null;
  let line = 0;
  let offset = 0;
  const len = text.length;
  while (offset <= len) {
    const nl = text.indexOf("\n", offset);
    const end = nl < 0 ? len : nl;
    const lineText = text.slice(offset, end);
    const nextLine = nl < 0 ? len : nl + 1;
    if (!cur && isConflictMarker(lineText, "<")) {
      cur = {
        startLine: line,
        startOffset: offset,
        oursStartOffset: nextLine,
        oursEndOffset: -1,
        baseLine: -1,
        baseStartOffset: -1,
        baseEndOffset: -1,
        sepLine: -1,
        theirsStartOffset: -1,
        theirsEndOffset: -1,
        endLine: -1,
        endOffset: -1,
        oursLabel: lineText.slice(7).trim(),
        baseLabel: "",
        theirsLabel: "",
      };
    } else if (cur && cur.baseLine < 0 && isConflictMarker(lineText, "|")) {
      cur.baseLine = line;
      cur.baseLabel = lineText.slice(7).trim();
      cur.oursEndOffset = offset;
      cur.baseStartOffset = nextLine;
    } else if (cur && cur.sepLine < 0 && isConflictMarker(lineText, "=")) {
      cur.sepLine = line;
      if (cur.baseLine < 0) {
        cur.oursEndOffset = offset;
      } else {
        cur.baseEndOffset = offset;
      }
      cur.theirsStartOffset = nextLine;
    } else if (cur && isConflictMarker(lineText, ">")) {
      cur.endLine = line;
      cur.theirsEndOffset = offset;
      cur.endOffset = nextLine;
      cur.theirsLabel = lineText.slice(7).trim();
      if (cur.sepLine >= 0 && cur.oursEndOffset >= 0) conflicts.push(cur);
      cur = null;
    }
    if (nl < 0) break;
    offset = nextLine;
    line++;
  }
  return conflicts;
}

function conflictPreview(text, start, end) {
  if (start < 0 || end < 0 || end <= start) return "";
  const block = text.slice(start, end);
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "(empty)";
}

function buildConflictLineMap(conflicts) {
  const map = new Map();
  for (const c of conflicts) {
    map.set(c.startLine, "cf-start");
    map.set(c.sepLine, "cf-sep");
    map.set(c.endLine, "cf-end");
    if (c.baseLine >= 0) map.set(c.baseLine, "cf-basemarker");
    const oursEnd = c.baseLine >= 0 ? c.baseLine : c.sepLine;
    for (let line = c.startLine + 1; line < oursEnd; line++) map.set(line, "cf-ours");
    if (c.baseLine >= 0) {
      for (let line = c.baseLine + 1; line < c.sepLine; line++) map.set(line, "cf-base");
    }
    for (let line = c.sepLine + 1; line < c.endLine; line++) map.set(line, "cf-theirs");
  }
  return map;
}

function refreshConflicts() {
  if (state.conflictTimer) {
    clearTimeout(state.conflictTimer);
    state.conflictTimer = 0;
  }
  if (state.largeMode || !state.engineReady || !state.settings.conflictDisplay) {
    state.conflicts = [];
    state.conflictLines = new Map();
    state.activeConflict = -1;
    state.conflictCount = 0;
    updateConflictUI(false);
    return;
  }
  const text = $("editor").value;
  state.conflicts = text.includes("<<<<<<<") ? scanConflicts(text) : [];
  state.conflictLines = buildConflictLineMap(state.conflicts);
  const reappeared = state.conflictCount === 0 && state.conflicts.length !== 0;
  state.conflictCount = state.conflicts.length;
  if (state.activeConflict >= state.conflicts.length) {
    state.activeConflict = state.conflicts.length - 1;
  }
  updateConflictUI(reappeared);
}

function scheduleConflictRefresh() {
  if (state.conflictTimer) clearTimeout(state.conflictTimer);
  state.conflictTimer = setTimeout(() => {
    state.conflictTimer = 0;
    refreshConflicts();
    updateHighlight();
  }, 90);
}

function applyConflictClasses(container) {
  if (!state.conflictLines.size) return;
  for (const el of container.querySelectorAll(".vl[data-l]")) {
    const cls = state.conflictLines.get(Number(el.dataset.l));
    if (cls) el.classList.add(cls);
  }
}

function updateConflictUI(reopen = false) {
  const button = $("statusConflicts");
  const count = state.conflicts.length;
  if (button) {
    button.hidden = count === 0;
    button.textContent = `Conflicts ${count}`;
    button.classList.toggle("on", count !== 0);
  }
  const panel = $("conflictPanel");
  if (!panel) return;
  if (!count) {
    panel.hidden = true;
    state.activeConflict = -1;
    return;
  }
  // Undoing a merge resolution brings the markers back; the conflict list
  // should come back with them instead of leaving the user to hunt for it.
  if (reopen) panel.hidden = false;
  if (!panel.hidden) renderConflictList();
}

function renderConflictList() {
  const list = $("conflictList");
  if (!list) return;
  const editor = $("editor");
  const text = editor.value;
  list.textContent = "";
  const title = $("conflictTitle");
  if (title) title.textContent = `${state.conflicts.length} merge conflict${state.conflicts.length === 1 ? "" : "s"}`;
  state.conflicts.forEach((c, index) => {
    const item = document.createElement("div");
    item.className = "conflict-item";
    item.dataset.index = String(index);
    if (index === state.activeConflict) item.classList.add("active");
    const head = document.createElement("div");
    head.className = "conflict-item-head";
    const name = document.createElement("strong");
    name.textContent = `Conflict ${index + 1}`;
    const lines = document.createElement("span");
    lines.className = "cf-lines";
    lines.textContent = `Ln ${c.startLine + 1}–${c.endLine + 1}`;
    head.append(name, lines);
    const ours = document.createElement("span");
    ours.className = "conflict-preview ours";
    ours.textContent = `ours: ${c.oursLabel || "current"} — ${conflictPreview(text, c.oursStartOffset, c.oursEndOffset)}`;
    const theirs = document.createElement("span");
    theirs.className = "conflict-preview theirs";
    theirs.textContent = `theirs: ${c.theirsLabel || "incoming"} — ${conflictPreview(text, c.theirsStartOffset, c.theirsEndOffset)}`;
    item.append(head, ours);
    if (c.baseLine >= 0) {
      const base = document.createElement("span");
      base.className = "conflict-preview base";
      base.textContent = `base: ${c.baseLabel || "ancestor"} — ${conflictPreview(text, c.baseStartOffset, c.baseEndOffset)}`;
      item.appendChild(base);
    }
    item.appendChild(theirs);
    const actions = document.createElement("div");
    actions.className = "conflict-item-actions";
    for (const [mode, label, cls] of [
      ["ours", "Accept ours", "ours"],
      ["theirs", "Accept theirs", "theirs"],
      ["both", "Accept both", ""],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mini-btn ${cls}`;
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        resolveConflict(index, mode);
      });
      actions.appendChild(button);
    }
    item.appendChild(actions);
    item.addEventListener("click", () => jumpToConflict(index));
    list.appendChild(item);
    if (index === state.activeConflict) {
      requestAnimationFrame(() => item.scrollIntoView({ block: "nearest" }));
    }
  });
}

function jumpToConflict(index) {
  const c = state.conflicts[index];
  if (!c) return;
  state.activeConflict = index;
  const editor = $("editor");
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(c.startOffset, c.endOffset);
  revealSelection();
  updateStatus();
  renderConflictList();
}

function stepConflict(delta) {
  if (!state.conflicts.length) return;
  let index = state.activeConflict;
  if (index < 0) index = delta > 0 ? -1 : 0;
  index = (index + delta + state.conflicts.length) % state.conflicts.length;
  $("conflictPanel").hidden = false;
  jumpToConflict(index);
}

function resolveConflict(index, mode) {
  const c = state.conflicts[index];
  if (!c) return;
  const editor = $("editor");
  const text = editor.value;
  const ours = text.slice(c.oursStartOffset, c.oursEndOffset);
  const theirs = text.slice(c.theirsStartOffset, c.theirsEndOffset);
  const replacement = mode === "ours" ? ours : mode === "theirs" ? theirs : ours + theirs;
  editor.focus({ preventScroll: true });
  editor.setRangeText(replacement, c.startOffset, c.endOffset, "end");
  editor.dispatchEvent(new Event("input"));
  refreshConflicts();
  updateHighlight();
  toast(`resolved conflict ${index + 1}: ${mode === "both" ? "both sides" : mode}`);
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

// The textarea's border-box width minus its scrollbar.  clientWidth is an
// integer, but wrapped text is laid out at the fractional width, so measuring
// the mirror with clientWidth can disagree with the textarea by sub-pixels
// and wrap a line at a different character.
function editorInnerWidth(editor) {
  const rect = editor.getBoundingClientRect();
  const chrome = editor.offsetWidth - editor.clientWidth;
  return Math.max(0, rect.width - chrome);
}

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
  // Mirror the textarea's real content width.  clientWidth is rounded and
  // excludes the scrollbar; a fractional width matters because a one-pixel
  // difference moves the wrap point and leaves the caret one word off.
  const inner = editorInnerWidth(editor);
  if (inner > 0) el.style.width = `${inner}px`;
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
  const inner = editorInnerWidth(editor);
  state.wrapWidth = inner;
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
  const key = `${inner.toFixed(2)}x${state.settings.fontSize}x${state.settings.lineHeight}`;
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

function enterLargeMode(info) {
  state.largeMode = true;
  resetHistory();
  const editor = $("editor");
  editor.value = "";
  state.prevText = "";
  editor.hidden = true;
  const scroll = $("largeScroll");
  scroll.hidden = false;
  scroll.scrollTop = 0;
  scroll.scrollLeft = 0;
  state.largeFirst = 0;
  updateLargeSpacer();
  document.body.classList.add("large-mode");
  state.wrapDirty = true;
  state.conflicts = [];
  state.conflictLines = new Map();
  state.activeConflict = -1;
  state.conflictCount = 0;
  updateConflictUI(false);
}

function exitLargeMode() {
  if (!state.largeMode) return;
  state.largeMode = false;
  $("largeScroll").hidden = true;
  $("largeSpacer").style.height = "0px";
  $("editor").hidden = false;
  document.body.classList.remove("large-mode");
}

function updateLargeSpacer() {
  if (!state.largeMode || !state.engineReady) return;
  const total = Math.max(1, state.engine.lineCount) * state.settings.lineHeight;
  state.largeScaled = total > MAX_SCROLL_PX;
  $("largeSpacer").style.height = `${Math.min(total, MAX_SCROLL_PX)}px`;
}

function refreshLargeSpacer() {
  updateLargeSpacer();
}

function renderLargeWindow() {
  const scroll = $("largeScroll");
  const { lineHeight } = fontSizeMetrics();
  const scrollTop = scroll.scrollTop;
  const visible = Math.ceil(scroll.clientHeight / lineHeight) + 2;
  const total = Math.max(1, state.engine.lineCount);
  let first;
  let offsetY;
  if (state.largeScaled) {
    // One scrollbar pixel stands for several lines; map the full range.
    const maxScroll = Math.max(1, scroll.scrollHeight - scroll.clientHeight);
    const span = Math.max(1, total - visible);
    first = Math.floor((scrollTop / maxScroll) * span);
    offsetY = 0;
  } else {
    const rowsTop = scrollTop / lineHeight;
    first = Math.floor(rowsTop);
    offsetY = scrollTop - first * lineHeight;
  }
  first = Math.max(0, Math.min(first, Math.max(0, total - 1)));
  state.largeFirst = first;
  const count = Math.max(1, Math.min(visible, total - first));
  let html;
  try {
    html = state.engine.view(first, count, false);
  } catch (error) {
    fail("render", error);
    return;
  }
  const hl = $("highlight");
  hl.style.width = `${scroll.clientWidth}px`;
  hl.innerHTML = html;
  applyConflictClasses(hl);
  hl.style.transform = `translate(0px, ${-offsetY}px)`;
  renderGutter(first, count);
  const gutterInner = $("gutter");
  const shift = document.createElement("div");
  while (gutterInner.firstChild) shift.appendChild(gutterInner.firstChild);
  shift.style.transform = `translateY(${-offsetY}px)`;
  gutterInner.appendChild(shift);
  updateStatus();
}

function renderWindow() {
  if (!state.engineReady) return;
  if (state.largeMode) {
    renderLargeWindow();
    return;
  }
  const editor = $("editor");
  const { lineHeight } = fontSizeMetrics();
  const wrap = !!state.settings.wrap;
  if (wrap && (state.wrapDirty || !state.wrapOffsets ||
      Math.abs(state.wrapWidth - editorInnerWidth(editor)) > 0.01)) {
    refreshWrapRows();
  }
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
  if (wrap && editor.clientWidth > 0) hl.style.width = `${editorInnerWidth(editor)}px`;
  hl.innerHTML = html;
  applyConflictClasses(hl);
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
  // The large-file view never puts the document into the textarea, so its
  // empty value must not overwrite the engine buffer.
  if (state.largeMode) return;
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
    recordHistory(prefix, removed, inserted);
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
  scheduleConflictRefresh();
}

function setEditorText(text) {
  const editor = $("editor");
  editor.value = text;
  state.prevText = text;
  state.docIndent = detectIndent(text);
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  state.wrapDirty = true;
  resetHistory();
  refreshConflicts();
  updateHighlight();
  updateStatus();
}

/* --------------------------------------------------------------- history */

// Undo entries are diffs, not full copies: a 7 MiB file would otherwise need
// megabytes per keystroke.  Indices are JS string (UTF-16) offsets, matching
// setRangeText and the prefix/suffix diff computed in syncEditorToEngine.
const HISTORY_LIMIT = 400;
const HISTORY_COALESCE_MS = 700;

function resetHistory() {
  state.history = [];
  state.historyIndex = -1;
  state.historyTime = 0;
  updateHistoryButtons();
}

function recordHistory(start, removed, inserted) {
  if (state.applyingHistory || (removed.length === 0 && inserted.length === 0)) return;
  const now = performance.now();
  const last = state.history[state.historyIndex];
  // Merge a burst of ordinary typing into one entry so Ctrl+Z undoes a word
  // or a short burst, not a single character at a time.
  if (
    last &&
    now - state.historyTime < HISTORY_COALESCE_MS &&
    removed.length === 0 &&
    inserted.length !== 0 &&
    last.removed.length === 0 &&
    start === last.start + last.inserted.length
  ) {
    last.inserted += inserted;
    state.historyTime = now;
    return;
  }
  // A fresh edit after undoing throws away the redo branch.
  state.history.length = state.historyIndex + 1;
  state.history.push({ start, removed, inserted });
  state.historyIndex = state.history.length - 1;
  state.historyTime = now;
  if (state.history.length > HISTORY_LIMIT) {
    state.history.shift();
    state.historyIndex--;
  }
  updateHistoryButtons();
}

function applyHistory(entry, removeText, addText) {
  const editor = $("editor");
  editor.focus({ preventScroll: true });
  editor.setRangeText(addText, entry.start, entry.start + removeText.length, "preserve");
  state.applyingHistory = true;
  editor.dispatchEvent(new Event("input"));
  state.applyingHistory = false;
  editor.setSelectionRange(entry.start, entry.start + addText.length);
  refreshConflicts();
  updateHighlight();
  updateStatus();
}

function undo() {
  if (state.largeMode || state.hexMode || state.historyIndex < 0) return;
  const entry = state.history[state.historyIndex];
  state.historyIndex--;
  state.historyTime = 0;
  applyHistory(entry, entry.inserted, entry.removed);
  updateHistoryButtons();
}

function redo() {
  if (state.largeMode || state.hexMode || state.historyIndex + 1 >= state.history.length) return;
  const entry = state.history[++state.historyIndex];
  state.historyTime = 0;
  applyHistory(entry, entry.removed, entry.inserted);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = $("undoBtn");
  const redoBtn = $("redoBtn");
  if (!undoBtn || !redoBtn) return;
  const ready = !state.largeMode && !state.hexMode;
  undoBtn.disabled = !ready || state.historyIndex < 0;
  redoBtn.disabled = !ready || state.historyIndex + 1 >= state.history.length;
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

function isLargeDocument(info) {
  return info.size > LARGE_FILE_BYTES || info.lineCount > LARGE_FILE_LINES;
}

async function openPath(path, quiet = false) {
  try {
    const volume = state.volumes.active();
    const bytes = await volume.read(path);
    const info = state.engine.load(bytes, path, -1);
    state.path = path;
    state.volume = state.volumes.ref();
    const large = isLargeDocument(info);
    if (large) {
      // Do not materialise the whole document as a JS string or hand it to
      // the textarea; keep the engine as the source and paint a window.
      enterLargeMode(info);
    } else {
      exitLargeMode();
      setEditorText(state.engine.text);
    }
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
    $("docName").textContent = large ? `${path} (view)` : path;
    if (!large && state.conflicts.length) {
      $("conflictPanel").hidden = false;
      renderConflictList();
    }
    toast(
      `${path} • ${info.encodingName}${info.sourceCrlf ? " • CRLF" : ""}` +
        (large ? " • large file: read-only partial view" : ""),
    );
    renderWindow();
    if (!large) $("editor").focus();
    scheduleSessionSave();
  } catch (error) {
    if (!quiet) fail("open", error);
  }
}

async function refreshFiles() {
  closeFileMenu();
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
      row.title = entry.name;
      const icon = document.createElement("span");
      icon.className = "ficon";
      icon.textContent = entry.dir ? "▸" : "·";
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = entry.name;
      name.title = entry.name;
      row.append(icon, name);
      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "fmenu";
      menuBtn.title = "More actions";
      menuBtn.setAttribute("aria-label", `Actions for ${entry.name}`);
      menuBtn.setAttribute("aria-haspopup", "menu");
      menuBtn.textContent = "⋮";
      menuBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openFileMenu(menuBtn, entry);
      });
      row.appendChild(menuBtn);
      row.addEventListener("click", () => openEntry(entry));
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
  scheduleSessionSave();
}

function currentEntryPath(entry) {
  return state.volumes.path ? `${state.volumes.path}/${entry.name}` : entry.name;
}

function openEntry(entry) {
  if (entry.dir) {
    state.volumes.path = currentEntryPath(entry);
    setPathDisplay();
    refreshFiles();
    return;
  }
  // A file replaces the editor, so the drawer gets out of the way on phones.
  // Selecting a directory keeps it open for the next level.
  if (window.innerWidth <= 720) $("sidebar").classList.add("hidden");
  openPath(currentEntryPath(entry));
}

/* ------------------------------------------------------- explorer menu */

function menuButton(menu, icon, label, action, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", label);
  const glyph = document.createElement("span");
  glyph.className = "menu-icon";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = icon;
  const text = document.createElement("span");
  text.textContent = label;
  button.append(glyph, text);
  button.disabled = !!disabled;
  if (!disabled) {
    button.addEventListener("click", () => {
      closeFileMenu();
      action();
    });
  }
  menu.appendChild(button);
  return button;
}

function menuSeparator(menu) {
  const sep = document.createElement("div");
  sep.className = "menu-sep";
  sep.setAttribute("role", "separator");
  menu.appendChild(sep);
}

function closeFileMenu() {
  const menu = $("fileMenu");
  if (!menu) return;
  if (state.fileMenuEntry?.anchor) {
    state.fileMenuEntry.anchor.setAttribute("aria-expanded", "false");
  }
  state.fileMenuEntry = null;
  menu.hidden = true;
  menu.textContent = "";
}

function openFileMenu(anchor, entry) {
  closeFileMenu();
  const menu = $("fileMenu");
  const volume = state.volumes.active();
  const writable = !volume.readOnly;
  state.fileMenuEntry = { anchor, entry };
  anchor.setAttribute("aria-expanded", "true");

  menuButton(menu, entry.dir ? "▸" : "·", "Open", () => openEntry(entry));
  menuButton(menu, "✎", "Rename", () => renameEntry(entry), !writable || !volume.canRename);
  menuSeparator(menu);
  menuButton(menu, "⧉", "Copy", () => setClipboard(entry, "copy"));
  menuButton(menu, "✂", "Cut", () => setClipboard(entry, "cut"), !writable || !volume.canRemove);
  menuButton(
    menu,
    "▤",
    entry.dir ? "Paste into folder" : "Paste here",
    () => pasteEntry(entry),
    !state.clipboard || (entry.dir ? !writable || !volume.canMkdir : !writable),
  );
  menuButton(menu, "🗑", "Delete", () => removeEntry(entry),
    !writable || !volume.canRemove);
  menuSeparator(menu);
  menuButton(menu, "ⓘ", "Properties", () => showProperties(entry), !volume.canStat);

  menu.hidden = false;
  // Position the menu under the ⋮ button, flipping above and clamping to the
  // viewport when the row is near an edge (important in the phone drawer).
  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  let left = rect.right - box.width;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (left + box.width > window.innerWidth - 8) {
    left = window.innerWidth - box.width - 8;
  }
  if (top + box.height > window.innerHeight - 8) top = rect.top - box.height - 4;
  if (top < 8) top = 8;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function setClipboard(entry, mode) {
  state.clipboard = {
    volume: state.volumes.ref(),
    path: currentEntryPath(entry),
    name: entry.name,
    dir: entry.dir,
    mode,
  };
  toast(`${mode === "cut" ? "cut" : "copied"} ${entry.name}`);
}

function copyName(name, taken) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = `${stem}-copy${ext}`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${stem}-copy-${n++}${ext}`;
  return candidate;
}

async function pasteEntry(entry) {
  const clip = state.clipboard;
  if (!clip) return;
  try {
    const destVolume = state.volumes.active();
    const destRef = state.volumes.ref();
    const destDir = entry.dir ? currentEntryPath(entry) : state.volumes.path;
    if (clip.volume === destRef &&
        (destDir === clip.path || destDir.startsWith(`${clip.path}/`))) {
      throw new Error("A folder cannot be pasted into itself.");
    }
    const srcVolume = state.volumes.get(clip.volume);
    const existing = await destVolume.list(destDir);
    const taken = new Set(existing.map((e) => e.name));
    const name = taken.has(clip.name) ? copyName(clip.name, taken) : clip.name;
    const destPath = destDir ? `${destDir}/${name}` : name;
    await copyTreeBetweenVolume(srcVolume, clip.path, destVolume, destPath, clip.dir);
    if (clip.mode === "cut") {
      await srcVolume.remove(clip.path, clip.dir);
      if (state.volume === clip.volume &&
          (state.path === clip.path || state.path.startsWith(`${clip.path}/`))) {
        state.path = destPath + state.path.slice(clip.path.length);
        state.volume = destRef;
        $("docName").textContent = state.path;
      }
      state.clipboard = null;
    }
    await refreshFiles();
    toast(`pasted ${name}`);
  } catch (error) {
    fail("paste", error);
  }
}

async function copyTreeBetweenVolume(srcVolume, srcPath, destVolume, destPath, isDir) {
  if (!isDir) {
    await destVolume.write(destPath, await srcVolume.read(srcPath));
    return;
  }
  if (!destVolume.canMkdir) throw new Error("This volume cannot create folders.");
  await destVolume.mkdir(destPath);
  const entries = await srcVolume.list(srcPath);
  for (const item of entries) {
    await copyTreeBetweenVolume(
      srcVolume,
      `${srcPath}/${item.name}`,
      destVolume,
      `${destPath}/${item.name}`,
      item.dir,
    );
  }
}

async function renameEntry(entry) {
  const volume = state.volumes.active();
  const oldPath = currentEntryPath(entry);
  if (volume.readOnly || !volume.canRename) {
    toast("This volume cannot rename files.", true);
    return;
  }
  const name = prompt("Rename (name only, not a path)", entry.name);
  if (!name || name === entry.name) return;
  if (/[\/\\]/.test(name) || name === "." || name === "..") {
    toast("Names cannot contain / or \\ and cannot be . or ..", true);
    return;
  }
  try {
    const dir = state.volumes.path;
    const newPath = dir ? `${dir}/${name}` : name;
    const existing = (await volume.list(dir)).find((e) => e.name === name);
    if (existing) {
      if (!confirm(`Replace the existing ${name}?`)) return;
      await volume.remove(newPath, existing.dir);
    }
    await volume.rename(oldPath, newPath);
    if (state.path === oldPath) {
      state.path = newPath;
    } else if (state.path.startsWith(`${oldPath}/`)) {
      state.path = newPath + state.path.slice(oldPath.length);
    }
    if (state.path) $("docName").textContent = state.path;
    if (state.clipboard?.volume === state.volumes.ref()) {
      const clip = state.clipboard;
      if (clip.path === oldPath) {
        clip.path = newPath;
        clip.name = name;
      } else if (clip.path.startsWith(`${oldPath}/`)) {
        clip.path = newPath + clip.path.slice(oldPath.length);
      }
    }
    await refreshFiles();
    toast(`renamed ${entry.name} to ${name}`);
  } catch (error) {
    fail("rename", error);
  }
}

function propertyRow(list, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

async function showProperties(entry) {
  const volume = state.volumes.active();
  const path = currentEntryPath(entry);
  const list = $("propsBody");
  list.textContent = "";
  propertyRow(list, "Name", entry.name);
  propertyRow(list, "Path", path || "/");
  propertyRow(list, "Volume", `${volume.label} (${volume.kind})`);
  propertyRow(list, "Type", entry.dir ? "Folder" : "File");
  let info = null;
  try {
    info = await volume.stat(path);
  } catch {
    /* size and modified time are optional */
  }
  if (info) {
    propertyRow(list, "Size",
      entry.dir || info.size == null ? "—" : formatBytes(info.size));
    if (info.type && !entry.dir) propertyRow(list, "MIME", info.type);
    propertyRow(list, "Modified",
      info.mtime ? new Date(info.mtime).toLocaleString() : "—");
  }
  if (entry.dir) {
    try {
      const children = await volume.list(path);
      propertyRow(list, "Contents", `${children.length} item${children.length === 1 ? "" : "s"}`);
    } catch {
      /* unreadable folder */
    }
  }
  propertyRow(list, "Writable", volume.readOnly ? "no (read-only mount)" : "yes");
  $("propsModal").hidden = false;
}

async function removeEntry(entry) {
  const volume = state.volumes.active();
  const path = currentEntryPath(entry);
  if (volume.readOnly || !volume.canRemove) {
    toast("This volume cannot delete files.", true);
    return;
  }
  if (!confirm(`Remove ${path}?`)) return;
  try {
    await volume.remove(path, entry.dir);
    if (state.path === path || state.path.startsWith(`${path}/`)) {
      state.path = "";
      updateDirty(false);
      $("docName").textContent = "untitled";
    }
    if (state.clipboard) {
      const clip = state.clipboard;
      if (clip.path === path || clip.path.startsWith(`${path}/`)) state.clipboard = null;
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

async function saveDocument(saveAs = false, ask = false) {
  if (!state.engineReady) return;
  if (state.largeMode) {
    toast("Large files open in the read-only partial view; edit them with the native CLI.", true);
    return;
  }
  if (!state.path || saveAs) {
    const suggested = state.path || "untitled.txt";
    const name = prompt("Save as (path inside the current volume)", suggested);
    if (!name) return;
    state.path = name;
    state.volume = state.volumes.ref();
  } else if (ask) {
    // Saving overwrites the file on the current volume.  Only the explicit
    // Save button (and Ctrl+S) asks first; autosave must stay unattended.
    if (!confirm(`Save changes to ${state.path}?`)) return;
  }
  try {
    syncEditorToEngine();
    // A newly typed file has no open-time sample; learn its style on save so
    // the next Tab respects what the user just wrote.
    state.docIndent = detectIndent($("editor").value);
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
  exitLargeMode();
  state.path = "";
  state.volume = state.volumes.ref();
  setEditorText("");
  state.settings.eol = 0;
  $("statusEol").textContent = EOL_LABELS[0];
  $("docName").textContent = "untitled";
  updateDirty(false);
  scheduleSessionSave();
  toast(`closed ${name}`);
}

/* ------------------------------------------------------------ open files */

async function openFromFileInput(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = state.engine.load(bytes, file.name, -1);
    state.path = "";
    state.volume = state.volumes.ref();
    const large = isLargeDocument(info);
    if (large) {
      enterLargeMode(info);
    } else {
      exitLargeMode();
      setEditorText(state.engine.text);
    }
    state.settings.eol = 0;
    $("statusEol").textContent = EOL_LABELS[0];
    updateDirty(true);
    toast(
      `${file.name} • ${info.encodingName} • unsaved buffer` +
        (large ? " • large file: read-only partial view" : ""),
    );
    renderWindow();
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

// The PTY lives in the native server now, so the browser only needs to
// remember which shell it belongs to.  sessionStorage survives a reload and a
// background/foreground cycle in the same tab without making a second tab
// hijack the same shell.
function terminalSessionId() {
  if (state.termSession) return state.termSession;
  let id = "";
  try {
    id = sessionStorage.getItem("pwacode.term.session") || "";
  } catch {
    /* private mode */
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      crypto.getRandomValues(bytes);
      id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }
    try {
      sessionStorage.setItem("pwacode.term.session", id);
    } catch {
      /* private mode */
    }
  }
  state.termSession = id;
  return id;
}

function clearTerminalSession() {
  state.termSession = "";
  try {
    sessionStorage.removeItem("pwacode.term.session");
  } catch {
    /* private mode */
  }
}

function terminalUrl() {
  let base = "";
  if (state.settings.termUrl) {
    base = state.settings.termUrl;
  } else if (state.volumes.current === "remote") {
    // A remote mount of the pwa-code server family also carries the PTY
    // terminal, so "connect" targets the machine whose files are open.
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
        base = url.toString();
      } catch {
        /* fall through to same origin */
      }
    }
  }
  if (!base) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    base = `${proto}//${location.host}/ws/term`;
  }
  const url = new URL(base);
  url.searchParams.set("session", terminalSessionId());
  url.searchParams.set("replay", state.termReplay ? "1" : "0");
  return url.toString();
}

function terminalVisible() {
  return !$("termWrap").hidden;
}

function terminalSocketOpen() {
  return !!state.ws && state.ws.readyState === WebSocket.OPEN;
}

// A phone (or a browser tab) may be suspended while another app is in front.
// The PTY WebSocket is frequently closed by the network stack when that
// happens, so return visits have to re-open it instead of leaving the pane
// alive but silent.
function ensureTerminalConnection() {
  if (!terminalVisible()) return;
  if (terminalSocketOpen()) return;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) return;
  connectTerminal();
}

function scheduleTerminalRetry() {
  if (!terminalVisible() || document.hidden) return;
  if (state.termRetry >= 8) return;
  if (state.termRetryTimer) return;
  const delay = Math.min(500 * (2 ** state.termRetry), 4000);
  state.termRetry++;
  $("termStatus").textContent = "reconnecting…";
  state.termRetryTimer = setTimeout(() => {
    state.termRetryTimer = 0;
    ensureTerminalConnection();
  }, delay);
}

function connectTerminal() {
  if (!terminalVisible()) return;
  if (state.termRetryTimer) {
    clearTimeout(state.termRetryTimer);
    state.termRetryTimer = 0;
  }
  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    try { old.close(); } catch { /* already closed */ }
  }
  if (!state.term) {
    state.term = new Terminal($("term"), {
      onData: (data) => {
        if (terminalSocketOpen()) state.ws.send(data);
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
      if (state.ws !== ws) return;
      state.termRetry = 0;
      state.termReplay = false;
      $("termStatus").textContent = "connected";
      $("termInput").focus({ preventScroll: true });
      // Tell the PTY its size before replaying anything the user typed while
      // the socket was down.
      resizeTerminal();
      const pending = state.termQueue;
      state.termQueue = [];
      for (const chunk of pending) {
        try { ws.send(chunk); } catch { /* socket closed again */ }
      }
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      $("termStatus").textContent = "disconnected";
      scheduleTerminalRetry();
    };
    ws.onerror = () => {
      if (state.ws !== ws) return;
      $("termStatus").textContent = "error";
      if (state.termRetry === 0) {
        toast("Terminal WebSocket failed. Start the native server or set a URL in Settings.", true);
      }
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
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
  // A hidden pane has no layout; measuring it would send a bogus 20x5 size to
  // the PTY.  The next visible resize corrects it.
  if (!el.clientWidth || !el.clientHeight) return;
  const style = getComputedStyle(el);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const meas = document.createElement("span");
  meas.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  meas.textContent = "M".repeat(40);
  el.appendChild(meas);
  const charWidth = meas.getBoundingClientRect().width / 40 || 8;
  meas.remove();
  // The terminal's own line-height, not the editor's setting: they are not the
  // same, and guessing high would leave blank rows at the bottom.
  const lineHeight =
    parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.25;
  const cols = Math.max(20, Math.floor((el.clientWidth - padX) / charWidth));
  const rows = Math.max(5, Math.floor((el.clientHeight - padY) / lineHeight));
  state.term.resize(cols, rows);
  sendTerminalSize(cols, rows);
}

// Text frames are keystrokes, so window changes use a binary control frame:
// [1, colsHi, colsLo, rowsHi, rowsLo].  The native server turns that into
// TIOCSWINSZ (or ResizePseudoConsole) before any bytes reach the PTY.
function sendTerminalSize(cols, rows) {
  state.termCols = cols;
  state.termRows = rows;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(
    new Uint8Array([1, (cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff]),
  );
}

function toggleTerminal(show) {
  const wrap = $("termWrap");
  const visible = show ?? wrap.hidden;
  wrap.hidden = !visible;
  $("termHandle").hidden = !visible;
  if (visible && state.hexMode) {
    closeHex();
  }
  // The code and the terminal share #main when the terminal is open; the
  // divider between them resizes those panes, not the application.
  $("editorWrap").hidden = state.hexMode;
  // On a phone the explorer is a full-screen drawer stacked above #main, so a
  // terminal opened behind it would be invisible and untappable.  Selecting a
  // file already closes the drawer; opening the terminal must do the same.
  if (visible && window.innerWidth <= 720) $("sidebar").classList.add("hidden");
  if (!visible) {
    if (state.ws) {
      const ws = state.ws;
      state.ws = null;
      try {
        // [3] terminates the server-side shell.  Without it the session would
        // be kept for a later reattach, which is not what Close means.
        if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([3]));
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (state.termRetryTimer) {
      clearTimeout(state.termRetryTimer);
      state.termRetryTimer = 0;
    }
    state.termRetry = 0;
    state.termQueue = [];
    clearTerminalSession();
    state.termReplay = true;
    if (state.term) state.term.clear();
    $("termStatus").textContent = "disconnected";
    $("editorWrap").hidden = state.hexMode;
    if (state.hexMode) $("hexWrap").hidden = false;
    return;
  }
  applyTerminalHeight();
  ensureTerminalConnection();
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
  sendTerminalBytes(bytes);
}

function sendTerminalBytes(bytes) {
  if (terminalSocketOpen()) {
    state.ws.send(bytes);
    return;
  }
  // Queue keystrokes typed while the socket is reconnecting from a suspend;
  // onopen replays them after sending the PTY size.
  state.termQueue.push(bytes);
  if (state.termQueue.length > 64) state.termQueue.shift();
  ensureTerminalConnection();
  toast("Terminal reconnecting…", true);
}

/* ---------------------------------------------------- terminal clipboard */

function terminalSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  const term = $("term");
  if (!term.contains(sel.anchorNode) && !term.contains(sel.focusNode)) return "";
  return sel.toString();
}

function fallbackCopyText(text) {
  // execCommand is deprecated but is the only option when the async clipboard
  // API is unavailable (insecure origin, old mobile browser, denied permission).
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  field.remove();
  return ok;
}

async function copyTerminalSelection() {
  const text = terminalSelectionText();
  if (!text) {
    toast("Select terminal text first.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`copied ${text.length} character${text.length === 1 ? "" : "s"}`);
  } catch {
    if (fallbackCopyText(text)) toast(`copied ${text.length} characters`);
    else toast("Clipboard write was blocked by the browser.", true);
  }
}

async function pasteTerminalClipboard() {
  ensureTerminalConnection();
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // The browser only allows readText from a permissioned secure context.
    // Keep the terminal focused so the user can use the normal paste shortcut
    // or the OS context menu instead.
    $("termInput").focus({ preventScroll: true });
    toast("Clipboard read was blocked; use Ctrl+V or the context menu.", true);
    return;
  }
  if (!text) return;
  sendTerminalBytes(text.replace(/\r?\n/g, "\r"));
  $("termInput").focus({ preventScroll: true });
}

// Ctrl+Shift+C/V are the terminal conventions.  A plain Ctrl+C with a live
// selection copies instead of sending SIGINT, which is what users expect
// after dragging over output.  Without a selection Ctrl+C still interrupts.
function terminalClipboardShortcut(event) {
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key.toLowerCase();
  if (key === "c" && event.shiftKey) {
    event.preventDefault();
    copyTerminalSelection();
    return true;
  }
  if (key === "v" && event.shiftKey) {
    event.preventDefault();
    pasteTerminalClipboard();
    return true;
  }
  if (key === "c" && !event.altKey) {
    const text = terminalSelectionText();
    if (text) {
      event.preventDefault();
      copyTerminalSelection();
      return true;
    }
  }
  return false;
}

// Coming back from another app or from a locked phone often leaves the pane
// with stale dimensions and a dead PTY socket.  Re-measure after the browser
// has restored the viewport, and retry once more after mobile chrome settles.
let termResumeTimer = 0;
function resumeTerminal() {
  if (!terminalVisible()) {
    positionSoftKeyboard();
    return;
  }
  state.wrapDirty = true;
  applyTerminalHeight();
  updateHighlight();
  positionSoftKeyboard();
  requestAnimationFrame(() => {
    if (!terminalVisible()) return;
    resizeTerminal();
    ensureTerminalConnection();
  });
  clearTimeout(termResumeTimer);
  termResumeTimer = setTimeout(() => {
    if (!terminalVisible()) return;
    resizeTerminal();
    ensureTerminalConnection();
    positionSoftKeyboard();
  }, 300);
}

/* --------------------------------------------------------- soft keyboard */

function toggleWrap() {
  state.settings.wrap = !state.settings.wrap;
  saveSettings();
  applySettings();
  updateHighlight();
  toast(`line wrap: ${state.settings.wrap ? "on" : "off"}`);
}

// There are two keyboards on a touch device: the browser's own on-screen
// keyboard (typing, IME, autocorrect) and this extra row of keys that a phone
// keyboard does not have (Esc, Tab, Ctrl, Alt, arrows).  Toggling the row is
// also the natural place to raise the OS keyboard, because a mobile browser
// only shows it from inside a user gesture.
function toggleSoftKeyboard(show, summon = false) {
  const kb = $("softKeyboard");
  const visible = show ?? kb.hidden;
  kb.hidden = !visible;
  document.body.classList.toggle("softkb", visible);
  state.settings.softKeyboard = visible;
  saveSettings();
  if (visible) {
    positionSoftKeyboard();
    if (summon) summonOnScreenKeyboard();
  } else {
    dismissOnScreenKeyboard();
  }
}

function summonOnScreenKeyboard() {
  if (state.largeMode || state.hexMode) return; // no editable textarea on screen
  // Do not steal the caret from an editor the user is actively typing in just
  // because the terminal pane happens to be open.
  const active = document.activeElement;
  if (active === $("editor") || active === $("pathBar")) return;
  if (terminalVisible() && (state.softTarget === "terminal" ||
      active === $("termInput") || active === $("term"))) {
    $("termInput").focus({ preventScroll: true });
    return;
  }
  $("editor").focus({ preventScroll: true });
}

function dismissOnScreenKeyboard() {
  // blur() on an element that is not focused is a no-op, so this also covers
  // the case where the Hide button itself took focus.
  $("editor").blur();
  $("termInput").blur();
}

// Keep the extra key row directly above the OS keyboard instead of hiding
// behind it.  visualViewport shrinks when the keyboard opens, while the
// layout viewport (and a fixed `bottom: 0`) does not.
function positionSoftKeyboard() {
  const kb = $("softKeyboard");
  if (!kb || kb.hidden) return;
  const vv = window.visualViewport;
  const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty("--kb-cover", `${covered}px`);
  kb.style.bottom = covered ? `${covered}px` : "";
}

// Detect whether a file indents with tabs or with spaces.  The product only
// distinguishes those two modes; a 4-space file is treated as space-indented
// and the editor keeps using two-space steps.
function detectIndent(text) {
  let tabs = 0;
  let spaces = 0;
  let offset = 0;
  let lines = 0;
  const limit = Math.min(text.length, 256 * 1024);
  while (offset < limit && lines < 4000) {
    const nl = text.indexOf("\n", offset);
    const end = nl < 0 || nl > limit ? limit : nl;
    const line = text.slice(offset, end);
    if (line && line.trim()) {
      if (line[0] === "\t") {
        tabs++;
      } else {
        let n = 0;
        while (n < line.length && line[n] === " ") n++;
        if (n >= 2) spaces++;
      }
    }
    if (nl < 0 || nl >= limit) break;
    offset = nl + 1;
    lines++;
  }
  return tabs > spaces ? 1 : 0;
}

function effectiveIndent() {
  return state.settings.indent === -1 ? state.docIndent : state.settings.indent;
}

// The extra key row belongs to whichever surface currently has the caret.
// Merely having the terminal open must not steal Esc/Tab/arrows from an editor
// the user is typing in.
function softKeyboardTargetsTerminal() {
  if (!terminalVisible()) return false;
  const active = document.activeElement;
  if (active === $("editor") || active === $("pathBar")) return false;
  if (active === $("termInput") || active === $("term") || $("term").contains(active)) {
    return true;
  }
  return state.softTarget === "terminal";
}

function editorKeyCommand(key, mods) {
  const editor = $("editor");
  if (document.activeElement !== editor && mods.ctrl) editor.focus();
  switch (key) {
    case "Tab":
      insertAtCursor(effectiveIndent() === 1 ? "\t" : "  ");
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

// Move the textarea caret for the navigation keys.  The extra key row calls
// preventDefault() on pointerdown to keep focus/selection, so the browser's
// native caret movement never runs and the soft keyboard has to do it.
function moveEditorSelection(key) {
  const editor = $("editor");
  const text = editor.value;
  const pos = editor.selectionStart;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = text.indexOf("\n", pos);
  const curEnd = lineEnd < 0 ? text.length : lineEnd;
  const col = pos - lineStart;
  let next = pos;
  if (key === "ArrowLeft") {
    next = Math.max(0, pos - 1);
  } else if (key === "ArrowRight") {
    next = Math.min(text.length, pos + 1);
  } else if (key === "Home") {
    next = lineStart;
  } else if (key === "End") {
    next = curEnd;
  } else if (key === "ArrowUp" || key === "ArrowDown" ||
      key === "PageUp" || key === "PageDown") {
    const { lineHeight } = fontSizeMetrics();
    const pageLines = Math.max(1, Math.floor(editor.clientHeight / lineHeight));
    const delta = key === "ArrowUp" ? -1
      : key === "ArrowDown" ? 1
        : key === "PageUp" ? -pageLines
          : pageLines;
    const dir = delta < 0 ? -1 : 1;
    let targetLine = lineStart;
    for (let i = 0; i < Math.abs(delta); i++) {
      if (dir < 0) {
        if (targetLine === 0) break;
        targetLine = text.lastIndexOf("\n", targetLine - 2) + 1;
      } else {
        const nl = text.indexOf("\n", targetLine);
        if (nl < 0) {
          targetLine = text.length;
          break;
        }
        targetLine = nl + 1;
      }
    }
    const nextLineEnd = text.indexOf("\n", targetLine);
    const targetEnd = nextLineEnd < 0 ? text.length : nextLineEnd;
    next = Math.min(targetLine + col, targetEnd);
  } else {
    return false;
  }
  if (next === pos) return false;
  editor.setSelectionRange(next, next);
  revealSelection();
  updateStatus();
  return true;
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
  if (state.largeMode) {
    const text = prompt("Go to line", String(state.largeFirst + 1));
    if (!text) return;
    jumpToLine(parseInt(text, 10) || 1);
    return;
  }
  const text = prompt("Go to line", String($("editor").value.slice(0, $("editor").selectionStart).split("\n").length));
  if (!text) return;
  jumpToLine(parseInt(text, 10) || 1);
}

// Jump by line number without materialising the document as an array of
// lines: a 200k-line buffer should not allocate 200k JS strings just to find
// one offset.  Large mode gets a virtual-scrollbar jump instead.
function jumpToLine(wanted) {
  wanted = Math.max(1, Math.min(state.engineReady ? state.engine.lineCount : 1, wanted | 0));
  if (state.largeMode) {
    const scroll = $("largeScroll");
    const { lineHeight } = fontSizeMetrics();
    const visible = Math.ceil(scroll.clientHeight / lineHeight) + 2;
    if (state.largeScaled) {
      const maxScroll = Math.max(1, scroll.scrollHeight - scroll.clientHeight);
      const span = Math.max(1, state.engine.lineCount - visible);
      scroll.scrollTop = Math.floor(((wanted - 1) / span) * maxScroll);
    } else {
      scroll.scrollTop = (wanted - 1) * lineHeight;
    }
    updateHighlight();
    return;
  }
  const editor = $("editor");
  const text = editor.value;
  let offset = 0;
  for (let line = 1; line < wanted; line++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) break;
    offset = nl + 1;
  }
  editor.focus();
  editor.setSelectionRange(offset, offset);
  revealSelection();
  updateStatus();
}

/* Editable position readout: click "Ln N, Col M", type a line number and press
 * Enter.  It is contenteditable rather than an <input> so the status bar keeps
 * the exact same visible text it always had. */
function beginStatusEdit() {
  const el = $("statusLine");
  if (state.statusEditing || !state.engineReady) return;
  state.statusEditing = true;
  el.classList.add("editing");
  el.contentEditable = "plaintext-only";
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function endStatusEdit(commit) {
  const el = $("statusLine");
  if (!state.statusEditing) return;
  state.statusEditing = false;
  const typed = el.textContent;
  el.contentEditable = "false";
  el.classList.remove("editing");
  const match = commit ? typed.match(/(\d+)/) : null;
  updateStatus();
  if (match) jumpToLine(parseInt(match[1], 10));
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
  const autoIndent = $("setIndent").querySelector('option[value="-1"]');
  if (autoIndent) {
    autoIndent.textContent = `Auto (detected: ${state.docIndent === 1 ? "Tab" : "2 spaces"})`;
  }
  $("setAutoSave").checked = s.autoSave;
  $("setBracketColor").checked = s.bracketColor;
  $("setConflictDisplay").checked = s.conflictDisplay !== false;
  $("setRestoreSession").checked = s.restoreSession !== false;
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
  s.indent = Number($("setIndent").value);
  if (!Number.isFinite(s.indent)) s.indent = -1;
  s.indentExplicit = s.indent !== -1;
  s.autoSave = $("setAutoSave").checked;
  s.bracketColor = $("setBracketColor").checked;
  s.conflictDisplay = $("setConflictDisplay").checked;
  s.restoreSession = $("setRestoreSession").checked;
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

/* ------------------------------------------------------- session restore */

const SESSION_KEY = "pwacode.session.v1";
let sessionSaveTimer = 0;

function saveSessionNow() {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = 0;
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      volume: state.volumes.ref(),
      dir: state.volumes.path,
      file: state.path || "",
      fileVolume: state.path ? state.volume : "",
    }));
  } catch {
    /* private mode */
  }
}

function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 250);
}

function readSavedSession() {
  if (!state.settings.restoreSession) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function applySavedLocation(ref, dir) {
  const colon = String(ref || "").indexOf(":");
  const kind = colon < 0 ? String(ref || "internal") : String(ref).slice(0, colon);
  const id = colon < 0 ? "" : String(ref).slice(colon + 1);
  if (kind !== "internal" && kind !== "external" && kind !== "remote") return false;
  if (kind !== "internal" && !id) return false;
  setVolTab(kind);
  if (kind !== "internal") state.volumes.selected[kind] = id;
  try {
    state.volumes.get(kind === "internal" ? "internal" : `${kind}:${id}`);
  } catch {
    setVolTab("internal");
    state.volumes.path = "";
    return false;
  }
  state.volumes.path = String(dir || "");
  renderMountBar();
  return true;
}

// Restore the location of the last edit.  The file wins over the explorer tab:
// if the user left a file open and then browsed elsewhere, startup returns to
// the file's folder and opens it again.
function restoreSavedSession() {
  const saved = readSavedSession();
  if (!saved) {
    setVolTab("internal");
    return null;
  }
  if (saved.file && saved.fileVolume) {
    if (applySavedLocation(saved.fileVolume, parentPath(saved.file))) {
      return { file: saved.file };
    }
  }
  if (saved.volume) {
    applySavedLocation(saved.volume, saved.dir);
  } else {
    setVolTab("internal");
  }
  return null;
}

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
  const restored = restoreSavedSession();
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
    if (restored?.file) {
      await openPath(restored.file, true);
      if (window.innerWidth <= 720) $("sidebar").classList.add("hidden");
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
  $("largeScroll").addEventListener("scroll", () => updateHighlight(), { passive: true });
  editor.addEventListener("keyup", updateStatus);
  editor.addEventListener("click", updateStatus);
  editor.addEventListener("select", updateStatus);
  editor.addEventListener("selectionchange", updateStatus);

  editor.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) && !event.altKey &&
      (event.key === "z" || event.key === "Z")
    ) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) && !event.altKey &&
      (event.key === "y" || event.key === "Y")
    ) {
      event.preventDefault();
      redo();
      return;
    }
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
        insertAtCursor(effectiveIndent() === 1 ? "\t" : "  ");
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
      saveDocument(false, true);
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

  // Editor/terminal splitter.  It changes the height of the two panes inside
  // #main only; the rest of the app never moves.
  {
    const handle = $("termHandle");
    const main = $("main");
    const wrap = $("termWrap");
    let drag = null;
    const refreshAfterResize = () => {
      updateHighlight();
      if (state.term && !wrap.hidden) resizeTerminal();
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { y: event.clientY, height: wrap.getBoundingClientRect().height };
      handle.classList.add("dragging");
      document.body.classList.add("term-resizing");
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const height = clampTermHeight(drag.height + (drag.y - event.clientY));
      main.style.setProperty("--term-h", `${height}px`);
    });
    const finish = (event) => {
      if (!drag) return;
      drag = null;
      handle.classList.remove("dragging");
      document.body.classList.remove("term-resizing");
      if (handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      state.settings.termHeight = clampTermHeight(wrap.getBoundingClientRect().height);
      saveSettings();
      refreshAfterResize();
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => {
      state.settings.termHeight = 0;
      saveSettings();
      applyTerminalHeight();
      refreshAfterResize();
    });
  }

  // Click the position readout to type a line number.
  {
    const line = $("statusLine");
    line.addEventListener("click", () => beginStatusEdit());
    line.addEventListener("keydown", (event) => {
      if (!state.statusEditing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        endStatusEdit(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        endStatusEdit(false);
      }
    });
    line.addEventListener("blur", () => {
      if (state.statusEditing) endStatusEdit(false);
    });
  }
  $("statusConflicts").addEventListener("click", () => {
    const panel = $("conflictPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      if (state.activeConflict < 0 && state.conflicts.length) {
        jumpToConflict(0);
      } else {
        renderConflictList();
      }
    }
  });
  $("conflictPrev").addEventListener("click", () => stepConflict(-1));
  $("conflictNext").addEventListener("click", () => stepConflict(1));
  $("conflictClose").addEventListener("click", () => { $("conflictPanel").hidden = true; });
  document.addEventListener("keydown", (event) => {
    if (event.key === "F8" && state.conflicts.length) {
      event.preventDefault();
      stepConflict(event.shiftKey ? -1 : 1);
    }
  });
  $("openBtn").addEventListener("click", () => $("fileInput").click());
  $("propsClose").addEventListener("click", () => { $("propsModal").hidden = true; });
  $("propsOk").addEventListener("click", () => { $("propsModal").hidden = true; });
  $("propsModal").addEventListener("click", (event) => {
    if (event.target === $("propsModal")) $("propsModal").hidden = true;
  });
  // Dismiss the explorer menu on an outside tap, Escape, resize, or when the
  // list scrolls away from the row it belongs to.
  document.addEventListener("pointerdown", (event) => {
    if ($("fileMenu").hidden) return;
    if (event.target.closest("#fileMenu")) return;
    closeFileMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("fileMenu").hidden) {
      event.preventDefault();
      closeFileMenu();
    } else if (event.key === "Escape" && !$("conflictPanel").hidden) {
      event.preventDefault();
      $("conflictPanel").hidden = true;
    }
  });
  $("fileList").addEventListener("scroll", closeFileMenu, { passive: true });
  window.addEventListener("resize", closeFileMenu);
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("saveBtn").addEventListener("click", () => saveDocument(false, true));
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
  $("termCopy").addEventListener("click", copyTerminalSelection);
  $("termPaste").addEventListener("click", pasteTerminalClipboard);
  // A real pointerdown on a button would move focus and collapse the terminal
  // selection before the click handler can read it.  Suppress the default so
  // Copy still sees the text the user highlighted.
  for (const id of ["termCopy", "termPaste"]) {
    const button = $(id);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }
  $("term").addEventListener("keydown", (event) => {
    if (terminalClipboardShortcut(event)) return;
    if (event.key === "Tab") event.preventDefault();
    const bytes = keyToBytes(event);
    if (bytes) {
      event.preventDefault();
      sendTerminalBytes(bytes);
    }
  });

  // Tapping the terminal should bring the OS keyboard back after it has been
  // dismissed, and route physical keys to the PTY at the same time.  Mouse
  // drags and touch long-presses must still be able to select output, so the
  // proxy is focused on a completed tap/click rather than on pointerdown.
  const termInput = $("termInput");
  const termEl = $("term");
  const focusTerminalInput = () => {
    ensureTerminalConnection();
    // When the OS keyboard's own hide button dismissed it, the proxy often
    // keeps focus.  A no-op focus() would not raise the keyboard again, so
    // blur first; this still happens inside the tap's user gesture.
    if (document.activeElement === termInput) termInput.blur();
    termInput.focus({ preventScroll: true });
  };
  const terminalHasSelection = () => {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.toString() &&
      (termEl.contains(sel.anchorNode) || termEl.contains(sel.focusNode));
  };
  let termPointer = null;
  termEl.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    ensureTerminalConnection();
    termPointer = {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
      moved: false,
    };
    // Freeze repaints while a drag is selecting; the grid must not be
    // replaced mid-drag by a busy program such as top.  Touch long-press
    // selection starts after pointerdown, so hold for every pointer type.
    if (state.term) state.term.hold = true;
  });
  termEl.addEventListener("pointermove", (event) => {
    if (!termPointer) return;
    if (Math.abs(event.clientX - termPointer.x) > 3 ||
        Math.abs(event.clientY - termPointer.y) > 3) {
      termPointer.moved = true;
    }
  });
  const endTerminalPointer = (event) => {
    const pointer = termPointer;
    termPointer = null;
    if (state.term) {
      state.term.hold = false;
      if (state.term.dirty) state.term.schedule();
    }
    if (!pointer) return;
    // A drag is a selection gesture; leave focus (and the selection) alone.
    if (pointer.moved || terminalHasSelection()) return;
    // A plain tap/click is the request for the OS keyboard.
    if (event.type === "pointercancel") return;
    focusTerminalInput();
  };
  window.addEventListener("pointerup", endTerminalPointer);
  window.addEventListener("pointercancel", endTerminalPointer);
  // iOS is more reliable at raising the keyboard from a click than from a
  // pointerdown, so keep the click as a fallback, but never collapse a
  // selection the user just made.
  termEl.addEventListener("click", () => {
    ensureTerminalConnection();
    if (terminalHasSelection()) return;
    if (document.activeElement !== termInput) termInput.focus({ preventScroll: true });
  });
  // When the selection is dropped, flush any repaint that was held back.
  document.addEventListener("selectionchange", () => {
    if (state.term && state.term.dirty) state.term.schedule();
  });
  termInput.addEventListener("focus", () => {
    state.softTarget = "terminal";
    $("term").classList.add("kb-focus");
  });
  termInput.addEventListener("blur", () => $("term").classList.remove("kb-focus"));
  $("term").addEventListener("focus", () => { state.softTarget = "terminal"; });
  $("editor").addEventListener("focus", () => { state.softTarget = "editor"; });
  termInput.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (terminalClipboardShortcut(event)) return;
    // Printable keys are delivered through the input event, which is the only
    // path that works with soft keyboards and IMEs that report "Unidentified".
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      return;
    }
    const bytes = keyToBytes(event);
    if (bytes) {
      event.preventDefault();
      sendTerminalBytes(bytes);
    }
  });
  termInput.addEventListener("input", (event) => {
    if (event.isComposing) return;
    const text = termInput.value;
    if (!text) return;
    termInput.value = "";
    // A soft-keyboard Enter arrives as a newline rather than a keydown; the
    // PTY expects CR.
    sendTerminalBytes(text.replace(/\r?\n/g, "\r"));
  });
  termInput.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    sendTerminalBytes(text.replace(/\r?\n/g, "\r"));
  });
  window.addEventListener("resize", () => {
    state.wrapDirty = true;
    applyTerminalHeight();
    updateHighlight();
    if (state.hexMode) renderHex();
    if (state.term && !$("termWrap").hidden) resizeTerminal();
    positionSoftKeyboard();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      positionSoftKeyboard();
      if (state.term && !$("termWrap").hidden) resizeTerminal();
    });
    window.visualViewport.addEventListener("scroll", positionSoftKeyboard);
  }
  // Android/iOS close the PTY socket while the PWA is in the background and
  // can report the old viewport when it comes back.  Reconnect and re-measure
  // on every resume path the platform offers.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveSessionNow();
    else resumeTerminal();
  });
  window.addEventListener("pagehide", saveSessionNow);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resumeTerminal();
  });
  window.addEventListener("focus", resumeTerminal);
  window.addEventListener("online", resumeTerminal);
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

  $("keyboardBtn").addEventListener("click", () => toggleSoftKeyboard(undefined, true));
  $("skHide").addEventListener("click", () => toggleSoftKeyboard(false));
  for (const key of document.querySelectorAll("#softKeyboard [data-key]")) {
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const name = key.dataset.key;
      if (softKeyboardTargetsTerminal()) {
        sendTerminalKey(name, state.softMods);
      } else {
        const handled = editorKeyCommand(name, state.softMods);
        if (!handled) {
          // Native arrow/home/etc. handling for the focused textarea.
          editor.focus();
          moveEditorSelection(name);
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
