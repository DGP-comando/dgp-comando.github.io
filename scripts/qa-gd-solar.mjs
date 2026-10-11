#!/usr/bin/env node
/**
 * qa-gd-solar — geração distribuída solar (ANEEL, JSON gz aberto): carrega os
 * 330 mil sistemas, legenda por classe de consumo filtrável, tooltip com todos
 * os campos. Requer public/data/gd-solar-pr.json.gz (scripts/build_gd_solar.py).
 *
 * Uso: node scripts/qa-gd-solar.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-gd-solar');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

const classesVisiveis = () => page.evaluate(() => [...new Set(window.__gevEngine.map
  .queryRenderedFeatures({ layers: ['dg-gd-solar-pt'] }).map((f) => f.properties.c))]);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-gd-solar', true);
  const st = await waitForStats(page, 'datageo-gd-solar', 's => s.count > 0 || s.error', 120_000);
  check('330.413 sistemas carregados', st.stats?.count === 330413, st.stats);

  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const todas = await classesVisiveis();
  check('estado: as 6 classes de consumo na tela', todas.length === 6, todas);

  const alvo = 1; // Rural
  const clicou = await page.evaluate((k) => {
    const el = document.querySelector(`[data-layer-id="datageo-gd-solar"] .data-toggle-legend-item[data-key="${k}"]`);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return Boolean(el);
  }, alvo);
  await sleep(600);
  const so = await classesVisiveis();
  check('legenda: Shift deixa só uma classe', clicou && so.length === 1 && so[0] === alvo, so);
  await page.evaluate((k) => document.querySelector(`[data-layer-id="datageo-gd-solar"] .data-toggle-legend-item[data-key="${k}"]`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })), alvo);
  await sleep(400);

  await setCamera(page, { lon: -53.74, lat: -24.72, alt: 8_000 });
  await waitMapIdle(page, 60_000);
  const f = await interactiveFeature(page, 'datageo-gd-solar');
  const tip = f ? await hoverTooltip(page, f.lon, f.lat, /Potência instalada/) : '';
  check('tooltip: código GD, potência, modalidade, classe, distribuidora e município',
    /GD\.[A-Z]{2}\./.test(tip) && /Potência instalada\s*[\d,.]+ (kW|MW)/.test(tip) && /Modalidade/.test(tip)
    && /Classe de consumo/.test(tip) && /Distribuidora/.test(tip) && /Município/.test(tip), tip.slice(0, 300));
  check('tooltip: acentos íntegros', /Potência/.test(tip) && !/�|Ã§|Ã£|Ã©/.test(tip), tip.slice(0, 120));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
