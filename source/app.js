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
const NO_MATCH = 0xFFFFFFFF;
let fileSearchTimer = 0;
let fileSearchEnginePromise = null;
let macroSeq = 0;

const DEFAULT_SETTINGS = {
  theme: "system",
  fontSize: 13,
  lineHeight: 20,
  termFontSize: 13,
  browserZoom: false,
  lineNumbers: true,
  softKeyboard: false,
  indent: -1,
  indentExplicit: false,
  autoSave: false,
  wrap: false,
  bracketColor: true,
  wordCompletion: true,
  wordCompletionMin: 1,
  // Notepad++-style run commands.  Each macro can be attached to a set of
  // file extensions; the first matching entry in this list is the one the
  // play button and Ctrl+Shift+B run.
  buildMacros: [
    {
      id: "macro-cpp",
      name: "C++",
      exts: "cpp cc cxx c++ h hpp hh hxx",
      command:
        'cd "$(CURRENT_DIRECTORY)" && c++ -std=c++20 -O2 -o "$(NAME_PART)" ' +
        '"$(FILE_NAME)" && ./"$(NAME_PART)"',
    },
  ],
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
  softMods: { ctrl: false, alt: false },
  autoSaveTimer: 0,
  engineReady: false,
  wrapRows: null,
  wrapLines: null,
  wrapKey: "",
  wrapOffsets: null,
  wrapWidth: 0,
  wrapDirty: true,
  wordSet: null,
  wordSetText: "",
  wordSetTimer: 0,
  completionOpen: false,
  completionItems: [],
  completionIndex: -1,
  completionStart: 0,
  completionPrefix: "",
  acceptingCompletion: false,
  suppressCompletion: false,
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
  terms: [],
  activeTerm: -1,
  termSeq: 0,
  termMaximized: false,
  tabs: [],
  tabIndex: -1,
  tabSeq: 0,
  tabToken: 0,
  switchingTab: false,
  backupReady: false,
  backupWriting: false,
  backupPending: false,
  backupLastJson: "",
  backupErrorShown: false,
  bracketMatchSource: -1,
  bracketMatchOffset: NO_MATCH,
  softTarget: "editor",
  conflicts: [],
  conflictLines: new Map(),
  conflictTimer: 0,
  activeConflict: -1,
  conflictCount: 0,
  fileMatches: [],
  fileMatchIndex: -1,
  fileSearchToken: 0,
  fileSearchRoot: "",
  fileSearchQuery: "",
  fileSearchRunning: false,
  fileSearchPromise: null,
  fileCollapsed: new Set(),
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

function makeMacroId() {
  macroSeq++;
  return `macro-${Date.now().toString(36)}-${macroSeq}`;
}

// Extensions are stored as one space-separated list.  Accept the forms users
// naturally type: "cpp, cxx", ".h", "*.hpp" and mixed case.
function normalizeMacroExts(value) {
  const out = [];
  const seen = new Set();
  for (const token of String(value || "").split(/[\s,;]+/)) {
    let ext = token.trim().toLowerCase();
    if (!ext) continue;
    if (ext.startsWith("*.")) ext = ext.slice(2);
    else if (ext.startsWith(".")) ext = ext.slice(1);
    if (!ext || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out.join(" ");
}

function normalizeBuildMacro(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim() || `Macro ${index + 1}`;
  return {
    id: String(raw.id || makeMacroId()),
    name,
    exts: normalizeMacroExts(raw.exts ?? raw.extensions ?? ""),
    command: String(raw.command || ""),
  };
}

function normalizeBuildMacroList(list) {
  if (!Array.isArray(list)) return defaultBuildMacros();
  return list.map((macro, index) => normalizeBuildMacro(macro, index)).filter(Boolean);
}

function defaultBuildMacros() {
  return DEFAULT_SETTINGS.buildMacros.map((macro, index) => normalizeBuildMacro(macro, index));
}

function readSettings() {
  let saved = null;
  try {
    const raw = localStorage.getItem("pwacode.settings.v1");
    if (raw) {
      saved = JSON.parse(raw);
      state.settings = { ...DEFAULT_SETTINGS, ...saved };
      // Settings can outlive a build with a smaller zoom range; keep the
      // loaded values inside what the current UI can render.
      state.settings.fontSize = Math.max(9, Math.min(72,
        Number(state.settings.fontSize) || DEFAULT_SETTINGS.fontSize));
      state.settings.lineHeight = Math.max(state.settings.fontSize + 2, Math.min(160,
        Number(state.settings.lineHeight) || DEFAULT_SETTINGS.lineHeight));
      state.settings.termFontSize = Math.max(8, Math.min(72,
        Number(state.settings.termFontSize) || DEFAULT_SETTINGS.termFontSize));
      // The theme choice grew a "system" option; an unknown stored value
      // falls back to following the OS.
      if (state.settings.theme !== "dark" && state.settings.theme !== "light") {
        state.settings.theme = "system";
      }
      // Older builds always stored an explicit 0 (two spaces).  Unless the
      // user has touched the indent choice since, default that file to Auto.
      if (!saved.indentExplicit) state.settings.indent = -1;
    }
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
    saved = null;
  }
  // Migrate the single-macro setting from the first build-macro release.
  if (saved && !Array.isArray(saved.buildMacros) &&
      typeof saved.buildCommand === "string" && saved.buildCommand.trim()) {
    state.settings.buildMacros = [{
      id: makeMacroId(),
      name: "Build",
      exts: "",
      command: saved.buildCommand,
    }];
  }
  state.settings.buildMacros = normalizeBuildMacroList(
    Array.isArray(state.settings.buildMacros) ? state.settings.buildMacros : defaultBuildMacros(),
  );
  delete state.settings.buildCommand;
}

const SYSTEM_THEME_QUERY = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: light)")
  : null;

// The stored theme may be "system": resolve it against the OS preference at
// the moment it is applied, so a phone switching to night mode repaints the
// editor without a reload.
function resolvedTheme() {
  const choice = state.settings.theme;
  if (choice === "dark" || choice === "light") return choice;
  return SYSTEM_THEME_QUERY && SYSTEM_THEME_QUERY.matches ? "light" : "dark";
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#000000");
}

if (SYSTEM_THEME_QUERY) {
  const onSystemThemeChange = () => {
    if (state.settings.theme === "system") applyTheme();
  };
  if (SYSTEM_THEME_QUERY.addEventListener) {
    SYSTEM_THEME_QUERY.addEventListener("change", onSystemThemeChange);
  } else if (SYSTEM_THEME_QUERY.addListener) {
    SYSTEM_THEME_QUERY.addListener(onSystemThemeChange);
  }
}

function applySettings() {
  const s = state.settings;
  applyBrowserZoom();
  applyTheme();
  document.body.classList.toggle("no-bracket-color", !s.bracketColor);
  document.body.classList.toggle("wrap-mode", !!s.wrap);
  document.documentElement.style.setProperty("--font-size", `${s.fontSize}px`);
  document.documentElement.style.setProperty("--line-height", `${s.lineHeight}px`);
  document.documentElement.style.setProperty(
    "--term-font-size",
    `${Number(s.termFontSize) || DEFAULT_SETTINGS.termFontSize}px`,
  );
  document.documentElement.style.setProperty("--gutter-w", s.lineNumbers ? "" : "0px");
  $("gutter").hidden = !s.lineNumbers;
  const kb = $("softKeyboard");
  if (kb) kb.hidden = !s.softKeyboard;
  document.body.classList.toggle("softkb", !!s.softKeyboard);
  if (kb && !kb.hidden) positionSoftKeyboard();
  if (s.wordCompletion === false) closeCompletion();
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
  if (activeTermInst()) resizeTerminal();
  refreshBuildMacroUi();
}

/* ------------------------------------------------------------------ zoom */

// Browser page zoom and the app's editor/terminal zoom are alternatives.
// When browser zoom is on, the viewport allows pinch/Ctrl zoom and every
// custom zoom path below steps aside so the browser behaves normally.
function applyBrowserZoom() {
  const on = !!state.settings.browserZoom;
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    meta.setAttribute(
      "content",
      on
        ? "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content",
    );
  }
  document.documentElement.classList.toggle("browser-zoom", on);
}

const EDITOR_FONT_MIN = 9;
const EDITOR_FONT_MAX = 72;
const EDITOR_LINE_MAX = 160;
const TERM_FONT_MIN = 8;
const TERM_FONT_MAX = 72;

function clampZoom(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

// One step is 1px at the default size and grows with the text, so reaching a
// phone-sized 60-70px font does not need dozens of wheel notches or pinches.
function zoomStep(size) {
  return Math.max(1, Math.round(size * 0.1));
}

// Ctrl/Cmd + wheel or +/- zoom whichever surface owns the caret.  The editor
// and the terminal keep separate font sizes: a big readable shell must not
// also enlarge the code buffer, and vice versa.
function zoomSurfaceFor(element) {
  if (element && $("termWrap").contains(element)) return "terminal";
  if (element && $("editorWrap").contains(element)) return "editor";
  return terminalVisible() && state.softTarget === "terminal" ? "terminal" : "editor";
}

function repaintTerminals() {
  const inst = activeTermInst();
  if (!inst) return;
  inst.term.dirty = true;
  requestAnimationFrame(() => {
    resizeTerminal(inst);
    inst.term.schedule();
  });
}

function zoomEditor(delta) {
  const s = state.settings;
  const step = zoomStep(s.fontSize);
  const size = clampZoom(
    s.fontSize + (delta < 0 ? -step : step),
    EDITOR_FONT_MIN,
    EDITOR_FONT_MAX,
  );
  if (size === s.fontSize) return;
  const editor = $("editor");
  const oldLineHeight = s.lineHeight;
  const topLine = oldLineHeight > 0 ? editor.scrollTop / oldLineHeight : 0;
  const spacing = s.lineHeight / Math.max(1, s.fontSize);
  s.fontSize = size;
  s.lineHeight = Math.max(size + 2, Math.min(EDITOR_LINE_MAX, Math.round(size * spacing)));
  saveSettings();
  applySettings();
  if (topLine > 0) editor.scrollTop = topLine * s.lineHeight;
  state.wrapDirty = true;
  updateHighlight();
  toast(`editor zoom ${size}px`);
}

function zoomTerminal(delta) {
  const s = state.settings;
  const current = Number(s.termFontSize) || DEFAULT_SETTINGS.termFontSize;
  const step = zoomStep(current);
  const size = clampZoom(
    current + (delta < 0 ? -step : step),
    TERM_FONT_MIN,
    TERM_FONT_MAX,
  );
  if (size === current) return;
  s.termFontSize = size;
  saveSettings();
  applySettings();
  repaintTerminals();
  toast(`terminal zoom ${size}px`);
}

function resetZoom(surface) {
  const s = state.settings;
  if (surface === "terminal") {
    s.termFontSize = DEFAULT_SETTINGS.termFontSize;
    saveSettings();
    applySettings();
    repaintTerminals();
    toast(`terminal zoom ${s.termFontSize}px`);
  } else {
    const editor = $("editor");
    const topLine = s.lineHeight > 0 ? editor.scrollTop / s.lineHeight : 0;
    s.fontSize = DEFAULT_SETTINGS.fontSize;
    s.lineHeight = DEFAULT_SETTINGS.lineHeight;
    saveSettings();
    applySettings();
    if (topLine > 0) editor.scrollTop = topLine * s.lineHeight;
    state.wrapDirty = true;
    updateHighlight();
    toast(`editor zoom ${s.fontSize}px`);
  }
}

function zoomSurface(surface, delta) {
  if (surface === "terminal") zoomTerminal(delta);
  else zoomEditor(delta);
}

function pinchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// The terminal's tap-to-focus handler must ignore the pointerups that trail a
// two-finger pinch, otherwise the OS keyboard opens after every zoom.
let pinchEndedAt = 0;
function pinchRecently() {
  return Date.now() - pinchEndedAt < 400;
}

// A two-finger pinch over the editor or terminal zooms that pane's font.  The
// browser's own page pinch is disabled by the viewport meta, touch-action and
// the cancelled Safari gesture events, so this is the only pinch behaviour.
function bindPinchZoom(element, surface) {
  let start = 0;
  const stop = () => {
    if (start) pinchEndedAt = Date.now();
    start = 0;
  };
  element.addEventListener("touchstart", (event) => {
    if (state.settings.browserZoom || event.touches.length !== 2) {
      stop();
      return;
    }
    start = pinchDistance(event.touches);
  }, { passive: true });
  element.addEventListener("touchmove", (event) => {
    if (state.settings.browserZoom) return;
    if (event.touches.length !== 2 || !start) return;
    event.preventDefault();
    const distance = pinchDistance(event.touches);
    if (distance > start * 1.18) {
      zoomSurface(surface, 1);
      start = distance;
    } else if (distance < start * 0.85) {
      zoomSurface(surface, -1);
      start = distance;
    }
  }, { passive: false });
  element.addEventListener("touchend", stop, { passive: true });
  element.addEventListener("touchcancel", stop, { passive: true });
}

// Returns true when the event was a zoom shortcut.  The caller stops
// propagation so the terminal never receives a stray "=" or "-" byte.
function handleZoomKey(event) {
  if (state.settings.browserZoom) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.key === "0") {
    resetZoom(zoomSurfaceFor(document.activeElement));
    return true;
  }
  if (event.key === "+" || event.key === "=") {
    zoomSurface(zoomSurfaceFor(document.activeElement), 1);
    return true;
  }
  if (event.key === "-" || event.key === "_") {
    zoomSurface(zoomSurfaceFor(document.activeElement), -1);
    return true;
  }
  return false;
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

/* ------------------------------------------------------------- doc tabs */

// Tabs are snapshots around a single wasm document.  Switching captures the
// active buffer, restores the target into the engine, and swaps the textarea,
// undo stack, selection and scroll position.  Large read-only files are
// re-read from their volume instead of keeping a multi-megabyte string around.
function activeTab() {
  return state.tabs[state.tabIndex] || null;
}

function createTabData(overrides = {}) {
  const tab = {
    id: ++state.tabSeq,
    path: "",
    volume: state.volumes.ref(),
    label: "",
    langPath: "",
    text: "",
    bytes: null,
    large: false,
    dirty: false,
    encoding: 0,
    bom: false,
    sourceCrlf: false,
    eol: 0,
    docIndent: 0,
    history: [],
    historyIndex: -1,
    historyTime: 0,
    cursorStart: 0,
    cursorEnd: 0,
    scrollTop: 0,
    scrollLeft: 0,
    largeFirst: 0,
  };
  return Object.assign(tab, overrides);
}

function tabLabel(tab) {
  if (!tab) return "untitled";
  if (tab.path) return baseName(tab.path);
  if (tab.label) return tab.label;
  return "untitled";
}

function updateDocPath() {
  const input = $("topPath");
  if (!input) return;
  const large = state.largeMode;
  const tab = activeTab();
  const fallback = tab && tab.label ? tab.label : "untitled";
  // The top box is the current document path, not a directory browser.  It
  // stays empty (showing "untitled") until a file is selected.
  input.value = state.path || "";
  input.placeholder = large ? `${fallback} (view)` : fallback;
  input.title = state.path
    ? `Current file: ${state.path}${large ? " (read-only view)" : ""} — Enter to open another file, Esc to cancel`
    : "No file open — type a path and press Enter";
  refreshBuildMacroUi();
}

function renderTabs() {
  const bar = $("tabBar");
  if (!bar) return;
  bar.textContent = "";
  state.tabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-tab" + (index === state.tabIndex ? " active" : "");
    button.dataset.index = String(index);
    button.title = tab.path || tab.label || "untitled";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === state.tabIndex ? "true" : "false");
    const name = document.createElement("span");
    name.className = "doc-tab-name";
    name.textContent = tabLabel(tab);
    const dirty = document.createElement("span");
    dirty.className = "doc-tab-dirty";
    dirty.textContent = "●";
    dirty.hidden = !tab.dirty;
    const close = document.createElement("span");
    close.className = "doc-tab-close";
    close.textContent = "×";
    close.title = "Close tab";
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", `Close ${tabLabel(tab)}`);
    button.append(name, dirty, close);
    bar.appendChild(button);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.id = "tabNewBtn";
  add.className = "doc-tab-new";
  add.textContent = "+";
  add.title = "New tab";
  add.setAttribute("aria-label", "New tab");
  bar.appendChild(add);
}

function updateTabDirty() {
  const tab = activeTab();
  if (tab) tab.dirty = state.dirty;
  const bar = $("tabBar");
  const dot = bar && bar.querySelector(
    `.doc-tab[data-index="${state.tabIndex}"] .doc-tab-dirty`,
  );
  if (dot) dot.hidden = !state.dirty;
}

function captureActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  const editor = $("editor");
  tab.path = state.path;
  tab.volume = state.volume;
  tab.dirty = state.dirty;
  if (state.engineReady) {
    tab.encoding = state.engine.encoding;
    tab.bom = state.engine.bom;
    tab.sourceCrlf = state.engine.sourceCrlf;
  }
  tab.eol = state.settings.eol;
  tab.docIndent = state.docIndent;
  tab.history = state.history;
  tab.historyIndex = state.historyIndex;
  tab.historyTime = state.historyTime;
  if (state.largeMode) {
    tab.large = true;
    tab.largeFirst = state.largeFirst;
    tab.text = "";
  } else {
    tab.large = false;
    tab.text = editor.value;
    tab.cursorStart = editor.selectionStart;
    tab.cursorEnd = editor.selectionEnd;
    tab.scrollTop = editor.scrollTop;
    tab.scrollLeft = editor.scrollLeft;
  }
}

