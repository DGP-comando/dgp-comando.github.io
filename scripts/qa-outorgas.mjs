#!/usr/bin/env node
/**
 * qa-outorgas — outorgas de água do IAT ao vivo (GeoPR): imagens do
 * MapServer/export de longe, pontos do FeatureServer e tooltip de perto.
 *
 * Uso: node scripts/qa-outorgas.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando e acesso a geopr.iat.pr.gov.br.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-outorgas');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });

const tiles = [];
page.on('response', (r) => {
  if (r.url().includes('geopr.iat.pr.gov.br') && r.url().includes('/MapServer/export')) tiles.push(r.status());
});

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-outorgas', true);

  // Longe: imagens do export.
  await setCamera(page, { lon: -53.6, lat: -24.6, alt: 250_000 });
  await waitMapIdle(page, 60_000);
  check('imagens do MapServer/export carregam (200)', tiles.length > 0 && tiles.every((s) => s === 200), tiles);

  // Perto (Palotina): pontos vetoriais e tooltip.
  await setCamera(page, { lon: -53.84, lat: -24.28, alt: 12_000 });
  await waitMapIdle(page, 60_000);
  let f = null;
  for (let i = 0; i < 40 && !f; i++) {
    f = await interactiveFeature(page, 'datageo-outorgas');
    if (!f) await sleep(500);
  }
  check('pontos de outorga na vista aproximada', Boolean(f), f);
  if (f) {
    const txt = await hoverTooltip(page, f.lon, f.lat, /IAT/);
    check('tooltip com sistema e tipo', /IAT · (SIGARH|CRH)/.test(txt), txt.slice(0, 300));
    check('tooltip sem mojibake', !/�/.test(txt), txt.slice(0, 300));
  }
  // CRH: efluente (Café Iguaçu, Cornélio Procópio) e hidrelétrica (Salto Apucaraninha).
  for (const [grupo, lon, lat, re] of [['efl', -50.6374, -23.1808, /Lançamento de efluentes/], ['hid', -50.9092, -23.7503, /MW/]]) {
    await setCamera(page, { lon, lat, alt: 6_000 });
    await waitMapIdle(page, 60_000);
    let g = null;
    for (let i = 0; i < 40 && !g; i++) {
      g = await interactiveFeature(page, 'datageo-outorgas', { grupo, sistema: 'CRH' });
      if (!g) await sleep(500);
    }
    const txt = g ? await hoverTooltip(page, g.lon, g.lat, re) : '';
    check(`CRH ${grupo}: ponto e tooltip`, re.test(txt), txt.slice(0, 300) || g);
  }
  // Ficha municipal (Palotina) e regional: seção de outorgas por tipo.
  const secaoOutorgas = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
      .some((h) => h.textContent.startsWith('Outorgas de água')), { timeout: 60_000 }).catch(() => {});
    return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
      .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith('Outorgas de água'))?.textContent ?? null);
  };
  await page.evaluate(async () => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha('4117909', 'Palotina');
  });
  const ficha = await secaoOutorgas();
  check('ficha municipal: outorgas por tipo', /Outorgas vigentes: \d/.test(ficha ?? '') && /Capt\. superficial/.test(ficha ?? ''),
    ficha?.slice(0, 300));
  await page.evaluate(async () => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Teste', meta: '', ibges: ['4117909', '4106407'] });
  });
  const reg = await secaoOutorgas();
  check('ficha regional: outorgas somadas', /Outorgas vigentes: \d/.test(reg ?? ''), reg?.slice(0, 300));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
