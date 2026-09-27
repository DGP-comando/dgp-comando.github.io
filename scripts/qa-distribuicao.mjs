#!/usr/bin/env node
/**
 * qa-distribuicao — liga a camada de linhas de distribuição sobre Curitiba e
 * confere que as células carregam e viram feições no mapa, a camada some
 * acima do teto de altura (minzoom do layer MapLibre) e o disable esconde tudo. Salva screenshot.
 *
 * Uso: node scripts/qa-distribuicao.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, launchQaBrowser, openApp, renderedFeatures, setCamera, sleep, waitMapIdle, zoomGatedLayers,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-distribuicao.png');
const LAYER_ID = 'datageo-distribuicao';
const LAYERS = '^dg-distribuicao-';

const { check, finish } = createReport('qa-distribuicao');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

try {
  page.on('console', (m) => { if (/datageo-distribuicao/.test(m.text())) console.log('   console:', m.text()); });
  await openApp(page, url);
  const setView = (alt) => setCamera(page, { lat: -25.45, lon: -49.27, alt });

  await setView(30_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const loaded = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      if (stats.count > 0 && !stats.loading) return { ms: Math.round(performance.now() - t0), count: stats.count, error: stats.error };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('células carregadas em Curitiba', !loaded.timedOut && loaded.count > 10_000, loaded);

  await waitMapIdle(page);
  const drawn = await renderedFeatures(page, 'dg-distribuicao-');
  check('as linhas aparecem no mapa (feições renderizadas)', drawn.count > 0, drawn);
  await sleep(1_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  await setView(400_000);
  await sleep(1_000);
  const alto = await zoomGatedLayers(page, LAYERS);
  check('acima do teto os layers ficam fora da faixa de zoom', alto.shown.length === 0 && alto.gated.length > 0, alto);

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  await sleep(500);
  const desligada = await zoomGatedLayers(page, LAYERS);
  check('desligar esconde todos os layers', desligada.shown.length === 0 && desligada.gated.length === 0, desligada);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

finish();
