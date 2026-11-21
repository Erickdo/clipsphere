// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
/**
 * MOTOR LOCAL DE MOMENTOS — 100 % gratis, sin claves, sin internet.
 *
 *   audio 8 kHz ──► volumen por segundo (loud.js) ─┐
 *   palabras con tiempo (subtítulos / Whisper) ─────┼─► puntaje por segundo ─► ventanas por frase ─► top N sin solapes
 *   video (opcional) ──► cambios de escena (scdet) ─┘          (pesos configurables)        (bordes en pausas naturales)
 *
 * Señales (cada una normalizada 0..1 por percentiles DENTRO del mismo video):
 *   audio   · subidas de volumen (gritos, risas, aplausos, discusión) + golpes bruscos respecto a los segundos previos
 *   lexico  · ganchos, preguntas, énfasis, emoción, polémica, risas, números, jerga dominicana (diccionario propio)
 *   ritmo   · palabras por segundo (hablar rápido = emoción)
 *   escenas · cortes de cámara / cambios bruscos de imagen
 *
 * Devuelve lo mismo que la IA: { clips:[{start,end,title,hook,description,hashtags,label,category,score,context,angle}], skipped:[] }
 */

// ---------- Pesos (ajustables desde ⚙️ Ajustes → Motor local) ----------
const WEIGHTS = {
  todo:   { audio: 0.30, lexico: 0.40, ritmo: 0.20, escenas: 0.10 },
  peleas: { audio: 0.45, lexico: 0.35, ritmo: 0.15, escenas: 0.05 },
  gta:    { audio: 0.40, lexico: 0.30, ritmo: 0.15, escenas: 0.15 },
};
const TUNING = {
  hookSeconds: 3,        // el gancho: lo que pasa en los primeros segundos pesa más
  hookWeight: 0.35,
  peakWeight: 0.35,      // el mejor tramo de 5 s dentro del clip
  deadPenalty: 0.04,     // por cada segundo seguido "muerto" por encima de 6 s
  minGapBetween: 4,      // segundos mínimos entre clips elegidos
  perMinutes: 3,         // como mucho ~1 clip cada 3 min de video
  keepRatio: 0.5,        // solo clips por encima de la mitad del camino entre un tramo normal (mediana) y el mejor
};

