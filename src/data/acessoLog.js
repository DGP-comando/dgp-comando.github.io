// src/data/acessoLog.js
//
// Log de acesso do DataGeo: tabela datageo_acesso_log do c2-parana (migrations
// 048/049). O usuário só INSERE a própria linha; user_id e criado_em vêm do
// servidor. Lido apenas pelo painel do admin (src/datageoAnalytics.js).
//
// Os eventos entram numa fila em memória e saem em lote (15 s, 20 eventos ou
// aba escondida). Falha transitória (rede, 401, 5xx) devolve o lote à fila;
// recusa definitiva (outro 4xx) descarta. O log nunca derruba o app.

import { SUPABASE_URL, authHeaders } from './datageoAuth.js';

const FLUSH_MS = 15_000;
const LOTE = 20;
const FILA_MAX = 500;
const DEDUP_MS = 2_000;
const HEARTBEAT_MS = 5 * 60_000;
const ALVO_MAX = 300;
const KEEPALIVE_BYTES = 50_000; // fetch keepalive recusa corpo > 64 KB

/** Erro de envio que vale tentar de novo (rede, sessão expirada, servidor). */
export class FalhaTransitoria extends Error {}

/** Fila com dedup (mesmo evento+alvo em < 2 s conta uma vez). `enviar(lote, opts)` faz o POST. */
export function criarFila({ enviar, sessaoId, agora = Date.now, lote = LOTE }) {
  let fila = [];
  const visto = new Map();

  async function descarregar(opts = {}) {
    if (!fila.length) return 0;
    const saindo = fila;
    fila = [];
    try {
      await enviar(saindo, opts);
      return saindo.length;
    } catch (err) {
      if (err instanceof FalhaTransitoria) fila = [...saindo, ...fila].slice(-FILA_MAX);
      console.warn('[acessoLog] envio falhou:', err?.message ?? err);
      return 0;
    }
  }

  function registrar(evento, alvo = null, detalhe = null) {
    const chave = `${evento}|${alvo ?? ''}`;
    const t = agora();
    if (t - (visto.get(chave) ?? -Infinity) < DEDUP_MS) return false;
    visto.set(chave, t);
    fila = [...fila, {
      sessao_id: sessaoId,
      evento,
      alvo: alvo == null ? null : String(alvo).slice(0, ALVO_MAX),
      detalhe: detalhe ?? null,
    }].slice(-FILA_MAX);
    if (fila.length >= lote) void descarregar();
    return true;
  }

  return { registrar, descarregar, pendentes: () => fila.length };
}

/** Divide o lote em pedaços de JSON abaixo de `max` bytes (keepalive). */
export function emPedacos(linhas, max = KEEPALIVE_BYTES) {
  const pedacos = [];
  let atual = [];
  let tam = 2;
  for (const l of linhas) {
    const n = JSON.stringify(l).length + 1;
    if (atual.length && tam + n > max) {
      pedacos.push(atual);
      atual = [];
      tam = 2;
    }
    atual = [...atual, l];
    tam += n;
  }
  return atual.length ? [...pedacos, atual] : pedacos;
}

// Headers do último envio: no envio de saída (aba escondida/fechando) não dá
// para esperar getSession, que pode renovar o token pela rede.
let _headers = null;

async function postar(linhas, { keepalive = false } = {}) {
  if (!keepalive || !_headers) _headers = await authHeaders();
  const pedacos = keepalive ? emPedacos(linhas) : [linhas];
  const respostas = await Promise.all(pedacos.map((p) => fetch(`${SUPABASE_URL}/rest/v1/datageo_acesso_log`, {
    method: 'POST',
    keepalive,
    headers: { ..._headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(p),
  }).catch((err) => { throw new FalhaTransitoria(err.message); })));
  const ruim = respostas.find((r) => !r.ok);
  if (!ruim) return;
  const msg = `HTTP ${ruim.status}`;
  throw ruim.status === 401 || ruim.status >= 500 ? new FalhaTransitoria(msg) : new Error(msg);
}

/** Uma sessão por aba: sobrevive a recarregar a página (sessionStorage). */
function sessaoDaAba() {
  try {
    const id = sessionStorage.getItem('datageo-sessao') ?? crypto.randomUUID();
    sessionStorage.setItem('datageo-sessao', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

let _fila = null;

/** Registra um evento; no-op (false) antes do login (ativarLog) e no ?semlogin de dev. */
export function registrar(evento, alvo, detalhe) {
  return _fila?.registrar(evento, alvo, detalhe) ?? false;
}

/** Envia o que estiver na fila (ex.: antes do signOut). */
export const descarregarLog = (opts) => _fila?.descarregar(opts) ?? Promise.resolve(0);

/** Liga o log depois do login. `via`: 'login' | 'sessao_salva'. */
export function ativarLog(via) {
  if (_fila) return;
  _fila = criarFila({ enviar: postar, sessaoId: sessaoDaAba() });
  const url = new URL(location.href);
  registrar('sessao_inicio', via, {
    link_compartilhado: Boolean(url.hash.length > 1 || url.search.length > 1),
    tela: `${innerWidth}x${innerHeight}`,
    movel: globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false,
  });
  setInterval(() => void _fila.descarregar(), FLUSH_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') registrar('heartbeat');
  }, HEARTBEAT_MS);
  const sair = () => void _fila.descarregar({ keepalive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sair();
  });
  addEventListener('pagehide', sair);
}
