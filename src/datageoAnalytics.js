// src/datageoAnalytics.js
//
// Painel de acessos do DataGeo, só para admin (app_metadata.datageo_admin).
// Lê as RPCs datageo_acesso_resumo e datageo_acesso_eventos (migration 048 do
// c2-parana; o log é gravado por src/data/acessoLog.js) e cruza a matrícula
// com servidores-idr.json para a lotação. Gráficos em HTML/SVG puro: base
// cinza e uma cor de destaque (--accent).

import { SUPABASE_URL, authHeaders, getAuth } from './data/datageoAuth.js';
import { loadServidoresIdr } from './data/servidoresIdr.js';
import { downloadText, toCsv } from './data/areaExport.js';
import { escapeHtml as esc } from './data/vesselTooltip.js';

const TZ = 'America/Sao_Paulo';
const POR_PAGINA = 100;
const RPC_MAX = 1000; // teto da RPC (e do db-max-rows): export pagina nesse passo
const DIA_MS = 86_400_000;

export const EVENTOS = Object.freeze({
  sessao_inicio: 'Entrada',
  logout: 'Saída',
  heartbeat: 'Em uso (5 min)',
  camada_on: 'Ligou camada',
  camada_off: 'Desligou camada',
  ficha_municipio: 'Ficha municipal',
  ficha_regiao: 'Ficha regional',
  registro_aberto: 'Abriu cadastro',
  busca_pessoa: 'Busca de pessoa',
  dado_privado: 'Arquivo restrito',
  exportacao: 'Exportação',
  usuario_criar: 'Admin: cadastrou usuário',
  usuario_resetar: 'Admin: resetou senha',
  usuario_revogar: 'Admin: revogou acesso',
});
const SENSIVEIS = new Set(['busca_pessoa', 'registro_aberto', 'exportacao']);

const fmtInt = (n) => Number(n ?? 0).toLocaleString('pt-BR');
const fmtDataHora = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })
  : '—');
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`);

// ---------------------------------------------------------------- dados puros

/**
 * Usuários do resumo + nome, lotação e diretoria do servidor de mesma
 * matrícula (SisPont). A matrícula vem do e-mail do login (migration 049); o
 * nome do cadastro (user_metadata, editável pelo usuário) é só reserva.
 */
export function comLotacao(usuarios, servidores) {
  const porId = new Map((servidores ?? []).map((s) => [String(s.id), s]));
  return (usuarios ?? []).map((u) => {
    const s = porId.get(String(u.matricula ?? ''));
    return {
      ...u, nome: s?.nome || u.nome || u.email || '—',
      lotacao: s?.setor || 'Sem lotação no SisPont', diretoria: s?.diretoria || '',
    };
  });
}

/** Ativos x liberados por lotação, ordenado por ativos. */
export function agregaLotacao(usuarios) {
  const mapa = new Map();
  for (const u of usuarios) {
    const a = mapa.get(u.lotacao) ?? { lotacao: u.lotacao, liberados: 0, ativos: 0, acoes: 0 };
    mapa.set(u.lotacao, {
      ...a, liberados: a.liberados + 1, ativos: a.ativos + (u.acoes > 0 ? 1 : 0), acoes: a.acoes + u.acoes,
    });
  }
  return [...mapa.values()].filter((l) => l.ativos > 0).sort((a, b) => b.ativos - a.ativos || b.acoes - a.acoes);
}

/** Filtro da aba Usuários: texto (nome/matrícula/lotação) + situação. */
export function filtraUsuarios(usuarios, { busca = '', situacao = 'todos', agora = Date.now() } = {}) {
  const q = busca.trim().toLowerCase();
  const ultimo = (u) => Date.parse(u.ultimo_evento ?? u.ultimo_login ?? '') || 0;
  return usuarios.filter((u) => {
    if (q && !`${u.nome} ${u.matricula} ${u.lotacao}`.toLowerCase().includes(q)) return false;
    if (situacao === 'ativos') return u.acoes > 0;
    if (situacao === 'inativos') return Boolean(u.ultimo_login) && agora - ultimo(u) > 30 * DIA_MS;
    if (situacao === 'nunca') return !u.ultimo_login;
    return true;
  });
}

export function ordena(lista, chave, desc) {
  const v = (x) => x[chave] ?? '';
  return [...lista].sort((a, b) => {
    const r = typeof v(a) === 'number' && typeof v(b) === 'number'
      ? v(a) - v(b)
      : String(v(a)).localeCompare(String(v(b)), 'pt-BR');
    return desc ? -r : r;
  });
}

// ------------------------------------------------------------------- RPC

async function rpc(nome, args) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`${nome}: HTTP ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  return resp.json();
}

