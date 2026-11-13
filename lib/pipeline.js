// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
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
  if (/format is not available/i.test(m)) return "No pude leer la señal de ese video/directo (el sitio cambió algo). ClipSphere actualiza su descargador solo: dale a Reintentar. Si vuelve a pasar, avísanos en Soporte ClipSphere.";
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
/** Actualiza yt-dlp (una vez cada 6 h como mucho). YouTube cambia y una versión vieja deja de leer los directos. */
let ytUpdatedAt = 0;
async function updateYtdlp(T, log) {
  if (Date.now() - ytUpdatedAt < 6 * 3600e3) return;
  ytUpdatedAt = Date.now();
  log?.("  Actualizando el descargador de videos (yt-dlp)…");
  const r = await run(T.ytdlp, ["-U"], { allowFail: true }).catch(() => null);
  const out = String(r?.stdout || "") + String(r?.stderr || "");
  if (/Updated yt-dlp to|up to date/i.test(out)) log?.(/Updated/i.test(out) ? "  Descargador actualizado." : "  El descargador ya estaba al día.");
}
const fmtMin = (sec) => { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); rej(new Error("Cancelado")); }, { once: true });
  });
}

/**
 * Graba un EN VIVO en tramos .ts mientras dure (cfg.liveMinutes; 0 = hasta que termine, máx. 12 h).
 * Va dejando en `rec` lo grabado (rec.segs con su posición en la línea de tiempo, rec.total en segundos)
 * para que el análisis trabaje mientras se graba. Si la señal se corta, reconecta y abre otro tramo;
 * si la app se cierra, los tramos ya grabados se conservan y se sigue desde ahí.
 */
