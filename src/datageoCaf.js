// src/datageoCaf.js
//
// HTML do CAF (MDA) no painel da ficha: a seção "Agricultura familiar · CAF"
// da ficha municipal/regional (`secaoCaf`, agregado de getCaf) e o cadastro
// completo de uma família (`familiaHtml`, clique na camada). Mesmas classes
// do painel (.fx-section, .fx-bar-*, .fx-dim, .fx-sub, .fx-warn).
//
// O cadastro da família é dado pessoal (LGPD): só chega aqui pelo bucket
// privado, com usuário liberado. O hover da camada mostra só nome, produto,
// renda e área (para o técnico achar a família); CPF e contato, só no clique.

import { CAF_CORES, periodo, variacao } from './data/cafFamilias.js';

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, casas = 0) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const brl = (v) => (Number.isFinite(Number(v)) && v !== null ? `R$ ${n(v)}` : '—');
const pct = (parte, total) => (total > 0 ? `${n((parte / total) * 100, 1)}%` : '—');
const data = (iso) => (iso ? esc(String(iso).slice(0, 10).split('-').reverse().join('/')) : '—');
const section = (title, body) => `<section class="fx-section"><h3>${esc(title)}</h3>${body}</section>`;
const PEQUENA = 20; // abaixo disso a variação da mediana é ruído

/** "▲ 3,3%" verde / "▼ 4,1%" vermelho / "" sem variação. */
export function seta(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (Math.abs(v) < 0.05) return '<span class="fx-dim">= 0%</span>';
  const sobe = v > 0;
  return `<span style="color:${sobe ? '#22c55e' : '#ef4444'}">${sobe ? '▲' : '▼'} ${n(Math.abs(v), 1)}%</span>`;
}

