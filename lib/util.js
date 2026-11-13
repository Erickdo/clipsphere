// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// Utilidades: localizar programas y ejecutarlos con log en vivo.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWin = process.platform === "win32";

/** Busca un ejecutable en el PATH y en las carpetas típicas de winget. */
function findBin(name) {
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  if (isWin && process.env.LOCALAPPDATA) {
    dirs.unshift(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
    // ffmpeg de winget (Gyan) a veces queda solo dentro de Packages
    const pk = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    try {
      for (const d of fs.readdirSync(pk)) {
        if (/ffmpeg/i.test(d)) {
          for (const sub of fs.readdirSync(path.join(pk, d))) dirs.push(path.join(pk, d, sub, "bin"));
        }
      }
    } catch {}
  }
  // Scripts de Python (donde pip deja whisper-ctranslate2)
  if (isWin) {
    for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python"), process.env.APPDATA && path.join(process.env.APPDATA, "Python")]) {
      if (!base) continue;
      try { for (const d of fs.readdirSync(base)) dirs.push(path.join(base, d, "Scripts")); } catch {}
    }
  }
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

/**
 * Ejecuta un programa. onLine recibe cada línea de salida (para mostrar progreso).
 * Devuelve { code, stdout, stderr }. Lanza error si code != 0 y !allowFail.
 */
function run(bin, args, { cwd, onLine, allowFail = false, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    let out = "", err = "", buf = "";
    const feed = (chunk, isErr) => {
      const s = chunk.toString("utf8");
      if (isErr) err += s; else out += s;
      if (onLine) {
        buf += s;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        for (const l of parts) if (l.trim()) onLine(l);
      }
    };
    p.stdout.on("data", (c) => feed(c, false));
    p.stderr.on("data", (c) => feed(c, true));
    if (signal) signal.addEventListener("abort", () => p.kill());
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0 && !allowFail) {
        const e = new Error(`${path.basename(bin)} terminó con código ${code}: ${err.slice(-1500)}`);
        e.code = code;
        return reject(e);
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function hms(sec, ms = true) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = ms ? s.toFixed(3).padStart(6, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
}

function slug(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50).toLowerCase() || "video";
}

/**
 * Escribe un archivo sin riesgo de dejarlo a medias (corte de luz, cierre brusco):
 * primero a un temporal y luego se renombra. Si Windows bloquea el renombre
 * (antivirus, OneDrive), reintenta y, en último caso, escribe directo.
 */
function writeAtomic(file, data) {
  const tmp = file + ".guardando";
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (i === 4) break; const t = Date.now() + 60 * (i + 1); while (Date.now() < t) {} }
  }
  fs.writeFileSync(file, data);
  try { fs.unlinkSync(tmp); } catch {}
}

module.exports = { findBin, run, hms, slug, isWin, writeAtomic };
