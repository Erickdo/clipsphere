# ClipSphere

**Creado por Erick Nex · NexTech360** · © 2026 · Todos los derechos reservados (ver `LICENCIA.txt`).

Pegas el link de un video largo y ClipSphere:

1. Lee la información del video.
2. Saca la transcripción con tiempos (subtítulos de la plataforma, o Whisper si no hay).
3. La IA elige los mejores momentos (chisme, polémica, humor, tensión, historias) y escribe
   título, descripción y hashtags. Las historias largas salen como Parte 1, Parte 2…
4. Descarga el video (en paralelo mientras la IA piensa).
5. Monta cada clip en 9:16: fondo desenfocado, video completo, título arriba, subtítulos
   en MAYÚSCULAS y "Fuente: canal" abajo.
6. Deja todo en una carpeta: `c01.mp4`, `c02.mp4`…, portadas `.jpg`, `publicar.txt` y `plan.json`.

## Actualizaciones

ClipSphere revisa solo si hay versión nueva en este repositorio. Cuando la hay, aparece un aviso
arriba con el botón **Actualizar**: baja solo lo que cambió y se reinicia. Tus claves y tu historial
no se tocan.

## Directos (Live Clips)

Arriba, el selector **Videos | Directos | 🚀 Lanzamientos** cambia de sección. Cada una tiene su propio historial.

- Pega el link de un **directo en vivo** (YouTube, Kick, Twitch, TikTok, Facebook…). ClipSphere lo **vigila mientras pasa**: graba sin parar y cada 5 minutos (Ajustes → *Directos: revisar lo nuevo cada*) transcribe lo nuevo y la IA busca momentos con potencial viral para tu público (*Público / países*). Cuando encuentra uno, **el clip sale al momento**, mientras el directo sigue.
- *Vigilar el directo*: hasta que termine (máx. 12 h) o 30 min / 1 h / 2 h / 4 h. **Terminar grabación y sacar clips** corta cuando quieras.
- También acepta la **repetición** de un directo que ya terminó (se procesa completa).
- Aguanta horas: graba en tramos, reconecta si la señal se corta, y si se cierra la app, **Reintentar** sigue desde donde iba sin perder lo grabado ni los clips hechos.

## Motor local de momentos ⚡ (gratis, sin claves)

Desde la v1.7 ClipSphere elige los momentos **sin IA de pago**: todo se calcula en tu PC en menos de un segundo.

```
audio (solo la pista, baja calidad) ─► volumen por segundo ─┐
subtítulos de la plataforma / Whisper local ─► palabras ────┼─► puntaje por segundo ─► ventanas frase-a-frase ─► mejores N sin solapes
video (versión pequeña, 4 fps) ─► cambios de escena ────────┘        (pesos)            (bordes en pausas)
```

- **Volumen:** subidas y golpes bruscos (gritos, risas, aplausos, discusión).
- **Palabras clave:** ganchos, preguntas, énfasis, emoción, polémica, risas, números y jerga dominicana (`lib/local.js` → `LEX`).
- **Ritmo:** palabras por segundo (hablar rápido = emoción).
- **Escenas:** cortes de cámara y cambios bruscos de imagen.
- **Bordes:** cada clip empieza al inicio de una frase y termina en una pausa natural; si la frase anterior es fuerte (lo que inicia el pleito), se incluye.
- **Título, gancho, descripción, hashtags y etiqueta** salen de las frases más fuertes del propio clip.

**Pesos:** ⚙️ Ajustes → *Motor local · pesos* (vacío = automático según **Buscar**). Por defecto:

| Buscar | Volumen | Palabras | Ritmo | Escenas |
|---|---|---|---|---|
| Todo lo viral | 0.30 | 0.40 | 0.20 | 0.10 |
| Peleas y discusiones | 0.45 | 0.35 | 0.15 | 0.05 |
| Streamers | 0.40 | 0.30 | 0.15 | 0.15 |

Más fino en `lib/local.js` → `TUNING` (peso del gancho, del mejor tramo, castigo por silencios, clips por minuto, exigencia).

Claude / Gemini / Ollama siguen como **opción** en ⚙️ Ajustes (escriben títulos más creativos). Si una IA se queda sin crédito, ClipSphere sigue solo con el motor local. Las misiones 1, 2 y 4 de 🚀 Lanzamientos escriben textos y necesitan una IA: basta la clave **gratis** de Gemini.

## Encuadre vertical 9:16 🎯

**Por defecto (Completo):** cada clip sale vertical 1080×1920 con **todo el video original visible**, sin recortes ni zoom, centrado sobre el mismo video difuminado.

**Opcional (Inteligente, en ⚙️ Ajustes):** recorta para poner a la persona en grande:

- **Entrevistas y podcasts:** ClipSphere detecta las caras, mira quién mueve la boca (y, con Deepgram, quién dice cada palabra) y hace **cortes secos** al que tiene la palabra, en primer plano medio.
- **Streams con webcam:** si hay una cara pequeña y fija en una esquina, la pantalla se divide: **arriba el juego** (centrado en la acción) y **abajo la cara del streamer**. Los subtítulos van en la línea del medio.
- **Sin caras:** el recorte sigue el movimiento.
- Si el video original cambia de cámara, el encuadre se recalcula en cada plano.

La primera vez instala OpenCV con Python (~1 min). Si algo falla, ese clip sale con el encuadre clásico. Se elige en ⚙️ Ajustes → *Encuadre vertical*.

