#!/usr/bin/env node
/**
 * qa-distribuicao — liga a camada de linhas de distribuição sobre Curitiba e
 * confere que as células carregam, os primitives ficam prontos, a camada some
 * acima do teto de altura e o disable esconde tudo. Salva screenshot.
 *
 * Uso: node scripts/qa-distribuicao.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-distribuicao.png');
const LAYER_ID = 'datageo-distribuicao';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--window-size=1440,900', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (/datageo-distribuicao/.test(m.text())) console.log('   console:', m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);

  const setView = (height) => page.evaluate((h) => {
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: window.Cesium
        ? window.Cesium.Cartesian3.fromDegrees(-49.27, -25.45, h)
        : v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: -49.27 * Math.PI / 180, latitude: -25.45 * Math.PI / 180, height: h,
        }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, height);

  await setView(30_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const loaded = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    const mod = gev.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      const root = [...Array(gev.viewer.scene.groundPrimitives.length).keys()]
        .map((i) => gev.viewer.scene.groundPrimitives.get(i));
      let pending = 0; let prims = 0;
      const walk = (c) => {
        for (let i = 0; i < (c.length ?? 0); i++) {
          const p = c.get(i);
          if (p instanceof Object && typeof p.length === 'number' && typeof p.get === 'function') walk(p);
          else if (p?.geometryInstances !== undefined || 'ready' in (p ?? {})) { prims++; if (!p.ready) pending++; }
        }
      };
      root.forEach((c) => { if (c && typeof c.get === 'function') walk(c); });
      if (stats.count > 0 && pending === 0 && prims > 0) {
        return { ms: Math.round(performance.now() - t0), count: stats.count, prims, error: stats.error };
      }
      gev.viewer.scene.requestRender?.();
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('células carregadas e primitives prontos em Curitiba', !loaded.timedOut && loaded.count > 10_000, loaded);
  await sleep(2_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  await setView(400_000);
  await sleep(1_500);
  const hiddenHigh = await page.evaluate(() => {
    const gp = window.__godsEyeView.viewer.scene.groundPrimitives;
    const shows = [];
    for (let i = 0; i < gp.length; i++) shows.push(gp.get(i).show);
    return shows;
  });
  check('acima do teto a coleção fica oculta', hiddenHigh.includes(false), hiddenHigh);

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-distribuicao: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
