import test from 'node:test';
import assert from 'node:assert/strict';
import { prontuario } from './getecFichaProdutor.js';
import { secaoProntuario } from '../datageoCaf.js';

const FICHA = {
  produtores: {
    111: { caf: '111', nVinculos: 1, programas: ['Leite'], tecnicos: [{ id: 9, nome: 'Ana' }],
      grupos: [{ nome: 'G1', projeto: 'Leite', tecnicoNome: 'Ana' }], atendimentosDatados: null },
  },
};
const ATEND = {
  periodo: { de: '2008-01-01', ate: '2026-10-16' },
  produtores: {
    111: { n: 44, horas: 27, primeiro: '2010-08-09', ultimo: '2026-07-01', porAno: { 2025: 16, 2026: 6 },
      ultimos: [{ data: '2026-07-01', metodo: 'Visita', acao: 'Acesso ao Crédito Rural', atividade: 'Crédito Rural',
        programa: 'Crédito Rural', tecnico: 'Carlos <Ré>' }], nEventos: 17, ultimoEvento: '2025-09-04' },
    222: { n: 3, horas: 2, primeiro: '2020-01-02', ultimo: '2021-05-06', porAno: { 2020: 2, 2021: 1 },
      ultimos: [], nEventos: 0, ultimoEvento: null },
  },
};

test('prontuario: junta grupos do ano e atendimentos do banco sem mutar a ficha', () => {
  const p = prontuario(FICHA, 111, ATEND);
  assert.equal(p.nVinculos, 1);
  assert.equal(p.atendimentosDatados.n, 44);
  assert.equal(p.atendimentosDatados.periodo.ate, '2026-10-16');
  assert.equal(FICHA.produtores[111].atendimentosDatados, null);
});

test('prontuario: família fora dos grupos ganha ficha só com o histórico; sem nada, null', () => {
  const p = prontuario(FICHA, '222', ATEND);
  assert.equal(p.nVinculos, 0);
  assert.equal(p.atendimentosDatados.n, 3);
  assert.equal(prontuario(FICHA, 333, ATEND), null);
  assert.equal(prontuario(null, 111, null), null);
  assert.equal(prontuario(FICHA, 111, null).historicoIndisponivel, true);
  assert.equal(prontuario(FICHA, 111, { produtores: {} }), FICHA.produtores[111]);
});

test('secaoProntuario: mostra nº, período, últimos e eventos, com acento e escape', () => {
  const html = secaoProntuario(prontuario(FICHA, 111, ATEND));
  assert.match(html, /Atendimentos individuais: <b>44<\/b>/);
  assert.match(html, /09\/08\/2010 a 01\/07\/2026/);
  assert.match(html, /Acesso ao Crédito Rural/);
  assert.match(html, /Carlos &lt;Ré&gt;/);
  assert.match(html, /Eventos coletivos: <b>17<\/b>/);
  assert.match(html, /base de 16\/10\/2026/);
  assert.doesNotMatch(html, /pendentes/);
});

test('secaoProntuario: sem atendimentos mantém só os grupos e não confunde falha com ausência', () => {
  const html = secaoProntuario(prontuario(FICHA, 111, { produtores: {} }));
  assert.doesNotMatch(html, /Atendimentos individuais/);
  assert.match(html, /sem atendimento individual registrado/);
  assert.match(secaoProntuario(prontuario(FICHA, 111, null)), /indisponível/);
  assert.match(html, /Vínculos de grupo: <b>1<\/b>/);
});
