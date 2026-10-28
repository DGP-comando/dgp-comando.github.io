import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recuperarSenha, validaRecuperacao } from './datageoSenha.js';

const CPF = '529.982.247-25';

test('validaRecuperacao: cada regra barra com mensagem própria', () => {
  assert.equal(validaRecuperacao(['', CPF, 'senhaboa1', 'senhaboa1']), 'Informe a matrícula ou o e-mail.');
  assert.equal(validaRecuperacao(['12345', '111.111.111-11', 'senhaboa1', 'senhaboa1']), 'CPF inválido.');
  assert.match(validaRecuperacao(['12345', CPF, 'curta', 'curta']), /pelo menos 8/);
  assert.equal(validaRecuperacao(['12345', CPF, 'senhaboa1', 'senhaboa2']), 'As senhas não conferem.');
  assert.equal(validaRecuperacao(['12345', CPF, 'x54321abc', 'x54321abc']), 'A senha não pode conter a matrícula.');
  assert.equal(validaRecuperacao(['12345', CPF, 'ção-segura9', 'ção-segura9']), null);
  assert.equal(validaRecuperacao(['ana@ex.com', CPF, 'senhaboa1', 'senhaboa1']), null);
});

test('recuperarSenha: anon key, CPF só dígitos, erro do servidor repassado', async () => {
  let pedido;
  const ok = await recuperarSenha({ login: ' 12345 ', cpf: CPF, senha: 'senhaboa1' }, async (url, init) => {
    pedido = { url, init };
    return new Response('{"ok":true}', { status: 200 });
  });
  assert.deepEqual(ok, { ok: true });
  assert.match(pedido.url, /functions\/v1\/datageo-senha$/);
  assert.deepEqual(JSON.parse(pedido.init.body), { login: '12345', cpf: '52998224725', senha: 'senhaboa1' });

  const falha = await recuperarSenha({ login: '1', cpf: CPF, senha: 'x' },
    async () => new Response('{"error":"Muitas tentativas."}', { status: 429 }));
  assert.deepEqual(falha, { erro: 'Muitas tentativas.' });
});
