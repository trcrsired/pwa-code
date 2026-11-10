// pwa-code storage volumes.
//
// Volume families mirror pwa-player:
//
//   internal  - Origin Private File System (one built-in root)
//   external  - any number of mounted File System Access directories
//   remote    - any number of mounted HTTP / pwa-code-server endpoints
//
// Every volume exposes the same tiny interface:
//
//   list(path)          -> [{name, dir}]
//   read(path)          -> Uint8Array
//   write(path, bytes)  -> void
//   mkdir(path)         -> void
//   remove(path, isDir) -> void
//
// Errors are thrown as Error objects with a human readable message.  The C++
// engine never reports errors through return codes; this JavaScript layer is
// the browser-side equivalent: callers use try/catch, never status flags.

const DB_NAME = "pwacode";
const DB_STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

export async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

export async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const req = tx.objectStore(DB_STORE).put(value, key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function kvDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const req = tx.objectStore(DB_STORE).delete(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

function splitPath(path) {
  return String(path || "")
    .split("/")
    .filter((p) => p.length !== 0 && p !== ".");
}

function joinPath(path, name) {
  return path ? `${path}/${name}` : name;
}

export function parentPath(path) {
  const parts = splitPath(path);
  parts.pop();
  return parts.join("/");
}

export function baseName(path) {
  const parts = splitPath(path);
  return parts.length ? parts[parts.length - 1] : "";
}

export function dirName(path) {
  return parentPath(path);
}

export function validMountName(name) {
  const text = String(name || "").trim();
  return !!text && !/[.\/\\:*?"<>|\x00-\x1f]/.test(text);
}

function uniqueName(base, taken) {
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

// ---------------------------------------------------------------- internal

export class OpfsVolume {
  constructor(id = "internal", label = "Internal") {
    this.id = id;
    this.label = label;
    this.kind = "opfs";
    this.rootPromise = null;
  }

  async root() {
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        if (!navigator.storage?.getDirectory) {
          throw new Error("This browser has no Origin Private File System support.");
        }
        const origin = await navigator.storage.getDirectory();
        return origin.getDirectoryHandle("pwa-code", { create: true });
      })();
    }
    return this.rootPromise;
  }

  async dirHandle(path, create) {
    let dir = await this.root();
    for (const part of splitPath(path)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async list(path) {
    const dir = await this.dirHandle(path, false);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (name === ".keep") continue;
      out.push({ name, dir: handle.kind === "directory" });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  }

  async read(path) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), false);
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path, bytes) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }

  async mkdir(path) {
    await this.dirHandle(path, true);
  }

  async remove(path, isDir) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), false);
    await dir.removeEntry(name, { recursive: !!isDir });
  }
}

// ---------------------------------------------------------------- external

export class ExternalVolume {
  constructor(id, label, handle = null) {
    this.id = id;
    this.label = label;
    this.kind = "fsa";
    this.handle = handle;
  }

  static supported() {
    return typeof window.showDirectoryPicker === "function";
  }

  async restore() {
    if (!this.handle) throw new Error("Choose an external folder first.");
    let perm = await this.handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await this.handle.requestPermission({ mode: "readwrite" });
    }
    if (perm !== "granted") {
      throw new Error("External folder permission was denied. Mount it again.");
    }
    return this.handle;
  }

  async dirHandle(path, create) {
    let dir = await this.restore();
    for (const part of splitPath(path)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async list(path) {
    const dir = await this.dirHandle(path, false);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      out.push({ name, dir: handle.kind === "directory" });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  }

  async read(path) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), false);
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path, bytes) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }

  async mkdir(path) {
    await this.dirHandle(path, true);
  }

  async remove(path, isDir) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await this.dirHandle(parts.join("/"), false);
    await dir.removeEntry(name, { recursive: !!isDir });
  }
}

// ------------------------------------------------------------------ remote

function encodePath(path) {
  return splitPath(path).map(encodeURIComponent).join("/");
}