const serie = (obj) => Object.entries(obj ?? {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${periodo(k)} <b>${n(v)}</b>`)
  .join(' → ');

function linhaRenda(rotulo, atual, ant, painel, painelAnt, painelN, unidade = '') {
  if (atual === null || atual === undefined) return '';
  const p = painelN >= PEQUENA && painel !== null
    ? ` · mesmas famílias ${seta(variacao(painelAnt, painel))}`
    : '';
  return `<div>${esc(rotulo)}: <b>${brl(atual)}${unidade}</b> ${seta(variacao(ant, atual))}${p}</div>`;
}

/** Seção da ficha municipal/regional. `c` = getCaf(ibges); null omite. */
export function secaoCaf(c) {
  if (!c?.caf) return null;
  const { meta } = c;
  const ativas = c.caf['2025-10'] ?? 0;
  const ref = periodo(meta.referencia);
  const ant = periodo(meta.anterior);
  const rows = [];
  rows.push(`<div>Famílias com CAF ativa: <b>${n(ativas)}</b> <span class="fx-dim">(${ref})</span>` +
    (c.vencer ? ` · <span class="fx-warn">${n(c.vencer)} vencem em 6 meses</span>` : '') + '</div>');
  const fam = c.familias ?? {};
  if (fam['2023-11']) {
    rows.push(`<div>Com cadastro (CAF ou DAP): ${periodo('2023-11')} <b>${n(fam['2023-11'])}</b> → ${ref} <b>${n(fam['2025-10'])}</b> ` +
      `${seta(variacao(fam['2023-11'], fam['2025-10']))}</div>`);
  }
  rows.push(`<div class="fx-sub">CAF: ${serie(c.caf)}</div>`);
  rows.push(`<div class="fx-sub">DAP: ${serie(c.dap)} <span class="fx-dim">(a DAP deixou de valer em 2025)</span></div>`);

  const r = c.renda ?? {};
  const pa = c.painel ?? {};
  rows.push(`<div class="fx-sub" style="margin-top:8px">Renda mediana por família · ${ref} x ${ant} (variação real, IPCA)</div>`);
  rows.push(linhaRenda('Renda total', r.rt, r.rt24, pa.rt, pa.rt24, pa.n));
  rows.push(linhaRenda('Renda por hectare', r.rha, r.rha24, pa.rha, pa.rha24, pa.n, '/ha'));
  if (r.ha) rows.push(`<div class="fx-sub">Área mediana ${n(r.ha, 1)} ha · renda de fora do estabelecimento ${n(c.fora_pct ?? 0, 1)}% da renda</div>`);
  if (pa.n < PEQUENA) rows.push(`<div class="fx-dim">Só ${n(pa.n ?? 0)} famílias nas duas extrações: variação pouco confiável</div>`);

  if (c.top?.length) {
    const total = c.top.reduce((s, t) => s + t.v, 0);
    const maior = c.top[0].v || 1;
    rows.push('<div class="fx-sub" style="margin-top:8px">Principais produtos (renda declarada)</div>');
    for (const t of c.top.slice(0, 3)) {
      rows.push(`<div class="fx-bar-row"><span class="fx-bar-label fx-bar-label-wide" title="${esc(t.p)}">${esc(t.p)}</span>` +
        `<span class="fx-bar-track"><span class="fx-bar-fill" style="width:${Math.round((t.v / maior) * 100)}%;background:#a3e635"></span></span>` +
        `<span class="fx-bar-val fx-bar-val-wide">${n(t.n)}</span></div>`);
    }
    rows.push(`<div class="fx-dim">Número de famílias que declaram o produto · ${n(c.n_prod ?? 0)} produto(s) por família (mediana) · top 5 somam ${brl(total)}</div>`);
  }

  const pr = c.pronaf ?? {};
  const pub = [
    ['assentados', 'assentados'], ['quilombolas', 'quilombolas'], ['indigenas', 'em terra indígena'],
    ['pncf', 'PNCF'], ['tradicionais', 'povos tradicionais'],
  ].filter(([k]) => c.publico?.[k]).map(([k, rot]) => `${n(c.publico[k])} ${rot}`);
  const atv = [['pescadores', 'pescadores'], ['extrativistas', 'extrativistas'], ['aquicultores', 'aquicultores'],
    ['silvicultores', 'silvicultores']].filter(([k]) => c.atividade?.[k]).map(([k, rot]) => `${n(c.atividade[k])} ${rot}`);
  rows.push(`<div class="fx-sub" style="margin-top:8px">Pronaf: A <b>${n(pr.A ?? 0)}</b> · B <b>${n(pr.B ?? 0)}</b> · V <b>${n(pr.V ?? 0)}</b></div>`);
  if (pub.length || atv.length) rows.push(`<div class="fx-sub">Público prioritário: ${[...pub, ...atv].join(' · ')}</div>`);
  rows.push(`<div class="fx-sub">Mulheres declarantes ${pct(c.mulheres, ativas)} · jovens 16-29 anos ${n(c.jovens ?? 0)} ` +
    `(${pct(c.jovens, c.membros)} dos membros) · idade mediana do declarante ${c.idade ? n(c.idade) : '—'}</div>`);
  rows.push(`<div class="fx-sub">Declarante até o 5º ano ou sem escolaridade ${pct(c.escol_baixa, ativas)} · ` +
    `não proprietários ${pct(c.nao_prop, ativas)} · aposentadoria/pensão ${pct(c.aposent, ativas)} · Bolsa Família ${n(c.bolsa ?? 0)}</div>`);
  rows.push(`<div class="fx-sub">CAFs emitidas pelo IDR: ${pct(c.idr, ativas)}</div>`);
  if (c.pj) {
    const tipos = Object.entries(c.pj.tipos).filter(([, v]) => v).map(([t, v]) => `${n(v)} ${esc(t.toLowerCase())}`);
    rows.push(`<div class="fx-sub">CAF jurídicas com sede aqui: <b>${n(c.pj.total)}</b>${tipos.length ? ` (${tipos.join(' · ')})` : ''} · ` +
      `famílias sócias de alguma: <b>${n(c.pj.associadas)}</b> (${pct(c.pj.associadas, ativas)})</div>`);
  }
  rows.push(`<div class="fx-dim">MDA · CAF PF, extração de ${data(meta.referencia)} x ${data(meta.anterior)} (acesso restrito) · ` +
    `medianas; ${ant} corrigido pelo IPCA (+${n((meta.ipca - 1) * 100, 1)}%) · famílias na camada Agricultura familiar (CAF)</div>`);
  return section('Agricultura familiar · CAF (MDA)', rows.filter(Boolean).join(''));
}

// ------------------------------------------------------------ família

const cpfFmt = (c) => (/^\d{11}$/.test(String(c)) ? String(c).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : esc(c));
const tel = (t) => {
  const d = String(t ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : esc(t);
};
const kv = (rotulo, valor) => (valor === null || valor === undefined || valor === '' ? ''
  : `<div><span class="fx-dim">${esc(rotulo)}:</span> ${valor}</div>`);

function membroHtml(m) {
  return '<div style="margin:6px 0;padding-left:8px;border-left:2px solid #334155">' +
    `<div><b>${esc(m.nome)}</b>${m.nome_social ? ` (${esc(m.nome_social)})` : ''} <span class="fx-dim">· ${esc(m.parentesco)}</span></div>` +
    kv('CPF', cpfFmt(m.cpf)) +
    kv('Nascimento', m.nascimento ? `${data(m.nascimento)} (${n(m.idade)} anos)` : '') +
    kv('Sexo · estado civil · etnia', [m.sexo, m.estado_civil, m.etnia].filter(Boolean).map(esc).join(' · ')) +
    kv('Escolaridade', esc(m.escolaridade)) +
    kv('Naturalidade', esc([m.naturalidade, m.nacionalidade].filter(Boolean).join(' · '))) +
    kv('Mãe', esc(m.mae)) +
    kv('Documento', esc(m.documento)) +
    kv('Telefone', m.telefone ? `${tel(m.telefone)} <span class="fx-dim">${esc(m.tipo_telefone)}</span>` : '') +
    kv('E-mail', esc(m.email)) +
    kv('Trabalha na UFPA', m.trabalha_ufpa ? 'sim' : 'não') +
    '</div>';
}

function areaHtml(a) {
  return '<div style="margin:6px 0;padding-left:8px;border-left:2px solid #334155">' +
    `<div><b>${n(a.area, 2)} ${esc(a.unidade)}</b> · ${esc(a.tipo)} · ${esc(a.dominio)}` +
    `${a.principal ? ' <span class="fx-dim">(imóvel principal)</span>' : ''}</div>` +
    kv('Município · localização', esc([a.municipio, a.localizacao].filter(Boolean).join(' · '))) +
    kv('Responsável', a.responsavel ? `${esc(a.responsavel)} · ${cpfFmt(a.cpf)}` : '') +
    kv('Coordenada declarada', a.lat !== null ? `${a.lat}, ${a.lon}` : '') +
    '</div>';
}

function producaoHtml(lista, titulo) {
  if (!lista.length) return '';
  const linhas = lista.map((p) => {
    const est = p.estimada !== p.auferida ? ` <span class="fx-dim">(estimada ${brl(p.estimada)})</span>` : '';
    return `<div>${esc(p.produto)} <span class="fx-dim">· ${esc(p.tipo)}</span>: <b>${brl(p.auferida)}</b>${est}</div>`;
  });
  return `<div class="fx-sub" style="margin-top:6px">${esc(titulo)}</div>${linhas.join('')}`;
}

/**
 * Texto do vínculo com o CAR para o painel: imóvel destacado, nenhum imóvel
 * ou a dica de ligar a camada. `car` = {ligado, imovel} (imovel de carImovelEm).
 */
export function carHtml(car, areaCaf) {
  if (!car?.ligado) return '<div class="fx-dim">Ligue a camada CAR para destacar o imóvel que contém o ponto</div>';
  if (!car.imovel) return '<div class="fx-warn">Nenhum imóvel do CAR contém o ponto da família</div>';
  const { ha, classe } = car.imovel;
  const dif = areaCaf > 0 ? ` · CAF declara ${n(areaCaf, 1)} ha (${seta(variacao(areaCaf, ha)) || '='} no CAR)` : '';
  return `<div>Imóvel do CAR destacado no mapa: ~<b>${n(ha, 1)} ha</b> · ${classe ? `${esc(classe)} módulos fiscais` : 'classe não informada'}${dif}</div>` +
    '<div class="fx-dim">Divisa generalizada do SICAR; o menor imóvel que contém o ponto</div>';
}

/** Cadastro completo de uma família (painel do clique). */
export function familiaHtml(f, { car = null, grupos = [], grupo = null, pjs = [], fontes = [], tiposFonte = [] } = {}) {
  const out = [];
  if (f.alertas?.length) out.push(section('Conferir', f.alertas.map((a) => `<div class="fx-warn">${esc(a)}</div>`).join('')));

  const r = f.renda ?? {};
  const r24 = f.renda_2024;
  const cor = grupo !== null ? CAF_CORES[grupo] : null;
  out.push(section('Renda e produção',
    (cor ? `<div><span style="color:${cor}">●</span> ${esc(grupos[grupo] ?? '')}</div>` : '') +
    `<div>Renda total: <b>${brl(r.total)}</b> <span class="fx-dim">· dentro ${brl(r.dentro)} · fora ${brl(r.fora)}</span></div>` +
    `<div>Área total: <b>${n(r.ha ?? 0, 2)} ha</b> · renda/ha <b>${r.por_ha !== null ? brl(r.por_ha) : '—'}</b></div>` +
    (r24 ? `<div class="fx-sub">Declarado em jul/24: ${brl(r24.total)} total, ${n(r24.ha, 2)} ha ${seta(variacao(r24.total, r.total))} <span class="fx-dim">(nominal)</span></div>` : '') +
    producaoHtml(f.producao.filter((p) => p.dentro), 'Dentro do estabelecimento') +
    producaoHtml(f.producao.filter((p) => !p.dentro), 'Fora do estabelecimento')));

  if (pjs.length) {
    out.push(section(`Sócia de CAF jurídica (${pjs.length})`, pjs.map((p) =>
      `<div><b>${esc(p.fantasia || p.razao)}</b> <span class="fx-dim">· ${esc(p.tipo)} · ${esc(p.endereco?.municipio)}</span></div>`).join('') +
      '<div class="fx-dim">Ligue a camada CAF jurídicas e clique na entidade para ver os demais sócios</div>'));
  }
  if (fontes.length) {
    out.push(section(`Fonte protegida pelo IDR (${fontes.length})`, fontes.map(([, , , comunidade, , t, ano, mes]) =>
      `<div>${esc(tiposFonte[t] ?? '')} ${esc([mes, ano].filter(Boolean).join(' '))}${comunidade ? ` <span class="fx-dim">· ${esc(comunidade)}</span>` : ''}</div>`).join('') +
      '<div class="fx-dim">Solo-cimento para captação · camada Fontes protegidas</div>'));
  }
  out.push(section(`Membros da família (${f.membros.length})`, f.membros.map(membroHtml).join('')));

  const e = f.endereco;
  out.push(section('Cadastro',
    kv('Situação', esc(f.situacao)) +
    kv('Enquadramento Pronaf', esc((f.pronaf ?? []).join(', ') || '—')) +
    kv('Criação · atualização · validade', `${data(f.criacao)} · ${data(f.atualizacao)} · <b>${data(f.validade)}</b>`) +
    kv('Emissor', esc(f.emissor)) +
    kv('Cadastrado por', esc(f.cadastrador)) +
    kv('Caracterização', esc([f.caracterizacao, f.terreno].filter(Boolean).join(' · '))) +
    kv('Mão de obra', `${n(f.mo_familiar ?? 0)} familiar · ${n(f.mo_contratada ?? 0)} contratada`) +
    (e ? kv('Endereço', esc([e.logradouro, e.numero && e.numero !== '0' ? e.numero : '', e.complemento, e.referencia, e.municipio, e.cep]
      .filter(Boolean).join(', '))) : '')));

  const loc = f.local ?? {};
  const situacao = { ok: 'no município declarado', corrigida: `corrigida (${esc(loc.conserto)})`,
    fora_municipio: 'fora do município declarado', sem_local: 'inválida' }[loc.status] ?? '';
  out.push(section(`Áreas (${f.areas.length}) e localização`,
    f.areas.map(areaHtml).join('') +
    kv('Ponto no mapa', loc.lat !== null && loc.lat !== undefined ? `${loc.lat}, ${loc.lon} · ${situacao}` : situacao) +
    carHtml(car, r.ha)));
  return out.join('');
}

// ------------------------------------------------------------ CAF jurídica

const cnpjFmt = (c) => (/^\d{14}$/.test(String(c))
  ? String(c).replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : esc(c));
const PRECISAO = {
  rua: 'endereço (rua)', cep: 'CEP', assentamento: 'assentamento do INCRA citado no endereço',
  sede: 'aproximada, sede urbana do município', municipio: 'aproximada, município da sede',
};
const MAX_LISTA = 300;

/**
 * Painel de uma CAF jurídica. `nomes`: nr_caf PF -> nome do declarante
 * (caf-pontos); `filiadas`: PJs filiadas (centrais).
 */
export function pjHtml(p, { nomes = new Map(), filiadas = [] } = {}) {
  const out = [];
  const e = p.endereco ?? {};
  const r = p.responsavel;
  out.push(section('Entidade',
    kv('Tipo', esc(p.tipo)) +
    kv('CNPJ', cnpjFmt(p.cnpj)) +
    kv('Razão social', esc(p.razao)) +
    kv('Constituição · inscrição · validade', `${data(p.constituicao)} · ${data(p.inscricao)} · <b>${data(p.validade)}</b>`) +
    kv('Emissor', esc(p.emissor)) +
    kv('Cadastrado por', esc(p.cadastrador)) +
    kv('Responsável', r ? `${esc(r.nome)} · ${cpfFmt(r.cpf)}${r.nome_t ? ` · técnico ${esc(r.nome_t)}` : ''}` : '') +
    p.contatos.map((c) => kv('Contato', [esc(c.email), c.telefone ? tel(c.telefone) : ''].filter(Boolean).join(' · '))).join('') +
    kv('Endereço', esc([e.logradouro, e.numero && e.numero !== '0' ? e.numero : '', e.complemento, e.municipio, e.cep]
      .filter(Boolean).join(', '))) +
    kv('Localização', esc(PRECISAO[p.precisao] ?? p.precisao))));

  const sem = p.socios_sem_caf.length;
  const falhas = Object.entries(p.falhas ?? {}).map(([erro, k]) => `<div class="fx-warn">${n(k)} · ${esc(erro)}</div>`).join('');
  out.push(section('Sócios',
    `<div>Famílias sócias com CAF PF: <b>${n(p.familias.length)}</b> · no mapa <b>${n(p.familias_no_mapa)}</b> ` +
    '<span class="fx-dim">(destacadas com linhas até a entidade)</span></div>' +
    (sem ? `<div class="fx-sub">Sócios pessoa física sem CAF PF localizada: ${n(sem)}</div>` : '') +
    (falhas ? `<div class="fx-sub" style="margin-top:6px">Recusados pelo MDA</div>${falhas}` : '')));

  if (filiadas.length) {
    out.push(section(`Entidades filiadas (${filiadas.length})`, filiadas.map((f) =>
      `<div>${esc(f.fantasia || f.razao)} <span class="fx-dim">· ${esc(f.tipo)} · ${esc(f.endereco?.municipio)} · ${n(f.familias.length)} famílias</span></div>`).join('')));
  }
  const lista = p.familias.slice(0, MAX_LISTA).map((k) => `<div>${esc(nomes.get(k) || '(sem ponto no mapa)')} <span class="fx-dim">· CAF ${esc(k)}</span></div>`);
  const resto = p.familias.length - lista.length;
  out.push(section('Famílias sócias', lista.join('') +
    (resto > 0 ? `<div class="fx-dim">… e mais ${n(resto)}</div>` : '') +
    (sem ? `<div class="fx-sub" style="margin-top:6px">Sem CAF PF</div>${p.socios_sem_caf.slice(0, MAX_LISTA).map((s) => `<div>${esc(s)}</div>`).join('')}` : '')));
  return out.join('');
}
