#!/usr/bin/env node
/**
 * qa-fontes-protegidas — fontes protegidas do IDR (bucket privado):
 *   1. a camada carrega um ponto por fonte e o hover mostra produtor e tipo;
 *   2. o clique numa fonte ligada à CAF abre o cadastro da família, que cita a fonte;
 *   3. a ficha municipal traz "Proteção de fontes · IDR";
 *   4. o tooltip do município traz a contagem de fontes.
 * Bucket privado servido de data/privado/ (interceptação), como no qa-caf.
 *
 * Uso: node scripts/qa-fontes-protegidas.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const F = JSON.parse(readFileSync(new URL('fontes-protegidas.json', PRIVADO), 'utf8'));
// Fonte ligada à CAF, no município, sem outra fonte a menos de ~50 m.
const longe = (r) => F.p.every((o) => o === r || Math.hypot(o[0] - r[0], o[1] - r[1]) > 0.0005);
const alvo = F.p.filter((r) => r[9] && !r[8] && r[4]).find(longe);
const [LON, LAT, IBGE, , PRODUTOR] = alvo;
const fmt = (v) => Number(v).toLocaleString('pt-BR');

const { check, finish } = createReport('qa-fontes-protegidas');
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
  return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: readFileSync(arq) });
});

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');

  // 0. Tooltip do município (sem outra camada sob o cursor): contagem de fontes.
  await setCamera(page, { lon: LON, lat: LAT, alt: 60_000 });
  await waitMapIdle(page, 60_000);
  const tmun = await hoverTooltip(page, LON, LAT, /Fontes protegidas/);
  check('tooltip do município: fontes protegidas', tmun.includes(`Fontes protegidas (IDR)${fmt(F.municipios[IBGE].total)}`), tmun.slice(0, 250));

  await setLayer(page, 'datageo-fontes-protegidas', true);
  const { stats } = await waitForStats(page, 'datageo-fontes-protegidas', 's => s.count > 0 || s.error', 120_000);
  check('camada carrega um ponto por fonte', stats?.count === F.p.length, { stats, esperado: F.p.length });

  await setCamera(page, { lon: LON, lat: LAT, alt: 2_000 });
  await waitMapIdle(page, 60_000);
  const tip = await hoverTooltip(page, LON, LAT, /Família CAF/);
  check('hover: produtor, tipo e família CAF', tip.includes(PRODUTOR) && /Tipo/.test(tip) && /CAF \d+/.test(tip), tip.slice(0, 250));

  const pt = await page.evaluate((lo, la) => {
    const { engine } = window.__godsEyeView;
    const q = engine.project(lo, la);
    const r = engine.container.getBoundingClientRect();
    return { x: r.left + q.x, y: r.top + q.y };
  }, LON, LAT);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => /Fonte protegida pelo IDR/.test(document.querySelector('#datageo-ficha')?.textContent ?? ''),
    { timeout: 60_000 }).catch(() => {});
  await sleep(500);
  const painel = await page.evaluate(() => document.querySelector('#datageo-ficha')?.textContent ?? '');
  check('clique: cadastro CAF da família cita a fonte', painel.includes(`CAF ${alvo[9]}`) && /Fonte protegida pelo IDR/.test(painel),
    painel.slice(0, 300));
  await page.mouse.move(5, 450);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-mapa.png') });

  await page.evaluate(async (i) => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha(i, '');
  }, IBGE);
  const total = F.municipios[IBGE].total;
  const alvoTxt = `Fontes protegidas: ${fmt(total)}`;
  await page.waitForFunction((t) => document.querySelector('#datageo-ficha')?.textContent.includes(t), { timeout: 60_000 }, alvoTxt)
    .catch(() => {});
  const ficha = await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((s) => (s.querySelector('h3')?.textContent ?? '').startsWith('Proteção de fontes'))?.textContent ?? '');
  check('ficha municipal: proteção de fontes', ficha.includes(alvoTxt) && /Últimos anos/.test(ficha), ficha.slice(0, 250));
  if (shot) {
    await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
      .find((h) => h.textContent.startsWith('Proteção de fontes'))?.scrollIntoView());
    await page.screenshot({ path: shot });
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
