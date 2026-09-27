#!/usr/bin/env node
/**
 * track-regression.mjs — DETERMINISTIC regression harness for flight TRACKING
 * on the MapLibre engine.
 *
 * Tracking regressed several times in the Cesium app (flicker → freeze →
 * jitter → pull-out → cross-layer orphan). The engine changed; the invariants
 * the owner cares about did not. This harness drives the REAL app headless and
 * locks the ones that still mean something on a 2D/globe map:
 *
 *   0. INIT CLEAN        — flights + military registered, no page/console
 *                          errors during boot.
 *   1. NO JITTER         — while tracked, the target's `getPosition()` (what
 *                          the engine centres on), the tracked icon marker on
 *                          screen and the `getDetectableObjects()` entry
 *                          (HUD/detection) agree on EVERY sampled frame, and
 *                          the map centre follows the target.
 *   2. NO PULL-OUT       — switching the tracked plane A → B keeps the camera
 *                          altitude in the follow band (no overview jump).
 *   3. NO CROSS-LAYER    — tracking a military plane and then a commercial one
 *      ORPHAN              (and back) clears the first layer's
 *                          `getTrackedInfo()` (engine 'trackedchange').
 *   H1. CLICK OWN PLANE  — a real mouse click on the tracked icon is a no-op
 *                          (still tracked, camera does not jump).
 *   M3. AGE-OUT RELEASE  — when the tracked plane's fixes stop arriving it
 *                          coasts with a "STALE" card, then (after the missed-
 *                          poll grace) tracking clears and the camera is
 *                          released IN PLACE (no fly-out).
 *   L. LANDING GHOST     — a low+slow (landed) plane that vanishes is removed
 *                          after ONE missed poll; a cruise plane keeps the
 *                          3-poll grace.
 *   E. ESC RELEASE       — Esc releases the tracked plane without moving the
 *                          camera.
 *
 * What the Cesium harness also covered and no longer exists (3D models, model
 * matrices, ground snap / floor hold, depth test of ground billboards, the
 * standalone tracked model pick id) is retired with the Cesium engine — see
 * scripts/APOSENTADOS.md.
 *
 * DETERMINISM: a fetch shim installed before app code answers the pollers:
 *   /api/opensky        → { states: [state-vector…] } (synthetic planes)
 *   /api/adsblol/mil    → { ac: [aircraft…] }
 *   /api/opensky-track, /api/adsblol/trace, /api/adsbdb/* → empty payloads
 * Missed polls are driven by calling the layer's own `update()`.
 *
 * Run:  npm run test:track                (QA_BASE_URL or http://localhost:4173)
 *       node scripts/track-regression.mjs --url http://localhost:4400 [--headful]
 * Exits non-zero if any invariant fails.
 */

import {
  DEFAULT_APP_URL, argValue, hasFlag, launchQaBrowser, openApp, setCamera, sleep, createReport,
} from './lib/qaBrowser.mjs';

const APP_URL = argValue('--url', DEFAULT_APP_URL);
const HEADFUL = hasFlag('--headful');

// Synthetic planes around Curitiba (the app opens over Paraná).
const SYNTH = {
  flights: [
    { icao: 'aaa001', callsign: 'SYN001', lon: -49.270, lat: -25.430, alt: 9000, vel: 230, track: 90 },
    { icao: 'aaa002', callsign: 'SYN002', lon: -49.300, lat: -25.410, alt: 9500, vel: 210, track: 45 },
    { icao: 'aaa003', callsign: 'SYN003', lon: -49.240, lat: -25.460, alt: 8700, vel: 250, track: 135 },
    // Landing-ghost pair: one low+slow (landed profile), one cruise.
    { icao: 'aaa004', callsign: 'SYNLND', lon: -49.175, lat: -25.530, alt: 60, vel: 20, track: 150 },
    { icao: 'aaa005', callsign: 'SYNCRZ', lon: -49.350, lat: -25.380, alt: 10500, vel: 240, track: 270 },
  ],
  military: [
    { hex: 'bbb101', flight: 'MIL101', lon: -49.280, lat: -25.440, altFt: 28000, track: 270, gsKt: 420, t: 'F16', r: 'AF-101' },
    { hex: 'bbb102', flight: 'MIL102', lon: -49.255, lat: -25.450, altFt: 26000, track: 315, gsKt: 400, t: 'F18', r: 'AF-102' },
  ],
};

