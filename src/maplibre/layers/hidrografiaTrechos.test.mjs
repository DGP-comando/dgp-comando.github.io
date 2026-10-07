import assert from 'node:assert/strict';
import test from 'node:test';
import { trechoFeature, trechoProps, trechoTooltip } from './hidrografiaTrechos.js';

const ATTR = {
  objectid: 604699, noriocomp: 'Rio Verde ', nustrahler: 3, nucomptrec: 0.11183448, nuareamont: 12.5,
  dedominial: 'Estadual', cobacia: '86429329462', cocursodag: '8642932946',
};

test('atributos do GeoPR viram propriedades curtas', () => {
  assert.deepEqual(trechoProps(ATTR), {
    nome: 'Rio Verde', strahler: 3, km: 0.11183448, areaMontKm2: 12.5, dominio: 'Estadual',
    cobacia: '86429329462', curso: '8642932946',
  });
  assert.equal(trechoProps({ nustrahler: null }).strahler, null);
});

test('paths do ArcGIS viram MultiLineString com id (realce por feature-state)', () => {
  const f = trechoFeature({ attributes: ATTR, geometry: { paths: [[[-50.1, -25.1], [-50.2, -25.2]]] } });
  assert.equal(f.id, 604699);
  assert.equal(f.geometry.type, 'MultiLineString');
  assert.equal(trechoFeature({ attributes: ATTR, geometry: null }), null);
});

test('tooltip: nome, metros abaixo de 1 km, área e domínio; sem nome tem título próprio', () => {
  const html = trechoTooltip(trechoProps(ATTR));
  assert.match(html, /Rio Verde/);
  assert.match(html, /112 m/);
  assert.match(html, /12,5 km²/);
  assert.match(html, /Estadual/);
  assert.match(trechoTooltip(trechoProps({ ...ATTR, noriocomp: '' })), /Curso d’água sem nome/);
});
