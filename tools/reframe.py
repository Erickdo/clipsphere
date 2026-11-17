# -*- coding: utf-8 -*-
"""
ClipSphere · encuadre inteligente 9:16.

Analiza un tramo de video y decide cómo llevarlo a vertical:
  - "talk":   entrevistas / podcasts -> sigue a la persona que habla con cortes secos.
  - "stream": juego o pantalla con webcam en una esquina -> pantalla dividida
              (arriba el juego, abajo la cara del streamer).
  - "center": sin caras -> recorte que sigue el movimiento.

Uso:
  python reframe.py <ffmpeg> <video> <inicio> <duracion> <palabras.json|-> <salida.json>

palabras.json (opcional): [{"t": seg_relativo, "s": hablante_o_null}, ...]
La salida es JSON con el plan de encuadre; ClipSphere hace el render con ffmpeg.
"""
import json, os, re, subprocess, sys
import numpy as np
import cv2

FPS = 5            # fotogramas analizados por segundo
AW = 640           # ancho de análisis
MIN_SHOT = 1.0     # duración mínima de un plano (seg)
HERE = os.path.dirname(os.path.abspath(__file__))


def probe_size(ffmpeg, video):
    r = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, text=True, errors="ignore")
    for line in r.stderr.splitlines():
        if "Video:" in line:
            m = re.search(r"\b(\d{2,5})x(\d{2,5})\b", line)
            if m:
                return int(m.group(1)), int(m.group(2))
    raise RuntimeError("no pude leer el tamaño del video")


def read_frames(ffmpeg, video, start, dur, W, H):
    ah = int(round(AW * H / W / 2) * 2)
    cmd = [ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{dur:.3f}",
           "-an", "-vf", f"fps={FPS},scale={AW}:{ah}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = AW * ah * 3
    frames = []
    while True:
        b = p.stdout.read(size)
        if len(b) < size:
            break
        frames.append(np.frombuffer(b, np.uint8).reshape(ah, AW, 3))
    p.wait()
    return frames, ah


class Detector:
    def __init__(self, w, h):
        self.yn = None
        model = os.path.join(HERE, "face_yunet.onnx")
        try:
            if hasattr(cv2, "FaceDetectorYN") and os.path.exists(model):
                self.yn = cv2.FaceDetectorYN.create(model, "", (w, h), 0.7, 0.3, 50)
        except Exception:
            self.yn = None
        if self.yn is None:
            self.haar = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))

    def __call__(self, img):
        """Lista de (x, y, w, h, score, mouth_x, mouth_y)."""
        out = []
        if self.yn is not None:
            _, faces = self.yn.detect(img)
            if faces is not None:
                for f in faces:
                    x, y, w, h = f[:4]
                    mx, my = (f[10] + f[12]) / 2, (f[11] + f[13]) / 2  # comisuras de la boca
                    out.append((float(x), float(y), float(w), float(h), float(f[14]), float(mx), float(my)))
        else:
            g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            for (x, y, w, h) in self.haar.detectMultiScale(g, 1.1, 5, minSize=(24, 24)):
                out.append((float(x), float(y), float(w), float(h), 0.8, x + w / 2, y + h * 0.78))
        return [f for f in out if f[2] >= 14]