async function recordSegments({ T, src, ck, cacheDir, h, cfg, emit, log, signal, stopSignal, rec }) {
  const untilEnd = !(+cfg.liveMinutes > 0);
  const target = (+rec.base || 0) + (untilEnd ? 720 : Math.min(720, +cfg.liveMinutes)) * 60;
  const names = () => fs.readdirSync(cacheDir).filter((f) => /^rec_\d{3}\.ts$/.test(f)).sort();
  // base: al "Seguir vigilando" un directo ya cerrado, la línea de tiempo continúa donde quedó.
  const base = +rec.base || 0;
  let recorded = base;
  for (const f of names()) {
    const d = await mediaDuration(T.ffmpeg, path.join(cacheDir, f));
    if (d < 1) { try { fs.unlinkSync(path.join(cacheDir, f)); } catch {} continue; }
    rec.segs.push({ file: path.join(cacheDir, f), offset: recorded, dur: d });
    recorded += d;
  }
  rec.total = recorded; rec.ready = true;
  if (recorded > base) log(`Ya había ${fmtMin(recorded - base)} grabados: sigo desde ahí.`);
  emit({ type: "recording", on: true });
  // Señal ya unida (audio+video) si existe; si el sitio solo da video y audio por separado, se graban los dos.
  const FMT = `b[height<=${h}]/bv*[height<=${h}]+ba/b/bv*+ba/bv*/ba`;
  const probe = async (f) => JSON.parse((await run(T.ytdlp, [...ck, "-J", "--no-warnings", ...(f ? ["-f", f] : []), src], { signal })).stdout);
  const getStream = async () => {
    let j;
    try { j = await probe(FMT); }
    catch (e) {
      if (signal?.aborted || !/format is not available|Unable to extract|nsig|signature|player/i.test(ytErr(e))) throw e;
      // YouTube cambia seguido: actualizo el descargador y pruebo otra vez, primero con mi formato y luego con el que él elija.
      await updateYtdlp(T, log);
      try { j = await probe(FMT); } catch { j = await probe(null); }
    }
    const rf = j.requested_formats;
    const v = rf ? rf[0] : j, a = rf && rf[1];
    return { live: !!j.is_live || j.live_status === "is_live", url: v.url || j.url, aurl: a?.url || null, headers: v.http_headers || j.http_headers || {} };
  };
  let quickFails = 0;
  try {
    while (recorded < target - 5 && !stopSignal?.aborted) {
      if (signal?.aborted) throw new Error("Cancelado");
      let st;
      try { st = await getStream(); }
      catch (e) {
        if (signal?.aborted) throw e;
        if (recorded > 0 || base > 0) { log("  El directo ya no responde: termino la grabación con lo que hay."); break; }
        throw new Error(friendlyYtError(e));
      }
      if (!st.live && (recorded > 0 || base > 0)) { log("  El directo terminó."); break; }
      if (!st.url) throw new Error("No encontré la señal del en vivo.");
      const hdr = Object.entries(st.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      const web = /^https?:/i.test(st.url)
        ? [...(hdr ? ["-headers", hdr] : []), "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10", "-rw_timeout", "30000000"]
        : [];
      const file = path.join(cacheDir, `rec_${String(names().length).padStart(3, "0")}.ts`);
      const seg = { file, offset: recorded, dur: 0 };
      rec.segs.push(seg);
      const ctrl = new AbortController();
      const kill = () => ctrl.abort();
      signal?.addEventListener("abort", kill); stopSignal?.addEventListener("abort", kill);
      let last = -1;
      const t0 = Date.now();
      const inputs = st.aurl ? [...web, "-i", st.url, ...web, "-i", st.aurl, "-map", "0:v:0", "-map", "1:a:0"] : [...web, "-i", st.url];
      await run(T.ffmpeg, ["-y", "-v", "error", "-stats", ...inputs, "-t", String(Math.ceil(target - recorded)), "-c", "copy", "-f", "mpegts", file], {
        signal: ctrl.signal, allowFail: true,
        onLine: (l) => {
          const m = /time=(\d+):(\d+):(\d+)/.exec(l);
          if (!m) return;
          seg.dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
          rec.total = recorded + seg.dur;
          if (rec.total - last >= 10) {
            last = rec.total;
            emit({ type: "progress", id: "download", value: Math.min(untilEnd ? 0.99 : 1, (rec.total - base) / (target - base)) });
            emit({ type: "step", id: "download", status: "run", detail: `Grabación en curso · ${fmtMin(rec.total - base)}` });
          }
        },
      }).catch(() => {});
      signal?.removeEventListener("abort", kill); stopSignal?.removeEventListener("abort", kill);
      if (signal?.aborted) throw new Error("Cancelado");
      seg.dur = fs.existsSync(file) ? await mediaDuration(T.ffmpeg, file) : 0;
      if (seg.dur < 1) { rec.segs.pop(); try { fs.unlinkSync(file); } catch {} }
      recorded += seg.dur; rec.total = recorded;
      if (stopSignal?.aborted) { log(`  Grabación terminada por ti: ${fmtMin(recorded - base)}.`); break; }
      if (recorded >= target - 5) break;
      quickFails = Date.now() - t0 < 20000 ? quickFails + 1 : 0;
      if (quickFails >= 6) { log("  La señal se corta una y otra vez: termino con lo grabado."); break; }
      log(`  Se cortó la señal a los ${fmtMin(recorded)}; reconectando…`);
      await sleep(Math.min(15000, 2000 * (quickFails + 1)), signal);
    }
  } finally {
    rec.done = true;
    emit({ type: "recording", on: false });
    emit({ type: "step", id: "download", status: "ok", detail: `Grabación terminada · ${fmtMin(rec.total - base)}` });
  }
  if (!rec.segs.length && base > 0) { log("El directo ya terminó: no hay nada nuevo que vigilar."); return; }
  if (!rec.segs.length || recorded - base < 20) throw new Error("No pude grabar el en vivo (la señal se cortó o terminó enseguida). Inténtalo otra vez.");
}

const liveClipsText = (n) => `${n} clip${n === 1 ? "" : "s"} generado${n === 1 ? "" : "s"} de este live`;
const readyText = (plan) => { const n = plan.clips.filter((c) => c.status === "ok").length; return n ? `${n} clip${n === 1 ? "" : "s"} listo${n === 1 ? "" : "s"}` : ""; };

/** Lista para el "concat" de ffmpeg con el tramo [a, b] de la línea de tiempo de la grabación. */
function concatList(rec, a, b) {
  const L = [];
  for (const s of rec.segs) {
    const s0 = s.offset, s1 = s.offset + s.dur;
    if (s1 <= a || s0 >= b) continue;
    L.push(`file '${path.basename(s.file)}'`);
    if (a > s0) L.push(`inpoint ${(a - s0).toFixed(3)}`);
    if (b < s1) L.push(`outpoint ${(b - s0).toFixed(3)}`);
  }
  return L.join("\n");
}

/** Convierte un momento elegido por la IA en un clip del plan (mismo formato que los videos normales). */
function planClip(c, info) {
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
}

function writePublish(jobDir, info, plan) {
  const L = [`CLIPSPHERE — ${info.title}`, `Video original: ${info.webpage}`, ""];
  for (const c of plan.clips) {
    L.push("=".repeat(50), `${c.file}  (${c.startTimestamp.slice(0, 8)} → ${c.endTimestamp.slice(0, 8)})  [${c.label}]`, "",
      c.title, "", c.description, "", c.hashtags.join(" "), "");
  }
  L.push("=".repeat(50), "La atribución no evita reclamos de copyright: lo más seguro es pedir permiso al creador.");
  writeAtomic(path.join(jobDir, "publicar.txt"), L.join("\r\n"));
}

/**
 * DIRECTOS: vigila el en vivo mientras pasa. Graba sin parar y cada cfg.liveScanMinutes (5 por defecto)
 * transcribe lo nuevo; la IA mira esos minutos (con un poco de lo anterior para no cortar historias)
 * y, si hay un momento con potencial viral para el público elegido, el clip se hace AL MOMENTO.
 * Al terminar el directo (o con «Terminar grabación») se revisa el último tramo y se cierra.
 */
async function runLiveScan({ T, cfg, info, jobDir, cacheDir, src, ck, emit, log, step, signal, recStop, h }) {
  if (!cfg.deepgramKey && !cfg.groqKey && !T.whisper)
    throw new Error("Para vigilar un directo hay que transcribir el audio: pon la clave de Deepgram en Ajustes (es gratis) o ejecuta instalar.bat para instalar Whisper.");
  const stepSec = Math.max(2, Math.min(30, +cfg.liveScanMinutes || 5)) * 60;
  const ctxSec = Math.max(+cfg.maxSeconds || 200, 120); // contexto previo para no partir historias
  const stateFile = path.join(cacheDir, "live_state.json");
  const state = readJson(stateFile) || { transcribed: 0 };
  const wordsFile = path.join(cacheDir, "words.json");
  const words = readJson(wordsFile) || [];
  const planFile = path.join(jobDir, "plan.json");
  const attribution = `Fuente: ${info.uploader}${cfg.attributionPlatform !== false ? ` (${info.platform || "web"})` : ""}`;
  const plan = readJson(planFile) || {
    version: "1.0", createdAt: new Date().toISOString(),
    source: { platform: info.platform.toLowerCase(), url: info.webpage, title: info.title, creator: info.uploader, creatorHandle: info.handle, mode: "live" },
    clips: [], skipped: [],
  };
  const savePlan = () => writeAtomic(planFile, JSON.stringify(plan, null, 2));
  savePlan();
  emit({ type: "plan", plan });
  log(`Vigilando el directo: cada ${fmtMin(stepSec)} reviso lo nuevo y, si hay un momento que puede pegar con tu público, saco el clip al momento.`);
  step("download", "run", { detail: "Grabación en curso" });
  step("subs", "run", { detail: state.transcribed ? `Transcripción en curso · ${fmtMin(state.transcribed)}` : "Transcripción en curso" });
  step("ai", "run", { detail: plan.clips.length ? liveClipsText(plan.clips.length) : "Buscando momentos virales…" });
  step("render", "run", { detail: readyText(plan) || "Esperando el primer clip" });
  render.prepareFont(jobDir, cfg.fontFile);

  // Si este directo ya se había cerrado antes ("Seguir vigilando"), se continúa la línea de tiempo.
  const hasSegs = fs.readdirSync(cacheDir).some((f) => /^rec_\d{3}\.ts$/.test(f));
  const base = hasSegs ? 0 : +state.recordedTotal || 0;
  if (base > 0) { state.transcribed = Math.max(state.transcribed, base); log(`Sigo vigilando el directo: los ${plan.clips.length} clips anteriores se quedan y los nuevos se suman.`); }
  const rec = { segs: [], total: base, base, done: false, ready: false };
  const recP = recordSegments({ T, src, ck, cacheDir, h, cfg, emit, log, signal, stopSignal: recStop, rec })
    .catch((e) => { rec.err = e; });

  const renderOne = async (c) => {
    if (fs.existsSync(path.join(jobDir, c.file))) {
      if (!fs.existsSync(path.join(jobDir, c.cover))) await render.thumbnail({ ffmpeg: T.ffmpeg, jobDir, video: c.file, outName: c.cover });
      if (c.status !== "ok") { c.status = "ok"; savePlan(); }
      emit({ type: "clip", clip: c });
      return;
    }
    // Fuente: el tramo .ts que contiene el clip (o los tramos unidos si cae justo en un corte de señal).
    let source, shift, tmpSrc = null;
    const one = rec.segs.find((x) => c.start >= x.offset && c.end <= x.offset + x.dur);
    if (one) { source = one.file; shift = one.offset; }
    else {
      const inv = rec.segs.filter((x) => x.offset < c.end && x.offset + x.dur > c.start);
      if (!inv.length) throw new Error(`No encuentro la grabación del clip ${c.id}.`);
      const lf = path.join(cacheDir, `clip_${c.id}.txt`);
      fs.writeFileSync(lf, inv.map((x) => `file '${path.basename(x.file)}'`).join("\n"));
      tmpSrc = path.join(cacheDir, `clip_${c.id}.ts`);
      await run(T.ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lf, "-c", "copy", tmpSrc], { cwd: cacheDir, signal });
      source = tmpSrc; shift = inv[0].offset;
      try { fs.unlinkSync(lf); } catch {}
    }
    const assName = `${c.id}.ass`;
    writeAtomic(path.join(jobDir, assName), render.buildAss({ words, start: c.start, end: c.end, title: c.title, attribution, font: cfg.fontName || "Arial Black" }));
    log(`  ★ Clip ${c.id}: ${c.title}`);
    const tmpName = `${c.id}.tmp.mp4`;
    await render.renderClip({
      ffmpeg: T.ffmpeg, jobDir, source, clip: { ...c, start: c.start - shift, end: c.end - shift }, assName, outName: tmpName, encoder: cfg.encoder, signal,
      onProgress: (p) => emit({ type: "progress", id: "render", value: p, clip: c.id }),
    });
    fs.renameSync(path.join(jobDir, tmpName), path.join(jobDir, c.file));
    await render.thumbnail({ ffmpeg: T.ffmpeg, jobDir, video: c.file, outName: c.cover });
    try { fs.unlinkSync(path.join(jobDir, assName)); } catch {}
    if (tmpSrc) try { fs.unlinkSync(tmpSrc); } catch {}
    c.status = "ok"; savePlan();
    emit({ type: "clip", clip: c });
    step("render", "run", { detail: readyText(plan) });
  };

  const scanOnce = async (ready, final) => {
    const a = state.transcribed, b = Math.min(ready, a + stepSec * 2); // si hay atraso, de a dos tramos
    const wdir = path.join(cacheDir, `scan_${Math.round(a)}`);
    fs.mkdirSync(wdir, { recursive: true });
    log(`Revisando el directo: ${fmtMin(a)} → ${fmtMin(b)}…`);
    // 1) audio de ese tramo (desde los .ts, aunque el último se siga grabando)
    const audio = path.join(wdir, "audio.mp3");
    if (!fs.existsSync(audio)) {
      const lf = path.join(cacheDir, `scan_${Math.round(a)}.txt`);
      fs.writeFileSync(lf, concatList(rec, a, b));
      await run(T.ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lf, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio + ".tmp.mp3"], { cwd: cacheDir, signal });
      fs.renameSync(audio + ".tmp.mp3", audio);
      try { fs.unlinkSync(lf); } catch {}
    }
    // 2) transcribir solo lo nuevo
    const w = await transcribeCloud({ cfg, ffmpeg: T.ffmpeg, jobDir: wdir, cacheDir: wdir, audioFile: audio, log, whisper: T.whisper, signal });
    const fresh = w.map((x) => ({ ...x, t: +(x.t + a).toFixed(2) })).filter((x) => x.t >= a && x.t < b + 1);
    words.push(...fresh);
    writeAtomic(wordsFile, JSON.stringify(words));
    step("subs", "run", { detail: `Transcripción en curso · ${fmtMin(b)}` });
    // 3) la IA mira estos minutos (+ contexto) y elige solo lo que de verdad puede pegar
    if (fresh.length >= 15) {
      const lines = subs.toTimedLines(words.filter((x) => x.t >= Math.max(0, a - ctxSec) && x.t < b));
      const picked = cfg.fakeLlmFile ? readJson(cfg.fakeLlmFile) : await pickMoments({
        cfg: { ...cfg, liveScan: { note: final ? "El directo ya terminó: este es el final." : "El directo sigue en curso." } }, info, lines, log,
      });
      const margin = final ? 0 : 10; // un clip que llega al borde puede seguir: se deja para la próxima revisión
      const cand = normalizeClips(picked.clips || [], words, { ...cfg, clipLimit: 0 }, b)
        .filter((c) => c.end <= b - margin + 0.5 && c.start >= Math.max(0, a - ctxSec) - 1)
        .filter((c) => !plan.clips.some((o) => Math.min(o.end, c.end) - Math.max(o.start, c.start) > 0.3 * (c.end - c.start)));
      for (const c of cand) {
        c.id = `c${String(plan.clips.length + 1).padStart(2, "0")}`;
        const pc = planClip(c, info);
        plan.clips.push(pc);
        savePlan();
        emit({ type: "plan", plan });
        await renderOne(pc);
      }
      if (picked.skipped?.length) { plan.skipped.push(...picked.skipped); savePlan(); }
      if (!cand.length) log("  Nada que pegue en este tramo; sigo vigilando.");
    } else log("  En este tramo casi no se habló; sigo vigilando.");
    state.transcribed = b;
    writeAtomic(stateFile, JSON.stringify(state));
    try { fs.rmSync(wdir, { recursive: true, force: true }); } catch {}
    step("ai", "run", { detail: plan.clips.length ? liveClipsText(plan.clips.length) : "Buscando momentos virales…" });
  };

  let fails = 0, pendingDone = false;
  while (true) {
    if (signal?.aborted) throw new Error("Cancelado");
    if (rec.err && !rec.segs.length) throw rec.err;
    if (rec.ready && !pendingDone) { // clips que quedaron a medias si la app se cerró
      for (const c of plan.clips) if (c.status !== "ok") await renderOne(c);
      pendingDone = true;
    }
    const final = rec.done;
    const ready = final ? rec.total : rec.total - 8; // lo último puede estar a medio escribir
    if (rec.ready && (ready - state.transcribed >= stepSec || (final && ready - state.transcribed > 3))) {
      try { await scanOnce(ready, final); fails = 0; }
      catch (e) {
        if (signal?.aborted || e.message === "Cancelado") throw e;
        fails++;
        log(`  No pude revisar este tramo (${e.message}). Lo intento de nuevo…`);
        if (fails >= 4 && final) throw e;
        await sleep(Math.min(60000, 10000 * fails), signal);
      }
      continue;
    }
    if (final) break;
    await sleep(5000, signal);
  }
  await recP;
  if (rec.err && !plan.clips.length && state.transcribed - base < 20) throw rec.err;

  info.duration = rec.total;
  writeAtomic(path.join(jobDir, "info.json"), JSON.stringify(info, null, 2));
  state.recordedTotal = rec.total; // para poder "Seguir vigilando" más tarde
  writeAtomic(stateFile, JSON.stringify(state));
  step("subs", "ok", { detail: "Transcripción completa" });
  step("ai", "ok", { detail: plan.clips.length ? liveClipsText(plan.clips.length) : "Ningún momento viral claro" });
  step("render", "ok", { detail: readyText(plan) || "Sin clips" });
  writePublish(jobDir, info, plan);
  // Guardar la grabación completa solo si se pidió conservar el original
  const segFiles = rec.segs.map((x) => x.file);
  if (cfg.keepSource && segFiles.length) {
    const lf = path.join(cacheDir, "rec_list.txt");
    fs.writeFileSync(lf, segFiles.map((f) => `file '${path.basename(f)}'`).join("\n"));
    await run(T.ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lf, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", path.join(cacheDir, `grabacion.mp4`)], { cwd: cacheDir, signal }).catch(() => {});
    try { fs.unlinkSync(lf); } catch {}
  }
  for (const f of segFiles) try { fs.unlinkSync(f); } catch {}
  for (const f of fs.readdirSync(jobDir)) if (/\.(ass)$/.test(f) || /\.tmp\.mp4$/.test(f)) try { fs.unlinkSync(path.join(jobDir, f)); } catch {}
  if (!plan.clips.length) log("El directo terminó y no hubo ningún momento con potencial viral claro.");
  writeAtomic(path.join(jobDir, "done.json"), JSON.stringify({ at: new Date().toISOString() }));
  emit({ type: "done", plan });
  return plan;
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
async function runJobInner({ url, cfg, jobDir, emit, signal, dlCtrl, recStop }) {
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
    if (isLive) { // un en vivo siempre va a la sección Directos
      const jf = path.join(jobDir, "job.json"), jj = readJson(jf) || {};
      if (jj.module !== "live") { writeAtomic(jf, JSON.stringify({ ...jj, module: "live" })); emit({ type: "module", module: "live" }); }
    }
  } else {
    log("Retomando el trabajo donde se quedó…");
  }
  const cacheDir = path.join(path.dirname(jobDir), "_cache", slug(info.id || url));
  fs.mkdirSync(cacheDir, { recursive: true });
  const src = info.src || url;
  const ck = info.cookies ? ["--cookies-from-browser", info.cookies] : [];
  emit({ type: "info", info });
  step("info", "ok", { detail: info.isLive ? `${info.title} — EN VIVO` : `${info.title} — ${hms(info.duration, false)}` });

  const h = cfg.maxHeight || 720;
  // DIRECTOS: se vigila mientras pasa y los clips salen al momento
  if (info.isLive) return runLiveScan({ T, cfg, info, jobDir, cacheDir, src, ck, emit, log, step, signal: dlCtrl.signal, recStop, h });

  // 2) Descarga del video (en el caché; yt-dlp reanuda los .part y salta si ya está completo)
  step("download", "run");
  const videoName = `video_${h}p`;
  let lastDl = -10;
  const existing = findFile(cacheDir, new RegExp(`^${videoName}\\.(mp4|mkv|webm)$`));
  const dl = (existing
    ? Promise.resolve(log("Video ya descargado: no se vuelve a bajar."))
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
  const m = (url.match(/[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})|\/(?:live|shorts)\/([\w-]{6,})|\/([\w-]{6,})\/?(?:\?|$)/) || []).slice(1).find(Boolean);
  if (m) return slug(m);
  // Sin un id claro (p. ej. kick.com/canal): sitio + ruta, para no mezclar canales distintos.
  try { const u = new URL(url); return slug((u.hostname.replace(/^www\./, "").split(".")[0] + "-" + u.pathname.replace(/\/+$/, "")).slice(0, 60)) || "video"; }
  catch { return "video"; }
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

module.exports = { runJob, tools, updateYtdlp, normalizeClips, newJobDir, findResumableDir, friendlyYtError, wholeVideoClip };
