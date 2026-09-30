// node --test src/maplibre/layers/protecaoSocial.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import layers from './protecaoSocial.js';
import { pointFeatures } from './energiaLogistica.js';
import { equipamentoSuasEstilo, equipamentoSuasTooltipHtml } from '../../data/equipamentosSuasEstilos.js';

const gj = JSON.parse(readFileSync(new URL('../../../public/data/equipamentos-suas-pr.geojson', import.meta.url), 'utf8'));

test('dados reais: todo ponto tem estilo, rótulo com layer e tooltip limpo', () => {
  const [layer] = layers;
  assert.equal(layer.id, 'datageo-equipamentos-suas');
  const { features, counts } = pointFeatures(gj, equipamentoSuasEstilo);
  assert.equal(features.length, gj.features.length);
  assert.ok(counts.cras > 500 && counts.creas > 150 && counts.san > 0, JSON.stringify(counts));
  const filters = new Set(layer.layers.filter((l) => l.type === 'symbol').map((l) => l.filter[2]));
  for (const f of features) assert.ok(filters.has(f.properties.__ld));
  for (const f of gj.features) {
    const h = equipamentoSuasTooltipHtml(f.properties);
    assert.match(h, /^<div class="tt">/);
    assert.doesNotMatch(h, /undefined|NaN|�|@/, h);
  }
});

test('tooltip: título curto, nome só quando diz algo, situação parada vira badge', () => {
  const h = equipamentoSuasTooltipHtml({ grupo: 'cras', nome: 'CRAS', municipio: 'Pérola d\'Oeste', endereco: 'Rua A, 1' });
  assert.match(h, /tt-title">CRAS Pérola d&#39;Oeste</);
  assert.doesNotMatch(h, /<dt>Nome</);
  const generico = { grupo: 'cras', nome: 'CRAS - CENTRO DE REFERENCIA DA ASSISTENCIA SOCIAL', municipio: 'X' };
  assert.doesNotMatch(equipamentoSuasTooltipHtml(generico), /<dt>Nome</);
  const proprio = { grupo: 'cras', nome: 'CRAS - NOSSA SENHORA DA CONCEIÇÃO/CENTRO DE REFERENCIA DE ASSISTENCIA SOCIAL', municipio: 'X' };
  assert.match(equipamentoSuasTooltipHtml(proprio), /NOSSA SENHORA DA CONCEIÇÃO/);
  const c = equipamentoSuasTooltipHtml({ grupo: 'cozinha', nome: 'Cozinha X', municipio: 'Toledo', situacao: 'PARALISADO' });
  assert.match(c, /tt-badge tt-warn">paralisado</);
  assert.equal(equipamentoSuasEstilo({ grupo: 'banco' }).grupo, 'san');
  assert.equal(equipamentoSuasEstilo({ grupo: 'x' }), null);
});
