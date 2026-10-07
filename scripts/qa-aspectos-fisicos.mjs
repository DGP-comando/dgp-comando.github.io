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
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, sleep, openApp, setCamera, setLayer, waitMapIdle,
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
  // Hidrografia: tooltip do trecho (zoom 12+, trechos da vista vindos do FeatureServer).
  let trecho = null;
  for (let i = 0; i < 40 && !trecho; i++) {
    trecho = await interactiveFeature(page, 'datageo-hidrografia');
    if (!trecho) await sleep(500);
  }
  check('hidrografia: trechos da vista para o hover', Boolean(trecho), trecho);
  if (trecho) {
    const tip = await hoverTooltip(page, trecho.lon, trecho.lat, /Hidrografia · trecho/);
    check('hidrografia: tooltip do trecho com Strahler e comprimento', /Hidrografia · trecho/.test(tip) && /Ordem de Strahler/.test(tip)
      && /Comprimento do trecho/.test(tip), tip.slice(0, 300));
    const realce = await page.evaluate(() => window.__gevEngine.map.queryRenderedFeatures({ layers: ['dg-hidrografia-trechos-hit'] })
      .some((f) => window.__gevEngine.map.getFeatureState({ source: 'dg-hidrografia-trechos', id: f.id }).hover));
    check('hidrografia: trecho sob o cursor realçado', realce);
  }
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
  // Tooltip pelo pixel do PNG: o centro de Ponta Grossa é área urbanizada.
  await page.waitForFunction(() => (window.__gevEngine.map.getSource('dg-uso-solo-area')?.serialize().data?.features?.length ?? 0) > 0,
    { timeout: 30_000 }).catch(() => {});
  const contornoN = () => page.evaluate(() => window.__gevEngine.map.getSource('dg-uso-solo-contorno')
    ?.serialize().data?.features?.[0]?.geometry?.coordinates?.length ?? 0);
  const tipCentro = await hoverTooltip(page, -50.16, -25.095, /Uso do solo/);
  check('uso do solo: tooltip com a classe do pixel', /Área Urbanizada/.test(tipCentro) && /Classe no município/.test(tipCentro)
    && /Ponta Grossa/.test(tipCentro), tipCentro.slice(0, 300));
  // Área deste polígono: a mancha urbana contínua, menor ou igual ao total da classe (10.047 ha).
  const haPoligono = Number((/Área deste polígono≈ ([\d.,]+) ha/.exec(tipCentro)?.[1] ?? '').replace(/\./g, '').replace(',', '.'));
  check('uso do solo: área do polígono sob o cursor', haPoligono > 1000 && haPoligono <= 10_047 * 1.01, haPoligono);
  const nSeg = await contornoN();
  check('uso do solo: contorno do polígono destacado no hover', nSeg > 4, nSeg);
  const tipRural = await hoverTooltip(page, -50.33, -25.0, /Uso do solo/);
  check('uso do solo: tooltip rural com outra classe', /Uso do solo/.test(tipRural) && !/Área Urbanizada/.test(tipRural), tipRural.slice(0, 200));
  check('uso do solo: contorno troca para o polígono novo', (await contornoN()) !== nSeg && (await contornoN()) > 0);
  await page.mouse.move(5, 450); // fora do mapa
  await page.waitForFunction(() => !(window.__gevEngine.map.getSource('dg-uso-solo-contorno')?.serialize().data?.features?.length),
    { timeout: 5_000 }).catch(() => {});
  check('uso do solo: contorno some ao sair', (await contornoN()) === 0);
  // Filtro pela legenda: esconder "Área Urbanizada" repinta o PNG (blob) e tira o tooltip dela.
  const clicaLegenda = (lid, key) => page.evaluate(([l, k]) => {
    const el = document.querySelector(`[data-layer-id="${l}"] .data-toggle-legend-item[data-key="${CSS.escape(k)}"]`);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return Boolean(el);
  }, [lid, key]);
  check('uso do solo: legenda clicável', await clicaLegenda('datageo-uso-solo', 'Área Urbanizada'));
  await page.waitForFunction(() => /^blob:/.test(window.__gevEngine.map.getSource('dg-uso-solo')?.url ?? ''), { timeout: 15_000 }).catch(() => {});
  check('uso do solo: classe escondida repinta a imagem', /^blob:/.test((await usoSrc())?.url ?? ''), (await usoSrc())?.url);
  const tipEscondida = await hoverTooltip(page, -50.16, -25.095, /Uso do solo/);
  check('uso do solo: sem tooltip sobre classe escondida', !/Área Urbanizada/.test(tipEscondida), tipEscondida.slice(0, 120));
  await clicaLegenda('datageo-uso-solo', 'Área Urbanizada');
  await page.waitForFunction(() => /4119905\.png$/.test(window.__gevEngine.map.getSource('dg-uso-solo')?.url ?? ''), { timeout: 15_000 }).catch(() => {});
  check('uso do solo: mostrar de novo volta à imagem original', /4119905\.png$/.test((await usoSrc())?.url ?? ''), (await usoSrc())?.url);
  await page.mouse.move(5, 450);
  // Declividade: mesmo tooltip com área e contorno (PNG invisível da ZEE recortada).
  await setLayer(page, 'datageo-uso-solo', false);
  await setLayer(page, 'datageo-declividade', true);
  await page.waitForFunction(() => (window.__gevEngine.map.getSource('dg-declividade-mancha-area')?.serialize().data?.features?.length ?? 0) > 0,
    { timeout: 30_000 }).catch(() => {});
  const tipDecl = await hoverTooltip(page, -50.33, -25.0, /Declividade/);
  check('declividade: tooltip com classe e área do polígono', /Declividade/.test(tipDecl) && /Área deste polígono≈ [\d.,]+ ha/.test(tipDecl)
    && /Classe no município/.test(tipDecl) && /Ponta Grossa/.test(tipDecl), tipDecl.slice(0, 300));
  const nDecl = await page.evaluate(() => window.__gevEngine.map.getSource('dg-declividade-mancha-contorno')
    ?.serialize().data?.features?.[0]?.geometry?.coordinates?.length ?? 0);
  check('declividade: contorno do polígono destacado', nDecl > 0, nDecl);
  await page.mouse.move(5, 450);
  // Filtro pela legenda na declividade: o export do GeoPR ganha layerDefs sem a classe.
  await clicaLegenda('datageo-declividade', '>45');
  const tilesDecl = await page.evaluate(() => decodeURIComponent(window.__gevEngine.map.getSource('dg-declividade')?.serialize().tiles?.[0] ?? ''));
  check('declividade: classe escondida vai no layerDefs do GeoPR', /layerDefs=\{"0":".*>45/.test(tilesDecl), tilesDecl.slice(-160));
  await clicaLegenda('datageo-declividade', '>45');
  const tilesDecl2 = await page.evaluate(() => window.__gevEngine.map.getSource('dg-declividade')?.serialize().tiles?.[0] ?? '');
  check('declividade: mostrar de novo tira o filtro', !/layerDefs/.test(tilesDecl2));
  await setLayer(page, 'datageo-declividade', false);
  await setLayer(page, 'datageo-uso-solo', true);
  // Rotular o maior município (Guarapuava, 313 mil ha) não pode travar o mapa.
  const ms = await page.evaluate(async () => {
    const { rotulaManchas, areasManchas, caixasManchas } = await import('/src/maplibre/layers/manchasRaster.js');
    const img = new Image();
    img.src = '/data/uso-solo/4109401.png';
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    const c2d = c.getContext('2d', { willReadFrequently: true });
    c2d.drawImage(img, 0, 0);
    const { data } = c2d.getImageData(0, 0, c.width, c.height);
    const t0 = performance.now();
    const m = rotulaManchas(data, c.width, c.height);
    areasManchas(m, c.width, c.height, [-52, -26, -51, -25]);
    caixasManchas(m, c.width, c.height);
    return Math.round(performance.now() - t0);
  });
  check('uso do solo: manchas do maior município em menos de 1,5 s', ms < 1500, `${ms} ms`);
  // Camada normal por cima (UC estadual: APA da Escarpa Devoniana em Ponta Grossa)
  // mantém o tooltip dela; o uso do solo só vence as bases.
  await setLayer(page, 'datageo-ucs-estaduais', true);
  await setCamera(page, { lon: -49.9616, lat: -25.1545, alt: 30_000 });
  await waitMapIdle(page, 60_000);
  const tipUc = await hoverTooltip(page, -49.9616, -25.1545, /ESCARPA|Escarpa/);
  check('UC por cima do uso do solo mantém o tooltip da UC', /Escarpa/i.test(tipUc) && !/Uso do solo ·/.test(tipUc), tipUc.slice(0, 200));
  await setLayer(page, 'datageo-ucs-estaduais', false);
  await setCamera(page, { lon: -50.16, lat: -25.09, alt: 60_000 });
  await waitMapIdle(page, 60_000);
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
