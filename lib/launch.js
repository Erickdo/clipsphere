// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// 🚀 Lanzamientos (Modo Misión): prepara clips ANTES de un evento grande (un juego, un estreno,
// un concierto, un reality) para que el día que la gente empiece a buscar, todo esté listo.
// Cada campaña vive en outputRoot/_campanas/<id>/campana.json.
const fs = require("node:fs");
const path = require("node:path");
const { run, writeAtomic } = require("./util");
const { askJson } = require("./llm");

const PROMPT = fs.readFileSync(path.join(__dirname, "..", "prompts", "campana.md"), "utf8");
const TZ = "-04:00"; // hora de República Dominicana (no cambia de horario)
const MISSIONS = {
  1: "Lo que busca la gente",
  2: "Lo que más peta",
  3: "Fuentes y clips",
  4: "Títulos y portadas",
  5: "El lanzamiento",
};

// ---------- utilidades ----------
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slugify(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "campana";
}
const campRoot = (cfg) => path.join(cfg.outputRoot, "_campanas");
const campDir = (cfg, id) => {
  if (!/^[a-z0-9-]+$/.test(String(id))) throw Object.assign(new Error("Campaña no válida."), { status: 400 });
  return path.join(campRoot(cfg), id);
};
const campFile = (cfg, id) => path.join(campDir(cfg, id), "campana.json");

/** "2026-11-19T00:00" (hora de RD) → Date. */
function rdDate(local) { return new Date(String(local).slice(0, 16) + ":00" + TZ); }
/** Date → { day: "2026-11-19", hm: "00:00", label: "jue 19 nov, 12:00 a. m." } en hora de RD. */
function rdParts(d) {
  const t = new Date(d.getTime() - 4 * 3600e3);
  const iso = t.toISOString();
  const label = new Date(d).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return { day: iso.slice(0, 10), hm: iso.slice(11, 16), label };
}
const rdIso = (d) => { const p = rdParts(d); return `${p.day}T${p.hm}:00${TZ}`; };