// ---------- Diccionario (es + en + jerga RD). Peso por palabra/expresión ----------
const LEX = {
  gancho: { w: 2.0, words: ["mira", "miren", "escucha", "escuchen", "ojo", "atención", "nadie", "secreto", "verdad", "la verdad", "te digo", "les digo", "imagínate", "sabías", "sabes qué", "lo que pasó", "resulta que", "de repente", "spoiler", "listen", "look", "nobody", "secret", "truth", "the thing is", "guess what"] },
  enfasis: { w: 1.0, words: ["nunca", "jamás", "increíble", "brutal", "demasiado", "literalmente", "en serio", "de verdad", "totalmente", "imposible", "never", "always", "literally", "seriously", "insane", "crazy", "huge"] },
  emocion: { w: 1.6, words: ["wow", "dios mío", "diablo", "diache", "coño", "mierda", "carajo", "locura", "ayy", "oh no", "no puede ser", "me muero", "omg", "oh my god", "what", "holy", "damn", "bro"] },
  polemica: { w: 2.2, words: ["mentira", "mentiroso", "culpa", "robó", "robaste", "traición", "traicionó", "pelea", "pelear", "fuera", "cállate", "respeta", "respeto", "falso", "falsa", "hipócrita", "problema", "lío", "bulla", "gaboche", "chisme", "puya", "indirecta", "me debes", "págame", "vete", "lárgate", "liar", "fake", "shut up", "fight", "beef", "drama", "disrespect"] },
  risa: { w: 2.6, words: ["jaja", "jajaja", "jajajaja", "jeje", "jsjs", "[risas]", "(risas)", "[risa]", "risas", "haha", "hahaha", "lol", "lmao", "[laughter]", "(laughs)", "[laughs]"] },
  revelacion: { w: 1.8, words: ["por qué", "cómo", "cuánto", "descubrí", "confieso", "confesión", "nadie sabe", "lo que no", "la razón", "el problema es", "el truco", "why", "how", "the reason", "nobody knows", "confess"] },
  gente: { w: 1.5, words: ["dijo que", "me dijeron", "anda diciendo", "habló de", "hablo de", "su esposa", "su mujer", "su marido", "su ex", "la ex", "el ex", "su novia", "su novio", "esa mujer", "ese tipo", "ese hombre", "esa gente", "fulano", "fulana", "le tiró", "le tiro", "tiradera", "le faltó", "le falto", "con quién", "se acostó", "lo dejó", "la dejó", "le pegó", "traicionó", "me traicionó", "ella dijo", "él dijo", "he said", "she said", "his wife", "her ex"] },
  rd: { w: 0.5, words: ["manito", "tiguere", "tíguere", "vaina", "klk", "jevi", "ombe", "concho", "de pinga", "ta' to", "un chin", "buen tiguere", "qué lo que", "e' verdad", "manín", "pana", "bacano", "chévere"] },
};
const STOP = new Set("el la los las un una unos unas de del al a en y o u que se no si sí es son fue ser era lo le les me te nos mi mis tu tus su sus por para con sin como más pero ya muy yo tú él ella ellos ellas eso esto esta este ese esa hay ha he han tiene tengo tiene van voy vamos eh ah pues entonces así aquí ahí allá también porque cuando donde qué cómo cuál está estoy estaba están bien todo nada algo uno dos tres the a an and or of to in on is it that this you i we they he she was be are for with as at so but not do".split(" "));
const LABEL_BY = { gente: ["chisme", "Chisme / hablan de gente", "B"], risa: ["humor", "Reacción graciosa", "C"], polemica: ["polemica", "Pelea/Gaboche", "B"], audio: ["tension", "Momento tenso", "A"], escenas: ["momento_epico", "Acción/Persecución", "A"], revelacion: ["revelacion", "Revelación", "D"], emocion: ["reaccion", "Reacción", "C"], gancho: ["revelacion", "Frase célebre", "D"], enfasis: ["emotivo", "Real talk", "D"] };
const EMOJI = { chisme: "👀", humor: "😂", polemica: "🔥", tension: "😱", momento_epico: "💥", revelacion: "👀", reaccion: "😳", emotivo: "💯" };

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const LEXN = Object.fromEntries(Object.entries(LEX).map(([k, v]) => [k, { w: v.w, words: v.words.map(norm) }]));

/** Percentil-rank 0..1 de cada valor (robusto ante videos con volumen raro). */
function rank01(arr) {
  const vals = arr.filter((x) => x > 0).sort((a, b) => a - b);
  if (!vals.length) return arr.map(() => 0);
  return arr.map((x) => {
    if (x <= 0) return 0;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= x) lo = m + 1; else hi = m; }
    return lo / vals.length;
  });
}
const smooth = (a, r = 1) => a.map((_, i) => { let s = 0, n = 0; for (let j = i - r; j <= i + r; j++) if (j >= 0 && j < a.length) { s += a[j]; n++; } return s / n; });

