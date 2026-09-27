#!/usr/bin/env node
/**
 * qa-agroindustrias — confere as duas camadas de agroindústrias:
 *   1. Agroindústrias (SIGSIF/OSM), cadastro IDR e Rotas turísticas carregam;
 *   2. a linha do painel mostra a legenda com uma entrada por cor;
 *   3. o hover num ponto de cada uma abre o tooltip.
 * Confere também a legenda das outras camadas de pontos que usam a mesma
 * factory (armazéns, CEASAs, subestações, usinas).
 *
 * Uso: node scripts/qa-agroindustrias.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-agroindustrias.png');
const CAMADAS = [
  { id: 'datageo-agroindustrias', min: 100, espera: /Fonte: (SIGSIF|OpenStreetMap)/, cores: 3 },
  { id: 'datageo-agroindustrias-idr', min: 1200, espera: /Situação legal|Matéria-prima/, cores: 3 },
  { id: 'datageo-rotas-turisticas', min: 85, espera: /Rota d/, cores: 2 },
];
const SO_LEGENDA = [
  { id: 'datageo-armazens', cores: 2 },
  { id: 'datageo-ceasas', cores: 1 },
  { id: 'datageo-subestacoes', cores: 2 },
  { id: 'datageo-geracao', cores: 7 },
];

const legendaDe = (page, lid) => page.evaluate((l) => [
  ...document.querySelectorAll(`[data-layer-id="${l}"] .data-toggle-legend-item`),
].map((e) => ({ texto: e.textContent.trim(), cor: e.querySelector('.data-toggle-legend-swatch')?.style.background })), lid);

async function carregar(page, lid) {
  await page.evaluate((l) => window.__godsEyeView.dataManager.setEnabled(l, true, { origin: 'user' }), lid);
  return page.evaluate(async (l) => {
    const mod = window.__godsEyeView.dataManager.layers.get(l)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      const s = mod?.getStats?.() ?? {};
      if (s.count > 0) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true };
  }, lid);
}

const { check, finish } = createReport('qa-agroindustrias');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });
const setView = (lon, lat, alt) => setCamera(page, { lon, lat, alt });

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');
  await sleep(500);

  for (const { id, cores } of SO_LEGENDA) {
    await carregar(page, id);
    await sleep(1_000);
    const leg = await legendaDe(page, id);
    check(`${id}: legenda com ${cores} cor(es)`, leg.length === cores && leg.every((e) => e.cor), leg);
    await page.evaluate((lid) => window.__godsEyeView.dataManager.setEnabled(lid, false, { origin: 'user' }), id);
  }

  for (const { id, min, espera, cores } of CAMADAS) {
    await setView(-51.4, -24.6, 900_000);
    const stats = await carregar(page, id);
    check(`${id}: pontos carregam`, stats.count >= min, stats);
    await sleep(2_000);
    const leg = await legendaDe(page, id);
    // O painel abrevia acima de mil ("1.2K"): a soma vem da própria camada.
    const soma = await page.evaluate((lid) => window.__godsEyeView.dataManager.layers.get(lid).module
      .getRowControls().legend.reduce((t, e) => t + e.count, 0), id);
    check(`${id}: legenda com ${cores} cores somando os pontos`, leg.length === cores && soma === stats.count, { leg, soma });
    await page.screenshot({ path: shot.replace(/\.png$/, `-${id}-estado.png`) });

    await waitMapIdle(page);
    const alvo = await interactiveFeature(page, id);
    let html = '';
    if (alvo) {
      await setView(alvo.lon, alvo.lat, 3_000);
      await waitMapIdle(page);
      await sleep(1_000);
      // As coordenadas vindas do quadro de 900 km são quantizadas pelo tile;
      // de perto, pega de novo a feição mais próxima do centro.
      const perto = (await interactiveFeature(page, id)) ?? alvo;
      html = await hoverTooltip(page, perto.lon, perto.lat, espera);
    }
    await page.screenshot({ path: shot.replace(/\.png$/, `-${id}.png`) });
    check(`${id}: hover abre o tooltip`, espera.test(html), html.slice(0, 160));
    await page.evaluate((lid) => window.__godsEyeView.dataManager.setEnabled(lid, false, { origin: 'user' }), id);
    await page.mouse.move(10, 10);
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

finish();
