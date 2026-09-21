#!/usr/bin/env node
/**
 * qa-radios — confere a camada Rádios ao vivo de ponta a ponta:
 *   1. os pontos dos municípios aparecem;
 *   2. clicar no ponto de Curitiba abre o player e o áudio entra no ar;
 *   3. a seta avança de estação e desligar a camada para o som.
 *
 * Uso: node scripts/qa-radios.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando e internet (o áudio vem direto das emissoras).
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-radios.png');
const LAYER_ID = 'datageo-radios';
const CURITIBA = '4106902';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--window-size=1440,900', '--autoplay-policy=user-gesture-required',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});

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

  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: -49.27 * Math.PI / 180, latitude: -25.43 * Math.PI / 180, height: 400_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
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
  check('estações carregam', stats.count > 0, stats);
  await sleep(2_000);

  // Clique REAL no ponto (gesto do usuário libera o autoplay).
  const xy = await page.evaluate((ibge) => {
    const gev = window.__godsEyeView;
    const ds = gev.viewer.dataSources.getByName('datageo-radios')[0];
    const e = ds?.entities.getById(`datageo-radios:${ibge}`);
    if (!e) return null;
    gev.viewer.scene.render();
    const p = gev.viewer.scene.cartesianToCanvasCoordinates(e.position.getValue(gev.viewer.clock.currentTime));
    const r = gev.viewer.scene.canvas.getBoundingClientRect();
    return p ? { x: r.left + p.x, y: r.top + p.y } : null;
  }, CURITIBA);
  check('ponto de Curitiba na tela', !!xy, xy);
  if (xy) await page.mouse.click(xy.x, xy.y);

  const open = await page.waitForFunction(
    () => document.querySelector('#dg-radio.open .dgr-place')?.textContent,
    { timeout: 10_000 },
  ).then((h) => h.jsonValue()).catch(() => null);
  check('clique abre o player no município', /Curitiba/.test(open ?? ''), open);

  const state = await page.waitForFunction(
    () => ['playing', 'error'].includes(document.querySelector('#dg-radio')?.dataset.state)
      && document.querySelector('#dg-radio').dataset.state,
    { timeout: 20_000 },
  ).then((h) => h.jsonValue()).catch(() => 'timeout');
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);
  const name1 = await page.$eval('.dgr-name', (el) => el.textContent);
  check('áudio entra no ar', state === 'playing', { state, estacao: name1 });

  await page.click('.dgr-skip[data-step="1"]');
  const name2 = await page.$eval('.dgr-name', (el) => el.textContent);
  check('seta avança de estação', name2 !== name1, { de: name1, para: name2 });

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  await sleep(500);
  const off = await page.evaluate(() => ({
    open: document.querySelector('#dg-radio')?.classList.contains('open'),
    state: document.querySelector('#dg-radio')?.dataset.state,
  }));
  check('desligar a camada fecha o player e para o som', !off.open && off.state === 'stopped', off);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-radios: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
