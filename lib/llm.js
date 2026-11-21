// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// Los CLIPS los elige siempre el motor local (lib/local.js + lib/research.js): gratis, sin claves.
// Este archivo solo conserva IA GRATUITA para escribir textos de 🚀 Lanzamientos:
//   · Google Gemini (nivel gratis, con clave)   · Ollama (corre en tu PC)
// Sin IA de pago: se eliminó Claude/Anthropic (v1.9).
const fs = require("node:fs");

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

/** Si el modelo configurado no existe, elige el Flash más nuevo que permita generateContent. */
async function resolveGeminiModel(cfg, log) {
  // Vacío o el viejo de fábrica = automático: el Flash más nuevo disponible para esta clave.
  let want = String(cfg.geminiModel || "").trim().replace(/^models\//, "");
  if (want === "gemini-2.5-flash") want = "";
  const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": cfg.geminiKey } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${j?.error?.message || "clave inválida"}`);
  const ok = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
  if (want && ok.includes(want)) { cfg.geminiBackups = []; return want; }
  const flash = ok.filter((n) => /flash/i.test(n) && !/lite|image|tts|live|audio|thinking-exp|embedding/i.test(n));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  flash.sort((a, b) => ver(b) - ver(a) || (/preview|exp/.test(a) ? 1 : 0) - (/preview|exp/.test(b) ? 1 : 0));
  const lite = ok.filter((n) => /flash-lite/i.test(n)).sort((a, b) => ver(b) - ver(a));
  const pick = flash[0] || ok.find((n) => /gemini/.test(n));
  if (!pick) throw new Error("Tu clave de Gemini no tiene modelos disponibles.");
  // Modelos de repuesto, por si el elegido no tiene cupo gratis.
  cfg.geminiBackups = [...flash.slice(1), ...lite].filter((n) => n !== pick);
  log(want ? `Modelo ${want} no disponible; usando ${pick}` : `Modelo de Gemini: ${pick}`);
  return pick;
}

async function callGemini(cfg, user, log, { system = "" } = {}) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.5, maxOutputTokens: 8192 },
  });
  let lastMsg = "", switches = 0, netFails = 0;
  const tried = new Set([cfg.geminiModel]);
  const nextModel = (why) => {
    const next = (cfg.geminiBackups || []).find((n) => !tried.has(n));
    if (!next) return false;
    cfg.geminiBackups = cfg.geminiBackups.filter((n) => n !== next);
    log(`  ${cfg.geminiModel} ${why}; probando con ${next}…`);
    cfg.geminiModel = next; tried.add(next); switches++;
    return true;
  };
  for (let attempt = 0; attempt < 4 && switches < 8; attempt++) {
    let res;
    try {
      res = await fetch(`${GEMINI}/models/${cfg.geminiModel}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey }, body,
        signal: AbortSignal.timeout(240000),
      });
    } catch (e) {
      // Corte de internet o respuesta demasiado lenta: esperar y reintentar.
      netFails++;
      const why = e.name === "TimeoutError" ? "Google tardó demasiado en responder" : `se cortó la conexión (${e.cause?.code || e.message})`;
      if (netFails >= 4) throw new Error(`No se pudo conectar con Gemini: ${why}. Revisa el internet de esta PC y dale a Reintentar.`);
      if (e.name === "TimeoutError" && nextModel("tardó demasiado")) { attempt = -1; continue; }
      log(`  Gemini: ${why}; reintento en ${10 * netFails} s…`);
      await new Promise((r) => setTimeout(r, 10000 * netFails));
      attempt--; continue;
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status === 503) {
      const raw = JSON.stringify(j);
      lastMsg = j?.error?.message || lastMsg;
      // Sin cupo gratis en este modelo (limit: 0), cupo diario agotado, o ya esperamos una vez: probar otro modelo.
      const noQuota = /limit:\s*0\b/i.test(raw), daily = /per ?day/i.test(raw);
      if ((noQuota || daily || attempt >= 1) && nextModel(`sin cupo gratis${daily ? " por hoy" : ""}`)) {
        attempt = -1; // los intentos empiezan de nuevo con el otro modelo
        continue;
      }
      if (daily || noQuota) throw new Error("Se acabó el cupo gratis de Gemini por hoy. Vuelve mañana.");
      // Límite gratis por minuto: esperar lo que pide Google y reintentar
      const d = raw.match(/"retryDelay"\s*:\s*"(\d+)/);
      const wait = Math.min(70, d ? +d[1] + 2 : 20 * (attempt + 1));
      log(`  Gemini pidió esperar (límite gratis por minuto); reintento en ${wait} s…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    // Google retira modelos y dice cuál usar: se cambia solo a ese y se reintenta.
    const sug = res.status === 404 && String(j?.error?.message || "").match(/use\s+models\/([\w.\-]+)/i);
    if (sug && !tried.has(sug[1])) {
      log(`  Google retiró ${cfg.geminiModel}; cambiando a ${sug[1]}…`);
      cfg.geminiModel = sug[1]; tried.add(sug[1]);
      continue;
    }
    if (res.status === 404 && nextModel("no está disponible para esta clave")) { attempt = -1; continue; }
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${j?.error?.message || ""}`);
    const parts = j.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text) throw new Error(`Gemini no devolvió texto (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "sin motivo"})`);
    return text;
  }
  throw new Error("Gemini sigue sin dejar usar la clave gratis después de varios intentos. Espera unos minutos y dale a Reintentar." + (lastMsg ? ` (Google dice: ${lastMsg.slice(0, 220)})` : ""));
}

/** Si el modelo configurado no está instalado, usa el mejor que haya en Ollama. */
async function resolveOllamaModel(cfg, log) {
  const base = cfg.ollamaUrl || "http://localhost:11434";
  let names = [];
  try {
    const r = await fetch(base + "/api/tags");
    names = ((await r.json()).models || []).map((m) => m.name);
  } catch {
    throw new Error("Ollama no responde. Abre la app de Ollama y vuelve a intentar.");
  }
  const want = cfg.ollamaModel || "qwen2.5:7b";
  if (names.includes(want) || names.includes(want + ":latest")) return want;
  const chat = names.filter((n) => !/embed|nomic|bge|minilm|whisper|vision|llava/i.test(n));
  if (!chat.length) throw new Error(`No tienes modelos en Ollama. Abre una terminal y ejecuta: ollama pull ${want}`);
  const pref = [/qwen2\.5|qwen3/i, /llama3\.[1-9]|llama3/i, /gemma/i, /mistral|mixtral/i, /phi/i];
  const pick = pref.map((re) => chat.find((n) => re.test(n))).find(Boolean) || chat[0];
  log(`El modelo ${want} no está instalado; usando ${pick} (instalados: ${chat.join(", ")})`);
  return pick;
}

/**
 * Ollama con node:http (sin el límite de 5 minutos de fetch). En CPU un tramo puede
 * tardar bastante; streaming = el progreso llega mientras el modelo escribe.
 */
function callOllama(cfg, user, onTokens, { system = "" } = {}) {
  const http = require("node:http");
  const u = new URL((cfg.ollamaUrl || "http://localhost:11434") + "/api/chat");
  const body = JSON.stringify({
    model: cfg.ollamaModel || "qwen2.5:7b",
    stream: true,
    format: "json",
    keep_alive: "30m",
    options: { num_ctx: 16384, temperature: 0.4 },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let buf = "", out = "", n = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          let j; try { j = JSON.parse(l); } catch { continue; }
          if (j.error) return reject(new Error(`Ollama: ${j.error}`));
          if (j.message?.content) { out += j.message.content; n++; if (onTokens && n % 40 === 0) onTokens(n); }
        }
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Ollama ${res.statusCode}: ${(buf || out).slice(0, 200)}`));
        resolve(out);
      });
    });
    req.setTimeout(45 * 60 * 1000, () => req.destroy(new Error("Ollama tardó más de 45 minutos en un tramo")));
    req.on("error", (e) => reject(new Error(`No pude hablar con Ollama: ${e.message}`)));
    req.end(body);
  });
}