// ---------- guardar / leer ----------
function readCampaign(cfg, id) {
  const c = readJson(campFile(cfg, id));
  if (!c) throw Object.assign(new Error("Esa campaña ya no existe."), { status: 404 });
  return c;
}
function saveCampaign(cfg, c) {
  fs.mkdirSync(campDir(cfg, c.id), { recursive: true });
  c.updatedAt = new Date().toISOString();
  writeAtomic(campFile(cfg, c.id), JSON.stringify(c, null, 2));
  return c;
}
function createCampaign(cfg, { tema, fecha, publico, idioma }) {
  tema = String(tema || "").trim();
  if (!tema) throw Object.assign(new Error("Escribe el tema de la campaña (por ejemplo: GTA 6)."), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(fecha || ""))) throw Object.assign(new Error("Pon la fecha y la hora del lanzamiento."), { status: 400 });
  const when = rdDate(fecha);
  if (isNaN(when)) throw Object.assign(new Error("Fecha no válida."), { status: 400 });
  let id = `${slugify(tema)}-${rdParts(when).day.replace(/-/g, "")}`;
  for (let n = 2; fs.existsSync(campFile(cfg, id)); n++) id = `${slugify(tema)}-${rdParts(when).day.replace(/-/g, "")}-${n}`;
  const c = {
    id, tema, fecha: rdIso(when), publico: String(publico || "").trim() || cfg.audience || "", idioma: idioma || cfg.language || "es",
    createdAt: new Date().toISOString(),
    missions: Object.fromEntries(Object.keys(MISSIONS).map((n) => [n, { status: "pendiente" }])),
    jobs: [],
  };
  return saveCampaign(cfg, c);
}
/** Cambiar la fecha/hora del lanzamiento (el calendario se rehace en la Misión final). */
function updateCampaign(cfg, id, { fecha, publico }) {
  const c = readCampaign(cfg, id);
  if (fecha !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(fecha))) throw Object.assign(new Error("Fecha no válida."), { status: 400 });
    c.fecha = rdIso(rdDate(fecha));
    if (c.m5) { delete c.m5; c.missions["5"] = { status: "pendiente" }; } // el calendario viejo ya no sirve
  }
  if (publico !== undefined) c.publico = String(publico).trim() || c.publico;
  return saveCampaign(cfg, c);
}
function listCampaigns(cfg) {
  let names = [];
  try { names = fs.readdirSync(campRoot(cfg), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  return names.map((n) => readJson(path.join(campRoot(cfg), n, "campana.json"))).filter(Boolean)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}
function deleteCampaign(cfg, id) {
  fs.rmSync(campDir(cfg, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { ok: true };
}

/** Clips de la campaña: se buscan en los trabajos cuyo plan.json lleva campaign: id. */
function campaignClips(cfg, id) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(cfg.outputRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name); } catch {}
  for (const d of dirs) {
    const plan = readJson(path.join(cfg.outputRoot, d, "plan.json"));
    if (!plan || plan.campaign !== id) continue;
    for (const c of plan.clips || []) {
      const ready = c.status === "ok" && fs.existsSync(path.join(cfg.outputRoot, d, c.file));
      out.push({ ...c, jobId: d, ready, source: plan.source?.title || "" });
    }
  }
  return out;
}

/** Lo que se le manda a la IA cuando saca clips para una campaña (lo usa llm.pickMoments). */
function campaignBlock(cfg, id) {
  const c = readCampaign(cfg, id);
  const frases = (c.m1?.clave || []).map((f) => `${f.frase} (${f.nivel})`);
  const f = c.m2?.formula;
  return "CAMPAÑA DE LANZAMIENTO:\n" + JSON.stringify({
    tema: c.tema, lanzamiento: rdParts(new Date(c.fecha)).label + " (hora de RD)", publico: c.publico,
    frases_que_busca_la_gente: frases.slice(0, 30),
    formula_de_lo_que_mas_peta: f ? { ganchos: f.ganchos, titulos: f.titulos, duracion: f.duracion, portadas: f.portadas } : undefined,
  }, null, 1) +
  "\nINSTRUCCIONES DE CAMPAÑA: prefiere los momentos que respondan a lo que la gente busca (las frases de arriba). " +
  "Mete esas frases, tal cual, en el título y en los hashtags cuando encajen de verdad con el clip. Sigue la fórmula de títulos. " +
  "No prometas en el título algo que el clip no muestra.\n";
}

// ---------- progreso en vivo (SSE) ----------
const live = new Map(); // id → { clients:Set, events:[], running:n|null }
function rt(id) { if (!live.has(id)) live.set(id, { clients: new Set(), events: [], running: null }); return live.get(id); }
function emit(id, ev) {
  const r = rt(id); ev.at = Date.now();
  r.events.push(ev); if (r.events.length > 400) r.events.splice(0, r.events.length - 400);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of r.clients) res.write(data);
}
function subscribe(id, res, req) {
  const r = rt(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const ev of r.events.slice(-80)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (r.clients.size >= 20) { const o = r.clients.values().next().value; r.clients.delete(o); try { o.end(); } catch {} }
  r.clients.add(res);
  const beat = setInterval(() => { try { res.write(": latido\n\n"); } catch { drop(); } }, 25000); beat.unref();
  const drop = () => { clearInterval(beat); r.clients.delete(res); };
  req.on("close", drop); res.on("error", drop); res.on("close", drop);
}
const isRunning = (id) => !!live.get(id)?.running;

/** Corre una misión en segundo plano. El progreso sale por SSE; el resultado queda en campana.json. */
function runMission(cfg, id, n, deps) {
  n = String(n);
  if (!MISSIONS[n]) throw Object.assign(new Error("Esa misión no existe."), { status: 400 });
  readCampaign(cfg, id); // que exista
  const r = rt(id);
  if (r.running) throw Object.assign(new Error(`Ya está corriendo la misión ${r.running}. Espera a que termine.`), { status: 409 });
  r.running = n;
  const log = (msg) => emit(id, { type: "log", msg });
  const setStatus = (status, extra = {}) => {
    const c = readCampaign(cfg, id);
    c.missions[n] = { ...c.missions[n], status, at: new Date().toISOString(), ...extra };
    if (status !== "error") delete c.missions[n].error;
    saveCampaign(cfg, c);
    emit(id, { type: "mission", n, status, error: extra.error });
  };
  setStatus("corriendo");
  log(`▶ Misión ${n} · ${MISSIONS[n]}`);
  const fn = { 1: mission1, 2: mission2, 3: mission3, 4: mission4, 5: mission5 }[n];
  (async () => {
    try {
      const st = (await fn(cfg, id, log, deps)) || "lista";
      setStatus(st);
      log(st === "lista" ? `✅ Misión ${n} lista.` : `Misión ${n}: falta un paso (mira arriba).`);
    } catch (e) {
      setStatus("error", { error: e.message });
      log(`❌ Misión ${n}: ${e.message}`);
    } finally {
      r.running = null;
      emit(id, { type: "campaign" });
      deps?.backupSoon?.();
    }
  })();
  return { ok: true };
}

// ---------- MISIÓN 1 · Lo que busca la gente ----------
async function suggest(cfg, q, lang) {
  const base = cfg.suggestUrl || "https://suggestqueries.google.com/complete/search";
  const url = `${base}?client=firefox&ds=yt&hl=${encodeURIComponent(lang || "es")}&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/128.0" }, signal: AbortSignal.timeout(12000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      let txt = buf.toString("utf8");
      if (txt.includes("\uFFFD")) txt = buf.toString("latin1"); // a veces Google responde en ISO-8859-1
      const j = JSON.parse(txt);
      return Array.isArray(j[1]) ? j[1].map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === "string") : [];
    } catch (e) { if (i === 2) throw e; await sleep(800); }
  }
  return [];
}
const norm = (s) => String(s).toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

async function mission1(cfg, id, log) {
  const c = readCampaign(cfg, id);
  const tema = c.tema.trim();
  const seeds = [tema, ..."abcdefghijklmnopqrstuvwxyz".split("").map((l) => `${tema} ${l}`),
    ...["cómo", "qué", "cuándo", "dónde", "precio"].map((w) => `${tema} ${w}`)];
  log(`Preguntándole al buscador de YouTube qué escribe la gente sobre «${tema}» (${seeds.length} búsquedas)…`);
  const score = new Map(); // frase → { q, peso, veces }
  let ok = 0, fails = 0;
  for (let i = 0; i < seeds.length; i += 4) {
    const batch = seeds.slice(i, i + 4);
    const res = await Promise.all(batch.map((q) => suggest(cfg, q, c.idioma).then((r) => { ok++; return r; }, () => { fails++; return []; })));
    for (const list of res) {
      list.forEach((s, pos) => {
        const k = norm(s);
        if (!k || k === norm(tema)) return;
        const e = score.get(k) || { q: s.trim(), peso: 0, veces: 0 };
        e.peso += Math.max(1, 10 - pos); // primero en la lista = más buscado
        e.veces++;
        score.set(k, e);
      });
    }
    if (i % 12 === 0) log(`  ${Math.min(i + 4, seeds.length)}/${seeds.length} búsquedas…`);
    await sleep(250);
  }
  if (!ok) throw new Error("No pude consultar el buscador de YouTube. Revisa el internet de esta PC y vuelve a correr la misión.");
  const tokens = norm(tema).split(" ").filter((t) => t.length > 1);
  let frases = [...score.values()]
    .filter((e) => tokens.some((t) => norm(e.q).includes(t)))
    .map((e) => ({ frase: e.q, peso: e.peso + e.veces * 3, veces: e.veces }))
    .sort((a, b) => b.peso - a.peso);
  if (!frases.length) throw new Error(`El buscador no devolvió frases para «${tema}». Prueba con otro nombre (por ejemplo, más corto).`);
  // Ranking SIN inventar volúmenes: alta / media / baja según el peso relativo.
  const n = frases.length;
  frases = frases.map((f, i) => ({ ...f, nivel: i < n / 3 ? "alta" : i < (2 * n) / 3 ? "media" : "baja" }));
  log(`  ${n} frases distintas (${fails ? fails + " búsquedas fallaron" : "todas las búsquedas respondieron"}). La IA las agrupa…`);
  const lista = frases.slice(0, 150).map((f) => `${f.frase} [${f.nivel}]`).join("\n");
  const ai = await askJson(cfg, PROMPT,
    `MISIÓN 1 · LO QUE BUSCA LA GENTE\nTema: ${c.tema}\nPúblico: ${c.publico}\nIdioma: ${c.idioma}\n` +
    `Frases reales del autocompletado de YouTube (ordenadas de más a menos fuerte, con su nivel):\n${lista}\n\n` +
    `1) Agrupa las frases en 4 a 8 temas (ej.: mapa, secretos, personajes, teorías, precio, filtraciones).\n` +
    `2) Elige las 30 frases clave más fuertes y útiles para títulos y hashtags. Copia cada frase EXACTAMENTE como está en la lista.`,
    { type: "object", required: ["grupos", "clave"], properties: {
      grupos: { type: "array", items: { type: "object", required: ["tema", "frases"], properties: { tema: { type: "string" }, emoji: { type: "string" }, frases: { type: "array", items: { type: "string" } } } } },
      clave: { type: "array", items: { type: "string" } },
    } }, { name: "mision1", log });
  const byKey = new Map(frases.map((f) => [norm(f.frase), f]));
  let clave = (ai.clave || []).map((q) => byKey.get(norm(q))).filter(Boolean);
  clave = [...new Map(clave.map((f) => [norm(f.frase), f])).values()];
  for (const f of frases) { if (clave.length >= 30) break; if (!clave.includes(f)) clave.push(f); } // si la IA eligió menos de 30
  const grupos = (ai.grupos || []).map((g) => ({ tema: g.tema, emoji: g.emoji || "", frases: (g.frases || []).map((q) => byKey.get(norm(q))).filter(Boolean).map((f) => ({ frase: f.frase, nivel: f.nivel })) })).filter((g) => g.frases.length);
  const cc = readCampaign(cfg, id);
  cc.m1 = { at: new Date().toISOString(), fuente: "Autocompletado de YouTube", total: n, grupos, clave: clave.slice(0, 30).map((f) => ({ frase: f.frase, nivel: f.nivel })), frases: frases.slice(0, 300).map((f) => ({ frase: f.frase, nivel: f.nivel })) };
  saveCampaign(cfg, cc);
  log(`  ${grupos.length} temas y ${cc.m1.clave.length} frases clave.`);
}

// ---------- MISIÓN 2 · Lo que más peta ----------
async function ytJson(T, args, signal) {
  const r = await run(T.ytdlp, ["--no-warnings", ...args], { signal, allowFail: true });
  return String(r.stdout || "").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const ago = (yyyymmdd) => {
  if (!/^\d{8}$/.test(String(yyyymmdd || ""))) return null;
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00Z`);
  return Math.max(1, (Date.now() - d) / 86400e3);
};

