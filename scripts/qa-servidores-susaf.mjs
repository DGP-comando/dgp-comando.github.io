#!/usr/bin/env node
/**
 * qa-servidores-susaf — ficha municipal com "Extensionistas · IDR" e
 * "SUSAF-PR"; camadas de estações (tooltip com servidores) e de unidades.
 *
 * Os arquivos do bucket privado são servidos de data/privado/ (interceptação
 * de /storage/v1/object/authenticated/datageo-privado/*), porque o dev roda
 * com ?semlogin. Precisa de servidores-idr.json local (mesmo formato do que a
 * Edge Function datageo-servidores grava).
 *
 * Uso: node scripts/qa-servidores-susaf.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, renderedFeatures, setCamera,
  setLayer, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const ler = (nome) => JSON.parse(readFileSync(new URL(nome, PRIVADO), 'utf8'));
const SERV = ler('servidores-idr.json').servidores;
const SUSAF = ler('susaf-pr.json').municipios;
const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const extDe = (nome) => SERV.filter((s) => s.extensionista && norm(s.municipio) === norm(nome)).length;

// Um município de cada caso do SUSAF, mais um com muitos extensionistas.
const CASOS = [
  { ibge: '4128104', nome: 'Umuarama', susaf: /Aderiu com SIM próprio/ },
  { ibge: '4100202', nome: 'Adrianópolis', susaf: /via consórcio/ },
  { ibge: '4106902', nome: 'Curitiba', susaf: /Não aderiu/ },
];

const { check, finish } = createReport('qa-servidores-susaf');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

await page.setRequestInterception(true);
page.on('request', (req) => {
  const m = /\/storage\/v1\/object\/authenticated\/datageo-privado\/([^?]+)/.exec(req.url());
  if (!m) return req.continue();
  // O header Authorization faz o browser mandar preflight (OPTIONS) antes do GET.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
  const arq = new URL(m[1], PRIVADO);
  if (!existsSync(arq)) return req.respond({ status: 404, headers: cors, body: '' });
  return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: readFileSync(arq) });
});

const secao = (titulo) => page.evaluate((t) => {
  const s = [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith(t));
  return s ? s.textContent : null;
}, titulo);

try {
  await openApp(page, url);
  for (const c of CASOS) {
    check(`${c.nome}: SUSAF no JSON bate com o caso`, c.susaf.source.includes('Não') ? !SUSAF[c.ibge] : Boolean(SUSAF[c.ibge]));
    await page.evaluate(async (i, n) => {
      const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
      await openMunicipioFicha(i, n);
    }, c.ibge, c.nome);
    await page.waitForFunction(() => /SUSAF-PR/.test(document.querySelector('#datageo-ficha .fx-body')?.textContent ?? ''),
      { timeout: 60_000 });
    const sus = await secao('SUSAF-PR');
    check(`${c.nome}: seção SUSAF (${c.susaf})`, c.susaf.test(sus ?? ''), sus);
    const n = extDe(c.nome);
    const ext = await secao('Extensionistas · IDR');
    check(`${c.nome}: ${n} extensionistas na ficha`, n ? ext?.includes(`Extensionistas · IDR (${n})`) : ext === null, ext?.slice(0, 160));
    if (n) check(`${c.nome}: sem RG na ficha`, !/\b\d{2}\.?\d{3}\.?\d{3}-?\d\b/.test(ext));
    if (shot && c.nome === 'Umuarama') await (await page.$('#datageo-ficha')).screenshot({ path: shot });
  }

  await page.evaluate(async () => (await import('/src/datageoFicha.js')).closeFicha());

  // Estações: 20 áreas + 13 núcleos das fazendas florestais; o ponto do polo
  // de Ponta Grossa lista os servidores do polo.
  await setLayer(page, 'datageo-estacoes-idr', true);
  await setCamera(page, { lon: -51.4, lat: -24.6, alt: 900_000, heading: 0, pitch: -90 });
  await waitMapIdle(page);
  const areas = await renderedFeatures(page, 'dg-estacoes-idr-fill');
  check('estações: áreas + núcleos florestais renderizados', areas.count >= 33, areas);
  await setCamera(page, { lon: -50.0, lat: -25.14, alt: 40_000, heading: 0, pitch: -90 });
  await waitMapIdle(page);
  const f = await interactiveFeature(page, 'datageo-estacoes-idr', { unidade: 'polo-ponta-grossa' });
  check('estações: ponto do polo de Ponta Grossa renderizado', f);
  if (f) {
    const esperado = SERV.filter((s) => s.unidade === 'polo-ponta-grossa').length;
    const tip = await hoverTooltip(page, f.lon, f.lat, /servidor/);
    check(`estações: tooltip com ${esperado} servidores`, tip.includes(`${esperado} servidores`), tip.slice(0, 200));
  }
  await setLayer(page, 'datageo-estacoes-idr', false);

  await setLayer(page, 'datageo-unidades-idr', true);
  await setCamera(page, { lon: -51.4, lat: -24.6, alt: 900_000, heading: 0, pitch: -90 });
  await waitMapIdle(page);
  const pts = await renderedFeatures(page, 'dg-unidades-idr-pt');
  check('unidades: pontos renderizados (447 no arquivo)', pts.count >= 440, pts.count);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} catch (err) {
  check(`execução: ${err.message}`, false);
} finally {
  await browser.close();
}
finish();
