// Uso (para el autor): node make-manifest.js 1.2.0 "Nota 1" "Nota 2"
// Genera manifest.json con la versión y el sha256 de cada archivo de la app.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = __dirname;
const SKIP = new Set(["config.json", "config.json.bak", "errores.log", "manifest.json", "node_modules", ".git", "_update_tmp", "ANUNCIOS.md"]);
const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    if (SKIP.has(n) || n.endsWith(".new") || n.endsWith(".guardando")) continue;
    const p = path.join(d, n), rel = path.relative(ROOT, p).split(path.sep).join("/");
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
  }
})(ROOT);
const [version = "1.0.0", ...notes] = process.argv.slice(2);
fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify({ version, date: new Date().toISOString().slice(0, 10), notes, files }, null, 2));
console.log(`manifest.json ${version}: ${files.length} archivos`);