async function mission2(cfg, id, log, { tools }) {
  const c = readCampaign(cfg, id);
  const T = tools();
  if (!T.ytdlp) throw new Error("Falta yt-dlp. Cierra ClipSphere y ejecuta instalar.bat.");
  log(`Buscando en YouTube lo más nuevo y lo más visto de «${c.tema}»…`);
  const seen = new Map();
  for (const q of [`ytsearchdate40:${c.tema}`, `ytsearch40:${c.tema}`]) {
    const [j] = await ytJson(T, ["--flat-playlist", "-J", q]);
    for (const e of j?.entries || []) if (e?.id && !seen.has(e.id)) seen.set(e.id, e);
  }
  if (!seen.size) throw new Error("YouTube no devolvió resultados. Revisa el internet o prueba otro nombre del tema.");
  // La búsqueda rápida no trae la fecha: se piden los detalles de los más vistos (en una sola llamada).
  const cand = [...seen.values()].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, 35);
  log(`  ${seen.size} videos encontrados. Revisando fecha y formato de los ${cand.length} más vistos…`);
  const urls = cand.map((e) => (/^https?:/.test(e.url || "") ? e.url : `https://www.youtube.com/watch?v=${e.id}`));
  const det = await ytJson(T, ["--skip-download", "--ignore-errors", "--no-playlist", "--sleep-requests", "1.2", "-j", ...urls]);
  const byId = new Map(det.map((d) => [d.id, d]));
  const videos = cand.map((e) => {
    const d = byId.get(e.id) || {};
    const views = d.view_count ?? e.view_count ?? 0;
    const duration = d.duration ?? e.duration ?? 0;
    const days = ago(d.upload_date);
    const url = d.webpage_url || (/^https?:/.test(e.url || "") ? e.url : `https://www.youtube.com/watch?v=${e.id}`);
    const vertical = d.width && d.height ? d.height > d.width : false;
    const short = /\/shorts\//.test(url) || vertical || (duration > 0 && duration <= 60);
    return { id: e.id, url, title: d.title || e.title || "", channel: d.channel || d.uploader || e.channel || e.uploader || "",
      views, duration, uploadDate: d.upload_date || null, perDay: days ? Math.round(views / days) : null, short };
  }).filter((v) => v.title);
  videos.sort((a, b) => (b.perDay ?? -1) - (a.perDay ?? -1) || b.views - a.views);
  const top = videos.slice(0, 15);
  log(`  Top ${top.length} por vistas al día. La IA saca la fórmula…`);
  const lista = top.map((v, i) => `${i + 1}. "${v.title}" — ${v.channel} — ${v.views.toLocaleString("es-DO")} vistas, ${v.perDay != null ? v.perDay.toLocaleString("es-DO") + "/día" : "fecha desconocida"}, ${Math.round(v.duration)} s, ${v.short ? "Short" : "Largo"}`).join("\n");
  const formula = await askJson(cfg, PROMPT,
    `MISIÓN 2 · LO QUE MÁS PETA\nTema: ${c.tema}\nPúblico: ${c.publico}\n` +
    `Los videos que más vistas por día sacan ahora mismo sobre el tema (datos reales de YouTube):\n${lista}\n\n` +
    `Saca LA FÓRMULA que se repite: tipos de gancho, cómo se arman los títulos (palabras, mayúsculas, emojis, números), duración ideal (Shorts y largos) y el texto típico de las portadas. Basado SOLO en estos títulos y datos.`,
    { type: "object", required: ["ganchos", "titulos", "duracion", "portadas", "resumen"], properties: {
      ganchos: { type: "array", items: { type: "string" } },
      titulos: { type: "object", properties: { palabras: { type: "string" }, mayusculas: { type: "string" }, emojis: { type: "string" }, numeros: { type: "string" }, ejemplos: { type: "array", items: { type: "string" } } } },
      duracion: { type: "object", properties: { shorts: { type: "string" }, largos: { type: "string" } } },
      portadas: { type: "array", items: { type: "string" } },
      resumen: { type: "string" },
    } }, { name: "mision2", log });
  const cc = readCampaign(cfg, id);
  cc.m2 = { at: new Date().toISOString(), total: videos.length, videos, top, formula };
  saveCampaign(cfg, cc);
}

