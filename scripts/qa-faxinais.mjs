#!/usr/bin/env node
/**
 * qa-faxinais — faxinais do IAT (dado público):
 *   1. a camada de pontos carrega os 227 faxinais e o hover mostra nome, município e situação;
 *   2. a camada de perímetros carrega um polígono por faxinal e o hover mostra a resolução ARESUR;
 *   3. sem camada ligada, o tooltip do município traz a contagem de faxinais.
 *
 * Uso: node scripts/qa-faxinais.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const read = (n) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
const PONTOS = read('faxinais-pr.geojson').features;
const POLIS = read('faxinais-territorios-pr.geojson').features;

// Ponto sem vizinho a menos de ~2 km (o hover não cai no faxinal ao lado).
const isolado = PONTOS.find((f) => PONTOS.every((o) => o === f
  || Math.hypot(o.geometry.coordinates[0] - f.geometry.coordinates[0], o.geometry.coordinates[1] - f.geometry.coordinates[1]) > 0.02));
const [PLON, PLAT] = isolado.geometry.coordinates;

/** Ponto dentro do anel (ray casting). */
const dentro = ([x, y], ring) => {
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
};
// Perímetro com resolução e um ponto interno (centro do bbox, se cair dentro).
const poli = POLIS.map((f) => {
  const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  return { f, c: dentro(c, ring) ? c : null };
}).find((x) => x.c && x.f.properties.resolucao && x.f.properties.perimetro !== 'Área Imóvel');
const [GLON, GLAT] = poli.c;

const { check, finish } = createReport('qa-faxinais');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');

  // 0. Tooltip do município (nenhuma camada sob o cursor): total do inventário
  // e ARESUR dos perímetros. Inácio Martins (sem ARESUR) e Pinhão (2 ARESUR de 2013).
  const pinhao = PONTOS.find((f) => f.properties.ibge === '4119301');
  for (const f of [isolado, pinhao]) {
    const { ibge, municipio } = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const total = PONTOS.filter((o) => o.properties.ibge === ibge).length;
    const aresur = POLIS.filter((o) => o.properties.ibge === ibge && o.properties.aresur === 'Sim').length;
    const esperado = `Faxinais (IAT, 2010)${total}${aresur ? `ARESUR (IAT)${aresur} faxina` : ''}`;
    await setCamera(page, { lon, lat, alt: 60_000 });
    await waitMapIdle(page, 60_000);
    const tm = await hoverTooltip(page, lon, lat, /Faxinais/);
    check(`tooltip do município (${municipio}): faxinais e ARESUR`, tm.includes(esperado) && tm.includes(municipio),
      { tm: tm.slice(0, 300), esperado });
  }

  await setLayer(page, 'datageo-faxinais', true);
  const pts = await waitForStats(page, 'datageo-faxinais', 's => s.count > 0 || s.error', 120_000);
  check('pontos: 227 faxinais', pts.stats?.count === 227, pts.stats);
  await setCamera(page, { lon: PLON, lat: PLAT, alt: 20_000 });
  await waitMapIdle(page, 60_000);
  const tp = await hoverTooltip(page, PLON, PLAT, /Situação/);
  check('hover do ponto: nome, município e situação',
    tp.includes(isolado.properties.nome) && tp.includes(isolado.properties.municipio) && /uso comum/i.test(tp), tp.slice(0, 250));
  await setLayer(page, 'datageo-faxinais', false);

  await setLayer(page, 'datageo-faxinais-territorios', true);
  const tr = await waitForStats(page, 'datageo-faxinais-territorios', 's => s.count > 0 || s.error', 120_000);
  check('perímetros: um polígono por faxinal', tr.stats?.count === POLIS.length, { stats: tr.stats, esperado: POLIS.length });
  await setCamera(page, { lon: GLON, lat: GLAT, alt: 15_000 });
  await waitMapIdle(page, 60_000);
  const tg = await hoverTooltip(page, GLON, GLAT, /ARESUR/);
  check('hover do perímetro: resolução ARESUR', tg.includes(poli.f.properties.resolucao) && tg.includes(poli.f.properties.municipio),
    tg.slice(0, 300));

  if (shot) {
    await setLayer(page, 'datageo-faxinais', true);
    await setCamera(page, { lon: -50.9, lat: -25.4, alt: 260_000 });
    await waitMapIdle(page, 60_000);
    await page.screenshot({ path: shot });
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
