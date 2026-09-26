/**
 * Shared icon-orientation + horizon helpers. Orientation and culling serve the
 * moving-entity layers (commercial flights, military flights, AIS vessels);
 * `skyBackdropFactor` serves the detection overlay, which needs the same
 * silhouette geometry to know what a label is being read against.
 *
 * THE ORIENTATION PROBLEM (2026-06-10 playtest): billboards are camera-facing
 * quads, so "point along the real-world course" must be computed in SCREEN
 * space. The previous approach mixed two regimes (surface-normal alignedAxis
 * at oblique pitch, camera-heading compensation at nadir) and broke in
 * tracked-entity orbit mode, where camera.heading is expressed in the
 * entity's reference frame — the tracked icon stayed glued to the viewport.
 *
 * THE FIX: transform the local course vector into world space, then project it
 * directly onto the camera's right/up basis. This stays valid when a forward
 * probe point would be off-screen or behind the camera during a >180° tracked
 * orbit. The camera-basis projection is exact at the viewport center and an
 * intentional orthographic approximation elsewhere: an off-center contact at
 * oblique pitch can diverge from a pinhole/window-space projection because the
 * latter also includes the course vector's depth component. The approximation
 * keeps rotation continuous through tracked orbits; field evidence, not an
 * unverified math swap, decides whether exact projection becomes preferred.
 */
//
// MIGRAÇÃO MAPLIBRE (2026-09): sem Cesium. Tipos neutros:
//  - posições: {lon, lat, alt} (ou ECEF {x, y, z} / [lon, lat, alt], por
//    compatibilidade);
//  - "scene"/"camera": o `engine` do app (src/maplibre/engine.js). O caminho
//    antigo por base da câmera ({camera: {rightWC, upWC}} com vetores {x,y,z})
//    continua aceito — é matemática pura e segue coberto pelos testes.
// No MapLibre um ícone com `icon-rotation-alignment: 'map'` já gira com o
// mapa; `screenProjectedRotation` serve a quem desenha em espaço de TELA
// (overlays HTML, canvas) e devolve o ângulo na mesma convenção de antes
// (radianos, anti-horário positivo, 0 = topo da tela).
import { destinationPointDeg, ecefFromGeo, toEcef, toGeo, WGS84_A, WGS84_B } from './motionModel.js';

/** Meters used to give the course vector a stable projection magnitude. */
const FORWARD_PROBE_M = 2000;
/**
 * Minimum camera-plane component before we trust the angle — below this the
 * course points almost exactly into/out of the screen and the angle is noise.
 */
const MIN_SCREEN_COMPONENT_M = 0.5;
/** Minimum projected probe length (px) in the engine path. */
const MIN_SCREEN_COMPONENT_PX = 0.5;
/** Ignore sub-degree projection noise while retaining deliberate camera-orbit rotation. */
const ROTATION_DEADBAND_RAD = 0.5 * Math.PI / 180;
const DEG = Math.PI / 180;

/** Vetor de curso (ENU -> ECEF) num ponto; `out` recebe {x,y,z}. */
function worldCourseVector(position, courseDeg, out) {
  const g = toGeo(position);
  if (!g) return null;
  const c = (courseDeg || 0) * DEG;
  const e = Math.sin(c) * FORWARD_PROBE_M;
  const n = Math.cos(c) * FORWARD_PROBE_M;
  const phi = g.lat * DEG;
  const lam = g.lon * DEG;
  out.x = -Math.sin(lam) * e - Math.sin(phi) * Math.cos(lam) * n;
  out.y = Math.cos(lam) * e - Math.sin(phi) * Math.sin(lam) * n;
  out.z = Math.cos(phi) * n;
  return out;
}
const _worldForward = { x: 0, y: 0, z: 0 };
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Computes the icon rotation (radians, CCW-positive, 0 = screen up) that
 * points an icon along its real-world course.
 *
 * @param {object} sceneOrEngine - `engine` do app (projeção pela câmera do
 *   MapLibre), ou legado `{camera: {rightWC, upWC}}` (base da câmera).
 * @param {{lon:number,lat:number,alt?:number}|{x,y,z}} position - Posição do objeto.
 * @param {number} courseDeg - Course/track in degrees clockwise from north.
 * @param {number|null} previous - Rotation to keep when projection is unavailable.
 * @returns {number|null} Rotation in radians, or `previous` when unknown.
 */
