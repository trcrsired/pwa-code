#!/usr/bin/env node
// Build the static PWA into docs/.
//
// Like pwa-player, the player shipped in docs/ contains minified HTML, CSS and
// JavaScript (source/ stays readable).  On top of that, precompressed .gz/.br
// copies are emitted; the native server negotiates them and any static host can
// do the same.
//
// The minifiers are build-time dependencies only; nothing from node_modules is
// copied into the player.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { minify as minifyHTML } from "html-minifier-terser";
import CleanCSS from "clean-css";
import { minify as minifyJS } from "terser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "source");
const docs = path.join(root, "docs");
const compressible = new Set([".html", ".js", ".mjs", ".css", ".wasm", ".svg", ".json", ".webmanifest", ".md", ".txt"]);

// ES modules may safely mangle top-level names.  The service worker is a
// classic script, so keep top-level names there.
const moduleScripts = new Set(["app.js", "wasm.js", "storage.js", "terminal.js"]);

async function walk(dir) {
  const out = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function minifyScript(content, rel, stamp) {
  if (rel === "sw.js") {
    // Stamp before minification: constant folding is free to drop VERSION
    // afterwards, but every build must still get a fresh cache name.
    content = content.replace(/const VERSION = "[^"]*";/, `const VERSION = "${stamp}";`);
  }
  const result = await minifyJS(content, {
    module: moduleScripts.has(rel),
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false },
  });
  if (result.error) throw result.error;
  if (!result.code) throw new Error(`terser produced no output for ${rel}`);
  return result.code;
}

async function processFile(srcPath, docsPath, rel, stamp) {
  const ext = path.extname(srcPath).toLowerCase();
  await fs.promises.mkdir(path.dirname(docsPath), { recursive: true });

  if (ext === ".html") {
    const content = await fs.promises.readFile(srcPath, "utf8");
    const result = await minifyHTML(content, {
      collapseWhitespace: true,
      removeComments: true,
      removeRedundantAttributes: true,
      minifyCSS: true,
      minifyJS: true,
    });
    await fs.promises.writeFile(docsPath, result);
    return;
  }

  if (ext === ".css") {
    const content = await fs.promises.readFile(srcPath, "utf8");
    const result = new CleanCSS({ level: 2 }).minify(content);
    if (result.errors.length) throw new Error(`clean-css: ${result.errors.join("; ")}`);
    await fs.promises.writeFile(docsPath, result.styles);
    return;
  }

  if (ext === ".js" || ext === ".mjs") {
    const content = await fs.promises.readFile(srcPath, "utf8");
    await fs.promises.writeFile(docsPath, await minifyScript(content, rel, stamp));
    return;
  }

  if (ext === ".json" || ext === ".webmanifest") {
    const content = await fs.promises.readFile(srcPath, "utf8");
    await fs.promises.writeFile(docsPath, JSON.stringify(JSON.parse(content)));
    return;
  }

  await fs.promises.copyFile(srcPath, docsPath);
}

async function main() {
  const wasm = path.join(source, "pwacode.wasm");
  if (!(await exists(wasm))) {
    console.error("error: source/pwacode.wasm is missing; run build/build-wasm.sh first");
    process.exit(1);
  }

  await fs.promises.rm(docs, { recursive: true, force: true });
  await fs.promises.mkdir(docs, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  for (const file of await walk(source)) {
    const rel = path.relative(source, file);
    await processFile(file, path.join(docs, rel), rel, stamp);
  }

  const files = await walk(docs);
  let raw = 0;
  let gz = 0;
  let br = 0;
  for (const file of files) {
    const stat = await fs.promises.stat(file);
    raw += stat.size;
    const ext = path.extname(file);
    if (!compressible.has(ext)) continue;
    const data = await fs.promises.readFile(file);
    const gzData = zlib.gzipSync(data, { level: 9 });
    const brData = zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
    await fs.promises.writeFile(`${file}.gz`, gzData);
    await fs.promises.writeFile(`${file}.br`, brData);
    gz += gzData.length;
    br += brData.length;
  }

  const fmt = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
  console.log(`docs/: ${files.length} files, ${fmt(raw)} minified, ${fmt(gz)} gzip, ${fmt(br)} brotli`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
