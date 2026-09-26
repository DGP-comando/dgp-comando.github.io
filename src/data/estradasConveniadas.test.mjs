import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { centroidByName } from './prCentroids.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { GRUPOS, partesDe, tooltipHtml } from './estradasConveniadasTooltip.js';
import {
  conveniadasHitFilter, contarPorGrupo, estradasConveniadasLayer as layer,
} from '../maplibre/layers/transporte.js';

const raw = readFileSync(new URL('../../data/privado/estradas-conveniadas-pr.geojson', import.meta.url), 'utf8');
const { features } = JSON.parse(raw);
const doGrupo = (id) => features.filter((f) => f.properties.grupo === id);

test('os três conjuntos estão lá, cada trecho no PR e desenhável', () => {
  assert.equal(doGrupo('conveniadas').length, 96);
  assert.ok(doGrupo('protocolos').length >= 350);
  assert.ok(doGrupo('automatizado').length >= 490);
  for (const f of features) {
    assert.ok(GRUPOS.some((g) => g.id === f.properties.grupo), f.properties.grupo);
    const partes = partesDe(f.geometry);
    assert.ok(partes.length > 0 && partes.every((p) => p.length >= 2));
    for (const [lon, lat] of partes.flat()) {
      assert.ok(lon > -54.7 && lon < -47.9 && lat > -26.8 && lat < -22.4, `${lon},${lat} fora do PR`);
    }
  }
});

test('sem CNPJ nem caminho de máquina na saída', () => {
  assert.doesNotMatch(raw, /CNPJ|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  assert.doesNotMatch(raw, /[A-Z]:[\\/]/);
});

test('toda conveniada tem município oficial do PR e acentos quase todos reparados', () => {
  for (const f of doGrupo('conveniadas')) {
    assert.ok(centroidByName(f.properties['Município']), f.properties['Município']);
  }
  const perdidos = raw.match(/�/g)?.length ?? 0;
  assert.ok(perdidos <= 6, `${perdidos} letras ainda perdidas`);
});

test('tooltip escapa texto e mostra o trecho', () => {
  const html = tooltipHtml({ grupo: 'protocolos', Trecho: '<b>x</b>', 'Descrição': 'a'.repeat(400) });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /a…<\/div>/);
  assert.equal(tooltipHtml({ grupo: 'outro' }), '');
});

// Na versão MapLibre os conjuntos são chips da linha do painel (rowControls /
// onChip) que só mudam a visibilidade dos layers; não há mais getParams/setParams
// próprios da camada Cesium.
test('chips ligam e desligam cada conjunto; chip desconhecido é ignorado', () => {
  const layout = new Map();
  const filters = new Map();
  const map = {
    getLayer: () => true,
    setLayoutProperty: (id, _prop, value) => layout.set(id, value),
    setFilter: (id, filter) => filters.set(id, filter),
  };
  const ctx = { map };
  const chips = () => layer.rowControls(ctx).chips;
  assert.deepEqual(chips().map((c) => [c.id, c.active]),
    [['conveniadas', true], ['protocolos', true], ['automatizado', true]]);
  layer.onChip('protocolos', ctx);
  assert.equal(chips().find((c) => c.id === 'protocolos').active, false);
  assert.equal(layout.get('dg-estradas-conveniadas-protocolos'), 'none');
  assert.equal(layout.get('dg-estradas-conveniadas-conveniadas'), 'visible');
  assert.deepEqual(filters.get('dg-estradas-conveniadas-hit'),
    conveniadasHitFilter({ conveniadas: true, protocolos: false, automatizado: true }));
  layer.onChip('protocolos', ctx);
  assert.equal(layout.get('dg-estradas-conveniadas-protocolos'), 'visible');
  layer.onChip('outro', ctx);
  assert.ok(chips().every((c) => c.active));
});

test('contagem por conjunto ignora grupo desconhecido', () => {
  const counts = contarPorGrupo(features);
  assert.equal(counts.conveniadas, 96);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), features.length);
  assert.deepEqual(contarPorGrupo([{ properties: { grupo: 'x' } }, null]),
    { conveniadas: 0, protocolos: 0, automatizado: 0 });
});

test('camada tem token próprio no link', () => {
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === layer.id);
  assert.ok(entry);
  assert.equal(LAYER_STATE_REGISTRY.filter((e) => e.token === entry.token).length, 1);
});
