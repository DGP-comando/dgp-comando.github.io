#!/usr/bin/env node
/**
 * qa-armazens-privado — Armazéns (CONAB) com duas versões:
 *   1. sem sessão: a camada lê o público (nem pede o bucket) e o armazém de
 *      pessoa física aparece com o rótulo genérico, sem endereço nem e-mail;
 *   2. com sessão mockada (localStorage do Auth): a camada lê
 *      /privado/armazens-conab-pr.geojson e o tooltip traz nome real, endereço e e-mail.
 * Bucket servido de data/privado/ por interceptação, como no qa-fontes-protegidas;
 * pedido com a anon key leva 400, como no bucket de verdade. Não imprime dado pessoal.
 *
 * Uso: node scripts/qa-armazens-privado.mjs [--url http://localhost:5173]
 */
import { readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';
import { ANON_KEY } from '../src/data/datageoAuth.js';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const ARQ = 'armazens-conab-pr.geojson';
const PRIV = readFileSync(new URL(`../data/privado/${ARQ}`, import.meta.url));
const PUB = JSON.parse(readFileSync(new URL(`../public/data/${ARQ}`, import.meta.url), 'utf8'));
const feats = JSON.parse(PRIV.toString('utf8')).features;
// Armazém de pessoa física com e-mail e endereço, sem outro ponto a menos de ~500 m.
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const alvo = feats.find((f) => /física/i.test(f.properties.pessoa ?? '') && f.properties.email && f.properties.endereco
  && feats.every((o) => o === f || dist(o.geometry.coordinates, f.geometry.coordinates) > 0.005));
const [LON, LAT] = alvo.geometry.coordinates;
const P = alvo.properties;

const { check, finish } = createReport('qa-armazens-privado');

async function rodada(comSessao) {
  const { browser, page, errors } = await launchQaBrowser({
    viewport: { width: 1440, height: 900 },
    ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|400|401|DataGeo/i,
  });
  const pedidos = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const m = /\/storage\/v1\/object\/authenticated\/datageo-privado\/([^?]+)/.exec(req.url());
    if (!m) return req.continue();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
    pedidos.push(m[1]);
    const anon = (req.headers().authorization ?? '') === `Bearer ${ANON_KEY}`;
    if (anon || m[1] !== ARQ) return req.respond({ status: 400, headers: cors, body: '{}' });
    return req.respond({ status: 200, headers: cors, contentType: 'application/geo+json', body: PRIV });
  });
  if (comSessao) {
    await page.evaluateOnNewDocument(() => {
      const exp = Math.floor(Date.now() / 1000) + 86_400;
      localStorage.setItem('datageo-auth', JSON.stringify({
        access_token: 'qa-token', refresh_token: 'qa-refresh', token_type: 'bearer', expires_in: 86_400, expires_at: exp,
        user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated', app_metadata: { datageo: true }, user_metadata: {} },
      }));
    });
  }
  const tag = comSessao ? 'com sessão' : 'sem sessão';
  try {
    await openApp(page, url);
    await page.keyboard.press('Escape');
    await setLayer(page, 'datageo-armazens', true);
    const { stats } = await waitForStats(page, 'datageo-armazens', 's => s.count > 0 || s.error', 120_000);
    check(`${tag}: um ponto por armazém`, stats?.count === PUB.features.length, { count: stats?.count, esperado: PUB.features.length });
    check(`${tag}: ${ARQ} ${comSessao ? 'pedido' : 'não pedido'} ao bucket`, pedidos.includes(ARQ) === comSessao, pedidos.filter((p) => p === ARQ));

    await setCamera(page, { lon: LON, lat: LAT, alt: 3_000 });
    await waitMapIdle(page, 60_000);
    const tip = await hoverTooltip(page, LON, LAT, comSessao ? /E-mail/ : /pessoa física/);
    if (comSessao) {
      check('com sessão: nome real, endereço e e-mail no tooltip',
        tip.includes(P.nome) && tip.includes(P.endereco) && tip.includes(P.email) && /Código CONAB/.test(tip), { len: tip.length });
    } else {
      check('sem sessão: rótulo genérico, sem nome, endereço nem e-mail',
        /Armazém de pessoa física/.test(tip) && !tip.includes(P.nome) && !tip.includes(P.endereco) && !/E-mail|Endereço/.test(tip),
        { len: tip.length });
    }
    check(`${tag}: sem erros de página`, errors.length === 0, errors.slice(0, 5));
  } finally {
    await browser.close();
  }
}

await rodada(false);
await rodada(true);
finish();
