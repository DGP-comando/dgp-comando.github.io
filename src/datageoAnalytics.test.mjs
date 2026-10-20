import test from 'node:test';
import assert from 'node:assert/strict';
import { agregaLotacao, comLotacao, filtraUsuarios, ordena } from './datageoAnalytics.js';

const AGORA = Date.parse('2026-10-20T12:00:00Z');
const SERV = [
  { id: '772708', setor: 'Regional de Curitiba', diretoria: 'DER' },
  { id: '111', setor: 'Regional de Maringá', diretoria: 'DER' },
];
const USR = comLotacao([
  { id: 'a', nome: 'Ana Conceição', matricula: '772708', acoes: 40, ultimo_login: '2026-10-20T10:00:00Z', ultimo_evento: '2026-10-20T11:00:00Z' },
  { id: 'b', nome: 'Bruno', matricula: '111', acoes: 0, ultimo_login: '2026-08-01T10:00:00Z', ultimo_evento: null },
  { id: 'c', nome: 'Célia', matricula: '999', acoes: 5, ultimo_login: '2026-10-19T10:00:00Z', ultimo_evento: '2026-10-19T10:00:00Z' },
  { id: 'd', nome: 'Davi', matricula: '112', acoes: 0, ultimo_login: null, ultimo_evento: null },
], SERV);

test('lotação pela matrícula do SisPont; sem cadastro vira grupo próprio', () => {
  assert.deepEqual(USR.map((u) => u.lotacao), [
    'Regional de Curitiba', 'Regional de Maringá', 'Sem lotação no SisPont', 'Sem lotação no SisPont',
  ]);
  const lot = agregaLotacao(USR);
  assert.deepEqual(lot.map((l) => [l.lotacao, l.ativos, l.liberados]), [
    ['Regional de Curitiba', 1, 1], ['Sem lotação no SisPont', 1, 2],
  ]); // Maringá sem nenhum ativo fica fora do gráfico
});

test('filtro de usuários: texto com acento, ativos, inativos > 30 dias e nunca entraram', () => {
  const ids = (o) => filtraUsuarios(USR, { agora: AGORA, ...o }).map((u) => u.id);
  assert.deepEqual(ids({ busca: 'conceição' }), ['a']);
  assert.deepEqual(ids({ busca: 'maringá' }), ['b']);
  assert.deepEqual(ids({ situacao: 'ativos' }), ['a', 'c']);
  assert.deepEqual(ids({ situacao: 'inativos' }), ['b']);
  assert.deepEqual(ids({ situacao: 'nunca' }), ['d']);
  assert.equal(ids({}).length, 4);
});

test('ordenação numérica e alfabética pt-BR, sem mutar a lista', () => {
  const antes = USR.map((u) => u.id);
  assert.deepEqual(ordena(USR, 'acoes', true).map((u) => u.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(ordena(USR, 'nome', false).map((u) => u.nome), ['Ana Conceição', 'Bruno', 'Célia', 'Davi']);
  assert.deepEqual(USR.map((u) => u.id), antes);
});
