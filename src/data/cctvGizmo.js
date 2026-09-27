/**
 * @module cctvGizmo
 *
 * Calibration gizmo for the CCTV layer (ADJUST mode) — MapLibre version.
 *
 * DEGRADAÇÃO 3D → 2D (migração Cesium → MapLibre):
 *  O gizmo Cesium tinha 7 alças 3D sobre a câmera ativa (anel de rumo, anel de
 *  inclinação, setas Leste/Norte/Cima, alça de alcance no centro do plano do
 *  monitor, alças de FOV nas bordas do plano), arrastadas por raio do mouse
 *  contra planos/eixos no espaço ECEF. Num mapa 2D não há volume para agarrar,
 *  então o gizmo vira DOIS marcadores arrastáveis no chão:
 *   - base (quadrado): move a câmera → offsetNorthM / offsetEastM;
 *   - mira (seta, no fim do eixo do polígono no chão): gira → headingDeg
 *     (rumo base→mira).
 *  Alcance, inclinação, FOV e altura do mastro continuam editáveis pelos campos
 *  numéricos do painel CCTV (ui.js, CCTV_CAL_FIELDS) e por voz — o mesmo
 *  `setParams({calibration: {patch}})` de sempre.
 *
 * O contrato com a camada não muda: o gizmo só a enxerga por
 * `getActiveRecord()`, `applyPatch(patch, record)` (arrasto em curso,
 * transitório) e `endPatch(record)` (soltou). Os patches são offsets ABSOLUTOS
 * de calibração, como antes.
 *
 * A matemática pura de arrasto 3D (raio×eixo, raio×plano, ângulo em anel)
 * continua exportada sobre vetores simples `{x, y, z}` — é geometria genérica
 * e tem testes; o gizmo 2D usa os auxiliares geográficos abaixo dela.
 */

// Grazing guard: reject plane intersections when the view ray is nearly
// parallel to the constraint plane.
const GRAZING_DOT_MIN = 0.08;
// Near-parallel guard for ray/axis closest-point (denominator 1 - (d·a)²).
const PARALLEL_EPS = 1e-6;

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/**
 * Parameter t (metres) along an axis line of the point on that axis closest
 * to a mouse ray. Both directions must be normalized.
 * @param {{x,y,z}} rayOrigin
 * @param {{x,y,z}} rayDir - Unit.
 * @param {{x,y,z}} axisOrigin
 * @param {{x,y,z}} axisDir - Unit.
 * @returns {number|null} t along the axis, or null when ray ∥ axis.
 */
export function closestParamOnAxis(rayOrigin, rayDir, axisOrigin, axisDir) {
  const b = dot(rayDir, axisDir);
  const denom = 1 - b * b;
  if (Math.abs(denom) < PARALLEL_EPS) return null;
  const w = sub(rayOrigin, axisOrigin);
  const d = dot(rayDir, w);
  const e = dot(axisDir, w);
  return (e - b * d) / denom;
}

/**
 * Ray/plane intersection with the grazing-angle guard.
 * @param {{x,y,z}} rayOrigin
 * @param {{x,y,z}} rayDir - Unit.
 * @param {{x,y,z}} planeOrigin
 * @param {{x,y,z}} planeNormal - Unit.
 * @returns {{x,y,z}|null} Hit point (new object), or null.
 */
export function rayPlaneIntersect(rayOrigin, rayDir, planeOrigin, planeNormal) {
  const denom = dot(rayDir, planeNormal);
  if (Math.abs(denom) < GRAZING_DOT_MIN) return null;
  const s = dot(sub(planeOrigin, rayOrigin), planeNormal) / denom;
  if (s < 0) return null;
  return { x: rayOrigin.x + rayDir.x * s, y: rayOrigin.y + rayDir.y * s, z: rayOrigin.z + rayDir.z * s };
}

/**
 * Angle (radians, atan2 convention) of a point around a ring center in the
 * plane spanned by two orthonormal basis vectors.
 * @returns {number} Angle in (−π, π].
 */
export function ringAngle(hitPoint, center, basisA, basisB) {
  const v = sub(hitPoint, center);
  return Math.atan2(dot(v, basisB), dot(v, basisA));
}

