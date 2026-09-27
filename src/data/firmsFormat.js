// src/data/firmsFormat.js
//
// Regras puras (sem Cesium) dos focos de calor FIRMS: severidade por FRP e
// confiança, tamanho do marcador, placar de calor das células e a formatação
// dos cards. Movidas de firmsHeatmap.js (que importa daqui) para o protótipo
// MapLibre reaproveitar exatamente a mesma apresentação.

/**
 * Severidade de uma detecção a partir de FRP + confiança: os mesmos limiares
 * amarelo → laranja → vermelho das células de calor agregadas.
 * @param {{frp:number, confidence:number}} fire
 * @returns {'red'|'orange'|'yellow'}
 */
export function detectionSeverity(fire) {
  const heat = Math.min(1, Math.sqrt(Math.max(0, fire.frp) / 150) * 0.85 + fire.confidence * 0.15);
  if (heat > 0.72) return 'red';
  if (heat > 0.42) return 'orange';
  return 'yellow';
}

/** Placar normalizado (0..1) de uma célula → severidade (limiares de heatColor). */
export function cellSeverity(normalized) {
  if (normalized > 0.72) return 'red';
  if (normalized > 0.42) return 'orange';
  return 'yellow';
}

/** Intensidade de uma detecção na agregação por células. */
export function fireIntensity(fire) {
  // confidence is normalized 0..1 — weight ×4 preserves the old 0..100×0.04 scale.
  return Math.max(1, fire.frp * 0.18 + fire.confidence * 4 + fire.brightness * 0.01);
}

export function heatScore(cell) {
  return cell.intensity + cell.count * 0.8 + cell.night * 0.6 + cell.maxFrp * 0.12;
}

/** FRP → core marker pixel size, clamped to 8..28px. */
export function frpPixelSize(frp) {
  return Math.max(8, Math.min(28, Math.round(8 + Math.sqrt(Math.max(0, frp)) * 2)));
}

/** Coordinate line like "30.512°N 75.831°E". */
export function formatLatLon(lat, lon) {
  const latPart = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonPart = `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latPart} ${lonPart}`;
}

export function formatFrp(frp) {
  return frp >= 10 ? frp.toFixed(0) : frp.toFixed(1);
}

/** Millisecond delta → "<1h" / "Xh" / "Xd", or '' for invalid input. */
export function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return '';
  const hours = deltaMs / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Millisecond delta → "<1m ago" / "Xm ago" / "Xh ago" (fresh-feed readout). */
export function formatAgoMinutes(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return '<1m ago';
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Normalized 0..1 confidence → low/nominal/high display bucket. */
export function confidenceBucket(confidence) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.45) return 'nominal';
  return 'low';
}