export function screenProjectedRotation(sceneOrEngine, position, courseDeg, previous = null) {
  if (!sceneOrEngine || !position) return previous;
  const camera = sceneOrEngine.camera;
  if (camera?.rightWC && camera?.upWC) {
    if (!worldCourseVector(position, courseDeg, _worldForward)) return previous;
    // Screen x follows camera-right; window y grows downward (−camera-up).
    const dx = dot(_worldForward, camera.rightWC);
    const dy = -dot(_worldForward, camera.upWC);
    if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_M * MIN_SCREEN_COMPONENT_M) return previous;
    return Math.atan2(-dx, -dy);
  }
  if (typeof sceneOrEngine.project === 'function') {
    const g = toGeo(position);
    if (!g) return previous;
    const a = sceneOrEngine.project(g.lon, g.lat, g.alt);
    const tip = destinationPointDeg(g.lon, g.lat, courseDeg || 0, FORWARD_PROBE_M);
    const b = sceneOrEngine.project(tip.lon, tip.lat, g.alt);
    if (!a || !b) return previous;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!(Number.isFinite(dx) && Number.isFinite(dy))) return previous;
    if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_PX * MIN_SCREEN_COMPONENT_PX) {
      // Probe degenerou (zoom muito baixo): usa o rumo em relação ao bearing do mapa.
      const bearing = sceneOrEngine.getCameraView?.().heading;
      return Number.isFinite(bearing) ? -((courseDeg || 0) - bearing) * DEG : previous;
    }
    return Math.atan2(-dx, -dy);
  }
  return previous;
}

/**
 * Hold a billboard rotation when the newly projected angle differs only by
 * sub-degree render noise. The comparison uses the shortest wrapped arc so
 * values around ±π do not jump.
 *
 * @param {number|null} previous Last displayed rotation.
 * @param {number|null} next Newly projected rotation.
 * @param {number} [deadbandRad=ROTATION_DEADBAND_RAD] Angular hold threshold.
 * @returns {number|null} Stable rotation.
 */
export function stabilizeScreenRotation(
  previous,
  next,
  deadbandRad = ROTATION_DEADBAND_RAD,
) {
  if (!Number.isFinite(next)) return Number.isFinite(previous) ? previous : null;
  if (!Number.isFinite(previous)) return next;
  const delta = Math.atan2(Math.sin(next - previous), Math.cos(next - previous));
  return Math.abs(delta) < Math.max(0, deadbandRad) ? previous : next;
}


/**
 * Half-width of the crossfade band centred on the ellipsoid silhouette, in
 * radians. ~1.1° per side: at the product's default 60° frustum on a 1280×800
 * viewport that is roughly 30 px of screen crossfade — wide enough that a
 * contact drifting across the horizon never pops, narrow enough that a label
 * plainly over ground still gets its full treatment.
 */
export const HORIZON_FEATHER_RAD = 0.019;
const _skyCam = { x: 0, y: 0, z: 0 };
const _skyPos = { x: 0, y: 0, z: 0 };

const _wgs84OneOverRadii = Object.freeze({ x: 1 / WGS84_A, y: 1 / WGS84_A, z: 1 / WGS84_B });

