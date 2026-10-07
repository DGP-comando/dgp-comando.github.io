// src/datageoLogin.js
//
// Gate de login antes do boot (main.js). Resolve so quando ha sessao de um
// usuario liberado (app_metadata.datageo) que ja trocou a senha inicial e
// assinou o termo de responsabilidade LGPD (src/data/termoLgpd.js); o tutorial
// de entrada so vem depois do boot.
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
import {
  TERMO_BUCKET, TERMO_TEXTO, TERMO_TITULO, TERMO_VERSAO, caminhoRegistro, cpfValido, emailReal, emailValido,
  mascaraCpf, montaRegistro, termoAssinado,
} from './data/termoLgpd.js';

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

/** Grava o registro da assinatura no bucket (só INSERT na própria pasta, migration 047 do c2). */
async function gravaRegistro(user, registro, agora) {
  const caminho = caminhoRegistro(user, agora).split('/').map(encodeURIComponent).join('/');
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${TERMO_BUCKET}/${caminho}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(registro),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text().catch(() => '')}`);
}

/**
 * Termo de responsabilidade LGPD: texto, CPF, e-mail e aceite. Assinar grava o
 * registro no bucket e marca a versão no user_metadata; recusar sai da conta.
 */
async function pedirTermo(form, user) {
  form.replaceChildren();
  form.classList.add('login-form-termo');
  const h = Object.assign(document.createElement('p'), { className: 'login-title', textContent: TERMO_TITULO });
  const texto = document.createElement('div');
  texto.className = 'login-termo';
  texto.tabIndex = 0;
  texto.setAttribute('aria-label', TERMO_TITULO);
  const lista = document.createElement('ol');
  for (const par of TERMO_TEXTO) lista.append(Object.assign(document.createElement('li'), { textContent: par }));
  texto.append(lista);
  const cpf = campo('CPF', { name: 'cpf', inputMode: 'numeric', autocomplete: 'off', maxLength: 14, placeholder: '000.000.000-00' });
  cpf.input.addEventListener('input', () => { cpf.input.value = mascaraCpf(cpf.input.value); });
  const email = campo('E-mail', { type: 'email', name: 'email', autocomplete: 'email', value: emailReal(user) });
  const aceite = document.createElement('label');
  aceite.className = 'login-aceite';
  const check = Object.assign(document.createElement('input'), { type: 'checkbox', required: true });
  aceite.append(check, document.createTextNode(' Li o termo e me comprometo a cumpri-lo.'));
  const nota = Object.assign(document.createElement('p'), {
    className: 'login-hint',
    textContent: `Versão ${TERMO_VERSAO}. A data e a hora da assinatura ficam registradas com o seu CPF e e-mail.`,
  });
  const erro = Object.assign(document.createElement('p'), { className: 'login-error' });
  erro.setAttribute('role', 'alert');
  const assinar = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Assinar e entrar' });
  const recusar = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Recusar e sair' });
  recusar.className = 'login-secundario';
  const acoes = Object.assign(document.createElement('div'), { className: 'login-actions' });
  acoes.append(assinar, recusar);
  form.append(h, texto, cpf.wrap, email.wrap, aceite, nota, erro, acoes);
  texto.focus();

  recusar.addEventListener('click', async () => {
    await getAuth().signOut({ scope: 'local' });
    location.reload();
  });

  return new Promise((resolve) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!cpfValido(cpf.input.value)) { erro.textContent = 'CPF inválido.'; return; }
      if (!emailValido(email.input.value)) { erro.textContent = 'E-mail inválido.'; return; }
      if (!check.checked) { erro.textContent = 'Marque a declaração de que leu e aceita o termo.'; return; }
      assinar.disabled = true;
      recusar.disabled = true;
      erro.textContent = '';
      try {
        const agora = new Date();
        const registro = await montaRegistro(user, { cpf: cpf.input.value, email: email.input.value }, agora, navigator.userAgent);
        await gravaRegistro(user, registro, agora);
        const { data, error } = await getAuth().updateUser({
          data: { lgpd_termo: { versao: TERMO_VERSAO, em: agora.toISOString() } },
        });
        if (error) throw error;
        form.classList.remove('login-form-termo');
        resolve(data.user);
      } catch (e) {
        console.error('[termo LGPD]', e);
        erro.textContent = 'Não foi possível registrar a assinatura. Tente de novo.';
      } finally {
        assinar.disabled = false;
        recusar.disabled = false;
      }
    };
  });
}

export async function requireLogin() {
  const screen = document.getElementById('loading-screen');
  const content = screen.querySelector('.loader-content');
  const status = content.querySelector('.loader-status');

  const { data } = await getAuth().getSession();
  let user = data.session?.user ?? null;
  if (user && temAcesso(user) && !precisaTrocarSenha(user)) {
    // Sessão salva também passa pelo termo (versão nova do texto = assinar de novo).
    if (!termoAssinado(user)) {
      status.hidden = true;
      const form = montarForm(content);
      user = await pedirTermo(form, user);
      form.remove();
      status.hidden = false;
    }
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
  if (precisaTrocarSenha(user)) user = await pedirNovaSenha(form, user);
  if (!termoAssinado(user)) user = await pedirTermo(form, user);
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
