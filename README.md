# ClipSphere

**Creado por Erick Ramírez** · © 2026 · Todos los derechos reservados (ver `LICENCIA.txt`).

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

Arriba, el selector **Videos | Directos** cambia de sección. Cada una tiene su propio historial.

- Pega el link de un **directo en vivo** (YouTube, Kick, Twitch, TikTok, Facebook…): se graba 30 min, 1 h, 2 h, 4 h o **hasta que termine** (máx. 12 h) y luego se sacan los clips con el mismo motor. El botón **Terminar grabación y sacar clips** corta cuando quieras.
- También acepta la **repetición** de un directo que ya terminó (aunque dure horas).
- Pensado para horas: graba en tramos y reconecta si la señal se corta; si se cierra la app, lo grabado se conserva y **Reintentar** sigue desde ahí.
- Si pegas un en vivo en *Videos*, se pasa solo a *Directos*.

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
