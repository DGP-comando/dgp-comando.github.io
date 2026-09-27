import { governorRequestRender } from './renderGovernor.js';

/** Outer edge of the existing NVG/FLIR keyhole in normalized shader space. */
export const KEYHOLE_OUTER_RADIUS = 1.05;
/** Clearance required before entering the visible state. */
export const GLOBE_ENTER_CLEARANCE_PX = 24;
/** Clearance below which the overlay leaves the visible state. */
export const GLOBE_EXIT_CLEARANCE_PX = 12;
/** Minimum stable length of a celestial direction projected into the camera plane. */
export const CELESTIAL_PLANE_EPSILON = 0.045;
/** Responsive radial fade band used by every keyhole-aligned text overlay —
 * this is the Detection FADE (label/card fading), NOT the scope-mask feather
 * in scopeMask.js. 0.07 since the 2026-08-24 final value (was 0.16). */
export const KEYHOLE_LABEL_FEATHER_RATIO = 0.07;
export const KEYHOLE_LABEL_FEATHER_MAX_RATIO = 0.4;
/**
 * First-run OUTSIDE opacity for keyhole-aligned world overlays.
 *
 * 0.01 since 2026-08-24 (final value; 0.03 on 08-23, 0.05 before). Keep in lockstep with
 * `#detection-opacity-slider`'s markup value AND readout in index.html,
 * `_detectionOutsideOpacityPct` in sharelink.js,
 * `GLOBAL_POST_DEFAULTS.detectionOutsideOpacityPct` in ui.js, and
 * `AIRCRAFT_BRACKET_FLOOR_ANCHOR` in detectionPolicy.js — a fresh boot applies
 * no restore, so those literals ARE the first-run state. NOT the `ko` PARSE
 * fallback, which stays at 5 on purpose: a link predating that field was
 * authored when 5 was what its author saw. Pinned in reasonableDefaults.test.mjs.
 */
export const KEYHOLE_OUTSIDE_OPACITY_DEFAULT = 0.01;

const RING_INSET_PX = 11;
const MARKER_INSET_PX = 36;
const COLLIDING_MARKER_EXTRA_INSET_PX = 32;
const MARKER_COLLISION_ANGLE = (6 * Math.PI) / 180;
const FULL_GLOBE_RADIUS_RATIO = 0.61;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** WGS84 semi-major axis (Cesium.Ellipsoid.WGS84.maximumRadius). */
export const EARTH_MAX_RADIUS_M = 6_378_137;
// This overlay is a secondary HUD treatment. Keep it smooth while reserving
// the majority of the frame budget for the map renderer.
export const CELESTIAL_MAX_FRAME_RATE = 30;
// There are two independently rotating effect canvases (sun and moon), so
// this is a per-layer budget; their combined allocation remains comparable to
// the former single 4 MP canvas.
export const CELESTIAL_MAX_BACKING_PIXELS = 2_000_000;
export const CELESTIAL_MAX_BACKING_DIMENSION = 1_600;
const CELESTIAL_MAX_DEVICE_PIXEL_RATIO = 1.25;

let keyholeFadeRatio = KEYHOLE_LABEL_FEATHER_RATIO;
let keyholeOutsideOpacity = KEYHOLE_OUTSIDE_OPACITY_DEFAULT;

/** Clamp a number to an inclusive range. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Update the shared fade distance and outside-opacity floor. */
export function setKeyholeFadeTuning({ fadeRatio, outsideOpacity } = {}) {
  if (Number.isFinite(fadeRatio)) {
    keyholeFadeRatio = clamp(fadeRatio, 0, KEYHOLE_LABEL_FEATHER_MAX_RATIO);
  }
  if (Number.isFinite(outsideOpacity)) {
    keyholeOutsideOpacity = clamp(outsideOpacity, 0, 1);
  }
  return getKeyholeFadeTuning();
}

/** Read the current normalized keyhole fade settings. */
export function getKeyholeFadeTuning() {
  return { fadeRatio: keyholeFadeRatio, outsideOpacity: keyholeOutsideOpacity };
}

/** Return the single shared screen-space keyhole circle and label feather. */
export function getKeyholeGeometry(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) {
    return { centerX: 0, centerY: 0, radius: 0, featherPx: 0 };
  }
  const radius = h * 0.5 * KEYHOLE_OUTER_RADIUS;
  return {
    centerX: w * 0.5,
    centerY: h * 0.5,
    radius,
    featherPx: radius * keyholeFadeRatio,
  };
}

/**
 * Compute the radial opacity for a callout's visual center. Text remains fully
 * opaque inside the keyhole and fades linearly to the configured outside-opacity
 * floor through a band derived from the live keyhole radius.
 */
export function keyholeLabelAlpha(labelX, labelY, width, height) {
  return keyholeLabelAlphaFromGeometry(labelX, labelY, getKeyholeGeometry(width, height));
}

