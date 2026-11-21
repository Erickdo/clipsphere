// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
/**
 * UN ALGORITMO PARA CADA VIDEO — gratis, sin IA de pago.
 *
 * Antes de elegir los clips, ClipSphere estudia el video y arma su propio "perfil":
 *   1. ¿Qué tipo de contenido es?  (entrevista/chisme, gaming/stream, reality, comedia, deporte,
 *      música, noticias/política, educativo, religioso/motivacional, podcast)  → pesos y palabras de ese tipo
 *   2. Lo investiga en internet (todo gratis):
 *      · "Lo más repetido" de YouTube (heatmap): dónde la gente vuelve a ver el video
 *      · Comentarios con minutos ("12:34 jajaja"): dónde la gente dice que está lo bueno
 *      · Google (sugerencias): qué busca la gente del tema y de las personas del video
 *      · YouTube: títulos de los videos más vistos del mismo tema → palabras que pegan
 *   3. Junta todo en un perfil (tipo, pesos, palabras investigadas, señal de audiencia por segundo)
 *      que el motor local aplica SOLO a ese video.
 */
const fs = require("fs");
const path = require("path");
const { run, writeAtomic } = require("./util");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOP = new Set("el la los las un una unos unas de del al a en y o u que se no si es son fue por para con sin como mas pero ya muy yo tu el ella ellos eso esto esta este ese esa hay lo le les me te nos mi su sus video videos parte completo nuevo nueva oficial capitulo episodio ep hoy aqui asi todo todos the a an and or of to in on is it that this you i we for with official full new part episode live vivo directo shorts short clip clips 2024 2025 2026".split(" "));

