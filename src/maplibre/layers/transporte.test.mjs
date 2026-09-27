import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  cellFeatures, cellsForView, groupStyles, intersectBbox, layerSpecs, createSlicedLinesLayer,
} from '../slicedLines.js';
import transporte, {
  ESTRADAS_GRUPOS, RODOVIAS_STYLE, conveniadaLayerSpec, conveniadaTooltip, conveniadasHitFilter, contarPorGrupo,
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
  assert.deepEqual(rod.layers.map((l) => l.id), ['dg-rodovias-fed-line', 'dg-rodovias-est-line']);
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
  assert.match(html, /&lt;i&gt;T&lt;\/i&gt;/);
  assert.match(html, /Conveniadas 2026 · Castro/);
  assert.match(html, /Km:<\/span> 12/);
  assert.equal(conveniadaTooltip({ grupo: 'nada' }), '');
  const chips = conv.rowControls().chips;
  assert.deepEqual(chips.map((c) => c.id), ['conveniadas', 'protocolos', 'automatizado']);
});
