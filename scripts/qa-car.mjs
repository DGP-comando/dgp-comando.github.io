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
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-car.png');
const LAYER_ID = 'datageo-car';
// Guarapuava: município grande, agrícola, com imóveis em todas as classes.
const IBGE = '4109401';

const { check, finish } = createReport('qa-car');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

try {
  page.on('console', (m) => { if (/datageo-car|DataGeo:car/.test(m.text())) console.log('   console:', m.text()); });
  await openApp(page, url);

  // ── 1. Camada ───────────────────────────────────────────────────────────
  await setCamera(page, { lon: -53.5, lat: -24.0, alt: 20_000 });
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const carregou = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      if (stats.count > 0) return { count: stats.count, error: stats.error };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('divisas do CAR carregam no oeste do PR', !carregou.timedOut && carregou.count > 1_000, carregou);

  // Um layer de linha só (dg-car-line), cor por `classe`: conta as classes
  // distintas entre as feições realmente desenhadas.
  await waitMapIdle(page);
  const classes = await page.evaluate(() => {
    const { map } = window.__godsEyeView.engine;
    if (!map.getLayer('dg-car-line')) return 0;
    return new Set(map.queryRenderedFeatures({ layers: ['dg-car-line'] }).map((f) => f.properties?.classe)).size;
  });
  check('mais de uma classe de módulos fiscais desenhada', classes > 1, { grupos: classes });
  await sleep(2_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  // ── 2. Ficha ────────────────────────────────────────────────────────────
  await page.evaluate(async (ibge) => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha(ibge, 'Guarapuava');
  }, IBGE);
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

finish();
