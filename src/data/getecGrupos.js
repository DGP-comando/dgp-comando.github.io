// src/data/getecGrupos.js
//
// Grupos de assistidos do GETEC por extensionista (data/privado/getec-grupos.json,
// de scripts/build_getec_grupos.py): cada cliente com município, categoria e,
// quando casou com a CAF, nº da CAF e coordenada. A chave do extensionista é
// o `id` do SisPont (servidores-idr.json). BUCKET PRIVADO (nomes de produtores):
// sem sessão o loader devolve null.

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/getec-grupos.json';

let _promessa = null;

/** Payload ou null (sem sessão/arquivo). Nunca lança. */
export function loadGetecGrupos() {
  _promessa ??= dgFetchData(URL)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      if (!d) _promessa = null; // tenta de novo depois do login
      return d;
    });
  return _promessa;
}

/** Entrada do extensionista pelo id do SisPont, ou null. */
export function grupos(dados, id) {
  return dados?.extensionistas?.[String(id)] ?? null;
}

/** Totais de um extensionista: grupos, clientes (únicos por nome+ibge), com ponto. */
export function resumo(ext) {
  const vistos = new Set();
  let comPonto = 0;
  for (const g of ext?.grupos ?? []) {
    for (const c of g.clientes) {
      const k = `${c.nome}|${c.ibge}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      if (c.lon != null && c.lat != null) comPonto += 1;
    }
  }
  return { grupos: ext?.grupos?.length ?? 0, clientes: vistos.size, comPonto };
}

/**
 * Rede do extensionista: linha da origem (escritório) a cada cliente com ponto
 * na CAF, mais o ponto; um só por família (o mesmo produtor pode estar em dois
 * grupos). `projeto` na feição para a cor.
 */
export function redeFeatures(ext, origem) {
  const feats = [];
  const vistos = new Set();
  for (const g of ext?.grupos ?? []) {
    for (const c of g.clientes) {
      if (c.lon == null || c.lat == null) continue;
      const k = `${c.lon},${c.lat}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      const props = { projeto: g.projeto, nome: c.nome };
      feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [origem, [c.lon, c.lat]] } });
      feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } });
    }
  }
  return feats;
}