// ---------- Tipos de contenido: cómo se reconocen y qué se busca en cada uno ----------
const TYPES = {
  chisme: {
    label: "Entrevista / chisme (\"dando los focos\")",
    detect: ["entrevista", "focos", "da los focos", "chisme", "farandula", "habla de", "responde", "rompe el silencio", "revela", "confiesa", "le tira", "tiradera", "beef", "polemica", "escandalo", "podcast", "alofoke", "show", "invitado", "verdad", "expone", "destapa"],
    weights: { audio: 0.2, lexico: 0.5, ritmo: 0.2, escenas: 0.1 },
    // hablar de gente: nombres, acusaciones, revelaciones, indirectas
    boost: { revelacion: 1.6, polemica: 1.6, gancho: 1.3, gente: 2.2 },
    focus: "Cuando se habla de otras personas, se revelan cosas o se tiran indirectas.",
  },
  gaming: {
    label: "Gaming / stream de juego",
    detect: ["gta", "roleplay", "rp", "fortnite", "minecraft", "free fire", "warzone", "cod", "fifa", "fc 25", "valorant", "lol", "gameplay", "stream", "kick", "twitch", "partida", "jugando", "speedrun", "servidor", "boss", "clutch"],
    weights: { audio: 0.4, lexico: 0.25, ritmo: 0.15, escenas: 0.2 },
    boost: { risa: 1.6, emocion: 1.4, polemica: 1.2 },
    focus: "Gritos, risas, choques, giros en la partida y reacciones fuertes.",
  },
  reality: {
    label: "Reality / convivencia",
    detect: ["reality", "casa", "la casa de", "nominacion", "eliminado", "eliminacion", "convivencia", "mansion", "participantes", "temporada", "gala", "isla"],
    weights: { audio: 0.35, lexico: 0.4, ritmo: 0.15, escenas: 0.1 },
    boost: { polemica: 1.8, gente: 1.6, emocion: 1.3 },
    focus: "Peleas, alianzas, traiciones y momentos de tensión entre participantes.",
  },
  comedia: {
    label: "Comedia / humor",
    detect: ["comedia", "humor", "chistes", "stand up", "standup", "bromas", "broma", "sketch", "parodia", "jajaja", "risa", "comico", "troleo", "prank"],
    weights: { audio: 0.35, lexico: 0.4, ritmo: 0.15, escenas: 0.1 },
    boost: { risa: 2.0, emocion: 1.2 },
    focus: "El remate del chiste y las risas del público.",
  },
  deporte: {
    label: "Deporte",
    detect: ["gol", "goles", "partido", "highlights", "resumen", "nba", "mlb", "beisbol", "boxeo", "ufc", "pelea", "futbol", "jonron", "knockout", "ko", "liga", "campeonato", "final"],
    weights: { audio: 0.45, lexico: 0.2, ritmo: 0.1, escenas: 0.25 },
    boost: { emocion: 1.6 },
    focus: "La jugada, el grito del narrador y la reacción del público.",
  },
  musica: {
    label: "Música / sesión en vivo",
    detect: ["musica", "cancion", "freestyle", "session", "sesion", "live session", "concierto", "en vivo desde", "dembow", "bachata", "merengue", "reggaeton", "rap", "tiradera", "videoclip"],
    weights: { audio: 0.45, lexico: 0.25, ritmo: 0.2, escenas: 0.1 },
    boost: { emocion: 1.3 },
    focus: "El coro, la barra más fuerte y la reacción de la gente.",
  },
  noticias: {
    label: "Noticias / política / debate",
    detect: ["noticias", "noticia", "politica", "gobierno", "presidente", "debate", "elecciones", "congreso", "senado", "denuncia", "ultima hora", "periodista", "analisis", "opinion"],
    weights: { audio: 0.2, lexico: 0.55, ritmo: 0.15, escenas: 0.1 },
    boost: { revelacion: 1.6, polemica: 1.5, gente: 1.5 },
    focus: "La frase más fuerte, el dato que sorprende y el choque de opiniones.",
  },
  educativo: {
    label: "Educativo / tutorial / tecnología",
    detect: ["como", "tutorial", "aprende", "curso", "clase", "explicado", "guia", "tips", "trucos", "programacion", "tecnologia", "ia", "inteligencia artificial", "review", "unboxing", "dinero", "negocio", "finanzas"],
    weights: { audio: 0.1, lexico: 0.6, ritmo: 0.2, escenas: 0.1 },
    boost: { revelacion: 1.8, gancho: 1.5 },
    focus: "El dato útil, el truco y las frases tipo \"nadie te dice esto\".",
  },
  motivacion: {
    label: "Motivación / religioso / reflexión",
    detect: ["motivacion", "reflexion", "predica", "iglesia", "dios", "pastor", "testimonio", "superacion", "exito", "mentalidad", "consejos de vida"],
    weights: { audio: 0.2, lexico: 0.55, ritmo: 0.15, escenas: 0.1 },
    boost: { enfasis: 1.6, gancho: 1.4, revelacion: 1.3 },
    focus: "Las frases contundentes que la gente comparte.",
  },
  podcast: {
    label: "Podcast / conversación",
    detect: ["podcast", "conversacion", "charla", "hablamos", "episodio", "ep."],
    weights: { audio: 0.25, lexico: 0.45, ritmo: 0.2, escenas: 0.1 },
    boost: { gente: 1.4, revelacion: 1.4, risa: 1.3, polemica: 1.3 },
    focus: "Historias, revelaciones, risas y opiniones sin filtro.",
  },
};