// ------------------------------------------------------------------- gráficos

function barras(itens, { rotulo, valor, sub = null, vazio = 'Sem registros no período.' }) {
  if (!itens.length) return `<p class="an-vazio">${vazio}</p>`;
  const max = Math.max(...itens.map(valor), 1);
  return `<ol class="an-barras">${itens.map((it, i) => `
    <li${i === 0 ? ' class="an-destaque"' : ''}>
      <span class="an-barra-rotulo" title="${esc(rotulo(it))}">${esc(rotulo(it))}</span>
      <span class="an-barra-trilho"><span class="an-barra" style="width:${(100 * valor(it)) / max}%"></span></span>
      <span class="an-barra-valor">${fmtInt(valor(it))}${sub ? `<small>${esc(sub(it))}</small>` : ''}</span>
    </li>`).join('')}</ol>`;
}

/** Linha de usuários/dia com eixo a partir de zero; preenche dias sem acesso. */
function linhaDiaria(diario, dias) {
  const porDia = new Map(diario.map((d) => [d.dia, d]));
  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const dia = new Date(Date.now() - i * DIA_MS).toLocaleDateString('sv-SE', { timeZone: TZ });
    serie.push({ dia, usuarios: porDia.get(dia)?.usuarios ?? 0 });
  }
  const W = 640, H = 160, P = 28;
  const max = Math.max(...serie.map((s) => s.usuarios), 1);
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(serie.length - 1, 1);
  const y = (v) => H - P - (v * (H - 2 * P)) / max;
  const pts = serie.map((s, i) => `${x(i).toFixed(1)},${y(s.usuarios).toFixed(1)}`).join(' ');
  const ult = serie.at(-1);
  const pico = serie.reduce((a, b) => (b.usuarios > a.usuarios ? b : a));
  const dm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
  return `<svg class="an-linha" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Usuários por dia; pico de ${pico.usuarios} em ${dm(pico.dia)}">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="an-eixo"/>
    <text x="${P - 6}" y="${y(max) + 4}" class="an-tick" text-anchor="end">${max}</text>
    <text x="${P - 6}" y="${H - P + 4}" class="an-tick" text-anchor="end">0</text>
    <text x="${P}" y="${H - 8}" class="an-tick">${dm(serie[0].dia)}</text>
    <text x="${W - P}" y="${H - 8}" class="an-tick" text-anchor="end">${dm(ult.dia)}</text>
    <polyline points="${pts}" class="an-serie"/>
    <circle cx="${x(serie.length - 1)}" cy="${y(ult.usuarios)}" r="3.5" class="an-ponto"/>
    <text x="${x(serie.length - 1) - 6}" y="${y(ult.usuarios) - 8}" class="an-anot" text-anchor="end">hoje: ${ult.usuarios}</text>
  </svg>`;
}