// ---------- MISIÓN 3 · Fuentes y clips ----------
async function mission3(cfg, id, log) {
  const c = readCampaign(cfg, id);
  if (!c.m2?.videos?.length) throw new Error("Primero corre la Misión 2 (Lo que más peta): de ahí salen las fuentes.");
  const fuentes = c.m2.videos.filter((v) => !v.short && v.duration >= 90).slice(0, 20);
  c.m3 = { at: new Date().toISOString(), fuentes };
  saveCampaign(cfg, c);
  const clips = campaignClips(cfg, id);
  log(`  ${fuentes.length} videos largos para sacar clips. Clips de la campaña hasta ahora: ${clips.filter((x) => x.ready).length}.`);
  if (!fuentes.length) log("  No salieron videos largos en la búsqueda: pega tú el link de un tráiler o análisis aquí mismo.");
  // La misión queda ✅ cuando ya hay clips de la campaña; si no, las fuentes quedan listas para sacarlos.
  if (!clips.some((x) => x.ready)) { log("  Fuentes listas: dale a «Sacar clips con esta campaña» en las que quieras."); return "pendiente"; }
  return "lista";
}

// ---------- MISIÓN 4 · Títulos y portadas ----------
async function mission4(cfg, id, log, { render, tools }) {
  const c = readCampaign(cfg, id);
  const clips = campaignClips(cfg, id).filter((x) => x.ready);
  const frases = (c.m1?.clave || []).map((f) => f.frase);
  const lista = clips.map((x) => `- id: ${x.jobId}/${x.id} · título: ${x.title} · de: ${x.source}`).join("\n");
  log(`Escribiendo títulos, hashtags y portadas${clips.length ? ` para ${clips.length} clips` : ""}…`);
  const out = await askJson(cfg, PROMPT,
    `MISIÓN 4 · TÍTULOS Y PORTADAS\nTema: ${c.tema}\nPúblico: ${c.publico}\nIdioma: ${c.idioma}\n` +
    `Frases clave (lo que busca la gente): ${frases.length ? frases.join(" | ") : "(todavía no se corrió la misión 1)"}\n` +
    `Fórmula de lo que más peta: ${c.m2?.formula ? JSON.stringify(c.m2.formula) : "(todavía no se corrió la misión 2)"}\n` +
    (clips.length ? `Clips de la campaña:\n${lista}\n` : "Todavía no hay clips de la campaña.\n") +
    `\n1) 20 títulos listos para usar, en MAYÚSCULAS como los de ClipSphere, con la fórmula y las frases clave.\n` +
    `2) 3 sets de hashtags (6 a 10 cada uno): amplio, nicho y local (RD / Latinoamérica).\n` +
    `3) Para cada clip, el texto de portada: 2 a 5 palabras, en MAYÚSCULAS, que se lea de lejos.`,
    { type: "object", required: ["titulos", "hashtags", "portadas"], properties: {
      titulos: { type: "array", items: { type: "string" } },
      hashtags: { type: "object", required: ["amplio", "nicho", "local"], properties: { amplio: { type: "array", items: { type: "string" } }, nicho: { type: "array", items: { type: "string" } }, local: { type: "array", items: { type: "string" } } } },
      portadas: { type: "array", items: { type: "object", required: ["id", "texto"], properties: { id: { type: "string" }, texto: { type: "string" } } } },
    } }, { name: "mision4", log });
  const tag = (h) => "#" + String(h).replace(/^#/, "").replace(/\s+/g, "");
  const hashtags = { amplio: (out.hashtags?.amplio || []).map(tag), nicho: (out.hashtags?.nicho || []).map(tag), local: (out.hashtags?.local || []).map(tag) };
  const portadas = [];
  const T = tools();
  for (const p of out.portadas || []) {
    const [jobId, clipId] = String(p.id).split("/");
    const clip = clips.find((x) => x.jobId === jobId && x.id === clipId);
    if (!clip) continue;
    const texto = String(p.texto || "").toUpperCase().slice(0, 60);
    portadas.push({ jobId, clipId, title: clip.title, texto });
    // El texto también va en la portada .jpg del clip (y queda en plan.json para futuros renders).
    const planFile = path.join(cfg.outputRoot, jobId, "plan.json");
    const plan = readJson(planFile);
    const pc = plan?.clips?.find((x) => x.id === clipId);
    if (pc) { pc.coverText = texto; writeAtomic(planFile, JSON.stringify(plan, null, 2)); }
    if (T.ffmpeg) await render.thumbnail({ ffmpeg: T.ffmpeg, jobDir: path.join(cfg.outputRoot, jobId), video: clip.file, outName: clip.cover, text: texto, fontFile: cfg.fontFile });
  }
  const cc = readCampaign(cfg, id);
  cc.m4 = { at: new Date().toISOString(), titulos: (out.titulos || []).map((t) => String(t).toUpperCase()).slice(0, 20), hashtags, portadas };
  saveCampaign(cfg, cc);
  log(`  ${cc.m4.titulos.length} títulos, 3 sets de hashtags y ${portadas.length} portadas${portadas.length ? " (ya puestas en los .jpg)" : ""}.`);
  if (!clips.length) log("  Cuando tengas clips de la campaña (Misión 3), vuelve a correr esta misión para ponerles su portada.");
}

// ---------- MISIÓN FINAL · El lanzamiento ----------
const DIA_RE = /mapa|secret|primer|gameplay|c[oó]mo |gu[ií]a|truco|d[oó]nde|misi[oó]n|personaje|easter|an[aá]lisis|todo lo que|review|rese[ñn]a|jugando|minutos/i;
const PRE_RE = /teor[ií]a|filtr|leak|tr[aá]iler|espera|fecha|precio|rumor|cu[aá]ndo|reacci[oó]n|predic|confirm|nuevo|anunci|expect|cuenta regresiva/i;

function buildCalendar(c, clips) {
  const L = new Date(c.fecha);
  const at = (dayOffset, h, m = 0) => {
    const p = rdParts(new Date(L.getTime() + dayOffset * 86400e3));
    return new Date(`${p.day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${TZ}`);
  };
  const pre = [
    { slot: "D-2 · noche", when: at(-2, 19) }, { slot: "D-1 · mediodía", when: at(-1, 12) }, { slot: "D-1 · noche", when: at(-1, 20) },
  ].filter((s) => s.when < L);
  const day = [{ slot: "🚀 Lanzamiento", when: L },
    ...[9, 12, 15, 18, 21].map((h) => ({ slot: `Día D · ${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "p. m." : "a. m."}`, when: at(0, h) })).filter((s) => s.when > L)];
  const extra = [12, 19].map((h) => ({ slot: `D+1 · ${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "p. m." : "a. m."}`, when: at(1, h) }));
  const text = (x) => `${x.title} ${x.description || ""} ${(x.hashtags || []).join(" ")}`;
  const ready = clips.filter((x) => x.ready).sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));
  const dayClips = ready.filter((x) => DIA_RE.test(text(x)) && !PRE_RE.test(x.title));
  const preClips = ready.filter((x) => !dayClips.includes(x));
  const items = [];
  const put = (slots, list) => { while (slots.length && list.length) items.push({ ...slots.shift(), clip: list.shift(), tipo: null }); };
  const preSlots = [...pre], daySlots = [...day];
  put(preSlots, preClips.map((x) => ({ x, tipo: "expectativa" })));
  put(daySlots, dayClips.map((x) => ({ x, tipo: "día del lanzamiento" })));
  // lo que sobre, en los huecos que queden (primero antes, luego el día, luego D+1)
  const rest = [...preClips.filter((x) => !items.some((i) => i.clip.x === x)), ...dayClips.filter((x) => !items.some((i) => i.clip.x === x))]
    .map((x) => ({ x, tipo: preClips.includes(x) ? "expectativa" : "día del lanzamiento" }));
  put(daySlots, rest); put(preSlots, rest); put([...extra], rest);
  for (let h = 2; rest.length; h++) put([{ slot: `D+${h} · 7:00 p. m.`, when: at(h, 19) }], rest); // más clips que horas: un día más cada uno
  return items.sort((a, b) => a.when - b.when).map((i) => ({
    slot: i.slot, at: rdIso(i.when), label: rdParts(i.when).label, tipo: i.clip.tipo,
    jobId: i.clip.x.jobId, clipId: i.clip.x.id, title: i.clip.x.title, coverText: i.clip.x.coverText || "",
  }));
}

