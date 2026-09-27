import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  cellFeatures, cellsForView, groupStyles, intersectBbox, layerSpecs, createSlicedLinesLayer,
} from '../slicedLines.js';
import transporte, {
  ESTRADAS_GRUPOS, RODOVIAS_STYLE, conveniadaLayerSpec, conveniadaTooltip, conveniadaValor, conveniadasHitFilter,
  contarPorGrupo, cursorContext, estradaTooltip, ferroviaTooltip, fmtReais, jurisdicaoDe, kmPorChave, lineKm,
  rodoviaTooltip, trackCursor,
} from './transporte.js';
import { GRUPOS } from '../../data/estradasConveniadasTooltip.js';
import { zoomForHeight } from '../kit.js';

const read = (rel) => JSON.parse(readFileSync(new URL(`../../../public/data/${rel}`, import.meta.url), 'utf8'));

test('ids e ordem do grupo transporte', () => {
  assert.deepEqual(transporte.map((l) => l.id), [
    'datageo-ferrovias', 'datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas',
  ]);
  for (const l of transporte) assert.equal(l.category, 'Infraestrutura');
});

test('cellFeatures decodifica uma célula real das estradas em MultiLineStrings por classe', () => {
  const index = read('estradas/index.json');
  const key = Object.keys(index.cells).find((k) => index.cells[k] > 100);
  const feats = cellFeatures(read(`estradas/${key}.json`), key, index, 'classes');
  assert.ok(feats.length >= 1 && feats.length <= 2);
  const [i, j] = key.split('_').map(Number);
  let total = 0;
  for (const f of feats) {
    assert.ok(['urbanas', 'rurais'].includes(f.properties.grupo));
    assert.equal(f.geometry.type, 'MultiLineString');
    assert.equal(f.properties.trechos, f.geometry.coordinates.length);
    total += f.properties.trechos;
    for (const line of f.geometry.coordinates) {
      assert.ok(line.length >= 2);
      for (const [lon, lat] of line) {
        // Trechos podem sair um pouco da célula (cortados pelo 1º vértice).
        assert.ok(Math.abs(lat - (i + 0.5) * index.cell_deg) < index.cell_deg * 2, `${lat}`);
        assert.ok(Math.abs(lon - (j + 0.5) * index.cell_deg) < index.cell_deg * 2, `${lon}`);
      }
    }
  }
  assert.equal(total, index.cells[key]);
});

test('cellFeatures usa o valor do grupo (numérico na distribuição) e ignora grupos vazios', () => {
  const index = { cell_deg: 1, escala: 10, tensoes: [13.8, 34.5], cells: { '0_0': 1 } };
  const feats = cellFeatures({ t: [[], [[1, 1, 2, 2]]] }, '0_0', index, 'tensoes');
  assert.equal(feats.length, 1);
  assert.equal(feats[0].properties.grupo, 34.5);
  assert.deepEqual(feats[0].geometry.coordinates, [[[0.1, 0.1], [0.3, 0.3]]]);
});

test('cellsForView: só células existentes na vista, das mais próximas do centro, até o limite', () => {
  const index = { cell_deg: 0.25, cells: { '-100_-200': 1, '-100_-199': 1, '-99_-200': 1, '-90_-190': 1 } };
  const keys = cellsForView(index, [-50, -25, -49.5, -24.75], { lat: -24.8, lon: -49.9 }, 9);
  assert.deepEqual(keys, ['-100_-200', '-99_-200', '-100_-199']);
  assert.deepEqual(cellsForView(index, [-50, -25, -49.5, -24.75], { lat: -24.9, lon: -49.9 }, 1), ['-100_-200']);
  assert.deepEqual(cellsForView(index, [0, 0, 1, 1], { lat: 0.5, lon: 0.5 }), []);
  assert.deepEqual(intersectBbox([0, 0, 2, 2], [1, 1, 3, 3]), [1, 1, 2, 2]);
  assert.equal(intersectBbox([0, 0, 1, 1], [2, 2, 3, 3]), null);
});

test('estilos das estradas: tetos de 90 km e 30 km viram minzoom, cores do app', () => {
  const st = groupStyles({ grupos: ESTRADAS_GRUPOS, maxHeight: 90_000 });
  const urb = st.find((s) => s.value === 'urbanas');
  const rur = st.find((s) => s.value === 'rurais');
  assert.equal(rur.minzoom, zoomForHeight(90_000));
  assert.equal(urb.minzoom, zoomForHeight(30_000));
  assert.ok(urb.minzoom > rur.minzoom);
  assert.deepEqual([urb.color, urb.opacity, urb.width], ['#f1f5f9', 0.5, 1.0]);
  assert.deepEqual([rur.color, rur.opacity, rur.width], ['#a8a29e', 0.55, 1.2]);
  // styleFor também serve (caso da distribuição: valores numéricos).
  const kv = groupStyles({ grupos: [13.8, 34.5], styleFor: (v) => ({ color: v > 20 ? '#fb7185' : '#34d399', width: 1 }), maxHeight: 70_000 });
  assert.deepEqual(kv.map((s) => s.color), ['#34d399', '#fb7185']);
  const { sourceId, layers } = layerSpecs('distribuicao', kv, zoomForHeight(70_000));
  assert.equal(sourceId, 'dg-distribuicao');
  assert.deepEqual(layers.map((l) => l.id), ['dg-distribuicao-outros', 'dg-distribuicao-0', 'dg-distribuicao-1']);
  assert.deepEqual(layers[2].filter, ['==', ['get', 'grupo'], 34.5]);
});

