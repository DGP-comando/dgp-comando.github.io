import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMO_EXTERNO_TEXTO, TERMO_EXTERNO_VERSAO, TERMO_TEXTO, TERMO_VERSAO, caminhoRegistro, cpfValido, emailReal,
  emailValido, hashTermo, mascaraCpf, montaRegistro, termoAssinado, termoDe,
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

test('externo assina o termo de uso; servidor, o de LGPD; trocar de perfil pede nova assinatura', async () => {
  const servidor = { id: 's1', email: '1@sisater.local', app_metadata: { datageo: true }, user_metadata: { lgpd_termo: { versao: TERMO_VERSAO } } };
  const externo = { id: 'e1', email: 'a@b.com', app_metadata: { datageo: true, datageo_externo: true }, user_metadata: { nome: 'Conceição' } };
  assert.equal(termoDe(servidor).versao, TERMO_VERSAO);
  assert.equal(termoDe(externo).versao, TERMO_EXTERNO_VERSAO);
  assert.equal(termoAssinado(servidor), true);
  assert.equal(termoAssinado(externo), false);
  // assinou como servidor e virou externo: assina de novo
  assert.equal(termoAssinado({ ...servidor, app_metadata: { datageo: true, datageo_externo: true } }), false);
  assert.equal(termoAssinado({ ...externo, user_metadata: { lgpd_termo: { versao: TERMO_EXTERNO_VERSAO } } }), true);
  const agora = new Date('2026-10-20T15:00:00Z');
  assert.match(caminhoRegistro(externo, agora), new RegExp(`^e1/${TERMO_EXTERNO_VERSAO}_`));
  const r = await montaRegistro(externo, { cpf: '529.982.247-25', email: 'a@b.com' }, agora);
  assert.equal(r.termo.versao, TERMO_EXTERNO_VERSAO);
  assert.deepEqual(r.termo.texto, [...TERMO_EXTERNO_TEXTO]);
  assert.equal(r.termo.sha256, await hashTermo(TERMO_EXTERNO_TEXTO.join('\n')));
  assert.equal(r.usuario.nome, 'Conceição');
});

test('texto do termo externo: dado público, citar a fonte, sem travessão e sem atribuir ao IDR', () => {
  const t = TERMO_EXTERNO_TEXTO.join(' ');
  assert.match(t, /apenas a dados públicos/);
  assert.match(t, /citarei a fonte: "DataGeo Paraná"/);
  assert.match(t, /12 meses/);
  assert.ok(!t.includes('—'), 'sem travessão');
  assert.ok(!/plataforma do IDR|IDR-Paraná|SEAGRI/.test(t), 'sem vínculo institucional');
});
