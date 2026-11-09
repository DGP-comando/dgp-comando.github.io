// src/data/coletoresEsporos.js
//
// Coletores de esporos por município para o tooltip e as fichas, a partir da
// mesma camada de pontos (src/maplibre/layers/manejo.js). A chave é o `ibge`
// gravado pelo etl-manejo do c2. Bucket privado: sem sessão o loader devolve
// null e a contagem some.

import { dgFetchData } from './datageoClient.js';

export const temEsporo = (p) => Boolean(p?.primeiro_esporo);

/** {<ibge>: {total, comEsporo}}. */
export function coletoresPorMunicipio(gj) {
  const out = {};
  for (const f of gj?.features ?? []) {
    const { ibge } = f.properties ?? {};
    if (!ibge) continue;
    const m = out[ibge] ?? { total: 0, comEsporo: 0 };
    out[ibge] = { total: m.total + 1, comEsporo: m.comEsporo + (temEsporo(f.properties) ? 1 : 0) };
  }
  return out;
}

/** Soma os municípios pedidos: {total, comEsporo}, zeros sem coletor; null sem acesso ao dado. */
export function resumoColetores(por, ibges) {
  if (!por) return null;
  const itens = (ibges ?? []).map((c) => por[String(c)]).filter(Boolean);
  return {
    total: itens.reduce((s, m) => s + m.total, 0),
    comEsporo: itens.reduce((s, m) => s + m.comEsporo, 0),
  };
}

export async function getColetores(ibges) {
  return resumoColetores(await loadColetoresMunicipios(), ibges);
}

let p = null;
/** Contagem por município, ou null sem sessão/falha (tenta de novo depois). Nunca lança. */
export function loadColetoresMunicipios() {
  p ??= dgFetchData('/privado/manejo-coletores.geojson')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((gj) => {
      if (!gj) p = null;
      return gj && coletoresPorMunicipio(gj);
    });
  return p;
}
