// src/data/newArrivalHighlight.js
//
// Destaque de itens que chegaram no ultimo poll (padrao "new arrival" do
// osiris): o ponto ganha um contorno de destaque por um tempo fixo e depois
// volta ao estilo original. Duas escritas estaticas (liga/desliga), sem
// CallbackProperty por frame, respeitando a regra de performance das camadas
// DataGeo (cabecalho de datageoLayers.js).

export const NEW_ARRIVAL_MS = 60_000;
export const NEW_ARRIVAL_OUTLINE_WIDTH = 3;

/**
 * Aplica o destaque nos pontos das entidades e agenda a restauracao.
 * @param {Iterable<object>} entities entidades Cesium (ou objetos com `.point`).
 * @param {object} options
 * @param {*} options.outlineColor cor do contorno de destaque.
 * @param {number} [options.outlineWidth]
 * @param {number} [options.durationMs]
 * @param {(fn: Function, ms: number) => *} [options.setTimer]
 * @param {(handle: *) => void} [options.clearTimer]
 * @param {(reason: string) => void} [options.onChange] pede um frame ao governor.
 * @returns {{count: number, cancel: () => void}} cancel restaura na hora.
 */
export function highlightNewArrivals(entities, {
  outlineColor,
  outlineWidth = NEW_ARRIVAL_OUTLINE_WIDTH,
  durationMs = NEW_ARRIVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
} = {}) {
  const saved = [];
  for (const entity of entities ?? []) {
    const point = entity?.point;
    if (!point) continue;
    saved.push({ point, color: point.outlineColor, width: point.outlineWidth });
    point.outlineColor = outlineColor;
    point.outlineWidth = outlineWidth;
  }
  if (saved.length === 0) return { count: 0, cancel: () => {} };
  onChange('new-arrival-on');

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const { point, color, width } of saved) {
      point.outlineColor = color;
      point.outlineWidth = width;
    }
    onChange('new-arrival-off');
  };
  const handle = setTimer(restore, durationMs);
  return {
    count: saved.length,
    cancel() {
      clearTimer(handle);
      restore();
    },
  };
}

/**
 * Texto do contador do painel: "1.234" ou "1.234 +3" quando o ultimo refresh
 * (que nao seja o inicial) trouxe itens novos ha menos de `windowMs`.
 * @param {{count?: number, newCount?: number, initialRefresh?: boolean, lastUpdate?: number}} stats
 * @param {(n: number) => string} formatCount
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {{text: string, fresh: number}}
 */
export function countWithArrivals(stats, formatCount, now = Date.now(), windowMs = 10 * 60_000) {
  const count = Number(stats?.count) || 0;
  const base = count ? formatCount(count) : '—';
  const fresh = Number(stats?.newCount) || 0;
  const recent = Number(stats?.lastUpdate) > 0 && now - Number(stats.lastUpdate) < windowMs;
  if (!count || fresh <= 0 || stats?.initialRefresh || !recent) return { text: base, fresh: 0 };
  return { text: `${base} +${fresh}`, fresh };
}