/** Tipo de contenido: título, descripción, etiquetas, plataforma y lo que se dice en el video. */
function detectType({ info, words, focus }) {
  if (focus === "gta") return { type: "gaming", why: "elegiste Streamers en Buscar" };
  if (focus === "peleas") return { type: "reality", why: "elegiste Peleas y discusiones en Buscar" };
  const meta = norm([info.title, info.description, (info.tags || []).join(" "), (info.categories || []).join(" "), info.uploader].join(" "));
  const speech = norm((words || []).slice(0, 4000).map((w) => w.w).join(" "));
  const plat = norm(info.platform);
  const scores = {};
  for (const [k, t] of Object.entries(TYPES)) {
    let s = 0;
    for (const d of t.detect) {
      const re = new RegExp(`(^|[^a-z])${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "g");
      s += 3 * ((meta.match(re) || []).length > 0 ? 1 : 0) + Math.min(3, (speech.match(re) || []).length * 0.15);
    }
    scores[k] = s;
  }
  if (/kick|twitch/.test(plat)) scores.gaming += 3;
  const cats = norm((info.categories || []).join(" "));
  if (/gaming/.test(cats)) scores.gaming += 4;
  if (/comedy/.test(cats)) scores.comedia += 4;
  if (/sports/.test(cats)) scores.deporte += 4;
  if (/music/.test(cats)) scores.musica += 4;
  if (/news|politics/.test(cats)) scores.noticias += 4;
  if (/education|science|howto/.test(cats)) scores.educativo += 4;
  if (/entertainment|people/.test(cats)) { scores.chisme += 1.5; scores.podcast += 1; }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return { type: "podcast", why: "no hay pistas claras: lo trato como conversación", scores };
  const hits = TYPES[best[0]].detect.filter((d) => meta.includes(d)).slice(0, 4);
  return { type: best[0], why: hits.length ? `el título/descripción dice: ${hits.join(", ")}` : "por lo que se habla en el video", scores };
}

// palabras de títulos que NO son nombres aunque vengan con mayúscula
const TITLE_WORDS = new Set("rompe silencio sobre habla hablo dice dijo revela revelo confiesa confeso responde respondio entrevista podcast focos verdad todo toda nunca jamas mira miren esto como cuando porque quien quienes donde nuevo nueva primera vez completo completa oficial reaccion reaccionando reacciona exclusiva exclusivo historia vida final real show programa capitulo temporada parte live envivo directo pelea polemica chisme escandalo".split(" "));
/** Tema y personas del video, sacados del título (para investigar). */
function topicOf(info, words = []) {
  const t = String(info.title || "").replace(/\(en vivo.*?\)/i, "").replace(/[#|\-–—:¡!¿?"“”«»()\[\],.]/g, " ").replace(/\p{Extended_Pictographic}/gu, " ");
  const toks = t.split(/\s+/).filter(Boolean);
  const spoken = new Set(norm((words || []).map((w) => w.w).join(" ") + " " + (info.description || "")).match(/\p{L}{3,}/gu) || []);
  const caps = toks.filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w)).length;
  const titleCase = caps >= toks.length * 0.7;
  // personas: palabras con mayúscula que no son palabras comunes de títulos; si el título viene Todo En Mayúscula Inicial,
  // solo cuentan las que también se dicen en el video o en la descripción
  const people = [];
  let cur = [];
  for (const w of toks) {
    const n = norm(w);
    const ok = /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}$/.test(w) && n !== "vs" && !STOP.has(n) && !TITLE_WORDS.has(n) && (!titleCase || spoken.has(n));
    if (ok) cur.push(w.charAt(0) + w.slice(1).toLowerCase()); else { if (cur.length) people.push(cur.join(" ")); cur = []; }
  }
  if (cur.length) people.push(cur.join(" "));
  const key = toks.filter((w) => w.length > 2 && !STOP.has(norm(w))).slice(0, 5).join(" ");
  return { key: key || info.uploader || "", people: [...new Set(people.filter((p) => p.length > 3))].slice(0, 4) };
}

async function suggest(q, lang, base) {
  const url = `${base || "https://suggestqueries.google.com/complete/search"}?client=firefox&ds=yt&hl=${encodeURIComponent(lang || "es")}&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/128.0" }, signal: AbortSignal.timeout(10000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let txt = buf.toString("utf8"); if (txt.includes("�")) txt = buf.toString("latin1");
    const j = JSON.parse(txt);
    return Array.isArray(j[1]) ? j[1].map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

/** "12:34" o "1:02:03" en un comentario → segundos. */
function stampsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:^|[^\d:])((?:(\d{1,2}):)?(\d{1,2}):(\d{2}))(?![\d:])/g)) {
    const h = +(m[2] || 0), mi = +m[3], s = +m[4];
    if (s < 60 && mi < 60) out.push(h * 3600 + mi * 60 + s);
  }
  return out;
}


