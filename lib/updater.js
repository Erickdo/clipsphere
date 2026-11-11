// ClipSphere © 2026 Erick Ramírez. Todos los derechos reservados. Ver LICENCIA.txt
// Actualización automática desde GitHub (Erickdo/clipsphere).
// manifest.json lista cada archivo con su sha256: solo se bajan los que cambiaron, se verifican
// y se escriben. config.json (claves del usuario) nunca se toca.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = process.env.CLIPSPHERE_REPO || "Erickdo/clipsphere";
const BRANCH = process.env.CLIPSPHERE_BRANCH || "main";
const RAW = process.env.CLIPSPHERE_RAW || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const ROOT = path.join(__dirname, "..");
const PROTECTED = new Set(["config.json"]);

function sha(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function localManifest() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")); } catch { return { version: "0.0.0", files: [] }; }
}
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}
function safePath(rel) {
  const p = path.resolve(ROOT, rel);
  if (!p.startsWith(path.resolve(ROOT) + path.sep) || PROTECTED.has(path.basename(rel)) || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) throw new Error("ruta no permitida: " + rel);
  return p;
}

async function fetchRemote() {
  const res = await fetch(`${RAW}/manifest.json?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude revisar actualizaciones (${res.status}).`);
  return res.json();
}

async function check() {
  const local = localManifest();
  const remote = await fetchRemote();
  return { current: local.version, latest: remote.version, available: cmpVer(remote.version, local.version) > 0, notes: remote.notes || [] };
}

/** Descarga y aplica la versión nueva. Devuelve la lista de archivos cambiados. */
async function apply(log = () => {}) {
  const remote = await fetchRemote();
  const changed = [];
  const staged = [];
  for (const f of remote.files || []) {
    const dest = safePath(f.path);
    let same = false;
    try { same = sha(fs.readFileSync(dest)) === f.sha256; } catch {}
    if (same) continue;
    const res = await fetch(`${RAW}/${f.path.split("/").map(encodeURIComponent).join("/")}?v=${remote.version}`);
    if (!res.ok) throw new Error(`No pude bajar ${f.path} (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== f.sha256) throw new Error(`El archivo ${f.path} llegó dañado; intenta otra vez.`);
    staged.push({ dest, buf, rel: f.path });
  }
  // 1) Todo se baja primero a una carpeta temporal que no vigila el reinicio automático.
  // 2) Luego se copia de una sola pasada (server.js y lib/ al final).
  // 3) manifest.json se escribe al último: si algo se corta, la próxima revisión lo vuelve a aplicar.
  const tmp = path.join(ROOT, "_update_tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  staged.forEach((s, i) => { s.tmp = path.join(tmp, String(i)); fs.writeFileSync(s.tmp, s.buf); });
  staged.sort((a, b) => (/^(server\.js|lib\/)/.test(a.rel) ? 1 : 0) - (/^(server\.js|lib\/)/.test(b.rel) ? 1 : 0));
  for (const s of staged) {
    fs.mkdirSync(path.dirname(s.dest), { recursive: true });
    fs.copyFileSync(s.tmp, s.dest);
    changed.push(s.rel);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  changed.forEach((c) => log(`actualizado ${c}`));
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(remote, null, 2));
  return { version: remote.version, changed };
}

module.exports = { check, apply, localManifest, REPO };
