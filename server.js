// ClipSphere — © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// ClipSphere — servidor local sin dependencias. Uso: node server.js  →  http://localhost:3600
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { runJob, tools, newJobDir, findResumableDir } = require("./lib/pipeline");
const { isWin, writeAtomic } = require("./lib/util");
const backup = require("./lib/backup");
const updater = require("./lib/updater");

const PORT = +process.env.PORT || 3600;
// Con "node --watch" (iniciar.bat) el proceso hijo no ve --watch en execArgv; Node marca esta variable.
const IS_WATCH = process.execArgv.some((a) => a.startsWith("--watch")) || !!process.env.WATCH_REPORT_DEPENDENCIES;

// Registro de errores: si ClipSphere se cierra solo, aquí queda el motivo (errores.log en la carpeta de la app).
const ERR_LOG = path.join(__dirname, "errores.log");
function logErr(kind, e) {
  const line = `[${new Date().toISOString()}] ${kind}: ${e && e.stack ? e.stack : e}\n`;
  try { fs.appendFileSync(ERR_LOG, line); } catch {}
  console.error("  " + line);
}
process.on("unhandledRejection", (e) => logErr("Promesa sin manejar", e));
process.on("uncaughtException", (e) => { logErr("Error inesperado", e); process.exit(1); });
process.on("exit", (code) => { if (code) try { fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] Salió con código ${code}\n`); } catch {} });
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "config.json");

const DEFAULTS = {
  provider: "claude",              // "claude" (recomendado) | "gemini" | "ollama"
  anthropicKey: "",
  geminiKey: "",
  groqKey: "",
  deepgramKey: "",
  geminiModel: "",                 // vacío = el Flash más nuevo disponible
  claudeModel: "claude-sonnet-5-5",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen2.5:7b",
  outputRoot: path.join(os.homedir(), "Videos", "ClipSphere"),
  language: "es",
  clipLimit: 0,                    // 0 = sin límite: todos los momentos buenos
  minScore: 60,
  minSeconds: 90,
  maxSeconds: 200,
  maxHeight: 720,
  encoder: "libx264",
  keepSource: false,
  fontName: isWin ? "Arial Black" : "DejaVu Sans",
  fontFile: isWin ? "C:\\Windows\\Fonts\\ariblk.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  whisperModel: "small",
  liveMinutes: 30,                 // en vivo pegado en "Videos": minutos a grabar (en "Directos" se elige en pantalla)
  liveScanMinutes: 5,              // directos: cada cuántos minutos la IA revisa lo nuevo
  audience: "República Dominicana, Latinoamérica y latinos en EE. UU.", // público al que apunta la IA
  accessCode: "",                  // código para entrar desde el móvil (se genera solo)
  backupEnabled: true,             // respaldo automático a OneDrive / Google Drive
  backupDir: "",                   // vacío = se detecta OneDrive o Google Drive solo
  backupClips: true,               // incluir los videos de los clips en el respaldo
};

/** Si pegan un ejemplo de código (curl…) en vez de la clave sola, extrae la clave. */
function cleanKey(k, kind) {
  k = String(k || "").trim();
  const re = kind === "gemini" ? /AIza[0-9A-Za-z_\-]{30,}|AQ\.[0-9A-Za-z_\-.]{30,}/ : kind === "groq" ? /gsk_[A-Za-z0-9]{20,}/ : kind === "deepgram" ? /(?<=Token\s+)[A-Za-z0-9_\-.]{30,}|\b[0-9a-f]{40}\b/i : /sk-ant-[A-Za-z0-9_\-]{20,}/;
  const m = k.match(re);
  return m ? m[0] : k.replace(/\s+/g, "");
}

function readConfigFile() {
  // Si config.json se dañó (corte de luz), se usa la copia anterior para no perder las claves.
  for (const f of [CONFIG_FILE, CONFIG_FILE + ".bak"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  }
  return null;
}
function loadConfig() {
  const c = { ...DEFAULTS, ...(readConfigFile() || {}) };
  c.anthropicKey = cleanKey(c.anthropicKey, "anthropic");
  c.geminiKey = cleanKey(c.geminiKey, "gemini");
  c.groqKey = cleanKey(c.groqKey, "groq");
  c.deepgramKey = cleanKey(c.deepgramKey, "deepgram");
  return c;
}
function saveConfig(c) {
  try { if (readConfigFile()) fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + ".bak"); } catch {}
  writeAtomic(CONFIG_FILE, JSON.stringify(c, null, 2));
  backupSoon();
}
// Respaldo: se pide al guardar ajustes, al terminar cada clip y cada video, y cada 30 min.
function backupSoon(only) { return backup.schedule(loadConfig, CONFIG_FILE, only); }

// ---- Acceso desde el móvil (misma red Wi-Fi) ----
function accessCode() {
  const c = loadConfig();
  if (!c.accessCode) { c.accessCode = String(Math.floor(100000 + Math.random() * 900000)); saveConfig(c); }
  return c.accessCode;
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && !/^169\.254\./.test(a.address)) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}
function isLocal(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
}
const PIN_PAGE = (err) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClipSphere</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0f;color:#f2ede4;font-family:system-ui,sans-serif">
<form method="GET" action="/" style="width:min(340px,90vw);text-align:center">
<h1 style="font-size:34px;margin:0 0 6px">Clip<span style="color:#ffe100">Sphere</span></h1>
<p style="color:#8d8a84;margin:0 0 22px">Escribe el código que aparece en la laptop (⚙️ Ajustes → Abrir en el móvil)</p>
<input name="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus placeholder="000000"
 style="width:100%;box-sizing:border-box;font-size:32px;letter-spacing:10px;text-align:center;padding:14px;border-radius:14px;border:1px solid #2c2c34;background:#16161a;color:#f2ede4">
${err ? '<p style="color:#ff8a70">Código incorrecto</p>' : ""}
<button style="margin-top:16px;width:100%;padding:16px;border:0;border-radius:14px;background:#ffe100;color:#0d0d0f;font-size:18px;font-weight:800">Entrar</button>
</form></body></html>`;

// ---- Trabajos (uno a la vez, en cola) ----
const jobs = new Map(); // id → {id, url, dir, status, events:[], clients:Set, abort}
const queue = [];
let running = null;

function emit(job, ev) {
  ev.at = Date.now();
  job.events.push(ev);
  if (ev.type === "done") job.status = "done";
  if (ev.type === "error") job.status = "error";
  if ((ev.type === "clip" && ev.clip?.status === "ok") || ev.type === "done" || ev.type === "plan") backupSoon(job.id);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of job.clients) res.write(data);
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.status = "running";
  try { fs.unlinkSync(path.join(job.dir, "error.json")); } catch {}
  emit(job, { type: "status", status: "running" });
  const cfg = { ...loadConfig(), ...job.options };
  // Si se cancela, se suelta enseguida aunque el paso actual (esperas, IA) no haya terminado.
  const cancelled = new Promise((_, rej) => job.abort.signal.addEventListener("abort", () => rej(new Error("Cancelado"))));
  try {
    await Promise.race([
      runJob({ url: job.url, cfg, jobDir: job.dir, emit: (e) => job.status !== "error" && emit(job, e), signal: job.abort.signal, recStop: job.recStop.signal }),
      cancelled,
    ]);
  } catch (e) {
    const msg = e.message === "Cancelado" ? "Cancelado por ti." : e.message;
    if (job.status !== "error") emit(job, { type: "error", msg });
    // Se guarda el motivo para verlo después en el historial (aunque se cierre la app).
    try { fs.mkdirSync(job.dir, { recursive: true }); writeAtomic(path.join(job.dir, "error.json"), JSON.stringify({ at: new Date().toISOString(), msg, url: job.url })); } catch {}
  } finally {
    running = null;
    backupSoon(job.id);
    pump();
  }
}

// ---- Historial desde disco ----
function listHistory(module) {
  const root = loadConfig().outputRoot;
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "clips" && d.name !== "crudos").map((d) => d.name); } catch {}
  const all = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    const plan = readJsonSafe(path.join(dir, "plan.json"));
    const info = readJsonSafe(path.join(dir, "info.json"));
    if (!plan && !info && !fs.existsSync(path.join(dir, "error.json"))) continue;
    const live = jobs.get(d);
    const errFile = readJsonSafe(path.join(dir, "error.json"));
    const jobFile = readJsonSafe(path.join(dir, "job.json"));
    const mod = jobFile?.module === "live" || info?.isLive || plan?.source?.mode === "live" ? "live" : "vod";
    if (module && mod !== module) continue;
    const ready = plan ? plan.clips.filter((c) => c.status === "ok" && fs.existsSync(path.join(dir, c.file))).length : 0;
    const allReady = plan && plan.clips.length > 0 && ready === plan.clips.length;
    const done = fs.existsSync(path.join(dir, "done.json")) || allReady;
    const status = live && (live.status === "running" || live.status === "queued") ? live.status : done ? "done" : live?.status === "error" || errFile ? "error" : "interrumpido";
    const vid = d.replace(/^\d{8}-\d{4}-/, "");
    all.push({ id: d, vid, title: plan?.source.title || info?.title || errFile?.url || d, creator: plan?.source.creator || info?.uploader, url: info?.url || plan?.source.url,
      createdAt: plan?.createdAt || new Date(fs.statSync(dir).mtimeMs).toISOString(), clips: plan?.clips.length || 0, ready, status,
      error: status === "error" ? errFile?.msg || "" : "", live: !!info?.isLive, module: mod });
  }
  for (const j of jobs.values()) if (!all.find((o) => o.id === j.id) && (!module || (j.options?.module === "live" ? "live" : "vod") === module)) all.push({ id: j.id, vid: j.id.replace(/^\d{8}-\d{4}-/, ""), title: j.url, url: j.url, status: j.status, createdAt: new Date(j.created).toISOString(), clips: 0, ready: 0 });
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // Un solo renglón por video: los terminados con clips siempre; de los intentos fallidos, solo el más reciente.
  const out = [], seenPending = new Set();
  for (const j of all) {
    if (j.status === "done" && j.clips > 0) { out.push(j); continue; }
    if (seenPending.has(j.vid)) continue;
    if (all.some((o) => o.vid === j.vid && o.status === "done" && o.clips > 0) && j.status !== "running" && j.status !== "queued") continue;
    seenPending.add(j.vid);
    out.push(j);
  }
  return out;
}
async function deleteVideo(id) {
  const cfg = loadConfig(), root = cfg.outputRoot;
  if (!/^[\w.-]+$/.test(id)) throw Object.assign(new Error("Trabajo no válido."), { status: 400 });
  const vid = id.replace(/^\d{8}-\d{4}-/, "");
  const busy = [...jobs.values()].some((j) => j.id.replace(/^\d{8}-\d{4}-/, "") === vid && (j.status === "running" || j.status === "queued"));
  if (busy) throw Object.assign(new Error("Ese video se está procesando. Cancélalo o espera a que termine para eliminarlo."), { status: 409 });
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && (d.name === id || d.name.replace(/^\d{8}-\d{4}-/, "") === vid)).map((d) => d.name); } catch {}
  if (!names.length) throw Object.assign(new Error("Ese video ya no está en esta PC."), { status: 404 });
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }; // Windows a veces tiene el archivo abierto un instante
  for (const n of names) { fs.rmSync(path.join(root, n), rmOpts); jobs.delete(n); }
  if (vid && vid !== id) try { fs.rmSync(path.join(root, "_cache", vid), rmOpts); } catch {}
  const trashed = await backup.trash(cfg, names).catch(() => 0);
  console.log(`  Eliminado del historial: ${names.join(", ")}${trashed ? " (copia del respaldo movida a _papelera)" : ""}`);
  return { deleted: names.length, ids: names, trashed };
}
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }

