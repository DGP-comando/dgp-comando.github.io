#!/usr/bin/env node
/**
 * qa-torres — hover numa torre da camada Conectividade:
 *   1. o tooltip abre com operadora, gerações e o aviso de estimativa;
 *   2. os anéis de alcance são desenhados (um por geração);
 *   3. tirar o mouse apaga os anéis e o tooltip.
 *
 * Uso: node scripts/qa-torres.mjs [--url http://localhost:5173] [--shot out.png]
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-torres.png');
const LAYER_ID = 'datageo-conectividade';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 300_000, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);
  await page.keyboard.press('Escape');

  // Guarapuava, visão de ~60 km: torres rurais separadas o bastante para o pick.
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: -51.46 * Math.PI / 180, latitude: -25.39 * Math.PI / 180, height: 60_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
  const count = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    for (let t = 0; t < 120; t++) {
      if (mod?.getStats?.().count > 0) return mod.getStats().count;
      await new Promise((r) => setTimeout(r, 250));
    }
    return 0;
  }, LAYER_ID);
  check('torres carregam', count > 1000, { count });
  await sleep(2_000);

  // Torre mais perto do centro da tela.
  const xy = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    const ds = v.dataSources.getByName('datageo-conectividade-torres')[0];
    v.scene.render();
    const r = v.scene.canvas.getBoundingClientRect();
    let best = null;
    for (const e of ds.entities.values) {
      const p = v.scene.cartesianToCanvasCoordinates(e.position.getValue(v.clock.currentTime));
      if (!p) continue;
      const d = Math.hypot(p.x - r.width / 2, p.y - r.height / 2);
      if (!best || d < best.d) best = { d, x: r.left + p.x, y: r.top + p.y };
    }
    return best;
  });
  check('há torre na tela', !!xy, xy);
  await page.mouse.move(xy.x - 30, xy.y - 30);
  await sleep(200);
  await page.mouse.move(xy.x, xy.y, { steps: 5 });
  await sleep(1_500);

  const hover = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('.datageo-entity-tooltip')].find((el) => el.style.display === 'block');
    const ds = window.__godsEyeView.viewer.dataSources.getByName('datageo-conectividade-destaque')[0];
    return { tip: tip?.textContent ?? '', aneis: ds?.entities.values.length ?? 0 };
  });
  check('tooltip com operadora e aviso de estimativa', /📡/.test(hover.tip) && /ESTIMADO/.test(hover.tip), hover.tip.slice(0, 120));
  check('anéis de alcance desenhados', hover.aneis >= 2, { entidades: hover.aneis });
  await page.mouse.move(xy.x, xy.y - 150, { steps: 3 });
  await sleep(300);
  await page.mouse.move(xy.x - 200, xy.y + 80, { steps: 3 });
  await sleep(1_500);
  // screenshot com o destaque: volta à torre
  await page.mouse.move(xy.x, xy.y, { steps: 5 });
  await sleep(1_500);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);
  await page.mouse.move(xy.x + 250, xy.y + 120, { steps: 4 });
  await sleep(1_500);
  const out = await page.evaluate(() => ({
    aneis: window.__godsEyeView.viewer.dataSources.getByName('datageo-conectividade-destaque')[0]?.entities.values.length ?? -1,
    tip: [...document.querySelectorAll('.datageo-entity-tooltip')].some((el) => el.style.display === 'block'),
  }));
  check('sair da torre apaga anéis e tooltip', out.aneis === 0 && !out.tip, out);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-torres: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
