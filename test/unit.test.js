// Pruebas unitarias de seguridad y estabilidad: sesiones firmadas, intentos del código, eventos acotados, respaldo y restauración.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpDir } = require("./helpers");
const { createSecurity } = require("../lib/security");
const { keepEvent, EVENTS_MAX, EVENTS_HEAD } = require("../lib/events");
const backup = require("../lib/backup");

function makeSec(code = "246810") {
  let t = Date.UTC(2026, 10, 28);
  const box = { code };
  const sec = createSecurity({ secretFile: path.join(tmpDir("sec"), ".clipsphere-secret"), getCode: () => box.code, port: 3600, now: () => t });
  return { sec, box, advance: (ms) => { t += ms; } };
}

test("4 · una cookie manipulada se rechaza", () => {
  const { sec } = makeSec();
  const tok = sec.issueSession();
  assert.ok(sec.verifySession(tok), "la cookie original vale");
  const [p, s] = tok.split(".");
  const data = JSON.parse(Buffer.from(p, "base64url").toString());
  data.exp += 365 * 864e5; // intenta alargar su vida
  const forged = Buffer.from(JSON.stringify(data)).toString("base64url") + "." + s;
  assert.equal(sec.verifySession(forged), null, "payload cambiado");
  assert.equal(sec.verifySession(p + "." + s.slice(0, -2) + "AA"), null, "firma cambiada");
  assert.equal(sec.verifySession("246810"), null, "el código no sirve como cookie");
  assert.equal(sec.verifySession(""), null);
  // firmada con OTRO secreto (otra PC)
  const other = makeSec().sec.issueSession();
  assert.equal(sec.verifySession(other), null, "secreto distinto");
});

test("5 · una sesión vencida deja de funcionar, y cambiar el código cierra todas", () => {
  const { sec, box, advance } = makeSec();
  const tok = sec.issueSession();
  advance(29 * 864e5);
  assert.ok(sec.verifySession(tok), "a los 29 días sigue");
  assert.ok(sec.needsRenew(sec.verifySession(tok)), "y pide renovarse");
  advance(2 * 864e5);
  assert.equal(sec.verifySession(tok), null, "a los 31 días ya no");
  const tok2 = sec.issueSession();
  box.code = "135799";
  assert.equal(sec.verifySession(tok2), null, "código cambiado: sesión cerrada");
});

test("3 · el código no se puede probar sin límite (espera progresiva y bloqueo global)", () => {
  const { sec, advance } = makeSec();
  const ip = "192.168.1.50";
  for (let i = 0; i < 4; i++) assert.equal(sec.tryCode(ip, "000000").locked, false);
  const fifth = sec.tryCode(ip, "000000");
  assert.equal(fifth.locked, true, "al 5.º intento fallido se bloquea");
  assert.ok(fifth.wait >= 30000);
  assert.equal(sec.tryCode(ip, "246810").ok, false, "bloqueado: ni el código correcto entra");
  advance(31000);
  const sixth = sec.tryCode(ip, "111111");
  assert.ok(sixth.wait >= 60000, "la espera se duplica: " + sixth.wait);
  advance(61000);
  assert.equal(sec.tryCode(ip, "246810").ok, true, "pasada la espera, el código correcto entra");
  // ataque desde muchas IP: bloqueo global
  const { sec: g } = makeSec();
  let locked = false;
  for (let i = 0; i < 60 && !locked; i++) locked = g.tryCode(`10.0.${i}.1`, "000000").locked && g.lockInfo("10.9.9.9").locked;
  assert.ok(locked, "muchas IP fallando bloquean a todas por un rato");
  assert.equal(g.tryCode("10.9.9.9", "246810").ok, false);
});

test("comparaciones seguras y formato del código", () => {
  const { sec } = makeSec();
  assert.equal(sec.safeEqual("abc", "abc"), true);
  assert.equal(sec.safeEqual("abc", "abd"), false);
  assert.equal(sec.safeEqual("abc", "abcd"), false);
  assert.equal(sec.tryCode("1.1.1.1", " 246810 ").ok, true, "espacios alrededor se toleran");
  assert.equal(sec.tryCode("1.1.1.2", "2468100").ok, false);
});

test("2 · Host y Origin: solo esta app", () => {
  const { sec } = makeSec();
  assert.equal(sec.hostOk("localhost:3600"), true);
  assert.equal(sec.hostOk("127.0.0.1:3600"), true);
  assert.equal(sec.hostOk("evil.com:3600"), false, "DNS rebinding");
  assert.equal(sec.hostOk("localhost:9999"), false, "otro puerto");
  assert.equal(sec.hostOk(""), false);
  const req = (h) => ({ headers: { host: "localhost:3600", ...h } });
  assert.equal(sec.originOk(req({})), true);
  assert.equal(sec.originOk(req({ origin: "http://localhost:3600" })), true);
  assert.equal(sec.originOk(req({ origin: "http://evil.com" })), false);
  assert.equal(sec.originOk(req({ origin: "null" })), false);
  assert.equal(sec.originOk(req({ origin: "http://127.0.0.1:3600" })), false, "origen distinto al host pedido");
});

