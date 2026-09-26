// src/data/trackedModelRegime.test.mjs
//
// Zoom-driven 2D↔3D for the TRACKED contact (product invariant 2026-08-19).
//
// Two things are pinned here, and both are behavioural rather than cosmetic:
//
//  1. The POLICY — thresholds and hysteresis — as pure math in
//     trackedModelRegime.js. The enter ceiling is the playtested swap
//     distance, deliberately much NEARER than the fleet ceiling, and the exit
//     ceiling is deliberately higher than the enter ceiling. A regression that
//     collapsed the two thresholds back into one would silently reintroduce
//     billboard↔model flapping for a camera orbiting the boundary, which no
//     unit test would otherwise catch.
//
//  2. (REMOVIDO na migração MapLibre, 2026-09) A fiação nas camadas de voo —
//     o alvo trocando ícone ↔ modelo glTF por zoom — era 3D-only: no MapLibre
//     não há modelo, a aeronave é sempre o ícone. A política continua exportada
//     (trackedModelRegime.js) para quem montar uma câmera de perseguição, e
//     segue testada abaixo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackedModelZoomActive,
  TRACKED_MODEL_ENTER_ALT_M,
  TRACKED_MODEL_EXIT_ALT_M,
  FLEET_MODEL_ALT_CEIL_M,
  TRACKED_MODEL_EXIT_RATIO,
} from './trackedModelRegime.js';
// Sample altitudes are expressed RELATIVE to the band rather than as absolute
// offsets. The thresholds have already been retuned once (1_000_000 → 150_000
// on the owner's playtest), and the fixed ±50 km / ±100 km offsets that were
// fine against a 150 km-wide band silently landed on the WRONG SIDE of the exit
// ceiling against a 22.5 km one. Deriving them keeps the next retune honest.
const BAND_WIDTH_M = TRACKED_MODEL_EXIT_ALT_M - TRACKED_MODEL_ENTER_ALT_M;
/** Strictly between enter and exit: latched → holds, fresh → does not. */
const INSIDE_BAND_M = TRACKED_MODEL_ENTER_ALT_M + BAND_WIDTH_M / 2;
/** Unambiguously past the exit ceiling. */
const FAR_OUTSIDE_M = TRACKED_MODEL_EXIT_ALT_M * 2;
/** Unambiguously below the enter ceiling. */
const WELL_INSIDE_M = TRACKED_MODEL_ENTER_ALT_M / 2;

// ---------------------------------------------------------------------------
// 1. Policy: thresholds + hysteresis math
// ---------------------------------------------------------------------------

test('the tracked 3D takeover sits at the playtested swap distance', () => {
  // Field test 2026-08-20: an earlier 1_000_000 m ceiling "pops to 3D far
  // too early" — 2D still reads correctly at ~600_000 m and the swap belongs at
  // ~150_000 m. These are the numbers the operator judged by eye, so they are
  // pinned literally rather than derived from anything.
  assert.equal(TRACKED_MODEL_ENTER_ALT_M, 150_000);
  assert.equal(trackedModelZoomActive(600_000, false), false,
    'the owner explicitly called 2D correct at ~600 km — it must not model there');
  assert.equal(trackedModelZoomActive(140_000, false), true,
    'inside the ruled swap distance the model owns the visual');
});

test('the tracked contact swaps NEARER than the fleet — a recorded inversion, not a bug', () => {
  // Consequence of the selected threshold, spelled out so it cannot be "tidied
  // away": with the DISPLAY-rail 3D toggle ON, camera altitudes between the
  // tracked ceiling and the fleet ceiling draw surrounding contacts as models
  // while the SELECTED one is still a billboard. The fleet pass skips the
  // tracked icao, so nothing double-draws — this is purely an ordering
  // difference. Aligning them is a fleet-side decision, out of scope here.
  assert.equal(FLEET_MODEL_ALT_CEIL_M, 800_000,
    'mirror of MODEL_ALT_CEIL_M in both flight layers');
  assert.ok(TRACKED_MODEL_ENTER_ALT_M < FLEET_MODEL_ALT_CEIL_M,
    'the tracked contact deliberately enters 3D closer in than the fleet does');
  assert.equal(trackedModelZoomActive(FLEET_MODEL_ALT_CEIL_M - 1, false), false,
    'just inside the fleet ceiling the tracked contact is still 2D');
});

test('enter and exit thresholds are ASYMMETRIC — the anti-flap band', () => {
  assert.equal(TRACKED_MODEL_EXIT_RATIO, 1.15);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, 172_500);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, TRACKED_MODEL_ENTER_ALT_M * TRACKED_MODEL_EXIT_RATIO,
    'the exit ceiling stays derived from enter, so retuning enter carries the band with it');
  assert.ok(TRACKED_MODEL_EXIT_ALT_M > TRACKED_MODEL_ENTER_ALT_M,
    'a single shared threshold is exactly the flapping bug this prevents');
});

test('the regime enters at the enter ceiling and leaves only past the exit ceiling', () => {
  // Coming in from far out: nothing below the enter ceiling → still 2D.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M, false), false,
    'the ceiling itself is still outside — the regime is strictly below it');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - 1, false), true);

  // Already inside: the model holds the visual all the way out to the exit ceiling.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, true), true,
    'crossing back over the ENTER ceiling must not hand back — that is the flap');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M - 1, true), true);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M, true), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, true), false);
});

test('an orbit sitting AT the boundary never flaps', () => {
  // Simulate a camera loitering on the enter ceiling with orbital
  // wobble. Under a single threshold this alternates every sample.
  let active = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - BAND_WIDTH_M / 4, false);
  assert.equal(active, true, 'the orbit begins inside the regime');
  let transitions = 0;
  for (let i = 0; i < 40; i++) {
    const wobble = (i % 2 === 0 ? 1 : -1) * (BAND_WIDTH_M / 8);
    const next = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + wobble, active);
    if (next !== active) transitions++;
    active = next;
  }
  assert.equal(transitions, 0, 'the hysteresis band absorbs boundary wobble entirely');
  assert.equal(active, true);
});

test('a missing camera height reads as infinitely far out, never as "zoomed in"', () => {
  for (const height of [undefined, null, NaN, Infinity]) {
    assert.equal(trackedModelZoomActive(height, false), false);
    assert.equal(trackedModelZoomActive(height, true), false,
      'a torn-down viewer must not latch the model on');
  }
});

