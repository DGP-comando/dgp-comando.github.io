#!/usr/bin/env node
/**
 * qa-rede-copel — transformadores e postes da Copel (PMTiles da BDGD):
 * arquivo lido por HTTP Range, pontos na tela, tooltip,
 * legenda dos trafos filtrável.
 *
 * Uso: node scripts/qa-rede-copel.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-rede-copel');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });
const ranges = [];
page.on('response', (r) => { if (r.url().includes('copel-')) ranges.push(r.status()); });

const feicao = async (id) => {
  for (let i = 0; i < 40; i++) {
    const f = await interactiveFeature(page, id);
    if (f) return f;
    await sleep(500);
  }
  return null;
};
const renderizados = (lid) => page.evaluate((l) => window.__gevEngine.map.queryRenderedFeatures({ layers: [l] }).length, lid);

try {
  await openApp(page, url);

  // Transformadores: zona rural de Toledo (zoom ~12).
  await setLayer(page, 'datageo-copel-transformadores', true);
  await setCamera(page, { lon: -53.74, lat: -24.72, alt: 25_000 });
  await waitMapIdle(page, 60_000);
  check('trafos: PMTiles por Range (206/200)', ranges.length > 0 && ranges.every((s) => s === 206 || s === 200), ranges.slice(0, 10));
  const n = await renderizados('dg-copel-transformadores-pt');
  check('trafos: pontos na tela', n > 50, n);
  const t = await feicao('datageo-copel-transformadores');
  if (t) {
    const tip = await hoverTooltip(page, t.lon, t.lat, /Transformador/);
    check('trafos: tooltip com kVA e tipo', /Transformador [\d,.]+ kVA/.test(tip) && /(Trifásico|Monofásico)/.test(tip), tip.slice(0, 200));
  } else check('trafos: feição para o hover', false);
  // Legenda: Shift em Trifásico deixa só os trifásicos.
  const clicou = await page.evaluate(() => {
    const el = document.querySelector('[data-layer-id="datageo-copel-transformadores"] .data-toggle-legend-item[data-key="T"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return Boolean(el);
  });
  await sleep(600);
  const tipos = await page.evaluate(() => [...new Set(window.__gevEngine.map
    .queryRenderedFeatures({ layers: ['dg-copel-transformadores-pt'] }).map((f) => f.properties.tipo))]);
  check('trafos: legenda filtra trifásicos', clicou && tipos.length === 1 && tipos[0] === 'T', tipos);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-trafos.png') });
  await setLayer(page, 'datageo-copel-transformadores', false);

  // Postes: centro de Toledo (zoom ~15).
  await setLayer(page, 'datageo-copel-postes', true);
  await setCamera(page, { lon: -53.743, lat: -24.725, alt: 3_000 });
  await waitMapIdle(page, 60_000);
  const np = await renderizados('dg-copel-postes-pt');
  check('postes: pontos na tela', np > 100, np);
  const p = await feicao('datageo-copel-postes');
  if (p) {
    const tip = await hoverTooltip(page, p.lon, p.lat, /BDGD/);
    check('postes: tooltip com tipo e material', /Poste|Derivação|Torre|Ponto/.test(tip) && /BDGD/.test(tip), tip.slice(0, 200));
  } else check('postes: feição para o hover', false);
  if (shot) await page.screenshot({ path: shot });

  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