async function mission5(cfg, id, log) {
  const c = readCampaign(cfg, id);
  const clips = campaignClips(cfg, id);
  if (!clips.some((x) => x.ready)) throw new Error("Todavía no hay clips listos en la campaña. Sácalos en la Misión 3 y vuelve.");
  const cal = buildCalendar(c, clips);
  c.m5 = { at: new Date().toISOString(), calendario: cal };
  saveCampaign(cfg, c);
  log(`  Calendario con ${cal.length} publicaciones, de ${cal[0]?.label} a ${cal[cal.length - 1]?.label} (hora de RD).`);
}

/** Paquete del día: carpeta con los clips en orden (01_, 02_…), sus portadas y publicar.txt. */
async function buildPackage(cfg, id, day) {
  const c = readCampaign(cfg, id);
  const cal = c.m5?.calendario || [];
  if (!cal.length) throw Object.assign(new Error("Primero corre la Misión final para armar el calendario."), { status: 400 });
  const days = [...new Set(cal.map((i) => i.at.slice(0, 10)))];
  const today = rdParts(new Date()).day;
  day = day && days.includes(day) ? day : days.find((d) => d >= today) || days[days.length - 1];
  const items = cal.filter((i) => i.at.slice(0, 10) === day);
  const folder = path.join(campDir(cfg, id), "paquetes", day);
  fs.mkdirSync(folder, { recursive: true });
  const clips = campaignClips(cfg, id);
  const h = c.m4?.hashtags;
  const lines = [`PAQUETE DEL DÍA · ${c.tema} · ${day} (hora de República Dominicana)`, `Lanzamiento: ${rdParts(new Date(c.fecha)).label}`, ""];
  let n = 0;
  for (const it of items) {
    const clip = clips.find((x) => x.jobId === it.jobId && x.id === it.clipId);
    if (!clip?.ready) continue;
    n++;
    const pre = String(n).padStart(2, "0") + "_" + slugify(clip.title).slice(0, 30);
    const src = path.join(cfg.outputRoot, it.jobId);
    await fs.promises.copyFile(path.join(src, clip.file), path.join(folder, pre + ".mp4"));
    if (fs.existsSync(path.join(src, clip.cover))) await fs.promises.copyFile(path.join(src, clip.cover), path.join(folder, pre + "_portada.jpg"));
    const tags = [...new Set([...(clip.hashtags || []), ...(h?.nicho || []).slice(0, 3)])].slice(0, 10).join(" ");
    lines.push(`${String(n).padStart(2, "0")} · ${it.label} · ${it.slot}`, `Archivo: ${pre}.mp4`, `Título: ${clip.title}`,
      `Descripción: ${(clip.description || "").trim()}`, `Hashtags: ${tags}`, clip.coverText ? `Texto de portada: ${clip.coverText}` : "", "");
  }
  if (!n) throw Object.assign(new Error(`El ${day} no tiene clips listos en el calendario.`), { status: 400 });
  lines.push("Recuerda: ClipSphere NO publica solo. Sube cada clip tú a su hora.");
  writeAtomic(path.join(folder, "publicar.txt"), lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\r\n"));
  const cc = readCampaign(cfg, id);
  cc.paquetes = [...(cc.paquetes || []).filter((p) => p.day !== day), { day, folder, clips: n, at: new Date().toISOString() }];
  saveCampaign(cfg, cc);
  return { day, folder, clips: n, days };
}

/** Lo que ve la pantalla: la campaña + estado real de la misión 3 (lista cuando ya hay clips). */
function viewCampaign(cfg, id) {
  const c = readCampaign(cfg, id);
  const clips = campaignClips(cfg, id);
  if (clips.some((x) => x.ready) && c.missions["3"].status !== "corriendo") c.missions["3"].status = "lista";
  return { ...c, clips, running: live.get(id)?.running || null, missionNames: MISSIONS };
}

module.exports = {
  MISSIONS, createCampaign, updateCampaign, listCampaigns, readCampaign, saveCampaign, deleteCampaign, viewCampaign,
  campaignClips, campaignBlock, runMission, buildPackage, subscribe, isRunning, campDir, rdParts, buildCalendar,
};
