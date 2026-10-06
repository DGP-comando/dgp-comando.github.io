#!/usr/bin/env node
/**
 * qa-pessoa-search — busca por produtor (CAF) e extensionista ao lado da
 * localização: digitar um nome lista, Enter abre o cadastro / o escritório com
 * a rede. Bucket privado servido de data/privado/ (interceptação).
 *
 * Uso: node scripts/qa-pessoa-search.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import { argValue, createReport, launchQaBrowser, openApp, sleep } from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const ler = (rel) => JSON.parse(readFileSync(new URL(rel, PRIVADO), 'utf8'));
const CAF = ler('caf-pontos.json');
const SERV = ler('servidores-idr.json');
const GETEC = ler('getec-grupos.json');
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const prod = CAF.p.find((r) => r[5] && r[5].split(' ').length >= 3 && CAF.status[r[8]] === 'ok');
const ext = SERV.servidores.find((s) => s.extensionista && GETEC.extensionistas[s.id]?.grupos?.length);

const { check, finish } = createReport('qa-pessoa-search');
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

const painel = () => page.evaluate(() => document.querySelector('#datageo-ficha')?.textContent ?? '');
async function buscar(modo, texto) {
  await page.evaluate((m) => {
    document.getElementById('location-bar')?.classList.remove('collapsed');
    const sel = document.getElementById('pessoa-search-modo');
    sel.value = m;
    sel.dispatchEvent(new Event('change'));
  }, modo);
  await page.click('#pessoa-search', { clickCount: 3 });
  await page.type('#pessoa-search', texto);
  await page.waitForSelector('#pessoa-search-results .location-search-option', { timeout: 60_000 }).catch(() => {});
  return page.$$eval('#pessoa-search-results .location-search-option', (els) => els.map((e) => e.textContent));
}

try {
  await openApp(page, url);
  const visivel = await page.evaluate(() => {
    document.getElementById('location-bar')?.classList.remove('collapsed');
    const r = document.getElementById('pessoa-search')?.getBoundingClientRect();
    return r && r.width > 40 && r.height > 10;
  });
  check('caixa de busca por pessoa visível ao lado da localização', visivel);

  const [nomeProd, caf] = [prod[5], prod[2]];
  const termos = nomeProd.split(' ');
  const opcoes = await buscar('produtor', `${termos.at(-1)} ${termos[0]}`.toLowerCase());
  check('produtor: lista com o nome (termos fora de ordem, minúsculas)', opcoes.some((o) => o.includes(nomeProd)), opcoes.slice(0, 3));
  const i = opcoes.findIndex((o) => o.includes(`CAF ${caf}`));
  for (let k = 0; k <= i; k += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction((c) => (document.querySelector('#datageo-ficha')?.textContent ?? '').includes(`CAF ${c}`), { timeout: 90_000 }, caf).catch(() => {});
  check('produtor: abre o cadastro da família', (await painel()).includes(`CAF ${caf}`), (await painel()).slice(0, 200));
  await sleep(1500);
  const centro = await page.evaluate(() => window.__godsEyeView.engine.map.getCenter());
  check('produtor: mapa voa até o ponto', Math.abs(centro.lng - prod[0]) < 0.01 && Math.abs(centro.lat - prod[1]) < 0.01, { centro, ponto: prod.slice(0, 2) });
  check('produtor: camada CAF ligada', await page.evaluate(() => window.__godsEyeView.layerHost.isVisible('datageo-caf')));

  const opcoesExt = await buscar('extensionista', ext.nome.split(' ').slice(0, 2).join(' '));
  check('extensionista: lista com o nome', opcoesExt.some((o) => o.includes(ext.nome)), opcoesExt.slice(0, 3));
  const j = opcoesExt.findIndex((o) => o.includes(ext.nome));
  for (let k = 0; k <= j; k += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Grupos de assistidos/.test(document.querySelector('#datageo-ficha')?.textContent ?? ''), { timeout: 90_000 }).catch(() => {});
  await sleep(1500);
  const txt = await painel();
  check('extensionista: abre os grupos de assistidos dele', norm(txt).includes(norm(`Grupos de assistidos · ${GETEC.extensionistas[ext.id].nome}`)), txt.slice(0, 300));
  const linhas = await page.evaluate(() => window.__godsEyeView.engine.map.querySourceFeatures('dg-getec-rede').length);
  check('extensionista: rede desenhada', linhas > 0, { linhas });
  check('sem mojibake', !/�/.test(txt));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
