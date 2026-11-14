/**
 * Detector de momentos ruidosos (gritos, peleas, discusiones fuertes, público alborotado).
 * En una pelea casi no se entienden palabras: la transcripción sola no la ve, el volumen sí.
 */
const { spawn } = require("child_process");

const SR = 8000; // basta para medir volumen

/** Volumen (dB) por segundo de un audio. */
function loudnessPerSecond(ffmpeg, file, signal) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { windowsHide: true });
    const out = [];
    let cur = 0, n = 0, sum = 0;
    const kill = () => { try { p.kill(); } catch {} };
    signal?.addEventListener("abort", kill);
    p.stdout.on("data", (buf) => {
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        sum += v * v; n++;
        if (n === SR) { out.push(10 * Math.log10(sum / n + 1e-10)); sum = 0; n = 0; cur++; }
      }
    });
    p.stderr.on("data", () => {});
    p.on("close", () => { signal?.removeEventListener("abort", kill); if (n > SR / 2) out.push(10 * Math.log10(sum / n + 1e-10)); resolve(out); });
    p.on("error", () => resolve([]));
  });
}

/**
 * Tramos claramente más fuertes que lo normal de ese audio.
 * Devuelve [{ t0, t1, db }] en segundos (db = cuánto más fuerte que lo normal).
 */
function findPeaks(series, offset = 0) {
  const vals = series.filter((x) => x > -70).sort((a, b) => a - b);
  if (vals.length < 20) return [];
  const median = vals[Math.floor(vals.length / 2)];
  const p90 = vals[Math.floor(vals.length * 0.9)];
  const thr = Math.max(median + 7, p90); // fuerte de verdad, no un poco más alto
  const raw = [];
  let s = -1;
  for (let i = 0; i <= series.length; i++) {
    const hot = i < series.length && series[i] >= thr;
    if (hot && s < 0) s = i;
    if (!hot && s >= 0) { raw.push([s, i]); s = -1; }
  }
  // une tramos separados por menos de 3 s y descarta los de menos de 2 s
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= 3) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged
    .filter(([a, b]) => b - a >= 2)
    .map(([a, b]) => ({ t0: a + offset, t1: b + offset, db: Math.round(Math.max(...series.slice(a, b)) - median) }))
    .sort((x, y) => y.db - x.db).slice(0, 25)
    .sort((x, y) => x.t0 - y.t0);
}

/** Marca para meter en la transcripción que lee la IA. */
function peakLines(peaks) {
  return peaks.map((p) => ({ t: p.t0, text: `[🔊 VOLUMEN MUY ALTO ${Math.round(p.t1 - p.t0)} s (+${p.db} dB): gritos, pelea, discusión fuerte o público alborotado]` }));
}

/** Mezcla las marcas en las líneas de la transcripción, en orden de tiempo. */
function withPeaks(lines, peaks) {
  if (!peaks?.length) return lines;
  return [...lines, ...peakLines(peaks)].sort((a, b) => a.t - b.t);
}

module.exports = { loudnessPerSecond, findPeaks, withPeaks };
