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

// ---------- Links de cualquier sitio ----------
const COOKIE_BROWSERS = ["firefox", "edge", "chrome", "brave", "opera", "vivaldi"];
const LOGIN_RE = /log ?in|sign ?in|cookies|rate.?limit|HTTP Error 40[13]|empty media|requested content is not available|authenticat|confirm you|age.?restrict|inappropriate|registered users|login required/i;
function ytErr(e) {
  const m = String(e?.message || e).match(/ERROR:[^\n]*/g);
  return m ? m[m.length - 1].replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "").trim() : String(e?.message || e).slice(-300);
}
/** Traduce los errores de yt-dlp a algo que se entienda y diga qué hacer. */
function friendlyYtError(e) {
  const m = ytErr(e);
  if (/Unsupported URL/i.test(m)) return "Ese link no es de un video (o ese sitio no está soportado). Abre el video y copia el link del video, no el de la página principal.";
  if (/offline|not currently live|is not live|no longer live|stream.*ended/i.test(m)) return "Ese canal no está en vivo ahora mismo. Pega el link cuando esté en vivo, o el link de una grabación (VOD).";
  if (/private/i.test(m)) return "Ese video es privado: solo lo puede ver quien lo subió.";
  if (/geo|not available in your country|in your country/i.test(m)) return "Ese video no está disponible en tu país.";
  if (LOGIN_RE.test(m)) return "Ese sitio pide iniciar sesión para ver el video. Inicia sesión en ese sitio con Firefox o Edge en esta PC, cierra el navegador y dale a Reintentar.";
  if (/removed|deleted|does not exist|HTTP Error 404|not found|unavailable/i.test(m)) return "Ese video ya no existe o fue borrado.";
  return "No pude leer el link: " + m;
}
/** Lee el link. Si el sitio pide sesión, prueba con la sesión de los navegadores de esta PC. */
async function probeLink(T, url, signal, log) {
  const args = ["-J", "--no-warnings", "--no-playlist", "--playlist-items", "1", url];
  let first;
  try { return { j: JSON.parse((await run(T.ytdlp, args, { signal })).stdout), cookies: "" }; }
  catch (e) { if (signal?.aborted) throw e; first = e; }
  if (!LOGIN_RE.test(ytErr(first))) throw new Error(friendlyYtError(first));
  log("El sitio pide iniciar sesión: pruebo con la sesión de los navegadores de esta PC…");
  for (const b of COOKIE_BROWSERS) {
    try {
      const r = await run(T.ytdlp, ["--cookies-from-browser", b, ...args], { signal });
      log(`  Funcionó con la sesión de ${b}.`);
      return { j: JSON.parse(r.stdout), cookies: b };
    } catch (e) { if (signal?.aborted) throw e; }
  }
  throw new Error(friendlyYtError(first));
}
async function mediaDuration(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", file], { allowFail: true });
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}
/** Graba un EN VIVO durante cfg.liveMinutes minutos (por defecto 30) y lo deja como video normal. */
async function recordLive({ T, src, ck, cacheDir, videoName, h, cfg, emit, log, signal }) {
  const mins = Math.max(1, Math.min(240, +cfg.liveMinutes || 30));
  const secs = mins * 60;
  log(`Es un EN VIVO: grabo ${mins} minutos desde ahora y después saco los clips de esa grabación (cámbialo en Ajustes → Opciones avanzadas).`);
  let j;
  try { j = JSON.parse((await run(T.ytdlp, [...ck, "-J", "--no-warnings", "-f", `b[height<=${h}]/b`, src], { signal })).stdout); }
  catch (e) { if (signal?.aborted) throw e; throw new Error(friendlyYtError(e)); }
  const fmt = j.requested_formats ? j.requested_formats[0] : j;
  const streamUrl = fmt.url || j.url;
  if (!streamUrl) throw new Error("No encontré la señal del en vivo.");
  const hdr = Object.entries(fmt.http_headers || j.http_headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const ts = path.join(cacheDir, `${videoName}.rec.ts`);
  let last = -1;
  const web = /^https?:/i.test(streamUrl)
    ? [...(hdr ? ["-headers", hdr] : []), "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10", "-rw_timeout", "30000000"]
    : [];
  await run(T.ffmpeg, ["-y", "-v", "error", "-stats", ...web, "-i", streamUrl, "-t", String(secs), "-c", "copy", "-f", "mpegts", ts], {
    signal, allowFail: true,
    onLine: (l) => {
      const m = /time=(\d+):(\d+):(\d+)/.exec(l);
      if (!m) return;
      const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
      if (t - last >= 15) { last = t; emit({ type: "progress", id: "download", value: Math.min(1, t / secs) }); }
      if (t % 300 < 1 && t > 0) log(`  Grabando en vivo: ${Math.round(t / 60)} de ${mins} min…`);
    },
  });
  if (signal?.aborted) throw new Error("Cancelado");
  if (!fs.existsSync(ts) || fs.statSync(ts).size < 200000) throw new Error("No pude grabar el en vivo (la señal se cortó o terminó enseguida). Inténtalo otra vez.");
  const out = path.join(cacheDir, `${videoName}.mp4`);
  await run(T.ffmpeg, ["-y", "-v", "error", "-i", ts, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", out], { signal });
  try { fs.unlinkSync(ts); } catch {}
  const dur = await mediaDuration(T.ffmpeg, out);
  log(`  Grabación lista: ${Math.round(dur / 60)} min.`);
  return dur;
}
/** Video sin voz (música, audio sin letra) y corto: se usa completo, con el título del post. */
function wholeVideoClip(info, cfg) {
  const desc = String(info.description || "");
  const clean = (t) => t.replace(/#[\p{L}\d_]+/gu, "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  let title = String(info.title || "");
  if (!title || /^video by /i.test(title) || /^(instagram|tiktok|facebook) video/i.test(title)) title = clean(desc.split("\n")[0]) || info.uploader || "Video";
  const tags = [...new Set((desc.match(/#[\p{L}\d_]+/gu) || []).map((x) => x))].slice(0, 6);
  return {
    id: "c01", start: 0, end: info.duration, title: title.slice(0, 70),
    description: clean(desc).slice(0, 220) || title, hashtags: tags.length ? tags : ["#viral", "#parati"],
    label: "completo", score: 100,
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
    let { j, cookies } = await probeLink(T, url, signal, log);
    let src = url;
    // Perfil, canal o lista: se usa el video más reciente.
    if (j._type === "playlist" || Array.isArray(j.entries)) {
      const e = (j.entries || []).find(Boolean);
      if (!e) throw new Error("Ese link es de un perfil o una lista sin videos. Pega el link de un video.");
      src = e.webpage_url || e.original_url || e.url;
      log(`Ese link es de un perfil o lista: uso el video más reciente — ${e.title || src}`);
      if (e.formats || e.duration) j = e; else ({ j, cookies } = await probeLink(T, src, signal, log));
    }
    const isLive = !!j.is_live || j.live_status === "is_live";
    const stamp = path.basename(jobDir).slice(0, 13);
    info = {
      url, src: j.webpage_url || src, cookies,
      title: isLive ? `${j.title || j.uploader || "En vivo"} (en vivo ${stamp.slice(6, 8)}/${stamp.slice(4, 6)})` : j.title,
      uploader: j.uploader || j.channel || j.uploader_id || "Desconocido",
      handle: j.uploader_id ? "@" + String(j.uploader_id).replace(/^@/, "") : "",
      duration: isLive ? 0 : j.duration || 0, platform: j.extractor_key || "", isLive,
      webpage: j.webpage_url || src, id: (j.id || "") + (isLive ? "-" + stamp : ""), // cada en vivo es una grabación distinta
      description: String(j.description || "").slice(0, 600),
    };
    writeAtomic(path.join(jobDir, "info.json"), JSON.stringify(info, null, 2));
  } else {
    log("Retomando el trabajo donde se quedó…");
  }
  const cacheDir = path.join(path.dirname(jobDir), "_cache", slug(info.id || url));
  fs.mkdirSync(cacheDir, { recursive: true });
  const src = info.src || url;
  const ck = info.cookies ? ["--cookies-from-browser", info.cookies] : [];
  emit({ type: "info", info });
  step("info", "ok", { detail: info.isLive ? `${info.title} — EN VIVO` : `${info.title} — ${hms(info.duration, false)}` });

  // 2) Descarga del video (en el caché; yt-dlp reanuda los .part y salta si ya está completo)
  step("download", "run");
  const h = cfg.maxHeight || 720;
  const videoName = `video_${h}p`;
  let lastDl = -10;
  const existing = findFile(cacheDir, new RegExp(`^${videoName}\\.(mp4|mkv|webm)$`));
  if (info.isLive && !existing) {
    // En vivo: primero se graba (no se puede transcribir lo que todavía no pasó).
    info.duration = await recordLive({ T, src, ck, cacheDir, videoName, h, cfg, emit, log, signal: dlCtrl.signal });
    writeAtomic(path.join(jobDir, "info.json"), JSON.stringify(info, null, 2));
  } else if (info.isLive && !info.duration) {
    info.duration = await mediaDuration(T.ffmpeg, path.join(cacheDir, existing));
  }
  const dl = (existing || info.isLive
    ? Promise.resolve(existing && log("Video ya descargado: no se vuelve a bajar."))
    : run(T.ytdlp, [...ck,
        "-f", `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
        "--merge-output-format", "mp4", "--no-playlist", "--newline", "--continue", "--ffmpeg-location", path.dirname(T.ffmpeg),
        "-o", `${videoName}.%(ext)s`, src,
      ], {
        cwd: cacheDir, signal: dlCtrl.signal,
        onLine: (l) => {
          const m = /\[download\]\s+([\d.]+)%/.exec(l);
          if (m && (+m[1] - lastDl >= 2 || +m[1] >= 100)) { lastDl = +m[1]; emit({ type: "progress", id: "download", value: +m[1] / 100 }); }
        },
      })
  ).then(() => step("download", "ok"), (e) => { throw signal?.aborted ? e : new Error(friendlyYtError(e)); });
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
    if (!info.isLive) await run(T.ytdlp, [...ck,
      "--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", langs,
      "--sub-format", "json3", "--no-playlist", "-o", "subs.%(ext)s", src,
    ], { cwd: jobDir, signal, allowFail: true });
    const sf = info.isLive ? null : subs.findSubsFile(jobDir);
    if (sf) {
      words = subs.parseJson3(sf);
      step("subs", "ok", { detail: `Subtítulos de la plataforma (${words.length} palabras)` });
    } else {
      if (!cfg.deepgramKey && !cfg.groqKey && !T.whisper)
        throw new Error("El video no tiene subtítulos y Whisper no está instalado. Cierra ClipSphere, ejecuta instalar.bat (instala Whisper) y vuelve a intentarlo.");
      log("El video no trae subtítulos: los genero a partir del audio…");
      let audio = info.isLive ? findFile(cacheDir, new RegExp(`^${videoName}\\.mp4$`)) : findFile(cacheDir, /^audio\.(m4a|webm|mp3|opus|mp4|aac|ogg)$/);
      if (!audio) {
        try { await run(T.ytdlp, [...ck, "-f", "ba/b", "--no-playlist", "--continue", "-o", "audio.%(ext)s", src], { cwd: cacheDir, signal }); }
        catch (e) { if (signal?.aborted) throw e; throw new Error(friendlyYtError(e)); }
        audio = findFile(cacheDir, /^audio\.(m4a|webm|mp3|opus|mp4|aac|ogg)$/);
      }
      if (!audio) throw new Error("No pude descargar el audio del video.");
      const audioFile = path.join(cacheDir, audio);
      // Siempre por partes y con caché: si se corta, las partes hechas no se repiten
      words = await transcribeCloud({ cfg, ffmpeg: T.ffmpeg, jobDir, cacheDir, audioFile, log, whisper: T.whisper, signal });
      step("subs", "ok", { detail: `Transcripción del audio (${words.length} palabras)` });
    }
    if (words.length >= 30) writeAtomic(cachedWords, JSON.stringify(words));
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
    let picked = readJson(aiCache), clips;
    if (words.length < 30) {
      // Sin voz (música, audio sin letra): no hay palabras para que la IA elija momentos.
      if (!info.duration) { await dl; const f = findFile(cacheDir, new RegExp(`^${videoName}\\.(mp4|mkv|webm)$`)); if (f) info.duration = await mediaDuration(T.ffmpeg, path.join(cacheDir, f)); }
      const maxWhole = Math.max(180, (+cfg.maxSeconds || 200) * 1.5);
      if (!info.duration || info.duration > maxWhole)
        throw new Error("Este video casi no tiene voz (es música o audio sin letra) y es muy largo para usarlo completo. La IA necesita palabras para elegir los momentos.");
      log("El video casi no tiene voz: lo uso completo en 9:16, con el título del post.");
      clips = [wholeVideoClip(info, cfg)];
      picked = { clips, skipped: [] };
    } else {
      if (picked) log("Momentos elegidos anteriormente: no se vuelve a llamar a la IA.");
      else {
        picked = cfg.fakeLlmFile ? readJson(cfg.fakeLlmFile) : await pickMoments({ cfg, info, lines, log });
        writeAtomic(aiCache, JSON.stringify(picked));
      }
      clips = normalizeClips(picked.clips || [], words, cfg, info.duration);
    }
    if (!clips.length) throw new Error("La IA no encontró clips válidos con esas duraciones. Prueba bajar la duración mínima.");
    step("ai", "ok", { detail: `${clips.length} momentos elegidos` });
    plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      source: { platform: info.platform.toLowerCase(), url: info.webpage, title: info.title, creator: info.uploader, creatorHandle: info.handle, mode: info.isLive ? "live" : "vod" },
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

module.exports = { runJob, tools, normalizeClips, newJobDir, findResumableDir, friendlyYtError, wholeVideoClip };
