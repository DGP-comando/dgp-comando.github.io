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
  argValue, createReport, launchQaBrowser, openApp, setCamera, setLayer, waitMapIdle,
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
  const usoSrc = () => page.evaluate(() => {
    const src = window.__gevEngine.map.getSource('dg-uso-solo');
    return src ? { url: src.url, coords: src.coordinates } : null;
  });
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 60_000 });
  await waitMapIdle(page, 60_000);
  const pg = await usoSrc();
  check('uso do solo: imagem de Ponta Grossa no image source', /\/uso-solo\/4119905\.png$/.test(pg?.url ?? ''), pg);
  check('uso do solo: cantos em volta de Ponta Grossa', pg?.coords?.[0]?.[0] < -50.1 && pg?.coords?.[1]?.[0] > -50.0, pg?.coords);
  const png = await page.evaluate(async () => (await fetch('/data/uso-solo/4119905.png')).headers.get('content-type'));
  check('uso do solo: PNG servido', /image\/png/.test(png ?? ''), png);
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
  check('uso do solo: imagem trocou para Curitiba', /4106902\.png$/.test((await usoSrc())?.url ?? ''));

  // Troca de mapa base com a camada ligada: o image source vai junto.
  await page.evaluate(() => window.__gevEngine.setBasemap('osm'));
  await waitMapIdle(page, 60_000);
  check('troca de mapa base mantém a imagem do uso do solo', /4106902\.png$/.test((await usoSrc())?.url ?? ''), await usoSrc());
  await page.evaluate(() => window.__gevEngine.setBasemap('esri'));

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
