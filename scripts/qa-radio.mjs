#!/usr/bin/env node
/**
 * Deterministic browser proof for the Radio companion layer on the MapLibre
 * engine (src/data/radio.js: GeoJSON source `dg-radio` with native clusters,
 * symbol labels and a selection bracket).
 *
 * Intercepts only `/api/radio/*` with a 750-station fixture and stubs the
 * browser media `play()` primitive. It proves:
 *   - the launcher discloses compact controls without changing power, and
 *     enabling loads the whole catalog without autoplay;
 *   - stations render on the map as points and clusters, and the category
 *     filter changes what is drawn;
 *   - a real click on a station marker selects it and starts playback (the
 *     direct user action), without moving the camera;
 *   - programmatic selection never autoplays; Play is explicit;
 *   - disabling the layer stops the audio and clears the markers;
 *   - a shared-link restore brings the Radio state back without autoplay;
 *   - the Context host keeps Radio contained on desktop and mobile widths;
 *   - a clean console.
 * The Cesium harness also pinned the world-overlay label allocator, the
 * EntityCluster/horizon culling internals and the Earth-disc recentring,
 * which do not exist on MapLibre (see scripts/APOSENTADOS.md).
 * Screenshots are written under the gitignored `qa-shots/radio/`.
 *
 * Run: node scripts/qa-radio.mjs --url http://localhost:4400
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUrl, launchQaBrowser } from './lib/qaBrowser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'radio');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const APP_ORIGIN = new URL(APP_URL).origin;
const HEADFUL = args.includes('--headful');

const tags = [
  'news', 'talk', 'weather,emergency', 'public safety,scanner',
  'aviation,atc', 'marine,maritime', 'traffic,transit',
  'music,jazz', 'music,rock', 'community',
];
const stations = Array.from({ length: 750 }, (_, index) => {
  const row = Math.floor(index / 30);
  const column = index % 30;
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: index === 360
      ? '100.3 The River - WQRV - Meridianville/Huntsville, AL'
      : index === 390
        ? 'La Zeta (Hermosillo) - 93.9 FM - XHHY - Uniradio - Hermosillo, Sonora'
        : `QA Radio ${String(index + 1).padStart(3, '0')}`,
    lat: -72 + row * 6,
    lon: -174 + column * 12,
    streamUrl: `https://audio.example.test/${index}.mp3`,
    homepage: `https://station.example.test/${index}`,
    tags: tags[index % tags.length].split(','),
    languages: index === 360 ? ['Spanish'] : ['English'],
    state: `Region ${row + 1}`,
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: index % 2 ? 'AAC' : 'MP3',
    bitrate: 128,
  };
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rendered radio features on screen: {points, clusters, labels}. */
const renderedRadio = (page) => page.evaluate(() => {
  const { map } = window.__godsEyeView.engine;
  const count = (id) => (map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : 0);
  return {
    points: count('dg-radio-point'),
    clusters: count('dg-radio-cluster'),
    labels: count('dg-radio-label') + count('dg-radio-cluster-label'),
  };
});
const radioState = (page) => page.evaluate(() => {
  const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
  return {
    enabled: state.enabled,
    stationCount: state.stationCount,
    filter: state.filter,
    filteredCount: state.filteredCount,
    selected: state.selected?.id || null,
    audioState: state.audioState,
    playingStationId: state.playingStationId,
    plays: window.__qaRadioPlayCalls.length,
  };
});

async function installInterception(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN && url.pathname === '/api/radio/stations') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stations,
          updatedAt: new Date().toISOString(),
          stale: false,
          degraded: false,
          acceptedGeneration: 1,
          catalogInstance: 'qa-harness-instance',
        }),
      });
      return;
    }
    if (url.origin === APP_ORIGIN && /^\/api\/radio\/click\/[^/]+$/.test(url.pathname)) {
      request.respond({ status: 204 });
      return;
    }
    if (url.origin === APP_ORIGIN && url.pathname === '/api/openai/hud-summary') {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: 'QA globe ready' }) });
      return;
    }
    request.continue();
  });
}

