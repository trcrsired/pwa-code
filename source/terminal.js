// A small ANSI terminal renderer for the pwa-code PTY WebSocket.
//
// It is deliberately dependency free.  The native server sends raw PTY bytes;
// this class maintains a fixed-size character grid with scrollback and
// understands the CSI/SGR subset used by shells and common TUI programs.

const CSI = 0x1b;

const SGR_FG = {
  30: "ansi-black", 31: "ansi-red", 32: "ansi-green", 33: "ansi-yellow",
  34: "ansi-blue", 35: "ansi-magenta", 36: "ansi-cyan", 37: "ansi-white",
  90: "ansi-bright-black", 91: "ansi-bright-red", 92: "ansi-bright-green",
  93: "ansi-bright-yellow", 94: "ansi-bright-blue", 95: "ansi-bright-magenta",
  96: "ansi-bright-cyan", 97: "ansi-bright-white",
};

const SGR_BG = {
  40: "ansi-black", 41: "ansi-red", 42: "ansi-green", 43: "ansi-yellow",
  44: "ansi-blue", 45: "ansi-magenta", 46: "ansi-cyan", 47: "ansi-white",
  100: "ansi-bright-black", 101: "ansi-bright-red", 102: "ansi-bright-green",
  103: "ansi-bright-yellow", 104: "ansi-bright-blue", 105: "ansi-bright-magenta",
  106: "ansi-bright-cyan", 107: "ansi-bright-white",
};

function blankCell() {
  return { ch: " ", fg: "", bg: "", bold: false, underline: false, inverse: false };
}

class Line {
  constructor(cols) {
    this.cells = new Array(cols);
    for (let i = 0; i < cols; i++) this.cells[i] = blankCell();
  }
}

export class Terminal {
  constructor(element, options = {}) {
    this.el = element;
    this.cols = options.cols || 100;
    this.rows = options.rows || 30;
    this.scrollback = options.scrollback || 2000;
    this.lines = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.attr = blankCell();
    this.savedCursor = { row: 0, col: 0 };
    this.state = "normal";
    this.csi = "";
    this.osc = "";
    this.utf8 = new Uint8Array();
    this.dirty = false;
    this.frame = 0;
    this.onData = options.onData || (() => {});
    this.atBottom = true;
    this.alt = false;
    this.savedMain = null;
    this.scrollTop = 0;
    this.scrollBottom = -1;
    this.cursorVisible = true;
    this.clear();
    this.el.classList.add("term-grid");
    this.el.addEventListener("scroll", () => {
      this.atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
    });
  }

