// src/datageoLogin.js
//
// Gate de login antes do boot (main.js). Resolve so quando ha sessao de um
// usuario liberado (app_metadata.datageo) que ja trocou a senha inicial.
// A protecao de verdade e a RLS do Supabase; isto e a porta de entrada.

import {
  SENHA_MIN,
  SUPABASE_URL,
  authHeaders,
  credenciais,
  getAuth,
  precisaTrocarSenha,
  senhaGravada,
  temAcesso,
} from './data/datageoAuth.js';

const MSG_SEM_ACESSO = 'Seu usuário não tem acesso ao DataGeo. Procure o administrador.';

function montarForm(content) {
  const form = document.createElement('form');
  form.className = 'login-form';
  form.noValidate = true;
  content.append(form);
  return form;
}

function campo(label, attrs) {
  const wrap = document.createElement('label');
  wrap.className = 'login-field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = Object.assign(document.createElement('input'), attrs);
  input.required = true;
  wrap.append(span, input);
  return { wrap, input };
}

/** Renderiza um passo do gate e resolve com o submit validado. */
function passo(form, { titulo, campos, botao, validar, enviar, aviso = '' }) {
  form.replaceChildren();
  const h = document.createElement('p');
  h.className = 'login-title';
  h.textContent = titulo;
  const inputs = campos.map((c) => campo(c.label, c.attrs));
  const erro = document.createElement('p');
  erro.className = 'login-error';
  erro.setAttribute('role', 'alert');
  erro.textContent = aviso;
  const btn = Object.assign(document.createElement('button'), { type: 'submit', textContent: botao });
  form.append(h, ...inputs.map((i) => i.wrap), erro, btn);
  inputs[0].input.focus();

  return new Promise((resolve) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const valores = inputs.map((i) => i.input.value);
      const msg = validar?.(valores);
      if (msg) { erro.textContent = msg; return; }
      btn.disabled = true;
      erro.textContent = '';
      try {
        const res = await enviar(valores);
        if (res?.erro) { erro.textContent = res.erro; return; }
        resolve(res);
      } catch (e) {
        console.error('[login]', e);
        erro.textContent = 'Falha de conexão. Tente de novo.';
      } finally {
        btn.disabled = false;
      }
    };
  });
}

async function pedirLogin(form, aviso) {
  return passo(form, {
    aviso,
    titulo: 'Acesso restrito',
    botao: 'Entrar',
    campos: [
      { label: 'Matrícula', attrs: { name: 'username', autocomplete: 'username', inputMode: 'text' } },
      { label: 'Senha', attrs: { type: 'password', name: 'password', autocomplete: 'current-password' } },
    ],
    validar: ([login, senha]) => (!login.trim() || !senha ? 'Informe matrícula e senha.' : null),
    enviar: async ([login, senha]) => {
      const { data, error } = await getAuth().signInWithPassword(credenciais(login, senha));
      if (error) {
        return { erro: error.status === 400 ? 'Matrícula ou senha incorretas.' : error.message };
      }
      return data.user;
    },
  });
}

async function pedirNovaSenha(form, user) {
  return passo(form, {
    titulo: 'Primeiro acesso: defina sua senha',
    botao: 'Salvar senha',
    campos: [
      { label: `Nova senha (mín. ${SENHA_MIN})`, attrs: { type: 'password', autocomplete: 'new-password' } },
      { label: 'Repita a senha', attrs: { type: 'password', autocomplete: 'new-password' } },
    ],
    validar: ([a, b]) => {
      if (a.length < SENHA_MIN) return `A senha precisa de pelo menos ${SENHA_MIN} caracteres.`;
      if (a !== b) return 'As senhas não conferem.';
      const mat = user.user_metadata?.matricula;
      if (mat && (a.includes(mat) || a.includes([...mat].reverse().join('')))) {
        return 'A senha não pode conter a matrícula.';
      }
      return null;
    },
    enviar: async ([senha]) => {
      const { data, error } = await getAuth().updateUser({
        password: senhaGravada(user, senha),
        data: { must_change_password: false },
      });
      return error ? { erro: error.message } : data.user;
    },
  });
}

export async function requireLogin() {
  const screen = document.getElementById('loading-screen');
  const content = screen.querySelector('.loader-content');
  const status = content.querySelector('.loader-status');

  const { data } = await getAuth().getSession();
  let user = data.session?.user ?? null;
  if (user && temAcesso(user) && !precisaTrocarSenha(user)) {
    initConta(user);
    return;
  }

  status.hidden = true;
  const form = montarForm(content);
  let aviso = '';
  for (;;) {
    user ??= await pedirLogin(form, aviso);
    if (temAcesso(user)) break;
    await getAuth().signOut({ scope: 'local' });
    user = null;
    aviso = MSG_SEM_ACESSO;
  }
  if (precisaTrocarSenha(user)) await pedirNovaSenha(form, user);
  form.remove();
  status.hidden = false;
  initConta(user);
}

/** Botao Sair e, para admin (app_metadata.datageo_admin), o cadastro de usuarios. */
function initConta(user) {
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await getAuth().signOut({ scope: 'local' });
    location.reload();
  });
  const btn = document.getElementById('usuarios-btn');
  const dialog = document.getElementById('usuarios-dialog');
  if (!btn || !dialog || user?.app_metadata?.datageo_admin !== true) return;
  btn.hidden = false;
  btn.addEventListener('click', () => dialog.showModal());

  const form = dialog.querySelector('form');
  const msg = form.querySelector('.login-error');
  const mostrar = (texto, ok = false) => {
    msg.textContent = texto;
    msg.classList.toggle('login-ok', ok);
  };
  form.addEventListener('submit', async (ev) => {
    const acao = ev.submitter?.value;
    if (acao === 'fechar') { mostrar(''); return; }
    ev.preventDefault();
    const matricula = form.matricula.value.trim();
    const nome = form.nome.value.trim();
    if (!/^\d{3,10}$/.test(matricula)) return mostrar('Matrícula deve ter de 3 a 10 dígitos.');
    if (acao === 'criar' && nome.length < 3) return mostrar('Informe o nome completo.');
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    mostrar('Enviando...');
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/datageo-usuarios`, {
        method: 'POST',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao, matricula, nome }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return mostrar(body.error || `Erro ${resp.status}`);
      mostrar(acao === 'criar'
        ? `Matrícula ${matricula} cadastrada. Senha inicial: a matrícula invertida.`
        : `Senha da matrícula ${matricula} voltou para a inicial.`, true);
      form.reset();
    } catch (e) {
      console.error('[usuarios]', e);
      mostrar('Falha de conexão. Tente de novo.');
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  });
}
