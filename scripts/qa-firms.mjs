#!/usr/bin/env node
/**
 * qa-firms.mjs — headless proof for the fires layer (`local-firms`) on the
 * MapLibre engine (src/maplibre/layers/contextoGev.js).
 *
 * The layer reads the DataGeo PR Supabase table `fire_spots`
 * (fetchFiresPayload in src/data/datageoClient.js — NASA FIRMS detections
 * ingested by the DataGeo ETL). The run is deterministic: the Supabase REST
 * request is answered in-page (fetch shim) with synthetic detections, so it
 * needs no session, no key and no live data.
 *
 *   (i)   FEED DOWN — /rest/v1/fire_spots answers 503: the layer reports an
 *         error, draws zero fires and the page does not crash.
 *   (ii)  LOAD — synthetic detections load; stats count and the panel legend
 *         (alta/média/baixa) add up to the payload.
 *   (iii) LOD — far away the fires are an aggregated heatmap with cell cards;
 *         close in they are individual glows with their own cards.
 *   (iv)  ACTION — clicking a fire selects exactly that detection (selection
 *         ring + full card) and centres the map on it; a click on empty map
 *         clears the selection.
 *
 * The Cesium-era checks of the /api/firms proxy (key telemetry, KEY REQUIRED,
 * STALE payloads, world-overlay canvas cards) went away with that layer; see
 * scripts/APOSENTADOS.md.
 *
 * Run:  node scripts/qa-firms.mjs --url http://localhost:4400 [--headful]
 * Screenshots go to qa-shots/firms/ (gitignored). Exits non-zero on any FAIL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_APP_URL, argValue, createReport, hasFlag, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
  zoomGatedLayers,
} from './lib/qaBrowser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'firms');
const APP_URL = argValue('--url', DEFAULT_APP_URL);
const HEADFUL = hasFlag('--headful');
const LAYER_ID = 'local-firms';

/** Synthetic fire_spots rows: a cluster west of Guarapuava plus scattered fires. */
function syntheticRows() {
  const now = new Date(Date.now() - 90 * 60_000);
  const acqDate = now.toISOString().slice(0, 10);
  const acqTime = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const rows = [];
  const confidences = ['h', 'n', 'l'];
  for (let i = 0; i < 60; i++) {
    rows.push({
      latitude: -25.40 + (i % 8) * 0.012,
      longitude: -51.80 + Math.floor(i / 8) * 0.012,
      brightness: 320 + (i % 30),
      acq_date: acqDate,
      acq_time: acqTime,
      satellite: 'N20',
      instrument: 'VIIRS',
      confidence: confidences[i % 3],
      municipality: 'Guarapuava',
    });
  }
  for (let i = 0; i < 40; i++) {
    rows.push({
      latitude: -23.0 - (i % 10) * 0.35,
      longitude: -53.8 + Math.floor(i / 10) * 1.2,
      brightness: 310,
      acq_date: acqDate,
      acq_time: acqTime,
      satellite: 'N',
      instrument: 'VIIRS',
      confidence: confidences[i % 3],
      municipality: 'Oeste',
    });
  }
  return rows;
}
const ROWS = syntheticRows();

const { check, finish } = createReport('qa-firms');

