import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VINCULOS, pivoTooltip } from './pivos.js';

const fc = JSON.parse(readFileSync(new URL('../../../public/data/pivos-pr.geojson', import.meta.url), 'utf-8'));

test('pivôs: 302, cada um como polígono e ponto, classes conhecidas', () => {
  const pts = fc.features.filter((f) => f.geometry.type === 'Point');
  assert.equal(pts.length, 302);
  assert.equal(fc.features.length, 604);
  const chaves = new Set(VINCULOS.map((v) => v.key));
  assert.ok(pts.every((f) => chaves.has(f.properties.vinculo)));
});

test('pivôs: sem requerente (LGPD) e acentos íntegros', () => {
  const txt = JSON.stringify(fc);
  assert.doesNotMatch(txt, /requerente/i);
  assert.match(txt, /Foz do Iguaçu/);
  assert.doesNotMatch(txt, /�|Ã§/);
});

test('tooltip: outorga só quando há vínculo', () => {
  const com = pivoTooltip({ id: 'PR-001', ha: 275.07, municipio: 'Foz do Iguaçu', vinculo: 'ALTA', fonte: 'ANA', tipoAto: 'Resolução de outorga', ato: '1546/2016', demanda: 924.6 });
  assert.match(com, /Pivô PR-001/);
  assert.match(com, /ANA · Resolução de outorga 1546\/2016/);
  const sem = pivoTooltip({ id: 'PR-099', ha: 30, vinculo: 'SEM OUTORGA', demanda: 100 });
  assert.doesNotMatch(sem, /Outorga mais provável/);
});