/**
 * How much SKY sits behind a world point from this camera: 0 (planet behind)
 * … 1 (sky behind), smoothly blended across a band centred on the horizon.
 *
 * THERE ARE TWO REGIMES AND THEY ANSWER DIFFERENT QUESTIONS. Read this before
 * trusting the number for anything other than a plate alpha.
 *
 * ABOVE the ellipsoid the horizon is the tangent silhouette and the test is a
 * genuine ray/ellipsoid hit test: 1 means the view ray through the point misses
 * the planet entirely. Here the function is the exact complement of
 * {@link horizonOccluder} — the occluder asks whether the planet is in FRONT of
 * a point (cull it), this asks whether it is BEHIND (what a screen-space label
 * anchored there is read against). For any point the occluder keeps, a ray that
 * hits the ellipsoid must hit it beyond the point, so the hit/miss test alone
 * settles the backdrop.
 *
 * AT OR BELOW the ellipsoid there is no tangent cone, and the test is NOT a ray
 * hit test. It is an EYE-PLANE convention: 1 means the point sits above the
 * camera's local geodetic horizontal. The two genuinely differ — from a camera
 * 18 m under the surface, the ray to a contact 900 m up and a few km out
 * CROSSES the ellipsoid on the way there, and the answer is still sky. That is
 * deliberate. A sub-ellipsoid camera is an artifact of the geoid/ellipsoid
 * split, not of being underground: the geoid runs ~34 m below the ellipsoid at
 * JFK, so a cockpit parked on the ramp there sits at −18 m of ellipsoid height
 * with the whole rendered world still above it. The ellipsoid that ray crosses
 * is not a surface anyone can see, so intersecting it would answer a question
 * nobody asked; what a label is read against is decided instead by whether it
 * sits above or below the viewer's eye level. Cesium's `EllipsoidalOccluder`
 * takes the same convention below the surface, so the two stay sign-consistent
 * — the complementarity above survives as agreement here.
 *
 * The regimes MEET rather than being switched between: the horizon dip
 * acos(R/(R+h)) falls to zero as the camera settles onto the surface, so the
 * tangent cone opens continuously to the horizontal plane, and clamping the
 * cone's sine at 1 (half-angle 90°) IS that limit — not a special case.
 *
 * Computed in scaled space, where WGS84 becomes a unit sphere. That map is
 * affine, so both regimes stay exact: above the surface ray-surface
 * intersection is preserved and the zero crossing is the true silhouette rather
 * than a spherical stand-in; below it the eye plane is the true GEODETIC
 * tangent plane, because the scaled radial maps back to (x/a², y/a², z/b²), the
 * real surface normal, which at 40°N sits 0.19° off the geocentric radial. Only
 * the magnitude of the margin picks up the flattening, and a feather band does
 * not care about a third of a percent.
 *
 * Deliberately geometric, not photometric, in BOTH regimes: sampling rendered
 * pixels behind every label would be correct about mountains and towers that
 * rise above the horizon, and would also cost a readback per label per frame.
 * The band absorbs that approximation — a contact just above the horizon lands
 * mid-blend, which is the honest answer when the backdrop is part sky.
 *
 * @param {{x,y,z}|{lon,lat,alt}} cameraPosition Posição da câmera (ECEF ou geográfica).
 * @param {{x,y,z}|{lon,lat,alt}} position Posição do ponto rotulado.
 * @param {number} [featherRad=HORIZON_FEATHER_RAD] Half-width of the blend band.
 * @returns {number} 0 (ground behind) … 1 (sky behind).
 */
export function skyBackdropFactor(cameraPositionIn, positionIn, featherRad = HORIZON_FEATHER_RAD) {
  if (!cameraPositionIn || !positionIn) return 0;
  const cameraPosition = toEcef(cameraPositionIn, _skyCam);
  const position = toEcef(positionIn, _skyPos);
  if (!cameraPosition || !position) return 0;

  const s = _wgs84OneOverRadii;
  const cx = cameraPosition.x * s.x;
  const cy = cameraPosition.y * s.y;
  const cz = cameraPosition.z * s.z;
  const cameraMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  // Only the planet's exact centre (or a non-finite camera) has no local
  // vertical to measure against. Everything else — including the sub-ellipsoid
  // cameras that coastal ground level actually produces — gets a real answer.
  // `> 0` already rejects NaN and negatives; the finite check also rejects an
  // infinite coordinate, which would otherwise normalize to NaN below and slip
  // a NaN plate alpha into the paint.
  if (!(cameraMag > 0) || !Number.isFinite(cameraMag)) return 0;

  let dx = position.x * s.x - cx;
  let dy = position.y * s.y - cy;
  let dz = position.z * s.z - cz;
  const rayMag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // Same two rejections on the ray: a zero-length one has no direction, and an
  // infinite one normalizes to NaN.
  if (!(rayMag > 0) || !Number.isFinite(rayMag)) return 0;
  dx /= rayMag;
  dy /= rayMag;
  dz /= rayMag;

  // Angle between the view ray and the direction to the planet's centre,
  // against the half-angle of the tangent cone. Inside the cone the ray strikes
  // the planet; outside it, the ray escapes to sky.
  const cosToCentre = -(cx * dx + cy * dy + cz * dz) / cameraMag;
  const rayAngle = Math.acos(Math.min(1, Math.max(-1, cosToCentre)));
  // The clamp is the eye-level case described above, reached as a limit rather
  // than as a special case: at and under the surface the cone has opened to the
  // full 90° half-angle and the test reads "above or below local horizontal".
  const horizonHalfAngle = Math.asin(Math.min(1, 1 / cameraMag));
  const margin = rayAngle - horizonHalfAngle;

  if (!(featherRad > 0)) return margin > 0 ? 1 : 0;
  const t = Math.min(1, Math.max(0, margin / (2 * featherRad) + 0.5));
  // Smoothstep: C1-continuous, so a contact crossing the horizon fades rather
  // than steps, and the fade has no visible corner at either edge of the band.
  return t * t * (3 - 2 * t);
}

