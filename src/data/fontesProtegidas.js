// src/data/fontesProtegidas.js
//
// Fontes (nascentes) protegidas pelo IDR-Paraná com solo-cimento, para
// captação (scripts/build_fontes_protegidas.py). Bucket privado: tem o nome
// do produtor; sem sessão o loader devolve null.

import { dgFetchData } from './datageoClient.js';

/** Cor de cada tipo, na ordem de `tipos` do build (Construção, Reforma, Cercamento, Caxambu). */
export const FONTE_CORES = Object.freeze(['#22d3ee', '#a3e635', '#fbbf24', '#c084fc']);

let p = null;
/** O JSON inteiro, ou null (sem sessão/sem acesso/falha). Nunca lança. */
export function loadFontes() {
  p ??= dgFetchData('/privado/fontes-protegidas.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      if (!d) p = null;
      return d;
    });
  return p;
}

/** Soma os municípios pedidos: total, por tipo e por ano. null sem dado. */
export function resumoFontes(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!dados) return null;
  const tipos = {};
  const porAno = {};
  let total = 0;
  for (const it of itens) {
    total += it.total;
    for (const [k, n] of Object.entries(it.tipos ?? {})) tipos[k] = (tipos[k] ?? 0) + n;
    for (const [k, n] of Object.entries(it.por_ano ?? {})) porAno[k] = (porAno[k] ?? 0) + n;
  }
  return { total, tipos, porAno, referencia: dados.referencia };
}

export async function getFontes(ibges) {
  return resumoFontes(await loadFontes(), ibges);
}

/** nr_caf PF -> fontes protegidas da família (linhas de `p`). */
export function fontesPorFamilia(dados) {
  const m = new Map();
  for (const r of dados?.p ?? []) {
    const caf = r[9];
    if (!caf) continue;
    if (!m.has(caf)) m.set(caf, []);
    m.get(caf).push(r);
  }
  return m;
}
