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
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-estradas-conveniadas.png');
const LAYER_ID = 'datageo-estradas-conveniadas';
const GRUPOS = ['conveniadas', 'protocolos', 'automatizado'];

const { check, finish } = createReport('qa-estradas-conveniadas');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });
const setView = (lon, lat, alt) => setCamera(page, { lon, lat, alt });

// Visibilidade de cada conjunto = layout do layer MapLibre do conjunto.
const shows = () => page.evaluate((grupos) => {
  const { map } = window.__godsEyeView.engine;
  return Object.fromEntries(grupos.map((g) => {
    const id = `dg-estradas-conveniadas-${g}`;
    return [g, Boolean(map.getLayer(id)) && map.getLayoutProperty(id, 'visibility') !== 'none'];
  }));
}, GRUPOS);
const clickChip = (chipId) => page.evaluate((lid, cid) => {
  document.querySelector(`[data-layer-id="${lid}"] .data-toggle-chip[data-chip-id="${cid}"]`)?.click();
}, LAYER_ID, chipId);

try {
  await openApp(page, url);
  await page.keyboard.press('Escape'); // tutorial de primeira visita cobre o mapa
  await sleep(500);

  await setView(-51.4, -24.6, 900_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
  const stats = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      const s = mod?.getStats?.() ?? {};
      if (s.count > 0) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('trechos carregam (dado privado: /privado/estradas-conveniadas-pr.geojson)', stats.count >= 900, stats);

  await sleep(1_000);
  const chips = await page.$$eval(`[data-layer-id="${LAYER_ID}"] .data-toggle-chip`,
    (els) => els.map((e) => ({ id: e.dataset.chipId, on: e.getAttribute('aria-pressed') })));
  check('três chips na linha do painel', chips.length === 3, chips);
  const s0 = await shows();
  check('três conjuntos visíveis', Object.values(s0).every(Boolean), s0);
  await waitMapIdle(page);
  await page.screenshot({ path: shot.replace(/\.png$/, '-estado.png') });

  await clickChip('protocolos');
  await sleep(400);
  const s1 = await shows();
  check('chip esconde só os protocolos', s1.conveniadas && !s1.protocolos && s1.automatizado, s1);
  await clickChip('protocolos');
  await sleep(400);
  const s2 = await shows();
  check('e mostra de novo', s2.protocolos, s2);

  // Hover real numa conveniada, de perto.
  const alvo = await interactiveFeature(page, LAYER_ID, { grupo: 'conveniadas' });
  let html = '';
  if (alvo) {
    await setView(alvo.lon, alvo.lat, 4_000);
    await waitMapIdle(page);
    await sleep(1_000);
    // Coordenadas do quadro de 900 km são quantizadas pelo tile: refaz de perto.
    const perto = (await interactiveFeature(page, LAYER_ID, { grupo: 'conveniadas' })) ?? alvo;
    html = await hoverTooltip(page, perto.lon, perto.lat, /Conveniadas 2026/);
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

finish();