def scene_cuts(frames):
    """Índices donde empieza un plano nuevo (cambio de cámara en el original)."""
    cuts = [0]
    prev = None
    for i, fr in enumerate(frames):
        small = cv2.cvtColor(cv2.resize(fr, (64, 36)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([small], [0, 1], None, [16, 8], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        if prev is not None and cv2.compareHist(prev, hist, cv2.HISTCMP_BHATTACHARYYA) > 0.45 and i - cuts[-1] >= 2:
            cuts.append(i)
        prev = hist
    return cuts


def mouth_patch(gray, f):
    x, y, w, h, _, mx, my = f
    pw, ph = w * 0.55, h * 0.32
    x0, y0 = int(max(0, mx - pw / 2)), int(max(0, my - ph / 2))
    x1, y1 = int(min(gray.shape[1], mx + pw / 2)), int(min(gray.shape[0], my + ph / 2))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 18)).astype(np.float32)


def track_faces(frames, dets, cuts):
    """Agrupa caras en 'pistas' dentro de cada plano. Devuelve lista de pistas."""
    tracks = []
    bounds = cuts + [len(frames)]
    for si in range(len(cuts)):
        a, b = bounds[si], bounds[si + 1]
        live = []
        for i in range(a, b):
            gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
            used = set()
            for f in sorted(dets[i], key=lambda f: -f[2]):
                cx, cy = f[0] + f[2] / 2, f[1] + f[3] / 2
                best, bd = None, 1e9
                for t in live:
                    if id(t) in used:
                        continue
                    lx, ly, lw = t["last"]
                    d = ((cx - lx) ** 2 + (cy - ly) ** 2) ** 0.5
                    if d < max(lw, f[2]) * 0.8 and d < bd:
                        best, bd = t, d
                if best is None:
                    best = {"scene": si, "pts": {}, "act": {}, "prev": None, "last": None}
                    live.append(best)
                    tracks.append(best)
                used.add(id(best))
                patch = mouth_patch(gray, f)
                act = 0.0
                if patch is not None and best["prev"] is not None:
                    act = float(np.mean(np.abs(patch - best["prev"]))) / 255.0
                best["prev"] = patch
                best["last"] = (cx, cy, f[2])
                best["pts"][i] = f
                best["act"][i] = act
            for t in live:  # si una pista no aparece, se reinicia su boca
                if id(t) not in used:
                    t["prev"] = None
    for t in tracks:
        ws = [f[2] for f in t["pts"].values()]
        cxs = [f[0] + f[2] / 2 for f in t["pts"].values()]
        cys = [f[1] + f[3] / 2 for f in t["pts"].values()]
        t["n"] = len(t["pts"])
        t["w"] = float(np.median(ws))
        t["h"] = float(np.median([f[3] for f in t["pts"].values()]))
        t["cx"], t["cy"] = float(np.median(cxs)), float(np.median(cys))
        t["sx"] = float(np.std(cxs)) if len(cxs) > 1 else 0.0
        del t["prev"], t["last"]
    return [t for t in tracks if t["n"] >= 2]


def motion_center_x(frames, a, b, exclude=None):
    """Centro horizontal del movimiento entre a y b (en coordenadas de análisis)."""
    acc = np.zeros(frames[0].shape[1], np.float64)
    for i in range(max(a + 1, 1), b):
        d = cv2.absdiff(cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY), cv2.cvtColor(frames[i - 1], cv2.COLOR_BGR2GRAY))
        d = d.astype(np.float64)
        if exclude is not None:
            x0, y0, x1, y1 = exclude
            d[int(y0):int(y1), int(x0):int(x1)] = 0
        acc += d.sum(axis=0)
    if acc.sum() <= 0:
        return frames[0].shape[1] / 2
    xs = np.arange(len(acc))
    c = float((acc * xs).sum() / acc.sum())
    return 0.5 * c + 0.5 * frames[0].shape[1] / 2  # sin irse a los bordes


def find_webcam(tracks, n, aw, ah):
    """Una cara pequeña, quieta y en una esquina durante buena parte del clip = webcam de stream."""
    best = None
    for t in tracks:
        if t["n"] < n * 0.45:
            continue
        small = t["w"] < aw * 0.13
        still = t["sx"] < aw * 0.03
        edge_x = t["cx"] < aw * 0.34 or t["cx"] > aw * 0.66
        edge_y = t["cy"] < ah * 0.42 or t["cy"] > ah * 0.58
        if small and still and edge_x and edge_y:
            if best is None or t["n"] > best["n"]:
                best = t
    return best


def smooth(v, k=3):
    if len(v) < k:
        return v
    return np.convolve(v, np.ones(k) / k, mode="same")