/** Posição da câmera {lon, lat, alt} a partir do engine, de uma vista ou de um Camera legado. */
export function cameraGeoPosition(cameraOrEngine) {
  if (!cameraOrEngine) return null;
  if (typeof cameraOrEngine.getCameraView === 'function') {
    const v = cameraOrEngine.getCameraView();
    return Number.isFinite(v?.lat) && Number.isFinite(v?.lon) ? { lon: v.lon, lat: v.lat, alt: Number.isFinite(v.alt) ? v.alt : 0 } : null;
  }
  if (cameraOrEngine.positionWC) return toGeo(cameraOrEngine.positionWC);
  return toGeo(cameraOrEngine);
}

/**
 * Oclusor de horizonte (esfera de raio médio), no lugar do
 * Cesium.EllipsoidalOccluder. `isPointVisible(pos)` é falso quando o ponto
 * está atrás da curvatura da Terra vista da câmera: ângulo central câmera-ponto
 * maior que a soma dos ângulos de horizonte dos dois. No MapLibre isso só pesa
 * no globo em zoom baixo; em Mercator quase tudo é "visível".
 *
 * @param {object} cameraOrEngine - `engine`, vista {lat, lon, alt} da câmera,
 *   ou legado com `positionWC`.
 * @returns {{cameraPosition: object|null, isPointVisible: (pos: object) => boolean}}
 */
export function horizonOccluder(cameraOrEngine) {
  const cam = cameraGeoPosition(cameraOrEngine);
  _occluderState.cameraPosition = cam;
  if (cam) {
    const R = (WGS84_A * 2 + WGS84_B) / 3;
    _occluderState.camHorizon = Math.acos(Math.min(1, R / (R + Math.max(0, cam.alt))));
    _occluderState.R = R;
  }
  return _occluder;
}
const _occluderState = { cameraPosition: null, camHorizon: 0, R: WGS84_A };
const _occluder = {
  get cameraPosition() {
    return _occluderState.cameraPosition;
  },
  isPointVisible(pos) {
    const cam = _occluderState.cameraPosition;
    if (!cam) return true;
    const g = toGeo(pos);
    if (!g) return false;
    const { R, camHorizon } = _occluderState;
    const p1 = cam.lat * DEG;
    const p2 = g.lat * DEG;
    const cosD = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((g.lon - cam.lon) * DEG);
    const central = Math.acos(Math.max(-1, Math.min(1, cosD)));
    const ptHorizon = Math.acos(Math.min(1, R / (R + Math.max(0, g.alt || 0))));
    return central <= camHorizon + ptHorizon;
  },
};

/**
 * Cheap camera pose signature for "did the camera move" gating of rotation
 * passes (position quantized to ~10 m, angles to ~0.06°).
 * @param {object} cameraOrEngine - `engine` (usa getCameraView), vista
 *   {lat, lon, alt, heading, pitch, roll} (graus) ou Camera legado.
 * @returns {string}
 */
export function cameraPoseSignature(cameraOrEngine) {
  if (!cameraOrEngine) return '';
  if (cameraOrEngine.positionWC) {
    const p = cameraOrEngine.positionWC;
    return `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}:${Math.round(p.z / 10)}:`
      + `${cameraOrEngine.heading.toFixed(3)}:${cameraOrEngine.pitch.toFixed(3)}:${cameraOrEngine.roll.toFixed(3)}`;
  }
  const v = typeof cameraOrEngine.getCameraView === 'function' ? cameraOrEngine.getCameraView() : cameraOrEngine;
  const p = ecefFromGeo(Number(v.lon) || 0, Number(v.lat) || 0, Number.isFinite(v.alt) ? v.alt : 0);
  const r = (deg) => ((Number(deg) || 0) * DEG).toFixed(3);
  return `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}:${Math.round(p.z / 10)}:${r(v.heading)}:${r(v.pitch)}:${r(v.roll)}:${(Number(v.zoom) || 0).toFixed(3)}`;
}
