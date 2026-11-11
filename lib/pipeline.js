// ClipSphere © 2026 Erick Ramírez. Todos los derechos reservados. Ver LICENCIA.txt
// Flujo completo: link → info → subtítulos → IA → descarga → render → publicar.txt
const fs = require("node:fs");
const path = require("node:path");
const { findBin, run, hms, slug, writeAtomic } = require("./util");
const subs = require("./subs");
const { pickMoments } = require("./llm");
const render = require("./render");
const { transcribeCloud, transcribeLocal } = require("./transcribe");

function tools() {
  return {
    ytdlp: findBin("yt-dlp"),
    ffmpeg: findBin("ffmpeg"),
    whisper: findBin("whisper-ctranslate2"),
  };
}

/** Ajusta los cortes a límites de palabra, aplica duraciones y quita duplicados. */
function normalizeClips(raw, words, cfg, durationSec) {
  const times = words.map((w) => w.t);
  const nearestStart = (t) => {
    let best = t, d = Infinity;
    for (const x of times) { if (Math.abs(x - t) < d) { d = Math.abs(x - t); best = x; } if (x > t + 3) break; }
    return Math.max(0, best - 0.15);
  };
  const endAt = (t) => {
    // corta justo antes de la siguiente palabra después de t
    const nx = times.find((x) => x > t + 0.2);
    return nx ? Math.min(nx - 0.05, t + 1.5) : Math.min(t + 1, durationSec || t + 1);
  };
  let clips = raw
    .map((c) => ({ ...c, start: +c.start, end: +c.end, score: +(c.score || 0) }))
    .filter((c) => isFinite(c.start) && isFinite(c.end) && c.end > c.start)
    .map((c) => ({ ...c, start: nearestStart(c.start), end: endAt(c.end) }))
    .filter((c) => {
      const d = c.end - c.start;
      return d >= cfg.minSeconds * 0.85 && d <= cfg.maxSeconds * 1.15;
    });
  // solo los momentos con buena puntuación (si ninguno llega, se quedan los 3 mejores)
  clips.sort((a, b) => b.score - a.score);
  const minScore = cfg.minScore ?? 60;
  const good = clips.filter((c) => !c.score || c.score >= minScore);
  clips = good.length ? good : clips.slice(0, 3);
  const limit = cfg.clipLimit > 0 ? cfg.clipLimit : Infinity; // sin límite por defecto
  // quitar solapados (>50%), dejando el de mayor score
  const kept = [];
  for (const c of clips) {
    const dup = kept.some((k) => {
      const inter = Math.max(0, Math.min(k.end, c.end) - Math.max(k.start, c.start));
      return inter / Math.min(k.end - k.start, c.end - c.start) > 0.5;
    });
    if (!dup) kept.push(c);
    if (kept.length >= limit) break;
  }
  kept.sort((a, b) => a.start - b.start);
  return kept.map((c, i) => ({ ...c, id: `c${String(i + 1).padStart(2, "0")}` }));
}

/**
 * Ejecuta un trabajo. emit(evento) informa al navegador: {type:'log'|'step'|'progress'|'clip'|'done'|'error', ...}
 */