// ======================= FASE 1 · Perfil estadístico del propio video =======================
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const meanOf = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const stdOf = (a) => { const m = meanOf(a); return Math.sqrt(meanOf(a.map((x) => (x - m) ** 2))); };
/** Qué tan "picuda" es una señal: parte de la energía que se concentra en el 10 % de segundos más altos (0.1 = plana, 1 = solo picos). */
function peakiness(arr) {
  const v = arr.filter((x) => x > 0).sort((a, b) => b - a);
  if (v.length < 10) return 0;
  const tot = v.reduce((s, x) => s + x, 0) || 1;
  return v.slice(0, Math.ceil(v.length * 0.1)).reduce((s, x) => s + x, 0) / tot;
}

/** Temas propios del video con TF-IDF por frases (+ título, descripción y etiquetas). */
function tfidfTerms(words, info, n = 15) {
  const docs = [];
  let cur = [];
  for (const w of words || []) { cur.push(w.w); if (/[.?!…]$/.test(w.w) || cur.length >= 25) { docs.push(cur.join(" ")); cur = []; } }
  if (cur.length) docs.push(cur.join(" "));
  const tf = {}, df = {};
  for (const d of docs) {
    const toks = (norm(d).match(/\p{L}{4,}/gu) || []).filter((x) => !STOP.has(x) && !/^(ja|je|ha)+$/.test(x));
    for (const x of toks) tf[x] = (tf[x] || 0) + 1;
    for (const x of new Set(toks)) df[x] = (df[x] || 0) + 1;
  }
  const meta = new Set(norm([info.title, info.description, (info.tags || []).join(" ")].join(" ")).match(/\p{L}{4,}/gu) || []);
  const N = docs.length || 1;
  return Object.fromEntries(Object.keys(tf)
    // un tema se concentra en partes del video; lo que sale en casi todas las frases es relleno (idf ≈ 0)
    .filter((x) => (tf[x] >= 3 || meta.has(x)) && df[x] / N < 0.25)
    .map((x) => [x, Math.sqrt(tf[x]) * Math.log((N + 1) / (df[x] + 1)) * (meta.has(x) ? 2 : 1)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(2)]));
}

/** Mide el video: acústica, ritmo y pausas, visual. */
function videoStats({ loudness = [], words = [], scenes = [], duration = 0 }) {
  const db = loudness.filter((x) => x > -70);
  const acoustic = db.length ? {
    media: +meanOf(db).toFixed(1), desviacion: +stdOf(db).toFixed(1),
    p50: +pct(db, 0.5).toFixed(1), p75: +pct(db, 0.75).toFixed(1), p90: +pct(db, 0.9).toFixed(1), p10: +pct(db, 0.1).toFixed(1),
  } : null;
  if (acoustic) {
    acoustic.rango = +(acoustic.p90 - acoustic.p10).toFixed(1);
    // un video que grita todo el tiempo (rango corto, nivel alto) vs uno calmado donde un grito destaca
    acoustic.estilo = acoustic.rango < 8 ? "parejo (casi siempre igual de fuerte)" : acoustic.rango > 16 ? "con picos marcados" : "normal";
    acoustic.picos = +peakiness(loudness.map((x) => (x > -70 ? Math.max(0, x - acoustic.p50) : 0))).toFixed(2);
  }
  const dur = duration || (words.length ? words[words.length - 1].t : 0);
  const gaps = [];
  for (let i = 1; i < words.length; i++) { const g = words[i].t - words[i - 1].t; if (g > 0.25 && g < 10) gaps.push(g); }
  const perSec = {}; for (const w of words) perSec[Math.floor(w.t)] = (perSec[Math.floor(w.t)] || 0) + 1;
  const talking = Object.values(perSec);
  const pacing = words.length > 30 ? {
    palabrasPorSegundo: +meanOf(talking).toFixed(2),
    palabrasPorMinuto: Math.round(words.length / Math.max(1, dur / 60)),
    tiempoHablando: +(talking.length / Math.max(1, dur)).toFixed(2),
    pausaTipica: +pct(gaps, 0.5).toFixed(2), pausaLarga: +pct(gaps, 0.9).toFixed(2),
  } : null;
  if (pacing) pacing.estilo = pacing.palabrasPorSegundo >= 3 ? "rápido" : pacing.palabrasPorSegundo <= 2 ? "pausado" : "normal";
  const visual = { cortesPorMinuto: +(scenes.length / Math.max(1, dur / 60)).toFixed(2) };
  visual.estilo = !scenes.length ? "sin medir" : visual.cortesPorMinuto >= 6 ? "dinámico (acción / gameplay / edición rápida)" : visual.cortesPorMinuto <= 1.5 ? "estático (charla / podcast)" : "normal";
  return { acoustic, pacing, visual };
}