def plan_talk(frames, tracks, cuts, n, words):
    """Por cada fotograma, qué pista está hablando. Devuelve lista de (t_inicio, pista|None, plano)."""
    bounds = cuts + [n]
    speakers = [w.get("s") for w in words] if words else []
    has_diar = any(s is not None for s in speakers) and len(set(s for s in speakers if s is not None)) > 1
    owner = [None] * n
    for si in range(len(cuts)):
        a, b = bounds[si], bounds[si + 1]
        st = [t for t in tracks if t["scene"] == si]
        if not st:
            continue
        if len(st) == 1:
            for i in range(a, b):
                owner[i] = st[0]
            continue
        acts = {id(t): smooth(np.array([t["act"].get(i, 0.0) if i in t["pts"] else -1.0 for i in range(a, b)]), 3) for t in st}
        if has_diar:
            # cada turno de palabra (hablante) -> la cara con más boca en ese turno
            turns = []
            for w in words:
                if w.get("s") is None:
                    continue
                if turns and turns[-1][1] == w["s"]:
                    turns[-1][2] = w["t"]
                else:
                    turns.append([w["t"], w["s"], w["t"]])
            score = {}
            for t0, s, t1 in turns:
                i0, i1 = int(t0 * FPS), int(t1 * FPS) + 2
                for t in st:
                    seg = acts[id(t)][max(0, i0 - a):max(0, i1 - a)]
                    if len(seg):
                        score[(s, id(t))] = score.get((s, id(t)), 0) + float(np.clip(seg, 0, None).sum())
            spk_face = {}
            for s in set(x[1] for x in turns):
                cand = [(score.get((s, id(t)), 0), t) for t in st]
                cand.sort(key=lambda c: -c[0])
                if cand and cand[0][0] > 0:
                    spk_face[s] = cand[0][1]
            cur = None
            ti = 0
            for i in range(a, b):
                tt = i / FPS
                while ti + 1 < len(turns) and turns[ti + 1][0] <= tt:
                    ti += 1
                if turns and turns[ti][0] <= tt + 0.2 and turns[ti][1] in spk_face:
                    cur = spk_face[turns[ti][1]]
                owner[i] = cur or max(st, key=lambda t: t["n"])
        else:
            cur = None
            for i in range(a, b):
                vis = [t for t in st if i in t["pts"]]
                if not vis:
                    owner[i] = cur
                    continue
                win = max(vis, key=lambda t: acts[id(t)][i - a])
                if cur is None or cur not in vis:
                    cur = win
                elif win is not cur and acts[id(win)][i - a] > acts[id(cur)][i - a] * 1.35 + 0.002:
                    # retroceder al momento en que el nuevo empezó a hablar más (cambio de voz)
                    raw = lambda t, j: t["act"].get(j, 0.0)
                    j = i
                    while j - 1 >= max(a, i - 5) and raw(win, j - 1) > raw(cur, j - 1) and owner[j - 1] is cur:
                        j -= 1
                    for q in range(j, i):
                        owner[q] = win
                    cur = win
                owner[i] = cur
    return owner


def to_shots(owner, cuts, n, words):
    """Pasa de dueños por fotograma a planos (mín. MIN_SHOT); los cambios caen en el inicio de una palabra."""
    starts = [w["t"] for w in (words or [])]
    cutset = set(cuts)
    runs = []
    for i in range(n):
        if not runs or owner[i] is not runs[-1][1] or i in cutset:
            runs.append([i, owner[i]])
    ends = lambda k: runs[k + 1][0] if k + 1 < len(runs) else n
    changed = True
    while changed:  # quitar planos demasiado cortos dentro de un mismo plano de cámara
        changed = False
        for k in range(len(runs)):
            if (ends(k) - runs[k][0]) / FPS >= MIN_SHOT:
                continue
            if runs[k][0] not in cutset and k > 0:
                runs.pop(k); changed = True; break          # se queda el hablante anterior
            if k + 1 < len(runs) and runs[k + 1][0] not in cutset:
                runs[k][1] = runs[k + 1][1]; runs.pop(k + 1); changed = True; break
        if not changed:
            for k in range(1, len(runs)):
                if runs[k][1] is runs[k - 1][1] and runs[k][0] not in cutset:
                    runs.pop(k); changed = True; break
    out = []
    for i, o in runs:
        t = i / FPS
        if i not in cutset and starts:
            near = min(starts, key=lambda x: abs(x - t))
            if abs(near - t) <= 0.45:
                t = max(0.0, near - 0.04)
        out.append((t, o, i))
    return out


