// node --test src/maplibre/layers/energiaLogistica.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import layers, {
  legendWithCounts, pointFeatures, rgba, transmissaoFeatures, transmissaoTooltipHtml, vtWrap,
} from './energiaLogistica.js';
import {
  ARMAZEM_LEGENDA, USINA_LEGENDA, agroindustriaIdrEstilo, agroindustriaIdrTooltipHtml, agroindustriaTooltipHtml,
  armazemEstilo, ceasaEstilo, linhaTransmissaoClasse, rotaTuristicaEstilo, rotaTuristicaTooltipHtml,
  subestacaoEstilo, usinaEstilo,
} from '../../data/energiaLogisticaEstilos.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../../../public/data/${name}`, import.meta.url), 'utf8'));

test('ids na ordem do painel, com fontes/layers dg-', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-transmissao', 'datageo-distribuicao', 'datageo-subestacoes', 'datageo-geracao',
    'datageo-armazens', 'datageo-agroindustrias', 'datageo-agroindustrias-idr', 'datageo-rotas-turisticas',
    'datageo-ceasas',
  ]);
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  assert.equal(byId['datageo-transmissao'].category, 'Infraestrutura');
  assert.equal(byId['datageo-geracao'].category, 'Infraestrutura');
  assert.equal(byId['datageo-armazens'].category, 'Logística agro');
  assert.equal(byId['datageo-ceasas'].icon, '🥬');
});

test('rgba converte hex + alpha', () => {
  assert.equal(rgba('#fbbf24', 0.85), 'rgba(251,191,36,0.85)');
  assert.equal(rgba('#ffffff'), 'rgba(255,255,255,1)');
});

test('classe das linhas de transmissão', () => {
  assert.equal(linhaTransmissaoClasse({ planejada: true, tensao: 525 }), 'planejada');
  assert.equal(linhaTransmissaoClasse({ tensao: 525 }), 'kv525');
  assert.equal(linhaTransmissaoClasse({ tensao: '230' }), 'kv230');
  assert.equal(linhaTransmissaoClasse({ tensao: 138 }), 'baixa');
});

test('transmissaoFeatures conta trechos como o app e marca a classe', () => {
  const gj = {
    features: [
      { properties: { tensao: 525 }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { properties: { planejada: true }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]], [[4, 4]]] } },
      { properties: {}, geometry: null },
    ],
  };
  const { features, count } = transmissaoFeatures(gj);
  assert.equal(count, 3);
  assert.deepEqual(features.map((f) => f.properties.__classe), ['kv525', 'planejada']);
  const real = transmissaoFeatures(data('linhas-transmissao-pr.geojson'));
  assert.ok(real.count >= 297);
});

test('tooltip da transmissão escapa o nome', () => {
  const html = transmissaoTooltipHtml({ nome: 'LT <x>', tensao: 230, ano: 2019, planejada: false });
  assert.match(html, /LT &lt;x&gt;/);
  assert.match(html, /230 kV/);
  assert.match(html, /Em operação desde 2019/);
});

test('pointFeatures: estilo, contagem por grupo e id para o tooltip', () => {
  const gj = {
    features: [
      { properties: { kind: 'porto', nome: 'Porto' }, geometry: { coordinates: [-48.5, -25.5] } },
      { properties: { kind: 'armazem', nome: 'Silo', cap_t: 60_000 }, geometry: { coordinates: [-50, -24] } },
      { properties: { kind: 'armazem', nome: 'Sem coord' }, geometry: { coordinates: [null, 1] } },
    ],
  };
  const { features, counts, props } = pointFeatures(gj, armazemEstilo);
  assert.deepEqual(counts, { porto: 1, armazem: 1 });
  assert.equal(features[0].properties.__size, 12);
  assert.equal(features[0].properties.__color, 'rgba(249,115,22,1)');
  assert.equal(features[1].properties.__label, 'Silo · 60 mil t');
  assert.equal(features[1].properties.__size, 7);
  assert.equal(features[1].properties.__ld, 45_000);
  assert.equal(props[features[1].id].nome, 'Silo');
  assert.deepEqual(legendWithCounts(ARMAZEM_LEGENDA, counts), [
    { label: 'Armazém', color: '#fbbf24', count: 1 },
    { label: 'Porto', color: '#f97316', count: 1 },
  ]);
});

test('usinas: tamanho por potência, aerogerador e tipo desconhecido', () => {
  assert.equal(usinaEstilo({ tipo: 'uhe', nome: 'X', pot_kw: 600_000 }).size, 13);
  assert.equal(usinaEstilo({ tipo: 'uhe', nome: 'X', pot_kw: 600_000 }).labelMaxDist, 1_500_000);
  assert.equal(usinaEstilo({ tipo: 'pch', nome: 'Y', pot_kw: 60_000 }).size, 7);
  assert.equal(usinaEstilo({ tipo: 'aerogerador', nome: 'A1', alt: 90 }).label, 'Aerogerador A1 · 90 m');
  assert.equal(usinaEstilo({ tipo: 'nuclear' }), null);
  const { counts } = pointFeatures(data('usinas-pr.geojson'), usinaEstilo);
  const legend = legendWithCounts(USINA_LEGENDA, counts);
  assert.equal(legend.length, 7);
  assert.equal(legend.find((l) => l.label === 'Aerogerador').count, 106);
  assert.equal(legend.reduce((a, l) => a + l.count, 0), 977);
});

