// ClipSphere © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
// Elección de momentos con IA: Claude (API de Anthropic) u Ollama (local, gratis).
const fs = require("node:fs");
const path = require("node:path");
const { fmtLine } = require("./subs");

const SYSTEM = fs.readFileSync(path.join(__dirname, "..", "prompts", "system.md"), "utf8");

// Esquema que Claude debe llenar: con tool_choice forzado la respuesta siempre es JSON válido.
const CLIP_TOOL = {
  name: "entregar_clips",
  description: "Entrega los clips elegidos y los momentos saltados.",
  input_schema: {
    type: "object",
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          required: ["start", "end", "title", "description", "hashtags", "label", "score"],
          properties: {
            start: { type: "number" }, end: { type: "number" },
            title: { type: "string" }, hook: { type: "string" }, description: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            label: { type: "string", enum: ["chisme", "polemica", "tension", "humor", "revelacion", "emotivo", "educativo", "reaccion", "momento_epico"] },
            score: { type: "number" },
            seriesId: { type: ["string", "null"] }, part: { type: ["integer", "null"] }, totalParts: { type: ["integer", "null"] },
          },
        },
      },
      skipped: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" }, reason: { type: "string" } } } },
    },
  },
};

let claudeForcedTool = true; // algunos modelos no aceptan tool_choice forzado; se detecta solo

async function callClaude(cfg, user) {
  const send = async (mode) => {
    const body = {
      model: cfg.claudeModel || "claude-sonnet-5-5",
      max_tokens: 16000,
      system: SYSTEM + "\n\nEntrega el resultado llamando a la herramienta entregar_clips (una sola vez, con TODOS los clips).",
      tools: [CLIP_TOOL],
      messages: [{ role: "user", content: user }],
    };
    if (mode === "forced") body.tool_choice = { type: "tool", name: "entregar_clips" };
    else if (mode === "auto") body.tool_choice = { type: "auto" };
    else { delete body.tools; body.system = SYSTEM; }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    return { res, j };
  };
  const modes = claudeForcedTool ? ["forced", "auto", "text"] : ["auto", "text"];
  let lastErr = "";
  for (const mode of modes) {
    const { res, j } = await send(mode);
    if (!res.ok) {
      const msg = j?.error?.message || JSON.stringify(j).slice(0, 300);
      // Si el modelo no admite herramientas o tool_choice, probar el siguiente modo
      if (res.status === 400 && /tool_choice|tool|thinking/i.test(msg)) {
        if (mode === "forced") claudeForcedTool = false;
        lastErr = msg;
        continue;
      }
      throw new Error(`Claude API ${res.status}: ${msg}`);
    }
    const tool = (j.content || []).find((b) => b.type === "tool_use" && b.name === "entregar_clips");
    if (tool) return JSON.stringify(tool.input);
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text.trim()) return text;
    lastErr = `respuesta vacía (${j.stop_reason || "sin motivo"})`;
  }
  throw new Error(`Claude API: ${lastErr}`);
}

// ---------- Google Gemini (gratis con límites) ----------
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

