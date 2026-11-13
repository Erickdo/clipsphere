// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// Transcripción con tiempos por palabra.
// 1) Subtítulos de la plataforma (json3 de YouTube): instantáneo y gratis.
// 2) Si no hay, Whisper local (whisper-ctranslate2) sobre el audio.
const fs = require("node:fs");
const path = require("node:path");

/** json3 de YouTube → [{t, w}] (t en segundos). */
function parseJson3(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const words = [];
  for (const e of j.events || []) {
    if (!e.segs) continue;
    for (const s of e.segs) {
      const w = (s.utf8 || "").replace(/\s+/g, " ").trim();
      if (!w) continue;
      for (const piece of w.split(" ")) {
        words.push({ t: +(((e.tStartMs || 0) + (s.tOffsetMs || 0)) / 1000).toFixed(2), w: piece });
      }
    }
  }
  words.sort((a, b) => a.t - b.t);
  return dedupeRolling(words);
}

/** Los subtítulos manuales a veces repiten texto entre eventos: quita duplicados consecutivos casi simultáneos. */
function dedupeRolling(words) {
  const out = [];
  for (const x of words) {
    const prev = out[out.length - 1];
    if (prev && prev.w === x.w && Math.abs(prev.t - x.t) < 0.3) continue;
    out.push(x);
  }
  return out;
}

/** Salida JSON de whisper-ctranslate2 con --word_timestamps True → [{t, w}]. */
function parseWhisperJson(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const words = [];
  for (const seg of j.segments || []) {
    if (seg.words && seg.words.length) {
      for (const w of seg.words) words.push({ t: +(+w.start).toFixed(2), w: String(w.word).trim() });
    } else {
      const parts = String(seg.text).trim().split(/\s+/);
      const step = (seg.end - seg.start) / Math.max(1, parts.length);
      parts.forEach((p, i) => words.push({ t: +(seg.start + i * step).toFixed(2), w: p }));
    }
  }
  return words.filter((x) => x.w);
}

/** Agrupa palabras en líneas de ~10 s con marca [mm:ss] para el modelo. */
function toTimedLines(words, every = 10) {
  const lines = [];
  let cur = [], st = null;
  for (const x of words) {
    if (st === null) st = x.t;
    cur.push(x.w);
    if (x.t - st >= every) { lines.push({ t: st, text: cur.join(" ") }); cur = []; st = null; }
  }
  if (cur.length) lines.push({ t: st, text: cur.join(" ") });
  return lines;
}

function fmtLine(l) {
  const m = Math.floor(l.t / 60), s = Math.floor(l.t % 60);
  return `[${String(m).padStart(3, "0")}:${String(s).padStart(2, "0")} | ${l.t.toFixed(1)}s] ${l.text}`;
}

/** Busca el archivo de subtítulos que dejó yt-dlp (prefiere el idioma original). */
function findSubsFile(dir, base = "subs") {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(base + ".") && f.endsWith(".json3"));
  files.sort((a, b) => (/-orig/.test(b) ? 1 : 0) - (/-orig/.test(a) ? 1 : 0));
  return files.length ? path.join(dir, files[0]) : null;
}

module.exports = { parseJson3, parseWhisperJson, toTimedLines, fmtLine, findSubsFile };
