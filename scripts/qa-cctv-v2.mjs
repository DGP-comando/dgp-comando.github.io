/**
 * qa-cctv-v2.mjs — CCTV subsystem proof harness on the MapLibre engine.
 *
 * The Cesium harness proved the 3D frustum (5 polylines + far-cap plane),
 * the per-activation obstruction raycast, mesh-floor sampling and the 3D
 * calibration gizmo. On MapLibre the camera's coverage is the POLYGON ON THE
 * GROUND where the cone meets the floor (src/data/cctvViewshed.js), the live
 * frame is a "monitor" card at the end of the sight axis, there is no mesh to
 * raycast, and the gizmo is two draggable markers (src/data/cctvGizmo.js).
 * This harness asserts the invariants that still hold (all GL-independent —
 * layer state, map-source data, localStorage and network, never pixels):
 *
 *   1. Catalog: the layer loads cameras from /api/cctv/sources and a camera
 *      can be made active (`selectCamera`).
 *   2. Coverage geometry: with coverage 'on' the active camera has a ground
 *      footprint in the `dg-cctv-cover` source, and that geometry is
 *      byte-stable over an idle window (nothing rewrites it without a reason).
 *   3. Calibration round-trip: a manual patch + save writes the v2
 *      localStorage entry with source:'manual', rotates the footprint and
 *      flips the camera's calBadge; reset removes the entry and restores the
 *      base footprint.
 *   4. Frame loop: the active camera's public `frameUrl` and the frame
 *      requests the page actually makes share the /api/cctv/frame/<id> family.
 *   5. Empty-space click: a click on empty map publishes exactly one
 *      "no active camera" transition and does not move the camera; a repeat
 *      click is idempotent.
 *   6. Viewshed mode: coverage tri-state round-trip ('off' / 'on' /
 *      'viewshed') plus the boolean `showCoverage` compatibility; 'viewshed'
 *      fills the footprints of the visible set, 'off' draws none.
 *   7. Calibration gizmo: ADJUST mode shows the two drag handles (mount and
 *      aim) and hides them again when it is turned off.
 *
 * Run:  node scripts/qa-cctv-v2.mjs --url http://localhost:4400
 * Needs the dev server's /api/cctv/* proxy (camera catalog). Screenshots go
 * to qa-shots/cctv-v2/ for human review and do not gate the exit code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  argValue, createReport, hasFlag, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const HEADFUL = hasFlag('--headful');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'cctv-v2');
const STORAGE_KEY = 'godsEyeView.cctv.calibration.v2';
// Downtown Austin: the default CCTV source pack.
const AUSTIN = { lat: 30.2672, lon: -97.7431 };

const { check, finish } = createReport('qa-cctv-v2');

/** Footprint features of the `dg-cctv-cover` source (optionally one camera's). */
const coverData = (page) => page.evaluate(async () => {
  const src = window.__godsEyeView.engine.map.getSource('dg-cctv-cover');
  const data = src ? await src.getData() : null;
  return data?.features ?? [];
});
const cctv = (page, fn, ...args) => page.evaluate(
  // eslint-disable-next-line no-new-func
  (source, a) => new Function('mod', 'args', `return (${source})(mod, ...args);`)(
    window.__godsEyeView.dataManager.layers.get('cctv').module, a,
  ),
  fn.toString(),
  args,
);

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const { browser, page, errors } = await launchQaBrowser({ headful: HEADFUL, viewport: { width: 1440, height: 900 } });
  const frameRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/cctv/frame/')) frameRequests.push(url.pathname);
  });
  try {
    await openApp(page, APP_URL);
    await page.keyboard.press('Escape'); // first-run tutorial
    await page.evaluate((key) => { try { localStorage.removeItem(key); } catch { /* */ } }, STORAGE_KEY);
    await setCamera(page, { ...AUSTIN, alt: 2_500 });

    // ── 1. catalog ─────────────────────────────────────────────────────
    console.log('\n1 — catalog');
    const catalog = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      if (!dm.layers.has('cctv')) return { registered: false };
      await dm.setEnabled('cctv', true, { origin: 'user' });
      const mod = dm.layers.get('cctv').module;
      for (let i = 0; i < 120; i++) {
        const ui = mod.getUIState();
        if ((ui?.cameras?.length ?? 0) > 0) return { registered: true, count: ui.cameras.length };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { registered: true, count: 0, stats: mod.getStats() };
    });
    check('cctv layer registered (dev build)', catalog.registered, catalog);
    check('camera catalog loads from /api/cctv/sources', catalog.count > 0, catalog);
    if (!(catalog.count > 0)) return;

    const cameraId = await cctv(page, (mod) => {
      const ui = mod.getUIState();
      const first = ui.cameras[0];
      mod.setParams({ coverageMode: 'on' });
      mod.selectCamera(first.id);
      return first.id;
    });
    await sleep(1_500);
    const activeId = await cctv(page, (mod) => mod.getUIState().activeCameraId);
    check('selectCamera makes the camera active', activeId === cameraId, { cameraId, activeId });
    await setCamera(page, await cctv(page, (mod) => {
      const cam = mod.getUIState().activeCamera;
      return { lat: cam.lat ?? cam.latitude, lon: cam.lon ?? cam.longitude, alt: 1_500 };
    }).then((v) => (Number.isFinite(v.lat) ? v : { ...AUSTIN, alt: 1_500 })));
    await waitMapIdle(page);

    // ── 2. coverage geometry ───────────────────────────────────────────
    console.log('\n2 — coverage geometry');
    const base = await coverData(page);
    const own = base.filter((f) => JSON.stringify(f.properties ?? {}).includes(cameraId));
    check('active camera has a ground footprint in dg-cctv-cover', own.length > 0,
      { features: base.length, forActive: own.length });
    const before = JSON.stringify(own.map((f) => f.geometry));
    await sleep(10_000);
    const idleAfter = JSON.stringify((await coverData(page))
      .filter((f) => JSON.stringify(f.properties ?? {}).includes(cameraId)).map((f) => f.geometry));
    check('footprint geometry is byte-stable over a 10 s idle window', before === idleAfter && before !== '[]');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'coverage-on.png') });

    // ── 3. calibration round-trip ──────────────────────────────────────
    console.log('\n3 — calibration round-trip');
    const saved = await cctv(page, (mod, id, key) => {
      mod.setParams({ calibration: { cameraId: id, patch: { headingDeg: 25 }, save: true } });
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(key) || 'null'); } catch { stored = null; }
      const cam = mod.getUIState().cameras.find((c) => c.id === id);
      return { entry: stored?.[id] ?? null, badge: cam?.calBadge ?? null, values: mod.getParams().calibration?.values ?? null };
    }, cameraId, STORAGE_KEY);
    await sleep(800);
    const rotated = JSON.stringify((await coverData(page))
      .filter((f) => JSON.stringify(f.properties ?? {}).includes(cameraId)).map((f) => f.geometry));
    check('save writes the v2 localStorage entry with source:"manual"', saved.entry?.source === 'manual' && saved.entry?.values?.headingDeg === 25,
      saved.entry);
    check('the calibration badge reports the camera as calibrated', /calibrated|manual/i.test(String(saved.badge)), saved.badge);
    check('the patch rotates the ground footprint', rotated !== before && rotated !== '[]');

    const reset = await cctv(page, (mod, id, key) => {
      mod.setParams({ calibration: { cameraId: id, reset: true } });
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(key) || 'null'); } catch { stored = null; }
      return { entry: stored?.[id] ?? null };
    }, cameraId, STORAGE_KEY);
    await sleep(800);
    const restored = JSON.stringify((await coverData(page))
      .filter((f) => JSON.stringify(f.properties ?? {}).includes(cameraId)).map((f) => f.geometry));
    check('reset removes the stored entry', reset.entry === null, reset);
    check('reset restores the base footprint', restored === before);

    // ── 4. frame loop ──────────────────────────────────────────────────
    console.log('\n4 — frame loop');
    await sleep(3_000);
    const frameUrl = await cctv(page, (mod) => mod.getUIState().activeCamera?.frameUrl ?? null);
    const family = `/api/cctv/frame/${encodeURIComponent(cameraId)}`;
    check('active camera exposes a /api/cctv/frame/<id> frame URL', String(frameUrl).startsWith(family), frameUrl);
    check('the page actually fetches frames from the same family', frameRequests.some((p) => p.startsWith('/api/cctv/frame/')),
      `${frameRequests.length} frame requests`);

    // ── 5. empty-space click ───────────────────────────────────────────
    console.log('\n5 — empty-space click');
    await page.evaluate(() => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      window.__qaCctvTransitions = [];
      let last = mod.getUIState().activeCameraId;
      window.__qaCctvUnsub = mod.subscribe((state) => {
        if (state.activeCameraId !== last) {
          window.__qaCctvTransitions.push(state.activeCameraId);
          last = state.activeCameraId;
        }
      });
    });
    const emptyPoint = await page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      const r = engine.container.getBoundingClientRect();
      const { clientWidth: w, clientHeight: h } = engine.container;
      // A grid cell where the map canvas itself is on top (no panel, card or
      // marker) and no app feature lies within 12 px.
      for (let gy = 1; gy < 8; gy += 1) {
        for (let gx = 1; gx < 10; gx += 1) {
          const x = (w * gx) / 10;
          const y = (h * gy) / 8;
          const el = document.elementFromPoint(r.left + x, r.top + y);
          if (el !== engine.canvas) continue;
          const hits = engine.pick(x, y, { radius: 12 }).filter((f) => String(f.layer?.id || '').startsWith('dg-'));
          if (!hits.length) return { x: r.left + x, y: r.top + y };
        }
      }
      return null;
    });
    if (!emptyPoint) {
      check('found an empty spot on the map', false);
    } else {
      const camBefore = await page.evaluate(() => window.__godsEyeView.engine.getCameraView());
      await page.mouse.click(emptyPoint.x, emptyPoint.y);
      await sleep(900);
      await page.mouse.click(emptyPoint.x, emptyPoint.y);
      await sleep(900);
      const after = await page.evaluate(() => ({
        transitions: window.__qaCctvTransitions.slice(),
        cam: window.__godsEyeView.engine.getCameraView(),
      }));
      await page.evaluate(() => window.__qaCctvUnsub?.());
      check('empty-space click publishes exactly one null transition (repeat is idempotent)',
        after.transitions.length === 1 && after.transitions[0] === null, after.transitions);
      check('empty-space click does not move the camera',
        Math.abs(after.cam.alt - camBefore.alt) < 1 && Math.hypot(after.cam.lat - camBefore.lat, after.cam.lon - camBefore.lon) < 1e-6);
    }

    // The empty-space click released the active camera; take it back for the
    // coverage and gizmo checks, which are about the active camera.
    await cctv(page, (mod, id) => mod.selectCamera(id), cameraId);
    await sleep(800);

    // ── 6. viewshed mode ───────────────────────────────────────────────
    console.log('\n6 — coverage modes');
    const modes = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const { map } = window.__godsEyeView.engine;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const read = async () => {
        const data = await map.getSource('dg-cctv-cover')?.getData();
        const feats = data?.features ?? [];
        return {
          mode: mod.getParams().coverageMode,
          polygons: feats.filter((f) => /Polygon/.test(f.geometry?.type)).length,
          // With the live projection on, the ACTIVE camera keeps its footprint
          // even in 'off' (coverageFeatures in src/data/cctv.js).
          otherPolygons: feats.filter((f) => /Polygon/.test(f.geometry?.type) && !f.properties?.active).length,
          fillVisible: map.getLayer('dg-cctv-cover-fill') ? map.getLayoutProperty('dg-cctv-cover-fill', 'visibility') !== 'none' : false,
        };
      };
      const out = {};
      mod.setParams({ coverageMode: 'viewshed' }); await wait(800); out.viewshed = await read();
      mod.setParams({ coverageMode: 'off' }); await wait(800); out.off = await read();
      mod.setParams({ showCoverage: true }); await wait(800); out.boolTrue = await read();
      mod.setParams({ showCoverage: false }); await wait(800); out.boolFalse = await read();
      mod.setParams({ coverageMode: 'on' }); await wait(800); out.on = await read();
      return out;
    });
    check('viewshed fills the footprints of the visible set', modes.viewshed.mode === 'viewshed' && modes.viewshed.polygons > 0, modes.viewshed);
    check("'off' draws no coverage footprint (only the active camera's projection may stay)",
      modes.off.mode === 'off' && modes.off.otherPolygons === 0 && modes.off.polygons <= 1, modes.off);
    check('boolean showCoverage maps to on/off', modes.boolTrue.mode === 'on' && modes.boolFalse.mode === 'off', { t: modes.boolTrue.mode, f: modes.boolFalse.mode });
    check("back to 'on' restores the active footprint", modes.on.mode === 'on' && modes.on.polygons > 0, modes.on);

    // ── 7. calibration gizmo ───────────────────────────────────────────
    console.log('\n7 — calibration gizmo');
    const gizmo = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('cctv').module;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const count = () => ({
        mount: document.querySelectorAll('.dg-cctv-gizmo-mount').length,
        aim: document.querySelectorAll('.dg-cctv-gizmo-aim').length,
      });
      mod.setParams({ calibrationMode: true }); await wait(800);
      const on = count();
      mod.setParams({ calibrationMode: false }); await wait(800);
      const off = count();
      return { on, off };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'final.png') });
    check('ADJUST mode shows the mount and aim handles', gizmo.on.mount === 1 && gizmo.on.aim === 1, gizmo.on);
    check('turning ADJUST off removes the handles', gizmo.off.mount === 0 && gizmo.off.aim === 0, gizmo.off);

    check('no page/console errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
}

main()
  .then(() => finish())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
