// src/data/cafFamilias.js
//
// CAF (Cadastro Nacional da Agricultura Familiar, MDA) das famílias do PR,
// gerado por scripts/build_caf.py. Tudo do BUCKET PRIVADO (dgFetchData, só
// usuário liberado); sem sessão os loaders devolvem null e ficha/camada seguem
// sem o bloco.
//   caf-municipios.json  agregados por município, regional IDR e estado
//   caf-pontos.json      um ponto por família (camada)
//   caf/<ibge>.json      cadastro completo das famílias do município (clique)
//   caf-pj.json          CAF jurídicas, sócios (nr_caf PF) e resumo por município
//                        (scripts/build_caf_pj.py)

import { dgFetchData } from './datageoClient.js';

/** Cor de cada grupo de produto principal, na ordem de `grupos` do build. */
export const CAF_CORES = Object.freeze([
  '#facc15', // Soja
  '#f97316', // Milho
  '#60a5fa', // Leite
  '#b45309', // Bovinos de corte
  '#84cc16', // Fumo
  '#22c55e', // Hortaliças e frutas
  '#f472b6', // Aves e suínos
  '#a78bfa', // Outras atividades
  '#94a3b8', // Só renda de fora
]);

/** Cor de cada tipo de CAF PJ, na ordem de `tipos` do build_caf_pj. */
export const PJ_CORES = Object.freeze(['#38bdf8', '#e879f9', '#fb7185', '#fbbf24']);

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** '2025-10' ou '2025-10-08' -> 'out/25'. */
export const periodo = (k) => (k ? `${MESES[Number(String(k).slice(5, 7)) - 1]}/${String(k).slice(2, 4)}` : '');

/** JSON privado com cache; falha/sem sessão devolve null e libera nova tentativa. */
function cacheado(url) {
  let p = null;
  return () => {
    p ??= dgFetchData(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        if (!d) p = null;
        return d;
      });
    return p;
  };
}

export const loadCafMunicipios = cacheado('/privado/caf-municipios.json');
export const loadCafPontos = cacheado('/privado/caf-pontos.json');
export const loadCafPj = cacheado('/privado/caf-pj.json');

/** Soma o resumo de PJ dos municípios (PJ com sede ali por tipo e famílias sócias). null sem dado. */
export function resumoPj(pj, ibges) {
  const itens = (ibges ?? []).map((c) => pj?.municipios?.[String(c)]).filter(Boolean);
  if (!pj || !(ibges ?? []).length) return null;
  const tipos = Object.fromEntries((pj.tipos ?? []).map((t) => [t, 0]));
  let associadas = 0;
  for (const it of itens) {
    for (const [t, n] of Object.entries(it.pj ?? {})) tipos[t] = (tipos[t] ?? 0) + n;
    associadas += it.associadas ?? 0;
  }
  return { tipos, total: Object.values(tipos).reduce((a, b) => a + b, 0), associadas };
}

/** nr_caf PF -> PJs de que a família é sócia. */
export function pjsPorFamilia(pj) {
  const m = new Map();
  for (const p of pj?.pj ?? []) {
    for (const k of p.familias) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
  }
  return m;
}

const porMunicipio = new Map();
/** Cadastro completo das famílias de um município: {familias: {nr_caf: {...}}} ou null. */
export function loadCafFamilias(ibge) {
  const k = String(ibge);
  if (!porMunicipio.has(k)) porMunicipio.set(k, cacheado(`/privado/caf/${k}.json`));
  return porMunicipio.get(k)();
}

/**
 * Agregado do recorte: o município (1 IBGE) ou a regional com exatamente
 * esses municípios (medianas não somam, o build já as calculou). null senão.
 */
export function recorteCaf(dados, ibges) {
  const lista = (ibges ?? []).map(String);
  if (!dados || !lista.length) return null;
  if (lista.length === 1) return dados.municipios?.[lista[0]] ?? null;
  const chave = [...lista].sort().join(',');
  return Object.values(dados.regionais ?? {}).find((r) => r.municipios.join(',') === chave) ?? null;
}

/** Agregado + metadados (referência, IPCA, grupos) para a ficha; null sem dado. */
export async function getCaf(ibges) {
  const [dados, pj] = await Promise.all([loadCafMunicipios(), loadCafPj()]);
  const r = recorteCaf(dados, ibges);
  if (!r) return null;
  const { referencia, anterior, ipca, vence_dias: venceDias, grupos } = dados;
  return { ...r, pj: resumoPj(pj, ibges), meta: { referencia, anterior, ipca, venceDias, grupos } };
}

/** Variação % entre a e b (null se não der para calcular). */
export const variacao = (a, b) => (a > 0 && Number.isFinite(b) ? ((b - a) / a) * 100 : null);
