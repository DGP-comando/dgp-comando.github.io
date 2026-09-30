// src/data/servidoresIdr.js
//
// Servidores do IDR-Paraná: /privado/servidores-idr.json, gravado de hora em
// hora pela Edge Function datageo-servidores do c2-parana (SisPont + Portal
// da Transparência, sem RG nem chefia; a relação mensal do RH, quando
// publicada, manda em quadro, município, vínculo e cessão). Bucket privado: só usuário liberado.
//
// Usos: seção "Extensionistas · IDR" da ficha municipal e tooltip da camada
// de estações/polos/unidades florestais (chave `unidade`).
//
// Buscado no máximo uma vez a cada TTL (o arquivo muda de hora em hora).

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/servidores-idr.json';
const TTL_MS = 10 * 60_000;

let _promessa = null;
let _em = 0;

export function loadServidoresIdr() {
  if (!_promessa || Date.now() - _em > TTL_MS) {
    _em = Date.now();
    _promessa = dgFetchData(URL)
      .then((resp) => {
        if (!resp.ok) throw new Error(`${URL}: HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((err) => {
        _promessa = null; // falha não fica em cache
        throw err;
      });
  }
  return _promessa;
}

/** Maiúsculas, sem acento: "Paranavaí" e "PARANAVAI" casam. */
export const normNome = (s) =>
  String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');

/**
 * Extensionistas lotados no município, agrupados por formação (a mais
 * numerosa primeiro; "não informada" por último).
 * @returns {{total: number, grupos: Array<{formacao: string, servidores: object[]}>, geradoEm: string, rh: string|null}|null}
 */
export function extensionistasDoMunicipio(dados, municipio) {
  const alvo = normNome(municipio);
  const lista = (dados?.servidores ?? []).filter((s) => s.extensionista && normNome(s.municipio) === alvo);
  if (!lista.length) return null;
  const mapa = new Map();
  for (const s of lista) {
    const k = s.formacao || '';
    mapa.set(k, [...(mapa.get(k) ?? []), s]);
  }
  const grupos = [...mapa.entries()]
    .map(([formacao, servidores]) => ({ formacao, servidores: [...servidores].sort(porNome) }))
    .sort((a, b) => (!a.formacao) - (!b.formacao) || b.servidores.length - a.servidores.length
      || a.formacao.localeCompare(b.formacao, 'pt-BR'));
  return { total: lista.length, grupos, geradoEm: dados.gerado_em, rh: dados.fontes?.rh ?? null };
}

/** Servidores de uma ou mais unidades (chave `unidade`; "a,b" vira duas). */
export function servidoresDasUnidades(dados, unidades) {
  const chaves = new Set(String(unidades ?? '').split(',').map((u) => u.trim()).filter(Boolean));
  return (dados?.servidores ?? []).filter((s) => chaves.has(s.unidade)).sort(porNome);
}

/** Para a ficha: nunca lança (a ficha segue sem a seção). */
export async function getExtensionistas(municipio) {
  try {
    return extensionistasDoMunicipio(await loadServidoresIdr(), municipio);
  } catch (err) {
    console.warn('[DataGeo:ficha] servidores IDR indisponíveis:', err?.message);
    return null;
  }
}
