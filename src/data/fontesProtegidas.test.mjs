import test from 'node:test';
import assert from 'node:assert/strict';
import { fontesPorFamilia, resumoFontes } from './fontesProtegidas.js';
import { fonteFeatures } from '../maplibre/layers/fontesProtegidas.js';
import { familiaHtml } from '../datageoCaf.js';

const D = {
  referencia: '2024-11-10',
  tipos: ['Construção', 'Reforma', 'Cercamento', 'Caxambu'],
  p: [
    [-51, -24, '4100103', 'Água Boa', 'JOÃO', 0, 2023, 'Junho', 0, '123'],
    [-51.1, -24.1, '4100103', '', 'MARIA', 1, 2019, '', 1, null],
  ],
  municipios: {
    4100103: { total: 3, tipos: { Construção: 2, Reforma: 1 }, por_ano: { 2019: 1, 2023: 2 } },
    4100202: { total: 1, tipos: { Construção: 1 }, por_ano: { 2023: 1 } },
  },
};

test('fontes: resumo soma municípios e zera onde não há', () => {
  const r = resumoFontes(D, ['4100103', '4100202', '4100301']);
  assert.equal(r.total, 4);
  assert.deepEqual(r.tipos, { Construção: 3, Reforma: 1 });
  assert.equal(r.porAno['2023'], 3);
  assert.equal(resumoFontes(D, ['4100301']).total, 0);
  assert.equal(resumoFontes(null, ['4100103']), null);
});

test('fontes: pontos por tipo, vazado fora do município e vínculo com a família', () => {
  const { features, counts } = fonteFeatures(D);
  assert.deepEqual(counts, [1, 1, 0, 0]);
  assert.equal(features[1].properties.fora, 1);
  assert.equal(fontesPorFamilia(D).get('123').length, 1);
  const html = familiaHtml({ membros: [], areas: [], producao: [], renda: {}, local: {} }, { fontes: fontesPorFamilia(D).get('123'), tiposFonte: D.tipos });
  assert.match(html, /Fonte protegida pelo IDR \(1\)/);
  assert.match(html, /Construção Junho 2023/);
  assert.match(html, /Água Boa/);
});
