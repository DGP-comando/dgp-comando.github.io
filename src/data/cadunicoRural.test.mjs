// node --test src/data/cadunicoRural.test.mjs
// Dados sintéticos: o arquivo real fica no bucket privado, fora do git.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mesAno, resumirRural, secaoCadunicoTerritorio } from './cadunicoRural.js';
import { assentamentoTooltip, quilombolaTooltip, terraIndigenaTooltip } from './territoriosSpec.js';

const dados = {
  referencia: '202303',
  municipios: {
    1: { familias: 100, pessoas: 250, extrema_pobreza: 40, quilombolas: '<5' },
    2: { familias: 10, pessoas: 20, extrema_pobreza: '<5', indigenas: 6 },
  },
};

test('resumo rural: soma números, suprimido fica fora e é listado', () => {
  const um = resumirRural(dados, ['1']);
  assert.equal(um.n, 1);
  assert.deepEqual(um.suprimidos, ['quilombolas']);
  const dois = resumirRural(dados, [1, 2, 3]);
  assert.equal(dois.familias, 110);
  assert.equal(dois.extrema_pobreza, 40);
  assert.equal(dois.indigenas, 6);
  assert.deepEqual(dois.suprimidos.sort(), ['extrema_pobreza', 'quilombolas']);
  assert.equal(resumirRural(dados, ['9']), null);
  assert.equal(resumirRural(null, ['1']), null);
  assert.equal(mesAno('202303'), 'mar/2023');
});

test('seção do território: "<5" vira "menos de 5", percentual e alerta de extrema pobreza', () => {
  const s = secaoCadunicoTerritorio({ familias: 20, pessoas: 50, extrema_pobreza: 12, sem_banheiro: '<5' }, '202303');
  assert.match(s.title, /mar\/2023/);
  const linhas = Object.fromEntries(s.rows.map(([k, v, tom]) => [k, { v, tom }]));
  assert.equal(linhas['Famílias'].v, '20 · 50 pessoas');
  assert.match(linhas['Extrema pobreza'].v, /^12 \(60\s?%\)$/);
  assert.equal(linhas['Extrema pobreza'].tom, 'warn');
  assert.equal(linhas['Sem banheiro'].v, 'menos de 5');
  assert.equal(secaoCadunicoTerritorio({ familias: '<5' }, '202303').rows[0][1], 'menos de 5');
  assert.equal(secaoCadunicoTerritorio(null, '202303'), null);
});

test('tooltips dos territórios: bloco só aparece com dado (sessão liberada)', () => {
  const cad = { familias: 30, pessoas: 80, extrema_pobreza: 9 };
  const pa = { nome: 'PA TESTE', codigo: 'PR1', familias: 20, capacidade: 25 };
  assert.doesNotMatch(assentamentoTooltip(pa, {}), /CadÚnico/);
  const h = assentamentoTooltip(pa, { cadunico: cad, cadunicoRef: '202303' });
  assert.match(h, /CadÚnico · famílias rurais \(mar\/2023\)/);
  assert.match(h, /30 · 80 pessoas/);
  assert.match(quilombolaTooltip({ nome: 'Q' }, { cadunico: cad, cadunicoRef: '202303' }), /CadÚnico/);
  assert.match(terraIndigenaTooltip({ nome: 'TI X' }, { cadunico: cad, cadunicoRef: '202303' }), /CadÚnico/);
  assert.doesNotMatch(h, /undefined|NaN/);
});