/** Compute keyhole opacity from geometry already cached by a hot render loop. */
export function keyholeLabelAlphaFromGeometry(labelX, labelY, geometry) {
  if (!geometry || !(geometry.radius > 0) || !Number.isFinite(labelX) || !Number.isFinite(labelY)) return 0;
  const feather = geometry.featherPx;
  const distance = Math.hypot(labelX - geometry.centerX, labelY - geometry.centerY);
  if (distance <= geometry.radius) return 1;
  if (!(feather > 0) || distance >= geometry.radius + feather) return keyholeOutsideOpacity;
  const progress = clamp((distance - geometry.radius) / feather, 0, 1);
  return 1 - (1 - keyholeOutsideOpacity) * progress;
}

/** Normalize an angle to [0, 2π). */
export function normalizeAngle(angle) {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Return the shortest unsigned distance between two circular angles. */
export function circularAngleDistance(a, b) {
  const delta = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(delta, TAU - delta);
}

/** The optical celestial treatment is intentionally limited to Normal view. */
export function isCelestialRingStyleSupported(styleName) {
  return styleName === 'normal';
}

/**
 * Resolve a screen-space direction angle. Canvas Y grows downward, so camera-up
 * is inverted. When the celestial vector points almost directly into/out of the
 * camera, retain the prior stable bearing and fade the marker.
 *
 * @param {number} rightComponent - Dot(direction, camera.rightWC).
 * @param {number} upComponent - Dot(direction, camera.upWC).
 * @param {number} lastAngle - Previous stable angle in radians.
 * @returns {{angle:number, opacity:number, stable:boolean}}
 */
export function celestialScreenAngle(rightComponent, upComponent, lastAngle = 0) {
  const planeLength = Math.hypot(rightComponent, upComponent);
  if (!Number.isFinite(planeLength) || planeLength < CELESTIAL_PLANE_EPSILON) {
    return {
      angle: normalizeAngle(Number.isFinite(lastAngle) ? lastAngle : 0),
      opacity: clamp(planeLength / CELESTIAL_PLANE_EPSILON, 0, 1),
      stable: false,
    };
  }
  return {
    angle: normalizeAngle(Math.atan2(-upComponent, rightComponent)),
    opacity: clamp((planeLength - CELESTIAL_PLANE_EPSILON) / 0.16, 0.28, 1),
    stable: true,
  };
}

/**
 * Test whether a projected Earth disc is completely inside the shared keyhole.
 * The different enter/exit clearances provide hysteresis while zooming.
 *
 * @param {object} geometry
 * @param {number} geometry.earthCenterX
 * @param {number} geometry.earthCenterY
 * @param {number} geometry.earthRadius
 * @param {number} geometry.keyholeCenterX
 * @param {number} geometry.keyholeCenterY
 * @param {number} geometry.keyholeRadius
 * @param {boolean} wasVisible
 * @returns {boolean}
 */
export function isFullGlobeInsideKeyhole(geometry, wasVisible = false) {
  const {
    earthCenterX,
    earthCenterY,
    earthRadius,
    keyholeCenterX,
    keyholeCenterY,
    keyholeRadius,
  } = geometry || {};
  const values = [earthCenterX, earthCenterY, earthRadius, keyholeCenterX, keyholeCenterY, keyholeRadius];
  if (!values.every(Number.isFinite) || earthRadius <= 0 || keyholeRadius <= 0) return false;
  const offset = Math.hypot(earthCenterX - keyholeCenterX, earthCenterY - keyholeCenterY);
  const clearance = keyholeRadius - (offset + earthRadius);
  return clearance >= (wasVisible ? GLOBE_EXIT_CLEARANCE_PX : GLOBE_ENTER_CLEARANCE_PX);
}

/** Return the Earth-disc radius in CSS pixels for a perspective camera. */
export function earthDiscScreenRadius(cameraDistance, viewportHeight, fovy) {
  const earthRadiusM = EARTH_MAX_RADIUS_M;
  if (
    !Number.isFinite(cameraDistance)
    || cameraDistance <= earthRadiusM
    || !(viewportHeight > 0)
    || !Number.isFinite(fovy)
    || fovy <= 0
    || fovy >= Math.PI
  ) return null;
  const angularRadius = Math.asin(clamp(earthRadiusM / cameraDistance, 0, 1));
  const radius = (viewportHeight * 0.5) * Math.tan(angularRadius) / Math.tan(fovy * 0.5);
  return Number.isFinite(radius) && radius > 0 ? radius : null;
}

// ── MapLibre globe geometry and ephemeris (pure; replace Cesium camera/Simon1994) ──

/**
 * Screen-space Earth disc of the MapLibre globe projection, from the
 * transform's own numbers. MapLibre draws the globe with radius
 * `worldSize / 2π / cos(centerLat)` px, the camera `cameraToCenterDistance`
 * px (= the focal length in px) from the centre point, tilted by `pitch`
 * about that point. The earth centre therefore sits at camera-space
 * (0, R·sin p, d + R·cos p) — straight below the screen centre, whatever the
 * bearing — and the limb radius uses the same on-axis approximation Cesium's
 * `earthDiscScreenRadius` used.
 * Pure — unit-tested directly.
 * @param {{worldSize:number, centerLat:number, cameraToCenterDistance:number,
 *   pitchDeg?:number, width:number, height:number, offsetX?:number, offsetY?:number}} t
 * @returns {{earthCenterX:number, earthCenterY:number, earthRadius:number}|null}
 */
export function globeDiscFromTransform({
  worldSize,
  centerLat,
  cameraToCenterDistance,
  pitchDeg = 0,
  width,
  height,
  offsetX = 0,
  offsetY = 0,
} = {}) {
  const cosLat = Math.cos(Number(centerLat) * DEG);
  if (!(worldSize > 0) || !(cameraToCenterDistance > 0) || !(width > 0) || !(height > 0) || !(cosLat > 1e-6)) {
    return null;
  }
  const radiusPx = worldSize / TAU / cosLat;
  const pitch = Number(pitchDeg) * DEG || 0;
  const f = cameraToCenterDistance;
  const cy = radiusPx * Math.sin(pitch);
  const cz = f + radiusPx * Math.cos(pitch);
  const distance = Math.hypot(cy, cz);
  if (!(distance > radiusPx) || cz <= 0) return null;
  const angular = Math.asin(clamp(radiusPx / distance, 0, 1));
  const earthRadius = f * Math.tan(angular);
  if (!Number.isFinite(earthRadius) || earthRadius <= 0) return null;
  return {
    earthCenterX: width * 0.5 + offsetX,
    earthCenterY: height * 0.5 + offsetY + (cy / cz) * f,
    earthRadius,
  };
}

/**
 * Inverse of {@link globeDiscFromTransform} at nadir: the MapLibre zoom whose
 * globe disc has `screenRadius` CSS px. Pure.
 * @returns {number|null}
 */
export function zoomForGlobeDiscRadius(screenRadius, cameraToCenterDistance, centerLat, tileSize = 512) {
  const r = Number(screenRadius);
  const f = Number(cameraToCenterDistance);
  const cosLat = Math.cos(Number(centerLat) * DEG);
  if (!(r > 0) || !(f > 0) || !(cosLat > 1e-6)) return null;
  // r = f·R / sqrt(f² + 2fR)  ⇒  R = (r² + r·sqrt(r² + f²)) / f
  const radiusPx = (r * r + r * Math.sqrt(r * r + f * f)) / f;
  const worldSize = radiusPx * TAU * cosLat;
  return Math.log2(worldSize / tileSize);
}

/** Julian date for a JS Date (or ms). */
export function julianDate(date = new Date()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  return ms / 86_400_000 + 2_440_587.5;
}

/** Greenwich mean sidereal angle in radians. */
function gmstRadians(jd) {
  const d = jd - 2_451_545.0;
  const deg = 280.46061837 + 360.98564736629 * d;
  return (((deg % 360) + 360) % 360) * DEG;
}

/** Rotate an inertial (equatorial) unit vector into Earth-fixed axes. */
function inertialToFixed(x, y, z, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: x * c + y * s, y: -x * s + y * c, z };
}

