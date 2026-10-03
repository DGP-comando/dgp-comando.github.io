#!/usr/bin/env node
/**
 * qa-defesa-agropecuaria — cadastros da ADAPAR (bucket privado):
 *   1. as sete camadas aparecem sob o cabeçalho "Defesa Agropecuária";
 *   2. cada camada de estabelecimentos carrega todos os pontos do arquivo, a
 *      legenda traz a contagem de cada grupo e o hover num ponto isolado abre o
 *      tooltip com razão social e município acentuados;
 *   3. as propriedades com exploração pecuária (arquivo gzipado) carregam todas,
 *      com a legenda por DAP/CAF e o tooltip da propriedade.
 * O bucket privado é servido de data/privado/ (interceptação de
 * /storage/v1/object/authenticated/datageo-privado/*), porque o dev roda sem
 * login. Requer os arquivos de scripts/build_adapar.py.
 *
 * Uso: node scripts/qa-defesa-agropecuaria.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  argValue, createReport, hoverTooltip, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';
import {
  AGROTOXICOS_LEGENDA, ANIMAIS_LEGENDA, CONSOLIDACAO_LEGENDA, FERTILIZANTES_LEGENDA, INDUSTRIAS_LEGENDA, VETERINARIOS_LEGENDA,
  agrotoxicoEstilo, animaisVivosEstilo, consolidacaoEstilo, fertilizanteEstilo, industriaEstilo, veterinarioEstilo,
} from '../src/data/defesaAgropecuariaEstilos.js';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PRIVADO = new URL('../data/privado/', import.meta.url);
const GRUPO = 'Defesa Agropecuária';
const EXPLORACOES = { id: 'datageo-adapar-exploracoes', arq: 'adapar-exploracoes.json.gz' };

const PONTOS = [
  { id: 'datageo-adapar-veterinarios', arq: 'adapar-veterinarios-pr.geojson', estilo: veterinarioEstilo, legenda: VETERINARIOS_LEGENDA },
  { id: 'datageo-adapar-animais-vivos', arq: 'adapar-animais-vivos-pr.geojson', estilo: animaisVivosEstilo, legenda: ANIMAIS_LEGENDA },
  { id: 'datageo-adapar-agrotoxicos', arq: 'adapar-agrotoxicos-pr.geojson', estilo: agrotoxicoEstilo, legenda: AGROTOXICOS_LEGENDA },
  { id: 'datageo-adapar-fertilizantes', arq: 'adapar-fertilizantes-pr.geojson', estilo: fertilizanteEstilo, legenda: FERTILIZANTES_LEGENDA },
  { id: 'datageo-adapar-unidades-consolidacao', arq: 'adapar-unidades-consolidacao-pr.geojson', estilo: consolidacaoEstilo, legenda: CONSOLIDACAO_LEGENDA },
  { id: 'datageo-adapar-industrias-poa', arq: 'adapar-industrias-poa-pr.geojson', estilo: industriaEstilo, legenda: INDUSTRIAS_LEGENDA },
];

/** Primeiro item sem vizinho na célula de ~1 km nem nas 8 ao redor que passe em `serve`. */
function isolado(itens, coord, serve = () => true) {
  const celula = (c) => `${Math.round(c[0] * 100)},${Math.round(c[1] * 100)}`;
  const n = new Map();
  for (const it of itens) n.set(celula(coord(it)), (n.get(celula(coord(it))) ?? 0) + 1);
  const sozinho = (it) => {
    const [x, y] = coord(it);
    let soma = 0;
    for (const dx of [-0.01, 0, 0.01]) for (const dy of [-0.01, 0, 0.01]) soma += n.get(celula([x + dx, y + dy])) ?? 0;
    return soma === 1;
  };
  return itens.find((it) => serve(it) && sozinho(it));
}

for (const { arq } of [...PONTOS, EXPLORACOES]) {
  if (!existsSync(new URL(arq, PRIVADO))) {
    console.error(`falta data/privado/${arq}: rode py -3 scripts/build_adapar.py`);
    process.exit(2);
  }
}

