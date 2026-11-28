// Respaldo de punta a punta con el servidor real: lo que llega a la "nube" no trae secretos,
// y recuperar en una PC nueva o en la misma no destruye nada.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, request, pageToken, tmpDir } = require("./helpers");

const nube = tmpDir("nube");
const keys = { geminiKey: "AIzaSyFALSA_1234567890", groqKey: "gsk_FALSA_1234567890", deepgramKey: "dgFALSA_1234567890" };

test("6/9/10 · respaldo sin claves y recuperación que conserva credenciales", async () => {
  const S = await startServer({ config: { backupEnabled: true, backupDir: nube, ...keys } });
  try {
    // un trabajo "terminado" en el historial y una campaña, para ver que se respaldan
    const job = path.join(S.out, "20261128-0600-video"); fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, "plan.json"), JSON.stringify({ clips: [] }));
    const camp = path.join(S.out, "_campanas", "gta-6"); fs.mkdirSync(camp, { recursive: true });
    fs.writeFileSync(path.join(camp, "campana.json"), JSON.stringify({ id: "gta-6" }));
    fs.writeFileSync(path.join(path.dirname(S.cfgFile), "cookies.txt"), "# Netscape\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tSECRETO");
    const tk = await pageToken(S.port);
    const r = await request({ port: S.port, method: "POST", path: "/api/backup/run", headers: { host: `127.0.0.1:${S.port}`, "x-cs-token": tk, "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, r.text);
    const files = fs.readdirSync(nube, { recursive: true }).map(String);
    const all = files.filter((f) => fs.statSync(path.join(nube, f)).isFile()).map((f) => fs.readFileSync(path.join(nube, f), "utf8")).join("\n");
    for (const v of [...Object.values(keys), "246810", "SECRETO"]) assert.ok(!all.includes(v), "en la nube no está: " + v);
    assert.ok(files.some((f) => f.includes("20261128-0600-video")), "el historial sí se respalda");
    assert.ok(files.some((f) => f.includes("gta-6")), "las campañas sí se respaldan");
    // "Recuperar" en la misma PC: las claves locales siguen ahí
    const rr = await request({ port: S.port, method: "POST", path: "/api/backup/restore", headers: { host: `127.0.0.1:${S.port}`, "x-cs-token": tk, "content-type": "application/json" }, body: "{}" });
    assert.equal(rr.status, 200, rr.text);
    const local = JSON.parse(fs.readFileSync(S.cfgFile, "utf8"));
    for (const [k, v] of Object.entries(keys)) assert.equal(local[k], v, "clave local intacta: " + k);
    assert.equal(local.accessCode, "246810", "código local intacto");
  } finally { await S.stop(); }
});