async function boot(page, hash = '') {
  await page.goto(appUrl(APP_URL, { hash }), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => window.__godsEyeView?.engine && window.__godsEyeView?.dataManager?.layers?.has('radio'), { timeout: 120_000 });
  await page.evaluate(() => window.__godsEyeView.engine.ready);
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  ).catch(() => {});
  await page.keyboard.press('Escape'); // first-run tutorial
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const { browser, page, errors } = await launchQaBrowser({
    headful: HEADFUL,
    viewport: { width: 1440, height: 900 },
    extraArgs: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    await page.evaluateOnNewDocument(() => {
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextPlay = false;
      window.__qaRadioDelayNextFailure = false;
      window.__qaRadioFailNextPlay = false;
      HTMLMediaElement.prototype.play = function play() {
        window.__qaRadioPlayCalls.push(this.src);
        if (window.__qaRadioDelayNextPlay) {
          window.__qaRadioDelayNextPlay = false;
          return new Promise((resolve) => {
            window.__qaReleaseRadioPlay = () => {
              this.dispatchEvent(new Event('playing'));
              resolve();
              delete window.__qaReleaseRadioPlay;
            };
          });
        }
        if (window.__qaRadioDelayNextFailure) {
          window.__qaRadioDelayNextFailure = false;
          return new Promise((resolve, reject) => {
            window.__qaRejectRadioPlay = () => {
              reject(new DOMException('QA delayed broadcaster failure', 'NotSupportedError'));
              delete window.__qaRejectRadioPlay;
            };
          });
        }
        if (window.__qaRadioFailNextPlay) {
          window.__qaRadioFailNextPlay = false;
          return Promise.reject(new DOMException('QA silent broadcaster', 'NotSupportedError'));
        }
        if (this.src.endsWith('/330.mp3') && !window.__qaRadioFailedNearest) {
          window.__qaRadioFailedNearest = true;
          return Promise.reject(new DOMException('QA broadcaster unavailable', 'NotSupportedError'));
        }
        queueMicrotask(() => this.dispatchEvent(new Event('playing')));
        return Promise.resolve();
      };
    });
    await installInterception(page);
    await boot(page);
    await page.evaluate(() => {
      const { engine, styleManager } = window.__godsEyeView;
      engine.cancelFlight();
      for (const id of ['pp-toggles', 'cctv-panel', 'radio-panel', 'global-context-panel']) {
        styleManager.setPanelCollapsed(id, true);
      }
      engine.setCameraView({ lat: 6, lon: -12, alt: 18_000_000, heading: 0, pitch: -90, roll: 0 });
    });

    // ── launcher + enable ──────────────────────────────────────────────
    const disclosure = await page.evaluate(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      const mini = document.getElementById('context-radio-mini');
      const enabledBefore = window.__godsEyeView.dataManager.isEnabled('radio');
      button?.click();
      return {
        present: Boolean(button && mini),
        enabledBefore,
        enabledAfterDisclosure: window.__godsEyeView.dataManager.isEnabled('radio'),
        expanded: button?.getAttribute('aria-expanded'),
        miniHidden: mini?.hidden,
      };
    });
    check('Radio launcher discloses compact controls without changing power',
      disclosure.present && !disclosure.enabledBefore && !disclosure.enabledAfterDisclosure
        && disclosure.expanded === 'true' && !disclosure.miniHidden,
      JSON.stringify(disclosure));
    const enableStartedAt = Date.now();
    await page.$eval('#context-radio-mini-enable-btn', (button) => button.click());
    await page.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.enabled && !state.loading && state.stationCount === 750;
    }, { timeout: 60_000 });
    const enableElapsedMs = Date.now() - enableStartedAt;
    const initial = await radioState(page);
    check('750-station catalog loads within the browser budget', initial.stationCount === 750 && enableElapsedMs < 8000, `${enableElapsedMs}ms`);
    check('enable does not autoplay', initial.plays === 0 && initial.audioState === 'stopped', JSON.stringify(initial));
    check('All is the initial Radio filter', initial.filter === 'all' && initial.filteredCount === 750, `${initial.filteredCount} stations`);
    const filterOptions = await page.evaluate(() => document.getElementById('radio-filter')?.options.length ?? 0);
    check('dynamic canonical and genre categories reach the UI', filterOptions >= 10, `${filterOptions} options`);

    // ── markers on the map ─────────────────────────────────────────────
    await page.evaluate(() => new Promise((resolve) => {
      const { map } = window.__godsEyeView.engine;
      const t = setTimeout(resolve, 15_000);
      map.once('idle', () => { clearTimeout(t); resolve(); });
      map.triggerRepaint();
    }));
    const globalView = await renderedRadio(page);
    check('stations render as clusters/points at the global view', globalView.clusters + globalView.points > 0, JSON.stringify(globalView));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'global.png') });

    const filtered = await page.evaluate(async () => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      module.setFilter('news');
      await new Promise((r) => setTimeout(r, 800));
      const state = module.getUIState();
      return { filter: state.filter, filteredCount: state.filteredCount };
    });
    check('the category filter narrows the drawn set', filtered.filter === 'news' && filtered.filteredCount > 0 && filtered.filteredCount < 750,
      JSON.stringify(filtered));
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.setFilter('all'));

    // ── programmatic selection never autoplays ─────────────────────────
    const programmatic = await page.evaluate(async () => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const id = module.getTunerStations(1)[0]?.id ?? null;
      const plays = window.__qaRadioPlayCalls.length;
      const ok = module.selectStation(id, { origin: 'programmatic' });
      await new Promise((r) => setTimeout(r, 400));
      const state = module.getUIState();
      return { ok, id, selected: state.selected?.id || null, audioState: state.audioState, playsDelta: window.__qaRadioPlayCalls.length - plays };
    });
    check('programmatic selection selects without playing', programmatic.ok && programmatic.selected === programmatic.id
      && programmatic.playsDelta === 0 && programmatic.audioState === 'stopped', JSON.stringify(programmatic));
    const explicitPlay = await page.evaluate(async () => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const plays = window.__qaRadioPlayCalls.length;
      document.getElementById('radio-play-btn')?.click();
      await new Promise((r) => setTimeout(r, 600));
      const state = module.getUIState();
      return { playsDelta: window.__qaRadioPlayCalls.length - plays, audioState: state.audioState };
    });
    check('Play is an explicit action that starts the selected stream', explicitPlay.playsDelta === 1 && explicitPlay.audioState === 'playing',
      JSON.stringify(explicitPlay));
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.stopPlayback({ origin: 'user' }));

    // ── a real click on a marker: select + play, camera stays ──────────
    await page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      // Close enough that single stations are points, not clusters.
      engine.setCameraView({ lat: 12, lon: -30, alt: 1_500_000, heading: 0, pitch: -90, roll: 0 });
    });
    await page.evaluate(() => new Promise((resolve) => {
      const { map } = window.__godsEyeView.engine;
      const t = setTimeout(resolve, 15_000);
      map.once('idle', () => { clearTimeout(t); resolve(); });
      map.triggerRepaint();
    }));
    const target = await page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      const feats = engine.map.getLayer('dg-radio-point') ? engine.map.queryRenderedFeatures({ layers: ['dg-radio-point'] }) : [];
      const { clientWidth: w, clientHeight: h } = engine.container;
      let best = null;
      for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates;
        const p = engine.project(lon, lat);
        if (!p) continue;
        const d = Math.hypot(p.x - w / 2, p.y - h / 2);
        if (!best || d < best.d) best = { d, id: f.properties.id, x: p.x, y: p.y };
      }
      const r = engine.container.getBoundingClientRect();
      return best && { id: best.id, x: best.x + r.left, y: best.y + r.top };
    });
    check('Radio exposes a visible station marker to click', Boolean(target?.id), JSON.stringify(target));
    if (target) {
      const camBefore = await page.evaluate(() => window.__godsEyeView.engine.getCameraView());
      const playsBefore = (await radioState(page)).plays;
      await page.mouse.click(target.x, target.y);
      await sleep(1_200);
      const clicked = await radioState(page);
      const camAfter = await page.evaluate(() => window.__godsEyeView.engine.getCameraView());
      await page.screenshot({ path: path.join(SHOTS_DIR, 'clicked.png') });
      check('first click on a station selects it', clicked.selected === target.id, `${clicked.selected} vs ${target.id}`);
      check('the click is the direct action that starts playback', clicked.plays - playsBefore >= 1 && clicked.playingStationId === target.id,
        JSON.stringify(clicked));
      check('selecting and playing never moves the camera',
        Math.abs(camAfter.alt - camBefore.alt) < 1 && Math.hypot(camAfter.lat - camBefore.lat, camAfter.lon - camBefore.lon) < 1e-6);
      const bracket = await page.evaluate(() => {
        const { map } = window.__godsEyeView.engine;
        return map.getLayer('dg-radio-sel-bracket') ? map.queryRenderedFeatures({ layers: ['dg-radio-sel-bracket'] }).length : 0;
      });
      check('the selected station carries its selection bracket', bracket > 0, `${bracket}`);
    }

    // ── disable stops audio and clears the markers ─────────────────────
    await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('radio', false, { origin: 'user' }));
    await sleep(800);
    const off = { state: await radioState(page), drawn: await renderedRadio(page) };
    check('disabling Radio stops the audio', off.state.audioState !== 'playing', JSON.stringify(off.state));
    check('disabling Radio clears every marker', off.drawn.points + off.drawn.clusters + off.drawn.labels === 0, JSON.stringify(off.drawn));

    // ── shared-link restore without autoplay ───────────────────────────
    await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('radio', true, { origin: 'user' }));
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().stationCount === 750, { timeout: 60_000 });
    // The share link is written on a debounce; wait until it carries the
    // Radio token (`r` in the `l=` layer list) before copying it.
    await page.waitForFunction(
      () => /(?:^#|&)l=[^&]*\br\b/.test(location.hash),
      { timeout: 10_000 },
    ).catch(() => {});
    const hash = await page.evaluate(() => location.hash.replace(/^#/, ''));
    const restorePage = await browser.newPage();
    await restorePage.setViewport({ width: 1440, height: 900 });
    await restorePage.evaluateOnNewDocument(() => {
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextPlay = false;
      window.__qaRadioDelayNextFailure = false;
      window.__qaRadioFailNextPlay = false;
      HTMLMediaElement.prototype.play = function play() {
        window.__qaRadioPlayCalls.push(this.src);
        if (window.__qaRadioDelayNextPlay) {
          window.__qaRadioDelayNextPlay = false;
          return new Promise((resolve) => {
            window.__qaReleaseRadioPlay = () => {
              this.dispatchEvent(new Event('playing'));
              resolve();
              delete window.__qaReleaseRadioPlay;
            };
          });
        }
        if (window.__qaRadioDelayNextFailure) {
          window.__qaRadioDelayNextFailure = false;
          return new Promise((resolve, reject) => {
            window.__qaRejectRadioPlay = () => {
              reject(new DOMException('QA delayed broadcaster failure', 'NotSupportedError'));
              delete window.__qaRejectRadioPlay;
            };
          });
        }
        if (window.__qaRadioFailNextPlay) {
          window.__qaRadioFailNextPlay = false;
          return Promise.reject(new DOMException('QA silent broadcaster', 'NotSupportedError'));
        }
        if (this.src.endsWith('/330.mp3') && !window.__qaRadioFailedNearest) {
          window.__qaRadioFailedNearest = true;
          return Promise.reject(new DOMException('QA broadcaster unavailable', 'NotSupportedError'));
        }
        queueMicrotask(() => this.dispatchEvent(new Event('playing')));
        return Promise.resolve();
      };
    });
    await installInterception(restorePage);
    await boot(restorePage, hash);
    await restorePage.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.enabled && state.stationCount === 750;
    }, { timeout: 60_000 }).catch(() => {});
    const restored = await radioState(restorePage);
    check('a shared link restores Radio on', restored.enabled && restored.stationCount === 750, `l=${new URLSearchParams(hash).get('l')} → ${JSON.stringify(restored)}`);
    check('restoration never autoplays', restored.plays === 0 && restored.audioState !== 'playing', JSON.stringify(restored));
    await restorePage.close();

    // ── Context host containment (desktop and mobile) ──────────────────
    const containment = async (width, height) => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        const { styleManager } = window.__godsEyeView;
        styleManager.setPanelCollapsed('global-context-panel', false, { explicit: true });
        styleManager.setPanelCollapsed('radio-panel', false, { explicit: true });
      });
      await sleep(600);
      return page.evaluate(() => {
        const context = document.getElementById('global-context-panel').getBoundingClientRect();
        const radio = document.getElementById('radio-panel').getBoundingClientRect();
        return {
          left: context.left, right: context.right, top: context.top, bottom: context.bottom,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          radioInside: radio.left >= context.left - 1 && radio.right <= context.right + 1,
        };
      });
    };
    const desktop = await containment(1440, 900);
    check('desktop Context host keeps Radio contained', desktop.left >= 0 && desktop.right <= desktop.viewportWidth
      && desktop.top >= 0 && desktop.bottom <= desktop.viewportHeight && desktop.radioInside, JSON.stringify(desktop));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'context-desktop.png') });
    const mobile = await containment(390, 844);
    check('mobile Context host keeps Radio contained', mobile.left >= 0 && mobile.right <= mobile.viewportWidth && mobile.radioInside,
      JSON.stringify(mobile));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'context-mobile.png') });

    check('console stays clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nqa-radio: ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
