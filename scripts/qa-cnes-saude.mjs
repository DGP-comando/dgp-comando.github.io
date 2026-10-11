#!/usr/bin/env node
/**
 * qa-cnes-saude — empresas do agro (CNPJ, bucket privado): carrega os 35 mil,
 * legenda por família filtrável, tooltip com todos os campos e acentos. O bucket privado é servido de data/privado/ (interceptação
 * de /storage/v1/object/authenticated/datageo-privado/*), porque o dev roda sem
 * login. Requer data/privado/cnes-saude-pr.json.gz (scripts/build_cnes_saude.py).
 *
 * Uso: node scripts/qa-cnes-saude.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const { check, finish } = createReport('qa-cnes-saude');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

await page.setRequestInterception(true);
page.on('request', (req) => {
  const m = /\/storage\/v1\/object\/authenticated\/datageo-privado\/([^?]+)/.exec(req.url());
  if (!m) return req.continue();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
  const arq = new URL(m[1], PRIVADO);
  if (!existsSync(arq)) return req.respond({ status: 404, headers: cors, body: '' });
  const tipo = m[1].endsWith('.gz') ? 'application/gzip' : 'application/json';
  return req.respond({ status: 200, headers: cors, contentType: tipo, body: readFileSync(arq) });
});

const classesVisiveis = () => page.evaluate(() => [...new Set(window.__gevEngine.map
  .queryRenderedFeatures({ layers: ['dg-cnes-saude-pt'] }).map((f) => f.properties.c))]);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-cnes-saude', true);
  const st = await waitForStats(page, 'datageo-cnes-saude', 's => s.count > 0 || s.error', 90_000);
  check('32.337 estabelecimentos carregados', st.stats?.count === 32337, st.stats);

  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const todas = await classesVisiveis();
  check('estado: as 9 famílias na tela', todas.length === 9, todas);

  // Legenda: Shift em Hospitais (1) deixa só eles.
  const clicou = await page.evaluate(() => {
    const el = document.querySelector('[data-layer-id="datageo-cnes-saude"] .data-toggle-legend-item[data-key="1"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return Boolean(el);
  });
  await sleep(600);
  const so = await classesVisiveis();
  check('legenda: Shift deixa só Hospitais', clicou && so.length === 1 && so[0] === 1, so);
  await page.evaluate(() => document.querySelector('[data-layer-id="datageo-cnes-saude"] .data-toggle-legend-item[data-key="1"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  await sleep(400);

  // Tooltip em Curitiba (centro), de perto.
  await setCamera(page, { lon: -49.27, lat: -25.43, alt: 6_000 });
  await waitMapIdle(page, 60_000);
  const f = await interactiveFeature(page, 'datageo-cnes-saude');
  const tip = f ? await hoverTooltip(page, f.lon, f.lat, /Atende SUS/) : '';
  check('tooltip: CNES, tipo, SUS, esfera, natureza, endereço e região de saúde',
    /CNES \d{7}/.test(tip) && /Atende SUS/.test(tip) && /Esfera administrativa/.test(tip)
    && /Natureza jurídica\s*\d{4}/.test(tip) && /Endereço/.test(tip) && /Região de saúde/.test(tip), tip.slice(0, 300));
  check('tooltip: acentos íntegros', !/�|Ã§|Ã£|Ã©/.test(tip), tip.slice(0, 120));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