function normalize3(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Earth-fixed (ECEF) unit vector toward the Sun. Low-precision solar
 * coordinates (Astronomical Almanac, ~0.01°) — far below one marker width.
 * Pure — unit-tested directly.
 */
export function sunDirectionFixed(date = new Date()) {
  const jd = julianDate(date);
  const n = jd - 2_451_545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const x = Math.cos(lambda);
  const y = Math.cos(eps) * Math.sin(lambda);
  const z = Math.sin(eps) * Math.sin(lambda);
  return normalize3(inertialToFixed(x, y, z, gmstRadians(jd)));
}

/**
 * Earth-fixed unit vector toward the Moon (geocentric). Low-precision lunar
 * series (Astronomical Almanac, ~0.3°); parallax (~1°) is ignored like the
 * Cesium path, which also normalised the geocentric vector.
 * Pure — unit-tested directly.
 */
export function moonDirectionFixed(date = new Date()) {
  const jd = julianDate(date);
  const T = (jd - 2_451_545.0) / 36_525;
  const sd = (a, b) => Math.sin((a + b * T) * DEG);
  const lambda = (218.32 + 481267.881 * T
    + 6.29 * sd(135.0, 477198.87)
    - 1.27 * sd(259.3, -413335.36)
    + 0.66 * sd(235.7, 890534.22)
    + 0.21 * sd(269.9, 954397.74)
    - 0.19 * sd(357.5, 35999.05)
    - 0.11 * sd(186.5, 966404.03)) * DEG;
  const beta = (5.13 * sd(93.3, 483202.03)
    + 0.28 * sd(228.2, 960400.87)
    - 0.28 * sd(318.3, 6003.18)
    - 0.17 * sd(217.6, -407332.2)) * DEG;
  const eps = (23.439 - 0.0130042 * T) * DEG;
  const xe = Math.cos(beta) * Math.cos(lambda);
  const ye = Math.cos(beta) * Math.sin(lambda);
  const ze = Math.sin(beta);
  const x = xe;
  const y = ye * Math.cos(eps) - ze * Math.sin(eps);
  const z = ye * Math.sin(eps) + ze * Math.cos(eps);
  return normalize3(inertialToFixed(x, y, z, gmstRadians(jd)));
}

/**
 * Screen right/up axes of the map camera in Earth-fixed coordinates
 * (Cesium's camera.rightWC / camera.upWC), from the view centre, bearing and
 * MapLibre pitch (0 = nadir). Pure — unit-tested directly.
 */
export function cameraScreenAxesFixed({ lat, lon, bearingDeg = 0, pitchDeg = 0 }) {
  const phi = Number(lat) * DEG;
  const lam = Number(lon) * DEG;
  const h = Number(bearingDeg) * DEG || 0;
  const p = Number(pitchDeg) * DEG || 0;
  const e = { x: -Math.sin(lam), y: Math.cos(lam), z: 0 };
  const n = { x: -Math.sin(phi) * Math.cos(lam), y: -Math.sin(phi) * Math.sin(lam), z: Math.cos(phi) };
  const u = { x: Math.cos(phi) * Math.cos(lam), y: Math.cos(phi) * Math.sin(lam), z: Math.sin(phi) };
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const forwardH = { x: n.x * ch + e.x * sh, y: n.y * ch + e.y * sh, z: n.z * ch + e.z * sh };
  const right = { x: e.x * ch - n.x * sh, y: e.y * ch - n.y * sh, z: e.z * ch - n.z * sh };
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const up = { x: forwardH.x * cp + u.x * sp, y: forwardH.y * cp + u.y * sp, z: forwardH.z * cp + u.z * sp };
  return { right, up };
}

const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The MapLibre transform. MapLibre 6 moved it from `map.transform` to
 * `map._camera.transform`; read either so the geometry survives the upgrade.
 */
export function mapTransform(map) {
  return map?.transform ?? map?._camera?.transform ?? null;
}

/**
 * Camera altitude in metres estimated from the transform (focal distance in
 * px × metres per px at the view centre × cos pitch). Fallback for when the
 * engine cannot report `getCameraView().alt`. Pure given its inputs.
 */
export function cameraAltitudeFromTransform({ worldSize, centerLat, cameraToCenterDistance, pitchDeg = 0 } = {}) {
  const cosLat = Math.cos(Number(centerLat) * DEG);
  if (!(worldSize > 0) || !(cameraToCenterDistance > 0) || !(cosLat > 1e-6)) return NaN;
  const metresPerPx = (TAU * EARTH_MAX_RADIUS_M * cosLat) / worldSize;
  return cameraToCenterDistance * metresPerPx * Math.cos(Number(pitchDeg) * DEG || 0);
}

/** Engine camera altitude, falling back to the transform estimate. */
export function engineCameraAltitude(engine) {
  let alt;
  try {
    alt = engine?.getCameraView?.()?.alt;
  } catch {
    alt = undefined;
  }
  if (Number.isFinite(alt)) return alt;
  const map = engine?.map;
  const t = mapTransform(map);
  if (!t) return NaN;
  return cameraAltitudeFromTransform({
    worldSize: t.worldSize,
    centerLat: map.getCenter?.()?.lat ?? t.center?.lat,
    cameraToCenterDistance: t.cameraToCenterDistance,
    pitchDeg: map.getPitch?.() ?? t.pitch,
  });
}

/** Read the numbers {@link globeDiscFromTransform} needs from a map engine. */
function engineGlobeInputs(engine, width, height) {
  if (!engine?.map || (typeof engine.isGlobe === 'function' && !engine.isGlobe())) return null;
  const map = engine.map;
  const t = mapTransform(map);
  if (!t) return null;
  const center = map.getCenter?.() ?? t.center;
  const offset = t.centerOffset;
  return {
    worldSize: t.worldSize,
    centerLat: center?.lat,
    cameraToCenterDistance: t.cameraToCenterDistance,
    pitchDeg: map.getPitch?.() ?? t.pitch ?? 0,
    width,
    height,
    offsetX: Number.isFinite(offset?.x) ? offset.x : 0,
    offsetY: Number.isFinite(offset?.y) ? offset.y : 0,
  };
}

/**
 * Project the visible Earth disc into viewport coordinates.
 * Shared by full-globe UI treatments that must agree on visual containment.
 * Mercator (flat) view has no disc: returns null.
 *
 * @param {object} engine - src/maplibre/engine.js
 * @param {number} width - Viewport width in CSS pixels.
 * @param {number} height - Viewport height in CSS pixels.
 * @returns {object|null}
 */
export function projectEarthDiscToViewport(engine, width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const inputs = engineGlobeInputs(engine, width, height);
  const disc = inputs ? globeDiscFromTransform(inputs) : null;
  if (!disc) return null;
  const keyhole = getKeyholeGeometry(width, height);
  return {
    ...disc,
    keyholeCenterX: keyhole.centerX,
    keyholeCenterY: keyhole.centerY,
    keyholeRadius: keyhole.radius,
  };
}

/** Draw one tapered orbital arc around a celestial marker. */
function drawTaperedArc(ctx, cx, cy, radius, angle, rgb, strength) {
  const span = 0.82;
  const segments = 18;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = `rgba(${rgb}, ${0.5 * strength})`;
  ctx.shadowBlur = 9;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = angle - span + span * 2 * t0;
    const a1 = angle - span + span * 2 * t1;
    const envelope = Math.sin(Math.PI * ((t0 + t1) * 0.5));
    ctx.strokeStyle = `rgba(${rgb}, ${strength * envelope * envelope})`;
    ctx.lineWidth = 0.7 + envelope * 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw the soft directional rays cast inward from the sun marker. */
function drawSunRays(ctx, cx, cy, radius, innerRadius, angle) {
  const sx = cx + Math.cos(angle) * radius;
  const sy = cy + Math.sin(angle) * radius;
  ctx.save();
  // The reference keeps the globe untouched: all illumination lives in the
  // annulus between the Earth limb and the outer optics ring.
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 3, 0, TAU);
  ctx.arc(cx, cy, innerRadius, 0, TAU, true);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, radius * 0.94);
  glow.addColorStop(0, 'rgba(255, 222, 126, 0.17)');
  glow.addColorStop(0.22, 'rgba(255, 229, 157, 0.085)');
  glow.addColorStop(0.58, 'rgba(255, 235, 188, 0.027)');
  glow.addColorStop(1, 'rgba(255, 242, 214, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius - 4, cy - radius - 4, (radius + 4) * 2, (radius + 4) * 2);

  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255, 232, 171, 0.11)';
  ctx.shadowBlur = 18;
  const annulusWidth = Math.max(1, radius - innerRadius);
  for (let i = -2; i <= 2; i++) {
    const spread = i * 0.043;
    const rayAngle = angle + Math.PI + spread;
    const rayLength = annulusWidth * (0.7 + (2 - Math.abs(i)) * 0.07);
    const ex = sx + Math.cos(rayAngle) * rayLength;
    const ey = sy + Math.sin(rayAngle) * rayLength;
    const lineGradient = ctx.createLinearGradient(sx, sy, ex, ey);
    lineGradient.addColorStop(0, `rgba(255, 230, 166, ${0.075 - Math.abs(i) * 0.011})`);
    lineGradient.addColorStop(1, 'rgba(255, 226, 156, 0)');
    ctx.strokeStyle = lineGradient;
    ctx.lineWidth = i === 0 ? 1.8 : 0.9;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw a restrained cool haze around the moon sector. */
function drawMoonHaze(ctx, cx, cy, radius, angle) {
  const mx = cx + Math.cos(angle) * radius;
  const my = cy + Math.sin(angle) * radius;
  const haze = ctx.createRadialGradient(mx, my, 0, mx, my, radius * 0.22);
  haze.addColorStop(0, 'rgba(63, 214, 255, 0.16)');
  haze.addColorStop(0.42, 'rgba(63, 214, 255, 0.055)');
  haze.addColorStop(1, 'rgba(63, 214, 255, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = haze;
  ctx.beginPath();
  ctx.arc(mx, my, radius * 0.22, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Screen-space ring and celestial direction overlay for the full-globe view.
 */
export class CelestialRing {
  /**
   * @param {object} engine - src/maplibre/engine.js (map, canvas, container, on)
   * @param {{enabled?:boolean,onAutoDisable?:Function}} [options]
   */
  constructor(engine, { enabled = true, onAutoDisable = null } = {}) {
    this.engine = engine;
    /** Legacy alias: callers used to hand a Cesium viewer here. */
    this.viewer = engine;
    this.enabled = !!enabled;
    this.visible = false;
    this._onAutoDisable = typeof onAutoDisable === 'function' ? onAutoDisable : null;
    this._focusInProgress = false;
    this._ephemerisDirty = true;
    this._ephemerisUpdateCount = 0;
    this._sunAngle = 0;
    this._moonAngle = Math.PI;
    this._sunOpacity = 1;
    this._moonOpacity = 1;
    this._debug = null;
    this._nextDrawAt = 0;
    this._renderScale = 1;
    this._sunRenderKey = '';
    this._moonRenderKey = '';
    this._outlineRenderKey = '';

    this._sunFixed = { x: 1, y: 0, z: 0 };
    this._moonFixed = { x: -1, y: 0, z: 0 };

    this._buildDOM();
    // postRender equivalent: the engine emits 'render' after every map frame.
    this._removePostRender = engine?.on?.('render', () => this._draw()) || null;
    // Pre-existing staleness fix (perf wave 2 review): the ephemeris was
    // sampled once per visible-enable from the FROZEN app clock, so the
    // sun/moon markers aged with the app. Resample real wall time each
    // minute and request the one frame that repaints the ring.
    this._ephemerisTimer = setInterval(() => {
      if (!this.enabled) return;
      // Always mark dirty so a long-hidden interval can't serve stale
      // sun/moon vectors on return — but only request the repaint frame
      // while visible; the visibility-restore request (main.js) picks the
      // dirty flag up immediately. (review review finding)
      this._ephemerisDirty = true;
      if (typeof document !== 'undefined' && document.hidden) return;
      governorRequestRender('celestial-ephemeris');
    }, 60_000);
    this.setEnabled(this.enabled);
  }

  /** Construct cached effect layers and Material Symbols celestial markers. */
  _buildDOM() {
    this._root = document.createElement('div');
    this._root.id = 'celestial-ring-overlay';
    this._root.className = 'celestial-ring-overlay';
    this._root.setAttribute('aria-hidden', 'true');

    this._ringOutline = document.createElement('div');
    this._ringOutline.className = 'celestial-ring-outline';

    this._sunCanvas = document.createElement('canvas');
    this._sunCanvas.className = 'celestial-ring-canvas celestial-sun-canvas';
    this._sunCtx = this._sunCanvas.getContext('2d', { alpha: true, desynchronized: true });

    this._moonCanvas = document.createElement('canvas');
    this._moonCanvas.className = 'celestial-ring-canvas celestial-moon-canvas';
    this._moonCtx = this._moonCanvas.getContext('2d', { alpha: true, desynchronized: true });

    this._sunMarker = document.createElement('span');
    this._sunMarker.className = 'celestial-marker celestial-sun material-symbols-outlined';
    this._sunMarker.textContent = 'light_mode';

    this._moonMarker = document.createElement('span');
    this._moonMarker.className = 'celestial-marker celestial-moon material-symbols-outlined';
    this._moonMarker.textContent = 'dark_mode';

    this._root.append(
      this._ringOutline,
      this._sunCanvas,
      this._moonCanvas,
      this._sunMarker,
      this._moonMarker
    );
    this.engine?.container?.appendChild(this._root);
  }

  /** Enable or disable the user preference for the effect. */
  setEnabled(enabled) {
    const wasEnabled = this.enabled;
    this.enabled = !!enabled;
    if (this.enabled && !wasEnabled) this._ephemerisDirty = true;
    // The ring paints its canvases from postRender, which only fires on
    // rendered frames — under the idle render governor an enable (or the
    // clearing disable) must request its frame or the ring never draws at
    // all. Camera motion covers every later repaint; the 60 s ephemeris
    // timer requests its own. (perf wave 2 fix — field test finding)
    if (this.enabled !== wasEnabled) governorRequestRender('celestial-ring');
    this._root.classList.toggle('disabled', !this.enabled);
    if (!this.enabled) {
      this.visible = false;
      this._root.classList.remove('visible');
      this._clear();
    }
  }

  /** Whether the current camera already frames the complete globe inside the keyhole. */
  isGlobeFullyVisible() {
    const canvas = this.engine?.canvas;
    if (!canvas) return false;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!(width > 0 && height > 0)) return false;
    const disc = this._projectedEarthDisc(width, height);
    return !!disc && isFullGlobeInsideKeyhole(disc, false);
  }

  /**
   * Fly outward to the full-globe composition used by the celestial ring while
   * preserving the hemisphere currently beneath the camera.
   * @param {{duration?:number}} [options]
   * @returns {boolean} Whether a valid camera flight was started.
   */
  focusFullGlobe({ duration = 2.4 } = {}) {
    const engine = this.engine;
    const map = engine?.map;
    const canvas = engine?.canvas;
    const height = canvas?.clientHeight || canvas?.height;
    const f = mapTransform(map)?.cameraToCenterDistance;
    if (!map || !(height > 0) || !(f > 0)) return false;

    // The ring only exists on the globe projection.
    if (typeof engine.isGlobe === 'function' && !engine.isGlobe()) engine.setGlobe?.(true);

    const center = map.getCenter();
    const keyholeRadius = getKeyholeGeometry(canvas.clientWidth || canvas.width, height).radius;
    const targetScreenRadius = keyholeRadius * FULL_GLOBE_RADIUS_RATIO;
    const zoom = zoomForGlobeDiscRadius(targetScreenRadius, f, center.lat);
    if (!Number.isFinite(zoom)) return false;

    this._focusInProgress = true;
    engine.cancelFlight?.();
    let settled = false;
    const finishFocus = () => {
      if (settled) return;
      settled = true;
      this._focusInProgress = false;
      engine.requestRender?.();
      // Completed or interrupted: either way the ring stays only if the
      // whole globe now sits inside the keyhole (Cesium's cancel path).
      if (!this.isGlobeFullyVisible()) this._autoDisable();
    };
    const easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // CUBIC_IN_OUT
    // Preserve the hemisphere under the camera and its heading; nadir view.
    map.flyTo({
      center: [center.lng, center.lat],
      zoom: Math.max(map.getMinZoom?.() ?? 0, zoom),
      bearing: map.getBearing(),
      pitch: 0,
      duration: Math.max(0, duration) * 1000,
      easing,
      essential: true,
    });
    // Registered AFTER flyTo: its internal stop() may fire a stale moveend.
    if (map.isMoving()) map.once('moveend', finishFocus);
    else finishFocus();
    return true;
  }

  /** Clear the backing canvas. */
  _clear() {
    for (const [canvas, ctx] of [[this._sunCanvas, this._sunCtx], [this._moonCanvas, this._moonCtx]]) {
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    this._ringOutline?.style.setProperty('display', 'none');
    this._sunRenderKey = '';
    this._moonRenderKey = '';
    this._outlineRenderKey = '';
  }

  /** Resize the canvas backing store while drawing in CSS pixels. */
  _resize(width, height) {
    const nativeDpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelsScale = Math.sqrt(CELESTIAL_MAX_BACKING_PIXELS / (width * height));
    const dimensionScale = CELESTIAL_MAX_BACKING_DIMENSION / Math.max(width, height);
    const dpr = Math.min(nativeDpr, CELESTIAL_MAX_DEVICE_PIXEL_RATIO, pixelsScale, dimensionScale);
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    for (const [canvas, ctx] of [[this._sunCanvas, this._sunCtx], [this._moonCanvas, this._moonCtx]]) {
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._renderScale = dpr;
  }

  /**
   * Sample Earth-fixed directions once per enable. Camera movement only
   * re-projects these cached vectors; it never re-runs the planetary model.
   */
  _updateEphemeris(time) {
    if (!this._ephemerisDirty) return true;

    const date = time instanceof Date ? time : new Date();
    this._sunFixed = sunDirectionFixed(date);
    this._moonFixed = moonDirectionFixed(date);
    this._ephemerisDirty = false;
    this._ephemerisUpdateCount += 1;
    return true;
  }

  /** Disable after the camera leaves the complete-globe composition. */
  _autoDisable() {
    if (!this.enabled) return;
    this.setEnabled(false);
    this._onAutoDisable?.();
  }

  /** Return the projected Earth disc used for the full-globe gate. */
  _projectedEarthDisc(width, height) {
    return projectEarthDiscToViewport(this.engine, width, height);
  }

  /** Position one icon-library marker along the keyhole circumference. */
  _positionMarker(marker, cx, cy, radius, angle, opacity) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const margin = 14;
    const maxRadiusX = Math.abs(cos) > 1e-4 ? (cx - margin) / Math.abs(cos) : Number.POSITIVE_INFINITY;
    const maxRadiusY = Math.abs(sin) > 1e-4 ? (cy - margin) / Math.abs(sin) : Number.POSITIVE_INFINITY;
    const markerRadius = Math.min(radius, maxRadiusX, maxRadiusY);
    marker.style.left = `${cx + cos * markerRadius}px`;
    marker.style.top = `${cy + sin * markerRadius}px`;
    marker.style.opacity = String(opacity);
  }

  /** Update the cached effect geometry only when camera distance or viewport changes. */
  _renderEffectLayers(cx, cy, radius, rayInnerRadius) {
    const outlineKey = `${cx}:${cy}:${radius}`;
    if (outlineKey !== this._outlineRenderKey) {
      this._ringOutline.style.display = '';
      this._ringOutline.style.left = `${cx - radius}px`;
      this._ringOutline.style.top = `${cy - radius}px`;
      this._ringOutline.style.width = `${radius * 2}px`;
      this._ringOutline.style.height = `${radius * 2}px`;
      this._outlineRenderKey = outlineKey;
    }

    const sunKey = `${outlineKey}:${Math.round(rayInnerRadius)}`;
    if (sunKey !== this._sunRenderKey) {
      this._sunCtx.clearRect(0, 0, this._sunCanvas.width, this._sunCanvas.height);
      drawSunRays(this._sunCtx, cx, cy, radius, rayInnerRadius, 0);
      drawTaperedArc(this._sunCtx, cx, cy, radius, 0, '222, 190, 89', 0.56);
      this._sunRenderKey = sunKey;
    }

    if (outlineKey !== this._moonRenderKey) {
      this._moonCtx.clearRect(0, 0, this._moonCanvas.width, this._moonCanvas.height);
      drawMoonHaze(this._moonCtx, cx, cy, radius, 0);
      drawTaperedArc(this._moonCtx, cx, cy, radius, 0, '48, 201, 229', 0.42);
      this._moonRenderKey = outlineKey;
    }
  }

  /** Per-frame camera projection with GPU-composited cached effect layers. */
  _draw() {
    if (!this.enabled || !this._sunCtx || !this._moonCtx) return;
    const now = performance.now();
    if (now < this._nextDrawAt) return;
    this._nextDrawAt = now + 1000 / CELESTIAL_MAX_FRAME_RATE;
    const canvas = this.engine?.canvas;
    if (!canvas) return;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!(width > 0 && height > 0)) return;
    this._resize(width, height);

    const disc = this._projectedEarthDisc(width, height);
    const wasVisible = this.visible;
    const nextVisible = disc ? isFullGlobeInsideKeyhole(disc, wasVisible) : false;
    this.visible = nextVisible;
    this._root.classList.toggle('visible', nextVisible);
    this._root.dataset.globeVisible = String(nextVisible);
    this._root.dataset.ephemerisUpdates = String(this._ephemerisUpdateCount);
    if (!nextVisible || !disc) {
      this._clear();
      this._debug = { enabled: true, visible: false, disc };
      if (!this._focusInProgress) this._autoDisable();
      return;
    }

    if (!wasVisible) this._ephemerisDirty = true;

    if (!this._updateEphemeris(new Date())) return;
    this._root.dataset.ephemerisUpdates = String(this._ephemerisUpdateCount);
    const map = this.engine.map;
    const center = map.getCenter();
    const camera = cameraScreenAxesFixed({
      lat: center.lat,
      lon: center.lng,
      bearingDeg: map.getBearing(),
      pitchDeg: map.getPitch(),
    });
    const sunProjection = celestialScreenAngle(
      dot3(this._sunFixed, camera.right),
      dot3(this._sunFixed, camera.up),
      this._sunAngle
    );
    const moonProjection = celestialScreenAngle(
      dot3(this._moonFixed, camera.right),
      dot3(this._moonFixed, camera.up),
      this._moonAngle
    );
    if (sunProjection.stable) this._sunAngle = sunProjection.angle;
    if (moonProjection.stable) this._moonAngle = moonProjection.angle;
    this._sunOpacity = sunProjection.opacity;
    this._moonOpacity = moonProjection.opacity;

    const cx = width * 0.5;
    const cy = height * 0.5;
    const radius = disc.keyholeRadius - RING_INSET_PX;
    const rayInnerRadius = Math.min(radius - 12, disc.earthRadius + Math.max(38, radius * 0.065));
    this._renderEffectLayers(cx, cy, radius, rayInnerRadius);
    this._sunCanvas.style.transform = `rotate(${this._sunAngle}rad)`;
    this._sunCanvas.style.opacity = String(this._sunOpacity);
    this._moonCanvas.style.transform = `rotate(${this._moonAngle}rad)`;
    this._moonCanvas.style.opacity = String(this._moonOpacity);

    // Markers sit inside the illuminated band rather than straddling its outer
    // stroke. Near conjunction (such as a new moon), keep the true bearings but
    // move the moon into a second radial lane so both bodies remain legible.
    const markerRadius = radius - MARKER_INSET_PX;
    const markersCollide = circularAngleDistance(this._sunAngle, this._moonAngle)
      < MARKER_COLLISION_ANGLE;
    this._positionMarker(this._sunMarker, cx, cy, markerRadius, this._sunAngle, this._sunOpacity);
    this._positionMarker(
      this._moonMarker,
      cx,
      cy,
      markerRadius - (markersCollide ? COLLIDING_MARKER_EXTRA_INSET_PX : 0),
      this._moonAngle,
      this._moonOpacity
    );
    this._debug = {
      enabled: true,
      visible: true,
      sunAngle: this._sunAngle,
      moonAngle: this._moonAngle,
      sunOpacity: this._sunOpacity,
      moonOpacity: this._moonOpacity,
      markersCollide,
      ephemerisUpdates: this._ephemerisUpdateCount,
      renderScale: this._renderScale,
      disc: { ...disc },
    };
  }

  /** Read-only geometry snapshot for browser QA. */
  getDebugState() {
    return this._debug ? { ...this._debug, disc: this._debug.disc ? { ...this._debug.disc } : null } : null;
  }

  /** Detach the render hook and remove all overlay DOM. */
  destroy() {
    if (this._ephemerisTimer) {
      clearInterval(this._ephemerisTimer);
      this._ephemerisTimer = null;
    }
    if (this._removePostRender) this._removePostRender();
    this._removePostRender = null;
    this._root?.remove();
  }
}
