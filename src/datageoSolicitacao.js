// src/datageoSolicitacao.js
//
// "Solicitar acesso" no gate de login (src/datageoLogin.js), só para usuários
// EXTERNOS: servidor do IDR entra com matrícula e senha provisória. O pedido
// vai para datageo_solicitacao do c2-parana (migration 052: INSERT anônimo só
// nas colunas do formulário) e o admin aprova ou recusa na aba Solicitações
// do painel de acessos. Aprovado vira usuário externo (sem o bucket privado).

import { ANON_KEY, SUPABASE_URL } from './data/datageoAuth.js';
import { cpfValido, emailValido, mascaraCpf, soDigitos } from './data/termoLgpd.js';

const FINALIDADE_MIN = 10;

/** (41) 99999-9999 enquanto digita. */
export function mascaraTelefone(valor) {
  const d = soDigitos(valor).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  const meio = d.length === 11 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, meio)}${d.length > meio ? `-${d.slice(meio)}` : ''}`;
}

const limpo = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** Campos digitados -> { erro } ou { linha } pronta para o INSERT (colunas com grant na 052). */
export function montaSolicitacao(c) {
  const linha = {
    entidade: limpo(c.entidade),
    nome: limpo(c.nome),
    endereco: limpo(c.endereco),
    cpf: soDigitos(c.cpf),
    telefone: soDigitos(c.telefone),
    email: limpo(c.email).toLowerCase(),
    finalidade: limpo(c.finalidade),
    aceite_lgpd: true,
  };
  if (linha.entidade.length < 2) return { erro: 'Informe a entidade.' };
  if (linha.nome.length < 3) return { erro: 'Informe o nome completo.' };
  if (linha.endereco.length < 5) return { erro: 'Informe o endereço.' };
  if (!cpfValido(linha.cpf)) return { erro: 'CPF inválido.' };
  if (!/^\d{10,11}$/.test(linha.telefone)) return { erro: 'Telefone com DDD (10 ou 11 dígitos).' };
  if (!emailValido(linha.email)) return { erro: 'E-mail inválido.' };
  if (linha.finalidade.length < FINALIDADE_MIN) return { erro: 'Descreva a finalidade de uso dos dados.' };
  if (!c.aceite) return { erro: 'Marque a autorização de uso dos dados para analisar o pedido.' };
  return { linha };
}

/** Envia o pedido com a anon key (quem pede não tem sessão). */
export async function enviarSolicitacao(linha, doFetch = fetch) {
  const resp = await doFetch(`${SUPABASE_URL}/rest/v1/datageo_solicitacao`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(linha),
  });
  if (resp.ok) return { ok: true };
  if (resp.status === 409) return { erro: 'Já existe uma solicitação pendente para este e-mail.' };
  const corpo = await resp.json().catch(() => ({}));
  if (corpo.code === '54000') return { erro: 'Muitas solicitações agora. Tente de novo mais tarde.' };
  return { erro: `Não foi possível enviar (erro ${resp.status}). Tente de novo.` };
}

// ---------------------------------------------------------------- formulário

const CAMPOS = [
  ['entidade', 'Entidade (órgão, prefeitura, empresa...)', { autocomplete: 'organization', maxLength: 160 }],
  ['nome', 'Nome completo', { autocomplete: 'name', maxLength: 120 }],
  ['endereco', 'Endereço', { autocomplete: 'street-address', maxLength: 300 }],
  ['cpf', 'CPF', { inputMode: 'numeric', maxLength: 14, placeholder: '000.000.000-00', autocomplete: 'off' }],
  ['telefone', 'Telefone', { type: 'tel', inputMode: 'tel', maxLength: 15, placeholder: '(41) 99999-9999', autocomplete: 'tel' }],
  ['email', 'E-mail (será o seu login)', { type: 'email', autocomplete: 'email', maxLength: 160 }],
  ['finalidade', 'Finalidade de uso dos dados', { tag: 'textarea', rows: 3, maxLength: 1000 }],
];

function campo(nome, rotulo, attrs) {
  const wrap = Object.assign(document.createElement('label'), { className: 'login-field' });
  const span = Object.assign(document.createElement('span'), { textContent: rotulo });
  const input = Object.assign(document.createElement(attrs.tag ?? 'input'), { name: nome, required: true });
  for (const [k, v] of Object.entries(attrs)) if (k !== 'tag') input[k] = v;
  wrap.append(span, input);
  return wrap;
}

const texto = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent });

/** Formulário de pedido no lugar do login; `voltar()` retorna ao login. */
export function pedirSolicitacao(form, { voltar }) {
  form.replaceChildren();
  form.classList.add('login-form-solicitacao');
  form.onsubmit = null;
  const sair = () => {
    form.classList.remove('login-form-solicitacao');
    voltar();
  };

  const aviso = texto('p', 'login-hint login-destaque',
    'Somente para usuários externos (outros órgãos, prefeituras, entidades). Servidor do IDR-Paraná não precisa '
    + 'solicitar: entre com a sua matrícula e a senha provisória.');
  const nota = texto('p', 'login-hint',
    'Externos acessam as camadas abertas e as do Supabase; dados não-abertos (CAF, CadÚnico, ADAPAR, programas '
    + 'do IDR) ficam restritos a servidores. A resposta vem pelo e-mail ou telefone informado.');
  const aceite = document.createElement('label');
  aceite.className = 'login-aceite';
  const check = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'aceite' });
  aceite.append(check, document.createTextNode(
    ' Autorizo o uso destes dados pela administração do DataGeo somente para analisar e responder a este pedido (LGPD).'));
  const erro = texto('p', 'login-error', '');
  erro.setAttribute('role', 'alert');
  const enviar = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Enviar pedido' });
  const voltarBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Voltar', className: 'login-secundario' });
  const acoes = Object.assign(document.createElement('div'), { className: 'login-actions' });
  acoes.append(enviar, voltarBtn);
  const campos = CAMPOS.map(([n, r, a]) => campo(n, r, a));
  form.append(texto('p', 'login-title', 'Solicitar acesso · usuário externo'), aviso, ...campos, nota, aceite, erro, acoes);

  const el = (n) => form.elements.namedItem(n);
  el('cpf').addEventListener('input', (e) => { e.target.value = mascaraCpf(e.target.value); });
  el('telefone').addEventListener('input', (e) => { e.target.value = mascaraTelefone(e.target.value); });
  voltarBtn.addEventListener('click', sair);
  el('entidade').focus();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const valores = Object.fromEntries(CAMPOS.map(([n]) => [n, el(n).value]));
    const { erro: msg, linha } = montaSolicitacao({ ...valores, aceite: check.checked });
    if (msg) { erro.textContent = msg; return; }
    enviar.disabled = true;
    erro.textContent = '';
    try {
      const res = await enviarSolicitacao(linha);
      if (res.erro) { erro.textContent = res.erro; return; }
      form.replaceChildren(
        texto('p', 'login-title', 'Pedido enviado'),
        texto('p', 'login-hint', `Recebemos seu pedido. A administração do DataGeo vai analisar e responder pelo e-mail ${linha.email}.`),
        Object.assign(document.createElement('button'), { type: 'button', textContent: 'Voltar ao login', onclick: sair }),
      );
    } catch (e) {
      console.error('[solicitacao]', e);
      erro.textContent = 'Falha de conexão. Tente de novo.';
    } finally {
      enviar.disabled = false;
    }
  };
}