// Install a document the caller has already loaded into the engine.
function adoptLoadedDocument(tab, info, options) {
  const path = options.path || "";
  const langPath = options.langPath || path;
  const large = isLargeDocument(info);
  tab.path = path;
  tab.volume = options.volume;
  tab.label = options.label || "";
  tab.langPath = langPath;
  tab.dirty = !!options.dirty;
  tab.encoding = info.encoding;
  tab.bom = info.bom;
  tab.sourceCrlf = info.sourceCrlf;
  tab.eol = 0;
  tab.large = large;
  tab.bytes = options.bytes || null;
  tab.docIndent = 0;
  tab.cursorStart = 0;
  tab.cursorEnd = 0;
  tab.scrollTop = 0;
  tab.scrollLeft = 0;
  tab.largeFirst = 0;
  state.path = path;
  state.volume = options.volume;
  state.dirty = !!options.dirty;
  state.settings.eol = 0;
  $("statusEol").textContent = EOL_LABELS[0];
  if (large) {
    enterLargeMode(info);
  } else {
    exitLargeMode();
    setEditorText(state.engine.text);
    tab.text = $("editor").value;
    tab.docIndent = state.docIndent;
  }
  tab.history = state.history;
  tab.historyIndex = state.historyIndex;
  tab.historyTime = state.historyTime;
  updateDirty(tab.dirty);
  updateDocPath();
  renderTabs();
  updateHistoryButtons();
  updateStatus();
  if (!$("findBar").hidden) refreshFindCount();
  return large;
}

async function applyTabData(tab) {
  const token = ++state.tabToken;
  resetWordCompletion();
  if (state.hexMode) closeHex();
  if (tab.large) {
    const bytes = tab.bytes || await state.volumes.get(tab.volume).read(tab.path);
    if (token !== state.tabToken) return;
    const info = state.engine.load(bytes, tab.langPath || tab.path, -1);
    enterLargeMode(info);
    state.path = tab.path;
    state.volume = tab.volume;
    state.dirty = false;
    tab.dirty = false;
    state.largeFirst = tab.largeFirst;
    updateDirty(false);
    updateLargeSpacer();
    $("largeScroll").scrollTop = tab.largeFirst * state.settings.lineHeight;
    renderLargeWindow();
  } else {
    state.engine.setText(tab.text);
    state.engine.setPath(tab.langPath || tab.path);
    state.engine.setEncoding(tab.encoding, tab.bom);
    state.engine.setSourceCrlf(tab.sourceCrlf);
    state.engine.setEol(tab.eol);
    exitLargeMode();
    const editor = $("editor");
    editor.value = tab.text;
    state.prevText = tab.text;
    state.path = tab.path;
    state.volume = tab.volume;
    state.dirty = tab.dirty;
    state.docIndent = tab.docIndent;
    state.settings.eol = tab.eol;
    $("statusEol").textContent = EOL_LABELS[tab.eol] || "Preserve";
    state.history = tab.history;
    state.historyIndex = tab.historyIndex;
    state.historyTime = tab.historyTime;
    state.wrapDirty = true;
    editor.scrollTop = tab.scrollTop;
    editor.scrollLeft = tab.scrollLeft;
    editor.setSelectionRange(tab.cursorStart, tab.cursorEnd);
    updateDirty(tab.dirty);
    refreshBracketMatch(false);
    refreshConflicts();
    updateHighlight();
    renderWindow();
    updateHistoryButtons();
  }
  updateDocPath();
  updateStatus();
  renderTabs();
  if (!$("findBar").hidden) refreshFindCount();
  scheduleSessionSave();
  scheduleBackupSave();
}

async function switchTab(index, focus = true) {
  if (index < 0 || index >= state.tabs.length || index === state.tabIndex) return;
  if (state.switchingTab) return;
  captureActiveTab();
  const previous = state.tabIndex;
  state.switchingTab = true;
  state.tabIndex = index;
  try {
    await applyTabData(state.tabs[index]);
  } catch (error) {
    // A missing large file must not leave the tab strip pointing at a buffer
    // the engine never loaded.
    state.tabIndex = previous;
    fail("tab", error);
    try {
      await applyTabData(state.tabs[previous]);
    } catch {
      /* keep the previous buffer if it cannot be restored either */
    }
  } finally {
    state.switchingTab = false;
  }
  if (focus && !state.largeMode) $("editor").focus();
}

async function newBlankTab() {
  const current = activeTab();
  if (current && !state.path && !state.dirty && !state.largeMode && !$("editor").value) {
    $("editor").focus();
    return;
  }
  captureActiveTab();
  const tab = createTabData();
  state.tabs.push(tab);
  state.tabIndex = state.tabs.length - 1;
  try {
    state.engine.setText("");
  } catch (error) {
    fail("new tab", error);
  }
  exitLargeMode();
  setEditorText("");
  state.path = "";
  state.volume = state.volumes.ref();
  state.settings.eol = 0;
  $("statusEol").textContent = EOL_LABELS[0];
  tab.text = "";
  tab.history = state.history;
  tab.historyIndex = state.historyIndex;
  tab.historyTime = state.historyTime;
  updateDirty(false);
  updateDocPath();
  renderTabs();
  $("editor").focus();
  scheduleSessionSave();
  scheduleBackupSave();
}

async function closeTab(index, force = false) {
  const tab = state.tabs[index];
  if (!tab) return;
  if (index === state.tabIndex) captureActiveTab();
  if (!force && tab.dirty &&
      !confirm(`Discard unsaved changes to ${tabLabel(tab)}?`)) {
    return;
  }
  const wasActive = index === state.tabIndex;
  state.tabs.splice(index, 1);
  if (state.tabs.length === 0) {
    const fresh = createTabData();
    state.tabs.push(fresh);
    state.tabIndex = 0;
    try {
      state.engine.setText("");
    } catch (error) {
      fail("close tab", error);
    }
    exitLargeMode();
    setEditorText("");
    state.path = "";
    state.volume = state.volumes.ref();
    state.settings.eol = 0;
    $("statusEol").textContent = EOL_LABELS[0];
    fresh.text = "";
    fresh.history = state.history;
    fresh.historyIndex = state.historyIndex;
    fresh.historyTime = state.historyTime;
    updateDirty(false);
    updateDocPath();
    renderTabs();
    updateStatus();
    scheduleSessionSave();
    scheduleBackupSave();
    return;
  }
  if (wasActive) {
    state.tabIndex = Math.min(index, state.tabs.length - 1);
    state.switchingTab = false;
    await applyTabData(state.tabs[state.tabIndex]);
  } else if (index < state.tabIndex) {
    state.tabIndex--;
  }
  renderTabs();
  scheduleSessionSave();
  scheduleBackupSave();
}

// A file or folder was deleted: drop every tab that pointed into it.
async function dropTabsForPath(path) {
  for (let i = state.tabs.length - 1; i >= 0; i--) {
    const tab = state.tabs[i];
    if (!tab.path) continue;
    if (tab.path === path || tab.path.startsWith(`${path}/`)) {
      await closeTab(i, true);
    }
  }
}

function updateDirty(dirty) {
  state.dirty = dirty;
  $("dirtyDot").hidden = !dirty;
  updateTabDirty();
  if (dirty) scheduleBackupSave();
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
      ? `${line}`
      : `${line}:${col}`;
  $("statusSel").textContent = selected ? `Sel ${selected}` : "";
  $("statusLang").textContent = state.engineReady ? (state.engine.language || "plain") : "plain";
  $("statusSize").textContent = formatBytes(
    state.engineReady ? state.engine.size : new TextEncoder().encode(editor.value).length,
  );
  if (state.engineReady) {
    $("statusEncoding").textContent = ENCODINGS[state.engine.encoding] || "UTF-8";
  }
  $("statusWasm").textContent = state.engineReady ? "wasm" : "engine…";
  updateDocPath();
  updateGutterCursor(line);
}

function updateGutterCursor(line) {
  if (!state.settings.lineNumbers) return;
  for (const el of $("gutter").querySelectorAll(".gl")) {
    el.classList.toggle("current", Number(el.dataset.line) === line - 1);
  }
}

