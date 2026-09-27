#!/usr/bin/env node
/**
 * qa-cables-overlay — submarine-cable layer measurement + contract gate on the
 * MapLibre engine (`telegeography-submarine-cables`,
 * src/maplibre/layers/contextoGev.js).
 *
 * The Cesium build drew the cable reference labels in the shared world-overlay
 * canvas; on MapLibre they are native `symbol` layers with collision
 * (`dg-cable-refs-label`) over the `dg-cables-line` lines. With the layer ON at
 * a fixed mid-Atlantic camera this:
 *  1. MEASURES
 *     a. toggle-ON → first-labels-rendered latency,
 *     b. rendered line / reference-point / label feature counts,
 *     c. map frame cadence over a ~10 s driven orbit (frames and mean gap
 *        between 'render' events — relative numbers, SwiftShader surface),
 *     d. parked-idle 'render' fires over 5 s (render-governor honesty).
 *  2. GATES
 *     - labels render after enable, lines and labels are present,
 *     - a parked camera stays near-idle with cables ON (≤6 fires / 5 s),
 *     - a clean OFF→ON cycle: nothing of the layer renders while OFF, labels
 *       come back after ON.
 *
 * `--control` never enables the layer and only measures the empty-scene orbit.
 *
 * Usage: node scripts/qa-cables-overlay.mjs [--url http://localhost:4400] [--control]
 * Requires a running dev server.
 */
import {
  DEFAULT_APP_URL, argValue, hasFlag, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', DEFAULT_APP_URL);
const control = hasFlag('--control');
const LAYER_ID = 'telegeography-submarine-cables';
const LAYERS = ['dg-cables-line', 'dg-cable-refs-pt', 'dg-cable-refs-label'];

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
function report(name, detail) {
  console.log(`  [MEAS] ${name} — ${JSON.stringify(detail)}`);
}

const renderedCounts = (page) => page.evaluate((ids) => {
  const { map } = window.__godsEyeView.engine;
  const out = {};
  for (const id of ids) out[id] = map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : -1;
  return out;
}, LAYERS);

const { browser, page } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

try {
  await openApp(page, url);
  await sleep(4_000); // boot flight + deferred init

  // Park mid-Atlantic (many cables + both coasts' landings in range) and
  // disable every layer so the cables layer is measured in isolation.
  await setCamera(page, { lon: -40, lat: 35, alt: 4_500_000 });
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* measured via counts */ } }
    }
  });
  await waitMapIdle(page);
  await sleep(2_000);

  // ── a. toggle-ON → labels rendered ────────────────────────────────────
  if (!control) {
    const labelLatency = await page.evaluate(async (layerId) => {
      const gev = window.__godsEyeView;
      const { map } = gev.engine;
      const t0 = performance.now();
      await gev.dataManager.setEnabled(layerId, true, { origin: 'user' });
      while (performance.now() - t0 < 60_000) {
        if (map.getLayer('dg-cable-refs-label') && map.queryRenderedFeatures({ layers: ['dg-cable-refs-label'] }).length > 0) {
          return { ms: Math.round(performance.now() - t0), timedOut: false };
        }
        gev.engine.requestRender();
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ms: 60_000, timedOut: true };
    }, LAYER_ID);
    report('toggle-ON -> labels rendered (ms)', labelLatency);
    check('labels became visible after enable', labelLatency.timedOut === false, labelLatency);
    await waitMapIdle(page);
    await sleep(1_000);
  }

  // ── b. rendered counts ────────────────────────────────────────────────
  const counts = await renderedCounts(page);
  report(control ? 'rendered counts (control, cables OFF)' : 'rendered counts with cables ON', counts);

  // ── c. frame cadence over a ~10 s driven orbit ────────────────────────
  const orbit = await page.evaluate(() => new Promise((resolve) => {
    const { engine } = window.__godsEyeView;
    const stamps = [];
    const remove = engine.on('render', () => stamps.push(performance.now()));
    const t0 = performance.now();
    const tick = () => {
      const c = engine.map.getCenter();
      engine.map.jumpTo({ center: [c.lng + 0.02, c.lat] });
      if (performance.now() - t0 < 10_000) requestAnimationFrame(tick);
      else {
        remove();
        const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
        const n = gaps.length;
        resolve({
          frames: stamps.length,
          meanGapMs: +(gaps.reduce((s, d) => s + d, 0) / Math.max(1, n)).toFixed(2),
          p95GapMs: +(gaps[Math.floor(n * 0.95)] || 0).toFixed(2),
          effectiveFps: +(stamps.length / 10).toFixed(1),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  report(control ? 'orbit cadence, control (cables OFF), 10s' : 'orbit cadence, cables ON, 10s', orbit);

  // ── d. parked idle honesty ────────────────────────────────────────────
  await sleep(4_000);
  const idle = await page.evaluate(() => new Promise((resolve) => {
    let renders = 0;
    const remove = window.__godsEyeView.engine.on('render', () => { renders += 1; });
    setTimeout(() => { remove(); resolve({ renders }); }, 5_000);
  }));
  report(control ? 'parked idle, control (render fires / 5s)' : 'parked idle with cables ON (render fires / 5s)', idle);

  if (!control) {
    check('cable lines are drawn', counts['dg-cables-line'] > 0, counts);
    check('reference labels are drawn', counts['dg-cable-refs-label'] > 0, counts);
    check('parked idle stays near zero (≤6 / 5s)', idle.renders <= 6, idle);

    // OFF must leave nothing of the layer on screen, ON must restore labels.
    await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
    await sleep(1_200);
    const off = await renderedCounts(page);
    await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
    let on = null;
    for (let i = 0; i < 100; i++) {
      on = await renderedCounts(page);
      if (on['dg-cable-refs-label'] > 0) break;
      await sleep(200);
    }
    check('disable leaves no cable feature rendered (no orphans)', Object.values(off).every((n) => n <= 0), off);
    check('re-enable restores the labels', on['dg-cable-refs-label'] > 0, on);
  }
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-cables-overlay: ${passed}/${results.length} passed${control ? ' (control mode)' : ''}`);
console.log(`RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`);
process.exit(passed === results.length ? 0 : 1);