/**
 * Ajusta los pesos del tipo con las estadísticas: una señal plana no sirve para distinguir momentos
 * (pesa menos); una con picos claros pesa más. Devuelve pesos normalizados (suman 1) y reglas de corte.
 */
function adaptAlgorithm(base, st, cfg) {
  const w = { ...base };
  const why = [];
  if (st.acoustic) {
    const f = st.acoustic.rango < 8 ? 0.5 : st.acoustic.rango > 16 ? 1.4 : 1;
    if (f !== 1) { w.audio *= f; why.push(f < 1 ? "el volumen es parejo: los gritos destacan poco, el audio pesa menos" : "el volumen tiene picos claros: el audio pesa más"); }
  } else { w.audio = 0; why.push("sin audio medido"); }
  if (st.visual.estilo.startsWith("dinámico")) { w.escenas *= 1.5; why.push("video dinámico: los cortes de imagen pesan más"); }
  else if (st.visual.estilo.startsWith("estático")) { w.escenas *= 0.3; why.push("video estático: los cortes de imagen casi no cuentan"); }
  if (st.pacing?.estilo === "rápido") { w.ritmo *= 0.7; why.push("se habla rápido todo el tiempo: el ritmo distingue menos"); }
  if (st.pacing?.estilo === "pausado") { w.ritmo *= 1.3; why.push("video pausado: cuando se acelera el habla, es señal de emoción"); }
  const tot = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  for (const k in w) w[k] = +(w[k] / tot).toFixed(3);
  // reglas de corte de este video
  const minS = +cfg.minSeconds || 30, maxS = Math.max(minS + 5, +cfg.maxSeconds || 90);
  const pace = st.pacing?.palabrasPorSegundo || 2.5;
  const duracionIdeal = Math.round(Math.min(maxS, Math.max(minS, minS + (maxS - minS) * (pace >= 3 ? 0.25 : pace <= 2 ? 0.7 : 0.45))));
  const pausaCorte = +Math.max(0.3, Math.min(1.2, (st.pacing?.pausaTipica || 0.5) * 1.3)).toFixed(2);
  const umbralGrito = st.acoustic ? +(st.acoustic.p90 + (st.acoustic.rango < 8 ? 3 : 0)).toFixed(1) : null;
  return { weights: w, rules: { duracionIdeal, pausaCorte, umbralGrito }, why };
}

/** Temas del momento configurables: ⚙️ Ajustes (texto) + archivo momento.txt junto a ClipSphere. */
function momentTerms(cfg) {
  let txt = String(cfg.momentTopics || "");
  try { txt += "," + fs.readFileSync(path.join(__dirname, "..", "momento.txt"), "utf8"); } catch {}
  return [...new Set(txt.split(/[,\n;]+/).map((x) => norm(x).trim()).filter((x) => x.length >= 3 && !x.startsWith("#")))].slice(0, 60);
}