// Highlight the bracket matching the one under the caret (or the single
// bracket selected).  The engine returns a UTF-8 byte offset because that is
// what the view renderer uses; the caret offset is UTF-16, so the conversion
// happens inside the wasm bridge.
function refreshBracketMatch(render = true) {
  if (!state.engineReady || state.largeMode || state.hexMode) {
    if (state.bracketMatchOffset !== NO_MATCH || state.bracketMatchSource !== -1) {
      state.bracketMatchOffset = NO_MATCH;
      state.bracketMatchSource = -1;
      if (render) updateHighlight();
    }
    return;
  }
  const editor = $("editor");
  const text = editor.value;
  let source = -1;
  if (editor.selectionStart !== editor.selectionEnd) {
    const selected = text.slice(editor.selectionStart, editor.selectionEnd);
    if (selected.length === 1 && "()[]{}".includes(selected)) {
      source = editor.selectionStart;
    }
  } else {
    const at = editor.selectionStart;
    if ("()[]{}".includes(text[at] || "")) source = at;
    else if ("()[]{}".includes(text[at - 1] || "")) source = at - 1;
  }
  let match = NO_MATCH;
  if (source >= 0) {
    try {
      match = state.engine.bracketMatchUtf16(source);
    } catch {
      match = NO_MATCH;
    }
    if (match === NO_MATCH || match >= state.engine.size) match = NO_MATCH;
  }
  if (match === state.bracketMatchOffset && source === state.bracketMatchSource) return;
  state.bracketMatchOffset = match;
  state.bracketMatchSource = source;
  if (render) updateHighlight();
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
  refreshBracketMatch(false);
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
    html = state.engine.view(first, count, false, state.bracketMatchOffset);
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
    html = state.engine.view(first, count, false, state.bracketMatchOffset);
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
  resetWordCompletion();
  const editor = $("editor");
  editor.value = text;
  state.prevText = text;
  state.docIndent = detectIndent(text);
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  state.wrapDirty = true;
  resetHistory();
  const tab = activeTab();
  if (tab) {
    tab.text = text;
    tab.docIndent = state.docIndent;
    tab.history = state.history;
    tab.historyIndex = state.historyIndex;
    tab.historyTime = state.historyTime;
  }
  refreshBracketMatch(false);
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
  if ($("pathBar")) $("pathBar").value = `/${state.volumes.path}`;
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

// The top box is the document path.  Entering a file path opens it in the
// current volume; entering a folder only moves the explorer there and leaves
// the document path untouched (the path changes only when a file is selected).
async function openTypedDocument(text) {
  const target = normalizeVolumePath(text);
  if (!target || target === state.path) {
    updateDocPath();
    return;
  }
  const ref = state.path ? state.volume : state.volumes.ref();
  let volume;
  try {
    volume = state.volumes.get(ref);
  } catch (error) {
    fail("open", error);
    updateDocPath();
    return;
  }
  try {
    const info = await volume.stat(target);
    if (info && info.dir) {
      state.volumes.path = target;
      await refreshFiles();
      toast(`${target}/ is a folder — opened in the explorer`);
      updateDocPath();
      return;
    }
  } catch {
    // Not a directory or file the volume can stat; let openPath report it.
  }
  await openPath(target, false, ref);
  updateDocPath();
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

async function openPath(path, quiet = false, volumeRef = null) {
  const ref = volumeRef || state.volumes.ref();
  try {
    const existing = state.tabs.findIndex((tab) => tab.path === path && tab.volume === ref);
    if (existing >= 0) {
      await switchTab(existing);
      return;
    }
    const current = activeTab();
    const reuse = !!current && !state.path && !state.dirty && !state.largeMode &&
      !$("editor").value;
    // Capture before the engine is replaced by the new file.
    captureActiveTab();
    const volume = state.volumes.get(ref);
    const bytes = await volume.read(path);
    const info = state.engine.load(bytes, path, -1);
    // Keep the buffer LF.  Preserve means a CRLF source is written back as
    // CRLF and an LF source stays LF; explicit LF/CRLF remains a user choice.
    state.engine.setEol(1);
    state.engine.setEol(0);
    let tab;
    if (reuse) {
      tab = current;
      tab.volume = ref;
    } else {
      tab = createTabData({ volume: ref });
      state.tabs.push(tab);
      state.tabIndex = state.tabs.length - 1;
    }
    state.hexMode = false;
    $("hexWrap").hidden = true;
    $("editorWrap").hidden = false;
    adoptLoadedDocument(tab, info, {
      path,
      langPath: path,
      volume: ref,
      dirty: false,
    });
    if (!tab.large && state.conflicts.length) {
      $("conflictPanel").hidden = false;
      renderConflictList();
    }
    if (!quiet) {
      toast(
        `${path} • ${info.encodingName}${info.sourceCrlf ? " • CRLF" : ""}` +
          (tab.large ? " • large file: read-only partial view" : ""),
      );
    }
    renderWindow();
    // A full-screen terminal would cover the file that was just chosen.
    if (window.innerWidth <= 720 && terminalVisible()) collapseTerminalPane();
    if (state.termMaximized) setTerminalMaximized(false);
    if (!tab.large) $("editor").focus();
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

  if (entry.dir) {
    menuButton(menu, "⌕", "Find in folder", () =>
      startFileSearch(currentEntryPath(entry), false));
    menuButton(menu, "⇄", "Replace in folder", () =>
      startFileSearch(currentEntryPath(entry), true));
    menuSeparator(menu);
  }
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

function closeBuildMenu() {
  const menu = $("buildMenu");
  if (!menu) return;
  menu.hidden = true;
  menu.textContent = "";
  $("buildPickBtn")?.setAttribute("aria-expanded", "false");
}

function openBuildMenu(anchor) {
  closeFileMenu();
  closeBuildMenu();
  const menu = $("buildMenu");
  const macros = state.settings.buildMacros || [];
  if (!macros.length) {
    menuButton(menu, "·", "No build macros configured", () => {}, true);
  } else {
    const matched = selectBuildMacro();
    for (const macro of macros) {
      const exts = buildMacroExtensions(macro);
      const suffix = exts.length ? exts.join(", ") : "any file";
      menuButton(
        menu,
        macro === matched ? "▶" : "·",
        `${macro.name} — ${suffix}`,
        () => {
          closeBuildMenu();
          runBuildMacro(macro);
        },
      );
    }
  }
  menuSeparator(menu);
  menuButton(menu, "⚙", "Manage build macros…", () => {
    closeBuildMenu();
    populateSettingsForm();
    $("settingsModal").hidden = false;
  });
  menu.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
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
        const tab = activeTab();
        if (tab) {
          tab.path = state.path;
          tab.volume = destRef;
          tab.langPath = state.path;
        }
        updateDocPath();
        renderTabs();
        scheduleBackupSave();
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
    for (const tab of state.tabs) {
      if (!tab.path) continue;
      if (tab.path === oldPath) tab.path = newPath;
      else if (tab.path.startsWith(`${oldPath}/`)) {
        tab.path = newPath + tab.path.slice(oldPath.length);
      }
      tab.langPath = tab.path;
    }
    updateDocPath();
    renderTabs();
    scheduleBackupSave();
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
    await dropTabsForPath(path);
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

async function saveDocument(saveAs = false, quiet = false) {
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
    const tab = activeTab();
    if (tab) {
      tab.path = state.path;
      tab.volume = state.volume;
      tab.langPath = state.path;
      tab.label = "";
      tab.text = $("editor").value;
      tab.docIndent = state.docIndent;
      tab.encoding = state.engine.encoding;
      tab.bom = state.engine.bom;
      tab.sourceCrlf = state.engine.sourceCrlf;
      tab.eol = state.settings.eol;
    }
    updateDirty(false);
    updateDocPath();
    renderTabs();
    scheduleBackupSave();
    if (!quiet) toast(`saved ${state.path} • ${formatBytes(bytes.length)}`);
    await refreshFiles();
  } catch (error) {
    fail("save", error);
  }
}

/* ------------------------------------------------------------- build macro */

// Notepad++-style run command placeholders.  Paths are relative to the
// pwa-code server workspace, which is also where the PTY shell starts.
function buildMacroParts(path) {
  const file = baseName(path);
  const dot = file.lastIndexOf(".");
  return {
    FULL_CURRENT_PATH: path,
    CURRENT_DIRECTORY: parentPath(path) || ".",
    FILE_NAME: file,
    NAME_PART: dot > 0 ? file.slice(0, dot) : file,
    EXT_PART: dot > 0 ? file.slice(dot + 1) : "",
  };
}

function expandBuildMacro(template, path) {
  const parts = buildMacroParts(path);
  return String(template).replace(/\$\((FULL_CURRENT_PATH|CURRENT_DIRECTORY|FILE_NAME|NAME_PART|EXT_PART)\)/g,
    (match, key) => (Object.prototype.hasOwnProperty.call(parts, key) ? parts[key] : match));
}

function buildMacroVolume() {
  try {
    const volume = state.volumes.get(state.volume);
    // A static HTTP mount has no PTY and no writable workspace, so a build
    // command could neither save the file nor run against it.
    if (volume && volume.kind === "http" && volume.mode !== "http") return volume;
  } catch {
    /* unmounted volume */
  }
  return null;
}

function activeFileInfo(pathOverride = "") {
  const tab = activeTab();
  const path = pathOverride || state.path || tab?.langPath || tab?.path || "";
  const file = baseName(path);
  const dot = file.lastIndexOf(".");
  return {
    path,
    file,
    ext: dot > 0 ? file.slice(dot + 1).toLowerCase() : "",
  };
}

function buildMacroExtensions(macro) {
  return String(macro?.exts || "").split(/\s+/).filter(Boolean);
}

function macroMatchesExtension(macro, ext) {
  const exts = buildMacroExtensions(macro);
  if (!exts.length) return true;
  return !!ext && exts.includes(ext);
}

// Extension-specific entries win over catch-all entries regardless of list
// order; among equals the order in Settings is the tie-breaker (use the
// up/down buttons to choose which macro a one-press build should run).
function selectBuildMacro(path = "") {
  const macros = state.settings.buildMacros || [];
  const ext = activeFileInfo(path).ext;
  const specific = macros.find((macro) =>
    buildMacroExtensions(macro).length && macroMatchesExtension(macro, ext));
  if (specific) return specific;
  return macros.find((macro) => buildMacroExtensions(macro).length === 0) || null;
}

function refreshBuildMacroUi() {
  const macros = state.settings.buildMacros || [];
  const picker = $("buildPickBtn");
  if (picker) picker.hidden = macros.length <= 1;
  const matched = selectBuildMacro();
  const button = $("buildBtn");
  if (button) {
    button.title = matched
      ? `Build / run with "${matched.name}" (Ctrl+Shift+B)`
      : "Build / run current file (Ctrl+Shift+B)";
  }
}

async function runBuildMacro(macro = null) {
  if (!state.engineReady) return;
  if (state.largeMode) {
    toast("Large files open in the read-only partial view; use the native CLI.", true);
    return;
  }
  if (!buildMacroVolume()) {
    toast("Build macro needs a remote mount served by pwa-code.", true);
    return;
  }
  if (!state.path) {
    await saveDocument(false, true);
    if (!state.path) return;
  }
  const chosen = macro || selectBuildMacro(state.path);
  if (!chosen) {
    const ext = activeFileInfo(state.path).ext;
    toast(ext
      ? `No build macro for .${ext}; add or attach one in Settings.`
      : "No build macro matches this file; add one in Settings.", true);
    return;
  }
  const template = String(chosen.command || "").trim();
  if (!template) {
    toast(`Build macro "${chosen.name}" has no command.`, true);
    return;
  }
  // Compile what is on screen, not the previous save.  A failed save leaves
  // the document dirty, so stop rather than build stale bytes.
  if (state.dirty) {
    await saveDocument(false, true);
    if (state.dirty) return;
  }
  const command = expandBuildMacro(template, state.path);
  toggleTerminal(true);
  ensureTerminalInstances();
  let inst = activeTermInst();
  if (!inst) {
    toast("Could not open the terminal.", true);
    return;
  }
  // If the visible terminal belongs to another server, give the build its own
  // shell instead of typing the command into the wrong machine.
  const target = terminalUrl(inst);
  if (inst.url && terminalTargetKey(inst.url) !== terminalTargetKey(target)) {
    inst = newTerminalInstance();
  }
  sendTerminalBytes(new TextEncoder().encode(`${command}\r`));
  toast(`build ${chosen.name}: ${baseName(state.path)}`);
}

/* ------------------------------------------------------------------ close */

// Ctrl+W closes the active tab instead of tearing down the installed app.
function closeDocument() {
  if (!state.engineReady) return;
  closeTab(state.tabIndex);
}

/* ------------------------------------------------------------ open files */

async function openFromFileInput(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const current = activeTab();
    const reuse = !!current && !state.path && !state.dirty && !state.largeMode &&
      !$("editor").value;
    captureActiveTab();
    const info = state.engine.load(bytes, file.name, -1);
    let tab;
    if (reuse) {
      tab = current;
    } else {
      tab = createTabData();
      state.tabs.push(tab);
      state.tabIndex = state.tabs.length - 1;
    }
    state.hexMode = false;
    $("hexWrap").hidden = true;
    $("editorWrap").hidden = false;
    adoptLoadedDocument(tab, info, {
      path: "",
      langPath: file.name,
      label: file.name,
      volume: state.volumes.ref(),
      dirty: true,
      bytes,
    });
    toast(
      `${file.name} • ${info.encodingName} • unsaved buffer` +
        (tab.large ? " • large file: read-only partial view" : ""),
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
  refreshBracketMatch(false);
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

// Several PTYs can be open at once.  Each instance owns its own renderer,
// WebSocket, reconnect state and session id; the native server keeps the
// shells alive independently.  Switching a terminal tab only changes which
// pane is visible and which socket is kept connected.
const TERM_SESSIONS_KEY = "pwacode.term.sessions.v1";
const TERM_LEGACY_KEY = "pwacode.term.session";

function makeTerminalSessionId() {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function activeTermInst() {
  return state.terms[state.activeTerm] || null;
}

function terminalVisible() {
  return !$("termWrap").hidden;
}

function termInstFromElement(el) {
  return state.terms.find((inst) => inst.el === el) || null;
}

function terminalSocketOpen(inst = activeTermInst()) {
  return !!inst && !!inst.ws && inst.ws.readyState === WebSocket.OPEN;
}

function saveTerminalSessions() {
  try {
    if (state.terms.length) {
      sessionStorage.setItem(TERM_SESSIONS_KEY, JSON.stringify({
        active: state.activeTerm,
        terms: state.terms.map((inst) => ({ id: inst.sessionId, name: inst.name })),
      }));
      // Keep the single-session key in sync for older builds and tests.
      sessionStorage.setItem(TERM_LEGACY_KEY, state.terms[0].sessionId);
    } else {
      sessionStorage.removeItem(TERM_SESSIONS_KEY);
      sessionStorage.removeItem(TERM_LEGACY_KEY);
    }
  } catch {
    /* private mode */
  }
}

function acquireTerminalElement() {
  const used = new Set(state.terms.map((inst) => inst.el));
  const first = $("term");
  if (first && !used.has(first)) return first;
  const el = document.createElement("div");
  el.className = "term";
  el.tabIndex = 0;
  el.setAttribute("aria-label", "Terminal");
  $("termStack").appendChild(el);
  return el;
}

function createTerminalInstance(options = {}) {
  const el = acquireTerminalElement();
  el.hidden = true;
  el.textContent = "";
  el.classList.remove("kb-focus");
  state.termSeq++;
  const inst = {
    sessionId: options.sessionId || makeTerminalSessionId(),
    name: options.name || `Terminal ${state.termSeq}`,
    el,
    term: null,
    ws: null,
    url: "",
    queue: [],
    replay: options.replay !== false,
    retry: 0,
    retryTimer: 0,
    status: "disconnected",
    cols: 0,
    rows: 0,
  };
  inst.term = new Terminal(el, {
    onData: (data) => {
      if (terminalSocketOpen(inst)) inst.ws.send(data);
    },
  });
  state.terms.push(inst);
  return inst;
}

function restoreTerminalInstances() {
  if (state.terms.length) return;
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(TERM_SESSIONS_KEY) || "null");
  } catch {
    saved = null;
  }
  let entries = saved && Array.isArray(saved.terms)
    ? saved.terms.filter((entry) =>
        entry && /^[A-Za-z0-9_-]{8,64}$/.test(entry.id || ""))
    : [];
  if (!entries.length) {
    let legacy = "";
    try {
      legacy = sessionStorage.getItem(TERM_LEGACY_KEY) || "";
    } catch {
      legacy = "";
    }
    if (/^[A-Za-z0-9_-]{8,64}$/.test(legacy)) {
      entries = [{ id: legacy, name: "Terminal 1" }];
    }
  }
  if (!entries.length) {
    entries = [{ id: makeTerminalSessionId(), name: "Terminal 1" }];
  }
  entries.forEach((entry, index) => {
    createTerminalInstance({
      sessionId: entry.id,
      name: entry.name || `Terminal ${index + 1}`,
      replay: true,
    });
  });
  const active = saved && Number.isInteger(saved.active) ? saved.active : 0;
  state.termSeq = Math.max(state.termSeq, entries.length);
  state.activeTerm = active >= 0 && active < state.terms.length ? active : 0;
  state.terms.forEach((inst, index) => {
    inst.el.hidden = index !== state.activeTerm;
  });
  renderTerminalTabs();
  saveTerminalSessions();
}

function renderTerminalTabs() {
  const tabs = $("termTabs");
  if (!tabs) return;
  tabs.textContent = "";
  state.terms.forEach((inst, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "term-tab" + (index === state.activeTerm ? " active" : "");
    button.dataset.index = String(index);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === state.activeTerm ? "true" : "false");
    const name = document.createElement("span");
    name.className = "term-tab-name";
    name.textContent = inst.name;
    const close = document.createElement("span");
    close.className = "term-tab-close";
    close.textContent = "×";
    close.title = "Close terminal";
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", `Close ${inst.name}`);
    button.append(name, close);
    tabs.appendChild(button);
  });
}

function updateTerminalStatus(inst = activeTermInst()) {
  $("termStatus").textContent = inst ? (inst.status || "disconnected") : "disconnected";
}

function terminalTargetKey(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("replay");
    return parsed.toString();
  } catch {
    return String(url);
  }
}

function terminalUrl(inst) {
  let base = "";
  if (state.settings.termUrl) {
    base = state.settings.termUrl;
  } else {
    // A remote mount of the pwa-code server family also carries the PTY
    // terminal, so "connect" targets the machine whose files are open.  The
    // active tab's volume, not the sidebar tab, decides this: a build macro
    // must not run on another mount just because the explorer moved.
    let volume = null;
    try {
      volume = state.volumes.get(state.volume);
    } catch {
      volume = null;
    }
    if (volume && volume.kind === "http" && volume.mode !== "http" && volume.base) {
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
  url.searchParams.set("session", inst.sessionId);
  url.searchParams.set("replay", inst.replay ? "1" : "0");
  return url.toString();
}

// A phone (or a browser tab) may be suspended while another app is in front.
// The PTY WebSocket is frequently closed by the network stack when that
// happens, so return visits have to re-open it instead of leaving the pane
// alive but silent.
function ensureTerminalConnection(inst = activeTermInst()) {
  if (!inst || !terminalVisible() || inst !== activeTermInst()) return;
  if (terminalSocketOpen(inst)) return;
  if (inst.ws && inst.ws.readyState === WebSocket.CONNECTING) return;
  connectTerminal(inst);
}

function scheduleTerminalRetry(inst) {
  if (!inst || inst !== activeTermInst()) return;
  if (!terminalVisible() || document.hidden) return;
  if (inst.retry >= 8) return;
  if (inst.retryTimer) return;
  const delay = Math.min(500 * (2 ** inst.retry), 4000);
  inst.retry++;
  inst.status = "reconnecting…";
  if (inst === activeTermInst()) updateTerminalStatus(inst);
  inst.retryTimer = setTimeout(() => {
    inst.retryTimer = 0;
    ensureTerminalConnection(inst);
  }, delay);
}

function connectTerminal(inst = activeTermInst()) {
  if (!inst || !terminalVisible() || inst !== activeTermInst()) return;
  if (inst.retryTimer) {
    clearTimeout(inst.retryTimer);
    inst.retryTimer = 0;
  }
  if (inst.ws) {
    const old = inst.ws;
    inst.ws = null;
    try { old.close(); } catch { /* already closed */ }
  }
  const url = terminalUrl(inst);
  inst.url = url;
  inst.status = "connecting…";
  updateTerminalStatus(inst);
  try {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    inst.ws = ws;
    ws.onopen = () => {
      if (inst.ws !== ws) return;
      inst.retry = 0;
      inst.replay = false;
      inst.status = "connected";
      if (inst === activeTermInst()) {
        updateTerminalStatus(inst);
        $("termInput").focus({ preventScroll: true });
      }
      // Tell the PTY its size before replaying anything the user typed while
      // the socket was down.
      resizeTerminal(inst);
      const pending = inst.queue;
      inst.queue = [];
      for (const chunk of pending) {
        try { ws.send(chunk); } catch { /* socket closed again */ }
      }
    };
    ws.onclose = () => {
      if (inst.ws !== ws) return;
      inst.ws = null;
      inst.status = "disconnected";
      if (inst === activeTermInst()) updateTerminalStatus(inst);
      scheduleTerminalRetry(inst);
    };
    // A socket failure is routine whenever the app is backgrounded or the
    // network blips, and the reconnect loop handles it.  Report it in the
    // terminal's status line only; a toast here fires on every app switch and
    // buries the pane until the reconnect succeeds.
    ws.onerror = () => {
      if (inst.ws !== ws) return;
      inst.status = "error";
      if (inst === activeTermInst()) updateTerminalStatus(inst);
    };
    ws.onmessage = (event) => {
      if (inst.ws !== ws) return;
      if (typeof event.data === "string") {
        inst.term.feed(event.data);
      } else {
        inst.term.feedBytes(new Uint8Array(event.data));
      }
    };
  } catch (error) {
    fail("terminal", error);
  }
}

function resizeTerminal(inst = activeTermInst()) {
  if (!inst) return;
  const el = inst.el;
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
  inst.term.resize(cols, rows);
  sendTerminalSize(inst, cols, rows);
}

// Text frames are keystrokes, so window changes use a binary control frame:
// [1, colsHi, colsLo, rowsHi, rowsLo].  The native server turns that into
// TIOCSWINSZ (or ResizePseudoConsole) before any bytes reach the PTY.
function sendTerminalSize(inst, cols, rows) {
  inst.cols = cols;
  inst.rows = rows;
  if (!terminalSocketOpen(inst)) return;
  inst.ws.send(
    new Uint8Array([1, (cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff]),
  );
}

function activateTerminal(index) {
  if (index < 0 || index >= state.terms.length) return;
  const inst = state.terms[index];
  const previous = activeTermInst();
  if (previous && previous !== inst) {
    previous.el.hidden = true;
    previous.el.classList.remove("kb-focus");
  }
  state.activeTerm = index;
  inst.el.hidden = false;
  if (document.activeElement === $("termInput")) inst.el.classList.add("kb-focus");
  renderTerminalTabs();
  updateTerminalStatus(inst);
  saveTerminalSessions();
  if (terminalVisible()) {
    ensureTerminalConnection(inst);
    requestAnimationFrame(() => resizeTerminal(inst));
    if (inst.term.dirty) inst.term.schedule();
  }
}

function newTerminalInstance() {
  if (!state.terms.length) restoreTerminalInstances();
  const inst = createTerminalInstance();
  activateTerminal(state.terms.length - 1);
  if (terminalVisible()) {
    ensureTerminalConnection(inst);
    requestAnimationFrame(() => resizeTerminal(inst));
  }
  return inst;
}

function closeTerminalInstance(inst = activeTermInst()) {
  if (!inst) {
    hideTerminalPane();
    return;
  }
  if (inst.retryTimer) {
    clearTimeout(inst.retryTimer);
    inst.retryTimer = 0;
  }
  if (inst.ws) {
    const ws = inst.ws;
    inst.ws = null;
    try {
      // [3] terminates the server-side shell.  Hiding the pane does not.
      if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([3]));
      ws.close();
    } catch {
      /* already closed */
    }
  }
  inst.term.clear();
  inst.el.hidden = true;
  inst.el.textContent = "";
  if (inst.el !== $("term")) inst.el.remove();
  const index = state.terms.indexOf(inst);
  if (index >= 0) state.terms.splice(index, 1);
  if (!state.terms.length) {
    state.activeTerm = -1;
    saveTerminalSessions();
    updateTerminalStatus();
    hideTerminalPane();
    return;
  }
  if (index < state.activeTerm) {
    state.activeTerm--;
  } else if (index === state.activeTerm) {
    state.activeTerm = Math.min(index, state.terms.length - 1);
  }
  state.terms.forEach((term, i) => {
    term.el.hidden = i !== state.activeTerm;
    if (i === state.activeTerm && document.activeElement === $("termInput")) {
      term.el.classList.add("kb-focus");
    }
  });
  renderTerminalTabs();
  updateTerminalStatus();
  saveTerminalSessions();
  if (terminalVisible()) {
    const active = activeTermInst();
    ensureTerminalConnection(active);
    requestAnimationFrame(() => resizeTerminal(active));
  }
}

function ensureTerminalInstances() {
  if (!state.terms.length) restoreTerminalInstances();
}

// Maximize is a view state, not a saved setting: it hides the app chrome and
// lets the terminal own the whole viewport (including the top bar and status
// bar).  The terminal toolbar stays visible so the same button restores it.
function setTerminalMaximized(on) {
  const wrap = $("termWrap");
  if (!wrap) return;
  const next = !!on && !wrap.hidden;
  state.termMaximized = next;
  document.body.classList.toggle("term-max", next);
  const button = $("termMax");
  if (button) {
    button.title = next ? "Restore terminal size" : "Maximize terminal";
    button.setAttribute("aria-label", next ? "Restore terminal size" : "Maximize terminal");
    button.setAttribute("aria-pressed", next ? "true" : "false");
  }
  if (!next) applyTerminalHeight();
  requestAnimationFrame(() => {
    if (!$("termWrap").hidden) resizeTerminal();
    positionSoftKeyboard();
    // The toolbar button took focus; hand it back so typing reaches the shell.
    if (terminalVisible()) {
      state.softTarget = "terminal";
      $("termInput").focus({ preventScroll: true });
    }
  });
}

// On phones the terminal is a full-screen overlay, so a file cannot be seen
// behind it.  Hide the pane when a file is opened but keep the sockets and the
// server-side shells alive; tapping Terminal brings the same sessions back.
function hideTerminalPane() {
  const wrap = $("termWrap");
  if (wrap.hidden) return;
  if (state.termMaximized) setTerminalMaximized(false);
  wrap.hidden = true;
  $("termHandle").hidden = true;
  document.body.classList.remove("term-open");
  $("termInput").blur();
  $("editorWrap").hidden = state.hexMode;
  if (state.hexMode) $("hexWrap").hidden = false;
  // Hiding the terminal returns the caret to the code, so typing goes back to
  // the document instead of a terminal that is no longer on screen.
  if (!state.hexMode && !state.largeMode) {
    requestAnimationFrame(() => {
      if (!$("termWrap").hidden) return;
      state.softTarget = "editor";
      $("editor").focus({ preventScroll: true });
    });
  }
}

function collapseTerminalPane() {
  hideTerminalPane();
}

function toggleTerminal(show) {
  const wrap = $("termWrap");
  const visible = show ?? wrap.hidden;
  if (!visible) {
    hideTerminalPane();
    return;
  }
  ensureTerminalInstances();
  wrap.hidden = false;
  $("termHandle").hidden = false;
  document.body.classList.add("term-open");
  if (state.hexMode) {
    closeHex();
  }
  // The code and the terminal share #main when the terminal is open; the
  // divider between them resizes those panes, not the application.
  $("editorWrap").hidden = state.hexMode;
  // On a phone the explorer is a full-screen drawer stacked above #main, so a
  // terminal opened behind it would be invisible and untappable.
  if (window.innerWidth <= 720) $("sidebar").classList.add("hidden");
  if (state.activeTerm < 0 || state.activeTerm >= state.terms.length) {
    state.activeTerm = 0;
  }
  state.terms.forEach((inst, index) => {
    inst.el.hidden = index !== state.activeTerm;
  });
  renderTerminalTabs();
  updateTerminalStatus();
  applyTerminalHeight();
  ensureTerminalConnection();
  requestAnimationFrame(() => {
    if ($("termWrap").hidden) return;
    resizeTerminal();
    // Opening the terminal should put the caret (and on mobile the OS
    // keyboard) in the shell, not leave it in the code behind the pane.
    state.softTarget = "terminal";
    $("termInput").focus({ preventScroll: true });
  });
}

function sendTerminalKey(key, mods) {
  const inst = activeTermInst();
  if (!inst) return;
  const bytes = keyToBytes({
    key,
    ctrlKey: mods.ctrl,
    altKey: mods.alt,
    metaKey: false,
  });
  if (!bytes) return;
  sendTerminalBytes(bytes);
}

// The extra key row's Ctrl/Alt are sticky flags in `state.softMods`; a soft
// keyboard's printable key arrives through `input` (or a keydown with no
// ctrlKey/altKey), so the modifier has to be folded in here rather than read
// from the event.  Apply it to the first character and fall back to plain text
// for the rest, then consume it like a real chord.
function sendTerminalTypedText(text) {
  const mods = state.softMods;
  if (!mods.ctrl && !mods.alt) {
    sendTerminalBytes(text.replace(/\r?\n/g, "\r"));
    return;
  }
  let out = "";
  let used = false;
  for (const char of text.replace(/\r?\n/g, "\r")) {
    if (!used) {
      out += keyToBytes({
        key: char,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        metaKey: false,
      });
      used = true;
    } else {
      out += char;
    }
  }
  if (out) sendTerminalBytes(out);
  clearSoftModifiers();
}

function clearSoftModifiers() {
  state.softMods.ctrl = false;
  state.softMods.alt = false;
  updateSoftMods();
}

// A sticky Ctrl+C follows the same rule as a physical one: a live terminal
// selection is copied, otherwise it reaches the shell as SIGINT.
function softCtrlCCopiesSelection() {
  if (!state.softMods.ctrl) return false;
  if (!terminalSelectionText()) return false;
  copyTerminalSelection();
  clearSoftModifiers();
  return true;
}

function sendTerminalBytes(bytes) {
  const inst = activeTermInst();
  if (!inst) return;
  if (terminalSocketOpen(inst)) {
    inst.ws.send(bytes);
    return;
  }
  // Queue keystrokes typed while the socket is reconnecting from a suspend;
  // onopen replays them after sending the PTY size.  The status line already
  // says "reconnecting…", so do not raise a toast for every key.
  inst.queue.push(bytes);
  if (inst.queue.length > 64) inst.queue.shift();
  ensureTerminalConnection(inst);
}

/* ---------------------------------------------------- terminal clipboard */

function terminalSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  const inst = activeTermInst();
  const term = inst ? inst.el : null;
  if (!term) return "";
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
  // The key row changes the space available to a full-screen terminal even
  // before the OS keyboard reports a new visualViewport.
  requestAnimationFrame(() => {
    if (terminalVisible()) resizeTerminal();
  });
}

function summonOnScreenKeyboard() {
  if (state.largeMode || state.hexMode) return; // no editable textarea on screen
  // Do not steal the caret from an editor the user is actively typing in just
  // because the terminal pane happens to be open.
  const active = document.activeElement;
  if (active === $("editor") || active === $("pathBar")) return;
  if (terminalVisible() && (state.softTarget === "terminal" ||
      active === $("termInput") || $("termStack").contains(active))) {
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
// layout viewport (and a fixed `bottom: 0`) does not.  The measured row height
// also drives #app's padding and the full-screen terminal's bottom edge, so
// the shell shrinks by exactly what the keys and keyboard cover.
function positionSoftKeyboard() {
  const kb = $("softKeyboard");
  if (!kb || kb.hidden) return;
  const vv = window.visualViewport;
  const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty("--kb-cover", `${covered}px`);
  kb.style.bottom = covered ? `${covered}px` : "";
  document.documentElement.style.setProperty(
    "--softkb-h",
    `${Math.ceil(kb.getBoundingClientRect().height)}px`,
  );
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

// The line span touched by a selection.  A selection ending exactly at a line
// start does not include that next line, so selecting a whole line plus its
// newline indents only that line.
function editorLineRange(text, start, end) {
  const first = text.lastIndexOf("\n", start - 1) + 1;
  let last;
  if (end > start && text[end - 1] === "\n") {
    last = text.lastIndexOf("\n", end - 2) + 1;
  } else {
    last = text.lastIndexOf("\n", end - 1) + 1;
  }
  const nl = text.indexOf("\n", last);
  const lastEnd = nl < 0 ? text.length : nl;
  return { first, last, lastEnd };
}

// Tab/Shift+Tab.  A caret inserts (or outdents the current line); a selection
// indents or outdents every line it touches and keeps the same logical text
// selected so repeated presses stack.
function changeEditorIndent(outdent) {
  const editor = $("editor");
  const text = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const unit = effectiveIndent() === 1 ? "\t" : "  ";
  if (start === end && !outdent) {
    insertAtCursor(unit);
    return;
  }
  const { first, last, lastEnd } = editorLineRange(text, start, end);
  const lines = text.slice(first, lastEnd).split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  let changed = false;
  const outLines = lines.map((line, index) => {
    let delta = 0;
    let next = line;
    if (outdent) {
      if (line.startsWith("\t")) {
        next = line.slice(1);
        delta = -1;
      } else {
        let spaces = 0;
        while (spaces < line.length && spaces < unit.length && line[spaces] === " ") spaces++;
        if (spaces > 0) {
          next = line.slice(spaces);
          delta = -spaces;
        }
      }
    } else {
      next = unit + line;
      delta = unit.length;
    }
    if (delta !== 0) changed = true;
    if (index === 0) firstDelta = delta;
    totalDelta += delta;
    return next;
  });
  if (!changed) return;
  let newStart;
  let newEnd;
  if (start === end) {
    newStart = newEnd = Math.max(first, start + firstDelta);
  } else {
    // Keep the indent outside the selection when it began at the line start.
    newStart = Math.max(first, start + (start > first ? firstDelta : 0));
    newEnd = Math.max(newStart, end + totalDelta);
  }
  editor.setRangeText(outLines.join("\n"), first, lastEnd, "preserve");
  editor.setSelectionRange(newStart, newEnd, editor.selectionDirection);
  editor.dispatchEvent(new Event("input"));
}

// The extra key row belongs to whichever surface currently has the caret.
// Merely having the terminal open must not steal Esc/Tab/arrows from an editor
// the user is typing in.
function softKeyboardTargetsTerminal() {
  if (!terminalVisible()) return false;
  const active = document.activeElement;
  if (active === $("editor") || active === $("pathBar") || active === $("topPath")) return false;
  if (active === $("termInput") || $("termStack").contains(active)) {
    return true;
  }
  return state.softTarget === "terminal";
}

function editorKeyCommand(key, mods) {
  const editor = $("editor");
  if (document.activeElement !== editor && mods.ctrl) editor.focus();
  switch (key) {
    case "Tab":
      changeEditorIndent(false);
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

// Target offset for a vertical caret move.  Lines are logical lines (split by
// "\n"), never the visual rows produced by soft wrap, so Down from a wrapped
// line goes to the next real line.
function editorVerticalTarget(key, pos) {
  const editor = $("editor");
  const text = editor.value;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const col = pos - lineStart;
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
  return Math.min(targetLine + col, targetEnd);
}

// Physical Up/Down in a wrapped textarea normally walks visual rows.  When
// wrap is on, keep the active selection end and move by logical lines instead.
function moveEditorLogical(key, extend) {
  const editor = $("editor");
  let anchor = editor.selectionStart;
  let active = editor.selectionEnd;
  if (editor.selectionDirection === "backward") {
    anchor = editor.selectionEnd;
    active = editor.selectionStart;
  }
  const target = editorVerticalTarget(key, active);
  if (target === active) return;
  if (extend) {
    editor.setSelectionRange(
      Math.min(anchor, target),
      Math.max(anchor, target),
      target < anchor ? "backward" : "forward",
    );
  } else {
    editor.setSelectionRange(target, target);
  }
  refreshBracketMatch();
  revealSelection();
  updateStatus();
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
    next = editorVerticalTarget(key, pos);
  } else {
    return false;
  }
  if (next === pos) return false;
  editor.setSelectionRange(next, next);
  refreshBracketMatch();
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
  // On a phone the terminal and the explorer are full-screen overlays;
  // searching the document behind them would show a find bar the user cannot
  // see.
  if (window.innerWidth <= 720) {
    if (terminalVisible()) hideTerminalPane();
    $("sidebar").classList.add("hidden");
  }
  const bar = $("findBar");
  bar.hidden = false;
  const editor = $("editor");
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selected && !selected.includes("\n")) $("findText").value = selected;
  $("findText").focus();
  $("findText").select();
  if (replace) $("replaceText").focus();
  refreshFindCount();
  if (fileSearchEnabled() && $("findText").value) scheduleFileSearch();
}

function startFileSearch(root = "", replace = false) {
  state.fileSearchRoot = root || "";
  $("findFiles").checked = true;
  openFind(replace);
  if (fileSearchTimer) {
    clearTimeout(fileSearchTimer);
    fileSearchTimer = 0;
  }
  refreshFindCount();
  if ($("findText").value) runFileSearch();
}

function closeFind() {
  $("findBar").hidden = true;
  $("findCount").textContent = "";
  state.fileSearchRoot = "";
  state.fileCollapsed.clear();
  closeFileFind();
  $("editor").focus();
}

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

/* ------------------------------------------------- Notepad++ word completion */

// Words come from the current file, exactly like Notepad++: every run of
// letters/digits/underscore at least two characters long, including numbers.
// The list is rebuilt off the typing path (debounced) so a large document does
// not rescan on every keystroke; switching files drops the stale list.
const COMPLETION_LIMIT = 12;
const WORD_SCAN = /[A-Za-z0-9_]+/g;

function resetWordCompletion() {
  if (state.wordSetTimer) {
    clearTimeout(state.wordSetTimer);
    state.wordSetTimer = 0;
  }
  state.wordSet = null;
  state.wordSetText = "";
  closeCompletion();
}

function closeCompletion() {
  state.completionOpen = false;
  state.completionItems = [];
  state.completionIndex = -1;
  state.completionStart = 0;
  state.completionPrefix = "";
  const popup = $("completion");
  if (popup) {
    popup.hidden = true;
    popup.textContent = "";
  }
}

function rebuildWordSet() {
  const editor = $("editor");
  const set = new Set();
  if (!state.largeMode && !state.hexMode) {
    const text = editor.value;
    WORD_SCAN.lastIndex = 0;
    let match;
    while ((match = WORD_SCAN.exec(text))) {
      if (match[0].length >= 2) set.add(match[0]);
    }
    state.wordSetText = text;
  } else {
    state.wordSetText = "";
  }
  state.wordSet = set;
}

function scheduleWordSetRefresh() {
  if (state.settings.wordCompletion === false) return;
  if (state.wordSetTimer) clearTimeout(state.wordSetTimer);
  state.wordSetTimer = setTimeout(() => {
    state.wordSetTimer = 0;
    rebuildWordSet();
  }, 250);
}

function wordCompletionPrefix() {
  const editor = $("editor");
  if (state.largeMode || state.hexMode) return null;
  if (editor.selectionStart !== editor.selectionEnd) return null;
  const text = editor.value;
  const caret = editor.selectionStart;
  // Completing in the middle of an existing word would duplicate its tail.
  if (caret < text.length && isWordChar(text[caret])) return null;
  let start = caret;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  const prefix = text.slice(start, caret);
  return prefix ? { start, prefix, caret } : null;
}

function refreshCompletion(force = false) {
  if (state.suppressCompletion || state.acceptingCompletion ||
      state.settings.wordCompletion === false || state.largeMode || state.hexMode ||
      !state.engineReady) {
    closeCompletion();
    return false;
  }
  const editor = $("editor");
  if (document.activeElement !== editor) {
    closeCompletion();
    return false;
  }
  const info = wordCompletionPrefix();
  if (!info) {
    closeCompletion();
    return false;
  }
  const minimum = force
    ? 1
    : Math.max(1, Math.min(8, Number(state.settings.wordCompletionMin) || 1));
  if (info.prefix.length < minimum) {
    closeCompletion();
    return false;
  }
  if (!state.wordSet) rebuildWordSet();
  const needle = info.prefix.toLowerCase();
  const candidates = [];
  for (const word of state.wordSet || []) {
    if (word.length <= info.prefix.length) continue;
    if (!word.toLowerCase().startsWith(needle)) continue;
    candidates.push(word);
  }
  if (!candidates.length) {
    closeCompletion();
    return false;
  }
  const exactCase = (word) => (word.startsWith(info.prefix) ? 0 : 1);
  candidates.sort((a, b) =>
    exactCase(a) - exactCase(b) ||
    a.length - b.length ||
    a.localeCompare(b));
  const previous = state.completionOpen
    ? state.completionItems[state.completionIndex]
    : "";
  state.completionItems = candidates.slice(0, COMPLETION_LIMIT);
  state.completionIndex = Math.max(0, state.completionItems.indexOf(previous));
  state.completionStart = info.start;
  state.completionPrefix = info.prefix;
  state.completionOpen = true;
  renderCompletion();
  return true;
}

function renderCompletion() {
  const popup = $("completion");
  if (!popup || !state.completionOpen) {
    closeCompletion();
    return;
  }
  popup.textContent = "";
  state.completionItems.forEach((word, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "completion-item" + (index === state.completionIndex ? " active" : "");
    item.tabIndex = -1;
    item.dataset.index = String(index);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === state.completionIndex));
    item.title = word;
    item.textContent = word;
    popup.appendChild(item);
  });
  popup.hidden = false;
  positionCompletion(popup);
  scrollCompletionIntoView(popup);
}

function completionMirror() {
  let mirror = $("completionMirror");
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.id = "completionMirror";
    mirror.className = "completion-mirror";
    mirror.setAttribute("aria-hidden", "true");
    $("viewport").appendChild(mirror);
  }
  return mirror;
}

// The textarea cannot report a caret rectangle, so mirror the text before the
// caret with the same font, padding, tab size and wrap width and measure a
// zero-width marker.  This also handles wrapped rows and horizontal scrolling.
function positionCompletion(popup) {
  const editor = $("editor");
  const viewport = $("viewport");
  const style = getComputedStyle(editor);
  const mirror = completionMirror();
  const wrap = !!state.settings.wrap && !state.largeMode;
  mirror.style.width = wrap ? `${editorInnerWidth(editor)}px` : "max-content";
  mirror.style.whiteSpace = wrap ? "pre-wrap" : "pre";
  mirror.style.overflowWrap = wrap ? "anywhere" : "normal";
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.tabSize = style.tabSize;
  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  const editorRect = editor.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || state.settings.lineHeight;
  const caretX = editorRect.left - viewportRect.left +
    (markerRect.left - mirrorRect.left) - editor.scrollLeft;
  const caretTop = editorRect.top - viewportRect.top +
    (markerRect.top - mirrorRect.top) - editor.scrollTop;
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const maxX = Math.max(4, viewport.clientWidth - width - 4);
  const maxY = Math.max(4, viewport.clientHeight - height - 4);
  let x = Math.max(4, Math.min(caretX, maxX));
  let y = caretTop + lineHeight;
  if (y > maxY && caretTop - height - 2 >= 4) y = caretTop - height - 2;
  y = Math.max(4, Math.min(y, maxY));
  popup.style.left = `${Math.round(x)}px`;
  popup.style.top = `${Math.round(y)}px`;
}

function scrollCompletionIntoView(popup) {
  const active = popup.querySelector(".completion-item.active");
  if (!active) return;
  if (active.offsetTop < popup.scrollTop) {
    popup.scrollTop = active.offsetTop;
  } else if (active.offsetTop + active.offsetHeight > popup.scrollTop + popup.clientHeight) {
    popup.scrollTop = active.offsetTop + active.offsetHeight - popup.clientHeight;
  }
}

function moveCompletion(delta) {
  if (!state.completionOpen || !state.completionItems.length) return false;
  const count = state.completionItems.length;
  state.completionIndex = (state.completionIndex + delta + count) % count;
  renderCompletion();
  return true;
}

function acceptCompletion() {
  if (!state.completionOpen) return false;
  const word = state.completionItems[state.completionIndex];
  if (!word) return false;
  const editor = $("editor");
  const caret = editor.selectionStart;
  const start = Math.min(state.completionStart, caret);
  closeCompletion();
  state.acceptingCompletion = true;
  editor.setRangeText(word, start, caret, "end");
  editor.dispatchEvent(new Event("input"));
  state.acceptingCompletion = false;
  return true;
}

// Literal search only.  The regex toggle will arrive later; keeping this
// routine free of RegExp also means characters like . * ( ) need no escaping.
function findMatches(text, needle) {
  const matches = [];
  if (!needle) return matches;
  const caseSensitive = $("findCase").checked;
  const wholeWord = $("findWord").checked;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(target, from);
    if (at < 0) break;
    const end = at + needle.length;
    if (!wholeWord || (!isWordChar(text[at - 1]) && !isWordChar(text[end]))) {
      matches.push(at);
    }
    from = at + Math.max(1, target.length);
  }
  return matches;
}

/* ------------------------------------------------------ find in files */

function fileSearchEnabled() {
  return !!$("findFiles")?.checked && !$("findBar").hidden;
}

function getFileSearchEngine() {
  if (!fileSearchEnginePromise) {
    fileSearchEnginePromise = (async () => {
      const engine = new Engine();
      await engine.init("pwacode.wasm");
      return engine;
    })().catch((error) => {
      fileSearchEnginePromise = null;
      throw error;
    });
  }
  return fileSearchEnginePromise;
}

// Text files can still contain a NUL byte; only treat a file as binary when
// NULs are common.  UTF-16/32 BOMs and alternating NUL patterns stay text.
function looksBinary(bytes) {
  if (!bytes || !bytes.length) return false;
  if (bytes.length >= 4) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE && bytes[2] === 0 && bytes[3] === 0) return false;
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xFE && bytes[3] === 0xFF) return false;
  }
  if (bytes.length >= 2) {
    if ((bytes[0] === 0xFF && bytes[1] === 0xFE) ||
        (bytes[0] === 0xFE && bytes[1] === 0xFF)) return false;
  }
  const n = Math.min(bytes.length, 4096);
  let nul = 0;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0) continue;
    nul++;
    if (i % 2 === 0) even++;
    else odd++;
  }
  if (!nul) return false;
  // UTF-16 without a BOM: one parity is mostly NUL while the other is text.
  const evenHigh = even > n / 4;
  const oddHigh = odd > n / 4;
  if (evenHigh && odd <= n / 20) return false;
  if (oddHigh && even <= n / 20) return false;
  return true;
}

