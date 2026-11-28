// ClipSphere — © 2026 NexTech360 (Erick Ramírez). Todos los derechos reservados. Ver LICENCIA.txt
/**
 * Eventos de un trabajo con memoria acotada. Un directo de 12 h emite miles de mensajes:
 * se guardan los primeros (cómo empezó) y los más recientes; en medio queda un aviso con cuántos se omitieron.
 * Los "progress" seguidos del mismo paso y clip se funden en uno (solo importa el último valor).
 * A quien se conecta tarde por SSE se le reenvía lo guardado: nunca más de `max` mensajes.
 */
const EVENTS_MAX = 1500, EVENTS_HEAD = 40;

function keepEvent(list, ev, max = EVENTS_MAX, head = EVENTS_HEAD) {
  const last = list[list.length - 1];
  if (ev.type === "progress" && last && last.type === "progress" && last.id === ev.id && last.clip === ev.clip) { list[list.length - 1] = ev; return list; }
  list.push(ev);
  if (list.length > max) {
    const marker = list[head]?.omitted ? list[head] : null;
    const removed = list.splice(head + (marker ? 1 : 0), list.length - max + (marker ? 0 : 1)).length;
    const total = (marker?.omitted || 0) + removed;
    const m = { type: "log", omitted: total, msg: `… ${total} mensajes antiguos omitidos para ahorrar memoria …`, at: ev.at };
    if (marker) list[head] = m; else list.splice(head, 0, m);
  }
  return list;
}

module.exports = { keepEvent, EVENTS_MAX, EVENTS_HEAD };
