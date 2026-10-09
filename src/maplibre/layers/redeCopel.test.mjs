import assert from 'node:assert/strict';
import test from 'node:test';
import redeCopel, { posteTooltip, trafoTooltip } from './redeCopel.js';

test('trafo: kVA, tipo e área a partir dos códigos da BDGD', () => {
  const html = trafoTooltip({ kva: 112.5, tipo: 'T', area: 'NU', fases: 'ABC' });
  assert.match(html, /Transformador 112,5 kVA/);
  assert.match(html, /Trifásico · Rural \(não urbana\)/);
  assert.match(trafoTooltip({ kva: 10, tipo: 'M', area: 'UB' }), /10 kVA[\s\S]*Monofásico · Urbana/);
});

test('poste: tipo e material rotulados; código 0 vira vazio', () => {
  const html = posteTooltip({ tipo: 'POS', mat: 'CO', alt: '11', esf: '0', estr: 'DT' });
  assert.match(html, /Poste/);
  assert.match(html, /Concreto/);
  assert.doesNotMatch(html, /Esforço/);
});

test('camadas da Copel leem PMTiles', () => {
  assert.deepEqual(redeCopel.map((l) => l.id), ['datageo-copel-transformadores', 'datageo-copel-postes']);
  for (const l of redeCopel) assert.match(Object.values(l.sources)[0].url, /^pmtiles:\/\/\/data\/copel-.+\.pmtiles$/);
});
