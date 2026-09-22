import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { centroidByName } from './prCentroids.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import {
  GRUPOS, datageoEstradasConveniadasLayer as layer, partesDe, tooltipHtml,
} from './datageoEstradasConveniadas.js';

const raw = readFileSync(new URL('../../public/data/estradas-conveniadas-pr.geojson', import.meta.url), 'utf8');
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

test('chips ligam e desligam cada conjunto; parâmetro inválido é recusado', () => {
  assert.deepEqual(layer.getParams(), { conveniadas: true, protocolos: true, automatizado: true });
  const chip = layer.getRowControls().chips.find((c) => c.id === 'protocolos');
  assert.deepEqual(chip.params, { protocolos: false });
  assert.equal(layer.setParams(chip.params), true);
  assert.equal(layer.getParams().protocolos, false);
  assert.equal(layer.setParams({ protocolos: true }), true);
  assert.equal(layer.setParams({ outro: true }), false);
  assert.equal(layer.setParams({ conveniadas: 'sim' }), false);
});

test('camada tem token próprio no link', () => {
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === layer.id);
  assert.ok(entry);
  assert.equal(LAYER_STATE_REGISTRY.filter((e) => e.token === entry.token).length, 1);
});