const report = createReport('track-regression');
const { check, skip } = report;

async function main() {
  console.log('\nTracking regression harness (MapLibre)');
  console.log(`  App URL : ${APP_URL}`);
  try {
    const res = await fetch(new URL(APP_URL).origin);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    console.error(`Dev server not reachable at ${APP_URL} (${error.message}). Start it: ./scripts/dev-fresh.sh or npm run dev`);
    process.exit(2);
  }

  const { browser, page, errors } = await launchQaBrowser({ headful: HEADFUL, viewport: { width: 1280, height: 800 } });
  try {
    await page.evaluateOnNewDocument((synth) => {
      window.__SYNTH = synth;
      window.__SYNTH_HITS = { opensky: 0, mil: 0 };
      window.__SYNTH_WITHHOLD = new Set();
      const realFetch = window.fetch.bind(window);
      const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const url = new URL(raw, window.location.href);
        const own = url.origin === window.location.origin;
        const now = Math.floor(Date.now() / 1000);
        if (own && url.pathname === '/api/opensky') {
          window.__SYNTH_HITS.opensky++;
          const states = window.__SYNTH.flights
            .filter((f) => !window.__SYNTH_WITHHOLD.has(f.icao))
            .map((f) => [f.icao, f.callsign, 'Synthetica', now, now, f.lon, f.lat, f.alt, f.onGround === true,
              f.vel, f.track, 0, null, null, null, false, 0]);
          return Promise.resolve(json({ time: now, states }));
        }
        if (own && url.pathname === '/api/adsblol/mil') {
          window.__SYNTH_HITS.mil++;
          const ac = window.__SYNTH.military
            .filter((m) => !window.__SYNTH_WITHHOLD.has(m.hex))
            .map((m) => ({
              hex: m.hex, flight: m.flight, lon: m.lon, lat: m.lat, alt_baro: m.altFt, track: m.track,
              gs: m.gsKt, t: m.t, r: m.r, ownOp: 'SYNTH AF', seen_pos: 0,
            }));
          return Promise.resolve(json({ msg: 'No error', now: Date.now(), ac }));
        }
        if (own && url.pathname === '/api/opensky-track') return Promise.resolve(json({ path: [] }));
        if (own && url.pathname === '/api/adsblol/trace') return Promise.resolve(json({ timestamp: now, trace: [] }));
        if (own && /^\/api\/adsbdb\/(?:type|route)\/[^/]+$/.test(url.pathname)) return Promise.resolve(json({}));
        if (own && url.pathname === '/api/openai/hud-summary') return Promise.resolve(json({ summary: 'QA' }));
        return realFetch(input, init);
      };
    }, SYNTH);

    console.log('Loading app...');
    await openApp(page, APP_URL);

    // ── 0. INIT CLEAN ────────────────────────────────────────────────────
    console.log('\n0 — init clean');
    const layers = await page.evaluate(() => [...window.__godsEyeView.dataManager.layers.keys()]);
    check('flights + military layers registered', layers.includes('flights') && layers.includes('military'), `${layers.length} layers`);
    check('no page/console errors during boot', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');

    await setCamera(page, { lat: -25.44, lon: -49.27, alt: 60_000 });
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('flights', true, { origin: 'user' });
      await dm.setEnabled('military', true, { origin: 'user' });
    });
    const ingested = await waitFor(page, () => {
      const dm = window.__godsEyeView.dataManager;
      const f = dm.layers.get('flights')?.module;
      const m = dm.layers.get('military')?.module;
      return ['aaa001', 'aaa002', 'aaa003', 'aaa004', 'aaa005'].every((id) => f?.hasContact?.(id))
        && ['bbb101', 'bbb102'].every((id) => m?.hasContact?.(id));
    }, 60_000);
    check('both layers ingest the synthetic planes', ingested,
      JSON.stringify(await page.evaluate(() => window.__SYNTH_HITS)));
    if (!ingested) return;

    // ── 1. NO JITTER ─────────────────────────────────────────────────────
    console.log('\n1 — no jitter (target / marker / detection agree every frame)');
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('flights').module.trackById('aaa001', { origin: 'user' }));
    await waitFor(page, () => window.__godsEyeView.engine.trackedTarget?.icao24 === 'aaa001' && !window.__godsEyeView.engine.isMoving(), 20_000);
    await sleep(1500);
    const jitter = await page.evaluate(() => new Promise((resolve) => {
      const { engine, dataManager } = window.__godsEyeView;
      const flights = dataManager.layers.get('flights').module;
      const rows = [];
      const frame = () => {
        const target = engine.trackedTarget;
        const pos = target?.getPosition?.();
        const det = flights.getDetectableObjects({}).find((o) => o.sourceId === 'aaa001');
        const icon = document.querySelector('.dg-flight-tracked-icon');
        const rect = icon?.getBoundingClientRect();
        const containerRect = engine.container.getBoundingClientRect();
        const proj = pos ? engine.project(pos.lon, pos.lat) : null;
        const center = engine.map.getCenter();
        rows.push({
          detDeg: pos && det ? Math.hypot(det.position.lon - pos.lon, det.position.lat - pos.lat) : null,
          markerPx: rect && proj
            ? Math.hypot(rect.left + rect.width / 2 - containerRect.left - proj.x, rect.top + rect.height / 2 - containerRect.top - proj.y)
            : null,
          centerDeg: pos ? Math.hypot(center.lng - pos.lon, center.lat - pos.lat) : null,
        });
        if (rows.length < 40) requestAnimationFrame(frame); else resolve(rows);
      };
      requestAnimationFrame(frame);
    }));
    const finite = (xs) => xs.filter((x) => Number.isFinite(x));
    const maxOf = (xs) => (finite(xs).length ? Math.max(...finite(xs)) : Infinity);
    const detMax = maxOf(jitter.map((r) => r.detDeg));
    const markerMax = maxOf(jitter.map((r) => r.markerPx));
    const centerMax = maxOf(jitter.map((r) => r.centerDeg));
    check('detection position == tracked position on every frame', detMax < 1e-6, `max Δ ${detMax.toExponential(2)}°`);
    check('tracked icon marker sits on the projected target (≤ 2 px)', markerMax <= 2, `max ${markerMax.toFixed(2)} px over ${jitter.length} frames`);
    check('map centre follows the target (≤ 0.01°)', centerMax <= 0.01, `max ${centerMax.toFixed(5)}°`);

    // ── 2. NO PULL-OUT ───────────────────────────────────────────────────
    console.log('\n2 — no pull-out on A → B');
    const altA = (await page.evaluate(() => window.__godsEyeView.engine.getCameraView())).alt;
    const altTrace = await page.evaluate(() => new Promise((resolve) => {
      const { engine, dataManager } = window.__godsEyeView;
      const alts = [];
      const t0 = performance.now();
      const frame = () => {
        alts.push(engine.getCameraView().alt);
        if (performance.now() - t0 < 4000) requestAnimationFrame(frame); else resolve(alts);
      };
      dataManager.layers.get('flights').module.trackById('aaa002', { origin: 'user' });
      requestAnimationFrame(frame);
    }));
    const peak = Math.max(...altTrace);
    const trackedB = await page.evaluate(() => window.__godsEyeView.engine.trackedTarget?.icao24);
    check('switch A → B tracks B', trackedB === 'aaa002', String(trackedB));
    check('camera stays in the follow band during the switch (peak ≤ 2× start, ≤ 200 km)',
      peak <= Math.max(2 * altA, 5000) && peak <= 200_000, `start ${Math.round(altA)} m, peak ${Math.round(peak)} m`);

    // ── 3. NO CROSS-LAYER ORPHAN ─────────────────────────────────────────
    console.log('\n3 — no cross-layer orphan');
    const cross = await page.evaluate(async () => {
      const { engine, dataManager } = window.__godsEyeView;
      const f = dataManager.layers.get('flights').module;
      const m = dataManager.layers.get('military').module;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const milOk = m.trackById('bbb101', { origin: 'user' });
      await wait(800);
      const afterMil = { flights: f.getTrackedInfo()?.icao24 ?? null, military: m.getTrackedInfo() ? 'bbb101' : null, engine: engine.trackedTarget?.layerId ?? null };
      f.trackById('aaa003', { origin: 'user' });
      await wait(800);
      const afterCom = { flights: f.getTrackedInfo()?.icao24 ?? null, military: m.getTrackedInfo() ? 'tracked' : null, engine: engine.trackedTarget?.layerId ?? null };
      return { milOk, afterMil, afterCom };
    });
    if (!cross.milOk) {
      skip('military → commercial clears military', `military.trackById returned ${cross.milOk}`);
    } else {
      check('commercial → military clears the commercial layer', cross.afterMil.flights === null && cross.afterMil.military === 'bbb101', JSON.stringify(cross.afterMil));
      check('military → commercial clears the military layer', cross.afterCom.military === null && cross.afterCom.flights === 'aaa003', JSON.stringify(cross.afterCom));
    }

    // ── H1. CLICK OWN PLANE ──────────────────────────────────────────────
    console.log('\nH1 — clicking the tracked plane is a no-op');
    await waitFor(page, () => !window.__godsEyeView.engine.isMoving(), 10_000);
    await sleep(800);
    const iconPoint = await page.evaluate(() => {
      const r = document.querySelector('.dg-flight-tracked-icon')?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (!iconPoint) {
      check('tracked icon marker present', false);
    } else {
      const before = await page.evaluate(() => window.__godsEyeView.engine.getCameraView().alt);
      await page.mouse.click(iconPoint.x, iconPoint.y);
      await sleep(900);
      const after = await page.evaluate(() => ({
        tracked: window.__godsEyeView.dataManager.layers.get('flights').module.getTrackedInfo()?.icao24 ?? null,
        alt: window.__godsEyeView.engine.getCameraView().alt,
      }));
      check('click on own tracked plane keeps tracking and camera altitude', after.tracked === 'aaa003' && Math.abs(after.alt - before) < 1,
        JSON.stringify({ before, ...after }));
    }

    // ── L. LANDING GHOST ─────────────────────────────────────────────────
    console.log('\nL — landing ghost vs cruise grace');
    const ghost = await page.evaluate(async () => {
      const { engine, dataManager } = window.__godsEyeView;
      const f = dataManager.layers.get('flights').module;
      // A plane only counts as "landed" after it was seen airborne: fly it in
      // high first, then drop it to the landed profile.
      const synthLnd = window.__SYNTH.flights.find((p) => p.icao === 'aaa004');
      synthLnd.alt = 3000; synthLnd.vel = 120;
      await f.update(engine);
      synthLnd.alt = 60; synthLnd.vel = 20;
      await f.update(engine);
      window.__SYNTH_WITHHOLD.add('aaa004');
      window.__SYNTH_WITHHOLD.add('aaa005');
      await f.update(engine);
      const oneMiss = { landed: f.hasContact('aaa004'), cruise: f.hasContact('aaa005') };
      await f.update(engine);
      await f.update(engine);
      const threeMiss = { cruise: f.hasContact('aaa005') };
      await f.update(engine);
      const fourMiss = { cruise: f.hasContact('aaa005') };
      window.__SYNTH_WITHHOLD.delete('aaa004');
      window.__SYNTH_WITHHOLD.delete('aaa005');
      await f.update(engine);
      return { oneMiss, threeMiss, fourMiss };
    });
    check('landed plane is removed after ONE missed poll', ghost.oneMiss.landed === false, JSON.stringify(ghost.oneMiss));
    check('cruise plane survives the grace, then is removed', ghost.oneMiss.cruise === true && ghost.fourMiss.cruise === false,
      JSON.stringify(ghost));

    // ── M3. AGE-OUT RELEASE ──────────────────────────────────────────────
    console.log('\nM3 — age-out: STALE coast, then release in place');
    const ageOut = await page.evaluate(async () => {
      const { engine, dataManager } = window.__godsEyeView;
      const f = dataManager.layers.get('flights').module;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      f.trackById('aaa003', { origin: 'user' });
      await wait(1500);
      window.__SYNTH_WITHHOLD.add('aaa003');
      await f.update(engine);
      await wait(1000); // the card is rewritten by the marker's next frame
      // The military layer draws its own `.dg-flight-card`; read this plane's.
      const card = [...document.querySelectorAll('.dg-flight-card')]
        .map((el) => el.textContent || '').find((text) => text.includes('SYN003')) || '';
      const coasting = { tracked: f.getTrackedInfo()?.icao24 ?? null, stale: /STALE/.test(card) };
      const before = engine.getCameraView();
      await f.update(engine);
      await f.update(engine);
      await f.update(engine);
      await wait(1200);
      const after = engine.getCameraView();
      window.__SYNTH_WITHHOLD.delete('aaa003');
      await f.update(engine);
      await wait(300);
      const back = f.hasContact('aaa003');
      const cardBack = document.querySelector('.dg-flight-card');
      return {
        coasting,
        released: { tracked: f.getTrackedInfo(), engine: engine.trackedTarget ? engine.trackedTarget.layerId : null },
        altJump: Math.abs(after.alt - before.alt),
        centerMove: Math.hypot(after.targetLat - before.targetLat, after.targetLon - before.targetLon),
        back,
        cardGone: !cardBack || getComputedStyle(cardBack).display === 'none' || !cardBack.isConnected,
      };
    });
    check('tracked plane coasts with a STALE card after one missed poll', ageOut.coasting.tracked === 'aaa003' && ageOut.coasting.stale, JSON.stringify(ageOut.coasting));
    check('after the grace tracking clears (layer and engine)', ageOut.released.tracked === null && ageOut.released.engine === null, JSON.stringify(ageOut.released));
    check('camera released in place (no altitude jump, centre ≤ 0.05°)', ageOut.altJump < 1 && ageOut.centerMove <= 0.05,
      `Δalt ${ageOut.altJump.toFixed(1)} m, Δcentre ${ageOut.centerMove.toFixed(4)}°`);
    check('plane comes back when fixes resume', ageOut.back === true);

    // ── E. ESC RELEASE ───────────────────────────────────────────────────
    console.log('\nE — Esc releases in place');
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('flights').module.trackById('aaa001', { origin: 'user' }));
    await waitFor(page, () => window.__godsEyeView.engine.trackedTarget?.icao24 === 'aaa001' && !window.__godsEyeView.engine.isMoving(), 20_000);
    await sleep(600);
    const escBefore = await page.evaluate(() => window.__godsEyeView.engine.getCameraView().alt);
    await page.keyboard.press('Escape');
    await sleep(600);
    const esc = await page.evaluate(() => ({
      tracked: window.__godsEyeView.dataManager.layers.get('flights').module.getTrackedInfo(),
      engine: window.__godsEyeView.engine.trackedTarget,
      alt: window.__godsEyeView.engine.getCameraView().alt,
    }));
    check('Esc clears tracking without moving the camera', esc.tracked === null && !esc.engine && Math.abs(esc.alt - escBefore) < 1,
      `Δalt ${(esc.alt - escBefore).toFixed(1)} m`);

    check('no page/console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
  } finally {
    if (!hasFlag('--keep-open')) await browser.close();
  }
}

/** Polls a page predicate until true or timeout. */
async function waitFor(page, predicate, timeoutMs) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 });
    return true;
  } catch {
    return false;
  }
}

main()
  .then(() => report.finish())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
