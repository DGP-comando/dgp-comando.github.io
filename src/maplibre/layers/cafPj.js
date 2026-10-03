// src/maplibre/layers/cafPj.js
//
// CAF jurídicas (associações, cooperativas singulares e centrais,
// empreendimentos familiares) do MDA, no endereço geocodificado por
// scripts/build_caf_pj.py (rua, CEP, assentamento do INCRA ou, sem nenhum,
// a sede urbana do município: contorno apagado). O clique liga a entidade às famílias sócias com CAF PF
// (linhas até cada ponto) e, nas centrais, às filiadas e às famílias delas;
// o painel traz dados, responsável, contato e a lista de sócios.
//
// Bucket privado (LGPD): sem usuário liberado a camada não carrega.

import { PJ_CORES, loadCafPj, loadCafPontos, periodo } from '../../data/cafFamilias.js';
import { pjHtml } from '../../datageoCaf.js';
import { openPainel } from '../../datageoFicha.js';
import { EMPTY_FC, TEXT_FONT, defineLayer, fc, fmtInt, tipCard } from '../kit.js';

const SRC = 'dg-caf-pj';
const PT = 'dg-caf-pj-pt';
const REDE = 'dg-caf-rede';
const PRECISAO = { rua: 'endereço', cep: 'CEP', assentamento: 'assentamento (INCRA)', sede: 'sede do município', municipio: 'município' };
const APROX = new Set(['sede', 'municipio']);

let dados = null; // caf-pj.json
let legenda = [];
let pontoDe = null; // nr_caf PF -> [lon, lat, nome do declarante]

/** Features das PJ (id = índice em `pj`) e contagem por tipo. */
export function pjFeatures(d) {
  const counts = (d?.tipos ?? []).map(() => 0);
  const features = (d?.pj ?? []).map((p, id) => {
    const t = Math.max(0, d.tipos.indexOf(p.tipo));
    counts[t] += 1;
    return {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { t, nome: p.fantasia || p.razao, aprox: APROX.has(p.precisao) ? 1 : 0 },
    };
  });
  return { features, counts };
}

/**
 * Rede da entidade: linha da PJ a cada família sócia com ponto no mapa (nivel
 * 0) e, nas centrais, a cada filiada (nivel 2) e das filiadas às famílias
 * delas (nivel 1).
 */
export function redeFeatures(p, todas, pontos) {
  const feats = [];
  const linha = (a, b, nivel) => feats.push({ type: 'Feature', properties: { nivel }, geometry: { type: 'LineString', coordinates: [a, b] } });
  const ligar = (de, k, nivel) => {
    const alvo = pontos.get(String(k));
    if (!alvo) return;
    linha([de.lon, de.lat], [alvo[0], alvo[1]], nivel);
    feats.push({ type: 'Feature', properties: { nivel }, geometry: { type: 'Point', coordinates: [alvo[0], alvo[1]] } });
  };
  for (const k of p.familias) ligar(p, k, 0);
  for (const caf of p.filiadas ?? []) {
    const f = todas.find((x) => x.caf === caf);
    if (!f) continue;
    linha([p.lon, p.lat], [f.lon, f.lat], 2);
    for (const k of f.familias) ligar(f, k, 1);
  }
  return feats;
}

/** [[w, s], [e, n]] dos pontos e linhas, ou null. */
export function extensao(feats) {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of feats) {
    const cs = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const [x, y] of cs) {
      w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y);
    }
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

const cor = ['match', ['get', 't'], ...PJ_CORES.flatMap((c, i) => [i, c]), '#e2e8f0'];

