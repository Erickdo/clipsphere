// Ayudas de las pruebas: arrancan ClipSphere de verdad en un puerto libre, con carpetas temporales
// y un yt-dlp / Whisper falsos (sin internet). Uso: node --test test/
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(__dirname, "fixtures", "bin");

function tmpDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `cs-${name}-`)); }

/** Video de prueba (generado una vez con ffmpeg): imagen de prueba + tono, H.264/AAC. */
function testMedia(dir, seconds = 150, ext = "mp4") {
  const f = path.join(dir, `media_${seconds}.${ext}`);
  if (!fs.existsSync(f)) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=25:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=220:d=${seconds}`,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", ...(ext === "ts" ? ["-f", "mpegts"] : []), f]);
  }
  return f;
}

/** IP de esta máquina en la red (para simular el móvil: llega desde una IP que no es 127.0.0.1). */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}

/** Arranca server.js con su propio config.json. Devuelve { port, base, dir, cfgFile, stop, logs }. */
async function startServer({ config = {}, env = {} } = {}) {
  const dir = tmpDir("srv");
  const out = path.join(dir, "salida");
  fs.mkdirSync(out, { recursive: true });
  const cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ outputRoot: out, backupEnabled: false, accessCode: "246810", language: "es", localEngineV1: true, ...config }, null, 2));
  const port = 4100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLIPSPHERE_CONFIG: cfgFile, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, CLIPSPHERE_RAW: "http://127.0.0.1:9/none", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("el servidor no arrancó:\n" + logs)), 15000);
    const tick = setInterval(() => { if (/listo en/.test(logs)) { clearTimeout(t); clearInterval(tick); resolve(); } }, 100);
    child.on("exit", (c) => { clearTimeout(t); clearInterval(tick); reject(new Error("el servidor se cerró: " + c + "\n" + logs)); });
  });
  return { port, base: `http://127.0.0.1:${port}`, dir, out, cfgFile, child, logs: () => logs, stop: () => new Promise((r) => { child.once("exit", r); child.kill(); }) };
}

/** Solicitud HTTP con control total de encabezados (como lo haría una página externa o un atacante). */
function request({ host = "127.0.0.1", port, method = "GET", path: p = "/", headers = {}, body = null, localAddress }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers, localAddress }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** Token CSRF tal como lo recibe la página de ClipSphere. */
async function pageToken(port, host = "127.0.0.1", extra = {}) {
  const r = await request({ port, host, path: "/", headers: { host: `${host}:${port}`, ...extra } });
  const m = /name="cs-token" content="([^"]+)"/.exec(r.text);
  return m ? m[1] : null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, BIN, tmpDir, testMedia, lanIp, startServer, request, pageToken, wait };