## Lanzamientos (Modo Misión) 🚀

Tercera sección del selector: **Videos | Directos | 🚀 Lanzamientos**. Sirve para preparar clips
**antes** de un evento grande (un juego, un estreno, un concierto, un reality) y llegar a ese día
con todo listo. Creas una campaña (tema, fecha y hora del lanzamiento en hora de RD, público e idioma)
y arriba ves la cuenta regresiva. Después corres las misiones:

1. **Lo que busca la gente** — más de 30 consultas al autocompletado de YouTube (el tema, el tema + a…z,
   + cómo / qué / cuándo / dónde / precio). La IA agrupa las frases en temas y elige las 30 más fuertes.
   El ranking es **alta / media / baja**: YouTube no da cifras de búsquedas y ClipSphere no las inventa.
2. **Lo que más peta** — busca con yt-dlp lo más nuevo y lo más visto, calcula vistas por día y muestra
   el top 15 (Short o Largo, con su enlace). La IA saca la fórmula: ganchos, títulos, duración y portadas.
3. **Fuentes y clips** — los videos largos de la misión 2 con el botón **Sacar clips con esta campaña**
   (o pega tu propio link). Van al flujo normal de Videos, pero la IA recibe las frases clave y la fórmula,
   prefiere los momentos que responden a lo que la gente busca y mete esas frases en títulos y hashtags.
   Esos clips se marcan con la campaña y se ven también dentro de ella.
4. **Títulos y portadas** — 20 títulos en MAYÚSCULAS, 3 sets de hashtags (amplio, nicho, local RD/Latam)
   y el texto de portada de cada clip, que también se pone en su `.jpg`. Todo con botón de copiar.
5. **El lanzamiento** — calendario de publicación (D-2, D-1, la hora del lanzamiento y las horas fuertes
   del día). **Paquete del día** arma una carpeta con los clips en orden (`01_`, `02_`…), sus portadas y un
   `publicar.txt` con hora, título, descripción y hashtags. Cuando llega la hora de un clip, la app avisa
   (mensaje y sonido). **ClipSphere nunca publica solo.**

Las campañas se guardan en `_campanas/<campaña>/campana.json` dentro de tu carpeta de salida y entran
en el respaldo automático. Desde el móvil puedes ver y correr misiones; borrar campañas, solo desde la laptop.

## Respaldo automático (no se pierde nada)

ClipSphere copia tus ajustes, claves, historial y clips a **OneDrive** o **Google Drive** (los encuentra solo) cada vez que termina un clip, al guardar ajustes y cada 30 minutos. Solo copia lo nuevo y nunca borra nada del respaldo.

- **PC dañada o nueva:** instala ClipSphere, inicia sesión en el mismo OneDrive / Google Drive y abre la app: recupera sola ajustes, claves e historial.
- Ajustes → *Respaldo automático* muestra cuándo fue el último respaldo, y tiene **Respaldar ahora** y **Recuperar lo que falte**.
- Si no tienes OneDrive ni Google Drive, escribe otra carpeta (una USB o disco externo).
- Los ajustes se guardan de forma segura: si se va la luz mientras se guardan, se usa la copia anterior.

## Primera vez

1. Doble clic en **instalar.bat** (instala Node.js, yt-dlp y ffmpeg con winget).
2. Doble clic en **iniciar.bat**: se abre `http://localhost:3600` en tu navegador.
3. En **⚙️ Ajustes** elige la IA: **Gemini** (gratis, clave en aistudio.google.com/apikey), Claude (de pago) u Ollama (local).
   Alternativa gratis: elige **Ollama** si tienes un modelo instalado (`ollama pull qwen2.5:7b`);
   la calidad de los momentos es menor.

## Uso diario

Abre **iniciar.bat**, pega el link, dale a **Generar clips**. Mientras trabaja puedes ver el
progreso; los clips aparecen a medida que se renderizan. Cada tarjeta tiene botones para copiar
el título y el texto con hashtags. Los trabajos anteriores quedan abajo en el historial.

Carpeta de salida por defecto: `Vídeos\ClipSphere\<fecha>-<id del video>`.

## Ajustes útiles

- **Codificador**: si tienes tarjeta NVIDIA elige NVENC; renderiza varias veces más rápido.
- **Guardar video original**: por defecto se borra al terminar para ahorrar espacio.
- **Clips / Mín. seg / Máx. seg**: arriba del campo del link, para cada trabajo.

## Costos

Con Claude, un video de ~2 horas cuesta aproximadamente lo de procesar ~60 mil palabras de
texto: normalmente menos de 1 dólar por video. Todo lo demás corre gratis en tu PC.

## Derechos de autor

Poner la fuente es buena práctica pero **no evita reclamos ni strikes**. Pide permiso al
creador o añade comentario propio antes de publicar.

## Archivos

| Archivo | Qué hace |
|---|---|
| `server.js` | Servidor local y API (sin dependencias de npm) |
| `lib/pipeline.js` | El flujo completo de un trabajo |
| `lib/llm.js` | Llamadas a Claude u Ollama |
| `lib/subs.js` | Subtítulos y transcripción |
| `lib/render.js` | Montaje vertical con ffmpeg + libass |
| `prompts/system.md` | Instrucciones para la IA (puedes editarlas) |
| `public/index.html` | La interfaz |
| `config.json` | Tus ajustes (se crea solo) |
