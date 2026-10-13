#!/usr/bin/env node
/**
 * shots-el-nino — capturas da camada Perspectiva El Niño para relatórios:
 * estado inteiro por variável e mês, e um tooltip de exemplo.
 *
 * Uso: node scripts/shots-el-nino.mjs --url http://localhost:5173 --out pasta
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  argValue, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const LAYER = 'datageo-el-nino';
const url = argValue('--url', 'http://localhost:5173');
const out = argValue('--out', 'shots-el-nino');
fs.mkdirSync(out, { recursive: true });
const { browser, page } = await launchQaBrowser({ viewport: { width: 1600, height: 1000 }, ignoreConsole: /./ });

const clicar = async (id) => {
  await page.evaluate((lid, cid) => document.querySelector(`[data-layer-id="${lid}"] .data-toggle-chip[data-chip-id="${cid}"]`)?.click(), LAYER, id);
  await sleep(900);
};
const foto = async (nome) => {
  await waitMapIdle(page, 60_000);
  await sleep(800);
  await page.screenshot({ path: path.join(out, `${nome}.jpg`), type: 'jpeg', quality: 82 });
  console.log('ok', nome);
};

try {
  await openApp(page, url);
  const base = argValue('--base', 'osm-vector');
  await page.evaluate((b) => window.__gevEngine.setBasemap(b), base);
  await sleep(1500);
  await setLayer(page, 'datageo-municipios', false);
  await setLayer(page, LAYER, true);
  await waitForStats(page, LAYER, 's => s.count > 0 || s.error', 60_000);
  const estado = { lon: -51.45, lat: -24.65, alt: 760_000 };
  await setCamera(page, estado);
  const vistas = [
    ['chuva', 'm-0', '01-chuva-out'], ['chuva', 'm-1', '02-chuva-nov'], ['chuva', 'm-2', '03-chuva-dez'],
    ['chuva', 'm-3', '04-chuva-jan'], ['chuva', 'm-5', '05-chuva-mar'], ['excesso', 'm-1', '06-excesso-nov'],
    ['sinal', 'm-1', '07-sinal-nov'], ['sinal', 'm-0', '08-sinal-out'], ['temp', 'm-2', '09-temp-dez'],
  ];
  for (const [v, m, nome] of vistas) {
    await clicar(`v-${v}`);
    await clicar(m);
    await foto(nome);
  }
  await clicar('v-chuva');
  await clicar('m-1');
  await setLayer(page, 'datageo-municipios', true);
  await setCamera(page, { lon: -53.3, lat: -25.0, alt: 260_000 });
  await waitMapIdle(page, 60_000);
  const f = await interactiveFeature(page, LAYER);
  if (f) await hoverTooltip(page, -53.46, -24.96, /Chuva esperada/);
  await foto('10-tooltip-cascavel-nov');
} finally {
  await browser.close();
}