  resize(cols, rows) {
    cols = Math.max(20, cols | 0);
    rows = Math.max(5, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const old = this.cols;
    const oldRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    for (const line of this.lines) {
      if (line.cells.length < cols) {
        for (let i = line.cells.length; i < cols; i++) line.cells.push(blankCell());
      } else if (line.cells.length > cols) {
        line.cells.length = cols;
      }
    }
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].cells.length === 0) this.lines[i] = new Line(cols);
    }
    if (this.alt) {
      while (this.lines.length < rows) this.lines.push(new Line(cols));
      if (this.lines.length > rows) this.lines.length = rows;
      this.cursorRow = Math.min(this.cursorRow, rows - 1);
      this.scrollTop = 0;
      this.scrollBottom = -1;
    }
    this.cursorCol = Math.min(this.cursorCol, cols - 1);
    if (old !== cols || oldRows !== rows) this.dirty = true;
  }

  clear() {
    this.lines = [new Line(this.cols)];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.attr = blankCell();
    this.scrollTop = 0;
    this.scrollBottom = -1;
    this.cursorVisible = true;
    this.dirty = true;
  }

  line(row) {
    while (this.lines.length <= row) this.lines.push(new Line(this.cols));
    return this.lines[row];
  }

  scrollUp() {
    if (this.lines.length > this.scrollback) this.lines.shift();
    else {
      this.cursorRow = Math.max(0, this.cursorRow);
    }
    if (this.lines.length > this.rows && this.cursorRow >= this.lines.length - 1) {
      if (this.lines.length > this.scrollback) this.lines.shift();
    }
  }

  newline() {
    if (this.alt) {
      // Full-screen programs keep a screen of exactly `rows` lines and scroll
      // only inside their declared margin (vim, less, top all rely on this).
      const bottom = this.scrollBottom >= 0 ? this.scrollBottom : this.rows - 1;
      const top = this.scrollBottom >= 0 ? this.scrollTop : 0;
      if (this.cursorRow >= bottom) {
        this.lines.splice(top, 1);
        this.lines.splice(bottom, 0, new Line(this.cols));
        this.cursorRow = bottom;
      } else {
        this.cursorRow++;
        while (this.lines.length <= this.cursorRow) this.lines.push(new Line(this.cols));
      }
      this.atBottom = true;
      return;
    }
    this.cursorRow++;
    if (this.cursorRow >= this.lines.length) this.lines.push(new Line(this.cols));
    if (this.lines.length > this.scrollback) {
      const excess = this.lines.length - this.scrollback;
      this.lines.splice(0, excess);
      this.cursorRow -= excess;
    }
    this.atBottom = true;
  }

  reverseIndex() {
    const bottom = this.scrollBottom >= 0 ? this.scrollBottom : this.rows - 1;
    const top = this.scrollBottom >= 0 ? this.scrollTop : 0;
    if (this.cursorRow <= top) {
      this.lines.splice(bottom, 1);
      this.lines.splice(top, 0, new Line(this.cols));
    } else {
      this.cursorRow--;
    }
    this.dirty = true;
  }

  enterAltScreen() {
    if (this.alt) return;
    this.savedMain = {
      lines: this.lines,
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
    this.alt = true;
    this.lines = [];
    for (let i = 0; i < this.rows; i++) this.lines.push(new Line(this.cols));
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = -1;
    this.dirty = true;
  }

  leaveAltScreen() {
    if (!this.alt) return;
    this.alt = false;
    if (this.savedMain) {
      this.lines = this.savedMain.lines;
      this.cursorRow = this.savedMain.cursorRow;
      this.cursorCol = this.savedMain.cursorCol;
      this.scrollTop = this.savedMain.scrollTop;
      this.scrollBottom = this.savedMain.scrollBottom;
      this.savedMain = null;
    }
    this.atBottom = true;
    this.dirty = true;
  }

  putChar(ch) {
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.newline();
    }
    const row = this.line(this.cursorRow);
    row.cells[this.cursorCol] = { ...this.attr, ch };
    this.cursorCol++;
    this.dirty = true;
  }

  carriageReturn() {
    this.cursorCol = 0;
  }

  backspace() {
    if (this.cursorCol > 0) this.cursorCol--;
  }

  eraseLine(mode) {
    const row = this.line(this.cursorRow);
    let begin = 0;
    let end = this.cols;
    if (mode === 0) begin = this.cursorCol;
    else if (mode === 1) end = this.cursorCol + 1;
    for (let i = begin; i < end; i++) row.cells[i] = blankCell();
    this.dirty = true;
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      if (this.alt) {
        // Keep a full screen in the alternate buffer: vim and less rely on
        // every row existing when they repaint after a clear.
        this.lines = [];
        for (let i = 0; i < this.rows; i++) this.lines.push(new Line(this.cols));
        this.dirty = true;
      } else {
        this.clear();
      }
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.cursorRow + 1; r < this.lines.length; r++) this.lines[r] = new Line(this.cols);
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) this.lines[r] = new Line(this.cols);
      this.eraseLine(1);
    }
    this.dirty = true;
  }

  sgr(params) {
    if (!params.length) params = [0];
    for (let i = 0; i < params.length; i++) {
      const p = params[i] | 0;
      if (p === 0) this.attr = blankCell();
      else if (p === 1) this.attr.bold = true;
      else if (p === 4) this.attr.underline = true;
      else if (p === 7) this.attr.inverse = true;
      else if (p === 22) this.attr.bold = false;
      else if (p === 24) this.attr.underline = false;
      else if (p === 27) this.attr.inverse = false;
      else if (p === 39) this.attr.fg = "";
      else if (p === 49) this.attr.bg = "";
      else if (SGR_FG[p]) this.attr.fg = SGR_FG[p];
      else if (SGR_BG[p]) this.attr.bg = SGR_BG[p];
      else if (p === 38 || p === 48) {
        // 256-colour / truecolour sequences
        let cls = "";
        if (params[i + 1] === 5) {
          const n = params[i + 2] | 0;
          cls = `ansi-256-${n}`;
          i += 2;
        } else if (params[i + 1] === 2) {
          const r = params[i + 2] | 0;
          const g = params[i + 3] | 0;
          const b = params[i + 4] | 0;
          cls = `rgb-${r}-${g}-${b}`;
          i += 4;
        }
        if (p === 38) this.attr.fg = cls;
        else this.attr.bg = cls;
      }
    }
  }

  csiDispatch(final, raw) {
    const priv = raw.startsWith("?") || raw.startsWith(">") || raw.startsWith("!");
    const body = priv ? raw.slice(1) : raw;
    const params = body.length ? body.split(";").map((v) => (v === "" ? 0 : parseInt(v, 10) || 0)) : [];
    const n = params[0] || 0;
    switch (final) {
      case "A": this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, n)); break;
      case "B": this.cursorRow = Math.min(this.lines.length - 1, this.cursorRow + Math.max(1, n)); break;
      case "C": this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, n)); break;
      case "D": this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, n)); break;
      case "E": this.cursorRow = Math.min(this.lines.length - 1, this.cursorRow + Math.max(1, n)); this.cursorCol = 0; break;
      case "F": this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, n)); this.cursorCol = 0; break;
      case "G": this.cursorCol = Math.max(0, Math.min(this.cols - 1, n - 1)); break;
      case "d": this.cursorRow = Math.max(0, Math.min(this.lines.length - 1, n - 1)); break;
      case "H":
      case "f": {
        const row = Math.max(1, params[0] || 1);
        const col = Math.max(1, params[1] || 1);
        this.cursorRow = row - 1;
        this.cursorCol = col - 1;
        if (this.alt) {
          this.cursorRow = Math.min(this.cursorRow, this.rows - 1);
          this.cursorCol = Math.min(this.cursorCol, this.cols - 1);
        }
        this.line(this.cursorRow);
        break;
      }
      case "J": this.eraseDisplay(n); break;
      case "K": this.eraseLine(n); break;
      case "L": {
        for (let i = 0; i < Math.max(1, n); i++) this.lines.splice(this.cursorRow, 0, new Line(this.cols));
        if (this.lines.length > this.scrollback) this.lines.length = this.scrollback;
        break;
      }
      case "M": {
        this.lines.splice(this.cursorRow, Math.max(1, n));
        if (this.lines.length <= this.cursorRow) this.lines.push(new Line(this.cols));
        break;
      }
      case "S": {
        // Scroll up inside the current margin.
        const top = this.scrollBottom >= 0 ? this.scrollTop : 0;
        const bottom = this.scrollBottom >= 0 ? this.scrollBottom : this.rows - 1;
        for (let i = 0; i < Math.max(1, n); i++) {
          this.lines.splice(top, 1);
          this.lines.splice(bottom, 0, new Line(this.cols));
        }
        break;
      }
      case "T": {
        const top = this.scrollBottom >= 0 ? this.scrollTop : 0;
        const bottom = this.scrollBottom >= 0 ? this.scrollBottom : this.rows - 1;
        for (let i = 0; i < Math.max(1, n); i++) {
          this.lines.splice(bottom, 1);
          this.lines.splice(top, 0, new Line(this.cols));
        }
        break;
      }
      case "r": {
        // DECSTBM: top/bottom scrolling margins (1-based, inclusive).
        const top = Math.max(1, params[0] || 1) - 1;
        const bottom = Math.max(top + 1, params[1] || this.rows) - 1;
        this.scrollTop = Math.min(top, this.rows - 1);
        this.scrollBottom = Math.min(bottom, this.rows - 1);
        this.cursorRow = this.scrollTop;
        this.cursorCol = 0;
        break;
      }
      case "X": {
        const line = this.line(this.cursorRow);
        const end = Math.min(this.cols, this.cursorCol + Math.max(1, n));
        for (let i = this.cursorCol; i < end; i++) line.cells[i] = blankCell();
        break;
      }
      case "n": {
        // Device status report.  Full-screen programs use 6n to learn the
        // cursor position; without a reply vim may wait for a timeout.
        if (!priv && n === 6) {
          this.onData(`\x1b[${this.cursorRow + 1};${this.cursorCol + 1}R`);
        }
        break;
      }
      case "P": {
        const line = this.line(this.cursorRow);
        line.cells.splice(this.cursorCol, Math.max(1, n));
        while (line.cells.length < this.cols) line.cells.push(blankCell());
        break;
      }
      case "@": {
        const line = this.line(this.cursorRow);
        for (let i = 0; i < Math.max(1, n); i++) line.cells.splice(this.cursorCol, 0, blankCell());
        line.cells.length = this.cols;
        break;
      }
      case "m": this.sgr(params); break;
      case "s": this.savedCursor = { row: this.cursorRow, col: this.cursorCol }; break;
      case "u":
        this.cursorRow = this.savedCursor.row;
        this.cursorCol = this.savedCursor.col;
        this.line(this.cursorRow);
        break;
      case "h":
      case "l": {
        const on = final === "h";
        if (priv) {
          for (const p of params) {
            if (p === 25) {
              this.cursorVisible = on;
              this.dirty = true;
            }
            else if (p === 1049 || p === 1047 || p === 47) {
              if (on) this.enterAltScreen();
              else this.leaveAltScreen();
            }
          }
        }
        break;
      }
      default:
        break;
    }
    this.dirty = true;
  }

  feedBytes(bytes) {
    // Interpret as UTF-8; incomplete sequences are kept for the next chunk.
    let merged;
    if (this.utf8.length) {
      merged = new Uint8Array(this.utf8.length + bytes.length);
      merged.set(this.utf8);
      merged.set(bytes, this.utf8.length);
    } else {
      merged = bytes;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
      this.utf8 = new Uint8Array();
    } catch {
      // Trim an incomplete tail and decode what is complete.
      let cut = merged.length;
      while (cut > 0 && (merged[cut - 1] & 0xc0) === 0x80) cut--;
      if (cut > 0 && (merged[cut - 1] & 0x80) !== 0) cut--;
      if (cut <= 0) {
        this.utf8 = merged.slice(Math.max(0, merged.length - 3));
        return;
      }
      text = new TextDecoder("utf-8", { fatal: false }).decode(merged.subarray(0, cut));
      this.utf8 = merged.slice(cut);
    }
    this.feed(text);
  }

  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.state === "osc") {
        if (ch === "\x07") this.state = "normal";
        else if (ch === "\x1b" && text[i + 1] === "\\") { i++; this.state = "normal"; }
        continue;
      }
      if (this.state === "csi") {
        this.csi += ch;
        if (ch >= "\x40" && ch <= "\x7e") {
          const raw = this.csi.slice(0, -1);
          this.state = "normal";
          this.csi = "";
          this.csiDispatch(ch, raw);
        }
        continue;
      }
      if (this.state === "esc") {
        if (ch === "[") { this.state = "csi"; this.csi = ""; continue; }
        if (ch === "]") { this.state = "osc"; continue; }
        if (ch === "P" || ch === "^" || ch === "_") { this.state = "osc"; continue; }
        if (ch === "7") { this.savedCursor = { row: this.cursorRow, col: this.cursorCol }; this.state = "normal"; continue; }
        if (ch === "8") {
          this.cursorRow = this.savedCursor.row;
          this.cursorCol = this.savedCursor.col;
          this.state = "normal";
          continue;
        }
        if (ch === "(" || ch === ")" || ch === "#" || ch === "%") { this.state = "charset"; continue; }
        if (ch === "M") { this.reverseIndex(); this.state = "normal"; continue; }
        if (ch === "D") { this.newline(); this.state = "normal"; continue; }
        if (ch === "E") { this.newline(); this.carriageReturn(); this.state = "normal"; continue; }
        if (ch === "=" || ch === ">" || ch === "c") { this.state = "normal"; if (ch === "c") this.clear(); continue; }
        this.state = "normal";
        continue;
      }
      if (this.state === "charset") { this.state = "normal"; continue; }
      const code = ch.codePointAt(0);
      if (code === CSI) { this.state = "esc"; continue; }
      if (ch === "\n") { this.newline(); continue; }
      if (ch === "\r") { this.carriageReturn(); continue; }
      if (ch === "\b") { this.backspace(); continue; }
      if (ch === "\t") {
        const next = (Math.floor(this.cursorCol / 8) + 1) * 8;
        while (this.cursorCol < next) this.putChar(" ");
        continue;
      }
      if (code === 7) continue;
      if (code < 32) continue;
      if (code > 0xffff) {
        this.putChar(ch);
        // Surrogates occupy two JS code units but one terminal cell.
        i++;
      } else {
        this.putChar(ch);
      }
    }
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dirty) this.render();
    });
  }

  render() {
    this.dirty = false;
    const pieces = [];
    for (let row = 0; row < this.lines.length; row++) {
      const line = this.lines[row];
      let runText = "";
      let runKey = "";
      const flush = () => {
        if (!runText) return;
        if (!runKey) pieces.push(escapeHtml(runText));
        else pieces.push(`<span class="${runKey}">${escapeHtml(runText)}</span>`);
        runText = "";
      };
      for (let col = 0; col < line.cells.length; col++) {
        const cell = line.cells[col];
        // Paint a block cursor over the cell the PTY cursor is on.  This is
        // what makes vim's position visible: the parser keeps cursorRow/Col
        // updated from CUP/HVP, so the highlight follows the real terminal.
        if (this.cursorVisible && row === this.cursorRow && col === this.cursorCol) {
          flush();
          const cls = `term-cursor${runKey ? ` ${runKey}` : ""}`;
          pieces.push(`<span class="${cls}">${escapeHtml(cell.ch)}</span>`);
          continue;
        }
        let key = "";
        if (cell.bold) key += "tb ";
        if (cell.underline) key += "tu ";
        if (cell.fg) key += `${cell.fg} `;
        if (cell.bg) key += `bg-${cell.bg} `;
        if (cell.inverse) key += "tinv ";
        key = key.trim();
        if (key !== runKey) {
          flush();
          runKey = key;
        }
        runText += cell.ch;
      }
      flush();
      pieces.push("\n");
    }
    this.el.textContent = "";
    this.el.innerHTML = `<div class="term-lines">${pieces.join("")}</div>`;
    if (this.atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  clearScreen() {
    this.clear();
    this.render();
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Keyboard to PTY byte mapping.  `ctrl` is a boolean for the soft keyboard.
export function keyToBytes(event) {
  const { key, ctrlKey, altKey, metaKey } = event;
  if (ctrlKey && key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  switch (key) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return "\x1b[A";
    case "ArrowDown": return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft": return "\x1b[D";
    case "Home": return "\x1b[H";
    case "End": return "\x1b[F";
    case "PageUp": return "\x1b[5~";
    case "PageDown": return "\x1b[6~";
    case "Insert": return "\x1b[2~";
    case "Delete": return "\x1b[3~";
    default: break;
  }
  if (metaKey || altKey) {
    if (key.length === 1) return `\x1b${key}`;
  }
  if (key.length === 1) return key;
  return "";
}
