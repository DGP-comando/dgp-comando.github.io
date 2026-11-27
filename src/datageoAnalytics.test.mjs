import test from 'node:test';
import assert from 'node:assert/strict';
import { agregaLotacao, comLotacao, ehContaDeServico, filtraUsuarios, ordena } from './datageoAnalytics.js';

const AGORA = Date.parse('2026-10-20T12:00:00Z');
const SERV = [
  { id: '772708', setor: 'Regional de Curitiba', diretoria: 'DER' },
  { id: '111', setor: 'Regional de Maringá', diretoria: 'DER' },
];
const USR = comLotacao([
  { id: 'a', nome: 'Ana Conceição', matricula: '772708', acoes: 40, ultimo_login: '2026-10-20T10:00:00Z', ultimo_evento: '2026-10-20T11:00:00Z' },
  { id: 'b', nome: 'Bruno', matricula: '111', acoes: 0, ultimo_login: '2026-08-01T10:00:00Z', ultimo_evento: null },
  { id: 'c', nome: 'Célia', matricula: '999', acoes: 5, ultimo_login: '2026-10-19T10:00:00Z', ultimo_evento: '2026-10-19T10:00:00Z' },
  { id: 'd', nome: 'Davi', matricula: '112', acoes: 0, ultimo_login: null, ultimo_evento: null, externo: true },
  { id: 'e', nome: 'Edu', matricula: '113', acoes: 0, ultimo_login: '2026-08-01T10:00:00Z', ultimo_evento: null, ativo: false },
], SERV);

test('conta de serviço (matrícula 99 + 8 dígitos) não entra como servidor sem lotação', () => {
  assert.equal(ehContaDeServico('9900000001'), true);
  assert.equal(ehContaDeServico(9900000001), true);
  for (const m of ['772708', '990000001', '99000000012', '8900000001', '', null, undefined]) {
    assert.equal(ehContaDeServico(m), false, String(m));
  }
  const [servico, gente] = comLotacao([
    { id: 's', nome: 'Serviço Ater Digital (sincronização da CAF)', matricula: '9900000001', acoes: 398 },
    { id: 'g', nome: 'Gente', matricula: '424242', acoes: 1 },
  ], SERV);
  assert.equal(servico.lotacao, 'Conta de serviço (sistema)');
  assert.equal(servico.servico, true);
  assert.equal(gente.lotacao, 'Sem lotação no SisPont');
  assert.equal(gente.servico, false);
  // Mesmo que o SisPont um dia tenha um id igual, conta de serviço não vira servidor.
  const [colisao] = comLotacao([{ id: 's', nome: 'Serviço X', matricula: '9900000001' }], [{ id: '9900000001', nome: 'Fulano', setor: 'Regional' }]);
  assert.equal(colisao.lotacao, 'Conta de serviço (sistema)');
  assert.equal(colisao.nome, 'Serviço X');
});

test('lotação pela matrícula do SisPont; sem cadastro vira grupo próprio', () => {
  assert.deepEqual(USR.map((u) => u.lotacao), [
    'Regional de Curitiba', 'Regional de Maringá', 'Sem lotação no SisPont', 'Sem lotação no SisPont',
    'Sem lotação no SisPont',
  ]);
  const lot = agregaLotacao(USR);
  assert.deepEqual(lot.map((l) => [l.lotacao, l.ativos, l.liberados]), [
    ['Regional de Curitiba', 1, 1], ['Sem lotação no SisPont', 1, 2],
  ]); // Maringá sem nenhum ativo fica fora do gráfico; o revogado (Edu) não conta como liberado
});

test('filtro de usuários: texto com acento, ativos, inativos > 30 dias e nunca entraram', () => {
  const ids = (o) => filtraUsuarios(USR, { agora: AGORA, ...o }).map((u) => u.id);
  assert.deepEqual(ids({ busca: 'conceição' }), ['a']);
  assert.deepEqual(ids({ busca: 'maringá' }), ['b']);
  assert.deepEqual(ids({ situacao: 'ativos' }), ['a', 'c']);
  assert.deepEqual(ids({ situacao: 'inativos' }), ['b']);
  assert.deepEqual(ids({ situacao: 'nunca' }), ['d']);
  assert.equal(ids({}).length, 4); // revogado fora de "todos os liberados"
  assert.deepEqual(ids({ situacao: 'revogados' }), ['e']);
  assert.deepEqual(ids({ situacao: 'externos' }), ['d']);
  assert.deepEqual(ids({ situacao: 'revogados', busca: 'ana' }), []);
});

test('ordenação numérica e alfabética pt-BR, sem mutar a lista', () => {
  const antes = USR.map((u) => u.id);
  assert.deepEqual(ordena(USR, 'acoes', true).map((u) => u.id), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(ordena(USR, 'nome', false).map((u) => u.nome), ['Ana Conceição', 'Bruno', 'Célia', 'Davi', 'Edu']);
  assert.deepEqual(USR.map((u) => u.id), antes);
});