async function collectFiles(volume, dir, out, limit) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await volume.list(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.dir && (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn")) {
      continue;
    }
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.dir) await collectFiles(volume, path, out, limit);
    else out.push(path);
  }
}

function findFileMatches(text, needle, caseSensitive, wholeWord, limit) {
  if (!needle || limit <= 0) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  const out = [];
  let from = 0;
  while (out.length < limit) {
    const at = haystack.indexOf(target, from);
    if (at < 0) break;
    if (wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[at + needle.length]))) {
      from = at + 1;
      continue;
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = starts[lo];
    const nl = text.indexOf("\n", at);
    const lineEnd = nl < 0 ? text.length : nl;
    let preview = text.slice(lineStart, lineEnd).replace(/\t/g, " ");
    if (preview.length > 160) preview = `${preview.slice(0, 160)}…`;
    out.push({
      start: at,
      line: lo + 1,
      column: at - lineStart + 1,
      preview: preview.trim() || " ",
    });
    from = at + Math.max(1, target.length);
  }
  return out;
}

function scheduleFileSearch() {
  if (!fileSearchEnabled()) return;
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  fileSearchTimer = setTimeout(() => {
    fileSearchTimer = 0;
    runFileSearch();
  }, 320);
}

function closeFileFind() {
  if (fileSearchTimer) {
    clearTimeout(fileSearchTimer);
    fileSearchTimer = 0;
  }
  state.fileSearchToken++;
  state.fileSearchQuery = "";
  state.fileMatches = [];
  state.fileMatchIndex = -1;
  const panel = $("fileFindPanel");
  if (panel) panel.hidden = true;
}

