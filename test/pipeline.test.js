// Regresión: después de los cambios de seguridad, un video se procesa y se renderiza de punta a punta,
// y un directo (Kick simulado) se graba, se analiza y saca clips. Todo con el servidor real y sin internet.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startServer, request, pageToken, testMedia, tmpDir, wait } = require("./helpers");

const media = tmpDir("media");
const MP4 = testMedia(media, 150, "mp4");
const TS = testMedia(media, 150, "ts");
let live, S, token;
test.before(async () => {
  // "Kick": sirve el .ts del directo por HTTP, como lo daría la plataforma
  live = http.createServer((req, res) => { res.writeHead(200, { "content-type": "video/mp2t" }); fs.createReadStream(TS).pipe(res); });
  await new Promise((r) => live.listen(0, "127.0.0.1", r));
  S = await startServer({
    config: { minSeconds: 20, maxSeconds: 60, liveScanMinutes: 2, keepSource: false },
    env: { CS_TEST_MEDIA: MP4, CS_TEST_LIVE_URL: `http://127.0.0.1:${live.address().port}/live.ts`, CS_TEST_STATE: path.join(media, "kick-state") },
  });
  token = await pageToken(S.port);
});
test.after(async () => { await S.stop(); live.close(); });

async function runJob(url, options) {
  const r = await request({ port: S.port, method: "POST", path: "/api/jobs", headers: { host: `127.0.0.1:${S.port}`, "content-type": "application/json", "x-cs-token": token }, body: JSON.stringify({ url, options }) });
  assert.equal(r.status, 200, r.text);
  const id = r.json.id;
  const dir = path.join(S.out, id);
  for (let i = 0; i < 240; i++) {
    if (fs.existsSync(path.join(dir, "done.json"))) return { id, dir };
    if (fs.existsSync(path.join(dir, "error.json"))) throw new Error("el trabajo falló: " + fs.readFileSync(path.join(dir, "error.json"), "utf8") + "\n" + S.logs().slice(-2000));
    await wait(1000);
  }
  throw new Error("el trabajo no terminó a tiempo\n" + S.logs().slice(-2000));
}
const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString();
const size = (f) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).toString().trim();

test("14/15 · un video se procesa y sus clips se renderizan en 9:16", async () => {
  const { dir } = await runJob("https://youtu.be/prueba01", { module: "vod", minSeconds: 20, maxSeconds: 60, focus: "reality", language: "es" });
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const ok = plan.clips.filter((c) => c.status === "ok");
  assert.ok(ok.length >= 1, "hay clips listos");
  for (const c of ok) {
    const f = path.join(dir, c.file);
    assert.ok(fs.existsSync(f), "existe " + c.file);
    assert.equal(size(f), "1080,1920", "vertical 1080x1920");
    assert.ok(dur(f) >= 15 && dur(f) <= 95, "duración razonable: " + dur(f));
    assert.ok(fs.existsSync(f.replace(/\.mp4$/, ".jpg")), "portada");
  }
  assert.match(fs.readFileSync(path.join(dir, "publicar.txt"), "utf8"), /CLIP #001/);
  // el historial lo muestra
  const h = await request({ port: S.port, path: "/api/jobs", headers: { host: `127.0.0.1:${S.port}` } });
  assert.equal(h.status, 200);
  assert.ok(JSON.stringify(h.json).includes("prueba"), "aparece en el historial");
});

test("13 · un directo se graba, se analiza y saca clips", async () => {
  const { id, dir } = await runJob("https://kick.com/canalprueba", { module: "live", minSeconds: 20, maxSeconds: 60, language: "es" });
  // lo grabado y analizado queda anotado (los tramos .ts se borran al terminar si no guardas el original)
  const st = fs.readdirSync(path.join(S.out, "_cache")).filter((d) => d.startsWith("directo-")).map((d) => JSON.parse(fs.readFileSync(path.join(S.out, "_cache", d, "live_state.json"), "utf8")))[0];
  assert.ok(st && st.transcribed >= 140, "se grabó y transcribió el directo completo: " + (st && st.transcribed) + " s");
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  assert.ok(plan.clips.some((c) => c.status === "ok"), "el directo dio clips");
  // SSE: quien se conecta después recibe lo guardado y el aviso de fin
  const ev = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: S.port, path: `/api/jobs/${id}/events`, headers: { host: `127.0.0.1:${S.port}` } }, (res) => {
      let buf = ""; res.on("data", (d) => { buf += d; if (/"type":"done"/.test(buf)) { req.destroy(); resolve(buf); } });
      setTimeout(() => { req.destroy(); resolve(buf); }, 5000);
    });
  });
  assert.match(ev, /"type":"done"/, "el SSE entrega el final del directo");
  assert.match(ev, /"type":"recording","on":true/, "hubo grabación en vivo");
});