async function runJob(args) {
  // Controlador propio de la descarga: si algo falla, se detiene la descarga en curso.
  const dlCtrl = new AbortController();
  args.signal?.addEventListener("abort", () => dlCtrl.abort());
  try {
    return await runJobInner({ ...args, dlCtrl });
  } catch (e) {
    dlCtrl.abort();
    throw e;
  }
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function findFile(dir, re) { try { return fs.readdirSync(dir).find((f) => re.test(f)); } catch { return null; } }

/**
 * Cada paso guarda su resultado; al repetir o reintentar el trabajo, lo que ya está hecho se salta:
 *  - jobDir/info.json, plan.json (con estado por clip), cXX.mp4
 *  - outputRoot/_cache/<id del video>/: video.mp4 (la descarga se reanuda si quedó a medias),
 *    audio, words.json (transcripción), ai_*.json (momentos elegidos)
 */
async function runJobInner({ url, cfg, jobDir, emit, signal, dlCtrl }) {
  const T = tools();
  if (!T.ytdlp) throw new Error("No encuentro yt-dlp. Ejecuta instalar.bat.");
  if (!T.ffmpeg) throw new Error("No encuentro ffmpeg. Ejecuta instalar.bat.");
  const log = (msg) => emit({ type: "log", msg });
  const step = (id, status, extra = {}) => emit({ type: "step", id, status, ...extra });
  fs.mkdirSync(jobDir, { recursive: true });
  try { fs.unlinkSync(path.join(jobDir, "done.json")); } catch {}

  // 1) Información del video
  step("info", "run");
  let info = readJson(path.join(jobDir, "info.json"));
  if (!info) {
    const { stdout } = await run(T.ytdlp, ["-J", "--no-playlist", "--no-warnings", url], { signal });
    const j = JSON.parse(stdout);
    info = {
      url, title: j.title, uploader: j.uploader || j.channel || "Desconocido",
      handle: j.uploader_id ? "@" + String(j.uploader_id).replace(/^@/, "") : "",
      duration: j.duration || 0, platform: j.extractor_key || "", isLive: !!j.is_live,
      webpage: j.webpage_url || url, id: j.id || "",
    };
    if (info.isLive) throw new Error("Es una transmisión en vivo. El modo en vivo todavía no está disponible; usa la grabación cuando termine.");
    writeAtomic(path.join(jobDir, "info.json"), JSON.stringify(info, null, 2));
  } else {
    log("Retomando el trabajo donde se quedó…");
  }
  const cacheDir = path.join(path.dirname(jobDir), "_cache", slug(info.id || url));
  fs.mkdirSync(cacheDir, { recursive: true });
  emit({ type: "info", info });
  step("info", "ok", { detail: `${info.title} — ${hms(info.duration, false)}` });

  // 2) Descarga del video (en el caché; yt-dlp reanuda los .part y salta si ya está completo)
  step("download", "run");
  const h = cfg.maxHeight || 720;
  const videoName = `video_${h}p`;
  let lastDl = -10;
  const existing = findFile(cacheDir, new RegExp(`^${videoName}\\.(mp4|mkv|webm)$`));
  const dl = (existing
    ? Promise.resolve(log("Video ya descargado: no se vuelve a bajar."))
    : run(T.ytdlp, [
        "-f", `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
        "--merge-output-format", "mp4", "--no-playlist", "--newline", "--continue", "--ffmpeg-location", path.dirname(T.ffmpeg),
        "-o", `${videoName}.%(ext)s`, url,
      ], {
        cwd: cacheDir, signal: dlCtrl.signal,
        onLine: (l) => {
          const m = /\[download\]\s+([\d.]+)%/.exec(l);
          if (m && (+m[1] - lastDl >= 2 || +m[1] >= 100)) { lastDl = +m[1]; emit({ type: "progress", id: "download", value: +m[1] / 100 }); }
        },
      })
  ).then(() => step("download", "ok"));
  dl.catch(() => {});

  // 3) Transcripción
  step("subs", "run");
  let words = [];
  const cachedWords = path.join(cacheDir, "words.json");
  if (fs.existsSync(cachedWords)) {
    words = readJson(cachedWords) || [];
    step("subs", "ok", { detail: `Transcripción guardada (${words.length} palabras)` });
  }
  if (!words.length) {
    const langs = cfg.language === "en" ? "en.*,en" : `${cfg.language || "es"}.*,${cfg.language || "es"}`;
    await run(T.ytdlp, [
      "--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", langs,
      "--sub-format", "json3", "--no-playlist", "-o", "subs.%(ext)s", url,
    ], { cwd: jobDir, signal, allowFail: true });
    const sf = subs.findSubsFile(jobDir);
    if (sf) {
      words = subs.parseJson3(sf);
      step("subs", "ok", { detail: `Subtítulos de la plataforma (${words.length} palabras)` });
    } else {
      if (!cfg.deepgramKey && !cfg.groqKey && !T.whisper)
        throw new Error("El video no tiene subtítulos y Whisper no está instalado. Cierra ClipSphere, ejecuta instalar.bat (instala Whisper) y vuelve a intentarlo.");
      log("El video no trae subtítulos: los genero a partir del audio…");
      let audio = findFile(cacheDir, /^audio\.(m4a|webm|mp3|opus|mp4|aac|ogg)$/);
      if (!audio) {
        await run(T.ytdlp, ["-f", "ba/b", "--no-playlist", "--continue", "-o", "audio.%(ext)s", url], { cwd: cacheDir, signal });
        audio = findFile(cacheDir, /^audio\.(m4a|webm|mp3|opus|mp4|aac|ogg)$/);
      }
      if (!audio) throw new Error("No pude descargar el audio del video.");
      const audioFile = path.join(cacheDir, audio);
      // Siempre por partes y con caché: si se corta, las partes hechas no se repiten
      words = await transcribeCloud({ cfg, ffmpeg: T.ffmpeg, jobDir, cacheDir, audioFile, log, whisper: T.whisper, signal });
      step("subs", "ok", { detail: `Transcripción del audio (${words.length} palabras)` });
    }
    if (words.length < 30) throw new Error("La transcripción salió vacía; no hay suficiente texto para elegir momentos.");
    writeAtomic(cachedWords, JSON.stringify(words));
  }
  const lines = subs.toTimedLines(words);

  // 4) IA elige los momentos (si este trabajo ya tiene plan, se reutiliza)
  step("ai", "run");
  const attribution = `Fuente: ${info.uploader}${cfg.attributionPlatform !== false ? ` (${info.platform || "web"})` : ""}`;
  let plan = readJson(path.join(jobDir, "plan.json"));
  if (plan?.clips?.length) {
    step("ai", "ok", { detail: `${plan.clips.length} momentos (guardados)` });
  } else {
    const aiCache = path.join(cacheDir, `ai_${cfg.provider || "claude"}_${cfg.minSeconds}-${cfg.maxSeconds}.json`);
    let picked = readJson(aiCache);
    if (picked) log("Momentos elegidos anteriormente: no se vuelve a llamar a la IA.");
    else {
      picked = cfg.fakeLlmFile ? readJson(cfg.fakeLlmFile) : await pickMoments({ cfg, info, lines, log });
      writeAtomic(aiCache, JSON.stringify(picked));
    }
    const clips = normalizeClips(picked.clips || [], words, cfg, info.duration);
    if (!clips.length) throw new Error("La IA no encontró clips válidos con esas duraciones. Prueba bajar la duración mínima.");
    step("ai", "ok", { detail: `${clips.length} momentos elegidos` });
    plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      source: { platform: info.platform.toLowerCase(), url: info.webpage, title: info.title, creator: info.uploader, creatorHandle: info.handle, mode: "vod" },
      clips: clips.map((c) => {
        const series = c.seriesId ? { seriesId: String(c.seriesId), part: c.part || 1, totalParts: c.totalParts || 1 } : null;
        return {
          id: c.id, start: +c.start.toFixed(2), end: +c.end.toFixed(2),
          startTimestamp: hms(c.start), endTimestamp: hms(c.end), series,
          hook: c.hook || "", title: String(c.title || "").slice(0, 80),
          description: `${c.description || ""}\nFuente: ${info.uploader}${info.handle ? " " + info.handle : ""} — ${info.webpage}`,
          hashtags: (c.hashtags || []).map((x) => (x.startsWith("#") ? x : "#" + x).replace(/\s+/g, "")).slice(0, 8),
          label: c.label || "reaccion", score: { total: c.score || 0 },
          attribution: `Fuente: ${info.uploader} — ${info.webpage}`,
          rights: { risk: "medio", note: "Pide permiso al creador o añade comentario propio antes de publicar." },
          file: `${c.id}.mp4`, cover: `${c.id}.jpg`, status: "pending",
        };
      }),
      skipped: picked.skipped || [],
    };
  }
  const savePlan = () => writeAtomic(path.join(jobDir, "plan.json"), JSON.stringify(plan, null, 2));
  savePlan();
  emit({ type: "plan", plan });

  // 5) Esperar descarga
  await dl;
  const sourceName = findFile(cacheDir, new RegExp(`^${videoName}\\.(mp4|mkv|webm)$`));
  if (!sourceName) throw new Error("No se encontró el video descargado.");
  const source = path.join(cacheDir, sourceName);

  // 6) Render (los clips ya terminados se saltan)
  step("render", "run");
  render.prepareFont(jobDir, cfg.fontFile);
  for (const [i, c] of plan.clips.entries()) {
    if (signal?.aborted) throw new Error("Cancelado");
    // El render escribe a .tmp.mp4 y solo al terminar lo renombra: si existe cXX.mp4, está completo.
    if (fs.existsSync(path.join(jobDir, c.file))) {
      if (!fs.existsSync(path.join(jobDir, c.cover))) await render.thumbnail({ ffmpeg: T.ffmpeg, jobDir, video: c.file, outName: c.cover });
      if (c.status !== "ok") { c.status = "ok"; savePlan(); }
      emit({ type: "clip", clip: c });
      continue;
    }
    const assName = `${c.id}.ass`;
    writeAtomic(path.join(jobDir, assName), render.buildAss({
      words, start: c.start, end: c.end, title: c.title, attribution, font: cfg.fontName || "Arial Black",
    }));
    log(`Renderizando ${c.id}: ${c.title}`);
    const tmpName = `${c.id}.tmp.mp4`;
    await render.renderClip({
      ffmpeg: T.ffmpeg, jobDir, source, clip: c, assName, outName: tmpName, encoder: cfg.encoder, signal,
      onProgress: (p) => emit({ type: "progress", id: "render", value: (i + p) / plan.clips.length, clip: c.id }),
    });
    fs.renameSync(path.join(jobDir, tmpName), path.join(jobDir, c.file)); // así un clip a medias nunca cuenta como listo
    await render.thumbnail({ ffmpeg: T.ffmpeg, jobDir, video: c.file, outName: c.cover });
    c.status = "ok";
    savePlan();
    emit({ type: "clip", clip: c });
  }
  step("render", "ok");

  // 7) Hoja para publicar
  const L = [`CLIPSPHERE — ${info.title}`, `Video original: ${info.webpage}`, ""];
  for (const c of plan.clips) {
    L.push("=".repeat(50), `${c.file}  (${c.startTimestamp.slice(0, 8)} → ${c.endTimestamp.slice(0, 8)})  [${c.label}]`, "",
      c.title, "", c.description, "", c.hashtags.join(" "), "");
  }
  L.push("=".repeat(50), "La atribución no evita reclamos de copyright: lo más seguro es pedir permiso al creador.");
  writeAtomic(path.join(jobDir, "publicar.txt"), L.join("\r\n"));

  // Limpieza: el video original solo se borra cuando TODO salió bien
  if (!cfg.keepSource) {
    for (const f of fs.readdirSync(cacheDir)) if (/^(video_|audio\.)/.test(f)) try { fs.unlinkSync(path.join(cacheDir, f)); } catch {}
  }
  for (const f of fs.readdirSync(jobDir)) {
    if (/\.(ass|part|ytdl)$/.test(f) || /\.tmp\.mp4$/.test(f) || /^subs\./.test(f)) try { fs.unlinkSync(path.join(jobDir, f)); } catch {}
  }
  writeAtomic(path.join(jobDir, "done.json"), JSON.stringify({ at: new Date().toISOString() }));
  emit({ type: "done", plan });
  return plan;
}

function videoIdFromUrl(url) {
  return slug((url.match(/[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})|\/(?:live|shorts)\/([\w-]{6,})|\/([\w-]{6,})\/?(?:\?|$)/) || []).slice(1).find(Boolean) || "video");
}

/** Si ya hay un trabajo SIN terminar para el mismo video, se retoma esa carpeta en vez de empezar otra. */
function findResumableDir(root, url) {
  const id = videoIdFromUrl(url);
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => d.endsWith("-" + id)).sort().reverse(); } catch {}
  for (const d of dirs) if (!fs.existsSync(path.join(root, d, "done.json"))) return path.join(root, d);
  return null;
}

function newJobDir(root, url) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return path.join(root, `${stamp}-${videoIdFromUrl(url)}`);
}

module.exports = { runJob, tools, normalizeClips, newJobDir, findResumableDir };