function startJob({ url, dir, opts }) {
  const id = path.basename(dir);
  const prev = jobs.get(id);
  if (prev && (prev.status === "running" || prev.status === "queued")) return prev;
  // job.json: sección (videos/directos), link y opciones; así "Reintentar" funciona aunque se haya cerrado la app.
  const jf = path.join(dir, "job.json"), saved = readJsonSafe(jf) || {};
  const options = opts || prev?.options || saved.options || {};
  const module = saved.module === "live" ? "live" : options.module === "live" ? "live" : "vod";
  try { fs.mkdirSync(dir, { recursive: true }); writeAtomic(jf, JSON.stringify({ ...saved, url, module, options })); } catch {}
  const job = { id, url, dir, status: "queued", events: [], clients: prev ? prev.clients : new Set(), abort: new AbortController(), recStop: new AbortController(), options, created: Date.now() };
  jobs.set(id, job);
  queue.push(job);
  emit(job, { type: "status", status: "queued", position: queue.length });
  pump();
  return job;
}

// ---- HTTP ----
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-created-by": "ClipSphere by Erick Nex - NexTech360" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
}

function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: "no existe" }); }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const [a, b] = range.replace("bytes=", "").split("-");
    const start = +a, end = b ? +b : st.size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

function safeJoin(base, ...parts) {
  const p = path.resolve(base, ...parts);
  if (!p.startsWith(path.resolve(base))) throw new Error("ruta inválida");
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;

    // Desde otro aparato (móvil) hace falta el código de acceso
    if (!isLocal(req)) {
      const code = accessCode();
      const given = u.searchParams.get("c");
      if (given !== null) {
        if (given.trim() === code) {
          res.writeHead(302, { "set-cookie": `cs_code=${code}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, location: "/" });
          return res.end();
        }
        return send(res, 401, PIN_PAGE(true), "text/html; charset=utf-8");
      }
      if (cookies(req).cs_code !== code) {
        if (p.startsWith("/api/") || p.startsWith("/files/")) return send(res, 401, { error: "Falta el código de acceso" });
        return send(res, 200, PIN_PAGE(false), "text/html; charset=utf-8");
      }
      if (p === "/api/config" && req.method === "POST") return send(res, 403, { error: "Los ajustes solo se cambian desde la laptop." });
      if (/\/open$/.test(p)) return send(res, 200, { ok: true, note: "La carpeta se abre en la laptop" });
    }

    // ---- Actualizaciones (solo desde la laptop) ----
    if (p === "/api/update/check") {
      try { return send(res, 200, await updater.check()); }
      catch (e) { return send(res, 200, { current: updater.localManifest().version, available: false, error: e.message }); }
    }
    if (p === "/api/update/apply" && req.method === "POST") {
      if (!isLocal(req)) return send(res, 403, { error: "La actualización se hace desde la laptop." });
      if (running || queue.length) return send(res, 409, { error: "Hay un trabajo en curso. Espera a que termine para actualizar." });
      try {
        const r = await updater.apply((m) => console.log("  " + m));
        console.log(`\n  ClipSphere actualizado a la versión ${r.version} (${r.changed.length} archivos). Reiniciando…\n`);
        send(res, 200, r);
        // Si iniciar.bat usa --watch se reinicia solo; si no, salimos y el .bat lo vuelve a abrir.
        if (!IS_WATCH) setTimeout(() => process.exit(0), 800);
        return;
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    // ---- Respaldo (solo desde la laptop) ----
    if (p.startsWith("/api/backup")) {
      if (!isLocal(req)) return send(res, 403, { error: "El respaldo se maneja desde la laptop." });
      if (p === "/api/backup") return send(res, 200, backup.status(loadConfig()));
      if (p === "/api/backup/run" && req.method === "POST") {
        const r = await backup.schedule(loadConfig, CONFIG_FILE);
        const st = backup.status(loadConfig());
        if (!r && st.error) return send(res, 500, { error: st.error });
        return send(res, 200, st);
      }
      if (p === "/api/backup/restore" && req.method === "POST") {
        try { return send(res, 200, await backup.restore(loadConfig(), CONFIG_FILE)); }
        catch (e) { return send(res, 500, { error: e.message }); }
      }
    }

    if (p === "/api/whoami") return send(res, 200, { local: isLocal(req) });

    if (p === "/api/lan") {
      if (!isLocal(req)) return send(res, 403, { error: "solo desde la laptop" });
      return send(res, 200, { urls: lanUrls(), code: accessCode() });
    }

    if (p === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ffe100"/><path d="M12 9l12 7-12 7z" fill="#0d0d0f"/></svg>');
    }
    if (p === "/" || p === "/index.html") return serveFile(req, res, path.join(ROOT, "public", "index.html"));

    if (p === "/api/check") {
      const t = tools();
      const c = loadConfig();
      let ollama = false;
      if (c.provider === "ollama") { try { ollama = (await fetch(c.ollamaUrl + "/api/tags")).ok; } catch {} }
      const hasKey = c.provider === "gemini" ? !!c.geminiKey : c.provider === "claude" ? !!c.anthropicKey : true;
      return send(res, 200, { tools: t, hasKey, hasGroq: !!(c.groqKey || c.deepgramKey), provider: c.provider, ollama, fontOk: fs.existsSync(c.fontFile) });
    }

    if (p === "/api/config" && req.method === "GET") {
      const c = loadConfig();
      const mask = (k) => (k ? "••••" + k.slice(-4) : "");
      return send(res, 200, { ...c, anthropicKey: mask(c.anthropicKey), geminiKey: mask(c.geminiKey), groqKey: mask(c.groqKey), deepgramKey: mask(c.deepgramKey) });
    }
    if (p === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const c = loadConfig();
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in body)) continue;
        if (/Key$/.test(k) && (!body[k] || String(body[k]).startsWith("••••"))) continue;
        c[k] = typeof DEFAULTS[k] === "number" ? +body[k] : typeof DEFAULTS[k] === "boolean" ? !!body[k] : String(body[k]).trim();
        if (k === "anthropicKey") c[k] = cleanKey(c[k], "anthropic");
        if (k === "geminiKey") c[k] = cleanKey(c[k], "gemini");
        if (k === "groqKey") c[k] = cleanKey(c[k], "groq");
        if (k === "deepgramKey") c[k] = cleanKey(c[k], "deepgram");
      }
      saveConfig(c);
      return send(res, 200, { ok: true });
    }

    if (p === "/api/jobs" && req.method === "GET") return send(res, 200, listHistory(["live", "vod"].includes(u.searchParams.get("module")) ? u.searchParams.get("module") : null));
    // Eliminar un video del historial: todos sus intentos, sus clips y el video descargado.
    const mDel = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (mDel && req.method === "DELETE") {
      try { return send(res, 200, await deleteVideo(decodeURIComponent(mDel[1]))); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    if (p === "/api/jobs" && req.method === "POST") {
      const body = await readBody(req);
      const url = String(body.url || "").trim();
      if (!/^https?:\/\//.test(url)) return send(res, 400, { error: "Pega un link válido (https://…)" });
      const cfg = loadConfig();
      const prov = body.options?.provider || cfg.provider;
      if (prov === "claude" && !cfg.anthropicKey && !cfg.fakeLlmFile)
        return send(res, 400, { error: "Falta la API key de Claude. Ábrela en ⚙️ Ajustes." });
      if (prov === "gemini" && !cfg.geminiKey && !cfg.fakeLlmFile)
        return send(res, 400, { error: "Falta la clave de Gemini (gratis en aistudio.google.com). Ponla en ⚙️ Ajustes." });
      let dir = findResumableDir(cfg.outputRoot, url);
      const wantMod = body.options?.module === "live" ? "live" : "vod";
      const oldJob = dir && readJsonSafe(path.join(dir, "job.json"));
      if (dir && oldJob?.module && oldJob.module !== wantMod && !readJsonSafe(path.join(dir, "info.json"))?.isLive) dir = null; // cada sección con sus trabajos
      // Un en vivo de hace horas ya es otra transmisión: se empieza una grabación nueva.
      const oldInfo = dir && readJsonSafe(path.join(dir, "info.json"));
      if (oldInfo?.isLive && Date.now() - fs.statSync(path.join(dir, "info.json")).mtimeMs > 6 * 3600e3) dir = null;
      dir = dir || newJobDir(cfg.outputRoot, url);
      const opts = {};
      for (const k of ["minSeconds", "maxSeconds", "language", "maxHeight", "provider", "module", "liveMinutes"]) if (body.options?.[k] !== undefined && body.options[k] !== "") opts[k] = typeof DEFAULTS[k] === "number" ? +body.options[k] : body.options[k];
      const job = startJob({ url, dir, opts });
      return send(res, 200, { id: job.id });
    }

    let m;
    if ((m = /^\/api\/jobs\/([\w-]+)\/events$/.exec(p))) {
      const job = jobs.get(m[1]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (!job) { res.write(`data: ${JSON.stringify({ type: "gone" })}\n\n`); return res.end(); }
      for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      job.clients.add(res);
      req.on("close", () => job.clients.delete(res));
      return;
    }
    if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(p)) && req.method === "GET") {
      const dir = safeJoin(loadConfig().outputRoot, m[1]);
      try { return send(res, 200, JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"))); } catch { return send(res, 404, { error: "sin plan todavía" }); }
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p)) && req.method === "POST") {
      const job = jobs.get(m[1]);
      if (job && job.status !== "done" && job.status !== "error") {
        const qi = queue.indexOf(job);
        if (qi >= 0) queue.splice(qi, 1);
        emit(job, { type: "error", msg: "Cancelado por ti." });
        job.abort.abort();
      }
      return send(res, 200, { ok: true });
    }
    // Directos: seguir vigilando un directo que se cerró (con «Terminar grabación», o porque se cortó).
    if ((m = /^\/api\/jobs\/([\w-]+)\/resume-live$/.exec(p)) && req.method === "POST") {
      const dir = safeJoin(loadConfig().outputRoot, m[1]);
      const info = readJsonSafe(path.join(dir, "info.json"));
      if (!info?.isLive) return send(res, 400, { error: "Ese trabajo no es de un directo en vivo." });
      const live = jobs.get(m[1]);
      if (live && (live.status === "running" || live.status === "queued")) return send(res, 200, { id: live.id });
      try { fs.unlinkSync(path.join(dir, "done.json")); } catch {}
      const saved = readJsonSafe(path.join(dir, "job.json")) || {};
      const job = startJob({ url: info.url, dir, opts: { ...(saved.options || {}), module: "live" } });
      return send(res, 200, { id: job.id });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/stop-recording$/.exec(p)) && req.method === "POST") {
      const job = jobs.get(m[1]);
      if (!job || job.status !== "running") return send(res, 400, { error: "Ese trabajo no está grabando." });
      job.recStop.abort();
      emit(job, { type: "log", msg: "Terminando la grabación: ahora saco los clips de lo grabado…" });
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/retry$/.exec(p)) && req.method === "POST") {
      const dir = safeJoin(loadConfig().outputRoot, m[1]);
      const info = readJsonSafe(path.join(dir, "info.json"));
      const url = info?.url || jobs.get(m[1])?.url || readJsonSafe(path.join(dir, "job.json"))?.url || readJsonSafe(path.join(dir, "error.json"))?.url;
      if (!url) return send(res, 400, { error: "No sé qué video era este trabajo; pega el link otra vez." });
      const job = startJob({ url, dir });
      return send(res, 200, { id: job.id });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/open$/.exec(p)) && req.method === "POST") {
      const dir = safeJoin(loadConfig().outputRoot, m[1]);
      const cmd = isWin ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/files\/([\w-]+)\/([\w.-]+)$/.exec(p))) {
      return serveFile(req, res, safeJoin(loadConfig().outputRoot, m[1], m[2]));
    }
    send(res, 404, { error: "no encontrado" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const URL_APP = `http://localhost:${PORT}`;
function openBrowser() {
  if (!process.argv.includes("--open")) return;
  // Con "node --watch" el servidor se reinicia solo al actualizarse; abrir el navegador solo la primera vez.
  const mark = path.join(os.tmpdir(), "clipsphere-opened.txt");
  try { if (fs.readFileSync(mark, "utf8") === String(process.ppid)) return; } catch {}
  try { fs.writeFileSync(mark, String(process.ppid)); } catch {}
  const cmd = isWin ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = isWin ? ["/c", "start", "", URL_APP] : [URL_APP];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// PC nueva o reinstalada: si no hay ajustes pero sí respaldo, se recupera todo antes de arrancar.
async function restoreIfFresh() {
  if (readConfigFile()) return;
  try {
    const r = await backup.restore({ ...DEFAULTS }, CONFIG_FILE);
    if (r.config || r.restored) console.log(`\n  Respaldo recuperado: ${r.config ? "ajustes y claves, " : ""}${r.restored} archivos del historial.`);
  } catch {}
}

function startBackups() {
  const st = backup.status(loadConfig());
  if (st.enabled) console.log(st.dir ? `  Respaldo automático en: ${st.dir}\n` : "  Respaldo: no encontré OneDrive ni Google Drive. Elige una carpeta en Ajustes.\n");
  setTimeout(() => backupSoon(), 15000);
  setInterval(() => backupSoon(), 30 * 60 * 1000).unref();
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`\n  ClipSphere ya está abierto en otra ventana. Abriendo ${URL_APP} …\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

restoreIfFresh().then(() => server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  ClipSphere v${updater.localManifest().version} © 2026 · Creado por Erick Nex · NexTech360`);
  console.log(`\n  ClipSphere listo en ${URL_APP}\n  (deja esta ventana abierta mientras lo usas)\n`);
  const lan = lanUrls();
  if (lan.length) console.log(`  En el móvil (mismo Wi-Fi): ${lan[0]}   código: ${accessCode()}\n`);
  openBrowser();
  startBackups();
}));