function runFileSearch() {
  const promise = doFileSearch();
  const safe = promise.catch((error) => {
    console.error("find in files", error);
  });
  state.fileSearchPromise = safe;
  state.fileSearchRunning = true;
  safe.finally(() => {
    if (state.fileSearchPromise === safe) {
      state.fileSearchPromise = null;
      state.fileSearchRunning = false;
    }
  });
  return safe;
}

async function doFileSearch() {
  const panel = $("fileFindPanel");
  const list = $("fileFindList");
  if (!panel || !list) return;
  const needle = $("findText").value;
  const token = ++state.fileSearchToken;
  state.fileSearchQuery = needle;
  state.fileMatches = [];
  state.fileMatchIndex = -1;
  if (!needle) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  list.textContent = "";
  const note = document.createElement("div");
  note.className = "file-find-empty";
  note.textContent = "Searching…";
  list.appendChild(note);
  let volume;
  const ref = state.volume || state.volumes.ref();
  try {
    volume = state.volumes.get(ref);
  } catch (error) {
    note.textContent = error.message;
    return;
  }
  // Search the whole mounted volume by default; a folder action scopes it to
  // that folder (state.fileSearchRoot) without changing the volume.
  const root = state.fileSearchRoot || "";
  state.fileSearchRoot = root;
  $("fileFindTitle").textContent = root
    ? `Find in folder — ${root}`
    : `Find in files — ${volume.label}`;
  state.fileCollapsed.clear();
  const files = [];
  await collectFiles(volume, root, files, 4000);
  // Stable, path-sorted results keep the tree from jumping between runs.
  files.sort();
  let engine = null;
  try {
    engine = await getFileSearchEngine();
  } catch {
    engine = null;
  }
  const caseSensitive = $("findCase").checked;
  const wholeWord = $("findWord").checked;
  const MAX_MATCHES = 500;
  const MAX_BYTES = 4 * 1024 * 1024;
  const matches = [];
  for (let i = 0; i < files.length && matches.length < MAX_MATCHES; i++) {
    if (token !== state.fileSearchToken) return;
    const path = files[i];
    let bytes;
    try {
      bytes = await volume.read(path);
    } catch {
      continue;
    }
    if (!bytes || !bytes.length || bytes.length > MAX_BYTES || looksBinary(bytes)) continue;
    let text;
    if (engine) {
      try {
        engine.load(bytes, path, -1);
        text = engine.text;
      } catch {
        continue;
      }
    } else {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    // The open file may have unsaved edits; search what the user sees.  An
    // inactive tab keeps its own buffer, which may also differ from disk.
    if (path === state.path && state.volume === ref &&
        !state.largeMode && !state.hexMode) {
      text = $("editor").value;
    } else {
      const tab = state.tabs.find(
        (candidate) => candidate.path === path && candidate.volume === ref &&
          !candidate.large,
      );
      if (tab) text = tab.text;
    }
    const found = findFileMatches(
      text, needle, caseSensitive, wholeWord, MAX_MATCHES - matches.length,
    );
    for (const hit of found) matches.push({ path, volume: ref, ...hit });
    if ((i & 15) === 15) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (token !== state.fileSearchToken) return;
  state.fileMatches = matches;
  state.fileMatchIndex = -1;
  renderFileFindResults();
}

function renderFileFindResults() {
  const list = $("fileFindList");
  if (!list) return;
  list.textContent = "";
  const title = $("fileFindTitle");
  if (!state.fileMatches.length) {
    const empty = document.createElement("div");
    empty.className = "file-find-empty";
    empty.textContent = $("findText").value
      ? "No matches in this folder."
      : "Type a query to search every file.";
    list.appendChild(empty);
    if (title) title.textContent = "Find in files";
    return;
  }
  if (title) {
    const where = state.fileSearchRoot
      ? `in folder ${state.fileSearchRoot}`
      : "in files";
    title.textContent = `Find ${where} — ${state.fileMatches.length}` +
      `${state.fileMatches.length >= 500 ? "+" : ""} match` +
      `${state.fileMatches.length === 1 ? "" : "es"}`;
  }
  // Group by file, the way VSCode renders "Search": a collapsible file header
  // with the path and hit count, then one row per location.
  const groups = new Map();
  state.fileMatches.forEach((match, index) => {
    let group = groups.get(match.path);
    if (!group) {
      group = { path: match.path, entries: [] };
      groups.set(match.path, group);
    }
    group.entries.push({ match, index });
  });
  const rootPrefix = state.fileSearchRoot ? `${state.fileSearchRoot}/` : "";
  for (const group of groups.values()) {
    const collapsed = state.fileCollapsed.has(group.path);
    const head = document.createElement("button");
    head.type = "button";
    head.className = "file-find-group";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    head.title = group.path;
    const caret = document.createElement("span");
    caret.className = "file-find-caret";
    caret.textContent = collapsed ? "▸" : "▾";
    const path = document.createElement("span");
    path.className = "file-find-path";
    path.textContent = rootPrefix && group.path.startsWith(rootPrefix)
      ? group.path.slice(rootPrefix.length)
      : group.path;
    const count = document.createElement("span");
    count.className = "file-find-count";
    count.textContent = String(group.entries.length);
    head.append(caret, path, count);
    head.addEventListener("click", () => {
      if (state.fileCollapsed.has(group.path)) state.fileCollapsed.delete(group.path);
      else state.fileCollapsed.add(group.path);
      renderFileFindResults();
    });
    list.appendChild(head);
    if (collapsed) continue;
    for (const { match, index } of group.entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `file-find-item${index === state.fileMatchIndex ? " active" : ""}`;
      const loc = document.createElement("span");
      loc.className = "file-find-line";
      loc.textContent = `${match.line}:${match.column}`;
      const preview = document.createElement("span");
      preview.className = "file-find-preview";
      preview.textContent = match.preview;
      row.append(loc, preview);
      row.addEventListener("click", () => openFileMatch(index));
      list.appendChild(row);
    }
  }
}

async function openFileMatch(index) {
  const match = state.fileMatches[index];
  if (!match) return;
  state.fileMatchIndex = index;
  renderFileFindResults();
  await openPath(match.path, true, match.volume);
  jumpToLine(match.line, match.column);
}

function stepFileMatch(delta) {
  if (!state.fileMatches.length) return;
  let index = state.fileMatchIndex;
  if (index < 0) {
    index = delta > 0 ? 0 : state.fileMatches.length - 1;
  } else {
    index = (index + delta + state.fileMatches.length) % state.fileMatches.length;
  }
  openFileMatch(index);
}

function refreshFindCount() {
  const count = $("findCount");
  if (!count) return;
  if (fileSearchEnabled()) {
    count.textContent = $("findText").value
      ? (state.fileSearchRoot ? "folder" : "files")
      : "";
    return;
  }
  if (state.largeMode) {
    count.textContent = "view";
    return;
  }
  const needle = $("findText").value;
  if (!needle) {
    count.textContent = "";
    return;
  }
  const matches = findMatches($("editor").value, needle);
  count.textContent = matches.length
    ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
    : "0";
}

function findNext(direction = 1) {
  if (fileSearchEnabled()) {
    const needle = $("findText").value;
    if (!needle) return;
    if (state.fileSearchQuery !== needle) {
      runFileSearch().then(() => {
        if (state.fileMatches.length) stepFileMatch(direction);
      });
    } else if (state.fileSearchRunning) {
      state.fileSearchPromise?.then(() => {
        if (state.fileMatches.length) stepFileMatch(direction);
      });
    } else if (state.fileMatches.length) {
      stepFileMatch(direction);
    } else {
      toast("not found");
    }
    return;
  }
  if (state.largeMode) {
    toast("Find is unavailable in the large-file view.", true);
    return;
  }
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const matches = findMatches(editor.value, needle);
  if (!matches.length) {
    $("findCount").textContent = "0";
    toast("not found");
    return;
  }
  let index;
  if (direction > 0) {
    index = matches.findIndex((at) => at >= editor.selectionEnd);
    if (index < 0) index = 0;
  } else {
    index = -1;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i] < editor.selectionStart) {
        index = i;
        break;
      }
    }
    if (index < 0) index = matches.length - 1;
  }
  const at = matches[index];
  editor.setSelectionRange(at, at + needle.length);
  editor.focus();
  refreshBracketMatch();
  revealSelection();
  updateStatus();
  $("findCount").textContent = `${index + 1}/${matches.length}`;
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

