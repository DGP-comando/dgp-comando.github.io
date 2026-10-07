import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMO_TEXTO, TERMO_VERSAO, caminhoRegistro, cpfValido, emailReal, emailValido, hashTermo, mascaraCpf,
  montaRegistro, termoAssinado,
} from './termoLgpd.js';

test('CPF: dígitos verificadores, máscara e sequências repetidas', () => {
  assert.equal(cpfValido('529.982.247-25'), true);
  assert.equal(cpfValido('52998224725'), true);
  assert.equal(cpfValido('529.982.247-24'), false);
  assert.equal(cpfValido('111.111.111-11'), false);
  assert.equal(cpfValido('1234567890'), false);
  assert.equal(mascaraCpf('52998224725'), '529.982.247-25');
  assert.equal(mascaraCpf('5299'), '529.9');
});

test('e-mail: formato e o sintético do SISATER não conta como real', () => {
  assert.equal(emailValido('fulano@idr.pr.gov.br'), true);
  assert.equal(emailValido('fulano@idr'), false);
  assert.equal(emailReal({ email: '772708@sisater.local' }), '');
  assert.equal(emailReal({ email: 'a@b.com' }), 'a@b.com');
});

test('termo assinado só na versão atual', () => {
  assert.equal(termoAssinado({ user_metadata: { lgpd_termo: { versao: TERMO_VERSAO } } }), true);
  assert.equal(termoAssinado({ user_metadata: { lgpd_termo: { versao: '2000-01-01' } } }), false);
  assert.equal(termoAssinado({ user_metadata: {} }), false);
});

test('registro: pasta do usuário, texto completo, hash e hora de Brasília', async () => {
  const user = { id: 'abc-123', email: '772708@sisater.local', user_metadata: { matricula: '772708', nome: 'Fulano' } };
  const agora = new Date('2026-10-07T15:04:05.678Z');
  assert.equal(caminhoRegistro(user, agora), `abc-123/${TERMO_VERSAO}_2026-10-07T15-04-05-678Z.json`);
  const r = await montaRegistro(user, { cpf: '529.982.247-25', email: ' Fulano@IDR.pr.gov.br ' }, agora, 'UA');
  assert.equal(r.cpf, '52998224725');
  assert.equal(r.email, 'fulano@idr.pr.gov.br');
  assert.equal(r.usuario.matricula, '772708');
  assert.deepEqual(r.termo.texto, [...TERMO_TEXTO]);
  assert.equal(r.termo.sha256, await hashTermo());
  assert.match(r.termo.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.assinado_em_local, /07\/10\/2026.*12:04:05.*America\/Sao_Paulo/);
});

test('texto do termo: SEAGRI, prefeituras, sem travessão e sem atribuir a plataforma ao IDR', () => {
  const t = TERMO_TEXTO.join(' ');
  assert.match(t, /SEAGRI/);
  assert.match(t, /prefeituras/);
  assert.match(t, /Lei nº 13\.709\/2018/);
  assert.ok(!t.includes('—'), 'sem travessão');
  assert.ok(!/plataforma do IDR|IDR-Paraná/.test(t), 'DataGeo não é plataforma do IDR');
});
