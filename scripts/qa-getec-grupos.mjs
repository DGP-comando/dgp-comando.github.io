#!/usr/bin/env node
/**
 * qa-getec-grupos — Unidades do IDR + grupos de assistidos do GETEC (bucket privado):
 *   1. o clique numa UME abre o painel com os extensionistas do município e a
 *      contagem de grupos/assistidos de cada um;
 *   2. o clique num nome lista os grupos e produtores e liga o escritório às
 *      famílias com ponto na CAF (linhas em dg-getec-rede).
 * O bucket privado é servido de data/privado/ (interceptação). Requer as saídas
 * de build_getec_grupos.py, build_unidades_idr.py e servidores-idr.json.
 *
 * Uso: node scripts/qa-getec-grupos.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const ler = (rel) => JSON.parse(readFileSync(new URL(rel, PRIVADO), 'utf8'));
const GETEC = ler('getec-grupos.json');
const SERV = ler('servidores-idr.json');
const UNID = ler('unidades-idr-pr.geojson');

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const comPonto = (ext) => new Set(ext.grupos.flatMap((g) => g.clientes.filter((c) => c.lon != null).map((c) => `${c.lon},${c.lat}`))).size;
// UME cuja lotação tem um extensionista com entre 5 e 80 famílias no mapa.
let alvo = null;
for (const f of UNID.features) {
  const p = f.properties;
  if (p.tipo !== 'ume') continue;
  const ext = SERV.servidores.find((s) => s.extensionista && norm(s.municipio) === norm(p.municipio)
    && GETEC.extensionistas[s.id] && comPonto(GETEC.extensionistas[s.id]) >= 5 && comPonto(GETEC.extensionistas[s.id]) <= 80);
  if (ext) { alvo = { p, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], ext, n: comPonto(GETEC.extensionistas[ext.id]) }; break; }
}
if (!alvo) throw new Error('nenhuma UME com extensionista de 5 a 80 famílias no mapa');

const { check, finish } = createReport('qa-getec-grupos');
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

const painelTexto = () => page.evaluate(() => document.querySelector('#datageo-ficha')?.textContent ?? '');
const pontoTela = (lo, la) => page.evaluate((lo2, la2) => {
  const { engine } = window.__godsEyeView;
  const q = engine.project(lo2, la2);
  const r = engine.container.getBoundingClientRect();
  return { x: r.left + q.x, y: r.top + q.y };
}, lo, la);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-unidades-idr', true);
  const { stats } = await waitForStats(page, 'datageo-unidades-idr', 's => s.count > 0 || s.error', 120_000);
  check('unidades carregam', stats?.count > 0, stats);
  await setCamera(page, { lon: alvo.lon, lat: alvo.lat, alt: 3_000 });
  await waitMapIdle(page, 60_000);
  const pt = await pontoTela(alvo.lon, alvo.lat);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => /Extensionistas \(/.test(document.querySelector('#datageo-ficha')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {});
  await sleep(800);
  const painel = await painelTexto();
  check('painel da UME lista os extensionistas', painel.includes(alvo.p.nome) && painel.includes(alvo.ext.nome), painel.slice(0, 300));
  check('painel traz a contagem de assistidos do GETEC', /\d+ assistidos/.test(painel), painel.match(/[^\n]*assistidos[^\n]*/)?.[0]);
  await page.evaluate((id) => document.querySelector(`#datageo-ficha button[data-ext="${id}"]`)?.click(), alvo.ext.id);
  await sleep(1500);
  const depois = await painelTexto();
  const linhas = await page.evaluate(() => window.__godsEyeView.engine.map.querySourceFeatures('dg-getec-rede')
    .filter((f) => f.geometry.type === 'LineString').length);
  // O nome vem do GETEC (Título), não do RH (MAIÚSCULAS): compara normalizado.
  check('clique no nome: grupos e produtores', norm(depois).includes(norm(`Grupos de assistidos · ${alvo.ext.nome}`)), depois.slice(0, 400));
  check('clique no nome: linhas do escritório às famílias', linhas >= Math.min(alvo.n, 5), { linhas, esperado: alvo.n });
  check('painel sem mojibake', !/�/.test(depois));
  await page.mouse.move(5, 450);
  await sleep(500);
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
