// src/datageoGetec.js
//
// Painel do escritório municipal do IDR (UME): extensionistas lotados no
// município com os grupos de assistidos do GETEC. Clicar num nome lista os
// grupos e produtores dele e liga o escritório a cada família com ponto na
// CAF (rede desenhada por estacoesIdr.js). Só HTML; sem dado além do que já
// está no bucket privado.

import { grupos, resumo } from './data/getecGrupos.js';

const MAX_LISTA = 300;
const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => Number(v).toLocaleString('pt-BR');
const section = (title, body) => `<section class="fx-section"><h3>${esc(title)}</h3>${body}</section>`;

/**
 * Lista de extensionistas do escritório com a contagem de assistidos.
 * `servidores`: os do município (servidoresIdr.extensionistasDoMunicipio, achatado);
 * `getec`: payload de getec-grupos.json ou null; `ativo`: id selecionado.
 */
export function escritorioHtml({ servidores, getec, ativo = null }) {
  if (!servidores.length) return section('Extensionistas', '<div class="fx-dim">Nenhum extensionista lotado no município.</div>');
  const linhas = servidores.map((s) => {
    const r = resumo(grupos(getec, s.id));
    const conta = getec
      ? (r.clientes ? `<span class="fx-dim">· ${n(r.grupos)} grupo${r.grupos === 1 ? '' : 's'} · ${n(r.clientes)} assistidos</span>` : '<span class="fx-dim">· sem grupos no GETEC</span>')
      : '';
    const btn = r.clientes
      ? `<button type="button" class="fx-link${String(s.id) === String(ativo) ? ' is-on' : ''}" data-ext="${esc(s.id)}">${esc(s.nome)}</button>`
      : `<span>${esc(s.nome)}</span>`;
    return `<div>${btn} <span class="fx-dim">${esc(s.formacao || '')}</span> ${conta}</div>`;
  });
  const nota = getec
    ? `<div class="fx-dim">GETEC ${esc(getec.ano)} · clique no nome para ver os produtores e ligar ao mapa</div>`
    : '<div class="fx-dim">Grupos do GETEC indisponíveis (sem sessão ou arquivo).</div>';
  return section(`Extensionistas (${n(servidores.length)})`, linhas.join('') + nota);
}

/** Grupos e produtores de um extensionista. `ext` = entrada de getec-grupos.json. */
export function extensionistaHtml(ext) {
  if (!ext) return '';
  const r = resumo(ext);
  // comCaf/semCaf e programas: produtores únicos (nome+ibge), como em resumo().
  const vistos = new Set();
  const programas = [];
  let comCaf = 0;
  for (const g of ext.grupos) {
    if (g.projeto && !programas.includes(g.projeto)) programas.push(g.projeto);
    for (const c of g.clientes) {
      const k = `${c.nome}|${c.ibge}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      if (c.caf) comCaf += 1;
    }
  }
  const semCaf = r.clientes - comCaf;
  const cab = `<div>Assistidos: <b>${n(r.clientes)}</b> em <b>${n(r.grupos)}</b> grupo${r.grupos === 1 ? '' : 's'} ` +
    `<span class="fx-dim">· ${n(comCaf)} com CAF (${n(r.comPonto)} com ponto, ligados ao escritório no mapa) · ${n(semCaf)} sem CAF</span></div>` +
    (programas.length ? `<div class="fx-sub">Programas: ${programas.map(esc).join(' · ')}</div>` : '');
  let restantes = MAX_LISTA;
  const blocos = ext.grupos.map((g) => {
    const itens = g.clientes.slice(0, Math.max(0, restantes));
    restantes -= itens.length;
    const lista = itens.map((c) => `<div${c.ativo ? '' : ' class="fx-dim"'}>${esc(c.nome)} ` +
      `<span class="fx-dim">· ${esc(c.municipio ?? c.ibge ?? '')}${c.caf ? ` · CAF ${esc(c.caf)}` : ' · sem CAF'}` +
      `${c.ativo ? '' : ' · inativo'}</span></div>`).join('');
    const corte = g.clientes.length - itens.length;
    return `<div class="fx-sub" style="margin-top:8px"><b>${esc(g.nome)}</b> <span class="fx-dim">· ${esc(g.projeto)} · ${n(g.clientes.length)}</span></div>` +
      lista + (corte > 0 ? `<div class="fx-dim">… e mais ${n(corte)}</div>` : '');
  });
  return section(`Grupos de assistidos · ${ext.nome}`, cab + blocos.join(''));
}
