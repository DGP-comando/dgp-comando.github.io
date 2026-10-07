#!/usr/bin/env node
/**
 * qa-ottobacias — as duas camadas de ottobacias da aba Aspectos físicos:
 *   - microbacias do IDR (PROtto): carrega as 6.210, tooltip, legenda por
 *     manancial filtrável, linha na ficha;
 *   - ottobacias por trecho (GeoPR): imagens do cache, tooltip e realce da
 *     área de contribuição a partir do zoom 12.
 *
 * Uso: node scripts/qa-ottobacias.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando e acesso a geopr.iat.pr.gov.br.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-ottobacias');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });
const tiles = [];
page.on('response', (r) => { if (r.url().includes('rede_otto_areas_drena')) tiles.push(r.status()); });

const feicao = async (id) => {
  for (let i = 0; i < 40; i++) {
    const f = await interactiveFeature(page, id);
    if (f) return f;
    await sleep(500);
  }
  return null;
};
const clicaLegenda = (lid, key, shift = false) => page.evaluate(([l, k, s]) => {
  const el = document.querySelector(`[data-layer-id="${l}"] .data-toggle-legend-item[data-key="${k}"]`);
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: s }));
  return Boolean(el);
}, [lid, key, shift]);
const renderizadas = () => page.evaluate(() => {
  const m = window.__gevEngine.map;
  return [...new Set(m.queryRenderedFeatures({ layers: ['dg-ottobacias-idr-fill'] }).map((f) => f.properties.man))];
});

try {
  await openApp(page, url);

  // Microbacias do IDR.
  await setLayer(page, 'datageo-ottobacias-idr', true);
  const st = await waitForStats(page, 'datageo-ottobacias-idr', 's => s.count > 0 || s.error', 60_000);
  check('microbacias: 6.210 ottobacias carregadas', st.stats?.count === 6210, st.stats);
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 60_000 });
  await waitMapIdle(page, 60_000);
  const f = await feicao('datageo-ottobacias-idr');
  check('microbacias: polígonos na tela', Boolean(f), f?.props);
  if (f) {
    const tip = await hoverTooltip(page, f.lon + 0.01, f.lat - 0.01, /Ottobacia/);
    check('microbacias: tooltip com código, bacia e área', /Ottobacia \d+/.test(tip) && /Microbacia IDR · bacia do/.test(tip) && /Área/.test(tip), tip.slice(0, 200));
  }
  // Legenda filtrável: Shift em "Manancial Sanepar" deixa só mananciais Sanepar.
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 120_000 });
  await waitMapIdle(page, 60_000);
  check('microbacias: legenda por manancial clicável', await clicaLegenda('datageo-ottobacias-idr', 'sanepar', true));
  await sleep(600);
  const so = await renderizadas();
  check('microbacias: Shift deixa só os mananciais Sanepar', so.length === 1 && so[0] === 'sanepar', so);
  await clicaLegenda('datageo-ottobacias-idr', 'sanepar', true);
  await sleep(600);
  check('microbacias: de novo mostra todas', (await renderizadas()).includes('demais'));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-idr.png') });
  await setLayer(page, 'datageo-ottobacias-idr', false);

  // Ottobacias por trecho (GeoPR).
  await setLayer(page, 'datageo-ottobacias-trecho', true);
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 8_000 });
  await waitMapIdle(page, 90_000);
  check('por trecho: imagens do cache do GeoPR (200)', tiles.length > 0 && tiles.every((s) => s === 200), tiles);
  const a = await feicao('datageo-ottobacias-trecho');
  check('por trecho: áreas da vista para o hover', Boolean(a), a?.props);
  if (a) {
    const tip = await hoverTooltip(page, a.lon, a.lat, /Área de contribuição/);
    check('por trecho: tooltip com ottobacia e área de contribuição', /Ottobacia \d+/.test(tip) && /Área de contribuição/.test(tip), tip.slice(0, 200));
    const realce = await page.evaluate(() => {
      const m = window.__gevEngine.map;
      return m.queryRenderedFeatures({ layers: ['dg-ottobacias-trecho-areas-hit'] })
        .some((x) => m.getFeatureState({ source: 'dg-ottobacias-trecho-areas', id: x.id }).hover);
    });
    check('por trecho: área sob o cursor realçada', realce);
  }
  if (shot) await page.screenshot({ path: shot });

  // Ficha: linha das ottobacias na Hidrografia.
  await page.evaluate(async () => (await import('/src/maplibre/layers/municipios.js')).openMunicipioFicha('4119905', 'Ponta Grossa'));
  await page.waitForFunction(() => /Ottobacias do IDR/.test(document.querySelector('#datageo-ficha')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {});
  const ficha = await page.evaluate(() => document.querySelector('#datageo-ficha')?.textContent ?? '');
  check('ficha: ottobacias e manancial de Ponta Grossa', /Ottobacias do IDR: \d+/.test(ficha) && /Pitangui/.test(ficha));
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
