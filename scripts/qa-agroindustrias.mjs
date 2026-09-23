#!/usr/bin/env node
/**
 * qa-agroindustrias — confere as duas camadas de agroindústrias:
 *   1. Agroindústrias (SIGSIF/OSM), cadastro IDR e Rotas turísticas carregam;
 *   2. o hover num ponto de cada uma abre o tooltip.
 *
 * Uso: node scripts/qa-agroindustrias.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-agroindustrias.png');
const CAMADAS = [
  { id: 'datageo-agroindustrias', min: 100, espera: /Fonte: (SIGSIF|OpenStreetMap)/ },
  { id: 'datageo-agroindustrias-idr', min: 1200, espera: /Situação legal|Matéria-prima/ },
  { id: 'datageo-rotas-turisticas', min: 85, espera: /Rota d/ },
];

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

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);
  await page.keyboard.press('Escape');
  await sleep(500);

  for (const { id, min, espera } of CAMADAS) {
    await setView(page, -51.4, -24.6, 900_000);
    await page.evaluate((lid) => window.__godsEyeView.dataManager.setEnabled(lid, true, { origin: 'user' }), id);
    const stats = await page.evaluate(async (lid) => {
      const mod = window.__godsEyeView.dataManager.layers.get(lid)?.module;
      const t0 = performance.now();
      while (performance.now() - t0 < 30_000) {
        const s = mod?.getStats?.() ?? {};
        if (s.count > 0) return s;
        await new Promise((r) => setTimeout(r, 250));
      }
      return { timedOut: true };
    }, id);
    check(`${id}: pontos carregam`, stats.count >= min, stats);
    await sleep(2_000);
    await page.screenshot({ path: shot.replace(/\.png$/, `-${id}-estado.png`) });

    const alvo = await page.evaluate((lid) => {
      const v = window.__godsEyeView.viewer;
      const e = v.dataSources.getByName(lid)[0].entities.values[0];
      const c = v.scene.globe.ellipsoid.cartesianToCartographic(e.position.getValue());
      return { lon: c.longitude * 180 / Math.PI, lat: c.latitude * 180 / Math.PI };
    }, id);
    await setView(page, alvo.lon, alvo.lat, 3_000);
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
      if (espera.test(html)) break;
    }
    await page.screenshot({ path: shot.replace(/\.png$/, `-${id}.png`) });
    check(`${id}: hover abre o tooltip`, espera.test(html), html.slice(0, 160));
    await page.evaluate((lid) => window.__godsEyeView.dataManager.setEnabled(lid, false, { origin: 'user' }), id);
    await page.mouse.move(10, 10);
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-agroindustrias: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
