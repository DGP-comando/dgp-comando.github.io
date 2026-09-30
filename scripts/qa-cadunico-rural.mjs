#!/usr/bin/env node
/**
 * qa-cadunico-rural — famílias rurais do CadÚnico (bucket privado):
 *   1. a ficha municipal mostra o bloco rural dentro de "Proteção social";
 *   2. o tooltip de um assentamento e de uma terra indígena traz a seção
 *      "CadÚnico · famílias rurais" com os números do arquivo.
 * O bucket privado é servido de data/privado/ (interceptação de
 * /storage/v1/object/authenticated/datageo-privado/*), porque o dev roda sem
 * login. Requer data/privado/cadunico-rural-pr.json (build_cadunico_rural.py).
 *
 * Uso: node scripts/qa-cadunico-rural.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const CAD = JSON.parse(readFileSync(new URL('cadunico-rural-pr.json', PRIVADO), 'utf8'));
const geo = (nome) => JSON.parse(readFileSync(new URL(`../public/data/${nome}`, import.meta.url), 'utf8')).features;
const fmt = (v) => Number(v).toLocaleString('pt-BR');

/** Centroide do anel externo do maior polígono. */
function centro(f) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const ring = polys.map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  const [x, y] = ring.reduce(([sx, sy], [lo, la]) => [sx + lo, sy + la], [0, 0]);
  return [x / ring.length, y / ring.length];
}

// O território casado com MAIS famílias de cada camada (tooltip mais rico).
const maior = (grupo) => Object.entries(CAD[grupo]).filter(([, v]) => typeof v.familias === 'number')
  .sort((a, b) => b[1].familias - a[1].familias)[0];
const [codPa, cadPa] = maior('assentamentos');
const [nomeTi, cadTi] = maior('terras_indigenas');
const TERRITORIOS = [
  { layer: 'datageo-assentamentos', feat: geo('assentamentos-incra-pr.geojson').find((f) => f.properties.codigo === codPa), cad: cadPa },
  { layer: 'datageo-terras-indigenas', feat: geo('terras-indigenas-pr.geojson').find((f) => f.properties.nome === nomeTi), cad: cadTi },
];
const FICHA = { ibge: '4109401', nome: 'Guarapuava' };

const { check, finish } = createReport('qa-cadunico-rural');
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

  // 1. Ficha municipal
  await page.evaluate(async (i, n) => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha(i, n);
  }, FICHA.ibge, FICHA.nome);
  await page.waitForFunction(
    (i) => {
      const t = document.querySelector('#datageo-ficha')?.textContent ?? '';
      return t.includes(`IBGE ${i}`) && /Famílias rurais no CadÚnico/.test(t);
    },
    { timeout: 60_000 },
    FICHA.ibge,
  );
  const texto = await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((s) => /Proteção social/.test(s.textContent))?.textContent ?? '');
  const m = CAD.municipios[FICHA.ibge];
  check(`${FICHA.nome}: famílias rurais`, texto.includes(`${fmt(m.familias)} famílias rurais · ${fmt(m.pessoas)} pessoas`), texto);
  check(`${FICHA.nome}: extrema pobreza`, texto.includes(`${fmt(m.extrema_pobreza)} em extrema pobreza`), texto);
  check(`${FICHA.nome}: sem undefined/NaN`, !/undefined|NaN/.test(texto), texto);
  if (shot) {
    await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
      .find((x) => /Proteção social/.test(x.textContent))?.scrollIntoView({ block: 'start' }));
    await (await page.$('#datageo-ficha')).screenshot({ path: shot.replace(/\.png$/, '-ficha.png') });
  }
  await page.keyboard.press('Escape');

  // 2. Tooltips dos territórios
  for (const { layer, feat, cad } of TERRITORIOS) {
    const nome = feat.properties.nome;
    await page.evaluate((l) => window.__godsEyeView.dataManager.setEnabled(l, true, { origin: 'user' }), layer);
    const [lon, lat] = centro(feat);
    await setCamera(page, { lon, lat, alt: 12_000 });
    await waitMapIdle(page);
    await sleep(1_500);
    const html = await hoverTooltip(page, lon, lat, /CadÚnico/);
    check(`${nome}: tooltip com CadÚnico`, /CadÚnico · famílias rurais/.test(html), html.slice(0, 200));
    check(`${nome}: ${cad.familias} famílias no tooltip`, html.includes(`${fmt(cad.familias)} · ${fmt(cad.pessoas)} pessoas`), html.slice(0, 400));
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, `-${layer}.png`) });
    await page.evaluate((l) => window.__godsEyeView.dataManager.setEnabled(l, false, { origin: 'user' }), layer);
    await page.mouse.move(10, 10);
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('execução do QA', false, error.message);
} finally {
  await browser.close();
}
finish();
