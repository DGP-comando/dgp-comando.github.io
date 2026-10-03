// node --test src/maplibre/layers/energiaLogistica.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import layers, {
  legendWithCounts, parseNomeLt, pointFeatures, rgba, transmissaoFeatures, transmissaoTooltipHtml,
} from './energiaLogistica.js';
import {
  ARMAZEM_LEGENDA, USINA_LEGENDA, agroindustriaIdrEstilo, agroindustriaIdrTooltipHtml, agroindustriaTooltipHtml,
  armazemEstilo, armazemTooltipHtml, ceasaEstilo, ceasaTooltipHtml, distribuicaoTooltipHtml, linhaTransmissaoClasse,
  parseRotaDescricao, rotaTuristicaEstilo, rotaTuristicaTooltipHtml, subestacaoEstilo, subestacaoTooltipHtml,
  usinaEstilo, usinaTooltipHtml,
} from '../../data/energiaLogisticaEstilos.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../../../public/data/${name}`, import.meta.url), 'utf8'));

test('ids na ordem do painel, com fontes/layers dg-', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-transmissao', 'datageo-distribuicao', 'datageo-subestacoes', 'datageo-geracao',
    'datageo-armazens', 'datageo-agroindustrias', 'datageo-agroindustrias-idr', 'datageo-rotas-turisticas',
    'datageo-ceasas',
  ]);
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  assert.equal(byId['datageo-transmissao'].category, 'Energia e conectividade');
  assert.equal(byId['datageo-geracao'].category, 'Energia e conectividade');
  assert.equal(byId['datageo-armazens'].category, 'Logística agro');
  assert.equal(byId['datageo-agroindustrias'].category, 'Logística agro');
  // Programas do IDR saem da Logística agro para o grupo próprio.
  assert.equal(byId['datageo-agroindustrias-idr'].category, 'IDR-Paraná');
  assert.equal(byId['datageo-rotas-turisticas'].category, 'IDR-Paraná');
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

