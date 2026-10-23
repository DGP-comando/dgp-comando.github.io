#!/usr/bin/env node
/**
 * qa-programas-idr — Unidades de Referência dos programas do IDR (bucket privado):
 *   1. Agroindústrias (cadastro IDR), Rotas turísticas e as camadas novas
 *      aparecem sob o cabeçalho "IDR-Paraná", e nenhuma delas sob "Logística agro";
 *   2. cada camada de URs carrega todos os pontos do arquivo e a legenda do painel
 *      traz a contagem de cada grupo igual à dos dados;
 *   3. o hover num ponto isolado abre o tooltip com produtor e município acentuados;
 *   4. sem camada ligada, o tooltip do município traz a contagem de URs por programa;
 *   5. URs do GETEC (build_getec_urs.py): camada com legenda por família de projeto e
 *      seção "Unidades de Referência · GETEC" na ficha municipal e na regional.
 * O bucket privado é servido de data/privado/ (interceptação de
 * /storage/v1/object/authenticated/datageo-privado/*), porque o dev roda sem
 * login. Requer os arquivos de scripts/build_urs_programas.py.
 *
 * Uso: node scripts/qa-programas-idr.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';
import {
  CAFE_LEGENDA, GETEC_LEGENDA, GRAOS_LEGENDA, PECUARIA_LEGENDA, PISCICULTURA_LEGENDA, cafeEstilo, coordenadaConferida, getecEstilo,
  graosEstilo, pecuariaEstilo, pisciculturaEstilo,
} from '../src/data/programasIdrEstilos.js';
import { ursPorMunicipio } from '../src/data/programasIdr.js';
import { ursTexto } from '../src/data/municipioTooltip.js';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const ler = (n) => JSON.parse(readFileSync(new URL(n, PRIVADO), 'utf8')).features;

const PONTOS = [
  { id: 'datageo-urs-graos', arq: 'urs-graos-pr.geojson', estilo: graosEstilo, legenda: GRAOS_LEGENDA },
  { id: 'datageo-urs-cafe', arq: 'urs-cafe-pr.geojson', estilo: cafeEstilo, legenda: CAFE_LEGENDA },
  { id: 'datageo-urs-piscicultura', arq: 'urs-piscicultura-pr.geojson', estilo: pisciculturaEstilo, legenda: PISCICULTURA_LEGENDA },
  { id: 'datageo-urs-pecuaria-corte', arq: 'urs-pecuaria-corte-pr.geojson', estilo: pecuariaEstilo, legenda: PECUARIA_LEGENDA },
  { id: 'datageo-urs-getec', arq: 'getec-urs-pr.geojson', estilo: getecEstilo, legenda: GETEC_LEGENDA },
];
const PLANILHAS = PONTOS.slice(0, 4); // as do tooltip do município (UR_ARQUIVOS)
const PROGRAMAS = ['datageo-agroindustrias-idr', 'datageo-rotas-turisticas', ...PONTOS.map((c) => c.id)];

/** Ponto sem vizinho a menos de ~2 km (o hover não cai no do lado), de preferência com acento. */
function isolado(feats) {
  const longe = feats.filter((f) => feats.every((o) => o === f || Math.hypot(
    o.geometry.coordinates[0] - f.geometry.coordinates[0], o.geometry.coordinates[1] - f.geometry.coordinates[1],
  ) > 0.02));
  return longe.find((f) => /[ãçéáíóúâêô]/i.test(`${f.properties.Produtor ?? ''}${f.properties['Município']}`)) ?? longe[0];
}

for (const { arq } of PONTOS) {
  if (!existsSync(new URL(arq, PRIVADO))) {
    console.error(`falta data/privado/${arq}: rode py -3 scripts/build_urs_programas.py`);
    process.exit(2);
  }
}

const { check, finish } = createReport('qa-programas-idr');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

await page.setRequestInterception(true);
page.on('request', (req) => {
  const m = /\/storage\/v1\/object\/authenticated\/datageo-privado\/([^?]+)/.exec(req.url());
  if (!m) return req.continue();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
  const arq = new URL(m[1], PRIVADO);
  if (!existsSync(arq)) return req.respond({ status: 404, headers: cors, body: '' });
  return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: readFileSync(arq) });
});

