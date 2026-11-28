// ClipSphere — © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
/**
 * Registro local de seguridad (seguridad.log, junto a config.json). Una línea JSON por evento:
 *   { t, tipo, ip, metodo, ruta, detalle }
 * NUNCA guarda códigos de acceso, claves, cookies ni tokens: la ruta va SIN parámetros (?c=… no se escribe)
 * y el detalle se filtra. Con límite de tamaño y rotación (seguridad.log → .1 → .2), y sin inundarse:
 * el mismo tipo desde la misma IP se escribe como mucho una vez cada 10 s (con cuántos se repitieron).
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 512 * 1024, KEEP = 2, QUIET_MS = 10000;
const SENSITIVE = /(c|code|codigo|token|key|clave|cookie|cs_s|cs_code|password|secret)=([^&\s;]+)/gi;

function createSecLog(file, { now = () => Date.now() } = {}) {
  const recent = new Map(); // tipo|ip → {at, skipped}
  function rotate() {
    try {
      if (fs.statSync(file).size < MAX_BYTES) return;
      for (let i = KEEP; i >= 1; i--) {
        const src = i === 1 ? file : `${file}.${i - 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i}`);
      }
    } catch {}
  }
  /** Registra un evento de seguridad. `detalle` se limpia de cualquier cosa que parezca un secreto. */
  function log(tipo, { ip = "", metodo = "", ruta = "", detalle = "" } = {}) {
    ip = String(ip).replace(/^::ffff:/, "");
    const key = `${tipo}|${ip}`;
    const r = recent.get(key);
    const t = now();
    if (r && t - r.at < QUIET_MS) { r.skipped++; return; }
    const line = {
      t: new Date(t).toISOString(), tipo, ip,
      metodo: String(metodo).slice(0, 10), ruta: String(ruta).split("?")[0].slice(0, 200),
      detalle: String(detalle).replace(SENSITIVE, "$1=•••").replace(/\b\d{6}\b/g, "••••••").slice(0, 300),
      ...(r && r.skipped ? { repetidos: r.skipped } : {}),
    };
    recent.set(key, { at: t, skipped: 0 });
    if (recent.size > 2000) recent.delete(recent.keys().next().value);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotate();
      fs.appendFileSync(file, JSON.stringify(line) + "\n");
    } catch {}
  }
  return { log, file };
}

module.exports = { createSecLog, MAX_BYTES };