async function callGemini(cfg, user, log) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
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
      if (daily || noQuota) throw new Error("Se acabó el cupo gratis de Gemini por hoy. Vuelve mañana o usa Claude.");
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
function callOllama(cfg, user, onTokens) {
  const http = require("node:http");
  const u = new URL((cfg.ollamaUrl || "http://localhost:11434") + "/api/chat");
  const body = JSON.stringify({
    model: cfg.ollamaModel || "qwen2.5:7b",
    stream: true,
    format: "json",
    keep_alive: "30m",
    options: { num_ctx: 16384, temperature: 0.4 },
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
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
 * Divide la transcripción en ventanas (Claude: 60 min, Ollama: 20 min) con solapamiento,
 * pide clips por ventana y junta los resultados.
 */
async function pickMoments({ cfg, info, lines, log }) {
  const provider = cfg.provider || "claude";
  const total = lines.length ? lines[lines.length - 1].t : 0;
  const win = provider === "ollama" ? 900 : 3600;
  const overlap = 180;
  const windows = [];
  for (let s = 0; s < total; s += win - overlap) {
    windows.push([s, Math.min(total + 10, s + win)]);
    if (s + win >= total) break;
  }
  if (!windows.length) windows.push([0, total + 10]);

  if (provider === "ollama") cfg = { ...cfg, ollamaModel: await resolveOllamaModel(cfg, log) };
  if (provider === "gemini") {
    if (!cfg.geminiKey) throw new Error("Falta la clave de Gemini (⚙️ Ajustes).");
    cfg = { ...cfg };
    cfg.geminiModel = await resolveGeminiModel(cfg, log); // también deja cfg.geminiBackups
  }
  const all = { clips: [], skipped: [] };
  for (const [i, [a, b]] of windows.entries()) {
    const part = lines.filter((l) => l.t >= a && l.t < b);
    const user =
      `VIDEO: "${info.title}" — canal: ${info.uploader}\n` +
      `CONFIG: ${JSON.stringify({
        minSeconds: cfg.minSeconds, maxSeconds: cfg.maxSeconds, idioma: cfg.language,
        publico: cfg.audience || "República Dominicana, Latinoamérica y latinos en EE. UU.",
        modo: cfg.liveScan ? "directo" : "video",
        ...(cfg.liveScan ? { minutosSinClip: cfg.liveScan.minutesSinceClip || 0 } : {}),
        cantidad: cfg.liveScan
          ? "Todos los momentos completos con potencial real (score 60 o más). Si no pasó nada que pegue, devuelve clips vacío."
          : "SIN LÍMITE: entrega TODOS los momentos que tengan potencial real (score 60 o más). Si hay pocos, entrega pocos; nunca rellenes con momentos flojos.",
      })}\n` +
      (cfg.liveScan ? `DIRECTO EN CURSO: estos son los últimos minutos. ${cfg.liveScan.note || ""}\n` : "") +
      `TRANSCRIPCIÓN (${cfg.liveScan ? "últimos minutos del directo" : windows.length > 1 ? `tramo ${i + 1} de ${windows.length}` : "completa"}):\n` +
      part.map(fmtLine).join("\n");
    log(`IA (${provider}${provider === "gemini" ? " " + cfg.geminiModel : provider === "ollama" ? " " + cfg.ollamaModel : ""}) analizando tramo ${i + 1}/${windows.length}…${provider === "ollama" ? " (en una laptop sin tarjeta gráfica puede tardar varios minutos)" : ""}`);
    let lastErr, badJson = null;
    const t0 = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      let text;
      // Errores de red / API: no se reintenta (evita esperas largas para nada)
      text = provider === "ollama"
        ? await callOllama(cfg, user + (badJson ? `\n\nTu respuesta anterior no era JSON válido. Responde solo el JSON.` : ""),
            (n) => log(`  …escribiendo respuesta (${n} fragmentos, ${Math.round((Date.now() - t0) / 1000)} s)`))
        : provider === "gemini"
        ? await callGemini(cfg, user + (badJson ? `\n\nTu respuesta anterior no era JSON válido. Responde solo el JSON.` : ""), log)
        : await callClaude(cfg, user + (badJson ? `\n\nTu respuesta anterior no era JSON válido (${badJson}). Responde solo el JSON.` : ""));
      try {
        const j = extractJson(text);
        all.clips.push(...(j.clips || []));
        all.skipped.push(...(j.skipped || []));
        lastErr = null;
        log(`  tramo ${i + 1} listo en ${Math.round((Date.now() - t0) / 1000)} s (${(j.clips || []).length} candidatos)`);
        break;
      } catch (e) {
        badJson = lastErr = e.message.slice(0, 120);
        log(`  respuesta no era JSON válido (${badJson}), reintentando una vez…`);
      }
    }
    if (lastErr) throw new Error("La IA no devolvió un JSON válido: " + lastErr);
  }
  return all;
}

module.exports = { pickMoments, extractJson };