/* ---- replacing across files ---- */

// A replacement must not race the background search: both use the same lazy
// wasm engine, and a half-run search would report stale offsets.
async function quiesceFileSearch() {
  if (fileSearchTimer) {
    clearTimeout(fileSearchTimer);
    fileSearchTimer = 0;
  }
  state.fileSearchToken++;
  const pending = state.fileSearchPromise;
  if (pending) {
    try {
      await pending;
    } catch {
      /* the search failed; replacement still works from the matches we have */
    }
  }
}

async function replaceTextInFile(volume, path, transform) {
  const bytes = await volume.read(path);
  let engine = null;
  try {
    engine = await getFileSearchEngine();
  } catch {
    engine = null;
  }
  let text;
  if (engine) {
    engine.load(bytes, path, -1);
    text = engine.text;
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  const next = transform(text);
  if (next === text) return false;
  if (engine) {
    // Re-encode through the document engine so the file keeps its BOM,
    // encoding and source line endings.
    engine.setText(next);
    await volume.write(path, engine.saveText());
  } else {
    await volume.write(path, new TextEncoder().encode(next));
  }
  return true;
}

// Apply the given matches (which carry JS-string offsets) to their files.
// Open documents are edited in memory so undo still works and nothing is
// saved behind the user's back; closed files are rewritten through the
// encoding-preserving engine.
async function applyFileMatches(matches, needle, replacement) {
  if (!matches.length) return 0;
  captureActiveTab();
  const groups = new Map();
  for (const match of matches) {
    const key = `${match.volume}\u0000${match.path}`;
    let group = groups.get(key);
    if (!group) {
      group = { volume: match.volume, path: match.path, starts: [] };
      groups.set(key, group);
    }
    group.starts.push(match.start);
  }
  let applied = 0;
  for (const group of groups.values()) {
    const volume = state.volumes.get(group.volume);
    if (!volume || volume.readOnly) continue;
    // Replace from the end so earlier offsets stay valid.
    const starts = group.starts.sort((a, b) => b - a);
    if (group.path === state.path && group.volume === state.volume &&
        !state.largeMode && !state.hexMode) {
      const editor = $("editor");
      for (const at of starts) {
        editor.setRangeText(replacement, at, at + needle.length, "preserve");
      }
      editor.dispatchEvent(new Event("input"));
      applied += starts.length;
      continue;
    }
    const tab = state.tabs.find(
      (candidate) => candidate.path === group.path && candidate.volume === group.volume,
    );
    if (tab) {
      if (tab.large) continue;
      let text = tab.text;
      for (const at of starts) {
        text = text.slice(0, at) + replacement + text.slice(at + needle.length);
      }
      tab.text = text;
      tab.dirty = true;
      // The old undo stack describes the pre-replacement text.
      tab.history = [];
      tab.historyIndex = -1;
      tab.historyTime = 0;
      applied += starts.length;
      continue;
    }
    try {
      const changed = await replaceTextInFile(volume, group.path, (text) => {
        let out = text;
        for (const at of starts) {
          out = out.slice(0, at) + replacement + out.slice(at + needle.length);
        }
        return out;
      });
      if (changed) applied += starts.length;
    } catch (error) {
      console.error("replace in file", group.path, error);
    }
  }
  if (applied) {
    renderTabs();
    scheduleBackupSave();
  }
  return applied;
}

async function replaceFileMatch(index) {
  const needle = $("findText").value;
  if (!needle) return;
  await quiesceFileSearch();
  if (!state.fileMatches.length || state.fileSearchQuery !== needle) {
    await runFileSearch();
  }
  if (!state.fileMatches.length) {
    toast("not found");
    return;
  }
  if (index < 0 || index >= state.fileMatches.length) index = 0;
  const match = state.fileMatches[index];
  const volume = state.volumes.get(match.volume);
  if (!volume || volume.readOnly) {
    toast("This volume is read-only.", true);
    return;
  }
  const replacement = $("replaceText").value;
  const applied = await applyFileMatches([match], needle, replacement);
  if (!applied) {
    toast("could not replace", true);
    return;
  }
  await runFileSearch();
  state.fileMatchIndex = state.fileMatches.length
    ? Math.min(index, state.fileMatches.length - 1)
    : -1;
  renderFileFindResults();
  toast("replaced 1");
}

async function replaceAllFiles() {
  const needle = $("findText").value;
  const replacement = $("replaceText").value;
  if (!needle) return;
  await quiesceFileSearch();
  if (!state.fileMatches.length || state.fileSearchQuery !== needle) {
    await runFileSearch();
  }
  if (!state.fileMatches.length) {
    toast("not found");
    return;
  }
  const matches = state.fileMatches.slice();
  const hasReadOnly = matches.some((match) => state.volumes.get(match.volume)?.readOnly);
  if (hasReadOnly) {
    toast("Skipping matches on read-only volumes.", true);
  }
  const applied = await applyFileMatches(matches, needle, replacement);
  await runFileSearch();
  toast(`replaced ${applied}`);
}

function replaceOne() {
  if (fileSearchEnabled()) {
    replaceFileMatch(state.fileMatchIndex);
    return;
  }
  if (state.largeMode) return;
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const matches = findMatches(editor.value, needle);
  const current = editor.selectionStart;
  if (!matches.includes(current)) {
    findNext(1);
    return;
  }
  insertAtCursor($("replaceText").value);
  refreshFindCount();
  findNext(1);
}

function replaceAll() {
  if (fileSearchEnabled()) {
    replaceAllFiles();
    return;
  }
  if (state.largeMode) {
    toast("Replace is unavailable in the large-file view.", true);
    return;
  }
  const editor = $("editor");
  const needle = $("findText").value;
  if (!needle) return;
  const replacement = $("replaceText").value;
  const matches = findMatches(editor.value, needle);
  if (!matches.length) {
    toast("not found");
    return;
  }
  const text = editor.value;
  const pieces = [];
  let last = 0;
  for (const at of matches) {
    pieces.push(text.slice(last, at), replacement);
    last = at + needle.length;
  }
  pieces.push(text.slice(last));
  editor.value = pieces.join("");
  editor.dispatchEvent(new Event("input"));
  refreshFindCount();
  toast(`replaced ${matches.length}`);
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
function jumpToLine(wanted, column = 1) {
  wanted = Math.max(1, Math.min(state.engineReady ? state.engine.lineCount : 1, wanted | 0));
  column = Math.max(1, column | 0);
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
  const lineEnd = text.indexOf("\n", offset);
  const end = lineEnd < 0 ? text.length : lineEnd;
  offset = Math.min(offset + column - 1, end);
  editor.focus();
  editor.setSelectionRange(offset, offset);
  refreshBracketMatch();
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
  const match = commit ? typed.match(/(\d+)(?:\s*[:,\s]\s*(\d+))?/) : null;
  updateStatus();
  if (match) {
    jumpToLine(parseInt(match[1], 10), match[2] ? parseInt(match[2], 10) : 1);
  }
}

/* ---------------------------------------------------------------- settings */

function macroField(label, className, value, multiline) {
  const wrap = document.createElement("label");
  wrap.className = "macro-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement(multiline ? "textarea" : "input");
  input.className = className;
  if (multiline) {
    input.rows = 3;
    input.spellcheck = false;
    input.value = value;
  } else {
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = value;
  }
  wrap.append(caption, input);
  return wrap;
}

function appendBuildMacroCard(macro, index) {
  const list = $("buildMacroList");
  const card = document.createElement("div");
  card.className = "macro-card";
  card.dataset.macroId = macro.id;

  const head = document.createElement("div");
  head.className = "macro-head";
  const name = document.createElement("input");
  name.type = "text";
  name.className = "macro-name";
  name.value = macro.name || `Macro ${index + 1}`;
  name.placeholder = "Macro name";
  name.setAttribute("aria-label", "Build macro name");
  const up = document.createElement("button");
  up.type = "button";
  up.className = "icon-btn macro-up";
  up.textContent = "↑";
  up.title = "Move earlier (wins ties)";
  up.setAttribute("aria-label", "Move macro up");
  const down = document.createElement("button");
  down.type = "button";
  down.className = "icon-btn macro-down";
  down.textContent = "↓";
  down.title = "Move later";
  down.setAttribute("aria-label", "Move macro down");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn macro-del";
  remove.textContent = "×";
  remove.title = "Remove macro";
  remove.setAttribute("aria-label", "Remove macro");
  head.append(name, up, down, remove);

  const extField = macroField("File extensions", "macro-exts", macro.exts || "");
  extField.querySelector("input").placeholder = "cpp cxx h — blank matches any file";
  const commandField = macroField("Command", "macro-command", macro.command || "", true);
  const command = commandField.querySelector("textarea");
  command.placeholder =
    'cd "$(CURRENT_DIRECTORY)" && c++ "$(FILE_NAME)" -o "$(NAME_PART)" && ./"$(NAME_PART)"';

  up.addEventListener("click", () => {
    const previous = card.previousElementSibling;
    if (previous?.classList.contains("macro-card")) {
      list.insertBefore(card, previous);
    }
  });
  down.addEventListener("click", () => {
    const next = card.nextElementSibling;
    if (next?.classList.contains("macro-card")) {
      list.insertBefore(next, card);
    }
  });
  remove.addEventListener("click", () => {
    card.remove();
    updateBuildMacroEmptyHint();
  });

  card.append(head, extField, commandField);
  list.appendChild(card);
  return card;
}

function updateBuildMacroEmptyHint() {
  const list = $("buildMacroList");
  if (!list) return;
  const empty = list.querySelector(".macro-empty");
  const cards = list.querySelectorAll(".macro-card");
  if (!cards.length && !empty) {
    const hint = document.createElement("p");
    hint.className = "macro-empty mount-help";
    hint.textContent = "No build macros. Add one to enable the play button.";
    list.appendChild(hint);
  } else if (cards.length && empty) {
    empty.remove();
  }
}

function renderBuildMacroRows() {
  const list = $("buildMacroList");
  if (!list) return;
  list.textContent = "";
  const macros = state.settings.buildMacros || [];
  macros.forEach((macro, index) => appendBuildMacroCard(macro, index));
  updateBuildMacroEmptyHint();
}

function collectBuildMacrosFromForm() {
  const list = $("buildMacroList");
  if (!list) return state.settings.buildMacros || [];
  const cards = [...list.querySelectorAll(".macro-card")];
  const out = [];
  cards.forEach((card, index) => {
    const macro = normalizeBuildMacro({
      id: card.dataset.macroId,
      name: card.querySelector(".macro-name")?.value || "",
      exts: card.querySelector(".macro-exts")?.value || "",
      command: card.querySelector(".macro-command")?.value || "",
    }, index);
    if (macro) out.push(macro);
  });
  return out;
}

function populateSettingsForm() {
  const s = state.settings;
  $("setTheme").value = s.theme;
  $("setFontSize").value = String(s.fontSize);
  $("setLineHeight").value = String(s.lineHeight);
  $("setTermFontSize").value = String(Number(s.termFontSize) || DEFAULT_SETTINGS.termFontSize);
  $("setLineNumbers").checked = s.lineNumbers;
  $("setWrap").checked = s.wrap;
  $("setSoftKeyboard").checked = s.softKeyboard;
  $("setBrowserZoom").checked = !!s.browserZoom;
  $("setIndent").value = String(s.indent);
  const autoIndent = $("setIndent").querySelector('option[value="-1"]');
  if (autoIndent) {
    autoIndent.textContent = `Auto (detected: ${state.docIndent === 1 ? "Tab" : "2 spaces"})`;
  }
  $("setAutoSave").checked = s.autoSave;
  $("setWordCompletion").checked = s.wordCompletion !== false;
  $("setWordCompletionMin").value = String(Number(s.wordCompletionMin) || 1);
  renderBuildMacroRows();
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
  s.fontSize = Math.max(9, Math.min(72, Number($("setFontSize").value) || 13));
  s.lineHeight = Math.max(s.fontSize + 2, Math.min(160, Number($("setLineHeight").value) || 20));
  s.termFontSize = Math.max(8, Math.min(72, Number($("setTermFontSize").value) || 13));
  s.lineNumbers = $("setLineNumbers").checked;
  s.wrap = $("setWrap").checked;
  s.softKeyboard = $("setSoftKeyboard").checked;
  s.browserZoom = $("setBrowserZoom").checked;
  s.indent = Number($("setIndent").value);
  if (!Number.isFinite(s.indent)) s.indent = -1;
  s.indentExplicit = s.indent !== -1;
  s.autoSave = $("setAutoSave").checked;
  s.wordCompletion = $("setWordCompletion").checked;
  s.wordCompletionMin = Math.max(1, Math.min(8, Number($("setWordCompletionMin").value) || 1));
  s.buildMacros = collectBuildMacrosFromForm();
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
    const tabs = state.tabs
      .filter((tab) => tab.path)
      .map((tab) => ({ volume: tab.volume, path: tab.path }));
    const active = activeTab();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      volume: state.volumes.ref(),
      dir: state.volumes.path,
      file: state.path || "",
      fileVolume: state.path ? state.volume : "",
      tabs,
      active: active && active.path ? { volume: active.volume, path: active.path } : null,
    }));
  } catch {
    /* private mode */
  }
}

