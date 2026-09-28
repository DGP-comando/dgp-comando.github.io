import test from 'node:test';
import assert from 'node:assert/strict';
import { resumirSusaf } from './susaf.js';

const SIM = { responsavel: 'Fulana', telefone: '(44) 0000-0000', email: 'sim@exemplo.gov.br' };
const DADOS = {
  fonte: 'SEAB/ADAPAR',
  dataMapa: '2026-08-12',
  municipios: {
    1: { adesao: 'sim-proprio', estabelecimentos: 3, suspenso: false, sim: SIM },
    2: { adesao: 'consorcio', estabelecimentos: 0, suspenso: false, sim: null },
    3: { adesao: 'sim-proprio', estabelecimentos: null, suspenso: true, sim: SIM },
  },
};

test('município com SIM próprio traz estabelecimentos e contato', () => {
  const r = resumirSusaf(DADOS, [1]);
  assert.equal(r.adesao, 'sim-proprio');
  assert.equal(r.estabelecimentos, 3);
  assert.deepEqual(r.sim, SIM);
  assert.equal(r.dataMapa, '2026-08-12');
});

test('município que não aderiu: adesao null (a ficha mostra "não aderiu")', () => {
  const r = resumirSusaf(DADOS, ['9']);
  assert.equal(r.adesao, null);
  assert.equal(r.sim, null);
});

test('regional soma adesões e estabelecimentos', () => {
  const r = resumirSusaf(DADOS, ['1', '2', '3', '9']);
  assert.deepEqual([r.n, r.aderiram, r.viaConsorcio, r.estabelecimentos], [4, 3, 1, 3]);
});

test('sem dados: null', () => {
  assert.equal(resumirSusaf(null, ['1']), null);
});