async function openWith(mode) {
  const session = await launchQaBrowser({ headful: HEADFUL, viewport: { width: 1280, height: 800 } });
  const { page } = session;
  // In-page fetch shim (installed before app code): answering the Supabase
  // REST call inside the page avoids the cross-origin preflight a network
  // interception would have to fake.
  await page.evaluateOnNewDocument((feedMode, rows) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (raw && new URL(raw, window.location.href).pathname.endsWith('/rest/v1/fire_spots')) {
        if (feedMode === 'down') {
          return Promise.resolve(new Response('{"message":"QA outage"}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${rows.length - 1}/${rows.length}` },
        }));
      }
      return realFetch(input, init);
    };
  }, mode, ROWS);
  await openApp(page, APP_URL);
  await setCamera(page, { lat: -24.7, lon: -51.6, alt: 3_000_000 });
  const stats = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    await dm.setEnabled(id, true, { origin: 'user' });
    const mod = dm.layers.get(id).module;
    let s = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      s = mod.getStats();
      if ((s.count > 0 || s.error) && !s.loading) break;
    }
    return s;
  }, LAYER_ID);
  return { ...session, stats };
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // ── (i) FEED DOWN ────────────────────────────────────────────────────
  console.log('\n(i) feed down');
  {
    const { browser, page, errors, stats } = await openWith('down');
    try {
      check('outage surfaces as a layer error with zero fires', Boolean(stats?.error) && !(stats?.count > 0), stats);
      check('no page error during the outage', !errors.some((e) => e.startsWith('[pageerror]')), errors.slice(0, 3));
    } finally {
      await browser.close();
    }
  }

  // ── (ii)–(iv) with synthetic detections ──────────────────────────────
  const { browser, page, errors, stats } = await openWith('ok');
  try {
    console.log('\n(ii) load');
    check('synthetic detections load with no error', stats?.count === ROWS.length && !stats?.error, stats);
    const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module
      .getRowControls?.()?.legend ?? [], LAYER_ID);
    const legendSum = legend.reduce((t, e) => t + (e.count || 0), 0);
    check('panel legend (alta/média/baixa) adds up to the payload', legend.length === 3 && legendSum === ROWS.length,
      { legend, legendSum });

    console.log('\n(iii) level of detail');
    await waitMapIdle(page);
    const far = await zoomGatedLayers(page, '^dg-firms-');
    const farCards = await page.evaluate(() => {
      const { map } = window.__godsEyeView.engine;
      const ids = ['dg-firms-cells2-label', 'dg-firms-cells1-label'].filter((id) => map.getLayer(id));
      return map.queryRenderedFeatures({ layers: ids }).length;
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'far.png') });
    check('far: heatmap on, individual glows gated out', far.shown.includes('dg-firms-heat') && far.gated.includes('dg-firms-glow'), far);
    check('far: aggregated cell cards are drawn', farCards > 0, { farCards });

    await setCamera(page, { lat: -25.36, lon: -51.76, alt: 60_000 });
    await waitMapIdle(page);
    await sleep(800);
    const near = await zoomGatedLayers(page, '^dg-firms-');
    const nearCounts = await page.evaluate(() => {
      const { map } = window.__godsEyeView.engine;
      const count = (id) => (map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : -1);
      return { glow: count('dg-firms-glow'), cards: count('dg-firms-label') };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'near.png') });
    check('near: individual glows on, heatmap faded out', near.shown.includes('dg-firms-glow') && near.gated.includes('dg-firms-heat'), near);
    check('near: glows and per-detection cards are drawn', nearCounts.glow > 0 && nearCounts.cards > 0, nearCounts);

    console.log('\n(iv) action');
    const target = await page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      const feats = engine.map.queryRenderedFeatures({ layers: ['dg-firms-glow'] });
      const { clientWidth: w, clientHeight: h } = engine.container;
      let best = null;
      for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates;
        const p = engine.project(lon, lat);
        const d = Math.hypot(p.x - w / 2, p.y - h / 2);
        if (!best || d < best.d) best = { d, lon, lat, key: f.properties.key, x: p.x, y: p.y };
      }
      const r = engine.container.getBoundingClientRect();
      return best && { ...best, x: best.x + r.left, y: best.y + r.top };
    });
    if (!target) {
      check('a fire is clickable on screen', false);
    } else {
      // Nudge the camera off the fire so the centring is observable.
      await setCamera(page, { lat: target.lat - 0.05, lon: target.lon - 0.05, alt: 60_000 });
      await waitMapIdle(page);
      const pt = await page.evaluate((lo, la) => {
        const { engine } = window.__godsEyeView;
        const p = engine.project(lo, la);
        const r = engine.container.getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      }, target.lon, target.lat);
      await page.mouse.click(pt.x, pt.y);
      await sleep(1_200);
      const selected = await page.evaluate(async () => {
        const { map } = window.__godsEyeView.engine;
        const data = await map.getSource('dg-firms-sel')?.getData?.();
        const c = map.getCenter();
        return { keys: (data?.features ?? []).map((f) => f.properties.key), center: [c.lng, c.lat] };
      });
      await page.screenshot({ path: path.join(SHOTS_DIR, 'selected.png') });
      check('click selects exactly the clicked detection', selected.keys.length === 1 && selected.keys[0] === target.key,
        { want: target.key, got: selected.keys });
      check('the map centres on the selected fire (≤ 0.01°)',
        Math.hypot(selected.center[0] - target.lon, selected.center[1] - target.lat) <= 0.01, selected.center);

      // Empty-map click clears it (top-left corner of the map, away from the cluster).
      const empty = await page.evaluate(() => {
        const r = window.__godsEyeView.engine.container.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height - 60 };
      });
      await page.mouse.click(empty.x, empty.y);
      await sleep(600);
      const cleared = await page.evaluate(async () => {
        const data = await window.__godsEyeView.engine.map.getSource('dg-firms-sel')?.getData?.();
        return data?.features?.length ?? -1;
      });
      check('a click on empty map clears the selection', cleared === 0, { cleared });
    }
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
