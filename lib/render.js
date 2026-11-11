// ClipSphere © 2026 Erick Ramírez. Todos los derechos reservados. Ver LICENCIA.txt
// Render vertical 1080x1920: fondo desenfocado, video completo, título arriba,
// subtítulos en MAYÚSCULAS y atribución. Todo el texto va en un .ass (libass),
// así no hay que pelear con rutas de fuentes en drawtext en Windows.
const fs = require("node:fs");
const path = require("node:path");
const { run } = require("./util");

function assTime(x) {
  x = Math.max(0, x);
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function esc(s) {
  return String(s).replace(/[{}]/g, "").replace(/\\/g, "／").replace(/\n/g, " ");
}

/** Quita emojis/símbolos que la fuente no tiene (se verían como cuadritos). */
function stripEmoji(s) {
  return String(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();
}

function cleanWord(w) {
  return w.replace(/\[\s*_+\s*\]/g, "***");
}

/**
 * Construye el .ass del clip. words = [{t,w}] absolutos del video original.
 * start/end = recorte en segundos del original.
 */
function buildAss({ words, start, end, title, attribution, font, wordsPerCaption = 3 }) {
  const dur = end - start;
  const capWords = words.filter((x) => x.t >= start - 0.05 && x.t < end);
  const ev = [];
  // Título: caja semitransparente, centrado, abajo-centrado en y=610 (justo encima del video 16:9)
  ev.push(`Dialogue: 1,${assTime(0)},${assTime(dur)},Title,,0,0,0,,{\\an2\\pos(540,610)}${esc(stripEmoji(title).toUpperCase())}`);
  if (attribution) ev.push(`Dialogue: 1,${assTime(0)},${assTime(dur)},Attr,,0,0,0,,${esc(attribution)}`);
  for (let i = 0; i < capWords.length; i += wordsPerCaption) {
    const grp = capWords.slice(i, i + wordsPerCaption);
    const next = capWords[i + wordsPerCaption];
    const s = grp[0].t - start;
    let e = (next ? next.t : end) - start;
    e = Math.min(e, s + 2.5, dur);
    if (e <= s) continue;
    const text = grp.map((x) => cleanWord(x.w)).join(" ").toUpperCase();
    ev.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Sub,,0,0,0,,${esc(text)}`);
  }
  // Colores ASS en &HAABBGGRR. Amarillo FFE100 → &H0000E1FF
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,${font},76,&H0000E1FF,&H0000E1FF,&H50000000,&H00000000,-1,0,0,0,100,100,0,0,3,16,0,2,90,90,0,1
Style: Sub,${font},62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,70,70,430,1
Style: Attr,${font},32,&H30FFFFFF,&H30FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join("\n")}
`;
}

/** Copia la fuente a <jobDir>/fonts para que libass la encuentre sin rutas raras. */
function prepareFont(jobDir, fontFile) {
  const dir = path.join(jobDir, "fonts");
  fs.mkdirSync(dir, { recursive: true });
  if (fontFile && fs.existsSync(fontFile)) {
    const dest = path.join(dir, path.basename(fontFile));
    if (!fs.existsSync(dest)) fs.copyFileSync(fontFile, dest);
  }
}

/** Renderiza un clip. onProgress(0..1). */
async function renderClip({ ffmpeg, jobDir, source, clip, assName, outName, encoder = "libx264", onProgress, signal }) {
  const dur = clip.end - clip.start;
  const vf =
    "[0:v]split[a][b];" +
    "[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.25,setsar=1[bg];" +
    "[b]scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[fg];" +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,ass=${assName}:fontsdir=fonts[v]`;
  const enc = {
    libx264: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"],
    h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23"],
    h264_qsv: ["-c:v", "h264_qsv", "-global_quality", "23"],
    h264_amf: ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24"],
  }[encoder] || ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
    "-ss", clip.start.toFixed(3), "-i", source, "-t", dur.toFixed(3),
    "-filter_complex", vf, "-map", "[v]", "-map", "0:a:0?",
    ...enc, "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outName,
  ];
  let last = -1;
  await run(ffmpeg, args, {
    cwd: jobDir,
    signal,
    onLine: (l) => {
      const m = /^out_time_us=(\d+)/.exec(l);
      if (!m || !onProgress) return;
      const p = Math.min(1, +m[1] / 1e6 / dur);
      if (p - last >= 0.05 || p >= 1) { last = p; onProgress(p); }
    },
  });
}

async function thumbnail({ ffmpeg, jobDir, video, outName, at = 1.5 }) {
  await run(ffmpeg, ["-y", "-v", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", outName], { cwd: jobDir, allowFail: true });
}

module.exports = { buildAss, renderClip, prepareFont, thumbnail, stripEmoji };
