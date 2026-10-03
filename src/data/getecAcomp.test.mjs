import test from 'node:test';
import assert from 'node:assert/strict';
import { resumirGetec } from './getecAcomp.js';

const mun = (existente, programado, atendido, n, equivalente, organizacoes = []) => ({
  regional: 'Ivaiporã',
  publico: { existente, programado, pct_programado: 0, atendido, pct_executado: 0 },
  extensionistas: { n, equivalente },
  publico_por_extensionista: 0,
  publico_por_equivalente: 0,
  entidades_atendidas: 2,
  organizacoes,
});

const DADOS = {
  fonte: 'GETEC',
  ano: 2026,
  municipios: {
    4101903: mun(378, 205, 354, 2, 1.2, [{ tipo: 'Agroindustria', existente: 12, atendido: 6 }]),
    4102109: mun(386, 270, 399, 4, 1.58, [
      { tipo: 'Agroindustria', existente: 4, atendido: 4 },
      { tipo: 'Cooperativa', existente: 1, atendido: 0 },
    ]),
  },
};

test('um município: público, extensionistas e razões', () => {
  const r = resumirGetec(DADOS, ['4101903']);
  assert.equal(r.n, 1);
  assert.equal(r.ano, 2026);
  assert.equal(r.existente, 378);
  assert.equal(r.pctProgramado, 54.2);
  assert.equal(r.pctExecutado, 172.7);
  assert.equal(r.equivalente, 1.2);
  assert.equal(r.publicoPorEquivalente, 315);
  assert.deepEqual(r.organizacoes, [{ tipo: 'Agroindustria', existente: 12, atendido: 6 }]);
});

test('vários municípios: soma, razões sobre a soma, organizações por tipo', () => {
  const r = resumirGetec(DADOS, ['4101903', 4102109, '9999999']);
  assert.equal(r.n, 2);
  assert.equal(r.existente, 764);
  assert.equal(r.atendido, 753);
  assert.equal(r.extensionistas, 6);
  assert.equal(r.equivalente, 2.78);
  assert.equal(r.publicoPorEquivalente, 275);
  assert.equal(r.entidadesAtendidas, 4);
  assert.deepEqual(r.organizacoes, [
    { tipo: 'Agroindustria', existente: 16, atendido: 10 },
    { tipo: 'Cooperativa', existente: 1, atendido: 0 },
  ]);
});

test('sem dado → null; sem extensionista a razão fica null', () => {
  assert.equal(resumirGetec(DADOS, ['9999999']), null);
  assert.equal(resumirGetec(null, ['4101903']), null);
  const r = resumirGetec({ ano: 2026, municipios: { 1: mun(10, 0, 0, 0, 0) } }, ['1']);
  assert.equal(r.publicoPorEquivalente, null);
  assert.equal(r.pctExecutado, null);
});