export default [defineLayer({
  id: 'datageo-caf-pj',
  name: 'CAF jurídicas (associações e cooperativas)',
  category: 'Agricultura familiar e CAR',
  icon: '🤝',
  source: 'MDA · CAF PJ',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC }, [REDE]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: 'dg-caf-rede-linha',
      type: 'line',
      source: REDE,
      filter: ['==', ['geometry-type'], 'LineString'],
      metadata: { 'dg:slot': 'point' }, // acima das divisas do CAR e dos pontos das famílias
      paint: {
        'line-color': ['match', ['get', 'nivel'], 2, '#fb7185', '#ffffff'],
        'line-width': ['match', ['get', 'nivel'], 2, 2.5, 1.4],
        'line-opacity': 0.85,
      },
    },
    {
      id: 'dg-caf-rede-pt',
      type: 'circle',
      source: REDE,
      filter: ['==', ['geometry-type'], 'Point'],
      metadata: { 'dg:slot': 'label' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 8],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    },
    {
      id: PT,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4.5, 12, 8],
        'circle-color': cor,
        'circle-stroke-color': ['case', ['==', ['get', 'aprox'], 1], 'rgba(255,255,255,0.4)', '#ffffff'],
        'circle-stroke-width': ['case', ['==', ['get', 'aprox'], 1], 1, 2],
      },
    },
    {
      id: 'dg-caf-pj-label',
      type: 'symbol',
      source: SRC,
      minzoom: 9,
      layout: {
        'text-field': ['get', 'nome'], 'text-font': TEXT_FONT, 'text-size': 11,
        'text-anchor': 'bottom', 'text-offset': [0, -0.9], 'text-max-width': 16,
      },
      paint: { 'text-color': '#e2e8f0', 'text-halo-color': 'rgba(0,0,0,0.95)', 'text-halo-width': 1.4 },
    },
  ],
  interactive: [PT],
  async load(ctx) {
    const [pj, pontos] = await Promise.all([loadCafPj(), loadCafPontos()]);
    if (!pj || !pontos) throw new Error('acesso restrito: entre com usuário liberado');
    dados = pj;
    pontoDe = new Map(pontos.p.map((r) => [String(r[2]), [r[0], r[1], r[5]]]));
    const { features, counts } = pjFeatures(pj);
    legenda = counts.map((count, i) => ({ label: pj.tipos[i], color: PJ_CORES[i], count }));
    ctx.setData(SRC, fc(features));
    const aprox = features.filter((f) => f.properties.aprox).length;
    return { count: features.length, info: `${periodo(pj.referencia)} · ${fmtInt(aprox)} com posição aproximada (sede do município)` };
  },
  onDisable: (ctx) => {
    ctx.setData(REDE, EMPTY_FC);
  },
  tooltip: (_p, feature) => {
    const p = dados?.pj?.[feature?.id];
    if (!p) return '';
    return tipCard({
      icon: '🤝',
      title: p.fantasia || p.razao,
      subtitle: `${p.tipo} · ${p.endereco?.municipio ?? ''}`,
      rows: [
        ['Famílias sócias (CAF PF)', fmtInt(p.familias.length)],
        ['Sócios sem CAF PF', p.socios_sem_caf.length ? fmtInt(p.socios_sem_caf.length) : ''],
        ['Filiadas', p.filiadas.length ? fmtInt(p.filiadas.length) : ''],
        ['Localização', `${PRECISAO[p.precisao] ?? p.precisao}${APROX.has(p.precisao) ? ' (aproximada)' : ''}`,
          APROX.has(p.precisao) ? 'warn' : null],
      ],
      note: 'Clique para ligar aos sócios no mapa',
      source: `MDA · CAF PJ ${periodo(dados.referencia)}`,
    });
  },
  click: (_p, feature, ctx) => {
    const p = dados?.pj?.[feature?.id];
    if (!p) return;
    const rede = redeFeatures(p, dados.pj, pontoDe);
    ctx.setData(REDE, fc(rede));
    const bb = extensao([{ geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }, ...rede]);
    if (bb && rede.length) ctx.map.fitBounds(bb, { padding: 80, maxZoom: 12, duration: 800 });
    const filiadas = dados.pj.filter((x) => p.filiadas.includes(x.caf));
    const nomes = new Map(p.familias.map((k) => [k, pontoDe.get(String(k))?.[2] ?? '']));
    openPainel({
      nome: p.fantasia || p.razao,
      meta: `CAF PJ ${p.caf} · ${p.tipo} · acesso restrito`,
      carregar: async () => pjHtml(p, { nomes, filiadas }),
    });
  },
  rowControls: () => ({ legend: legenda }),
})];
