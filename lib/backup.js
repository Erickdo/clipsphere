// ClipSphere © 2026 Erick Ramírez. Todos los derechos reservados. Ver LICENCIA.txt
// Respaldo automático: copia ajustes, historial y clips a una carpeta en la nube
// (OneDrive / Google Drive). Nunca borra nada del respaldo, solo añade o actualiza.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const STATE = { running: false, hasPending: false, last: null, error: null, dir: "" };

/** Busca OneDrive o Google Drive en esta PC. Devuelve la carpeta de respaldo sugerida o "". */
function detectDir() {
  const tries = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial,
    path.join(os.homedir(), "OneDrive"), "G:\\Mi unidad", "G:\\My Drive",
    path.join(os.homedir(), "Google Drive"), path.join(os.homedir(), "Google Drive", "Mi unidad")];
  for (const t of tries) {
    try { if (t && fs.statSync(t).isDirectory()) return path.join(t, "ClipSphere-respaldo"); } catch {}
  }
  return "";
}

function targetDir(cfg) { return String(cfg.backupDir || "").trim() || detectDir(); }

function inside(a, b) { const r = path.relative(b, a); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); }

/** Copia src → dst solo si falta o cambió. Escribe a un temporal y renombra: nunca queda un archivo a medias. */
async function copyIfChanged(src, dst, stats) {
  const s = await fsp.stat(src);
  try {
    const d = await fsp.stat(dst);
    if (d.size === s.size && d.mtimeMs >= s.mtimeMs - 2000) return false;
  } catch {}
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = dst + ".copiando";
  await fsp.copyFile(src, tmp);
  await fsp.utimes(tmp, s.atime, s.mtime).catch(() => {});
  await fsp.rename(tmp, dst);
  stats.files++; stats.bytes += s.size;
  return true;
}

const SKIP = /(\.tmp\.mp4|\.copiando|\.part|\.ytdl)$/i;

/** Lista las carpetas de trabajos (cada video procesado) dentro de outputRoot. */
function jobDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && (fs.existsSync(path.join(root, d.name, "plan.json")) || fs.existsSync(path.join(root, d.name, "info.json"))))
      .map((d) => d.name);
  } catch { return []; }
}

async function doSync(cfg, configFile, only) {
  const dir = targetDir(cfg);
  STATE.dir = dir;
  if (!dir) throw new Error("No encontré OneDrive ni Google Drive en esta PC. Elige una carpeta de respaldo en Ajustes.");
  if (inside(dir, cfg.outputRoot) || inside(cfg.outputRoot, dir)) throw new Error("La carpeta de respaldo no puede estar dentro de la carpeta de salida (ni al revés).");
  const stats = { files: 0, bytes: 0 };
  await fsp.mkdir(dir, { recursive: true });
  if (fs.existsSync(configFile)) await copyIfChanged(configFile, path.join(dir, "config.json"), stats);
  const names = only ? [only] : jobDirs(cfg.outputRoot);
  for (const name of names) {
    const src = path.join(cfg.outputRoot, name);
    let files = [];
    try { files = await fsp.readdir(src, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || SKIP.test(f.name)) continue;
      if (cfg.backupClips === false && /\.mp4$/i.test(f.name)) continue;
      await copyIfChanged(path.join(src, f.name), path.join(dir, "historial", name, f.name), stats);
    }
  }
  const total = jobDirs(path.join(dir, "historial")).length;
  const rec = { at: new Date().toISOString(), copied: stats.files, bytes: stats.bytes, videos: total };
  fs.writeFileSync(path.join(dir, "respaldo.json"), JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * Programa un respaldo. Si ya hay uno corriendo, se encadena otro al terminar
 * (así no se pierde nada aunque lleguen varios pedidos seguidos).
 * only = nombre de la carpeta de un trabajo para respaldar solo ese (más rápido).
 */
function schedule(getCfg, configFile, only) {
  const cfg = getCfg();
  if (cfg.backupEnabled === false) return Promise.resolve(null);
  if (STATE.running) {
    // Al terminar el actual se hace uno completo (es incremental: lo que no cambió no se copia).
    STATE.hasPending = true;
    return Promise.resolve(null);
  }
  STATE.running = true;
  return doSync(cfg, configFile, only)
    .then((r) => { STATE.last = r; STATE.error = null; return r; })
    .catch((e) => { STATE.error = e.message; console.log("  Respaldo: " + e.message); return null; })
    .finally(() => {
      STATE.running = false;
      if (STATE.hasPending) { STATE.hasPending = false; schedule(getCfg, configFile); }
    });
}

function status(cfg) {
  const dir = targetDir(cfg);
  let last = STATE.last;
  if (!last && dir) { try { last = JSON.parse(fs.readFileSync(path.join(dir, "respaldo.json"), "utf8")); } catch {} }
  return { enabled: cfg.backupEnabled !== false, dir, detected: detectDir(), custom: !!cfg.backupDir, running: STATE.running, last, error: STATE.error };
}

/**
 * Restaura desde el respaldo lo que falte en esta PC. Nunca pisa archivos que ya existen.
 * withConfig: también trae config.json (claves y ajustes) si aquí no existe.
 */
async function restore(cfg, configFile, { withConfig = true } = {}) {
  const dir = targetDir(cfg);
  if (!dir || !fs.existsSync(dir)) throw new Error("No hay respaldo en " + (dir || "(sin carpeta)"));
  const stats = { files: 0, bytes: 0 };
  let config = false;
  const bc = path.join(dir, "config.json");
  if (withConfig && fs.existsSync(bc) && !fs.existsSync(configFile)) {
    await fsp.copyFile(bc, configFile); config = true;
    // El historial va a la carpeta de salida que tenían los ajustes recuperados.
    try { const rc = JSON.parse(fs.readFileSync(bc, "utf8")); if (rc.outputRoot) cfg = { ...cfg, outputRoot: rc.outputRoot }; } catch {}
  }
  const hist = path.join(dir, "historial");
  for (const name of jobDirs(hist)) {
    for (const f of await fsp.readdir(path.join(hist, name), { withFileTypes: true })) {
      if (!f.isFile() || SKIP.test(f.name)) continue;
      const dst = path.join(cfg.outputRoot, name, f.name);
      if (fs.existsSync(dst)) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(path.join(hist, name, f.name), dst + ".copiando");
      await fsp.rename(dst + ".copiando", dst);
      stats.files++;
    }
  }
  return { restored: stats.files, config };
}

module.exports = { detectDir, targetDir, schedule, status, restore };