function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 250);
}

/* ------------------------------------------------- unsaved-edit backup */

// Dirty buffers are copied to a private OPFS directory outside the visible
// "pwa-code" volume root.  They survive a reload/crash even when the tab is
// untitled or the underlying mount is not available next time.
const BACKUP_DIR = "pwa-code-private";
const BACKUP_FILE = "unsaved.json";
let backupSaveTimer = 0;
let backupMaxTimer = 0;

async function backupDirectory(create) {
  if (!navigator.storage?.getDirectory) {
    throw new Error("Origin Private File System is unavailable.");
  }
  const origin = await navigator.storage.getDirectory();
  return origin.getDirectoryHandle(BACKUP_DIR, { create });
}

async function readUnsavedBackup() {
  try {
    const dir = await backupDirectory(false);
    const handle = await dir.getFileHandle(BACKUP_FILE, { create: false });
    const file = await handle.getFile();
    const data = JSON.parse(await file.text());
    return data && Array.isArray(data.tabs) ? data : null;
  } catch {
    return null;
  }
}

async function writeUnsavedBackup(json) {
  const dir = await backupDirectory(true);
  const handle = await dir.getFileHandle(BACKUP_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(json);
  } finally {
    await writable.close();
  }
}

async function deleteUnsavedBackup() {
  try {
    const dir = await backupDirectory(false);
    await dir.removeEntry(BACKUP_FILE);
  } catch {
    /* no backup to remove */
  }
}

function scheduleBackupSave() {
  if (!state.backupReady) return;
  // A continuous typist would otherwise keep resetting the debounce forever.
  if (!backupMaxTimer) {
    backupMaxTimer = setTimeout(() => {
      backupMaxTimer = 0;
      saveUnsavedBackupNow();
    }, 5000);
  }
  if (backupSaveTimer) clearTimeout(backupSaveTimer);
  backupSaveTimer = setTimeout(() => {
    backupSaveTimer = 0;
    saveUnsavedBackupNow();
  }, 750);
}

function backupEntryFor(tab) {
  return {
    path: tab.path,
    volume: tab.volume,
    label: tab.label,
    langPath: tab.langPath,
    text: tab.text,
    encoding: tab.encoding,
    bom: !!tab.bom,
    sourceCrlf: !!tab.sourceCrlf,
    eol: tab.eol,
    docIndent: tab.docIndent,
    cursorStart: tab.cursorStart,
    cursorEnd: tab.cursorEnd,
    scrollTop: tab.scrollTop,
    scrollLeft: tab.scrollLeft,
  };
}

async function saveUnsavedBackupNow() {
  if (!state.backupReady) return;
  if (backupSaveTimer) {
    clearTimeout(backupSaveTimer);
    backupSaveTimer = 0;
  }
  if (backupMaxTimer) {
    clearTimeout(backupMaxTimer);
    backupMaxTimer = 0;
  }
  if (state.backupWriting) {
    state.backupPending = true;
    return;
  }
  state.backupWriting = true;
  try {
    captureActiveTab();
    const entries = [];
    let active = -1;
    const current = activeTab();
    for (const tab of state.tabs) {
      if (!tab.dirty || tab.large) continue;
      if (tab === current) active = entries.length;
      entries.push(backupEntryFor(tab));
    }
    if (!entries.length) {
      await deleteUnsavedBackup();
      state.backupLastJson = "";
      return;
    }
    const payload = { version: 1, active, tabs: entries };
    const json = JSON.stringify(payload);
    if (json === state.backupLastJson) return;
    await writeUnsavedBackup(json);
    state.backupLastJson = json;
  } catch {
    if (!state.backupErrorShown) {
      state.backupErrorShown = true;
      toast("Could not back up unsaved edits to private storage.", true);
    }
  } finally {
    state.backupWriting = false;
    if (state.backupPending) {
      state.backupPending = false;
      scheduleBackupSave();
    }
  }
}

// Populate a tab from a backup without touching the engine; the chosen active
// tab is loaded afterwards by applyTabData.
function fillTabFromBackup(tab, entry) {
  const text = typeof entry.text === "string" ? entry.text : "";
  let path = typeof entry.path === "string" ? entry.path : "";
  const volume = entry.volume || state.volumes.ref();
  let label = typeof entry.label === "string" ? entry.label : "";
  const langPath = typeof entry.langPath === "string" ? entry.langPath : path;
  if (path) {
    try {
      state.volumes.get(volume);
    } catch {
      // The mount is not available this session.  Keep the text as a
      // recovered untitled buffer instead of losing the edits.
      label = `${baseName(path)} (recovered)`;
      path = "";
    }
  }
  tab.path = path;
  tab.volume = volume;
  tab.label = label;
  tab.langPath = langPath;
  tab.text = text;
  tab.bytes = null;
  tab.large = false;
  tab.dirty = true;
  tab.encoding = Math.max(0, Math.min(ENCODINGS.length - 1, Number(entry.encoding) || 0));
  tab.bom = !!entry.bom;
  tab.sourceCrlf = !!entry.sourceCrlf;
  tab.eol = Math.max(0, Math.min(2, Number(entry.eol) || 0));
  tab.docIndent = Number.isInteger(entry.docIndent)
    ? (entry.docIndent === 1 ? 1 : 0)
    : detectIndent(text);
  tab.history = [];
  tab.historyIndex = -1;
  tab.historyTime = 0;
  const len = text.length;
  tab.cursorStart = Math.max(0, Math.min(len, Number(entry.cursorStart) || 0));
  tab.cursorEnd = Math.max(tab.cursorStart, Math.min(len, Number(entry.cursorEnd) || tab.cursorStart));
  tab.scrollTop = Math.max(0, Number(entry.scrollTop) || 0);
  tab.scrollLeft = Math.max(0, Number(entry.scrollLeft) || 0);
  tab.largeFirst = 0;
}

async function restoreUnsavedBackup(backup) {
  const entries = backup && Array.isArray(backup.tabs) ? backup.tabs : [];
  if (!entries.length) return false;
  const map = new Map();
  let touched = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    let index = -1;
    if (entry.path) {
      index = state.tabs.findIndex((tab) =>
        tab.path === entry.path && tab.volume === (entry.volume || "internal"));
    }
    if (index < 0) {
      const current = activeTab();
      const reuse = !!current && !current.path && !current.dirty && !current.large &&
        !$("editor").value;
      if (reuse) {
        index = state.tabIndex;
      } else {
        const tab = createTabData({ volume: entry.volume || state.volumes.ref() });
        state.tabs.push(tab);
        index = state.tabs.length - 1;
      }
    }
    fillTabFromBackup(state.tabs[index], entry);
    map.set(i, index);
    touched = true;
  }
  if (!touched) return false;
  let activeIndex = Number.isInteger(backup.active) ? map.get(backup.active) : undefined;
  if (activeIndex === undefined) activeIndex = state.tabIndex;
  state.tabIndex = activeIndex;
  await applyTabData(state.tabs[activeIndex]);
  return true;
}