export class RemoteVolume {
  constructor(id, label, baseUrl, mode = "auto") {
    this.id = id;
    this.label = label;
    this.kind = "http";
    this.base = (baseUrl || "").replace(/\/+$/, "");
    this.mode = mode || "auto";
  }

  setBase(baseUrl) {
    this.base = (baseUrl || "").replace(/\/+$/, "");
  }

  url(path, query) {
    return `${this.base}${path}${query ? `?${query}` : ""}`;
  }

  async request(path, init) {
    const res = await fetch(this.url(path), init);
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j && j.error) detail = j.error;
      } catch {
        /* body was not JSON */
      }
      throw new Error(detail);
    }
    return res;
  }

  sortEntries(out) {
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  }

  async apiList(path) {
    const res = await this.request(
      `/api/list?path=${encodeURIComponent(path || "")}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    const out = (data.entries || []).map((e) => ({ name: e.name, dir: !!e.dir }));
    return this.sortEntries(out);
  }

  async httpList(path) {
    const rel = encodePath(path);
    const dirUrl = `${this.base}/${rel}${rel ? "/" : ""}`;
    const res = await fetch(dirUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const data = await res.json();
      const entries = data.entries || data.files || data;
      if (!Array.isArray(entries)) throw new Error("Unsupported remote directory format.");
      return this.sortEntries(entries.map((e) => ({
        name: typeof e === "string" ? e : e.name,
        dir: typeof e === "string" ? e.endsWith("/") : !!e.dir,
      })));
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const current = new URL(dirUrl).pathname;
    const out = [];
    const seen = new Set();
    for (const link of doc.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("?") || href.startsWith("#")) continue;
      if (/^(mailto|javascript):/i.test(href)) continue;
      let resolved;
      try {
        resolved = new URL(href, dirUrl);
      } catch {
        continue;
      }
      if (resolved.origin !== new URL(dirUrl).origin) continue;
      const isDir = resolved.pathname.endsWith("/");
      const wanted = current.endsWith("/") ? current : `${current}/`;
      if (!resolved.pathname.startsWith(wanted)) continue;
      const rest = resolved.pathname.slice(wanted.length);
      if (!rest) continue;
      const parts = rest.split("/").filter(Boolean);
      if (!parts.length) continue;
      const name = decodeURIComponent(parts[0]);
      if (!name || name === "." || name === "..") continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, dir: isDir || parts.length > 1 });
    }
    return this.sortEntries(out);
  }

  async list(path) {
    if (this.mode === "http") return this.httpList(path);
    if (this.mode === "server") return this.apiList(path);
    try {
      const entries = await this.apiList(path);
      this.mode = "server";
      return entries;
    } catch {
      const entries = await this.httpList(path);
      this.mode = "http";
      return entries;
    }
  }

  async read(path) {
    if (this.mode !== "http") {
      try {
        const res = await this.request(
          `/api/file?path=${encodeURIComponent(path)}`,
          { cache: "no-store" },
        );
        this.mode = "server";
        return new Uint8Array(await res.arrayBuffer());
      } catch (error) {
        if (this.mode === "server") throw error;
      }
    }
    const rel = encodePath(path);
    const res = await fetch(`${this.base}/${rel}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path, bytes) {
    if (this.mode === "http") {
      throw new Error("This remote mount is read-only.");
    }
    await this.request(`/api/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    this.mode = "server";
  }

  async mkdir() {
    throw new Error("The remote volume cannot create directories.");
  }

  async remove() {
    throw new Error("The remote volume cannot delete files.");
  }
}

// ---------------------------------------------------------------- manager

export class Volumes {
  constructor() {
    this.internal = new OpfsVolume("internal", "Internal");
    this.externalMounts = new Map();
    this.remoteMounts = new Map();
    this.current = "internal";
    this.mount = "";
    this.path = "";
  }

  async init(remoteBase) {
    await this.loadMounts();
    if (this.externalMounts.size === 0) {
      try {
        const legacy = await kvGet("external-dir");
        if (legacy) {
          await this.addExternalMount(legacy);
          await kvDelete("external-dir");
        }
      } catch {
        /* no legacy mount */
      }
    }
    if (this.remoteMounts.size === 0 && remoteBase) {
      try {
        const id = await this.addRemoteMount("Remote", remoteBase, "auto");
        this.mount = id;
      } catch {
        /* invalid saved base */
      }
    }
  }

  async loadMounts() {
    const external = await kvGet("external-mounts");
    if (external && typeof external === "object") {
      for (const [id, handle] of Object.entries(external)) {
        if (handle) this.externalMounts.set(id, new ExternalVolume(id, id, handle));
      }
    }
    const remote = await kvGet("remote-mounts");
    if (remote && typeof remote === "object") {
      for (const [id, cfg] of Object.entries(remote)) {
        if (!cfg || !cfg.url) continue;
        this.remoteMounts.set(
          id,
          new RemoteVolume(id, cfg.label || id, cfg.url, cfg.mode || "auto"),
        );
      }
    }
  }

  get(ref) {
    if (!ref || ref === "internal") return this.internal;
    const colon = ref.indexOf(":");
    if (colon < 0) {
      if (ref === "external") return this.externalMounts.get(this.mount);
      if (ref === "remote") return this.remoteMounts.get(this.mount);
      return this.internal;
    }
    const kind = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    return kind === "external" ? this.externalMounts.get(id) : this.remoteMounts.get(id);
  }

  active() {
    if (this.current === "internal") return this.internal;
    const volume = this.get(this.current);
    if (!volume) throw new Error("Select a mount first.");
    return volume;
  }

  ref() {
    return this.current === "internal" ? "internal" : `${this.current}:${this.mount}`;
  }

  mounts(kind) {
    const map = kind === "external" ? this.externalMounts : this.remoteMounts;
    return [...map.values()].map((v) => ({
      id: v.id,
      label: v.label,
      kind: kind,
      detail: kind === "remote" ? v.base : "",
    }));
  }

  async persistExternal() {
    const out = {};
    for (const [id, volume] of this.externalMounts) {
      if (volume.handle) out[id] = volume.handle;
    }
    await kvSet("external-mounts", out);
  }

  async persistRemote() {
    const out = {};
    for (const [id, volume] of this.remoteMounts) {
      out[id] = { label: volume.label, url: volume.base, mode: volume.mode };
    }
    await kvSet("remote-mounts", out);
  }

  async addExternalMount(handle) {
    const base = (handle && handle.name) || "external";
    const id = uniqueName(base, new Set(this.externalMounts.keys()));
    this.externalMounts.set(id, new ExternalVolume(id, id, handle));
    await this.persistExternal();
    return id;
  }

  async addRemoteMount(name, url, mode = "auto") {
    const label = String(name || "").trim();
    if (!validMountName(label)) throw new Error("Invalid mount name.");
    let base = String(url || "").trim();
    if (!base) throw new Error("Remote URL is required.");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `http://${base}`;
    base = base.replace(/\/+$/, "");
    const id = uniqueName(label, new Set(this.remoteMounts.keys()));
    this.remoteMounts.set(id, new RemoteVolume(id, label, base, mode));
    await this.persistRemote();
    return id;
  }

  async removeMount(kind, id) {
    if (kind === "external") {
      this.externalMounts.delete(id);
      await this.persistExternal();
    } else {
      this.remoteMounts.delete(id);
      await this.persistRemote();
    }
    if (this.mount === id) {
      this.mount = "";
      this.path = "";
    }
  }

  async setRemote(id, base, mode) {
    const volume = this.remoteMounts.get(id);
    if (!volume) throw new Error("Unknown remote mount.");
    volume.setBase(base);
    volume.mode = mode;
    await this.persistRemote();
  }
}

export { joinPath };
