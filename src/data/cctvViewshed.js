/**
 * @module cctvViewshed
 *
 * Viewshed presentation for the CCTV layer (MapLibre).
 *
 * Responsibilities, all pure of layer state:
 *  - Color identity: a stable per-camera hue (golden-angle spaced over the
 *    id-sorted catalog index) and the derived fill/line colors, now CSS
 *    `rgba()` strings for MapLibre paint properties (were Cesium.Color).
 *  - Ground footprint (NEW in the MapLibre port): the camera's view cone as a
 *    polygon ON THE GROUND — an annular sector between the nearest and the
 *    farthest ground point the frustum sees, spanning the horizontal FOV. The
 *    Cesium build drew a translucent 3D pyramid (5 vertices) plus a monitor
 *    plane at its far cap; a 2D map has no volume to draw, so the cone
 *    degrades to where it meets the ground.
 *  - Volume geometry data (`frustumVolumeGeometryData`): kept as a pure
 *    helper over any `{x, y, z}` points (it used to feed the Cesium
 *    primitive); nothing draws it in MapLibre.
 */

/** Golden angle in degrees — maximally spreads consecutive indices around the hue wheel. */
const GOLDEN_ANGLE_DEG = 137.50776405003785;

const FILL_ALPHA_IDLE = 0.12;
const FILL_ALPHA_ACTIVE = 0.22;
const LINE_ALPHA_IDLE = 0.85;
const LINE_ALPHA_ACTIVE = 1.0;

/** Earth radius used by the spherical offsets (same as cctv.js projectPoint). */
const EARTH_R = 6371000;
/** 16:9 monitor aspect (same as cctv.js PROJECTION_VERT_ASPECT). */
const ASPECT = 16 / 9;
const DEG = Math.PI / 180;

/**
 * Stable hue (degrees, [0, 360)) for a camera's position in the id-sorted
 * catalog.
 * @param {number} index - Camera index in the id-sorted catalog.
 * @returns {number} Hue in degrees.
 */
export function cameraHue(index) {
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return (i * GOLDEN_ANGLE_DEG) % 360;
}

/** HSL (0-1) -> [r, g, b] 0-255. */
export function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)].map((v) => Math.round(v * 255));
}

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

/**
 * Derived viewshed colors for a hue: translucent footprint fills (idle/active)
 * and outline tints (idle/active), all in the same hue family, as CSS strings.
 * @param {number} hueDeg - Hue in degrees.
 * @returns {{fill: string, fillActive: string, line: string, lineActive: string, hue: number}}
 */
export function viewshedColors(hueDeg) {
  const hueNorm = (((Number(hueDeg) || 0) % 360) + 360) % 360;
  const h = hueNorm / 360;
  return {
    hue: hueNorm,
    fill: rgba(hslToRgb(h, 0.85, 0.6), FILL_ALPHA_IDLE),
    fillActive: rgba(hslToRgb(h, 0.85, 0.6), FILL_ALPHA_ACTIVE),
    line: rgba(hslToRgb(h, 0.9, 0.65), LINE_ALPHA_IDLE),
    lineActive: rgba(hslToRgb(h, 0.9, 0.7), LINE_ALPHA_ACTIVE),
  };
}

/**
 * Flattens 5 frustum points into the raw vertex/index buffers of the frustum
 * volume: vertex order [mount, tl, tr, br, bl]; 4 side faces from the apex +
 * the far cap split into 2 triangles. Pure; any `{x, y, z}` objects work.
 * @param {{mount: {x,y,z}, tl: {x,y,z}, tr: {x,y,z}, br: {x,y,z}, bl: {x,y,z}}} positions
 * @returns {{positions: Float64Array, indices: Uint16Array}}
 */
export function frustumVolumeGeometryData(positions) {
  const pts = [positions.mount, positions.tl, positions.tr, positions.br, positions.bl];
  const flat = new Float64Array(15);
  pts.forEach((p, i) => {
    flat[i * 3] = p.x;
    flat[i * 3 + 1] = p.y;
    flat[i * 3 + 2] = p.z;
  });
  const indices = new Uint16Array([
    0, 1, 2,
    0, 2, 3,
    0, 3, 4,
    0, 4, 1,
    1, 2, 3,
    1, 3, 4,
  ]);
  return { positions: flat, indices };
}