test('tooltip da transmissão: trecho, tensão, situação e circuito (tipCard)', () => {
  const html = transmissaoTooltipHtml({ nome: 'LT <x>', tensao: 230, ano: 2019, planejada: false });
  assert.match(html, /^<div class="tt">/);
  assert.match(html, /tt-title">LT &lt;x&gt;</);
  assert.match(html, /<dt>Tensão<\/dt><dd class="">230 kV/);
  assert.match(html, /<dt>Situação<\/dt><dd class="tt-ok">Em operação desde 2019/);
  const real = transmissaoTooltipHtml({ nome: 'LT 230 kV Curitiba Centro - Uberaba, C2 (CD)', tensao: 230, ano: 0, planejada: false, __classe: 'kv230' });
  assert.match(real, /tt-title">Curitiba Centro – Uberaba</);
  assert.match(real, /tt-badge tt-warn">230–440 kV</);
  assert.match(real, /C2 · circuito duplo/);
  assert.doesNotMatch(real, /desde/, 'ano 0 some');
  const plan = transmissaoTooltipHtml({ nome: 'SECC LT 230 kV Curitiba - Joinville Norte, C2 (CD), na SE Joinville Norte 2', tensao: 230, ano: 2034, planejada: true });
  assert.match(plan, /tt-badge tt-warn">Prevista 2034</);
  assert.match(plan, /Seccionamento na SE Joinville Norte 2/);
  assert.deepEqual(parseNomeLt('xyz'), { trecho: '', circuito: '', secc: '' });
  for (const f of data('linhas-transmissao-pr.geojson').features) {
    assert.doesNotMatch(transmissaoTooltipHtml(f.properties), /undefined|NaN/);
  }
  const lt = layers.find((l) => l.id === 'datageo-transmissao');
  assert.deepEqual(lt.interactive, ['dg-transmissao-hit']);
});

test('distribuição: linha de pick larga e tooltip pela tensão da célula', () => {
  const dist = layers.find((l) => l.id === 'datageo-distribuicao');
  assert.deepEqual(dist.interactive, ['dg-distribuicao-hit']);
  const hit = dist.layers.find((l) => l.id === 'dg-distribuicao-hit');
  assert.equal(hit.source, 'dg-distribuicao');
  assert.ok(hit.paint['line-width'] >= 10 && hit.paint['line-opacity'] < 0.05);
  assert.ok(dist.focusOn && dist.onEnable && dist.rowControls);
  const html = distribuicaoTooltipHtml({ kv: 34.5, municipio: { nome: 'Castro' }, trechos: 1234, fonte: 'ANEEL · BDGD COPEL-DIS 2022-12-31 V11' });
  assert.match(html, /tt-title">Rede de distribuição 34,5 kV</);
  assert.match(html, /Copel Distribuição S\.A\./);
  assert.match(html, /<dt>Município<\/dt><dd class="">Castro/);
  assert.match(html, /1\.234 \(quadrícula/);
  assert.match(html, /BDGD COPEL-DIS 2022-12-31 V11/);
  assert.match(dist.tooltip({ grupo: 13.8, trechos: 5 }), /13,8 kV/);
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

test('tooltips dos pontos no formato tipCard, escapados', () => {
  const agro = agroindustriaTooltipHtml({ kind: 'frigorifico', nome: '<b>F</b>', municipio: 'Toledo' });
  assert.match(agro, /tt-title">&lt;b&gt;F&lt;\/b&gt;</);
  assert.match(agro, /Frigorífico/);
  assert.match(agro, /Toledo - PR/);
  assert.match(agro, /Inspeção Federal/);
  assert.equal(agroindustriaTooltipHtml({ kind: 'x' }), '');

  const idr = agroindustriaIdrTooltipHtml({
    id: 1, 'Agroindústria': 'Queijaria', 'Município': 'Castro', Regional: 'Ponta Grossa', Produtos: 'Queijo & nata',
    'Situação legal': 'Sim', 'Pessoas da família': '3', 'Contratados permanentes': '1', 'Venda direta': '60',
    'Mercado institucional': '40', 'Necessidade: gestão': 'Alta', 'Necessidade: BPF': 'Baixa', 'Necessidade: rotulagem': 'Alta',
    'Checagem da coordenada': 'FORA do município declarado', 'Observações': 'x'.repeat(400),
  });
  assert.match(idr, /^<div class="tt tt-wide">/);
  assert.match(idr, /tt-sub">Castro - PR · Regional Ponta Grossa</);
  assert.match(idr, /tt-badge tt-ok">Legalizada</);
  assert.match(idr, /<dt>Mão de obra<\/dt><dd class="">3 da família · 1 contratado\(s\)/);
  assert.match(idr, /<dt>Canais<\/dt><dd class="">direta 60% · institucional 40%/);
  assert.match(idr, /<dt>Alta<\/dt><dd class="tt-warn">gestão, rotulagem<\/dd><dt>Baixa<\/dt><dd class="">BPF/);
  assert.match(idr, /<dd class="tt-warn">FORA do município/);
  assert.match(idr, /<dt>Produtos<\/dt><dd class="">Queijo &amp; nata/);
  assert.match(idr, /tt-note">x{200,}…</);
  assert.doesNotMatch(idr, />id</);

  const rota = rotaTuristicaTooltipHtml({
    rota: 'Rota do Queijo Paranaense', nome: 'Queijaria Cornelia - Arapoti - PR',
    descricao: 'Queijos: Tipo Gouda.\nRegistro: SIM 0013/21\nExperiências turísticas:\n- Visita guiada;\n- Degustação.\n\nContato e horários de funcionamento:\nGezina (43) 98817-0172\n',
  });
  assert.match(rota, /🧀<\/span><span class="tt-title">Queijaria Cornelia</);
  assert.match(rota, /tt-sub">Rota do Queijo Paranaense · Arapoti</);
  assert.match(rota, /<dt>Produtos<\/dt><dd class="">Tipo Gouda/);
  assert.match(rota, /<dt>Registro<\/dt><dd class="">SIM 0013\/21/);
  assert.match(rota, /<dt>Experiências<\/dt><dd class="">Visita guiada; Degustação/);
  assert.match(rota, /<dt>Telefone<\/dt><dd class="">\(43\) 98817-0172/);
  const uva = parseRotaDescricao('Município:\nPiên\n\nProdutos comercializados:\nUva, Vinhos.\n\nQual a experiência turística que vai ofertar?\nColha e pague, Vindima\n\nTelefone: 47996067225\n@vinicolasocreppa\nE-mail: a@b.com');
  assert.equal(uva.municipio, 'Piên');
  assert.equal(uva.produtos, 'Uva, Vinhos');
  assert.equal(uva.experiencias, 'Colha e pague, Vindima');
  assert.equal(uva.email, 'a@b.com');
  assert.match(uva.site, /@vinicolasocreppa/);
  for (const f of data('rotas-turisticas-pr.geojson').features) {
    const h = rotaTuristicaTooltipHtml(f.properties);
    assert.doesNotMatch(h, /undefined|NaN/);
    assert.match(h, /<dt>(Produtos|Experiências|Telefone)<\/dt>|tt-note/, f.properties.nome);
  }

  const se = subestacaoTooltipHtml({ nome: 'SE Areia', tensao: '525/230/138', ano: '1997', planejada: false });
  assert.match(se, /tt-sub">Subestação · 525 kV</);
  assert.match(se, /525\/230\/138 kV/);
  assert.match(se, /Em operação desde<\/dt><dd class="">1997/);
  assert.doesNotMatch(subestacaoTooltipHtml({ nome: 'SE X', tensao: '230', ano: '-', planejada: false }), /desde/);
  assert.match(subestacaoTooltipHtml({ nome: 'SE P', tensao: '230/138/34,5', ano: '2030', planejada: true }), /Prevista.*34,5 kV|34,5 kV.*Prevista/s);

  const usina = usinaTooltipHtml({ tipo: 'uhe', nome: 'Foz do Areia', pot_kw: 1676000 });
  assert.match(usina, /tt-sub">Usina hidrelétrica \(UHE\)</);
  assert.match(usina, /tt-badge tt-alert">UHE</);
  assert.match(usina, /1\.676 MW/);
  assert.match(usinaTooltipHtml({ tipo: 'cgh', nome: 'C', pot_kw: 450 }), /0,45 MW/);
  assert.match(usinaTooltipHtml({ tipo: 'aerogerador', nome: 'Água Doce', pot_kw: 600, alt: 86.6 }), /600 kW.*86,6 m/s);
  assert.equal(usinaTooltipHtml({ tipo: 'x' }), '');

  const arm = armazemTooltipHtml({ kind: 'armazem_conab', nome: 'Coop', municipio: 'Toledo', tipo: 'Chapï¿½u Chines', cap_t: 21410 });
  assert.match(arm, /Chapéu chinês/);
  assert.match(arm, /21\.410 t/);
  assert.match(armazemTooltipHtml({ kind: 'porto', nome: 'Porto de Paranaguá', municipio: 'Paranaguá', tipo: 'porto graneleiro' }), /tt-badge tt-warn">Porto</);

  const ceasa = ceasaTooltipHtml({ nome: 'CEASA Londrina' });
  assert.match(ceasa, /<dt>Município<\/dt><dd class="">Londrina/);

  for (const [file, fn] of [
    ['subestacoes-pr.geojson', subestacaoTooltipHtml], ['usinas-pr.geojson', usinaTooltipHtml],
    ['armazens-conab-pr.geojson', armazemTooltipHtml], ['ceasas-pr.geojson', ceasaTooltipHtml],
  ]) {
    for (const f of data(file).features) {
      const h = fn(f.properties);
      assert.match(h, /^<div class="tt">/, file);
      assert.doesNotMatch(h, /undefined|NaN|ï¿½/, `${file}: ${h}`);
    }
  }
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
  assert.match(html, /<dt>Matéria-prima<\/dt><dd class="">Vegetal/);
  assert.doesNotMatch(html, /__size|__label/);
  assert.deepEqual(idr.rowControls().legend.map((l) => l.count), [1, 0, 0]);
  // Sem as propriedades originais (antes do load): o rótulo, no mesmo formato.
  const ceasas = layers.find((l) => l.id === 'datageo-ceasas');
  assert.match(ceasas.tooltip({ __label: 'CEASA <C>' }, { id: 0 }), /tt-title">CEASA &lt;C&gt;</);
});
