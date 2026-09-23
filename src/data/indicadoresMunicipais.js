// src/data/indicadoresMunicipais.js
//
// Indicadores por município (scripts/build_indicadores_municipais.py):
// agroindústrias (total e cadastro IDR), km de estradas (total, rural e
// convênios SEAB 2026), associações de municípios (27 municípios estão em
// duas) e regional do IDR.
//
// Vem do bucket privado (deriva de dado do IDR/SEAB) e é buscado no máximo
// uma vez, na primeira ficha aberta — mesmo contrato de carMunicipios.js.
// getIndicadores soma qualquer conjunto de municípios: um só (ficha
// municipal) ou uma regional inteira (ficha regional).

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/indicadores-municipios.json';
const CAMPOS = ['agro_total', 'agro_idr', 'km_total', 'km_rural', 'km_conv'];

let _promessa = null;

export function loadIndicadores() {
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
 * Soma dos indicadores dos municípios `ibges`, com as associações e regionais
 * envolvidas (distintas, na ordem de aparição), ou null sem dado. Nunca lança.
 */
export async function getIndicadores(ibges) {
  try {
    const dados = await loadIndicadores();
    return somarIndicadores(dados, ibges);
  } catch (err) {
    console.warn('[DataGeo:indicadores] indisponível:', err?.message);
    return null;
  }
}

export function somarIndicadores(dados, ibges) {
  const itens = ibges.map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const soma = Object.fromEntries(CAMPOS.map((k) => [k, itens.reduce((a, it) => a + (Number(it[k]) || 0), 0)]));
  const distintos = (k) => [...new Set(itens.flatMap((it) => it[k] ?? []).filter(Boolean))];
  return {
    ...soma,
    n: itens.length,
    associacoes: distintos('associacoes').map((sigla) => ({ sigla, nome: dados.associacoes?.[sigla] ?? '' })),
    regionais: distintos('regional'),
  };
}