/**
 * Shortest signed angular delta from → to, wrap-safe.
 * @returns {number} Delta in (−π, π].
 */
export function signedAngleDelta(fromRad, toRad) {
  const twoPi = 2 * Math.PI;
  let delta = (toRad - fromRad) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta <= -Math.PI) delta += twoPi;
  return delta;
}

// ---------------------------------------------------------------------------
// Geographic helpers for the 2D gizmo (pure)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

/** Initial bearing (degrees, 0 = north, clockwise) from a to b. */
export function bearingDeg(aLat, aLon, bLat, bLon) {
  const p1 = aLat * DEG;
  const p2 = bLat * DEG;
  const dl = (bLon - aLon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Local horizontal distance (m), equirectangular — fine at gizmo scales. */
export function localDistanceM(aLat, aLon, bLat, bLon) {
  const n = (bLat - aLat) * M_PER_DEG_LAT;
  const e = (bLon - aLon) * M_PER_DEG_LAT * Math.max(0.15, Math.cos(aLat * DEG));
  return Math.hypot(n, e);
}

/**
 * Calibration offsets that put the camera mount at (lat, lon): the exact
 * inverse of cctv.js `offsetDegrees` (111 320 m/deg, lon divisor floored at
 * cos = 0.15).
 * @param {{lat:number, lon:number}} basePose
 * @returns {{offsetNorthM:number, offsetEastM:number}}
 */
export function mountOffsetsForPosition(basePose, lat, lon) {
  const lonDivisor = Math.max(0.15, Math.cos(basePose.lat * DEG));
  return {
    offsetNorthM: (lat - basePose.lat) * M_PER_DEG_LAT,
    offsetEastM: (lon - basePose.lon) * M_PER_DEG_LAT * lonDivisor,
  };
}

/** Horizontal reach (m) of a pose's range along its pitched axis. */
export function aimDistanceM(rangeM, pitchDeg) {
  return Math.max(1, Number(rangeM) || 1) * Math.max(0.05, Math.cos((Number(pitchDeg) || 0) * DEG));
}

/**
 * Patch for dragging the aim handle to (aimLat, aimLon): heading follows the
 * mount→aim bearing, range scales with the mount→aim distance.
 * @param {{basePose:{headingDeg:number, rangeM:number}, camera:{lat:number, lon:number, pitchDeg:number}}} input
 * @returns {{headingDeg:number, rangeScale:number}}
 */
export function aimPatchFor({ basePose, camera, aimLat, aimLon, withRange = true }) {
  const heading = bearingDeg(camera.lat, camera.lon, aimLat, aimLon);
  let delta = heading - basePose.headingDeg;
  delta = ((delta + 540) % 360) - 180;
  if (!withRange) return { headingDeg: delta };
  const dist = localDistanceM(camera.lat, camera.lon, aimLat, aimLon);
  const baseReach = aimDistanceM(basePose.rangeM, camera.pitchDeg);
  return { headingDeg: delta, rangeScale: Math.max(0.01, dist / baseReach) };
}

// ---------------------------------------------------------------------------
// Gizmo controller (MapLibre markers)
// ---------------------------------------------------------------------------

/** Id prefix kept for compatibility (pick-owner checks elsewhere key off it). */
export const GIZMO_ID_PREFIX = 'cctv-gizmo-';

const DRAG_THROTTLE_MS = 16;

function handleElement(kind) {
  const node = document.createElement('div');
  node.className = `dg-cctv-gizmo dg-cctv-gizmo-${kind}`;
  node.title = kind === 'mount' ? 'Arraste para mover a câmera' : 'Arraste para girar (rumo)';
  node.style.zIndex = '5';
  Object.assign(node.style, kind === 'mount'
    ? { width: '14px', height: '14px', background: '#ffd97a', border: '2px solid #1a1206', borderRadius: '2px', cursor: 'move', boxShadow: '0 0 6px #ffd97a' }
    : { width: '0', height: '0', borderLeft: '9px solid transparent', borderRight: '9px solid transparent', borderBottom: '18px solid #35d8ff', cursor: 'grab', filter: 'drop-shadow(0 0 4px #35d8ff)' });
  return node;
}

/**
 * @param {Object} options
 * @param {Object} options.engine - Motor MapLibre (src/maplibre/engine.js). `viewer` é aceito como sinônimo.
 * @param {() => Object|null} options.getActiveRecord
 * @param {(patch: Object, record: Object) => void} options.applyPatch - transitório (arrasto)
 * @param {(record: Object) => void} options.endPatch - commit (soltou)
 */
export function createCalibrationGizmo({ engine, viewer, getActiveRecord, applyPatch, endPatch }) {
  const eng = engine || viewer;
  const maplibregl = eng?.maplibregl;
  const map = eng?.map;
  let enabled = false;
  let mount = null;
  let aim = null;
  let drag = null;
  let lastDragAt = 0;

  function ensureMarkers() {
    if (mount || !maplibregl || !map) return;
    mount = new maplibregl.Marker({ element: handleElement('mount'), draggable: true });
    aim = new maplibregl.Marker({ element: handleElement('aim'), draggable: true, rotationAlignment: 'map' });
    mount.on('dragstart', () => beginDrag('mount'));
    aim.on('dragstart', () => beginDrag('aim'));
    mount.on('drag', () => onDrag());
    aim.on('drag', () => onDrag());
    mount.on('dragend', () => finishDrag());
    aim.on('dragend', () => finishDrag());
  }

  function placeFor(record, { skipMount = false } = {}) {
    const cam = record?.camera;
    if (!cam || !mount) return;
    if (!skipMount) mount.setLngLat([cam.lon, cam.lat]);
    // A mira fica no fim do eixo do polígono no chão (o que se vê no mapa);
    // sem ele, no alcance horizontal da pose.
    const reach = Number.isFinite(record.footprint?.farM) && record.footprint.farM > 1
      ? record.footprint.farM
      : aimDistanceM(cam.rangeM, cam.pitchDeg);
    const lonScale = M_PER_DEG_LAT * Math.max(0.15, Math.cos(cam.lat * DEG));
    const h = cam.headingDeg * DEG;
    aim.setLngLat([cam.lon + (Math.sin(h) * reach) / lonScale, cam.lat + (Math.cos(h) * reach) / M_PER_DEG_LAT]);
    aim.setRotation(cam.headingDeg);
  }

  function hideAll() {
    mount?.remove();
    aim?.remove();
  }

  function refresh() {
    if (!enabled) {
      hideAll();
      return;
    }
    const record = getActiveRecord();
    if (!record) {
      hideAll();
      return;
    }
    ensureMarkers();
    if (!mount) return;
    if (!drag) placeFor(record);
    mount.addTo(map);
    aim.addTo(map);
  }

  function beginDrag(part) {
    const record = getActiveRecord();
    if (!enabled || !record?.camera?.basePose) {
      drag = null;
      return;
    }
    drag = { part, record };
  }

  function onDrag() {
    if (!drag) return;
    const now = Date.now();
    if (now - lastDragAt < DRAG_THROTTLE_MS) return;
    lastDragAt = now;
    if (getActiveRecord() !== drag.record) {
      finishDrag();
      return;
    }
    const cam = drag.record.camera;
    let patch;
    if (drag.part === 'mount') {
      const ll = mount.getLngLat();
      patch = mountOffsetsForPosition(cam.basePose, ll.lat, ll.lng);
    } else {
      const ll = aim.getLngLat();
      patch = aimPatchFor({ basePose: cam.basePose, camera: cam, aimLat: ll.lat, aimLon: ll.lng, withRange: false });
      aim.setRotation(bearingDeg(cam.lat, cam.lon, ll.lat, ll.lng));
    }
    applyPatch(patch, drag.record);
    // A mira acompanha a base.
    if (drag.part === 'mount') placeFor(drag.record, { skipMount: true });
  }

  function finishDrag() {
    if (!drag) return;
    const { record } = drag;
    drag = null;
    endPatch(record);
    refresh();
  }

  return {
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) {
        if (drag) finishDrag();
        hideAll();
      } else {
        refresh();
      }
    },
    refresh,
    destroy() {
      if (drag) finishDrag();
      hideAll();
      mount = null;
      aim = null;
    },
    isDragging: () => !!drag,
    isEnabled: () => enabled,
  };
}
