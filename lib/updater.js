// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// Actualización automática desde GitHub (Erickdo/clipsphere).
// manifest.json lista cada archivo con su sha256: solo se bajan los que cambiaron, se verifican
// y se escriben. config.json (claves del usuario) nunca se toca.
// Archivos retirados: solo se quitan los que la versión anterior instaló (estaban en su manifest), que ya no están en
// la nueva, que viven en carpetas de la app y que nadie modificó. No se borran: se mueven a _update_backup/.
// Si algo falla a mitad, se deshace todo con esa copia.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = process.env.CLIPSPHERE_REPO || "Erickdo/clipsphere";
const BRANCH = process.env.CLIPSPHERE_BRANCH || "main";
const RAW = process.env.CLIPSPHERE_RAW || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const ROOT = process.env.CLIPSPHERE_APP_ROOT || path.join(__dirname, "..");
// Nunca se escriben ni se borran: ajustes, claves, sesión de YouTube, secreto del móvil, registros
const PROTECTED = new Set(["config.json", "config.json.bak", "cookies.txt", ".clipsphere-secret", "errores.log", "seguridad.log", "seguridad.log.1", "seguridad.log.2", "manifest.json"]);
// Solo se retiran archivos dentro de la app: código, interfaz, herramientas y documentos de la raíz
const MANAGED = /^(lib|public|prompts|tools)\/[^]+$|^[^/]+\.(js|bat|txt|md|onnx|py)$|^\.gitignore$/;
const BACKUP = () => path.join(ROOT, "_update_backup");

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

/** Descarga y aplica la versión nueva. Devuelve la lista de archivos cambiados y retirados. */
async function apply(log = () => {}) {
  const local = localManifest();
  const remote = await fetchRemote();
  if (!remote || !Array.isArray(remote.files) || !remote.version) throw new Error("El manifest remoto no es válido.");
  const changed = [], removed = [], kept = [];
  const staged = [];
  for (const f of remote.files) {
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
  // Archivos retirados en la versión nueva (solo los administrados por la app y sin cambios del usuario)
  const inRemote = new Set(remote.files.map((f) => f.path));
  const retire = [];
  for (const f of local.files || []) {
    if (inRemote.has(f.path)) continue;
    let dest; try { dest = safePath(f.path); } catch { continue; }
    if (!MANAGED.test(f.path) || !fs.existsSync(dest)) continue;
    let cur = null; try { cur = sha(fs.readFileSync(dest)); } catch {}
    if (cur !== f.sha256) { kept.push(f.path); continue; } // lo cambiaste tú: no se toca
    retire.push({ dest, rel: f.path });
  }

  // 1) Todo se baja primero a una carpeta temporal que no vigila el reinicio automático.
  const tmp = path.join(ROOT, "_update_tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  staged.forEach((s, i) => { s.tmp = path.join(tmp, String(i)); fs.writeFileSync(s.tmp, s.buf); });
  // 2) Copia de seguridad de lo que se va a reemplazar o retirar (para deshacer si algo falla, o a mano después)
  const bk = BACKUP();
  fs.rmSync(bk, { recursive: true, force: true });
  fs.mkdirSync(bk, { recursive: true });
  const journal = { from: local.version, to: remote.version, at: new Date().toISOString(), files: [] };
  for (const s of [...staged, ...retire]) {
    let existed = false; try { existed = fs.statSync(s.dest).isFile(); } catch {}
    if (existed) { const b = path.join(bk, "files", s.rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(s.dest, b); }
    journal.files.push({ rel: s.rel, existed });
  }
  try { fs.copyFileSync(path.join(ROOT, "manifest.json"), path.join(bk, "manifest.json")); } catch {}
  fs.writeFileSync(path.join(bk, "journal.json"), JSON.stringify(journal, null, 2));
  // 3) Se aplica de una pasada (server.js y lib/ al final); si algo falla, se deshace todo.
  staged.sort((a, b) => (/^(server\.js|lib\/)/.test(a.rel) ? 1 : 0) - (/^(server\.js|lib\/)/.test(b.rel) ? 1 : 0));
  try {
    for (const s of staged) {
      fs.mkdirSync(path.dirname(s.dest), { recursive: true });
      fs.copyFileSync(s.tmp, s.dest);
      changed.push(s.rel);
    }
    for (const r of retire) { fs.rmSync(r.dest, { force: true }); removed.push(r.rel); }
    // manifest.json al último: si algo se corta, la próxima revisión lo vuelve a aplicar.
    fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(remote, null, 2));
  } catch (e) {
    log(`La actualización falló (${e.message}); dejo todo como estaba…`);
    rollback(log);
    throw new Error("La actualización falló y se deshizo: " + e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  changed.forEach((c) => log(`actualizado ${c}`));
  removed.forEach((c) => log(`retirado ${c} (copia en _update_backup)`));
  kept.forEach((c) => log(`conservado ${c}: ya no es parte de la app, pero tiene cambios tuyos`));
  return { version: remote.version, changed, removed, kept };
}

/** Vuelve a dejar los archivos como estaban antes de la última actualización (usa _update_backup/). */
function rollback(log = () => {}) {
  const bk = BACKUP();
  let j; try { j = JSON.parse(fs.readFileSync(path.join(bk, "journal.json"), "utf8")); } catch { throw new Error("No hay copia de la actualización anterior."); }
  for (const f of j.files) {
    let dest; try { dest = safePath(f.rel); } catch { continue; }
    const b = path.join(bk, "files", f.rel);
    try {
      if (f.existed && fs.existsSync(b)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(b, dest); }
      else if (!f.existed) fs.rmSync(dest, { force: true }); // era nuevo de la versión que se deshace
    } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") log(`No pude devolver ${f.rel}: ${e.message}`); }
  }
  try { fs.copyFileSync(path.join(bk, "manifest.json"), path.join(ROOT, "manifest.json")); } catch {}
  log(`Vuelto a la versión ${j.from}.`);
  return { version: j.from, files: j.files.length };
}

module.exports = { check, apply, rollback, localManifest, REPO, PROTECTED, MANAGED };