function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(t.slice(a, b + 1));
}


/**
 * Pregunta a una IA gratuita que siempre devuelve JSON (la usan las misiones 1, 2 y 4 de 🚀 Lanzamientos).
 * Gemini si hay clave (gratis); si no, Ollama si está configurado. cfg.fakeLlmFile: pruebas sin internet.
 */
async function askJson(cfg, system, user, schema, { name = "respuesta", log = () => {} } = {}) {
  if (cfg.fakeLlmFile) {
    const fake = JSON.parse(fs.readFileSync(cfg.fakeLlmFile, "utf8"));
    if (fake[name] !== undefined) { log(`  (IA de prueba: ${name})`); return fake[name]; }
  }
  cfg = { ...cfg };
  const provider = cfg.geminiKey ? "gemini" : cfg.provider === "ollama" || cfg.ollamaModel ? "ollama" : null;
  if (!provider) throw new Error("Esta misión escribe textos y necesita una IA gratis: pon una clave de Gemini en ⚙️ Ajustes (aistudio.google.com/apikey) o usa Ollama. Los clips no la necesitan.");
  if (provider === "ollama") cfg.ollamaModel = await resolveOllamaModel(cfg, log);
  else cfg.geminiModel = await resolveGeminiModel(cfg, log);
  const withSchema = `${user}\n\nResponde SOLO con un JSON válido con esta forma (JSON Schema):\n${JSON.stringify(schema)}`;
  let badJson = null, lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const u = withSchema + (badJson ? `\n\nTu respuesta anterior no era JSON válido (${badJson}). Responde solo el JSON.` : "");
    let text;
    try { text = provider === "ollama" ? await callOllama(cfg, u, null, { system }) : await callGemini(cfg, u, log, { system }); }
    catch (e) {
      const m = String(e.message);
      if (/quota|RESOURCE_EXHAUSTED|429|cupo/i.test(m)) throw new Error("Gemini llegó a su límite gratis por ahora: espera un rato y dale a Reintentar.");
      if (/401|403|API_KEY_INVALID|api key not valid/i.test(m)) throw new Error("Gemini rechazó la clave: revísala en ⚙️ Ajustes.");
      throw e;
    }
    try { return extractJson(text); }
    catch (e) { badJson = lastErr = e.message.slice(0, 120); log(`  respuesta no era JSON válido (${badJson}), reintentando una vez…`); }
  }
  throw new Error("La IA no devolvió un JSON válido: " + lastErr);
}

// ---------- Clips: siempre el motor local ----------
const local = require("./local");
/** Elige los momentos con el algoritmo de ESTE video (motor local, gratis). */
async function pickMoments(args) {
  return local.pickLocal({ words: args.words, loudness: args.loudness, scenes: args.scenes, range: args.range, profile: args.profile, cfg: args.cfg, info: args.info, log: args.log || (() => {}) });
}

module.exports = { pickMoments, extractJson, askJson };
