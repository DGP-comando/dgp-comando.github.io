// src/datageoSenha.js
//
// "Esqueci minha senha" no gate de login (src/datageoLogin.js). Sem e-mail:
// a Edge Function datageo-senha do c2 confere o CPF do termo LGPD assinado e
// grava a senha nova. Quem nunca assinou o termo não tem CPF guardado e
// recupera pelo administrador.

import { ANON_KEY, SENHA_MIN, SUPABASE_URL } from './data/datageoAuth.js';
import { cpfValido, soDigitos } from './data/termoLgpd.js';

export const AJUDA_RECUPERACAO =
  'Use o CPF informado no termo de responsabilidade. Se você ainda não assinou o termo, '
  + 'procure o administrador para voltar à senha inicial.';

/** Campos do passo -> mensagem de erro ou null (mesmas regras da função e do primeiro acesso). */
export function validaRecuperacao([login, cpf, senha, repetida]) {
  const l = String(login ?? '').trim();
  if (!l) return 'Informe a matrícula ou o e-mail.';
  if (!cpfValido(cpf)) return 'CPF inválido.';
  if (String(senha).length < SENHA_MIN) return `A senha precisa de pelo menos ${SENHA_MIN} caracteres.`;
  if (senha !== repetida) return 'As senhas não conferem.';
  if (/^\d+$/.test(l) && (senha.includes(l) || senha.includes([...l].reverse().join('')))) {
    return 'A senha não pode conter a matrícula.';
  }
  return null;
}

/** POST na datageo-senha com a anon key (quem recupera não tem sessão). */
export async function recuperarSenha({ login, cpf, senha }, doFetch = fetch) {
  const resp = await doFetch(`${SUPABASE_URL}/functions/v1/datageo-senha`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: String(login).trim(), cpf: soDigitos(cpf), senha }),
  });
  if (resp.ok) return { ok: true };
  const corpo = await resp.json().catch(() => ({}));
  return { erro: corpo.error || `Erro ${resp.status}. Tente de novo.` };
}
