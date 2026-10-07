// node --test src/maplibre/layers/aspectosFisicos.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { CORES_ALTITUDE, DECLIVIDADE } from '../../data/aspectosFisicos.js';
import {
  altimetriaLayer, coresUsoOcultas, declividadeLayer, reliefColor, whereDeclividade,
} from './aspectosFisicos.js';

test('altimetria: chave = índice da faixa; faixa oculta transparente nas duas paradas', () => {
  assert.deepEqual(altimetriaLayer.rowControls().legend.map((l) => l.key), CORES_ALTITUDE.map((_, i) => String(i)));
  const cheia = reliefColor();
  const sem = reliefColor(new Set(['1']));
  const cores = (e) => e.slice(3).filter((_, i) => i % 2 === 1);
  assert.deepEqual(cores(cheia).filter((c) => c === 'rgba(0,0,0,0)'), []);
  assert.deepEqual(cores(sem).map((c, i) => (c === 'rgba(0,0,0,0)' ? i : -1)).filter((i) => i >= 0), [2, 3]);
  const style = {
    version: 8,
    sources: { d: { type: 'raster-dem', tiles: ['x/{z}/{x}/{y}.png'] } },
    layers: [{ id: 'a', type: 'color-relief', source: 'd', paint: { 'color-relief-color': sem } }],
  };
  assert.deepEqual(validateStyleMin(style), []);
});

test('declividade: chaves da ZEE e layerDefs do GeoPR sem as classes', () => {
  const legenda = declividadeLayer.rowControls().legend;
  assert.deepEqual(legenda.filter((l) => l.key).map((l) => l.key), DECLIVIDADE.map((c) => c.key));
  assert.ok(legenda.filter((l) => !l.key).every((l) => /Clique/.test(l.label)), 'dica sem chave');
  assert.equal(whereDeclividade(new Set()), null);
  assert.equal(whereDeclividade(new Set(['>45'])), "classe NOT IN ('>45')");
  assert.equal(whereDeclividade(new Set(['0 a 10', '20 a 45'])), "classe NOT IN ('0 a 10','0 a 3','3 a 10','20 a 45')");
});

test('uso do solo: classe escondida vira a cor do PNG; sem cor conhecida, nada', () => {
  assert.deepEqual([...coresUsoOcultas(new Set(['Agricultura Anual', 'Classe Inventada']))], ['#89cd66']);
});
