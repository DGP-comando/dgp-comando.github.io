#!/usr/bin/env node
/**
 * qa-estradas-conveniadas — confere a camada Estradas Rurais Conveniadas:
 *   1. os três conjuntos carregam e a linha do painel ganha os três chips;
 *   2. o chip esconde e mostra só o seu conjunto;
 *   3. o hover numa conveniada mostra o tooltip com município e valores.
 *
 * Uso: node scripts/qa-estradas-conveniadas.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-estradas-conveniadas.png');
const LAYER_ID = 'datageo-estradas-conveniadas';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--window-size=1440,900',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});

const setView = (page, lon, lat, height) => page.evaluate((lo, la, h) => {
  const v = window.__godsEyeView.viewer;
  v.camera.cancelFlight();
  v.camera.setView({
    destination: v.scene.globe.ellipsoid.cartographicToCartesian({
      longitude: lo * Math.PI / 180, latitude: la * Math.PI / 180, height: h,
    }),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}, lon, lat, height);

const shows = (page) => page.evaluate((id) => Object.fromEntries(
  ['conveniadas', 'protocolos', 'automatizado'].map((g) => [
    g, window.__godsEyeView.viewer.dataSources.getByName(`${id}:${g}`)[0]?.show,
  ]),
), LAYER_ID);

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);
  await page.keyboard.press('Escape'); // tutorial de primeira visita cobre o mapa
  await sleep(500);

  await setView(page, -51.4, -24.6, 900_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
  const stats = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      const s = mod?.getStats?.() ?? {};
      if (s.count > 0) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true };
  }, LAYER_ID);
  check('trechos carregam', stats.count >= 900, stats);

  const chips = await page.$$eval(`[data-layer-id="${LAYER_ID}"] .data-toggle-chip`,
    (els) => els.map((e) => ({ id: e.dataset.chipId, on: e.getAttribute('aria-pressed') })));
  check('três chips na linha do painel', chips.length === 3, chips);
  check('três conjuntos visíveis', Object.values(await shows(page)).every(Boolean), await shows(page));
  await sleep(3_000);
  await page.screenshot({ path: shot.replace(/\.png$/, '-estado.png') });

  await page.evaluate((id) => window.__godsEyeView.dataManager.setLayerParams(id, { protocolos: false }, { origin: 'user' }), LAYER_ID);
  const s1 = await shows(page);
  check('chip esconde só os protocolos', s1.conveniadas && !s1.protocolos && s1.automatizado, s1);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setLayerParams(id, { protocolos: true }, { origin: 'user' }), LAYER_ID);
  check('e mostra de novo', (await shows(page)).protocolos, await shows(page));

  // Hover real numa conveniada, de perto.
  const alvo = await page.evaluate((id) => {
    const ds = window.__godsEyeView.viewer.dataSources.getByName(`${id}:conveniadas`)[0];
    const e = ds.entities.values[0];
    const pos = e.polyline.positions.getValue();
    const c = window.Cesium?.Cartographic?.fromCartesian?.(pos[Math.floor(pos.length / 2)])
      ?? window.__godsEyeView.viewer.scene.globe.ellipsoid.cartesianToCartographic(pos[Math.floor(pos.length / 2)]);
    return { lon: c.longitude * 180 / Math.PI, lat: c.latitude * 180 / Math.PI };
  }, LAYER_ID);
  await setView(page, alvo.lon, alvo.lat, 4_000);
  await sleep(6_000);
  const box = await page.evaluate(() => {
    const r = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  let html = '';
  for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [4, 4], [-4, -4]]) {
    await page.mouse.move(box.x + dx, box.y + dy);
    await sleep(700);
    html = await page.evaluate(() => [...document.querySelectorAll('.datageo-entity-tooltip')]
      .find((el) => el.style.display !== 'none')?.textContent ?? '');
    if (/Conveniadas 2026/.test(html)) break;
  }
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);
  check('hover mostra o tooltip da conveniada', /Conveniadas 2026/.test(html) && /Valor global/.test(html),
    html.slice(0, 160));
  check('tooltip sem CNPJ', !/CNPJ/.test(html));
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-estradas-conveniadas: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