const { check, finish } = createReport('qa-defesa-agropecuaria');
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
  // O .gz vai como o bucket entrega: bytes gzipados, sem Content-Encoding.
  const tipo = m[1].endsWith('.gz') ? 'application/gzip' : 'application/json';
  return req.respond({ status: 200, headers: cors, contentType: tipo, body: readFileSync(arq) });
});

/** Contagem como o painel mostra (manager.js): 1459 -> "1.5K". */
const abrev = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

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
  for (const { id } of [EXPLORACOES, ...PONTOS]) check(`${id} sob "${GRUPO}"`, grupoDe[id] === GRUPO, grupoDe[id]);

  // 2. Estabelecimentos: contagem, legenda e tooltip.
  for (const { id, arq, estilo, legenda } of PONTOS) {
    const feats = JSON.parse(readFileSync(new URL(arq, PRIVADO), 'utf8')).features;
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
    const linhas = legenda.filter((g) => esperado[g.grupo]).map((g) => `${g.label} ${abrev(esperado[g.grupo])}`);
    check(`${id}: legenda com contagem por grupo`, linhas.every((l) => leg.includes(l)), { leg, linhas });

    const acento = (f) => /[ãçéáíóúâêô]/i.test(`${f.properties['Razão social']}${f.properties['Município']}`);
    const alvo = isolado(feats, (f) => f.geometry.coordinates, acento) ?? isolado(feats, (f) => f.geometry.coordinates);
    const [lon, lat] = alvo.geometry.coordinates;
    await setCamera(page, { lon, lat, alt: 15_000 });
    await waitMapIdle(page, 60_000);
    await sleep(800);
    const tt = await hoverTooltip(page, lon, lat, /ADAPAR/);
    check(`${id}: tooltip com ${alvo.properties['Razão social']} · ${alvo.properties['Município']}`,
      tt.includes(alvo.properties['Razão social']) && tt.includes(alvo.properties['Município'])
        && tt.includes(alvo.properties.CNPJ) && !/undefined|NaN|Ã£|Ã§/.test(tt), tt.slice(0, 300));
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, `-${id}.png`) });
    await setLayer(page, id, false);
    await page.mouse.move(10, 10);
  }

  // 3. Propriedades com exploração pecuária.
  const dados = JSON.parse(gunzipSync(readFileSync(new URL(EXPLORACOES.arq, PRIVADO))).toString('utf8'));
  await setCamera(page, { lon: -51.4, lat: -24.6, alt: 900_000 });
  const t0 = Date.now();
  await setLayer(page, EXPLORACOES.id, true);
  const se = await waitForStats(page, EXPLORACOES.id, 's => s.count > 0 || s.error', 120_000);
  check(`${EXPLORACOES.id}: ${dados.p.length} propriedades em ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    se.stats?.count === dados.p.length, se.stats);
  await sleep(800);
  const legE = await legendaDe(EXPLORACOES.id);
  const porGrupo = dados.grupos.map((g, i) => `${g} ${abrev(dados.p.filter((p) => p[3] === i).length)}`);
  check(`${EXPLORACOES.id}: legenda por DAP/CAF`, porGrupo.every((l) => legE.includes(l)), { legE, porGrupo });
  if (shot) {
    await waitMapIdle(page, 120_000);
    await sleep(1_500);
    await page.screenshot({ path: shot });
  }
  const prop = isolado(dados.p, (p) => p, (p) => p[7] > 0 && p[5] && !p[4] && /[ÃÇÉÁÍÓÚÂÊÔ]/.test(p[6] + p[8]));
  await setCamera(page, { lon: prop[0], lat: prop[1], alt: 15_000 });
  await waitMapIdle(page, 120_000);
  await sleep(1_000);
  const te = await hoverTooltip(page, prop[0], prop[1], /ADAPAR/);
  check(`${EXPLORACOES.id}: tooltip com propriedade, produtor, município e área`,
    te.includes(prop[6]) && te.includes(prop[8]) && te.includes(dados.municipios[prop[2]][1]) && / ha/.test(te)
      && !/undefined|NaN|Ã£|Ã§/.test(te), te.replace(prop[8], '<produtor>').slice(0, 300));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, `-${EXPLORACOES.id}.png`) });

  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('execução do QA', false, error.message);
} finally {
  await browser.close();
}
finish();