test("9 · los eventos no crecen sin límite", () => {
  const list = [];
  for (let i = 0; i < 40; i++) keepEvent(list, { type: "log", msg: "inicio " + i, at: i });
  for (let i = 0; i < 20000; i++) {
    keepEvent(list, { type: "log", msg: "linea " + i, at: i });
    keepEvent(list, { type: "progress", id: "download", value: i / 20000, at: i }); // se funden
  }
  assert.ok(list.length <= EVENTS_MAX, "tamaño acotado: " + list.length);
  assert.equal(list[0].msg, "inicio 0", "se conserva cómo empezó");
  assert.ok(list[EVENTS_HEAD].omitted > 18000, "aviso de omitidos: " + list[EVENTS_HEAD].msg);
  assert.equal(list[list.length - 1].type, "progress", "se conserva lo más reciente");
  assert.equal(list[list.length - 2].msg, "linea 19999");
  assert.equal(list.filter((e) => e.omitted).length, 1, "un solo aviso");
});

test("6 · el respaldo no contiene secretos", async () => {
  const dir = tmpDir("bk");
  const out = path.join(dir, "salida"); fs.mkdirSync(out);
  const cfgFile = path.join(dir, "config.json");
  const cfg = { outputRoot: out, backupDir: path.join(dir, "nube"), backupEnabled: true, geminiKey: "AIzaSECRETO1", groqKey: "gsk_SECRETO2", deepgramKey: "dg_SECRETO3", anthropicKey: "sk-ant-SECRETO4", accessCode: "246810", minScore: 60 };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  // un respaldo viejo (v2.0) que sí traía claves: debe quedar limpio
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.backupDir, "config.json"), JSON.stringify(cfg));
  const r = await backup.schedule(() => cfg, cfgFile);
  assert.ok(r, "el respaldo corrió");
  const up = fs.readFileSync(path.join(cfg.backupDir, "config.json"), "utf8");
  for (const s of ["SECRETO1", "SECRETO2", "SECRETO3", "SECRETO4", "246810"]) assert.ok(!up.includes(s), "no debe estar: " + s);
  assert.equal(JSON.parse(up).minScore, 60, "los ajustes normales sí van");
  const all = fs.readdirSync(cfg.backupDir, { recursive: true });
  assert.ok(!all.some((f) => /cookies\.txt|clipsphere-secret/.test(String(f))), "ni cookies.txt ni el secreto");
});

test("7 · restaurar conserva las credenciales locales", async () => {
  const dir = tmpDir("rs");
  const nube = path.join(dir, "nube"); fs.mkdirSync(nube);
  fs.writeFileSync(path.join(nube, "config.json"), JSON.stringify({ outputRoot: path.join(dir, "salida"), minScore: 70, _sinSecretos: "x" }));
  const cfgFile = path.join(dir, "config.json");
  const local = { outputRoot: path.join(dir, "salida"), backupDir: nube, geminiKey: "AIzaLOCAL", accessCode: "112233", minScore: 60 };
  fs.writeFileSync(cfgFile, JSON.stringify(local));
  await backup.restore(local, cfgFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")), local, "config local intacto (claves y código)");
  // PC nueva: sin config local se recupera el respaldo (sin claves) y sin la marca interna
  fs.unlinkSync(cfgFile);
  const r = await backup.restore({ outputRoot: path.join(dir, "salida"), backupDir: nube }, cfgFile);
  assert.equal(r.config, true);
  const got = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  assert.equal(got.minScore, 70);
  assert.equal(got._sinSecretos, undefined);
});

test("registro de seguridad: sin secretos, con rotación y sin inundarse", () => {
  const { createSecLog, MAX_BYTES } = require("../lib/seclog");
  const dir = tmpDir("log");
  let t = 0;
  const L = createSecLog(path.join(dir, "seguridad.log"), { now: () => t });
  L.log("acceso-fallido", { ip: "::ffff:192.168.1.9", metodo: "GET", ruta: "/?c=246810", detalle: "código 135799 token=abc key=AIzaX" });
  const first = fs.readFileSync(L.file, "utf8");
  for (const s of ["246810", "135799", "abc", "AIzaX"]) assert.ok(!first.includes(s), "no debe guardar: " + s);
  assert.match(first, /"ip":"192\.168\.1\.9"/);
  // 100 intentos seguidos de la misma IP: una línea, con cuántos se repitieron
  for (let i = 0; i < 100; i++) { t += 50; L.log("acceso-fallido", { ip: "192.168.1.9" }); }
  t += 11000; L.log("acceso-fallido", { ip: "192.168.1.9" });
  const lines = fs.readFileSync(L.file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "no se inunda");
  assert.ok(JSON.parse(lines[1]).repetidos >= 99);
  // rotación por tamaño
  for (let i = 0; i < 4000; i++) { t += 11000; L.log("solicitud-rechazada", { ip: "10.0.0." + (i % 250), detalle: "x".repeat(200) }); }
  assert.ok(fs.statSync(L.file).size <= MAX_BYTES + 1024, "el archivo actual no pasa del límite");
  assert.ok(fs.existsSync(L.file + ".1") && fs.existsSync(L.file + ".2"), "rotó");
  assert.ok(!fs.existsSync(L.file + ".3"), "solo se guardan 2 rotaciones");
});
