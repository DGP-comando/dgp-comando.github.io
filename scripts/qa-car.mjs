#!/usr/bin/env node
/**
 * qa-car — confere as duas metades da entrega do CAR:
 *   1. a camada de divisas (apenas ativos) carrega células e desenha as
 *      classes de módulos fiscais;
 *   2. a ficha municipal traz a seção Estrutura fundiária com as 5 classes,
 *      duas barras por classe e percentuais que fecham em 100%.
 *
 * Uso: node scripts/qa-car.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-car.png');
const LAYER_ID = 'datageo-car';
// Guarapuava: município grande, agrícola, com imóveis em todas as classes.
const IBGE = '4109401';

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
  page.on('console', (m) => { if (/datageo-car|DataGeo:car/.test(m.text())) console.log('   console:', m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);

  // ── 1. Camada ───────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: -53.5 * Math.PI / 180, latitude: -24.0 * Math.PI / 180, height: 20_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const carregou = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    const mod = gev.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      if (stats.count > 0) return { count: stats.count, error: stats.error };
      gev.viewer.scene.requestRender?.();
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('divisas do CAR carregam no oeste do PR', !carregou.timedOut && carregou.count > 1_000, carregou);

  const classes = await page.evaluate(() => {
    const gp = window.__godsEyeView.viewer.scene.groundPrimitives;
    const isCollection = (x) => !!x && typeof x.get === 'function' && typeof x.length === 'number';
    let grupos = 0;
    for (let i = 0; i < gp.length; i++) {
      const root = gp.get(i);
      if (!root?.show || !isCollection(root)) continue;
      for (let j = 0; j < root.length; j++) {
        const cell = root.get(j);
        if (!isCollection(cell)) continue;
        for (let k = 0; k < cell.length; k++) if (!isCollection(cell.get(k))) grupos++;
      }
    }
    return grupos;
  });
  check('mais de uma classe de módulos fiscais desenhada', classes > 1, { grupos: classes });
  await sleep(2_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  // ── 2. Ficha ────────────────────────────────────────────────────────────
  await page.evaluate((ibge) => window.__godsEyeView.dataManager.layers
    .get('datageo-municipios')?.module?.openMunicipioFicha({ ibge, nome: 'Guarapuava' }), IBGE);
  await page.waitForFunction(
    () => /Estrutura fundi/.test(document.querySelector('#datageo-ficha .fx-body')?.textContent ?? ''),
    { timeout: 60_000 },
  ).catch(() => {});

  const ficha = await page.evaluate(() => {
    const corpo = document.querySelector('#datageo-ficha .fx-body');
    const secao = [...(corpo?.querySelectorAll('.fx-section') ?? [])]
      .find((s) => /Estrutura fundi/.test(s.querySelector('h3')?.textContent ?? ''));
    if (!secao) return { ausente: true, texto: (corpo?.textContent ?? '').slice(0, 200) };
    const linhas = [...secao.querySelectorAll('.fx-car-row')].map((row) => ({
      classe: row.querySelector('.fx-car-label')?.textContent,
      larguras: [...row.querySelectorAll('.fx-car-fill')].map((f) => parseFloat(f.style.width)),
    }));
    return { titulo: secao.querySelector('h3')?.textContent, linhas };
  });
  check('ficha traz Estrutura fundiária com as 5 classes',
    !ficha.ausente && ficha.linhas?.length === 5, ficha.ausente ? ficha : { titulo: ficha.titulo });
  if (!ficha.ausente) {
    const rotulos = ficha.linhas.map((l) => l.classe);
    check('classes na ordem e com duas barras cada',
      JSON.stringify(rotulos) === JSON.stringify(['0-4 MF', '4-10 MF', '10-20 MF', '20-50 MF', '>50 MF'])
        && ficha.linhas.every((l) => l.larguras.length === 2), rotulos);
    const somaN = ficha.linhas.reduce((a, l) => a + l.larguras[0], 0);
    const somaHa = ficha.linhas.reduce((a, l) => a + l.larguras[1], 0);
    check('percentuais fecham em 100% nas duas barras',
      Math.abs(somaN - 100) < 1 && Math.abs(somaHa - 100) < 1,
      { somaN: +somaN.toFixed(2), somaHa: +somaHa.toFixed(2) });
  }

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-car: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