test('subestações: prevista em âmbar com ano no rótulo', () => {
  const s = subestacaoEstilo({ nome: 'SE X', planejada: true, ano: 2030, tensao: '525/230' });
  assert.equal(s.color, '#fbbf24');
  assert.equal(s.label, 'SE X (prevista 2030) · 525/230 kV');
  assert.equal(subestacaoEstilo({ nome: 'SE Y', tensao: 230 }).grupo, 'existente');
});

test('cadastro IDR: grupo pela matéria-prima', () => {
  assert.equal(agroindustriaIdrEstilo({ 'Matéria-prima': 'Vegetal' }).grupo, 'vegetal');
  assert.equal(agroindustriaIdrEstilo({ 'Matéria-prima': 'Animal' }).grupo, 'animal');
  assert.equal(agroindustriaIdrEstilo({ 'GETEC · Tipo': 'Mista' }).grupo, 'mista');
  assert.equal(agroindustriaIdrEstilo({ 'Matéria-prima': 'Animal; Vegetal' }).color, '#c084fc');
});

test('cada labelMaxDist dos dados reais tem layer de rótulo', () => {
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  const cases = [
    ['datageo-subestacoes', 'subestacoes-pr.geojson', subestacaoEstilo],
    ['datageo-geracao', 'usinas-pr.geojson', usinaEstilo],
    ['datageo-armazens', 'armazens-conab-pr.geojson', armazemEstilo],
    ['datageo-rotas-turisticas', 'rotas-turisticas-pr.geojson', rotaTuristicaEstilo],
    ['datageo-ceasas', 'ceasas-pr.geojson', ceasaEstilo],
  ];
  for (const [id, file, estilo] of cases) {
    const filters = new Set(byId[id].layers.filter((l) => l.type === 'symbol').map((l) => l.filter[2]));
    for (const f of pointFeatures(data(file), estilo).features) {
      assert.ok(filters.has(f.properties.__ld), `${id}: sem layer para ${f.properties.__ld}`);
    }
  }
  // Tetos de escala viram minzoom: rótulo de armazém só de perto, CEASA no estado.
  const minz = (id, part) => byId[id].layers.find((l) => l.id.includes(part)).minzoom;
  assert.ok(minz('datageo-armazens', 'label-45k') > 11);
  assert.ok(minz('datageo-ceasas', 'label-2500k') < 6);
});

test('tooltips do app escapam e vão embrulhados com a largura', () => {
  const agro = agroindustriaTooltipHtml({ kind: 'frigorifico', nome: '<b>F</b>', municipio: 'Toledo' });
  assert.match(agro, /&lt;b&gt;F&lt;\/b&gt;/);
  assert.match(agro, /Frigorífico/);
  assert.match(agro, /Toledo - PR/);
  assert.equal(agroindustriaTooltipHtml({ kind: 'x' }), '');
  const idr = agroindustriaIdrTooltipHtml({ id: 1, 'Agroindústria': 'Queijaria', 'Município': 'Castro', Produtos: 'Queijo & nata' });
  assert.match(idr, /Queijaria/);
  assert.match(idr, /Produtos:<\/span> Queijo &amp; nata/);
  assert.doesNotMatch(idr, />id:/);
  const rota = rotaTuristicaTooltipHtml({ rota: 'Rota da Uva e do Vinho', nome: 'Vinícola', descricao: 'a\nb' });
  assert.match(rota, /🍇 Vinícola/);
  assert.match(rota, /a<br>b/);
  assert.equal(vtWrap('<i>x</i>', 720), '<div class="dg-vt dg-vt-w720"><i>x</i></div>');
  assert.equal(vtWrap(''), '');
});

test('tooltip do ponto usa as propriedades originais pelo id (IDR sem chaves internas)', async () => {
  const idr = layers.find((l) => l.id === 'datageo-agroindustrias-idr');
  const gj = { features: [{ properties: { 'Agroindústria': 'Q', 'Município': 'M', 'Matéria-prima': 'Vegetal' }, geometry: { coordinates: [-50, -25] } }] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(gj), { status: 200 });
  let set = null;
  try {
    const n = await idr.load({ setData: (id, d) => { set = [id, d]; } });
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(set[0], 'dg-agroindustrias-idr');
  const f = set[1].features[0];
  const html = idr.tooltip(f.properties, f);
  assert.match(html, /Matéria-prima:/);
  assert.doesNotMatch(html, /__size|__label/);
  assert.deepEqual(idr.rowControls().legend.map((l) => l.count), [1, 0, 0]);
  // Sem tooltip no app: o rótulo.
  const ceasas = layers.find((l) => l.id === 'datageo-ceasas');
  assert.match(ceasas.tooltip({ __label: 'CEASA <C>' }, { id: 0 }), /CEASA &lt;C&gt;/);
});
