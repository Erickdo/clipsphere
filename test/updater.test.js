// 8/11 · El actualizador protege los archivos personales, verifica SHA-256 y se puede deshacer.
// Corre aparte (su propio proceso) porque fija la carpeta de la app con variables de entorno.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { tmpDir } = require("./helpers");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const APP = tmpDir("app");
const put = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true }); fs.writeFileSync(path.join(APP, rel), txt); };
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");
const has = (rel) => fs.existsSync(path.join(APP, rel));

// Versión 1 instalada: archivos del programa + archivos personales
const v1 = { "lib/a.js": "a1", "lib/viejo.js": "viejo", "lib/tocado.js": "original", "prompts/system.md": "prompt", "server.js": "s1" };
for (const [k, v] of Object.entries(v1)) put(k, v);
put("lib/tocado.js", "lo cambié yo"); // el usuario lo modificó
put("config.json", '{"geminiKey":"AIzaMIA"}');
put("cookies.txt", "# Netscape");
put(".clipsphere-secret", "x".repeat(64));
put("errores.log", "log");
put("mis-clips/c01.mp4", "video");
put("salida/_campanas/gta/campana.json", "{}");
put("_update_backup/viejo/nota.txt", "respaldo anterior");
fs.writeFileSync(path.join(APP, "manifest.json"), JSON.stringify({ version: "1.0.0", files: Object.entries(v1).map(([p, c]) => ({ path: p, sha256: sha(c) })) }));

// Versión 2 en el "GitHub" falso: viejo.js, tocado.js y system.md se retiran; a.js cambia; nuevo.js aparece
const v2 = { "lib/a.js": "a2", "lib/nuevo.js": "nuevo", "server.js": "s2" };
let REMOTE = { version: "2.0.0", files: Object.entries(v2).map(([p, c]) => ({ path: p, sha256: sha(c) })) };
let CORRUPT = false;
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0].slice(1));
  if (p === "manifest.json") return res.end(JSON.stringify(REMOTE));
  if (v2[p] !== undefined) return res.end(CORRUPT && p === "lib/nuevo.js" ? "alterado" : v2[p]);
  res.statusCode = 404; res.end();
});

let updater;
test.before(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.CLIPSPHERE_APP_ROOT = APP;
  process.env.CLIPSPHERE_RAW = `http://127.0.0.1:${srv.address().port}`;
  updater = require("../lib/updater");
});
test.after(() => srv.close());

test("8 · un archivo dañado (SHA-256 distinto) detiene la actualización sin tocar nada", async () => {
  CORRUPT = true;
  await assert.rejects(updater.apply(), /llegó dañado/);
  assert.equal(read("lib/a.js"), "a1", "no se aplicó nada");
  assert.ok(has("lib/viejo.js"));
  CORRUPT = false;
});

test("8 · actualiza, retira solo lo del programa y protege lo personal", async () => {
  const r = await updater.apply();
  assert.equal(r.version, "2.0.0");
  assert.equal(read("lib/a.js"), "a2");
  assert.equal(read("lib/nuevo.js"), "nuevo");
  assert.deepEqual(r.removed.sort(), ["lib/viejo.js", "prompts/system.md"], "retirados");
  assert.ok(!has("lib/viejo.js") && !has("prompts/system.md"));
  assert.deepEqual(r.kept, ["lib/tocado.js"], "modificado por el usuario: se conserva");
  assert.equal(read("lib/tocado.js"), "lo cambié yo");
  for (const f of ["config.json", "cookies.txt", ".clipsphere-secret", "errores.log", "mis-clips/c01.mp4", "salida/_campanas/gta/campana.json"]) assert.ok(has(f), "intacto: " + f);
  assert.equal(read("config.json"), '{"geminiKey":"AIzaMIA"}');
  assert.ok(fs.existsSync(path.join(APP, "_update_backup", "files", "lib", "viejo.js")), "lo retirado queda en _update_backup");
  assert.equal(JSON.parse(read("manifest.json")).version, "2.0.0");
});

test("recuperación: se puede deshacer la actualización", () => {
  const r = updater.rollback();
  assert.equal(r.version, "1.0.0");
  assert.equal(read("lib/a.js"), "a1");
  assert.equal(read("lib/viejo.js"), "viejo");
  assert.equal(read("prompts/system.md"), "prompt");
  assert.ok(!has("lib/nuevo.js"), "lo que trajo la versión deshecha se quita");
  assert.equal(read("config.json"), '{"geminiKey":"AIzaMIA"}');
  assert.equal(JSON.parse(read("manifest.json")).version, "1.0.0");
});

test("un manifest malicioso no puede apuntar a archivos personales ni salir de la app", async () => {
  REMOTE = { version: "3.0.0", files: [{ path: "config.json", sha256: sha("x") }] };
  await assert.rejects(updater.apply(), /ruta no permitida/);
  REMOTE = { version: "3.0.0", files: [{ path: "../fuera.txt", sha256: sha("x") }] };
  await assert.rejects(updater.apply(), /ruta no permitida/);
  REMOTE = { version: "3.0.0", files: "nada" };
  await assert.rejects(updater.apply(), /no es válido/);
  assert.equal(read("config.json"), '{"geminiKey":"AIzaMIA"}');
});

test("recuperación automática: si falla a mitad de camino, todo vuelve a como estaba", async () => {
  // "lib/zz" es un ARCHIVO en esta PC y la versión nueva trae "lib/zz/x.js": crear esa carpeta falla
  // a mitad de la actualización, después de haber copiado ya otros archivos
  put("lib/zz", "soy un archivo");
  v2["lib/zz/x.js"] = "x";
  REMOTE = { version: "4.0.0", files: [...Object.entries(v2)].map(([p, c]) => ({ path: p, sha256: sha(c) })) };
  const before = { a: read("lib/a.js"), s: read("server.js"), m: read("manifest.json") };
  await assert.rejects(updater.apply(), /se deshizo/);
  assert.equal(read("lib/a.js"), before.a, "lib/a.js volvió");
  assert.equal(read("server.js"), before.s, "server.js volvió");
  assert.equal(read("manifest.json"), before.m, "la versión sigue siendo la de antes");
  assert.ok(!has("lib/nuevo.js"), "lo nuevo a medias se quitó");
  assert.equal(read("config.json"), '{"geminiKey":"AIzaMIA"}');
});