function flushUnsavedBackup() {
  if (!state.backupReady) return;
  saveUnsavedBackupNow();
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
// the file's folder and opens it again.  When several tabs were open, the
// active one chooses the folder and all of them are reopened.
function restoreSavedSession() {
  const saved = readSavedSession();
  if (!saved) {
    setVolTab("internal");
    return null;
  }
  const savedTabs = Array.isArray(saved.tabs)
    ? saved.tabs.filter((entry) => entry && entry.path)
    : [];
  const active = saved.active && saved.active.path
    ? saved.active
    : savedTabs[0] || null;
  if (active) {
    if (applySavedLocation(active.volume, parentPath(active.path))) {
      return { tabs: savedTabs.length ? savedTabs : [active], active };
    }
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
  const backup = await readUnsavedBackup();
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
    const initial = createTabData();
    state.tabs.push(initial);
    state.tabIndex = 0;
    setEditorText("");
    state.path = "";
    state.volume = state.volumes.ref();
    state.settings.eol = 0;
    updateDirty(false);
    renderTabs();
    if (restored?.tabs?.length) {
      for (const entry of restored.tabs) {
        if (entry && entry.path) await openPath(entry.path, true, entry.volume);
      }
      if (restored.active) {
        const index = state.tabs.findIndex((tab) =>
          tab.path === restored.active.path && tab.volume === restored.active.volume);
        if (index >= 0) await switchTab(index, false);
      }
    } else if (restored?.file) {
      await openPath(restored.file, true);
    }
    if (backup) {
      try {
        await restoreUnsavedBackup(backup);
      } catch (error) {
        fail("restore unsaved edits", error);
      }
    }
    state.backupReady = true;
    if (state.tabs.some((tab) => tab.dirty)) scheduleBackupSave();
    if (window.innerWidth <= 720 && state.path) $("sidebar").classList.add("hidden");
  } else {
    state.backupReady = false;
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
    const sample = `// PWA Code — fast_io + WebAssembly edition
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
        "# PWA Code\n\n" +
          "- The theme follows the OS by default; dark is full black, light is full white.\n" +
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

  editor.addEventListener("input", (event) => {
    syncEditorToEngine();
    updateDirty(true);
    state.wrapDirty = true;
    refreshBracketMatch(false);
    rerender();
    if (!event.isComposing) {
      scheduleWordSetRefresh();
      refreshCompletion();
    }
    if (state.settings.autoSave && state.path) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => saveDocument(false), 900);
    }
  });
  // Clicking a suggestion must not blur the textarea (that would dismiss the
  // OS keyboard); insert it and keep typing in place.
  $("completion").addEventListener("pointerdown", (event) => event.preventDefault());
  $("completion").addEventListener("click", (event) => {
    const item = event.target.closest(".completion-item");
    if (!item) return;
    event.preventDefault();
    state.completionIndex = Number(item.dataset.index) || 0;
    acceptCompletion();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!state.completionOpen) return;
    if ($("completion").contains(event.target) || event.target === editor) return;
    closeCompletion();
  });
  // Some browsers copy soft-wrapped rows as hard line breaks.  Always take
  // the exact logical selection from the buffer instead of the rendered text.
  const copyEditorSelection = (event) => {
    if (event.target !== editor || !event.clipboardData) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start === end) return;
    event.clipboardData.setData("text/plain", editor.value.slice(start, end));
    event.preventDefault();
    if (event.type === "cut") {
      editor.setRangeText("", start, end, "start");
      editor.dispatchEvent(new Event("input"));
    }
  };
  editor.addEventListener("copy", copyEditorSelection);
  editor.addEventListener("cut", copyEditorSelection);
  editor.addEventListener("scroll", rerender, { passive: true });
  $("largeScroll").addEventListener("scroll", () => updateHighlight(), { passive: true });
  editor.addEventListener("keyup", () => { refreshBracketMatch(); updateStatus(); });
  editor.addEventListener("click", () => { closeCompletion(); refreshBracketMatch(); updateStatus(); });
  editor.addEventListener("select", () => { refreshBracketMatch(); updateStatus(); });
  editor.addEventListener("selectionchange", () => { refreshBracketMatch(); updateStatus(); });

  editor.addEventListener("keydown", (event) => {
    // The completion list owns navigation/accept/cancel while it is open.
    if (state.completionOpen) {
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        moveCompletion(1);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        moveCompletion(-1);
        return;
      }
      if ((event.key === "Tab" && !event.shiftKey) ||
          (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey)) {
        event.preventDefault();
        acceptCompletion();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCompletion();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" ||
          event.key === "Home" || event.key === "End") {
        closeCompletion();
      }
    }
    // Notepad++'s manual word completion shortcut.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === " ") {
      event.preventDefault();
      refreshCompletion(true);
      return;
    }
    if (!event.isComposing && state.settings.wrap &&
        !event.altKey && !event.ctrlKey && !event.metaKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      // Up/Down move between real lines, not the visual rows produced by wrap.
      event.preventDefault();
      moveEditorLogical(event.key, event.shiftKey);
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      findNext(event.shiftKey ? -1 : 1);
      return;
    }
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
      changeEditorIndent(event.shiftKey);
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
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey &&
               event.key.toLowerCase() === "f") {
      // VSCode-style: search the folder the explorer is showing.
      event.preventDefault();
      startFileSearch(state.volumes.path || "", false);
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
  $("findText").addEventListener("input", () => {
    refreshFindCount();
    if (fileSearchEnabled()) scheduleFileSearch();
  });
  $("findCase").addEventListener("change", () => {
    refreshFindCount();
    if (fileSearchEnabled()) scheduleFileSearch();
  });
  $("findWord").addEventListener("change", () => {
    refreshFindCount();
    if (fileSearchEnabled()) scheduleFileSearch();
  });
  $("findFiles").addEventListener("change", () => {
    if (!$("findFiles").checked) state.fileSearchRoot = "";
    refreshFindCount();
    if (fileSearchEnabled()) {
      if ($("findText").value) runFileSearch();
    } else {
      closeFileFind();
    }
  });
  $("fileFindClose").addEventListener("click", closeFileFind);

  $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("hidden"));

  $("tabBar").addEventListener("click", (event) => {
    if (event.target.closest("#tabNewBtn")) {
      newBlankTab();
      return;
    }
    const tab = event.target.closest(".doc-tab");
    if (!tab) return;
    const index = Number(tab.dataset.index);
    if (event.target.closest(".doc-tab-close")) {
      closeTab(index);
      return;
    }
    switchTab(index);
  });
  $("tabBar").addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const tab = event.target.closest(".doc-tab");
    if (!tab) return;
    event.preventDefault();
    closeTab(Number(tab.dataset.index));
  });

  // Sidebar drag strip.  The width is written straight to --sidebar-w while the
  // pointer moves and persisted once it is released; double-click forgets it.
  {
    const handle = $("sidebarHandle");
    const sidebar = $("sidebar");
    let drag = null;
    const refreshAfterResize = () => {
      updateHighlight();
      if (state.hexMode) renderHex();
      if (activeTermInst() && !$("termWrap").hidden) resizeTerminal();
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
      if (activeTermInst() && !wrap.hidden) resizeTerminal();
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
  document.addEventListener("pointerdown", (event) => {
    if ($("buildMenu").hidden) return;
    if (event.target.closest("#buildMenu") || event.target.closest("#buildPickBtn")) return;
    closeBuildMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("fileMenu").hidden) {
      event.preventDefault();
      closeFileMenu();
    } else if (event.key === "Escape" && !$("buildMenu").hidden) {
      event.preventDefault();
      closeBuildMenu();
    } else if (event.key === "Escape" && !$("conflictPanel").hidden) {
      event.preventDefault();
      $("conflictPanel").hidden = true;
    }
  });
  $("fileList").addEventListener("scroll", closeFileMenu, { passive: true });
  window.addEventListener("resize", () => {
    closeFileMenu();
    closeBuildMenu();
  });
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("saveBtn").addEventListener("click", () => saveDocument(false));
  $("saveAsBtn").addEventListener("click", () => saveDocument(true));
  $("buildBtn").addEventListener("click", () => runBuildMacro());
  $("buildPickBtn").addEventListener("click", () => {
    if ($("buildMenu").hidden) openBuildMenu($("buildPickBtn"));
    else closeBuildMenu();
  });
  $("addBuildMacro").addEventListener("click", () => {
    const list = $("buildMacroList");
    const card = appendBuildMacroCard({
      id: makeMacroId(),
      name: `Macro ${list.querySelectorAll(".macro-card").length + 1}`,
      exts: "",
      command: "",
    }, list.querySelectorAll(".macro-card").length);
    updateBuildMacroEmptyHint();
    card.querySelector(".macro-name")?.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest" });
  });
  $("findBtn").addEventListener("click", () => openFind(false));
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
  $("termMax").addEventListener("click", () =>
    setTerminalMaximized(!state.termMaximized));
  $("termClose").addEventListener("click", () => closeTerminalInstance());
  $("termConnect").addEventListener("click", () => connectTerminal(activeTermInst()));
  $("termNew").addEventListener("click", () => newTerminalInstance());
  $("termClear").addEventListener("click", () => {
    const inst = activeTermInst();
    if (inst) inst.term.clearScreen();
  });
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
  $("termTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".term-tab");
    if (!tab) return;
    const index = Number(tab.dataset.index);
    if (event.target.closest(".term-tab-close")) {
      const inst = state.terms[index];
      if (inst) closeTerminalInstance(inst);
      return;
    }
    activateTerminal(index);
  });

  // Tapping the terminal should bring the OS keyboard back after it has been
  // dismissed, and route physical keys to the PTY at the same time.  Mouse
  // drags and touch long-presses must still be able to select output, so the
  // proxy is focused on a completed tap/click rather than on pointerdown.
  const termInput = $("termInput");
  const termStack = $("termStack");
  const focusTerminalInput = (inst = activeTermInst()) => {
    ensureTerminalConnection(inst);
    // When the OS keyboard's own hide button dismissed it, the proxy often
    // keeps focus.  A no-op focus() would not raise the keyboard again, so
    // blur first; this still happens inside the tap's user gesture.
    if (document.activeElement === termInput) termInput.blur();
    termInput.focus({ preventScroll: true });
  };
  const terminalHasSelection = (inst = activeTermInst()) => {
    const sel = window.getSelection();
    return !!inst && !!sel && !sel.isCollapsed && !!sel.toString() &&
      (inst.el.contains(sel.anchorNode) || inst.el.contains(sel.focusNode));
  };
  let termPointer = null;
  termStack.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    const pane = event.target.closest(".term");
    const inst = (pane && termInstFromElement(pane)) || activeTermInst();
    if (!inst) return;
    ensureTerminalConnection(inst);
    termPointer = {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
      moved: false,
      inst,
    };
    // Freeze repaints while a drag is selecting; the grid must not be
    // replaced mid-drag by a busy program such as top.  Touch long-press
    // selection starts after pointerdown, so hold for every pointer type.
    inst.term.hold = true;
  });
  termStack.addEventListener("pointermove", (event) => {
    if (!termPointer) return;
    if (Math.abs(event.clientX - termPointer.x) > 3 ||
        Math.abs(event.clientY - termPointer.y) > 3) {
      termPointer.moved = true;
    }
  });
  const endTerminalPointer = (event) => {
    const pointer = termPointer;
    termPointer = null;
    if (pointer && pointer.inst.term) {
      pointer.inst.term.hold = false;
      if (pointer.inst.term.dirty) pointer.inst.term.schedule();
    }
    if (!pointer) return;
    // A pinch is a zoom gesture, not a request for the OS keyboard.
    if (pinchRecently()) return;
    // A drag is a selection gesture; leave focus (and the selection) alone.
    if (pointer.moved || terminalHasSelection(pointer.inst)) return;
    // A plain tap/click is the request for the OS keyboard.
    if (event.type === "pointercancel") return;
    focusTerminalInput(pointer.inst);
  };
  window.addEventListener("pointerup", endTerminalPointer);
  window.addEventListener("pointercancel", endTerminalPointer);
  // iOS is more reliable at raising the keyboard from a click than from a
  // pointerdown, so keep the click as a fallback, but never collapse a
  // selection the user just made.
  termStack.addEventListener("click", () => {
    const inst = activeTermInst();
    ensureTerminalConnection(inst);
    if (pinchRecently() || terminalHasSelection(inst)) return;
    if (document.activeElement !== termInput) termInput.focus({ preventScroll: true });
  });
  termStack.addEventListener("keydown", (event) => {
    // The keyboard proxy inside the stack handles non-printable keys and
    // prevents their default; do not send the same arrow/escape byte twice.
    if (event.defaultPrevented) return;
    if (terminalClipboardShortcut(event)) return;
    if (event.key === "Tab") event.preventDefault();
    const bytes = keyToBytes(event);
    if (bytes) {
      event.preventDefault();
      sendTerminalBytes(bytes);
    }
  });
  // When the selection is dropped, flush any repaint that was held back.
  document.addEventListener("selectionchange", () => {
    const inst = activeTermInst();
    if (inst && inst.term.dirty) inst.term.schedule();
  });
  termInput.addEventListener("focus", () => {
    state.softTarget = "terminal";
    const inst = activeTermInst();
    if (inst) inst.el.classList.add("kb-focus");
  });
  termInput.addEventListener("blur", () => {
    for (const inst of state.terms) inst.el.classList.remove("kb-focus");
  });
  termStack.addEventListener("focusin", () => { state.softTarget = "terminal"; });
  $("editor").addEventListener("focus", () => { state.softTarget = "editor"; });
  termInput.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (terminalClipboardShortcut(event)) return;
    // Printable keys are delivered through the input event, which is the only
    // path that works with soft keyboards and IMEs that report "Unidentified".
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // ...but some soft keyboards do send a keydown.  When the on-screen
      // Ctrl/Alt is latched, turn this character into the chord now; otherwise
      // the terminal's bubbling keydown would send the bare letter.
      if (state.softMods.ctrl || state.softMods.alt) {
        event.preventDefault();
        if (!(event.key.toLowerCase() === "c" && softCtrlCCopiesSelection())) {
          sendTerminalTypedText(event.key);
        }
      }
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
    // Soft-keyboard chords carry no ctrlKey/altKey on the event, so the
    // latched on-screen modifiers are applied to the typed character.
    if (text.toLowerCase() === "c" && softCtrlCCopiesSelection()) return;
    // A soft-keyboard Enter arrives as a newline rather than a keydown; the
    // PTY expects CR.
    sendTerminalTypedText(text);
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
    if (activeTermInst() && !$("termWrap").hidden) resizeTerminal();
    positionSoftKeyboard();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      positionSoftKeyboard();
      if (activeTermInst() && !$("termWrap").hidden) resizeTerminal();
    });
    window.visualViewport.addEventListener("scroll", positionSoftKeyboard);
  }
  // Android/iOS close the PTY socket while the PWA is in the background and
  // can report the old viewport when it comes back.  Reconnect and re-measure
  // on every resume path the platform offers.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      saveSessionNow();
      flushUnsavedBackup();
    } else {
      resumeTerminal();
    }
  });
  window.addEventListener("pagehide", () => {
    saveSessionNow();
    flushUnsavedBackup();
  });
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
  $("findDirBtn").addEventListener("click", () =>
    startFileSearch(state.volumes.path || "", false));

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

  // The top box shows the open file.  Focusing selects it so typing a new
  // path replaces it; Enter opens that file, Escape restores the current one.
  $("topPath").addEventListener("focus", () => $("topPath").select());
  $("topPath").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const typed = $("topPath").value;
      $("topPath").blur();
      openTypedDocument(typed);
    } else if (event.key === "Escape") {
      event.preventDefault();
      updateDocPath();
      $("topPath").blur();
    }
  });
  $("topPath").addEventListener("blur", updateDocPath);

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
  // Mobile browsers dismiss the OS keyboard when a tap lands on a focusable
  // element, even when pointerdown is cancelled.  Take the buttons out of the
  // tab order, cancel every pre-focus event, and put the caret back into the
  // surface that owns the keyboard after each key.
  function keepSoftKeyboardAfterKey(name) {
    if (name === "Escape" && !softKeyboardTargetsTerminal()) return;
    if (softKeyboardTargetsTerminal()) {
      $("termInput").focus({ preventScroll: true });
    } else if (!state.largeMode && !state.hexMode) {
      $("editor").focus({ preventScroll: true });
    }
  }
  function guardSoftKey(button) {
    button.tabIndex = -1;
    const stop = (event) => event.preventDefault();
    button.addEventListener("pointerdown", stop);
    button.addEventListener("mousedown", stop);
    button.addEventListener("touchstart", stop, { passive: false });
    // A long press must not open the mobile context menu or start a text
    // selection; it is a key repeat gesture.
    button.addEventListener("contextmenu", stop);
  }

  // Hold an arrow (or Backspace/Delete/Page) and the caret keeps moving.  The
  // first repeat is delayed like a desktop keyboard, then repeats quickly.
  let softRepeatDelay = 0;
  let softRepeatTimer = 0;
  const SOFT_REPEAT_KEYS = new Set([
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "PageUp", "PageDown", "Home", "End", "Backspace", "Delete",
  ]);
  function stopSoftRepeat() {
    if (softRepeatDelay) {
      clearTimeout(softRepeatDelay);
      softRepeatDelay = 0;
    }
    if (softRepeatTimer) {
      clearInterval(softRepeatTimer);
      softRepeatTimer = 0;
    }
  }
  function runSoftKey(name) {
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
    if (name !== "") {
      state.softMods.ctrl = state.softMods.alt = false;
      updateSoftMods();
    }
    keepSoftKeyboardAfterKey(name);
  }
  for (const key of document.querySelectorAll("#softKeyboard [data-key]")) {
    guardSoftKey(key);
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (event.button > 0) return;
      stopSoftRepeat();
      const name = key.dataset.key;
      runSoftKey(name);
      if (!SOFT_REPEAT_KEYS.has(name)) return;
      // Capture the pointer so pointerup still arrives if the finger slides.
      try {
        key.setPointerCapture(event.pointerId);
      } catch {
        /* older browser without pointer capture */
      }
      softRepeatDelay = setTimeout(() => {
        softRepeatDelay = 0;
        softRepeatTimer = setInterval(() => runSoftKey(name), 55);
      }, 350);
    });
    key.addEventListener("pointerup", stopSoftRepeat);
    key.addEventListener("pointercancel", stopSoftRepeat);
    key.addEventListener("lostpointercapture", stopSoftRepeat);
  }
  window.addEventListener("pointerup", stopSoftRepeat);
  window.addEventListener("pointercancel", stopSoftRepeat);
  window.addEventListener("blur", stopSoftRepeat);
  document.addEventListener("visibilitychange", stopSoftRepeat);
  for (const key of document.querySelectorAll("#softKeyboard [data-mod]")) {
    guardSoftKey(key);
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const mod = key.dataset.mod;
      state.softMods[mod] = !state.softMods[mod];
      updateSoftMods();
      keepSoftKeyboardAfterKey("");
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
    state.settings = { ...DEFAULT_SETTINGS, buildMacros: defaultBuildMacros() };
    saveSettings();
    populateSettingsForm();
    applySettings();
    toast("settings reset");
  });

  $("statusWrap").addEventListener("click", toggleWrap);

  // Ctrl/Cmd + wheel (and a trackpad pinch, which reports ctrlKey) is our UI
  // zoom everywhere in the app.  The browser page itself never zooms; the
  // event is cancelled even over the sidebar or toolbar, and the editor or
  // terminal font changes instead.
  document.addEventListener("wheel", (event) => {
    if (state.settings.browserZoom) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomSurface(zoomSurfaceFor(event.target), event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Safari raises these for a pinch even when the viewport meta says
  // user-scalable=no.  Cancel them so only our UI zoom runs.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (event) => {
      if (state.settings.browserZoom) return;
      event.preventDefault();
    }, { passive: false });
  }
  bindPinchZoom($("editorWrap"), "editor");
  bindPinchZoom($("termStack"), "terminal");

  // Capture phase: handle the shortcut before the editor/terminal keydown
  // handlers turn "=" or "-" into text or PTY bytes.
  document.addEventListener("keydown", (event) => {
    if (!handleZoomKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

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
      // Ctrl+Shift+B is the Notepad++-style run/build shortcut.  Capture it so
      // the browser's bookmark-bar toggle never sees it.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        (event.key === "b" || event.key === "B")
      ) {
        event.preventDefault();
        runBuildMacro();
        return;
      }
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
      if (!$("termWrap").hidden && $("termStack").contains(document.activeElement)) return;
      closeDocument();
    },
    true,
  );

  window.addEventListener("beforeunload", (event) => {
    flushUnsavedBackup();
    if (state.dirty || state.tabs.some((tab) => tab.dirty)) {
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
