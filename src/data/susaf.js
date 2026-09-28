// src/data/susaf.js
//
// Adesão ao SUSAF-PR por município: /privado/susaf-pr.json
// (scripts/build_susaf.py, a partir do mapa da ADAPAR e da lista de SIMs da
// SEAB). Privado porque traz responsável e contato de cada SIM.
//
// Buscado no máximo uma vez, na primeira ficha aberta.

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/susaf-pr.json';
let _promessa = null;

function loadSusaf() {
  _promessa ??= dgFetchData(URL)
    .then((resp) => {
      if (!resp.ok) throw new Error(`${URL}: HTTP ${resp.status}`);
      return resp.json();
    })
    .catch((err) => {
      _promessa = null; // falha não fica em cache
      throw err;
    });
  return _promessa;
}

/**
 * Um município: a entrada dele (ou `adesao: null` se não aderiu). Vários
 * (regional): quantos aderiram e quantos estabelecimentos foram indicados.
 */
export function resumirSusaf(dados, ibges) {
  if (!dados?.municipios) return null;
  const cods = (ibges ?? []).map(String);
  const base = { dataMapa: dados.dataMapa, fonte: dados.fonte };
  if (cods.length === 1) {
    const m = dados.municipios[cods[0]];
    return { ...base, n: 1, adesao: m?.adesao ?? null, estabelecimentos: m?.estabelecimentos ?? null,
      suspenso: Boolean(m?.suspenso), sim: m?.sim ?? null };
  }
  const itens = cods.map((c) => dados.municipios[c]).filter(Boolean);
  return {
    ...base,
    n: cods.length,
    aderiram: itens.length,
    viaConsorcio: itens.filter((m) => m.adesao === 'consorcio').length,
    estabelecimentos: itens.reduce((a, m) => a + (m.estabelecimentos ?? 0), 0),
  };
}

/** Para a ficha: nunca lança (a ficha segue sem a seção). */
export async function getSusaf(ibges) {
  try {
    return resumirSusaf(await loadSusaf(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] SUSAF indisponível:', err?.message);
    return null;
  }
}