const legendaDe = (lid) => page.evaluate((l) => [
  ...document.querySelectorAll(`[data-layer-id="${l}"] .data-toggle-legend-item`),
].map((e) => e.textContent.trim()), lid);

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');

  // 1. Cabeçalho do grupo de cada linha do painel.
  const grupoDe = await page.evaluate(() => {
    const hdr = document.querySelector('.data-toggle-group-header');
    const out = {};
    let atual = '';
    for (const el of hdr?.parentElement?.children ?? []) {
      if (el.classList.contains('data-toggle-group-header')) atual = el.dataset.group;
      const id = el.getAttribute('data-layer-id') ?? el.querySelector('[data-layer-id]')?.getAttribute('data-layer-id');
      if (id) out[id] = atual;
    }
    return out;
  });
  for (const id of PROGRAMAS) check(`${id} sob "IDR-Paraná"`, grupoDe[id] === 'IDR-Paraná', grupoDe[id]);
  check('Logística agro sem programas do IDR', grupoDe['datageo-armazens'] === 'Logística agro'
    && !PROGRAMAS.some((id) => grupoDe[id] === 'Logística agro'), { armazens: grupoDe['datageo-armazens'] });

  // 4. Tooltip do município (nenhuma camada ligada): o município com mais
  // programas, hover num ponto dele com coordenada conferida.
  const porMun = ursPorMunicipio(PLANILHAS.map(({ arq }) => ({ features: ler(arq) })));
  const [ibgeMun, urs] = Object.entries(porMun)
    .sort((a, b) => Object.keys(b[1].programas).length - Object.keys(a[1].programas).length || b[1].total - a[1].total)[0];
  const alvoMun = PLANILHAS.flatMap(({ arq }) => ler(arq))
    .find((f) => f.properties.ibge === ibgeMun && coordenadaConferida(f.properties));
  const [mlon, mlat] = alvoMun.geometry.coordinates;
  await setCamera(page, { lon: mlon, lat: mlat, alt: 60_000 });
  await waitMapIdle(page, 60_000);
  const tm = await hoverTooltip(page, mlon, mlat, /URs dos programas/);
  const esperadoMun = `URs dos programas (IDR)${ursTexto(urs)}`;
  check(`tooltip do município (${alvoMun.properties['Município']}): ${ursTexto(urs)}`,
    tm.includes(esperadoMun) && tm.includes(alvoMun.properties['Município']), { tm: tm.slice(0, 400), esperadoMun });

  // 2 e 3. Pontos: contagem, legenda e tooltip.
  for (const { id, arq, estilo, legenda } of PONTOS) {
    const feats = ler(arq);
    const esperado = {};
    for (const f of feats) {
      const g = estilo(f.properties).grupo;
      esperado[g] = (esperado[g] ?? 0) + 1;
    }
    await setCamera(page, { lon: -51.4, lat: -24.6, alt: 900_000 });
    await setLayer(page, id, true);
    const st = await waitForStats(page, id, 's => s.count > 0 || s.error', 60_000);
    check(`${id}: ${feats.length} pontos`, st.stats?.count === feats.length, st.stats);
    await sleep(800);
    const leg = await legendaDe(id);
    const linhas = legenda.filter((g) => esperado[g.grupo]).map((g) => `${g.label} ${esperado[g.grupo]}`);
    check(`${id}: legenda com contagem por grupo`, linhas.every((l) => leg.includes(l)), { leg, linhas });

    const alvo = isolado(feats);
    const [lon, lat] = alvo.geometry.coordinates;
    await setCamera(page, { lon, lat, alt: 15_000 });
    await waitMapIdle(page, 60_000);
    await sleep(800);
    const tt = await hoverTooltip(page, lon, lat, /Coordenada/);
    const nome = alvo.properties.Produtor ?? alvo.properties.Unidade;
    check(`${id}: tooltip com ${nome} · ${alvo.properties['Município']}`,
      tt.includes(nome) && tt.includes(alvo.properties['Município']) && !/undefined|NaN|Ã/.test(tt), tt.slice(0, 260));
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, `-${id}.png`) });
    await setLayer(page, id, false);
    await page.mouse.move(10, 10);
  }

  if (shot) {
    for (const { id } of PONTOS) await setLayer(page, id, true);
    await setCamera(page, { lon: -51.6, lat: -24.6, alt: 750_000 });
    await waitMapIdle(page, 60_000);
    await sleep(1_500);
    await page.screenshot({ path: shot });
  }
  // 5. Ficha municipal e regional: URs do GETEC por projeto.
  const getec = ler('getec-urs-pr.geojson');
  const nPor = (ibs) => getec.filter((f) => ibs.includes(f.properties.ibge)).length;
  const [topIbge] = Object.entries(getec.reduce((a, f) => ({ ...a, [f.properties.ibge]: (a[f.properties.ibge] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])[0];
  const topNome = getec.find((f) => f.properties.ibge === topIbge).properties['Município'];
  const secaoUrs = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('#datageo-ficha .fx-section h3')]
      .some((h) => h.textContent.startsWith('Unidades de Referência')), { timeout: 60_000 }).catch(() => {});
    return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
      .find((x) => (x.querySelector('h3')?.textContent ?? '').startsWith('Unidades de Referência'))?.textContent ?? null);
  };
  await page.evaluate(async ([ib, nm]) => {
    const { openFicha } = await import('/src/datageoFicha.js');
    await openFicha({ ibge: ib, nome: nm });
  }, [topIbge, topNome]);
  const fm = await secaoUrs();
  check(`ficha municipal (${topNome}): ${nPor([topIbge])} URs por projeto`,
    (fm ?? '').includes(`URs cadastradas: ${nPor([topIbge])}`) && /Por projeto/.test(fm ?? ''), fm?.slice(0, 400));
  const ibsReg = ['4111209', '4101804', topIbge];
  await page.evaluate(async (l) => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Teste', meta: '', ibges: l });
  }, ibsReg);
  const fr = await secaoUrs();
  check(`ficha regional: ${nPor(ibsReg)} URs somadas`, (fr ?? '').includes(`URs cadastradas: ${nPor(ibsReg).toLocaleString('pt-BR')}`),
    fr?.slice(0, 300));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-ficha.png') });

  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('execução do QA', false, error.message);
} finally {
  await browser.close();
}
finish();
