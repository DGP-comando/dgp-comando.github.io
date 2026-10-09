#!/usr/bin/env node
/**
 * qa-pivos — pivôs centrais de irrigação: 302 carregados, pontos no estado,
 * círculos de perto, tooltip com o vínculo da outorga, legenda filtrável.
 *
 * Uso: node scripts/qa-pivos.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-pivos');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });
const visiveis = (lid, campo) => page.evaluate(([l, c]) => [...new Set(window.__gevEngine.map
  .queryRenderedFeatures({ layers: [l] }).map((f) => f.properties[c]))], [lid, campo]);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-pivos', true);
  const st = await waitForStats(page, 'datageo-pivos', 's => s.count > 0 || s.error', 60_000);
  check('302 pivôs carregados', st.stats?.count === 302, st.stats);

  // Estado inteiro: pontos.
  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const ids = await visiveis('dg-pivos-pt', 'id');
  check('estado: pontos na tela', ids.length > 100, ids.length);

  // Legenda: Shift em SEM OUTORGA deixa só esses.
  const clicou = await page.evaluate(() => {
    const el = document.querySelector('[data-layer-id="datageo-pivos"] .data-toggle-legend-item[data-key="SEM OUTORGA"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return Boolean(el);
  });
  await sleep(600);
  const so = await visiveis('dg-pivos-pt', 'vinculo');
  check('legenda: Shift deixa só os sem outorga', clicou && so.length === 1 && so[0] === 'SEM OUTORGA', so);
  await page.evaluate(() => document.querySelector('[data-layer-id="datageo-pivos"] .data-toggle-legend-item[data-key="SEM OUTORGA"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  await sleep(400);

  // De perto: círculo do PR-001 (Foz do Iguaçu, 275 ha).
  await setCamera(page, { lon: -54.413, lat: -25.333, alt: 6_000 });
  await waitMapIdle(page, 60_000);
  const circ = await visiveis('dg-pivos-fill', 'id');
  check('de perto: círculo do pivô', circ.includes('PR-001'), circ);
  const f = await interactiveFeature(page, 'datageo-pivos');
  const tip = f ? await hoverTooltip(page, f.lon, f.lat, /Pivô/) : '';
  check('tooltip: pivô, área, demanda e outorga, com acento', /Pivô PR-\d+/.test(tip) && /Demanda estimada/.test(tip) && /Iguaçu/.test(tip), tip.slice(0, 240));
  check('tooltip: sem requerente', !/FLAVIO|Requerente/i.test(tip));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
