// src/data/programasIdr.js
//
// URs dos programas do IDR por município para o tooltip do município, a partir
// das mesmas camadas de pontos (src/maplibre/layers/programasIdr.js). Conta pelo
// município declarado na planilha (`ibge`), não pelo ponto, e deixa de fora o
// produtor desligado do programa. Bucket privado: sem sessão o loader devolve
// null e a linha some.

import { dgFetchData } from './datageoClient.js';

export const UR_ARQUIVOS = Object.freeze([
  ['Grãos', '/privado/urs-graos-pr.geojson'],
  ['Café', '/privado/urs-cafe-pr.geojson'],
  ['Piscicultura', '/privado/urs-piscicultura-pr.geojson'],
  ['Pecuária de Corte', '/privado/urs-pecuaria-corte-pr.geojson'],
]);

const desligado = (p) => /desligad/i.test(p?.['Observação'] ?? '');

/** {<ibge>: {total, programas: {<programa>: n}}}; `colecoes` na ordem de UR_ARQUIVOS. */
export function ursPorMunicipio(colecoes) {
  const out = {};
  UR_ARQUIVOS.forEach(([programa], i) => {
    for (const f of colecoes[i]?.features ?? []) {
      const p = f.properties ?? {};
      if (!p.ibge || desligado(p)) continue;
      const m = (out[p.ibge] ??= { total: 0, programas: {} });
      m.total += 1;
      m.programas[programa] = (m.programas[programa] ?? 0) + 1;
    }
  });
  return out;
}

const json = (url) => dgFetchData(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

let p = null;
/** Contagem por município, ou null se algum arquivo faltar (sem sessão; tenta de novo depois). Nunca lança. */
export function loadUrsMunicipios() {
  p ??= Promise.all(UR_ARQUIVOS.map(([, url]) => json(url))).then((colecoes) => {
    if (colecoes.some((c) => !c)) {
      p = null;
      return null;
    }
    return ursPorMunicipio(colecoes);
  });
  return p;
}
