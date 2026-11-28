// Pruebas con el servidor real: páginas externas, contenido inválido y acceso desde el móvil (otra IP).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer, request, pageToken, lanIp } = require("./helpers");

let S, port, token;
test.before(async () => { S = await startServer(); port = S.port; token = await pageToken(port); });
test.after(async () => { await S.stop(); });

const H = (extra = {}) => ({ host: `127.0.0.1:${port}`, ...extra });
const cfgNow = () => JSON.parse(fs.readFileSync(S.cfgFile, "utf8"));
const evilBody = JSON.stringify({ outputRoot: "C:/atacante", ollamaUrl: "http://evil.com" });

test("PC: la página trae su token y puede guardar ajustes", async () => {
  assert.ok(token && token.length >= 20, "la página trae el token");
  const r = await request({ port, method: "POST", path: "/api/config", headers: H({ "content-type": "application/json", "x-cs-token": token, origin: `http://127.0.0.1:${port}` }), body: JSON.stringify({ minScore: 65 }) });
  assert.equal(r.status, 200, r.text);
  assert.equal(cfgNow().minScore, 65);
  const g = await request({ port, path: "/api/config", headers: H() });
  assert.equal(g.status, 200);
  assert.equal(g.json.accessCode, "246810", "en la laptop se ve el código del móvil");
});

test("1 · una página externa no puede ejecutar acciones", async () => {
  const before = cfgNow().outputRoot;
  const attempts = [
    // formulario o fetch "simple" desde otro sitio (texto plano, sin token)
    { headers: H({ "content-type": "text/plain", origin: "http://evil.com", "sec-fetch-site": "cross-site" }) },
    // aunque adivinara el formato, no tiene el token
    { headers: H({ "content-type": "application/json", origin: "http://evil.com" }) },
    // con un token robado de otra forma, pero el navegador marca el origen
    { headers: H({ "content-type": "application/json", origin: "http://evil.com", "x-cs-token": token }) },
    // sitio externo que se hace pasar por localhost (DNS rebinding): Host distinto
    { headers: { host: `evil.com:${port}`, "content-type": "application/json", "x-cs-token": token } },
    // sin Origin pero el navegador avisa cross-site
    { headers: H({ "content-type": "application/json", "sec-fetch-site": "cross-site", "x-cs-token": token }) },
  ];
  for (const a of attempts) {
    const r = await request({ port, method: "POST", path: "/api/config", headers: a.headers, body: evilBody });
    assert.ok([403, 421].includes(r.status), `debió rechazarse (${r.status}) ${JSON.stringify(a.headers)}`);
  }
  for (const p of ["/api/jobs", "/api/cookies", "/api/backup/run", "/api/update/apply"]) {
    const r = await request({ port, method: "POST", path: p, headers: H({ "content-type": "text/plain", origin: "http://evil.com" }), body: "{}" });
    assert.equal(r.status, 403, p);
  }
  const rb = await request({ port, path: "/", headers: { host: `evil.com:${port}` } });
  assert.equal(rb.status, 421, "ni siquiera la página se entrega a otro nombre");
  assert.equal(cfgNow().outputRoot, before, "los ajustes no cambiaron");
});

test("2 · el contenido inválido se rechaza", async () => {
  const send = (headers, body) => request({ port, method: "POST", path: "/api/config", headers: H({ "x-cs-token": token, ...headers }), body });
  assert.equal((await send({ "content-type": "text/plain" }, "{}")).status, 415, "tipo de contenido");
  assert.equal((await send({ "content-type": "application/json" }, "{malo")).status, 400, "JSON roto");
  assert.equal((await send({ "content-type": "application/json" }, "[1,2]")).status, 400, "no es objeto");
  assert.equal((await send({ "content-type": "application/json" }, JSON.stringify({ x: "a".repeat(400 * 1024) }))).status, 413, "demasiado grande");
  const r = await request({ port, method: "POST", path: "/api/jobs", headers: H({ "x-cs-token": token, "content-type": "application/json" }), body: JSON.stringify({ url: "--exec calc" }) });
  assert.equal(r.status, 400, "link que no es http(s)");
  assert.equal((await request({ port, method: "OPTIONS", path: "/api/config", headers: H() })).status, 405);
});

