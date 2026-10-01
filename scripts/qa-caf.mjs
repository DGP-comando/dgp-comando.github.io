#!/usr/bin/env node
/**
 * qa-caf — Agricultura familiar (CAF/MDA, bucket privado):
 *   1. a camada carrega um ponto por família e o hover mostra nome e renda;
 *   2. com o CAR ligado, o clique abre o cadastro completo no painel e destaca
 *      o imóvel do CAR que contém o ponto;
 *   3. a ficha municipal e a regional trazem "Agricultura familiar · CAF".
 * O bucket privado é servido de data/privado/ (interceptação), porque o dev
 * roda sem login. Requer as saídas de scripts/build_caf.py.
 *
 * Uso: node scripts/qa-caf.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const ler = (rel) => JSON.parse(readFileSync(new URL(rel, PRIVADO), 'utf8'));
const PONTOS = ler('caf-pontos.json');
const MUN = ler('caf-municipios.json');
const IBGE = '4117909'; // Palotina
const REGIONAL = JSON.parse(readFileSync(new URL('../public/data/regionais-idr-pr.geojson', import.meta.url), 'utf8'))
  .features.find((f) => f.properties.regional === 'Toledo').properties;
// Família de Palotina com ponto no município, renda declarada e coordenada só
// dela (várias famílias dividem o ponto do escritório ou do sindicato).
const chave = (r) => `${r[0]},${r[1]}`;
const vezes = new Map();
for (const r of PONTOS.p) vezes.set(chave(r), (vezes.get(chave(r)) ?? 0) + 1);
const longe = (r) => PONTOS.p.every((o) => o === r || Math.hypot(o[0] - r[0], o[1] - r[1]) > 0.0005);
const linha = PONTOS.p.filter((r) => r[3] === IBGE && PONTOS.status[r[8]] === 'ok' && r[6] > 0 && r[5]
  && vezes.get(chave(r)) === 1).find(longe);
const [LON, LAT, CAF, , , NOME] = linha;
const FAM = ler(`caf/${IBGE}.json`).familias[String(CAF)];

const { check, finish } = createReport('qa-caf');
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

const fichaTexto = () => page.evaluate(() => document.querySelector('#datageo-ficha')?.textContent ?? '');
const secaoCaf = async () => {
  await page.waitForFunction(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
    .some((h) => h.textContent.startsWith('Agricultura familiar')), { timeout: 60_000 }).catch(() => {});
  return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith('Agricultura familiar'))?.textContent ?? '');
};
const fmt = (v) => Number(v).toLocaleString('pt-BR');

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');

  // 1. Camada e hover
  await setLayer(page, 'datageo-caf', true);
  const { stats } = await waitForStats(page, 'datageo-caf', 's => s.count > 0 || s.error', 120_000);
  check('camada carrega um ponto por família', stats?.count === PONTOS.p.length, { stats, esperado: PONTOS.p.length });
  await setCamera(page, { lon: LON, lat: LAT, alt: 2_500 });
  await waitMapIdle(page, 60_000);
  const tip = await hoverTooltip(page, LON, LAT, new RegExp(`CAF ${CAF}`));
  check('hover: nome, CAF e renda', tip.includes(NOME) && tip.includes(`CAF ${CAF}`) && /Renda declarada/.test(tip), tip.slice(0, 300));

  // 2. Clique com o CAR ligado: cadastro completo + imóvel destacado
  await setLayer(page, 'datageo-car', true);
  await waitMapIdle(page, 60_000);
  const pt = await page.evaluate((lo, la) => {
    const { engine } = window.__godsEyeView;
    const p = engine.project(lo, la);
    const r = engine.container.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, LON, LAT);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => /Membros da família/.test(document.querySelector('#datageo-ficha')?.textContent ?? ''),
    { timeout: 60_000 }).catch(() => {});
  await sleep(500);
  const painel = await fichaTexto();
  const decl = FAM.membros[0];
  check('painel: cadastro completo da família', painel.includes(`CAF ${CAF}`) && painel.includes(decl.nome)
    && /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(painel) && /Dentro do estabelecimento|Fora do estabelecimento/.test(painel),
  painel.slice(0, 400));
  const destacado = /Imóvel do CAR destacado/.test(painel);
  const sel = await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    return engine.map.querySourceFeatures('dg-caf-sel').map((f) => f.geometry.type);
  });
  check('CAR: imóvel destacado no mapa (ou aviso de que nenhum contém o ponto)',
    (destacado && sel.includes('LineString')) || (!destacado && /Nenhum imóvel do CAR/.test(painel)),
  { destacado, sel, trecho: painel.match(/(Imóvel do CAR|Nenhum imóvel)[^·]*/)?.[0] });
  check('painel sem mojibake', !/�/.test(painel));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-familia.png') });

  // 3. Fichas municipal e regional
  await page.evaluate(async (i) => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha(i, 'Palotina');
  }, IBGE);
  const ficha = await secaoCaf();
  const m = MUN.municipios[IBGE];
  check('ficha municipal: contagem, série e renda', ficha.includes(`Famílias com CAF ativa: ${fmt(m.caf['2025-10'])}`)
    && /Com cadastro \(CAF ou DAP\)/.test(ficha) && /Renda total: R\$/.test(ficha) && /Pronaf: A/.test(ficha), ficha.slice(0, 400));
  if (shot) {
    await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
      .find((h) => h.textContent.startsWith('Agricultura familiar'))?.scrollIntoView());
    await page.screenshot({ path: shot });
  }
  await page.evaluate(async (ibges) => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Regional Toledo', meta: '', ibges });
  }, REGIONAL.municipios);
  const alvo = `Famílias com CAF ativa: ${fmt(MUN.regionais.Toledo.caf['2025-10'])}`;
  await page.waitForFunction((t) => document.querySelector("#datageo-ficha")?.textContent.includes(t), { timeout: 60_000 }, alvo)
    .catch(() => {});
  const reg = await secaoCaf();
  check('ficha regional: agregado da regional', reg.includes(alvo),
    reg.slice(0, 300));
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
