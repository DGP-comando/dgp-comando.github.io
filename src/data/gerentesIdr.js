// src/data/gerentesIdr.js
//
// Gerente (chefe do escritório regional) de cada regional do IDR:
// /privado/gerentes-idr.json, gerado por scripts/build_servidores_rh.py a
// partir da relação mensal do RH. Chave = nome da regional em
// regionais-idr-pr.geojson.
//
// Usos: tooltip da unidade regional (camada Unidades do IDR) e seção
// Território das fichas municipal e regional.

import { dgFetchData } from './datageoClient.js';
import { normNome } from './servidoresIdr.js';

const URL = '/privado/gerentes-idr.json';
let _promessa = null;

export function loadGerentesIdr() {
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

/** {nome, cargo, referencia} do gerente da regional, ou null. */
export function gerenteDaRegional(dados, regional) {
  const alvo = normNome(regional);
  if (!alvo) return null;
  const achado = Object.entries(dados?.regionais ?? {}).find(([k]) => normNome(k) === alvo);
  return achado ? { ...achado[1], referencia: dados.referencia ?? '' } : null;
}

/** Para a ficha: nunca lança (a ficha segue sem o gerente). */
export async function getGerentes() {
  try {
    return await loadGerentesIdr();
  } catch (err) {
    console.warn('[DataGeo:ficha] gerentes IDR indisponíveis:', err?.message);
    return null;
  }
}
