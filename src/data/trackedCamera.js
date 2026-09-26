// src/data/trackedCamera.js
//
// MIGRAÇÃO MAPLIBRE (2026-09): sem Cesium. Tipos neutros:
//  - alvo rastreado: objeto com `getPosition()` -> {lon, lat, alt} (o contrato
//    de `engine.track`), opcionalmente `gevDisplayPosition()` com o mesmo
//    formato (posição já consumida pelo desenho neste quadro);
//  - vetores de câmera em `clampTrackedCameraPosition`: {x, y, z} simples
//    (qualquer referencial local, como antes).
// `applyTrackedCameraFrame(engine, alvo, viewFrom)` é o equivalente 2D do
// enquadramento ENU do Cesium: liga `engine.track(alvo)` e, uma vez, voa a
// câmera para olhar o alvo da distância `|viewFrom|` (mínimo 150 m), com o
// pitch do vetor. O acompanhamento contínuo é do engine (centro segue o alvo).

const MIN_TRACKED_RANGE_M = 150;
/**
 * Preserve real-world model scale except when a very close tracked camera
 * would make the selected aircraft dominate the viewport.
 *
 * @param {object} options
 * @param {number} options.baseScale Asset's calibrated real-world scale.
 * @param {number} options.nativeRadiusM Asset bounding radius before scale.
 * @param {number} options.rangeM Camera-to-aircraft range.
 * @param {number} options.viewportHeightPx Rendered viewport height.
 * @param {number} options.fovyRad Vertical field of view.
 * @param {number} options.maximumPixelSize Maximum selected-model diameter.
 * @returns {number} Scale to apply to the model.
 */
export function trackedModelScaleForPixelCap({
  baseScale,
  nativeRadiusM,
  rangeM,
  viewportHeightPx,
  fovyRad,
  maximumPixelSize,
}) {
  if (
    !Number.isFinite(baseScale) || baseScale <= 0
    || !Number.isFinite(nativeRadiusM) || nativeRadiusM <= 0
    || !Number.isFinite(rangeM) || rangeM <= 0
    || !Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0
    || !Number.isFinite(fovyRad) || fovyRad <= 0
    || !Number.isFinite(maximumPixelSize) || maximumPixelSize <= 0
  ) return baseScale;
  const focalLengthPx = viewportHeightPx / (2 * Math.tan(fovyRad / 2));
  const projectedDiameterPx = (
    2 * nativeRadiusM * baseScale * focalLengthPx
  ) / rangeM;
  if (projectedDiameterPx <= maximumPixelSize) return baseScale;
  return baseScale * (maximumPixelSize / projectedDiameterPx);
}

/**
 * Resolve the exact position already consumed by the tracked visual whenever
 * the layer exposes one, without advancing its dead-reckoning again.
 *
 * @param {object} target Alvo rastreado ({gevDisplayPosition?, getPosition?} ou
 *   legado com `position.getValue(time)`).
 * @param {*} [time] Ignorado no MapLibre (mantido pela assinatura).
 * @param {object} [result] Destino opcional (recebe lon/lat/alt).
 * @returns {{lon:number, lat:number, alt:number}|undefined}
 */
export function trackedDisplayPositionForCamera(target, time, result) {
  const p = target?.gevDisplayPosition?.() ?? target?.getPosition?.() ?? target?.position?.getValue?.(time);
  if (!p) return undefined;
  if (!result) return p;
  return Object.assign(result, p);
}

const v3 = {
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  mag2: (a) => a.x * a.x + a.y * a.y + a.z * a.z,
};

/**
 * Keep a tracked-frame camera on the same side of its target and outside the
 * minimum readable range. Vetores {x,y,z} relativos ao alvo.
 *
 * @param {{position: {x,y,z}, direction: {x,y,z}}} camera Camera-like object (mutado).
 * @param {{x,y,z}} previousPosition Previous tracked-frame camera position.
 * @param {number} [minimumRangeM=MIN_TRACKED_RANGE_M] Minimum target range.
 * @returns {boolean} Whether the camera position was corrected.
 */
