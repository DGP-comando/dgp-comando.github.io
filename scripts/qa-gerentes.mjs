#!/usr/bin/env node
/**
 * qa-gerentes — gerente da regional (gerentes-idr.json) na ficha municipal, na
 * ficha regional e no tooltip da unidade regional (camada Unidades do IDR).
 *
 * Os arquivos do bucket privado são servidos de data/privado/ (mesma
 * interceptação do qa-servidores-susaf). Precisa de gerentes-idr.json local
 * (scripts/build_servidores_rh.py).
 *
 * Uso: node scripts/qa-gerentes.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const GER = JSON.parse(readFileSync(new URL('gerentes-idr.json', PRIVADO), 'utf8')).regionais;
const REG = JSON.parse(readFileSync(new URL('../public/data/regionais-idr-pr.geojson', import.meta.url), 'utf8'))
  .features.map((f) => f.properties);
const UMUARAMA = GER.Umuarama.nome;

const { check, finish } = createReport('qa-gerentes');
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

const territorio = async () => {
  await page.waitForFunction(() => /Território/.test(document.querySelector('#datageo-ficha .fx-body')?.textContent ?? ''),
    { timeout: 60_000 });
  return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith('Território'))?.textContent ?? null);
};

try {
  check('23 regionais com gerente no arquivo', REG.every((r) => GER[r.regional]), REG.filter((r) => !GER[r.regional]));
  await openApp(page, url);

  // Ficha municipal: Tapira é da regional de Umuarama.
  await page.evaluate(async () => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha('4126900', 'Tapira');
  });
  let t = await territorio();
  check(`ficha municipal (Tapira): gerente ${UMUARAMA}`, t?.includes(`Gerente regional: ${UMUARAMA}`), t?.slice(0, 400));
  if (shot) await (await page.$('#datageo-ficha')).screenshot({ path: shot });

  // Ficha regional.
  await page.evaluate(async (p) => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    const { fichaRegionalIdr } = await import('/src/data/territoriosSpec.js');
    await openFichaRegiao(fichaRegionalIdr(p));
  }, REG.find((r) => r.regional === 'Umuarama'));
  t = await territorio();
  check(`ficha regional (Umuarama): gerente ${UMUARAMA}`, t?.includes(`Gerente regional: ${UMUARAMA}`), t?.slice(0, 400));
  await page.evaluate(async () => (await import('/src/datageoFicha.js')).closeFicha());

  // Tooltip do escritório regional de Umuarama.
  await setLayer(page, 'datageo-unidades-idr', true);
  await setCamera(page, { lon: -53.32, lat: -23.77, alt: 30_000, heading: 0, pitch: -90 });
  await waitMapIdle(page);
  const alvo = await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    const f = engine.map.queryRenderedFeatures({ layers: ['dg-unidades-idr-pt'] })
      .find((x) => x.properties.__size === 9 && /Umuarama/.test(x.properties.__label));
    return f ? f.geometry.coordinates : null;
  });
  check('unidade regional de Umuarama renderizada', alvo);
  if (alvo) {
    const tip = await hoverTooltip(page, alvo[0], alvo[1], /Unidade regional/);
    check(`tooltip da regional com o gerente ${UMUARAMA}`, tip.includes(UMUARAMA) && tip.includes('Gerente'), tip.slice(0, 300));
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} catch (err) {
  check(`execução: ${err.message}`, false);
} finally {
  await browser.close();
}
finish();
