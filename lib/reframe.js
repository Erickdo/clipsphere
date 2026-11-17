/**
 * Encuadre inteligente 9:16 (sigue al que habla / pantalla dividida para streams).
 * El análisis lo hace tools/reframe.py (Python + OpenCV). Si Python u OpenCV no están,
 * se instalan una vez con pip; si aun así falla, ClipSphere usa el encuadre clásico.
 */
const fs = require("fs");
const path = require("path");
const { run, pythonCmd } = require("./util");

const SCRIPT = path.join(__dirname, "..", "tools", "reframe.py");
let state = null; // null = sin probar · "ok" · "fail"
let failMsg = "";
let installing = null;

async function ensure(log = () => {}) {
  if (state === "ok") return true;
  if (state === "fail") return false;
  if (installing) return installing;
  installing = (async () => {
    const py = pythonCmd();
    if (!py) { state = "fail"; failMsg = "no encontré Python"; return false; }
    const test = () => run(py[0], [...py.slice(1), "-c", "import cv2,numpy;print(cv2.__version__)"], { allowFail: true });
    let r = await test();
    if (r.code !== 0) {
      log("Encuadre inteligente: instalando OpenCV (solo la primera vez, ~1 min)…");
      await run(py[0], [...py.slice(1), "-m", "pip", "install", "--user", "-q", "opencv-python-headless", "numpy"], { allowFail: true });
      r = await test();
    }
    if (r.code !== 0) { state = "fail"; failMsg = "no pude instalar OpenCV"; return false; }
    state = "ok";
    return true;
  })();
  try { return await installing; } finally { installing = null; }
}

/**
 * Analiza el tramo [start, start+dur] de `source` y devuelve el plan de encuadre, o null.
 * words: [{t (seg absolutos del source), s (hablante|null)}]
 */
async function analyze({ ffmpeg, source, start, dur, words = [], workDir, log = () => {}, signal }) {
  if (!(await ensure(log))) { log(`  Encuadre inteligente no disponible (${failMsg}); uso el clásico.`); return null; }
  const py = pythonCmd();
  const wf = path.join(workDir, `rf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
  const of = wf.replace(/\.json$/, "_out.json");
  fs.writeFileSync(wf, JSON.stringify(words.filter((w) => w.t >= start && w.t < start + dur).map((w) => ({ t: +(w.t - start).toFixed(2), s: w.s ?? null }))));
  try {
    const r = await run(py[0], [...py.slice(1), SCRIPT, ffmpeg, source, start.toFixed(3), dur.toFixed(3), wf, of], { allowFail: true, signal });
    if (r.code !== 0 || !fs.existsSync(of)) {
      const m = /REFRAME_ERROR: (.*)/.exec(r.stderr || "");
      log(`  Encuadre inteligente falló (${m ? m[1] : "código " + r.code}); uso el clásico.`);
      return null;
    }
    return JSON.parse(fs.readFileSync(of, "utf8"));
  } catch (e) {
    log(`  Encuadre inteligente falló (${e.message}); uso el clásico.`);
    return null;
  } finally {
    for (const f of [wf, of]) try { fs.unlinkSync(f); } catch {}
  }
}

/** Expresión de ffmpeg con cortes secos: valor que cambia en cada t. */
function stepExpr(shots, key) {
  let e = String(shots[shots.length - 1][key]);
  for (let i = shots.length - 2; i >= 0; i--) e = `if(lt(t,${shots[i + 1].t}),${shots[i][key]},${e})`;
  return e;
}

/** Cadena de filtros de video para el plan (termina en [rv], 1080x1920). null = usar clásico. */
function filterFor(plan) {
  if (!plan) return null;
  if (plan.layout === "stream" && plan.cam && plan.game) {
    const g = plan.game, c = plan.cam;
    return `[0:v]split[g0][c0];` +
      `[g0]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[g1];` +
      `[c0]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[c1];` +
      `[g1][c1]vstack=inputs=2,drawbox=x=0:y=956:w=1080:h=8:color=black@0.9:t=fill[rv]`;
  }
  if ((plan.layout === "talk" || plan.layout === "center") && plan.crop && plan.shots?.length) {
    const { w, h } = plan.crop;
    const shots = plan.shots.slice(0, 120);
    return `[0:v]crop=${w}:${h}:'${stepExpr(shots, "x")}':'${stepExpr(shots, "y")}',scale=1080:1920:flags=lanczos,setsar=1[rv]`;
  }
  return null;
}

/** Dónde van título y subtítulos según el encuadre. */
function textLayout(plan) {
  if (!plan || plan.layout === "fit") return null;
  if (plan.layout === "stream") return { titleY: 300, subMarginV: 900 };
  return { titleY: 330, subMarginV: 430 };
}

module.exports = { analyze, filterFor, textLayout, ensure };