/** Spherical destination point (degrees). */
export function offsetLatLon(lat, lon, bearingDeg, distM) {
  const d = distM / EARTH_R;
  const b = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: ((l2 / DEG + 540) % 360) - 180 };
}

/**
 * Where the camera's frustum meets flat ground around the mount: nearest and
 * farthest visible ground distance (horizontal metres) and the horizontal
 * half-angle. The bottom ray (pitch − vFov/2) gives the near edge, the top ray
 * (pitch + vFov/2) the far edge; a ray at/above the horizon reaches the
 * camera's range. Both are capped at the (possibly probe-clamped) range.
 *
 * @param {{pitchDeg:number, fovDeg:number, rangeM:number, mountHeightM:number}} camera
 * @param {number|null} [rangeOverrideM=null] - Caps the range (never lengthens it).
 * @returns {{nearM:number, farM:number, halfAngleDeg:number, rangeM:number, vFovDeg:number}}
 */
export function groundFootprintExtent(camera, rangeOverrideM = null) {
  const poseRange = Math.max(1, Number(camera?.rangeM) || 700);
  const override = Number(rangeOverrideM);
  const range = Number.isFinite(override) && override > 0 ? Math.min(poseRange, override) : poseRange;
  const h = Math.max(0.5, Number(camera?.mountHeightM) || 24);
  const pitch = Math.max(-89, Math.min(89, Number.isFinite(Number(camera?.pitchDeg)) ? Number(camera.pitchDeg) : -17));
  const hFov = Math.max(8, Math.min(160, Number(camera?.fovDeg) || 74));
  const vFovDeg = (2 * Math.atan(Math.tan((hFov * DEG) / 2) / ASPECT)) / DEG;
  const reach = (elevationDeg) => (elevationDeg < -0.5
    ? Math.min(range, h / Math.tan(-elevationDeg * DEG))
    : range);
  const farM = reach(pitch + vFovDeg / 2);
  let nearM = pitch - vFovDeg / 2 < -0.5 ? reach(pitch - vFovDeg / 2) : 0;
  if (nearM >= farM) nearM = farM * 0.5;
  return { nearM, farM, halfAngleDeg: Math.min(85, hFov / 2), rangeM: range, vFovDeg };
}

/**
 * Ground footprint of a camera as a closed GeoJSON ring ([lon, lat] pairs):
 * an annular sector from `nearM` to `farM` spanning heading ± halfAngle.
 * Also returns the axis end (far edge center) for the outline's center ray.
 *
 * @param {{lat:number, lon:number, headingDeg:number, pitchDeg:number,
 *   fovDeg:number, rangeM:number, mountHeightM:number}} camera
 * @param {{rangeOverrideM?: number|null, segments?: number}} [options]
 * @returns {{ring: number[][], axisEnd: {lat:number, lon:number}, nearM:number, farM:number}|null}
 */
export function groundFootprint(camera, { rangeOverrideM = null, segments = 12 } = {}) {
  const lat = Number(camera?.lat);
  const lon = Number(camera?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const heading = Number(camera?.headingDeg) || 0;
  const { nearM, farM, halfAngleDeg } = groundFootprintExtent(camera, rangeOverrideM);
  const n = Math.max(2, Math.floor(segments));
  const ring = [];
  const arc = (dist, from, to) => {
    for (let i = 0; i <= n; i++) {
      const b = from + ((to - from) * i) / n;
      const p = offsetLatLon(lat, lon, b, dist);
      ring.push([p.lon, p.lat]);
    }
  };
  if (nearM < 1) ring.push([lon, lat]);
  else arc(nearM, heading - halfAngleDeg, heading + halfAngleDeg);
  arc(farM, heading + halfAngleDeg, heading - halfAngleDeg);
  ring.push([...ring[0]]);
  return { ring, axisEnd: offsetLatLon(lat, lon, heading, farM), nearM, farM };
}
