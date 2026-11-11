// ClipSphere © 2026 Erick Ramírez. Todos los derechos reservados. Ver LICENCIA.txt
// Transcripción cuando el video NO trae subtítulos.
// 1) Groq Whisper (nube, gratis, muy rápido) si hay clave de Groq.
// 2) Whisper local (whisper-ctranslate2) si está instalado.
const fs = require("node:fs");
const path = require("node:path");
const { run } = require("./util");
const { parseWhisperJson } = require("./subs");

/** Saca el audio del archivo en trozos MP3 mono de 20 min (≈7 MB cada uno, bajo el límite de 25 MB de Groq). */
async function splitAudio(ffmpeg, jobDir, audioFile, chunkSec = 1200) {
  const dir = path.join(jobDir, "audio_chunks");
  fs.mkdirSync(dir, { recursive: true });
  await run(ffmpeg, ["-y", "-v", "error", "-i", audioFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
    "-f", "segment", "-segment_time", String(chunkSec), "-reset_timestamps", "1", path.join(dir, "a_%03d.mp3")], { cwd: jobDir });
  return fs.readdirSync(dir).filter((f) => f.endsWith(".mp3")).sort().map((f, i) => ({ file: path.join(dir, f), offset: i * chunkSec }));
}

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); rej(new Error("Cancelado")); });
  });
}

async function groqChunk(cfg, file, language, signal) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(file)], { type: "audio/mpeg" }), path.basename(file));
    fd.append("model", cfg.groqWhisperModel || "whisper-large-v3-turbo");
    fd.append("language", language || "es");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    fd.append("timestamp_granularities[]", "segment");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${cfg.groqKey}` }, body: fd, signal,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const msg = JSON.stringify(j);
      if (/per day|RPD|ASD/i.test(msg)) throw Object.assign(new Error("Se acabó el límite gratis diario de Groq para transcribir."), { daily: true });
      // Groq dice cuánto esperar (retry-after o "try again in 12m30s")
      let wait = +(res.headers.get("retry-after") || 0);
      const m = msg.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
      if (m) wait = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.ceil(+m[3] || 0);
      wait = Math.max(15, Math.min(wait || 60, 20 * 60)) + 3;
      if (Date.now() - started > 75 * 60 * 1000) throw new Error("Groq lleva más de una hora limitando; intenta más tarde.");
      cfg.log?.(`  Límite gratis de Groq por hora alcanzado. Espero ${Math.round(wait / 60) || 1} min y sigo solo (no cierres nada)…`);
      await sleep(wait * 1000, signal);
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${res.status}: ${j?.error?.message || "error"}`);
    return j;
  }
}