/**
 * Arma el perfil del video. Todo es opcional: si algo falla o no hay internet, sigue con lo que tenga.
 * @returns {{type,typeLabel,why,focus,weights,boost,keywords:Object,heat:number[],marks:Array,sources:string[]}}
 */
async function buildProfile({ T, ck = [], info, words, cfg = {}, cacheDir, log = () => {}, signal, loudness = [], scenes = [] }) {
  const file = cacheDir && path.join(cacheDir, `profile_${cfg.focus || "todo"}.json`);
  if (file && fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {} }
  const { type, why } = detectType({ info, words, focus: cfg.focus });
  const t = TYPES[type];
  log(`🧠 Algoritmo de este video · tipo: ${t.label} (${why}).`);
  const sources = [];
  const dur = Math.ceil(info.duration || (words?.length ? words[words.length - 1].t + 5 : 0));
  const heat = new Array(dur).fill(0);
  const marks = [];

  // 1) "Lo más repetido" de YouTube
  if (Array.isArray(info.heatmap) && info.heatmap.length) {
    for (const h of info.heatmap) for (let s = Math.floor(h.start_time); s < Math.min(dur, Math.ceil(h.end_time)); s++) heat[s] = Math.max(heat[s], +h.value || 0);
    sources.push("lo más repetido de YouTube");
    log("  📈 Usando «lo más repetido» de YouTube: dónde la gente vuelve a ver el video.");
  }

  const research = cfg.research !== false && !info.isLive;
  const ytdlp = T?.ytdlp;
  // 2) Comentarios con minutos (solo YouTube, sin bajar el video)
  if (research && ytdlp && /youtube/i.test(info.platform) && dur > 120) {
    try {
      const tmp = path.join(cacheDir, "comments");
      fs.mkdirSync(tmp, { recursive: true });
      await run(ytdlp, [...ck, "--skip-download", "--no-warnings", "--write-comments", "--no-write-playlist-metafiles",
        "--extractor-args", "youtube:max_comments=300,300,0,0;comment_sort=top", "-o", "c.%(ext)s", info.webpage], { cwd: tmp, signal, allowFail: true });
      const jf = path.join(tmp, "c.info.json");
      if (fs.existsSync(jf)) {
        const cj = JSON.parse(fs.readFileSync(jf, "utf8"));
        for (const c of cj.comments || []) {
          const likes = Math.max(1, +c.like_count || 1);
          for (const s of stampsIn(c.text)) if (s < dur) marks.push({ t: s, w: Math.log2(1 + likes), text: String(c.text).slice(0, 80) });
        }
        if (!info.heatmap?.length && Array.isArray(cj.heatmap)) for (const h of cj.heatmap) for (let s = Math.floor(h.start_time); s < Math.min(dur, Math.ceil(h.end_time)); s++) heat[s] = Math.max(heat[s], +h.value || 0);
        sources.push(`${(cj.comments || []).length} comentarios`);
        log(`  💬 Leí ${(cj.comments || []).length} comentarios: ${marks.length} marcan un minuto exacto del video.`);
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    } catch (e) { if (signal?.aborted) throw e; }
  }
  for (const m of marks) for (let s = Math.max(0, m.t - 3); s < Math.min(dur, m.t + 25); s++) heat[s] += 0.25 * m.w * (s < m.t + 12 ? 1 : 0.5);

  // 3) Qué busca la gente (Google) + 4) títulos que pegan del mismo tema (YouTube)
  const keywords = {};
  const add = (txt, w) => { for (const x of norm(txt).match(/\p{L}{4,}/gu) || []) if (!STOP.has(x)) keywords[x] = (keywords[x] || 0) + w; };
  const { key, people } = topicOf(info, words);
  if (research && key) {
    const qs = [key, ...people.map((p) => p)].slice(0, 3);
    let n = 0;
    for (const q of qs) { const sg = await suggest(q, cfg.language, cfg.suggestUrl); n += sg.length; for (const x of sg) add(x.replace(new RegExp(q, "i"), ""), 1); await sleep(300); }
    if (n) { sources.push(`${n} búsquedas de Google`); log(`  🔎 Google: ${n} búsquedas de la gente sobre «${qs.join("», «")}».`); }
    if (ytdlp) {
      try {
        const r = await run(ytdlp, [...ck, "--flat-playlist", "-J", "--no-warnings", `ytsearch20:${key}`], { signal, allowFail: true });
        const ents = JSON.parse(r.stdout || "{}").entries || [];
        const views = ents.map((e) => +e.view_count || 0).sort((a, b) => b - a);
        const top = views[Math.floor(views.length / 3)] || 0;
        let used = 0;
        for (const e of ents) if ((+e.view_count || 0) >= top && e.title) { add(e.title, 1 + Math.log10(1 + (+e.view_count || 0)) / 3); used++; }
        if (used) { sources.push(`${used} videos más vistos del tema`); log(`  ▶️ YouTube: estudié los títulos de ${used} videos muy vistos del mismo tema.`); }
      } catch (e) { if (signal?.aborted) throw e; }
    }
  }
  // las personas del video valen más (hablar de gente)
  for (const p of people) for (const x of norm(p).match(/\p{L}{3,}/gu) || []) keywords[x] = (keywords[x] || 0) + 4;
  const topK = Object.fromEntries(Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 40));

  // temas propios del video (TF-IDF) y del momento (configurables)
  const own = tfidfTerms(words, info);
  for (const [k, v] of Object.entries(own)) keywords[k] = (keywords[k] || 0) + v;
  const moment = momentTerms(cfg);
  for (const x of moment) for (const k of x.match(/\p{L}{3,}/gu) || []) keywords[k] = (keywords[k] || 0) + 6;
  const topK2 = Object.fromEntries(Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 50));

  const hasHeat = heat.some((x) => x > 0);
  const st = videoStats({ loudness, words, scenes, duration: dur });
  const adapted = adaptAlgorithm({ ...t.weights, ...(hasHeat ? { audiencia: marks.length >= 3 || info.heatmap?.length ? 0.45 : 0.25 } : {}) }, st, cfg);
  log(`  📊 Este video: volumen ${st.acoustic ? st.acoustic.estilo + ` (normal ${st.acoustic.p50} dB, picos desde ${st.acoustic.p90} dB)` : "sin medir"} · habla ${st.pacing ? st.pacing.estilo + ` (${st.pacing.palabrasPorSegundo} palabras/s, pausa típica ${st.pacing.pausaTipica} s)` : "sin medir"} · imagen ${st.visual.estilo}.`);
  for (const y of adapted.why) log(`  ↳ ${y}`);
  log(`  ✂️ Reglas de corte: clips de ~${adapted.rules.duracionIdeal} s, cortar en pausas de ${adapted.rules.pausaCorte} s o más.`);
  const profile = {
    type, typeLabel: t.label, why, focus: t.focus,
    stats: st, rules: adapted.rules, adjustments: adapted.why, ownTerms: Object.keys(own), momentTerms: moment,
    weights: adapted.weights,
    boost: t.boost, keywords: topK2, people,
    heat: hasHeat ? heat.map((x) => +x.toFixed(3)) : [],
    marks: marks.sort((a, b) => b.w - a.w).slice(0, 30),
    sources,
  };
  log(`  ⚙️ Pesos para este video: ${Object.entries(profile.weights).map(([k, v]) => `${k} ${v}`).join(" · ")}${Object.keys(topK).length ? ` · palabras investigadas: ${Object.keys(topK).slice(0, 8).join(", ")}` : ""}.`);
  if (file) writeAtomic(file, JSON.stringify(profile));
  return profile;
}

module.exports = { buildProfile, detectType, topicOf, stampsIn, TYPES, videoStats, adaptAlgorithm, tfidfTerms };
