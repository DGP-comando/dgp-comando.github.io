import test from 'node:test';
import assert from 'node:assert/strict';
import { enviarSolicitacao, mascaraTelefone, montaSolicitacao } from './datageoSolicitacao.js';
import { fmtCpf, fmtTel, mensagemAprovacao } from './datageoAnalytics.js';

const OK = {
  entidade: '  Prefeitura de  Guarapuava ', nome: 'Conceição Araújo', endereco: 'Rua XV de Novembro, 100 - Curitiba',
  cpf: '529.982.247-25', telefone: '(41) 99999-8888', email: ' Conceicao@Exemplo.com.br',
  finalidade: 'Planejamento de estradas rurais do município', aceite: true,
};

test('montaSolicitacao: normaliza e só manda as colunas com grant', () => {
  const { erro, linha } = montaSolicitacao(OK);
  assert.equal(erro, undefined);
  assert.deepEqual(linha, {
    entidade: 'Prefeitura de Guarapuava', nome: 'Conceição Araújo', endereco: 'Rua XV de Novembro, 100 - Curitiba',
    cpf: '52998224725', telefone: '41999998888', email: 'conceicao@exemplo.com.br',
    finalidade: 'Planejamento de estradas rurais do município', aceite_lgpd: true,
  });
});

test('montaSolicitacao: cada campo obrigatório barra com mensagem própria', () => {
  const erro = (mudanca) => montaSolicitacao({ ...OK, ...mudanca }).erro;
  assert.match(erro({ entidade: ' ' }), /entidade/);
  assert.match(erro({ nome: 'Jo' }), /nome/);
  assert.match(erro({ endereco: 'Rua' }), /endereço/);
  assert.match(erro({ cpf: '111.111.111-11' }), /CPF/);
  assert.match(erro({ telefone: '9999-8888' }), /DDD/);
  assert.match(erro({ email: 'sem-arroba' }), /E-mail/);
  assert.match(erro({ finalidade: 'ver' }), /finalidade/);
  assert.match(erro({ aceite: false }), /autorização/);
});

test('máscaras de telefone, CPF e telefone no painel', () => {
  assert.equal(mascaraTelefone('41999998888'), '(41) 99999-8888');
  assert.equal(mascaraTelefone('4133334444'), '(41) 3333-4444');
  assert.equal(mascaraTelefone('41'), '(41');
  assert.equal(fmtCpf('52998224725'), '529.982.247-25');
  assert.equal(fmtTel('41999998888'), '(41) 99999-8888');
  assert.equal(fmtTel('4133334444'), '(41) 3333-4444');
});

test('enviarSolicitacao: anon key, 409 = pendente duplicada, 54000 = limite', async () => {
  const chamadas = [];
  const resposta = (status, corpo) => async (url, init) => {
    chamadas.push({ url, init });
    return new Response(corpo ? JSON.stringify(corpo) : null, { status });
  };
  assert.deepEqual(await enviarSolicitacao({ nome: 'x' }, resposta(201)), { ok: true });
  assert.match(chamadas[0].url, /\/rest\/v1\/datageo_solicitacao$/);
  assert.equal(chamadas[0].init.headers.Prefer, 'return=minimal');
  assert.match((await enviarSolicitacao({}, resposta(409))).erro, /pendente/);
  assert.match((await enviarSolicitacao({}, resposta(500, { code: '54000' }))).erro, /Muitas/);
  assert.match((await enviarSolicitacao({}, resposta(400, { code: '23514' }))).erro, /erro 400/);
});

test('mensagemAprovacao: conta nova mostra a senha temporária; existente não', () => {
  const sol = { nome: 'Conceição', entidade: 'Prefeitura' };
  const nova = mensagemAprovacao(sol, { login: 'c@x.com', senha_temporaria: 'Ab3dEf7hJk9m', conta_existente: false });
  assert.match(nova, /c@x\.com/);
  assert.match(nova, /Ab3dEf7hJk9m/);
  const existente = mensagemAprovacao(sol, { login: 'c@x.com', senha_temporaria: null, conta_existente: true });
  assert.match(existente, /já existia/);
  assert.doesNotMatch(existente, /senha temporária/);
});