/** Deepgram (nova-3): sin límite por hora; $200 de crédito gratis al registrarse. */
async function deepgramChunk(cfg, file, language, signal) {
  const q = new URLSearchParams({ model: cfg.deepgramModel || "nova-3", language: language || "es", smart_format: "true", punctuate: "true" });
  // Las claves de Deepgram se envían como "Token <clave>"; los tokens temporales como "Bearer". Se prueban ambos.
  const schemes = cfg._dgScheme ? [cfg._dgScheme] : ["Token", "Bearer"];
  let lastAuth = "";
  for (const scheme of schemes) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
        method: "POST", headers: { Authorization: `${scheme} ${cfg.deepgramKey}`, "Content-Type": "audio/mpeg" },
        body: fs.readFileSync(file), signal,
      });
      const j = await res.json().catch(() => ({}));
      const msg = j?.err_msg || j?.message || j?.error || "";
      if (res.status === 429 || res.status >= 500) {
        cfg.log?.(`  Deepgram ocupado, reintento en ${10 * (attempt + 1)} s…`);
        await sleep(10000 * (attempt + 1), signal);
        continue;
      }
      if (res.status === 401 || res.status === 403) { lastAuth = `${res.status} ${msg}`; break; }
      if (res.status === 402) throw Object.assign(new Error("Se acabó el crédito de Deepgram."), { fatal: true });
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${msg || "error"}`);
      cfg._dgScheme = scheme;
      const words = j.results?.channels?.[0]?.alternatives?.[0]?.words || [];
      return { words: words.map((w) => ({ word: w.punctuated_word || w.word, start: w.start })) };
    }
  }
  if (lastAuth) throw Object.assign(new Error(`Deepgram no acepta la clave (${lastAuth}). Revisa que copiaste la clave secreta completa en ⚙️ Ajustes.`), { fatal: true });
  throw new Error("Deepgram sigue ocupado; prueba en un minuto.");
}

function chunkWords(j, offset) {
  const words = [];
  if (j.words?.length) {
    for (const w of j.words) words.push({ t: +(offset + w.start).toFixed(2), w: String(w.word).trim() });
  } else {
    for (const s of j.segments || []) {
      const parts = String(s.text).trim().split(/\s+/);
      const step = (s.end - s.start) / Math.max(1, parts.length);
      parts.forEach((p, k) => words.push({ t: +(offset + s.start + k * step).toFixed(2), w: p }));
    }
  }
  return words;
}

/**
 * Transcribe por partes con Groq. Cada parte se guarda en cacheDir: si el trabajo se corta o
 * lo repites con el mismo link, las partes hechas no se vuelven a pedir.
 * Si se acaba el límite diario y hay Whisper local, las partes que faltan se hacen en tu PC.
 */
/**
 * Transcribe por partes en la nube (Deepgram si hay clave; si no, Groq). Cada parte se guarda en
 * cacheDir: si el trabajo se corta, las partes hechas no se repiten, aunque cambies de servicio.
 * Si el servicio falla y hay Whisper local, la parte se hace en tu PC.
 */
async function transcribeCloud({ cfg, ffmpeg, jobDir, cacheDir, audioFile, log, whisper, signal }) {
  // Servicio para las partes que falten: Deepgram > Groq > Whisper en tu PC
  let svc = cfg.deepgramKey ? "deepgram" : cfg.groqKey ? "groq" : whisper ? "local" : null;
  if (!svc) throw new Error("No hay con qué transcribir: pon la clave de Deepgram o instala Whisper.");
  const label = { deepgram: "Deepgram", groq: "Groq Whisper", local: "Whisper en tu PC" };
  const chunks = await splitAudio(ffmpeg, jobDir, audioFile);
  fs.mkdirSync(cacheDir, { recursive: true });
  const ctx = { ...cfg, log };
  const words = [];
  for (const [i, c] of chunks.entries()) {
    const n = String(i).padStart(3, "0");
    const cf = path.join(cacheDir, `part_${n}.json`);
    let j = null;
    for (const f of [cf, path.join(cacheDir, `groq_${n}.json`)]) {
      try { j = JSON.parse(fs.readFileSync(f, "utf8")); log(`  parte ${i + 1}/${chunks.length} (ya estaba hecha)`); break; } catch {}
    }
    while (!j) {
      if (signal?.aborted) throw new Error("Cancelado");
      log(`  ${label[svc]}: parte ${i + 1}/${chunks.length}…`);
      try {
        if (svc === "deepgram") j = await deepgramChunk(ctx, c.file, cfg.language, signal);
        else if (svc === "groq") j = await groqChunk(ctx, c.file, cfg.language, signal);
        else {
          const local = await transcribeLocal({ cfg, whisper, audioFile: c.file, log, signal });
          j = { words: local.map((x) => ({ word: x.w, start: x.t })) };
        }
      } catch (e) {
        if (e.message === "Cancelado" || signal?.aborted) throw e;
        // Pasar al siguiente servicio para esta parte y las que siguen
        const next = svc === "deepgram" && cfg.groqKey ? "groq" : svc !== "local" && whisper ? "local" : null;
        if (!next) throw e;
        log(`  ${e.message} → sigo con ${label[next]}.`);
        svc = next;
      }
    }
    fs.writeFileSync(cf, JSON.stringify(j));
    words.push(...chunkWords(j, c.offset));
  }
  fs.rmSync(path.join(jobDir, "audio_chunks"), { recursive: true, force: true });
  return words.filter((x) => x.w);
}

async function transcribeLocal({ cfg, whisper, audioFile, log, signal }) {
  const dir = path.dirname(audioFile);
  const base = path.parse(audioFile).name;
  await run(whisper, [path.basename(audioFile), "--language", cfg.language || "es", "--model", cfg.whisperModel || "small",
    "--word_timestamps", "True", "--vad_filter", "True", "--output_format", "json", "--output_dir", "."], {
    cwd: dir, signal, onLine: (l) => /\[\d/.test(l) && log("    " + l.slice(0, 110)),
  });
  return parseWhisperJson(path.join(dir, base + ".json"));
}

module.exports = { transcribeCloud, transcribeGroq: transcribeCloud, transcribeLocal };