def main():
    ffmpeg, video, start, dur, words_file, out_file = sys.argv[1:7]
    start, dur = float(start), float(dur)
    words = []
    if words_file != "-" and os.path.exists(words_file):
        with open(words_file, encoding="utf-8") as fh:
            words = json.load(fh)
    W, H = probe_size(ffmpeg, video)
    frames, ah = read_frames(ffmpeg, video, start, dur, W, H)
    n = len(frames)
    if n < 3:
        raise RuntimeError("tramo demasiado corto")
    sc = W / AW
    det = Detector(AW, ah)
    dets = [det(f) for f in frames]
    cuts = scene_cuts(frames)
    tracks = track_faces(frames, dets, cuts)
    face_frames = sum(1 for d in dets if d)
    ev = lambda v: int(round(v / 2) * 2)
    res = {"W": W, "H": H, "frames": n, "faceFrames": face_frames, "scenes": len(cuts)}

    # ---------- vertical o casi vertical: no hace falta nada ----------
    if W / H < 0.75:
        res.update(layout="fit")
        return write(out_file, res)

    # ---------- stream con webcam ----------
    cam = find_webcam(tracks, n, AW, ah)
    if cam is not None and W / H > 1.3:
        fw, fh = cam["w"] * sc, cam["h"] * sc
        ch = min(H * 0.6, max(fh * 2.6, H * 0.22))
        cw = ch * 9 / 8
        cx, cy = cam["cx"] * sc, cam["cy"] * sc - fh * 0.1
        x0 = min(max(0, cx - cw / 2), W - cw)
        y0 = min(max(0, cy - ch / 2), H - ch)
        gh = H
        gw = min(W, gh * 9 / 8)
        ex = ((cx - fw * 2) / sc, (cy - fh * 2) / sc, (cx + fw * 2) / sc, (cy + fh * 2) / sc)
        mx = motion_center_x(frames, 0, n, ex) * sc
        gx = min(max(0, mx - gw / 2), W - gw)
        res.update(layout="stream",
                   cam={"x": ev(x0), "y": ev(y0), "w": ev(cw), "h": ev(ch)},
                   game={"x": ev(gx), "y": 0, "w": ev(gw), "h": ev(gh)})
        return write(out_file, res)

    # ---------- conversación (una o varias caras) ----------
    if tracks and face_frames >= n * 0.3:
        main_tr = [t for t in tracks if t["n"] >= 3] or tracks
        fh_med = float(np.median([t["h"] for t in main_tr])) * sc
        ch = min(H, max(H * 0.62, fh_med * 4.2))
        cw = ch * 9 / 16
        if cw > W:
            cw, ch = W, W * 16 / 9
        owner = plan_talk(frames, tracks, cuts, n, words)
        shots = to_shots(owner, cuts, n, words)
        bounds = cuts + [n]
        out = []
        last_xy = None
        for k, (t, o, i) in enumerate(shots):
            nxt = shots[k + 1][2] if k + 1 < len(shots) else n
            if o is not None:
                pts = [o["pts"][j] for j in range(i, nxt) if j in o["pts"]] or list(o["pts"].values())
                fx = float(np.median([p[0] + p[2] / 2 for p in pts])) * sc
                fy = float(np.median([p[1] + p[3] / 2 for p in pts])) * sc
                x = fx - cw / 2
                y = fy - ch * 0.36
            else:
                si = max(j for j, c in enumerate(cuts) if c <= i)
                mx = motion_center_x(frames, i, max(i + 2, min(nxt, bounds[si + 1]))) * sc
                x, y = mx - cw / 2, (H - ch) / 2
            x = min(max(0, x), W - cw)
            y = min(max(0, y), H - ch)
            xy = (ev(x), ev(y))
            if last_xy and abs(xy[0] - last_xy[0]) < cw * 0.06 and abs(xy[1] - last_xy[1]) < ch * 0.06:
                continue  # mismo encuadre: no cortar por nada
            out.append({"t": round(t, 2), "x": xy[0], "y": xy[1]})
            last_xy = xy
        res.update(layout="talk", crop={"w": ev(cw), "h": ev(ch)}, shots=out,
                   speakers=len(set(id(t) for _, t, _ in shots if t is not None)))
        return write(out_file, res)

    # ---------- sin caras: sigue el movimiento por plano ----------
    ch = H
    cw = min(W, H * 9 / 16)
    bounds = cuts + [n]
    out = []
    for si, a in enumerate(cuts):
        mx = motion_center_x(frames, a, bounds[si + 1]) * sc
        out.append({"t": round(a / FPS, 2), "x": ev(min(max(0, mx - cw / 2), W - cw)), "y": 0})
    res.update(layout="center", crop={"w": ev(cw), "h": ev(ch)}, shots=out)
    write(out_file, res)


def write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # ClipSphere usa el encuadre clásico si esto falla
        print("REFRAME_ERROR: " + str(e), file=sys.stderr)
        sys.exit(2)
