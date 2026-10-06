#!/usr/bin/env node
/**
 * qa-aspectos-fisicos — aba Aspectos físicos: imagens do GeoPR (declividade,
 * hidrografia, nascentes, curvas) respondem 200, a altimetria desenha, o uso
 * do solo só aparece com município selecionado e segue a seleção, e a ficha
 * (municipal e regional) traz Relevo, Hidrografia e Uso do solo.
 *
 * Uso: node scripts/qa-aspectos-fisicos.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando e acesso a geopr.iat.pr.gov.br.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-aspectos-fisicos');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });

const tiles = [];
page.on('response', (r) => {
  if (r.url().includes('geopr.iat.pr.gov.br')) tiles.push({ url: r.url(), status: r.status() });
});
const rowText = (lid) => page.evaluate((l) => document.querySelector(`[data-layer-id="${l}"]`)?.textContent ?? '', lid);
const secao = async (titulo) => {
  await page.waitForFunction((t) => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
    .some((h) => h.textContent.startsWith(t)), { timeout: 60_000 }, titulo).catch(() => {});
  return page.evaluate((t) => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith(t))?.textContent ?? null, titulo);
};
const abreFicha = (ibge, nome) => page.evaluate(async ([i, n]) => {
  const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
  await openMunicipioFicha(i, n);
}, [ibge, nome]);

try {
  await openApp(page, url);
  check('aba Aspectos físicos no painel', await page.evaluate(() => document.body.textContent.includes('Aspectos físicos')));

  // Ponta Grossa, perto: tudo ligado.
  for (const id of ['datageo-altimetria', 'datageo-declividade', 'datageo-hidrografia', 'datageo-nascentes', 'datageo-curvas-nivel']) {
    await setLayer(page, id, true);
  }
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 9_000 });
  await waitMapIdle(page, 90_000);
  for (const [nome, servico] of [['declividade', 'zee_declividade'], ['hidrografia', 'rede_otto_trech_drena_2020_iat/'],
    ['nascentes', 'fbds_nascentes'], ['curvas', 'curvas_de_nivel_1_50000_20m']]) {
    const t = tiles.filter((x) => x.url.includes(servico));
    check(`${nome}: imagens do GeoPR (200)`, t.length > 0 && t.every((x) => x.status === 200), t.map((x) => x.status));
  }
  const relevo = await page.evaluate(() => {
    const m = window.__gevEngine.map;
    return Boolean(m.getLayer('dg-altimetria-cor')) && m.getLayoutProperty('dg-altimetria-cor', 'visibility') !== 'none';
  });
  check('altimetria: color-relief no estilo e visível', relevo);
  check('altimetria: legenda por faixa', /600-800 m/.test(await rowText('datageo-altimetria')));
  check('declividade: legenda', /20-45 %/.test(await rowText('datageo-declividade')));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-relevo.png') });
  for (const id of ['datageo-altimetria', 'datageo-declividade', 'datageo-nascentes', 'datageo-curvas-nivel']) {
    await setLayer(page, id, false);
  }

  // Uso do solo: vazio sem município, depois o município da ficha.
  await setLayer(page, 'datageo-uso-solo', true);
  check('uso do solo: pede um município', /Clique num município/.test(await rowText('datageo-uso-solo')));
  await abreFicha('4119905', 'Ponta Grossa');
  await page.waitForFunction(() => /ha/.test(document.querySelector('[data-layer-id="datageo-uso-solo"]')?.textContent ?? ''),
    { timeout: 30_000 }).catch(() => {});
  check('uso do solo: legenda com classes e hectares', /Agricultura Anual/.test(await rowText('datageo-uso-solo')));
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 30_000 });
  await waitMapIdle(page, 60_000);
  let f = null;
  for (let i = 0; i < 20 && !f; i++) {
    f = await interactiveFeature(page, 'datageo-uso-solo');
    if (!f) await sleep(500);
  }
  check('uso do solo: polígonos na tela', Boolean(f), f);
  if (f) {
    const txt = await hoverTooltip(page, f.lon, f.lat, /Uso do solo/);
    check('uso do solo: tooltip com área e parcela', /Área no município/.test(txt) && /Ponta Grossa/.test(txt), txt.slice(0, 300));
  }
  if (shot) await page.screenshot({ path: shot });

  // Ficha municipal.
  const rel = await secao('Relevo');
  check('ficha: relevo com altitude e declividade', /Altitude: [\d.]+ a [\d.]+ m/.test(rel ?? '') && /Declividade/.test(rel ?? ''), rel?.slice(0, 300));
  const hid = await secao('Hidrografia');
  check('ficha: drenagem e nascentes', /Drenagem: [\d.,]+ km/.test(hid ?? '') && /Nascentes: [\d.]+/.test(hid ?? ''), hid?.slice(0, 300));
  const us = await secao('Uso do solo');
  check('ficha: uso do solo por classe', /ha mapeados/.test(us ?? '') && /Floresta Nativa/.test(us ?? ''), us?.slice(0, 300));

  // Troca de município: o uso do solo acompanha.
  await abreFicha('4106902', 'Curitiba');
  await page.waitForFunction(() => /Área Urbanizada/.test(document.querySelector('[data-layer-id="datageo-uso-solo"]')?.textContent ?? ''),
    { timeout: 30_000 }).catch(() => {});
  check('uso do solo segue a seleção (Curitiba urbanizada)', /Área Urbanizada/.test(await rowText('datageo-uso-solo')));

  // Regional.
  await page.evaluate(async () => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Teste', meta: '', ibges: ['4119905', '4106902'] });
  });
  const reg = await secao('Hidrografia');
  check('ficha regional: hidrografia somada', /Nascentes: [\d.]+/.test(reg ?? ''), reg?.slice(0, 200));
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