test('layerSpecs com hitWidth acrescenta uma faixa de pick por grupo', () => {
  const st = groupStyles({ grupos: ['a', 'b'], maxHeight: 50_000 });
  const { layers, hitIds } = layerSpecs('x', st, zoomForHeight(50_000), { hitWidth: 10 });
  assert.deepEqual(hitIds, ['dg-x-hit-0', 'dg-x-hit-1']);
  assert.equal(layers.at(-1).paint['line-width'], 10);
  assert.deepEqual(layerSpecs('x', st, 5).hitIds, []);
});

test('createSlicedLinesLayer devolve uma camada do contrato, sem pick', () => {
  const l = createSlicedLinesLayer({
    id: 'datageo-x', name: 'X', category: 'Infraestrutura', baseUrl: '/data/x', groupsKey: 'classes', grupos: ['a'], maxHeight: 50_000,
  });
  assert.equal(typeof l.focusOn, 'function');
  assert.equal(typeof l.onEnable, 'function');
  assert.deepEqual(Object.keys(l.sources), ['dg-x']);
  assert.deepEqual(l.interactive, []);
  assert.deepEqual(l.rowControls().legend, [{ label: 'a', color: '#ffffff', count: 0 }]);
});

test('rodovias: cores e larguras do app, federais por baixo', () => {
  const rod = transporte.find((l) => l.id === 'datageo-rodovias');
  assert.deepEqual(rod.layers.map((l) => l.id), ['dg-rodovias-fed-line', 'dg-rodovias-est-line', 'dg-rodovias-fed-hit', 'dg-rodovias-est-hit']);
  assert.deepEqual(rod.interactive, ['dg-rodovias-fed-hit', 'dg-rodovias-est-hit']);
  assert.equal(rod.layers[2].paint['line-width'], 12);
  assert.equal(rod.layers[0].paint['line-color'], RODOVIAS_STYLE.federais.color);
  assert.equal(rod.layers[0].paint['line-width'], 2.4);
  assert.equal(rod.layers[1].paint['line-width'], 1.6);
});