test("móvil: código → sesión firmada; sin sesión no entra; la cookie vieja migra sola", async (t) => {
  const ip = lanIp();
  if (!ip) return t.skip("esta máquina no tiene IP de red");
  const MH = (extra = {}) => ({ host: `${ip}:${port}`, ...extra });
  const noSess = await request({ host: ip, port, path: "/api/jobs", headers: MH() });
  assert.equal(noSess.status, 401, "sin sesión la API no responde");
  const page = await request({ host: ip, port, path: "/", headers: MH() });
  assert.match(page.text, /Escribe el código/, "pide el código");
  const login = await request({ host: ip, port, path: "/?c=246810", headers: MH() });
  assert.equal(login.status, 302);
  const sc = [].concat(login.headers["set-cookie"] || []);
  const cs = sc.find((c) => c.startsWith("cs_s="));
  assert.ok(cs && /HttpOnly/i.test(cs) && /SameSite=Lax/i.test(cs) && /Max-Age=\d+/.test(cs), "cookie firmada HttpOnly, SameSite y con caducidad: " + cs);
  const cookie = cs.split(";")[0];
  const ok = await request({ host: ip, port, path: "/api/jobs", headers: MH({ cookie }) });
  assert.equal(ok.status, 200, "con la sesión entra");
  const cfg = await request({ host: ip, port, path: "/api/config", headers: MH({ cookie }) });
  assert.equal(cfg.json.accessCode, undefined, "el móvil no ve el código");
  // el móvil también manda órdenes con el token de la página
  const tk = await pageToken(port, ip, { cookie });
  const job = await request({ host: ip, port, method: "POST", path: "/api/jobs", headers: MH({ cookie, "x-cs-token": tk, "content-type": "application/json", origin: `http://${ip}:${port}` }), body: JSON.stringify({ url: "nada" }) });
  assert.equal(job.status, 400, "llega al servidor (link inválido), no se bloquea por seguridad");
  // cookie manipulada
  const bad = cookie.slice(0, -3) + "xyz";
  assert.equal((await request({ host: ip, port, path: "/api/jobs", headers: MH({ cookie: bad }) })).status, 401);
  // el código en texto plano como cookie (sistema viejo) ya no sirve... salvo para migrar una vez al sistema nuevo
  const mig = await request({ host: ip, port, path: "/api/jobs", headers: MH({ cookie: "cs_code=246810" }) });
  assert.equal(mig.status, 200, "un teléfono que ya estaba conectado sigue entrando");
  assert.ok([].concat(mig.headers["set-cookie"] || []).some((c) => c.startsWith("cs_s=")), "y recibe la cookie nueva firmada");
  assert.equal((await request({ host: ip, port, path: "/api/jobs", headers: MH({ cookie: "cs_code=111111" }) })).status, 401);
  // ajustes solo desde la laptop
  const post = await request({ host: ip, port, method: "POST", path: "/api/config", headers: MH({ cookie, "x-cs-token": tk, "content-type": "application/json" }), body: "{}" });
  assert.equal(post.status, 403);
});

test("3 · desde el móvil, el código no se puede probar sin límite", async (t) => {
  const ip = lanIp();
  if (!ip) return t.skip("esta máquina no tiene IP de red");
  const MH = { host: `${ip}:${port}` };
  let last;
  for (let i = 0; i < 5; i++) last = await request({ host: ip, port, path: "/?c=00000" + i, headers: MH });
  assert.equal(last.status, 429, "al 5.º fallo, a esperar");
  assert.match(last.text, /Espera \d+ segundos/);
  const right = await request({ host: ip, port, path: "/?c=246810", headers: MH });
  assert.equal(right.status, 429, "bloqueado: ni el correcto entra hasta que pase la espera");
  // la PC sigue funcionando normal aunque el móvil esté bloqueado
  assert.equal((await request({ port, path: "/api/jobs", headers: H() })).status, 200);
});

test("registro de seguridad: anota rechazos, fallos y bloqueos, sin códigos ni tokens", async () => {
  const f = require("node:path").join(require("node:path").dirname(S.cfgFile), "seguridad.log");
  assert.ok(fs.existsSync(f), "existe seguridad.log");
  const txt = fs.readFileSync(f, "utf8");
  for (const tipo of ["solicitud-rechazada", "solicitud-invalida"]) assert.match(txt, new RegExp(tipo), tipo);
  if (lanIp()) for (const tipo of ["acceso-fallido", "bloqueo-temporal", "sesion-invalida", "acceso-correcto"]) assert.match(txt, new RegExp(tipo), tipo);
  assert.ok(!txt.includes("246810"), "no guarda el código");
  assert.ok(!txt.includes(token), "no guarda el token");
});
