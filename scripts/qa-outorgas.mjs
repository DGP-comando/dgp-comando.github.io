#!/usr/bin/env node
/**
 * qa-outorgas — outorgas de água do IAT ao vivo (GeoPR): imagens do
 * MapServer/export de longe, pontos do FeatureServer e tooltip de perto,
 * chave Tipo/Atividade nos chips, ficha por atividade; no fim, a camada de
 * licenciamento ambiental do IAT (mesma mecânica, chave Modalidade/Atividade).
 *
 * Uso: node scripts/qa-outorgas.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando e acesso a geopr.iat.pr.gov.br.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-outorgas');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });

const tiles = [];
page.on('response', (r) => {
  if (r.url().includes('geopr.iat.pr.gov.br') && r.url().includes('/MapServer/export')) tiles.push({ url: r.url(), status: r.status() });
});
const clickChip = (lid, cid) => page.evaluate(([l, c]) => {
  document.querySelector(`[data-layer-id="${l}"] .data-toggle-chip[data-chip-id="${c}"]`)?.click();
}, [lid, cid]);
const rowText = (lid) => page.evaluate((l) => document.querySelector(`[data-layer-id="${l}"]`)?.textContent ?? '', lid);

try {
  await openApp(page, url);
  await setLayer(page, 'datageo-outorgas', true);

  // Longe: imagens do export.
  await setCamera(page, { lon: -53.6, lat: -24.6, alt: 250_000 });
  await waitMapIdle(page, 60_000);
  check('imagens do MapServer/export carregam (200)', tiles.length > 0 && tiles.every((t) => t.status === 200), tiles.map((t) => t.status));

  // Chave: chip Atividade troca as imagens (classes por desc_finalidades) e a legenda.
  tiles.length = 0;
  await clickChip('datageo-outorgas', 'modo-atividade');
  await waitMapIdle(page, 60_000);
  const porAtividade = tiles.filter((t) => decodeURIComponent(t.url).includes('desc_finalidades+LIKE'));
  check('chip Atividade: imagens por atividade (200/304)', porAtividade.length > 0 && porAtividade.every((t) => t.status === 200 || t.status === 304),
    tiles.map((t) => t.status));
  check('chip Atividade: legenda de atividades', /Criação animal/.test(await rowText('datageo-outorgas')));

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
    check('ponto com atividade e tooltip com a linha Atividade', Boolean(f.props?.atividade) && /Atividade/.test(txt),
      [f.props?.atividade, txt.slice(0, 300)]);
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
  const secaoLic = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
      .some((h) => h.textContent.startsWith('Licenciamento ambiental')), { timeout: 60_000 }).catch(() => {});
    return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
      .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith('Licenciamento ambiental'))?.textContent ?? null);
  };
  const fichaLic = await secaoLic();
  check('ficha municipal: licenciamento por modalidade e atividade',
    /Licenças com validade em dia: \d/.test(fichaLic ?? '') && /Por modalidade/.test(fichaLic ?? '') && /Agropecuária/.test(fichaLic ?? ''),
    fichaLic?.slice(0, 400));
  check('ficha municipal: outorgas por tipo', /Outorgas vigentes: \d/.test(ficha ?? '') && /Capt\. superficial/.test(ficha ?? ''),
    ficha?.slice(0, 300));
  check('ficha municipal: outorgas por atividade', /Por atividade/.test(ficha ?? '') && /Criação animal/.test(ficha ?? ''),
    ficha?.slice(0, 500));
  await page.evaluate(async () => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Teste', meta: '', ibges: ['4117909', '4106407'] });
  });
  const reg = await secaoOutorgas();
  const regLic = await secaoLic();
  check('ficha regional: licenciamento somado', /Licenças com validade em dia: \d/.test(regLic ?? '') && /Por atividade/.test(regLic ?? ''),
    regLic?.slice(0, 300));
  check('ficha regional: outorgas somadas, com atividade', /Outorgas vigentes: \d/.test(reg ?? '') && /Por atividade/.test(reg ?? ''),
    reg?.slice(0, 300));

  // Licenciamento ambiental do IAT.
  await page.evaluate(() => document.querySelector('#datageo-ficha .fx-close, #datageo-ficha [data-close]')?.click());
  await setLayer(page, 'datageo-outorgas', false);
  await setLayer(page, 'datageo-licenciamento', true);
  tiles.length = 0;
  await setCamera(page, { lon: -53.6, lat: -24.6, alt: 250_000 });
  await waitForStats(page, 'datageo-licenciamento', 's => s.count > 0 || s.error', 120_000);
  await page.waitForSelector('[data-layer-id="datageo-licenciamento"] .data-toggle-chip', { timeout: 30_000 }).catch(() => {});
  await waitMapIdle(page, 60_000);
  const lic = tiles.filter((t) => t.url.includes('licencas_ambientais_sia_sga'));
  check('licenciamento: imagens por modalidade (200)', lic.length > 0 && lic.every((t) => t.status === 200), lic.map((t) => t.status));
  check('licenciamento: legenda de modalidades', /Licença de operação/.test(await rowText('datageo-licenciamento')));
  await clickChip('datageo-licenciamento', 'modo-atividade');
  await waitMapIdle(page, 60_000);
  check('licenciamento: chip Atividade troca a legenda', /Agropecuária/.test(await rowText('datageo-licenciamento')));
  await setCamera(page, { lon: -53.74, lat: -24.72, alt: 8_000 }); // Toledo
  await waitMapIdle(page, 60_000);
  let l = null;
  for (let i = 0; i < 40 && !l; i++) {
    l = await interactiveFeature(page, 'datageo-licenciamento');
    if (!l) await sleep(500);
  }
  const ltxt = l ? await hoverTooltip(page, l.lon, l.lat, /licenciamento/) : '';
  check('licenciamento: ponto com classes e tooltip', Boolean(l?.props?.classe && l?.props?.atividade) && /Validade/.test(ltxt),
    [l?.props, ltxt.slice(0, 300)]);
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
finish();
