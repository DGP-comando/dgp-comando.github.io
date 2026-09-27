// src/camera.js
//
// Enquadramentos de câmera da Sala de Situação sobre o motor MapLibre
// (src/maplibre/engine.js). A câmera continua em semântica Cesium (posição da
// câmera lat/lon/alt, heading, pitch -90 = nadir): o motor converte.

/**
 * Enquadramento canonico da Sala de Situacao: o Parana inteiro em quadro,
 * NORTE PARA CIMA e vista ORTOGONAL (pitch -90). E para onde o voo de
 * abertura chega e para onde o botao de reset volta — o mesmo quadro, para
 * que "visao geral do estado" signifique sempre a mesma coisa.
 */
export const PARANA_OVERVIEW = Object.freeze({
  lon: -51.6,
  lat: -24.7,
  heightM: 900_000,
  durationS: 3.5,
});

/** Retângulo do Paraná [w, s, e, n] usado no enquadramento (divisas do IBGE com folga). */
export const PARANA_OVERVIEW_BBOX = Object.freeze([-54.62, -26.72, -48.02, -22.52]);

/**
 * Voa ate o enquadramento estadual (norte para cima, nadir). Solta qualquer
 * alvo acompanhado antes do voo.
 * @param {object} engine motor MapLibre
 * @param {{duration?: number, complete?: Function, cancel?: Function}} [options]
 * @returns {{latitude: number, longitude: number, heightM: number}}
 */
export function flyToParanaOverview(engine, options = {}) {
  engine.cancelFlight?.();
  if (engine.trackedTarget) engine.track?.(null);
  const duration = Number.isFinite(options.duration) && options.duration > 0
    ? options.duration
    : PARANA_OVERVIEW.durationS;
  engine.flyToBounds([...PARANA_OVERVIEW_BBOX], {
    pitch: -90,
    heading: 0,
    padding: 40,
    duration,
    complete: options.complete,
    cancel: options.cancel,
  });
  return {
    latitude: PARANA_OVERVIEW.lat,
    longitude: PARANA_OVERVIEW.lon,
    heightM: PARANA_OVERVIEW.heightM,
  };
}

/**
 * Voo de abertura da Sala de Situacao: o Parana inteiro em quadro (visao
 * estadual), nao um mergulho urbano — o operador escolhe onde descer.
 * Parte de uma vista alta (globo) e desce até o estado.
 */
export function flyToParana(engine) {
  engine.setCameraView({
    lat: PARANA_OVERVIEW.lat,
    lon: PARANA_OVERVIEW.lon,
    alt: 4_000_000,
    heading: 0,
    pitch: -90,
    roll: 0,
  });
  setTimeout(() => flyToParanaOverview(engine), 400);
}