test('conveniadas: ordem z, filtro de hover pelos chips, contagem e tooltip escapado', () => {
  const conv = transporte.find((l) => l.id === 'datageo-estradas-conveniadas');
  assert.deepEqual(conv.layers.slice(0, 3).map((l) => l.id), [
    'dg-estradas-conveniadas-automatizado', 'dg-estradas-conveniadas-protocolos', 'dg-estradas-conveniadas-conveniadas',
  ]);
  assert.equal(conveniadaLayerSpec(GRUPOS[0]).paint['line-width'], 4);
  assert.deepEqual(conveniadasHitFilter({ conveniadas: true, protocolos: false, automatizado: true }), [
    'in', ['get', 'grupo'], ['literal', ['conveniadas', 'automatizado']],
  ]);
  assert.deepEqual(contarPorGrupo([{ properties: { grupo: 'protocolos' } }, { properties: { grupo: 'x' } }]), {
    conveniadas: 0, protocolos: 1, automatizado: 0,
  });
  const html = conveniadaTooltip({ grupo: 'conveniadas', Trecho: '<i>T</i>', 'Município': 'Castro', Km: 12 });
  assert.match(html, /class="tt tt-wide"/);
  assert.match(html, /tt-title">&lt;i&gt;T&lt;\/i&gt;/);
  assert.match(html, /tt-badge tt-ok">CONVENIADAS 2026/);
  assert.match(html, /tt-sub">Castro</);
  assert.match(html, /Outros campos.*<dt>Km<\/dt><dd class="">12<\/dd>/);
  assert.doesNotMatch(html, /style=/, 'sem CSS inline: o desenho mora no style.css');
  assert.equal(conveniadaTooltip({ grupo: 'nada' }), '');
  const chips = conv.rowControls().chips;
  assert.deepEqual(chips.map((c) => c.id), ['conveniadas', 'protocolos', 'automatizado']);
});

const text = (html) => html.replace(/<\/(dt|dd|div|span)>/g, '$& ').replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

test('conveniadas: campos reais do build viram seções formatadas em pt-BR', () => {
  const html = conveniadaTooltip({
    grupo: 'conveniadas', Trecho: 'Estrada do Cerne', 'Município': 'Castro', 'Núcleo regional': 'Ponta Grossa',
    Tipo: 'Cascalhamento', 'Extensão (m)': 12345.6, 'Nº convênio': 20260123, Programa: 'Estradas da Integração',
    Situação: 'Em execução', 'Valor global': '1.234.567,89', 'Valor SEAB': 1000000, 'Valor pago': 0,
    'Fonte de recurso': 'Tesouro', '% contrapartida calculada': 0.125, Assinatura: '2026/03/12',
    'Data pagamento': '2026-05-02', 'Detalhes': 'x'.repeat(400),
  });
  const t = text(html);
  assert.match(t, /Estrada do Cerne CONVENIADAS 2026 Castro · NR Ponta Grossa/);
  assert.match(t, /Tipo Cascalhamento Extensão 12,35 km Situação Em execução Programa Estradas da Integração/);
  assert.match(t, /Nº convênio 20260123 /, 'identificador sem separador de milhar');
  assert.match(t, /Recursos Valor global R\$\s1\.234\.567,89 Valor SEAB R\$\s1\.000\.000,00/);
  assert.match(t, /% contrapartida calculada 12,5% Fonte de recurso Tesouro/);
  assert.match(t, /Valor pago R\$\s0,00/);
  assert.match(t, /Datas e empenhos Assinatura 12\/03\/2026 Data pagamento 02\/05\/2026/);
  assert.match(t, /x{280}…/);
  assert.doesNotMatch(t, /Outros campos/);

  const prot = text(conveniadaTooltip({ grupo: 'protocolos', Trecho: 'P1', 'Descrição': 'Pedido da prefeitura', 'Distância (km)': 3.456 }));
  assert.match(prot, /P1 PROTOCOLOS 2025 Protocolos 2025 Distância \(km\) 3,46 km Pedido da prefeitura/);
  const auto = conveniadaTooltip({ grupo: 'automatizado', 'Extensão (m)': 850, 'Origem (id)': 12345 });
  assert.match(text(auto), /Trecho sem nome AUTOMATIZADO 2025 .*Extensão 850 m Origem \(id\) 12345/);
  assert.match(auto, /tt-badge tt-muted/);

  assert.equal(fmtReais('abc'), 'abc');
  assert.equal(conveniadaValor('% contrapartida obrigatória', 20), '20,0%');
  assert.equal(conveniadaValor('Vigência (meses)', 12), '12');
});

test('extensão: haversine e soma por chave', () => {
  // 1° de latitude ~ 111,2 km.
  assert.ok(Math.abs(lineKm({ type: 'LineString', coordinates: [[-50, -25], [-50, -24]] }) - 111.19) < 0.05);
  assert.ok(Math.abs(lineKm({ type: 'MultiLineString', coordinates: [[[-50, -25], [-50, -24.5]], [[-50, -24.5], [-50, -24]]] }) - 111.19) < 0.05);
  assert.equal(lineKm(null), 0);
  const km = kmPorChave([
    { properties: { ref: 'BR-277;BR-373' }, geometry: { type: 'LineString', coordinates: [[-50, -25], [-50, -24]] } },
    { properties: { ref: 'BR-277' }, geometry: { type: 'LineString', coordinates: [[-50, -25], [-50, -24.5]] } },
    { properties: { ref: '' }, geometry: { type: 'LineString', coordinates: [[-50, -25], [-50, -24.5]] } },
  ], (p) => String(p.ref).split(';').filter(Boolean));
  assert.ok(Math.abs(km.get('BR-277') - 166.8) < 0.1);
  assert.ok(Math.abs(km.get('BR-373') - 111.2) < 0.1);
  assert.equal(km.size, 2);
});

test('rodovias: jurisdição pela sigla e tooltip com extensão, município e coincidência', () => {
  assert.equal(jurisdicaoDe('BR-277').orgao, 'DNIT');
  assert.equal(jurisdicaoDe('PRC-280').orgao, 'DER-PR');
  assert.match(jurisdicaoDe('PRC-280').esfera, /coincidente/);
  assert.equal(jurisdicaoDe('PR-418').esfera, 'Estadual');
  assert.equal(jurisdicaoDe('SC-100'), null);
  const kmPorSigla = new Map([['BR-277', 731.4], ['BR-373', 212]]);
  const cur = { lat: -25.43, lon: -49.27, municipio: 'Curitiba', ibge: '4106902' };
  const t = text(rodoviaTooltip({ ref: 'BR-277;BR-373', name: 'Rodovia do Café', km: 1.26 }, { nivel: 'federais', kmPorSigla, cur }));
  assert.match(t, /^🛣️ BR-277 FEDERAL Rodovia federal · Curitiba/);
  assert.match(t, /Denominação Rodovia do Café Trecho coincidente com BR-373 Jurisdição Federal · DNIT/);
  assert.match(t, /Extensão no PR BR-277: 731 km · BR-373: 212 km Segmento 1,3 km/);
  assert.match(t, /Município Curitiba \(IBGE 4106902\) Coordenada -25,4300°, -49,2700°/);
  assert.match(t, /OpenStreetMap · DNIT · DataGeo PR/);
  const est = text(rodoviaTooltip({ ref: 'PR-418', name: '' }, { kmPorSigla: new Map([['PR-418', 8.2]]) }));
  assert.match(est, /PR-418 ESTADUAL Rodovia estadual Jurisdição Estadual · DER-PR Extensão no PR 8,2 km/);
  assert.doesNotMatch(est, /Denominação|Município/);
  const semRef = text(rodoviaTooltip({ ref: '', name: 'Contorno Norte' }, { nivel: 'estaduais' }));
  assert.match(semRef, /^🛣️ Contorno Norte Rodovia estadual/);
});

test('ferrovias: nome, uso traduzido, operadoras e extensão da linha', () => {
  const t = text(ferroviaTooltip(
    { name: 'Tronco Principal Sul', operator: 'Rumo S/A;Cargill Agrícola S/A', usage: 'main', km: 0.8 },
    { kmLinha: 412.3, cur: { municipio: 'Ponta Grossa', ibge: '4119905', lat: -25.1, lon: -50.16 } },
  ));
  assert.match(t, /Tronco Principal Sul Linha principal · Ponta Grossa/);
  assert.match(t, /Operadoras Rumo S\/A, Cargill Agrícola S\/A Uso Linha principal Extensão da linha no PR 412 km Segmento 0,8 km/);
  assert.match(t, /OpenStreetMap · DataGeo PR/);
  const vazio = text(ferroviaTooltip({ name: null, operator: null, usage: null }));
  assert.match(vazio, /Ferrovia sem nome no OSM Ferrovia/);
  assert.doesNotMatch(vazio, /Operadora|Extensão|Município/);
});

test('estradas municipais: classe, jurisdição e trechos da célula', () => {
  const t = text(estradaTooltip({ grupo: 'rurais', cell: '-100_-200', trechos: 1523 }, { cur: { municipio: 'Castro', lat: -24.8, lon: -50 } }));
  assert.match(t, /Estrada rural \(vicinal\) Malha municipal · Castro Classe Vicinal/);
  assert.match(t, /Jurisdição Municipal \(prefeitura\) Município Castro Trechos da classe na célula 1\.523 \(quadro de 0,25°\)/);
  assert.match(text(estradaTooltip({ grupo: 'urbanas', trechos: 3 })), /Via urbana Malha municipal Classe Rua de cidade/);
  const est = transporte.find((l) => l.id === 'datageo-estradas');
  assert.deepEqual(est.interactive, ['dg-estradas-hit-0', 'dg-estradas-hit-1']);
  const hit = est.layers.find((l) => l.id === 'dg-estradas-hit-0');
  assert.deepEqual(hit.filter, ['==', ['get', 'grupo'], 'urbanas']);
  assert.equal(hit.minzoom, zoomForHeight(30_000), 'o pick segue o teto do grupo');
  assert.equal(typeof est.tooltip, 'function');
});

test('ferrovias e conveniadas: faixa de pick larga e interativa', () => {
  const fer = transporte.find((l) => l.id === 'datageo-ferrovias');
  assert.deepEqual(fer.interactive, ['dg-ferrovias-hit']);
  assert.equal(fer.layers.find((l) => l.id === 'dg-ferrovias-hit').paint['line-width'], 12);
});

test('cursorContext: coordenada do último mousemove e município do preenchimento', () => {
  const handlers = {};
  const map = {
    on: (ev, fn) => { handlers[ev] = fn; },
    getLayer: (id) => id === 'dg-municipios-fill',
    queryRenderedFeatures: (pt, opts) => (opts.layers[0] === 'dg-municipios-fill' && pt[0] === 10
      ? [{ properties: { NM_MUN: 'Castro', CD_MUN: '4104907' } }] : []),
  };
  assert.deepEqual(cursorContext({ map }), { lat: null, lon: null, municipio: null, ibge: null });
  const st = trackCursor(map);
  assert.equal(trackCursor(map), st, 'um ouvinte por mapa');
  handlers.mousemove({ point: { x: 10, y: 5 }, lngLat: { lng: -50, lat: -24.8 } });
  assert.deepEqual(cursorContext({ map }), { lat: -24.8, lon: -50, municipio: 'Castro', ibge: '4104907' });
  handlers.mouseout();
  assert.equal(cursorContext({ map }).lat, null);
});