function heatmap(celulas) {
  const v = new Map(celulas.map((c) => [`${c.dow}-${c.hora}`, c.sessoes]));
  const max = Math.max(...celulas.map((c) => c.sessoes), 1);
  const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const horas = Array.from({ length: 24 }, (_, h) => h);
  return `<table class="an-heat"><thead><tr><th></th>${horas.map((h) => `<th>${h % 3 ? '' : h}</th>`).join('')}</tr></thead>
    <tbody>${dias.map((d, i) => `<tr><th>${d}</th>${horas.map((h) => {
      const n = v.get(`${i + 1}-${h}`) ?? 0;
      return `<td style="--a:${(n / max).toFixed(2)}" title="${d} ${h}h: ${n} sessões"></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

function retencao(coortes) {
  if (!coortes.length) return '<p class="an-vazio">Ainda sem semanas completas.</p>';
  return `<table class="an-tabela an-compacta"><thead><tr><th>Semana do 1º acesso</th><th>Novos</th><th>Voltaram na semana seguinte</th></tr></thead>
    <tbody>${coortes.map((c) => `<tr><td>${c.semana.split('-').reverse().join('/')}</td><td>${c.novos}</td>
      <td>${c.voltaram} (${Math.round((100 * c.voltaram) / Math.max(c.novos, 1))}%)</td></tr>`).join('')}</tbody></table>`;
}

const kpi = (rotulo, valor, nota = '') =>
  `<div class="an-kpi"><span class="an-kpi-valor">${valor}</span><span class="an-kpi-rotulo">${rotulo}</span>${nota ? `<small>${nota}</small>` : ''}</div>`;

// ------------------------------------------------------------------- painel

export function initAnalytics({ nomeCamada = (id) => id } = {}) {
  const btn = document.getElementById('analytics-btn');
  if (!btn) return;
  void getAuth().getSession().then(({ data }) => {
    if (data.session?.user?.app_metadata?.datageo_admin !== true) return;
    btn.hidden = false;
    let painel = null;
    btn.addEventListener('click', () => {
      painel ??= criarPainel(nomeCamada);
      painel.abrir();
    });
  });
}

function criarPainel(nomeCamada) {
  const dlg = document.createElement('dialog');
  dlg.id = 'analytics-dialog';
  dlg.setAttribute('aria-labelledby', 'an-titulo');
  dlg.innerHTML = `
    <header class="an-topo">
      <h2 id="an-titulo">Acessos ao DataGeo</h2>
      <label>Período <select class="an-periodo">
        <option value="7">7 dias</option><option value="30" selected>30 dias</option>
        <option value="90">90 dias</option><option value="365">12 meses</option></select></label>
      <nav class="an-abas" role="tablist">
        <button role="tab" data-aba="geral" aria-selected="true">Visão geral</button>
        <button role="tab" data-aba="usuarios" aria-selected="false">Usuários</button>
        <button role="tab" data-aba="log" aria-selected="false">Log completo</button>
      </nav>
      <button class="an-fechar" aria-label="Fechar"><span class="material-symbols-outlined">close</span></button>
    </header>
    <section class="an-corpo" data-aba="geral"></section>
    <section class="an-corpo" data-aba="usuarios" hidden></section>
    <section class="an-corpo" data-aba="log" hidden></section>`;
  document.body.append(dlg);
  const secao = (aba) => dlg.querySelector(`section[data-aba="${aba}"]`);
  const periodo = dlg.querySelector('.an-periodo');
  let usuarios = [];
  let nomePorMatricula = new Map();
  const estadoUsuarios = { busca: '', situacao: 'todos', chave: 'acoes', desc: true };
  const filtroLog = { usuario: null, evento: '', busca: '', de: '', ate: '', pagina: 0, corte: Date.now() };
  let reqLog = 0;

  const trocarAba = (aba) => {
    for (const b of dlg.querySelectorAll('[data-aba][role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.aba === aba));
    for (const s of dlg.querySelectorAll('section[data-aba]')) s.hidden = s.dataset.aba !== aba;
    if (aba === 'log') recarregar();
  };
  dlg.querySelector('.an-abas').addEventListener('click', (e) => {
    const aba = e.target.closest('[data-aba]')?.dataset.aba;
    if (aba) trocarAba(aba);
  });
  dlg.querySelector('.an-fechar').addEventListener('click', () => dlg.close());
  periodo.addEventListener('change', () => {
    void carregarResumo();
    if (!secao('log').hidden) recarregar();
  });

  async function carregarResumo() {
    const geral = secao('geral');
    geral.innerHTML = '<p class="an-vazio">Carregando…</p>';
    try {
      const dias = Number(periodo.value);
      const [r, serv] = await Promise.all([
        rpc('datageo_acesso_resumo', { p_dias: dias }),
        loadServidoresIdr().then((d) => d.servidores).catch(() => []),
      ]);
      usuarios = comLotacao(r.usuarios, serv);
      nomePorMatricula = new Map(serv.map((x) => [String(x.id), x.nome]));
      renderGeral(geral, r, dias);
      renderUsuarios();
    } catch (err) {
      console.error('[analytics]', err);
      geral.innerHTML = `<p class="an-vazio">Falha ao carregar os acessos: ${esc(err.message)}</p>`;
    }
  }

  function renderGeral(el, r, dias) {
    const k = r.kpis;
    const pct = (a, b) => `${Math.round((100 * a) / Math.max(b, 1))}%`;
    const lot = agregaLotacao(usuarios).slice(0, 15);
    const eventos = r.eventos.filter((e) => e.evento !== 'heartbeat');
    el.innerHTML = `
      <div class="an-kpis">
        ${kpi('ativos hoje', fmtInt(k.dau))}
        ${kpi('ativos em 7 dias', fmtInt(k.wau))}
        ${kpi('ativos em 30 dias', fmtInt(k.mau), `${pct(k.mau, k.liberados)} dos ${fmtInt(k.liberados)} liberados`)}
        ${kpi('sessões no período', fmtInt(k.sessoes))}
        ${kpi('duração mediana', k.mediana_sessao_min == null ? '—' : fmtMin(k.mediana_sessao_min), 'por sessão')}
        ${kpi('nunca entraram', fmtInt(k.nunca_entraram), pct(k.nunca_entraram, k.liberados) + ' dos liberados')}
        ${kpi('acessos a dado pessoal', fmtInt(k.eventos_sensiveis), 'buscas, cadastros, exportações')}
      </div>
      <div class="an-grade">
        <article class="an-card an-largo"><h3>Usuários ativos por dia</h3>${linhaDiaria(r.diario, Math.min(dias, 90))}</article>
        <article class="an-card"><h3>Camadas mais ligadas</h3>${barras(r.camadas, {
          rotulo: (c) => nomeCamada(c.camada), valor: (c) => c.acessos, sub: (c) => ` ${c.usuarios} usuários` })}</article>
        <article class="an-card"><h3>Usuários ativos por lotação</h3>${barras(lot, {
          rotulo: (l) => l.lotacao, valor: (l) => l.ativos, sub: (l) => ` de ${l.liberados}` })}</article>
        <article class="an-card"><h3>Municípios mais consultados (ficha)</h3>${barras(r.municipios, {
          rotulo: (m) => m.nome || m.ibge, valor: (m) => m.acessos, sub: (m) => ` ${m.usuarios} usuários` })}</article>
        <article class="an-card"><h3>Ações por tipo</h3>${barras(eventos, {
          rotulo: (e) => EVENTOS[e.evento] ?? e.evento, valor: (e) => e.n, sub: (e) => ` ${e.usuarios} usuários` })}</article>
        <article class="an-card an-largo"><h3>Quando usam (sessões por dia da semana e hora)</h3>${heatmap(r.heatmap)}</article>
        <article class="an-card"><h3>Retenção semanal</h3>${retencao(r.retencao)}</article>
      </div>
      <p class="an-rodape">Atualizado em ${fmtDataHora(r.gerado_em)} · log guardado por 12 meses · horário de Brasília</p>`;
  }

  // ------------------------------------------------------------ usuários
  const colunasUsuarios = [
    ['nome', 'Nome'], ['matricula', 'Matrícula'], ['lotacao', 'Lotação'], ['ultimo_evento', 'Último uso'],
    ['dias_ativos', 'Dias ativos'], ['sessoes', 'Sessões'], ['minutos', 'Tempo'], ['acoes', 'Ações'],
  ];
  secao('usuarios').innerHTML = `
    <div class="an-filtros">
      <input type="search" class="an-busca-usuario" placeholder="Nome, matrícula ou lotação" aria-label="Filtrar usuários">
      <select class="an-situacao" aria-label="Situação">
        <option value="todos">Todos os liberados</option><option value="ativos">Ativos no período</option>
        <option value="inativos">Sem uso há mais de 30 dias</option><option value="nunca">Nunca entraram</option>
      </select>
      <span class="an-contagem"></span>
    </div>
    <div class="an-rolagem"><table class="an-tabela">
      <thead><tr>${colunasUsuarios.map(([c, l]) => `<th><button data-ordem="${c}">${l}</button></th>`).join('')}<th>Camadas favoritas</th></tr></thead>
      <tbody></tbody></table></div>`;
  secao('usuarios').querySelector('.an-busca-usuario').addEventListener('input', (e) => {
    estadoUsuarios.busca = e.target.value;
    renderUsuarios();
  });
  secao('usuarios').querySelector('.an-situacao').addEventListener('change', (e) => {
    estadoUsuarios.situacao = e.target.value;
    renderUsuarios();
  });
  secao('usuarios').querySelector('thead').addEventListener('click', (e) => {
    const c = e.target.closest('[data-ordem]')?.dataset.ordem;
    if (!c) return;
    estadoUsuarios.desc = estadoUsuarios.chave === c ? !estadoUsuarios.desc : true;
    estadoUsuarios.chave = c;
    renderUsuarios();
  });
  secao('usuarios').querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    Object.assign(filtroLog, { usuario: { id: tr.dataset.id, nome: tr.dataset.nome }, pagina: 0, corte: Date.now() + 1000 });
    trocarAba('log');
  });

  function renderUsuarios() {
    const lista = ordena(filtraUsuarios(usuarios, estadoUsuarios), estadoUsuarios.chave, estadoUsuarios.desc);
    secao('usuarios').querySelector('.an-contagem').textContent = `${fmtInt(lista.length)} usuários`;
    secao('usuarios').querySelector('tbody').innerHTML = lista.map((u) => `
      <tr data-id="${esc(u.id)}" data-nome="${esc(u.nome)}" title="Ver o log deste usuário">
        <td>${esc(u.nome)}</td><td>${esc(u.matricula)}</td><td>${esc(u.lotacao)}</td>
        <td>${u.ultimo_evento ? fmtDataHora(u.ultimo_evento) : u.ultimo_login ? `login ${fmtDataHora(u.ultimo_login)}` : 'nunca'}</td>
        <td>${u.dias_ativos}</td><td>${u.sessoes}</td><td>${u.minutos ? fmtMin(u.minutos) : '—'}</td><td>${fmtInt(u.acoes)}</td>
        <td>${esc((u.camadas ?? []).map(nomeCamada).join(', '))}</td>
      </tr>`).join('');
  }

  // ------------------------------------------------------------ log
  secao('log').innerHTML = `
    <div class="an-filtros">
      <label>De <input type="date" class="an-de"></label>
      <label>Até <input type="date" class="an-ate"></label>
      <select class="an-evento" aria-label="Evento"><option value="">Todos os eventos</option>
        ${Object.entries(EVENTOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input type="search" class="an-busca-log" placeholder="Buscar em alvo, detalhe, nome ou matrícula" aria-label="Buscar no log">
      <span class="an-chip" hidden></span>
      <button class="an-csv">Exportar CSV</button>
    </div>
    <div class="an-rolagem"><table class="an-tabela">
      <thead><tr><th>Data e hora</th><th>Usuário</th><th>Matrícula</th><th>Evento</th><th>Alvo</th><th>Detalhe</th></tr></thead>
      <tbody></tbody></table></div>
    <div class="an-paginacao"><button class="an-ant">Anterior</button><span></span><button class="an-prox">Próxima</button></div>`;
  const log = secao('log');
  const argsLog = (limite, offset) => {
    const dia = (v, fim) => (v ? new Date(`${v}T00:00:00-03:00`).getTime() + (fim ? DIA_MS : 0) : null);
    return {
      p_ini: new Date(dia(filtroLog.de) ?? Date.now() - Number(periodo.value) * DIA_MS).toISOString(),
      p_fim: new Date(dia(filtroLog.ate, true) ?? filtroLog.corte).toISOString(),
      p_user: filtroLog.usuario?.id ?? null,
      p_evento: filtroLog.evento || null,
      p_busca: filtroLog.busca || null,
      p_limite: limite,
      p_offset: offset,
    };
  };
  const alvoLegivel = (r) => (r.evento.startsWith('camada_') ? nomeCamada(r.alvo) : r.alvo ?? '');
  const detalheLegivel = (d) => (d ? Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(' · ') : '');
  let timerBusca = 0;
  // Nova consulta: fixa o fim da janela para as páginas não escorregarem.
  function recarregar() {
    Object.assign(filtroLog, { pagina: 0, corte: Date.now() + 1000 });
    void carregarLog();
  }
  const nomeLog = (r) => nomePorMatricula.get(String(r.matricula)) || r.nome || r.email;
  log.querySelector('.an-de').addEventListener('change', (e) => { filtroLog.de = e.target.value; recarregar(); });
  log.querySelector('.an-ate').addEventListener('change', (e) => { filtroLog.ate = e.target.value; recarregar(); });
  log.querySelector('.an-evento').addEventListener('change', (e) => { filtroLog.evento = e.target.value; recarregar(); });
  log.querySelector('.an-busca-log').addEventListener('input', (e) => {
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => { filtroLog.busca = e.target.value.trim(); recarregar(); }, 350);
  });
  log.querySelector('.an-chip').addEventListener('click', () => { filtroLog.usuario = null; recarregar(); });
  log.querySelector('.an-ant').addEventListener('click', () => { filtroLog.pagina--; void carregarLog(); });
  log.querySelector('.an-prox').addEventListener('click', () => { filtroLog.pagina++; void carregarLog(); });
  log.querySelector('.an-csv').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      let linhas = [];
      for (let total = Infinity; linhas.length < total;) {
        const pagina = await rpc('datageo_acesso_eventos', argsLog(RPC_MAX, linhas.length));
        if (!pagina.length) break;
        total = Number(pagina[0].total);
        linhas = [...linhas, ...pagina];
      }
      const csv = toCsv(linhas, [
        { label: 'data_hora', value: (r) => fmtDataHora(r.criado_em) },
        { label: 'nome', value: nomeLog }, { key: 'matricula', label: 'matricula' }, { key: 'email', label: 'email' },
        { key: 'user_id', label: 'user_id' },
        { label: 'evento', value: (r) => EVENTOS[r.evento] ?? r.evento },
        { label: 'alvo', value: alvoLegivel }, { label: 'detalhe', value: (r) => detalheLegivel(r.detalhe) },
        { key: 'sessao_id', label: 'sessao' },
      ]);
      downloadText(`datageo-acessos-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
    } catch (err) {
      console.error('[analytics] csv', err);
    } finally {
      e.target.disabled = false;
    }
  });

  async function carregarLog() {
    const chip = log.querySelector('.an-chip');
    chip.hidden = !filtroLog.usuario;
    chip.textContent = filtroLog.usuario ? `${filtroLog.usuario.nome} ✕` : '';
    const corpo = log.querySelector('tbody');
    corpo.innerHTML = '<tr><td colspan="6" class="an-vazio">Carregando…</td></tr>';
    const meu = ++reqLog;
    try {
      const linhas = await rpc('datageo_acesso_eventos', argsLog(POR_PAGINA, filtroLog.pagina * POR_PAGINA));
      if (meu !== reqLog) return; // resposta de consulta antiga
      const total = Number(linhas[0]?.total ?? 0);
      corpo.innerHTML = linhas.length ? linhas.map((r) => `
        <tr${SENSIVEIS.has(r.evento) ? ' class="an-sensivel"' : ''}>
          <td>${fmtDataHora(r.criado_em)}</td><td title="${esc(r.email)}">${esc(nomeLog(r))}</td><td>${esc(r.matricula)}</td>
          <td>${esc(EVENTOS[r.evento] ?? r.evento)}</td><td>${esc(alvoLegivel(r))}</td><td>${esc(detalheLegivel(r.detalhe))}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="an-vazio">Nenhum evento com esses filtros.</td></tr>';
      const paginas = Math.max(Math.ceil(total / POR_PAGINA), 1);
      log.querySelector('.an-paginacao span').textContent = `Página ${filtroLog.pagina + 1} de ${paginas} · ${fmtInt(total)} eventos`;
      log.querySelector('.an-ant').disabled = filtroLog.pagina === 0;
      log.querySelector('.an-prox').disabled = filtroLog.pagina + 1 >= paginas;
    } catch (err) {
      if (meu !== reqLog) return;
      console.error('[analytics] log', err);
      corpo.innerHTML = `<tr><td colspan="6" class="an-vazio">Falha ao carregar o log: ${esc(err.message)}</td></tr>`;
    }
  }

  return {
    abrir() {
      dlg.showModal();
      void carregarResumo();
    },
  };
}