/** Puntos léxicos de un texto y qué clases aparecieron. */
function lexScore(text, prof = null) {
  const t = " " + norm(text).replace(/[^\p{L}\p{N}\[\]()?!' ]+/gu, " ").replace(/\s+/g, " ") + " ";
  let pts = 0; const hits = {};
  for (const [k, { w, words }] of Object.entries(LEXN)) {
    for (const x of words) {
      if (t.includes(" " + x + " ") || (x.length > 4 && t.includes(x))) { pts += w * (prof?.boost?.[k] || 1); hits[k] = (hits[k] || 0) + 1; }
    }
  }
  const raw = String(text || "");
  const q = (raw.match(/\?/g) || []).length, ex = (raw.match(/!/g) || []).length;
  if (q) { pts += 1.2 * q; hits.revelacion = (hits.revelacion || 0) + q; }
  if (ex) { pts += 0.8 * ex; hits.emocion = (hits.emocion || 0) + ex; }
  if (/\d/.test(raw)) pts += 0.6;
  if (prof?.kw) { // palabras investigadas en internet para ESTE video (y las personas de las que se habla)
    for (const x of t.match(/\p{L}{3,}/gu) || []) if (prof.kw[x]) { pts += prof.kw[x]; if (prof.people?.has(x)) hits.gente = (hits.gente || 0) + 1; }
  }
  if (/\b[A-ZÁÉÍÓÚÑ]{4,}\b/.test(raw)) pts += 0.5; // gritos escritos en mayúsculas
  return { pts, hits };
}

/** Frases (oraciones) a partir de palabras con tiempo: cortan en . ? ! o en pausas. */
function sentences(words) {
  const out = []; let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], nx = words[i + 1];
    if (!cur) cur = { start: w.t, words: [] };
    cur.words.push(w.w);
    const gap = nx ? nx.t - w.t : 99;
    const endPunct = /[.?!…]["»”)]?$/.test(w.w);
    if (endPunct || gap >= 0.9 || cur.words.length >= 40 || !nx) {
      cur.end = Math.min(w.t + Math.max(0.35, Math.min(gap, 1.2)) - 0.05, nx ? nx.t - 0.05 : w.t + 1);
      cur.pauseAfter = gap; cur.text = cur.words.join(" ");
      out.push(cur); cur = null;
    }
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array<{t:number,w:string}>} p.words  palabras con tiempo (segundos)
 * @param {number[]} [p.loudness]  dB por segundo (índice = segundo absoluto)
 * @param {number[]} [p.scenes]    segundos donde hubo corte de escena
 * @param {object} p.cfg           minSeconds, maxSeconds, focus, localWeights, liveScan
 * @param {object} [p.info]        uploader, title (para hashtags)
 */
function pickLocal({ words, loudness = [], scenes = [], cfg = {}, info = {}, range = null, profile = null, log = () => {} }) {
  words = (words || []).filter((w) => w && isFinite(w.t) && w.w).sort((a, b) => a.t - b.t);
  if (words.length < 10) return { clips: [], skipped: [] };
  const t0 = range ? Math.max(0, Math.floor(range[0])) : 0;
  const T = Math.ceil(range ? range[1] : Math.max(words[words.length - 1].t + 2, loudness.length));
  const N = Math.max(1, T - t0);
  const minS = +cfg.minSeconds || 30, maxS = Math.max(minS + 5, +cfg.maxSeconds || 90);
  const W = { audiencia: 0, ...(profile?.weights || WEIGHTS[cfg.focus] || WEIGHTS.todo), ...(cfg.localWeights || {}) };
  // refuerzos de este video: palabras investigadas (0..2.5 puntos) y personas
  let prof = null;
  if (profile) {
    const kv = Object.entries(profile.keywords || {}), mx = Math.max(1, ...kv.map(([, v]) => v));
    const people = new Set((profile.people || []).flatMap((p) => norm(p).match(/\p{L}{3,}/gu) || []));
    prof = { boost: profile.boost || {}, kw: Object.fromEntries(kv.map(([k, v]) => [k, +(2.5 * v / mx).toFixed(2)])), people };
  }

  // ----- señales por segundo -----
  const lexRaw = new Array(N).fill(0), wps = new Array(N).fill(0), hitsAt = Array.from({ length: N }, () => ({}));
  const sents = sentences(words).filter((s) => s.end > t0 && s.start < T);
  for (const s of sents) {
    const { pts, hits } = lexScore(s.text, prof);
    const a = Math.max(0, Math.floor(s.start) - t0), b = Math.min(N - 1, Math.ceil(s.end) - t0);
    const per = pts / Math.max(1, b - a + 1);
    for (let i = a; i <= b; i++) { lexRaw[i] += per; for (const k in hits) hitsAt[i][k] = (hitsAt[i][k] || 0) + hits[k]; }
  }
  for (const w of words) { const i = Math.floor(w.t) - t0; if (i >= 0 && i < N) wps[i]++; }

  const loudSec = Array.from({ length: N }, (_, i) => loudness[i + t0] ?? -90);
  const valid = loudSec.filter((x) => x > -70).sort((a, b) => a - b);
  const med = valid.length ? valid[Math.floor(valid.length / 2)] : -30;
  const audRaw = loudSec.map((db, i) => {
    if (db <= -70) return 0;
    const prev = (loudSec[i - 1] ?? db) + (loudSec[i - 2] ?? db) + (loudSec[i - 3] ?? db);
    const jump = Math.max(0, db - prev / 3); // golpe brusco
    return Math.max(0, db - med) + 0.7 * jump;
  });
  const scnRaw = new Array(N).fill(0);
  for (const s of scenes) { const i = Math.floor(s) - t0; if (i >= 0 && i < N) scnRaw[i] += 1; }

  const heatRaw = Array.from({ length: N }, (_, i) => profile?.heat?.[i + t0] || 0);
  const A = rank01(smooth(audRaw, 1)), L = rank01(smooth(lexRaw, 2)), R = rank01(smooth(wps, 2)), S = rank01(smooth(scnRaw, 2)), H = rank01(heatRaw);
  const haveAudio = valid.length > N * 0.3, haveScenes = scenes.length > 3, haveHeat = heatRaw.some((x) => x > 0);
  const w = { audio: haveAudio ? W.audio : 0, lexico: W.lexico, ritmo: W.ritmo, escenas: haveScenes ? W.escenas : 0, audiencia: haveHeat ? W.audiencia || 0 : 0 };
  const sumW = w.audio + w.lexico + w.ritmo + w.escenas + w.audiencia || 1;
  const C = A.map((_, i) => (w.audio * A[i] + w.lexico * L[i] + w.ritmo * R[i] + w.escenas * S[i] + w.audiencia * H[i]) / sumW);
  // segundos muertos: sin palabras y sin volumen
  const dead = C.map((_, i) => wps[i] === 0 && (!haveAudio || A[i] < 0.25));
  log(`Motor local: ${N} s analizados · señales: ${[haveHeat && "audiencia (YouTube/comentarios)", haveAudio && "volumen", "palabras", "ritmo", haveScenes && "escenas"].filter(Boolean).join(", ")}.`);

  // prefijos y máximos de 5 s para puntuar ventanas en O(1)
  const pre = [0]; for (const x of C) pre.push(pre[pre.length - 1] + x);
  const mean = (a, b) => (pre[b] - pre[a]) / Math.max(1, b - a);
  const roll5 = C.map((_, i) => mean(i, Math.min(N, i + 5)));
  const deadRun = new Array(N).fill(0); for (let i = 0; i < N; i++) deadRun[i] = dead[i] ? (deadRun[i - 1] || 0) + 1 : 0;

  // ----- ventanas: empiezan al inicio de una frase y terminan al final de otra (pausa natural) -----
  const cands = [];
  for (let i = 0; i < sents.length; i++) {
    const st = sents[i].start;
    if (st < t0) continue;
    const a = Math.floor(st) - t0;
    // un buen arranque: la frase anterior terminó con pausa o puntuación (no a mitad de idea)
    const cleanStart = i === 0 || sents[i - 1].pauseAfter >= 0.35 || /[.?!…]$/.test(sents[i - 1].text);
    for (let j = i; j < sents.length; j++) {
      const en = sents[j].end, d = en - st;
      if (d > maxS) break;
      if (d < minS) continue;
      const b = Math.min(N, Math.ceil(en) - t0);
      let peak = 0, maxDead = 0;
      for (let k = a; k < b; k += 1) { if (roll5[k] > peak) peak = roll5[k]; if (deadRun[k] > maxDead) maxDead = deadRun[k]; }
      const hook = mean(a, Math.min(b, a + TUNING.hookSeconds));
      const cleanEnd = sents[j].pauseAfter >= 0.35 || /[.?!…]$/.test(sents[j].text);
      let score = (1 - TUNING.hookWeight - TUNING.peakWeight) * mean(a, b) + TUNING.peakWeight * peak + TUNING.hookWeight * hook;
      score -= TUNING.deadPenalty * Math.max(0, maxDead - 6);
      if (!cleanStart) score *= 0.85;
      if (!cleanEnd) score *= 0.9;
      cands.push({ i, j, start: st, end: en, a, b, score, peak, hook });
    }
  }
  if (!cands.length) return { clips: [], skipped: [] };
  cands.sort((x, y) => y.score - x.score);

  // ----- top N sin solapes -----
  const best = cands[0].score;
  const maxClips = cfg.liveScan ? 3 : Math.max(1, Math.ceil(N / 60 / TUNING.perMinutes));
  const medScore = cands[Math.floor(cands.length / 2)].score;
  const thr = cfg.liveScan && (cfg.liveScan.minutesSinceClip || 0) >= 15 ? 0 : medScore + TUNING.keepRatio * (best - medScore);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= maxClips || c.score < thr) break;
    if (chosen.some((k) => c.start < k.end + TUNING.minGapBetween && c.end > k.start - TUNING.minGapBetween)) continue;
    chosen.push(c);
  }
  chosen.sort((x, y) => x.start - y.start);
  // Contexto: si justo antes hay una frase fuerte (lo que inicia el pleito, la pregunta), se incluye
  for (let n = 0; n < chosen.length; n++) {
    const c = chosen[n];
    for (let k = 0; k < 2; k++) {
      const p = sents[c.i - 1];
      if (!p || c.start - p.end > 1.5 || c.end - p.start > maxS || lexScore(p.text, prof).pts < 1.5) break;
      if (n > 0 && p.start < chosen[n - 1].end + 1) break;
      c.i--; c.start = p.start; c.a = Math.max(0, Math.floor(p.start) - t0);
    }
  }

  // ----- textos del clip sin IA -----
  const docFreq = {};
  for (const s of sents) for (const x of new Set(norm(s.text).match(/\p{L}{5,}/gu) || [])) docFreq[x] = (docFreq[x] || 0) + 1;
  const clips = chosen.map((c) => {
    const inClip = sents.slice(c.i, c.j + 1);
    const hits = {};
    for (let k = c.a; k < c.b; k++) for (const h in hitsAt[k]) hits[h] = (hits[h] || 0) + hitsAt[k][h] * (LEX[h]?.w || 1);
    const audioShare = A.slice(c.a, c.b).reduce((s, x) => s + x, 0) / Math.max(1, c.b - c.a);
    const scnShare = S.slice(c.a, c.b).reduce((s, x) => s + x, 0) / Math.max(1, c.b - c.a);
    const kinds = Object.entries({ ...hits, audio: haveAudio && audioShare > 0.6 ? audioShare * 8 : 0, escenas: haveScenes && scnShare > 0.6 ? scnShare * 6 : 0, rd: 0 }).sort((x, y) => y[1] - x[1]);
    let top = kinds[0]?.[0] || "emocion";
    if ((hits.risa || 0) >= 2 * LEX.risa.w && top !== "polemica") top = "risa"; // varias risas = humor
    const [label, category, context] = LABEL_BY[top] || LABEL_BY.emocion;
    // frase más fuerte (4–14 palabras) para el título; la primera, para el gancho
    const strong = inClip.map((s) => ({ s, p: lexScore(s.text, prof).pts + (s.words.length >= 4 && s.words.length <= 14 ? 1 : 0) })).sort((x, y) => y.p - x.p)[0].s;
    const clean = (t) => t.replace(/^(eh+|ah+|y|pues|entonces|bueno|o sea|este|mm+)[ ,]+/i, "").replace(/\s+/g, " ").trim();
    const hook = clean(inClip[0].text).slice(0, 110);
    let title = clean(strong.text).replace(/^((ja|je|ha|js)+[!¡,. ]*)+/i, "").replace(/[.,;:]+$/, "").toUpperCase() || clean(strong.text).toUpperCase();
    if (title.length > 58) title = title.slice(0, 58).replace(/\s+\S*$/, "") + "…";
    title += " " + (EMOJI[label] || "🔥");
    const second = inClip.find((s) => s !== inClip[0] && s.words.length >= 5);
    const description = `«${hook}»${second ? " " + clean(second.text).slice(0, 140) : ""}`;
    const freq = {};
    for (const s of inClip) for (const x of norm(s.text).match(/\p{L}{5,}/gu) || []) if (!STOP.has(x) && !/^(ja|je|ha)+$/.test(x)) freq[x] = (freq[x] || 0) + 1;
    const tags = Object.entries(freq).map(([x, n]) => [x, n / Math.sqrt(1 + (docFreq[x] || 0))]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([x]) => "#" + x);
    const up = norm(info.uploader || "").replace(/[^a-z0-9]/g, "");
    const hashtags = [...tags, ...(up ? ["#" + up] : []), "#clips", "#viral"].slice(0, 6);
    const reasons = [];
    const heatShare = haveHeat ? H.slice(c.a, c.b).reduce((s2, x) => s2 + x, 0) / Math.max(1, c.b - c.a) : 0;
    const mk = (profile?.marks || []).filter((m) => m.t >= c.start - 3 && m.t <= c.end);
    if (mk.length) reasons.push(mk.length === 1 ? "un comentario marca este minuto" : `${mk.length} comentarios marcan este minuto`);
    if (heatShare > 0.6) reasons.push("la gente lo vuelve a ver en YouTube");
    if (hits.gente) reasons.push("se habla de otra persona");
    if (haveAudio && audioShare > 0.6) reasons.push("el volumen sube fuerte");
    if (hits.risa) reasons.push("hay risas");
    if (hits.polemica) reasons.push("hay choque o reclamo");
    if (hits.revelacion) reasons.push("deja una pregunta o revelación");
    if (mean(c.a, Math.min(c.b, c.a + 3)) > 0.6) reasons.push("arranca fuerte");
    const r = R.slice(c.a, c.b).reduce((s, x) => s + x, 0) / Math.max(1, c.b - c.a);
    if (r > 0.65) reasons.push("se habla rápido");
    const score = Math.round(60 + 40 * Math.max(0, Math.min(1, (c.score - thr) / Math.max(1e-6, best - thr))));
    return {
      start: +c.start.toFixed(2), end: +c.end.toFixed(2), title, hook, description, hashtags, label, category,
      context, angle: reasons.length ? "Funciona porque " + reasons.slice(0, 3).join(", ") + "." : "El tramo con más energía de esta parte.",
      score, seriesId: null, part: null, totalParts: null,
    };
  });
  return { clips, skipped: [] };
}

/** Cambios de escena (segundos) con el filtro scdet de ffmpeg sobre una versión pequeña del video. */
function detectScenes(ffmpeg, file, signal) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-nostats", "-threads", "0", "-i", file, "-an", "-sn",
      "-vf", "fps=4,scale=160:-2,scdet=threshold=12:sc_pass=1,metadata=print:file=-", "-f", "null", "-"], { windowsHide: true });
    const out = []; let buf = "";
    const kill = () => { try { p.kill(); } catch {} };
    signal?.addEventListener("abort", kill);
    const eat = (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = /lavfi\.scd\.time=([\d.]+)/.exec(l); if (m) out.push(+m[1]); } };
    p.stdout.on("data", eat); p.stderr.on("data", eat);
    p.on("close", () => { signal?.removeEventListener("abort", kill); resolve(out); });
    p.on("error", () => resolve([]));
  });
}

module.exports = { pickLocal, detectScenes, WEIGHTS, TUNING, LEX, lexScore, sentences };
