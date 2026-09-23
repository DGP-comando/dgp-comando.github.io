// src/data/datageoAuth.js
//
// Sessao do DataGeo no Supabase Auth do c2-parana. Os dados so sao legiveis
// com um JWT que tenha app_metadata.datageo = true (migration 045 do c2); a
// anon key sozinha nao le mais nada.
//
// Usuarios do SISATER (scripts/import_usuarios_sisater.py) entram pela
// matricula: email sintetico <matricula>@sisater.local e senha com prefixo
// (o Supabase exige >= 6 caracteres e ha matriculas de 3-4 digitos). Quem
// digita um e-mail entra com a senha crua (usuarios do c2).

import { AuthClient } from '@supabase/auth-js';

// `import.meta.env` so existe sob Vite; no node:test e undefined.
export const SUPABASE_URL = (
  import.meta.env?.VITE_DATAGEO_SUPABASE_URL || 'https://fialxjcsgywvvuxjxcly.supabase.co'
).replace(/\/+$/, '');

export const ANON_KEY =
  import.meta.env?.VITE_DATAGEO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWx4amNzZ3l3dnZ1eGp4Y2x5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNjczNTMsImV4cCI6MjA4Nzk0MzM1M30.e3X-LSPVUbxl-P9KLB9TuGB0nkmZ4OrNyHL9SuxaRgM';

// Mesmos valores do script de importacao.
const EMAIL_DOMINIO = 'sisater.local';
const SENHA_PREFIXO = 'dgp:';
export const SENHA_MIN = 8;

let _auth = null;
export function getAuth() {
  _auth ??= new AuthClient({
    url: `${SUPABASE_URL}/auth/v1`,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    storageKey: 'datageo-auth',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  });
  return _auth;
}

const isSisater = (email) => String(email ?? '').endsWith(`@${EMAIL_DOMINIO}`);

/** Login digitado (matricula ou e-mail) -> credenciais do Supabase. */
export function credenciais(login, senha) {
  const l = String(login).trim();
  if (l.includes('@')) return { email: l.toLowerCase(), password: senha };
  return { email: `${l}@${EMAIL_DOMINIO}`, password: SENHA_PREFIXO + senha };
}

/** Senha nova digitada -> senha gravada (mesma regra do login). */
export function senhaGravada(user, senha) {
  return isSisater(user?.email) ? SENHA_PREFIXO + senha : senha;
}

export const temAcesso = (user) => user?.app_metadata?.datageo === true;
export const precisaTrocarSenha = (user) => user?.user_metadata?.must_change_password === true;

/** Headers PostgREST/Storage com o JWT do usuario (getSession renova se expirou). */
export async function authHeaders() {
  const { data } = await getAuth().getSession();
  const token = data.session?.access_token ?? ANON_KEY;
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}` };
}
