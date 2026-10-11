#!/usr/bin/env node
/**
 * qa-umidade-solo — umidade do solo (SMAP L4, JSON estático): carrega as
 * células do PR, legenda por classe de percentil filtrável, tooltip com todas
 * as variáveis. Requer public/data/umidade-solo-pr.json (scripts/build_umidade_solo.py).
 *
 * Uso: node scripts/qa-umidade-solo.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-umidade-solo');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

const classesVisiveis = () => page.evaluate(() => [...new Set(window.__gevEngine.map
  .queryRenderedFeatures({ layers: ['dg-umidade-solo-fill'] }).map((f) => f.properties.c))]);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-umidade-solo', true);
  const st = await waitForStats(page, 'datageo-umidade-solo', 's => s.count > 0 || s.error', 60_000);
  check('mais de 2.000 células do PR', st.stats?.count > 2000 && !st.stats?.error, st.stats);

  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const todas = await classesVisiveis();
  check('estado: alguma classe de percentil na tela', todas.length >= 1, todas);

  const alvo = todas[0];
  const clicou = await page.evaluate((k) => {
    const el = document.querySelector(`[data-layer-id="datageo-umidade-solo"] .data-toggle-legend-item[data-key="${k}"]`);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return Boolean(el);
  }, alvo);
  await sleep(600);
  const so = await classesVisiveis();
  check('legenda: Shift deixa só uma classe', clicou && so.length === 1 && so[0] === alvo, so);
  await page.evaluate((k) => document.querySelector(`[data-layer-id="datageo-umidade-solo"] .data-toggle-legend-item[data-key="${k}"]`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })), alvo);
  await sleep(400);

  await setCamera(page, { lon: -51.9, lat: -24.2, alt: 200_000 });
  await waitMapIdle(page, 60_000);
  const f = await interactiveFeature(page, 'datageo-umidade-solo');
  const tip = f ? await hoverTooltip(page, f.lon, f.lat, /Zona de raiz/) : '';
  check('tooltip: raiz, percentil, saturação, superfície, anomalia e perfil',
    /Zona de raiz.*\d+,\d%/.test(tip) && /Percentil da zona de raiz\s*\d+/.test(tip) && /Saturação/.test(tip)
    && /Superfície/.test(tip) && /p\.p\./.test(tip) && /Perfil/.test(tip), tip.slice(0, 300));
  check('tooltip: acentos íntegros', /Saturação/.test(tip) && !/�|Ã§|Ã£|Ã©/.test(tip), tip.slice(0, 120));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
