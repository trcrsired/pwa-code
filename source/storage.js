// pwa-code storage volumes.
//
// Three import roots mirror pwa-player:
//
//   internal  - Origin Private File System (falls back to IndexedDB blobs)
//   external  - File System Access API directory chosen by the user
//   remote    - the native pwa-code server's /api/file + /api/list endpoints
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
  constructor() {
    this.id = "external";
    this.label = "External";
    this.kind = "fsa";
    this.handle = null;
  }

  static supported() {
    return typeof window.showDirectoryPicker === "function";
  }

  async restore() {
    if (this.handle) return this.handle;
    const saved = await kvGet("external-dir");
    if (!saved) throw new Error("Choose an external folder first.");
    let perm = await saved.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await saved.requestPermission({ mode: "readwrite" });
    }
    if (perm !== "granted") {
      this.handle = null;
      throw new Error("External folder permission was denied. Choose the folder again.");
    }
    this.handle = saved;
    return saved;
  }

  async pick() {
    if (!ExternalVolume.supported()) {
      throw new Error("This browser does not support the File System Access API.");
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    this.handle = handle;
    await kvSet("external-dir", handle);
    return handle;
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

export class RemoteVolume {
  constructor(baseUrl) {
    this.id = "remote";
    this.label = "Remote";
    this.kind = "http";
    this.base = baseUrl || "";
  }

  setBase(baseUrl) {
    this.base = (baseUrl || "").replace(/\/$/, "");
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

  async list(path) {
    const res = await this.request(
      `/api/list?path=${encodeURIComponent(path || "")}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    const out = (data.entries || []).map((e) => ({ name: e.name, dir: !!e.dir }));
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  }

  async read(path) {
    const res = await this.request(
      `/api/file?path=${encodeURIComponent(path)}`,
      { cache: "no-store" },
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path, bytes) {
    await this.request(`/api/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  }

  async mkdir() {
    throw new Error("The remote volume cannot create directories.");
  }

  async remove() {
    throw new Error("The remote volume is read/write but cannot delete files.");
  }
}

// ---------------------------------------------------------------- manager

export class Volumes {
  constructor() {
    this.internal = new OpfsVolume("internal", "Internal");
    this.external = new ExternalVolume();
    this.remote = new RemoteVolume("");
    this.current = "internal";
    this.path = "";
  }

  get(id) {
    if (id === "external") return this.external;
    if (id === "remote") return this.remote;
    return this.internal;
  }

  active() {
    return this.get(this.current);
  }

  async init(remoteBase) {
    this.remote.setBase(remoteBase || "");
    if (ExternalVolume.supported()) {
      try {
        await this.external.restore();
      } catch {
        /* not chosen yet; user can pick later */
      }
    }
  }
}
