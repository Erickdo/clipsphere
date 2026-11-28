// ClipSphere — © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
/**
 * Seguridad del servidor local. Sin dependencias.
 *
 *  · Host permitido: solo localhost / 127.0.0.1 / ::1 / el nombre de esta PC / sus IP de la red (frena "DNS rebinding").
 *  · Origin: si el navegador lo manda, tiene que ser esta misma app (frena páginas externas).
 *  · Token CSRF: toda orden (POST/PATCH/DELETE) lleva el encabezado x-cs-token, que solo conoce la página de ClipSphere.
 *  · JSON estricto: Content-Type application/json, tamaño máximo y JSON válido (si no: 415 / 413 / 400).
 *  · Acceso móvil: código de 6 dígitos con límite de intentos, espera progresiva y bloqueo global;
 *    sesión en cookie firmada con HMAC-SHA256 (secreto local, no se respalda), con caducidad.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

const b64u = (buf) => Buffer.from(buf).toString("base64url");
/** Comparación en tiempo constante (también si las longitudes no coinciden). */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a ?? "").length === String(b ?? "").length;
}

/** Secreto local para firmar sesiones: se crea una vez, solo lectura para el usuario, nunca va al respaldo. */
function loadSecret(file) {
  try { const s = fs.readFileSync(file, "utf8").trim(); if (/^[a-f0-9]{64}$/.test(s)) return s; } catch {}
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function createSecurity({ secretFile, getCode, port, sessionDays = 30, now = () => Date.now() }) {
  const secret = loadSecret(secretFile);
  const csrf = crypto.randomBytes(24).toString("base64url"); // cambia en cada arranque; la página lo pide de nuevo si hace falta
  const SESSION_MS = sessionDays * 864e5;

  // ---------- Host y Origin ----------
  let hostCache = { at: 0, set: new Set() };
  function allowedHosts() {
    if (now() - hostCache.at < 30000) return hostCache.set;
    const set = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    const hn = os.hostname().toLowerCase();
    set.add(hn); set.add(hn + ".local"); set.add(hn + ".lan");
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family === "IPv4") set.add(a.address);
      if (a.family === "IPv6" && !a.internal) set.add(`[${a.address.split("%")[0]}]`);
    }
    hostCache = { at: now(), set };
    return set;
  }
  /** "localhost:3600" → ok si es un nombre de esta PC y el puerto es el de ClipSphere. */
  function hostOk(hostHeader) {
    const h = String(hostHeader || "").toLowerCase().trim();
    if (!h) return false;
    const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d+))?$/.exec(h);
    if (!m) return false;
    if (m[2] && +m[2] !== +port) return false;
    return allowedHosts().has(m[1]);
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (o === undefined) return true; // navegación normal o herramientas locales: lo cubre el token
    if (o === "null") return false;    // iframes con sandbox, archivos locales, redirecciones raras
    try { const u = new URL(o); return u.protocol === "http:" && hostOk(u.host) && u.host.toLowerCase() === String(req.headers.host || "").toLowerCase(); }
    catch { return false; }
  }
  /** Primer filtro de cada solicitud. Lanza HttpError si no pasa. */
  function guardRequest(req) {
    if (!hostOk(req.headers.host)) throw new HttpError(421, "Host no permitido", "host");
    if (!originOk(req)) throw new HttpError(403, "Origen no permitido", "origin");
    // Un sitio externo que se cuela por una pestaña: el navegador lo marca como cross-site
    const sfs = req.headers["sec-fetch-site"];
    const method = req.method || "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (sfs === "cross-site") throw new HttpError(403, "Solicitud desde otro sitio", "cross-site");
      if (!safeEqual(req.headers["x-cs-token"], csrf)) throw new HttpError(403, "Falta el token de seguridad: recarga la página", "csrf");
    }
    if (method === "OPTIONS") throw new HttpError(405, "Método no permitido", "method");
  }

  // ---------- JSON estricto ----------
  function readJson(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      const len = +req.headers["content-length"] || 0;
      const hasBody = len > 0 || !!req.headers["transfer-encoding"];
      if (!hasBody) return resolve({});
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] || ""))) {
        req.resume(); return reject(new HttpError(415, "El contenido tiene que ser JSON", "content-type"));
      }
      // Demasiado grande: se descarta lo que llegue (hasta 32 MB) y se responde 413 limpio; más que eso, se corta.
      const tooBig = () => {
        const e = new HttpError(413, "La solicitud es demasiado grande", "too-large");
        if (len > 32 * 1024 * 1024) { reject(e); req.destroy(); return; }
        req.removeAllListeners("data"); req.removeAllListeners("end");
        req.on("end", () => reject(e)); req.resume();
      };
      if (len > limit) return tooBig();
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) return tooBig();
        chunks.push(c);
      });
      req.on("end", () => {
        let v;
        try { v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return reject(new HttpError(400, "JSON inválido", "bad-json")); }
        if (v === null || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "Se esperaba un objeto JSON", "bad-json"));
        resolve(v);
      });
      req.on("error", reject);
    });
  }

  // ---------- Sesión del móvil: cookie firmada ----------
  const codeTag = () => crypto.createHmac("sha256", secret).update("code:" + String(getCode())).digest("hex").slice(0, 16);
  const sign = (payload) => b64u(crypto.createHmac("sha256", secret).update(payload).digest());
  function issueSession() {
    const p = b64u(JSON.stringify({ v: 1, iat: now(), exp: now() + SESSION_MS, ct: codeTag() }));
    return `${p}.${sign(p)}`;
  }
  /** Devuelve la sesión si la firma es válida, no venció y el código no cambió; si no, null. */
  function verifySession(token) {
    const t = String(token || "");
    const i = t.indexOf(".");
    if (i <= 0 || t.length > 600) return null;
    const p = t.slice(0, i), s = t.slice(i + 1);
    if (!safeEqual(s, sign(p))) return null;
    let d; try { d = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
    if (!d || d.v !== 1 || typeof d.exp !== "number" || d.exp <= now()) return null;
    if (!safeEqual(d.ct, codeTag())) return null; // cambiaste el código: todas las sesiones viejas caen
    return d;
  }
  const cookieHeader = (token) => `cs_s=${token}; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}; HttpOnly; SameSite=Lax`;
  const needsRenew = (d) => d && d.exp - now() < SESSION_MS / 2;

  // ---------- Intentos del código ----------
  const FREE_TRIES = 5, BASE_WAIT = 30e3, MAX_WAIT = 3600e3, GLOBAL_WINDOW = 15 * 60e3, GLOBAL_MAX = 40, GLOBAL_LOCK = 10 * 60e3;
  const perIp = new Map(); // ip → {fails, until, last}
  let globalFails = [], globalUntil = 0;
  function lockInfo(ip) {
    const t = now();
    if (globalUntil > t) return { locked: true, wait: globalUntil - t, global: true };
    const r = perIp.get(ip);
    if (r && r.until > t) return { locked: true, wait: r.until - t };
    return { locked: false, wait: 0 };
  }
  /** Prueba un código. Devuelve {ok} o {ok:false, wait, left}. Nunca dice si el código "casi" era. */
  function tryCode(ip, given) {
    const t = now();
    const li = lockInfo(ip);
    if (li.locked) return { ok: false, locked: true, wait: li.wait };
    let r = perIp.get(ip);
    if (r && t - r.last > 3600e3) { perIp.delete(ip); r = null; } // una hora sin fallar: se olvida
    if (/^\d{6}$/.test(String(given || "").trim()) && safeEqual(String(given).trim(), String(getCode()))) {
      perIp.delete(ip);
      return { ok: true };
    }
    r = r || { fails: 0, until: 0, last: 0 };
    r.fails++; r.last = t;
    if (r.fails >= FREE_TRIES) r.until = t + Math.min(MAX_WAIT, BASE_WAIT * 2 ** (r.fails - FREE_TRIES));
    perIp.set(ip, r);
    globalFails = globalFails.filter((x) => t - x < GLOBAL_WINDOW); globalFails.push(t);
    if (globalFails.length >= GLOBAL_MAX) { globalUntil = t + GLOBAL_LOCK; globalFails = []; }
    if (perIp.size > 5000) perIp.delete(perIp.keys().next().value); // memoria acotada
    const li2 = lockInfo(ip);
    return { ok: false, locked: li2.locked, wait: li2.wait, left: Math.max(0, FREE_TRIES - r.fails) };
  }

  return { csrf, guardRequest, readJson, hostOk, originOk, issueSession, verifySession, cookieHeader, needsRenew, tryCode, lockInfo, safeEqual };
}

module.exports = { createSecurity, HttpError, safeEqual, loadSecret };
