// Oclusão de horizonte no overlay de mundo com `cullPosition` (o ponto
// elevado que uma fonte pode oferecer para o teste de horizonte, mantendo a
// posição de desenho no datum) — src/overlays/worldOverlay.js.
//
// Migrado de uma suíte da camada FIRMS Cesium (firmsHeatmap.js, removida).
// Saíram os testes de `applyHorizonCull` / `fireCullPosition` e da integração
// com a camada (rebuild, moveEnd, preRender, reativação, coorte de cards): no
// MapLibre os focos são layers do próprio mapa e o motor já recorta o lado de
// lá do globo. Ficam os contratos do host do overlay, que continua vivo, agora
// com o oclusor esférico de worldGeometry.js no lugar do EllipsoidalOccluder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverlayPointVisible, normalizeOverlayEntry } from '../overlays/worldOverlay.js';
import { createHorizonOccluder, sphereXyz } from '../overlays/worldGeometry.js';

const AUSTIN = { lon: -97.7, lat: 30.2 };
/** Antipode of Austin — as far behind the limb as a point on Earth can be. */
const ANTIPODE = { lon: 82.3, lat: -30.2 };
/** Reported repro altitude for the through-the-globe defect. */
const REPRO_HEIGHT_M = 1_500_000;

/** Horizon occluder for a camera directly above Austin at `heightM`. */
function occluderOverAustin(heightM) {
  const occluder = createHorizonOccluder();
  const cam = sphereXyz(AUSTIN.lon, AUSTIN.lat, heightM);
  occluder.setCamera(cam.x, cam.y, cam.z);
  occluder.enabled = true;
  return occluder;
}

/** Longitude east of Austin where a ground-level point sits exactly on the limb. */
function limbDlon(occluder) {
  let lo = 0;
  let hi = 90;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (occluder.isPointVisible({ lon: AUSTIN.lon + mid, lat: AUSTIN.lat, height: 0 })) lo = mid;
    else hi = mid;
  }
  return lo;
}

test('isOverlayPointVisible: horizon test prefers entry.cullPosition when present', () => {
  const viewport = { width: 800, height: 600 };
  const screen = { x: 400, y: 300 };
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const dlon = limbDlon(occluder);
  const render = { lon: AUSTIN.lon + dlon, lat: AUSTIN.lat, height: -22 };
  const lifted = { lon: AUSTIN.lon + dlon, lat: AUSTIN.lat, height: 12 };

  assert.equal(
    isOverlayPointVisible({ horizonCull: true }, render, screen, viewport, occluder),
    false,
    'baseline: the render anchor alone false-hides the card',
  );
  assert.equal(
    isOverlayPointVisible({ horizonCull: true, cullPosition: lifted }, render, screen, viewport, occluder),
    true,
    'the supplied cull position is what the horizon test uses',
  );
  assert.equal(
    isOverlayPointVisible(
      { horizonCull: true, cullPosition: { lon: ANTIPODE.lon, lat: ANTIPODE.lat, height: 12 } },
      render,
      screen,
      viewport,
      occluder,
    ),
    false,
    'a far-side cull position still culls',
  );
});

test('normalizeOverlayEntry: carries a valid cullPosition, nulls a junk one', () => {
  const position = { lon: 1, lat: 2, height: 3 };
  const kept = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: { lon: 4, lat: 5, height: 6 } });
  assert.deepEqual(
    [kept.cullPosition.lon, kept.cullPosition.lat, kept.cullPosition.height],
    [4, 5, 6],
  );
  const onSphere = sphereXyz(4, 5, 6);
  assert.ok(Math.abs(kept.cullPosition.x - onSphere.x) < 1e-6, 'resolved onto the map sphere');
  const dropped = normalizeOverlayEntry('firms', { id: 'b', position, cullPosition: { lon: NaN, lat: 5, height: 6 } });
  assert.equal(dropped.cullPosition, null, 'a malformed cull point falls back to the render position');
  const notAnObject = normalizeOverlayEntry('firms', { id: 'b2', position, cullPosition: 42 });
  assert.equal(notAnObject.cullPosition, null, 'a non-object cull point is rejected');
  const absent = normalizeOverlayEntry('firms', { id: 'c', position });
  assert.equal(absent.cullPosition, null, 'sources that do not opt in resolve to no cull anchor');
});

test('normalizeOverlayEntry: the stored cull anchor is a snapshot, not the caller object', () => {
  const position = { lon: 1, lat: 2, height: 3 };
  const caller = { lon: 4, lat: 5, height: 6 };
  const normalized = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: caller });
  assert.notEqual(normalized.cullPosition, caller, 'the host must not retain the caller reference');

  // Sources legitimately recycle scratch vectors between publishes; a mutation
  // after normalization must never reach the per-frame occluder.
  caller.lon = NaN;
  caller.lat = 999;
  assert.deepEqual(
    [normalized.cullPosition.lon, normalized.cullPosition.lat, normalized.cullPosition.height],
    [4, 5, 6],
    'post-normalize mutation of the source vector has no effect',
  );
});

test('normalizeOverlayEntry: an accessor-backed cullPosition is read exactly once', () => {
  const position = { lon: 1, lat: 2, height: 3 };
  let reads = 0;
  const entry = {
    id: 'a',
    position,
    get cullPosition() {
      reads += 1;
      return { lon: 4, lat: 5, height: 6 };
    },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(reads, 1, 'one property read — not one per validated component');
  assert.deepEqual(
    [normalized.cullPosition.lon, normalized.cullPosition.lat, normalized.cullPosition.height],
    [4, 5, 6],
  );
});

test('normalizeOverlayEntry: a throwing cullPosition accessor does not abort normalization', () => {
  const entry = {
    id: 'a',
    position: { lon: 1, lat: 2, height: 3 },
    title: 'still normalized',
    get cullPosition() { throw new Error('hostile accessor'); },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(normalized.cullPosition, null, 'the bad anchor degrades to null');
  assert.equal(normalized.title, 'still normalized', 'the rest of the entry survives');
  assert.equal(normalized.id, 'a');
});