export function clampTrackedCameraPosition(
  camera,
  previousPosition,
  minimumRangeM = MIN_TRACKED_RANGE_M,
) {
  const crossedOrigin = v3.dot(camera.position, previousPosition) <= 0;
  const forwardDistance = -v3.dot(camera.position, camera.direction);
  const rangeSquared = v3.mag2(camera.position);
  if (crossedOrigin) {
    const m = Math.sqrt(v3.mag2(previousPosition)) || 1;
    camera.position.x = (previousPosition.x / m) * minimumRangeM;
    camera.position.y = (previousPosition.y / m) * minimumRangeM;
    camera.position.z = (previousPosition.z / m) * minimumRangeM;
    return true;
  }
  if (forwardDistance < minimumRangeM || rangeSquared < minimumRangeM * minimumRangeM) {
    camera.position.x = camera.direction.x * -minimumRangeM + 0;
    camera.position.y = camera.direction.y * -minimumRangeM + 0;
    camera.position.z = camera.direction.z * -minimumRangeM + 0;
    return true;
  }
  return false;
}

/**
 * Converte o `viewFrom` do Cesium (deslocamento ENU da câmera em relação ao
 * alvo: x leste, y norte, z cima) em {rangeM, heading, pitch} (graus, semântica
 * Cesium). Exportada para teste.
 * @param {{x:number,y:number,z:number}|{rangeM:number,heading?:number,pitch?:number}} viewFrom
 */
export function viewFromToOrbit(viewFrom) {
  if (!viewFrom) return null;
  if (Number.isFinite(viewFrom.rangeM)) {
    return { rangeM: Math.max(MIN_TRACKED_RANGE_M, viewFrom.rangeM), heading: viewFrom.heading ?? 0, pitch: viewFrom.pitch ?? -45 };
  }
  const { x = 0, y = 0, z = 0 } = viewFrom;
  const range = Math.hypot(x, y, z);
  if (!(range > 1e-6)) return null;
  const horizontal = Math.hypot(x, y);
  // A câmera está em (x, y, z) do alvo e olha para ele: heading = rumo do alvo
  // visto da câmera; pitch negativo quando a câmera está acima.
  const heading = horizontal > 1e-6 ? ((Math.atan2(-x, -y) * 180) / Math.PI + 360) % 360 : 0;
  const pitch = -(Math.atan2(z, horizontal) * 180) / Math.PI;
  return { rangeM: Math.max(MIN_TRACKED_RANGE_M, range), heading, pitch: Math.max(-90, Math.min(-5, pitch)) };
}

/**
 * Enquadra o alvo recém-rastreado uma vez e entrega o acompanhamento contínuo
 * ao engine (`engine.track`).
 *
 * @param {object} engine `engine` do app.
 * @param {object} target Alvo com getPosition() -> {lon, lat, alt}.
 * @param {{x,y,z}|{rangeM,heading?,pitch?}} viewFrom Deslocamento desejado da câmera.
 * @param {{duration?: number}} [options] Duração do voo (s); 0 = salto.
 * @returns {(() => void)|undefined} Disposer (cancela o enquadramento pendente).
 */
export function applyTrackedCameraFrame(engine, target, viewFrom, { duration = 1.2 } = {}) {
  if (!engine || !target || !viewFrom) return undefined;
  const orbit = viewFromToOrbit(viewFrom);
  if (!orbit) return undefined;
  let stopped = false;
  const pos = trackedDisplayPositionForCamera(target);
  if (engine.trackedTarget !== target) engine.track?.(target);
  if (pos && Number.isFinite(pos.lon) && Number.isFinite(pos.lat)) {
    const view = engine.cameraLookingAt?.(
      { lon: pos.lon, lat: pos.lat, height: Number.isFinite(pos.alt) ? pos.alt : 0 },
      orbit,
    );
    if (view) {
      if (duration > 0) engine.flyToCamera(view, { duration });
      else engine.setCameraView(view);
    }
  }
  return () => {
    if (stopped) return;
    stopped = true;
    if (duration > 0 && engine.trackedTarget !== target) engine.cancelFlight?.();
  };
}
