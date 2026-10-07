// src/maplibre/layers/fontesProtegidas.js
//
// Fontes protegidas (nascentes com proteção de solo-cimento para captação),
// programa de Proteção de Fontes do IDR-Paraná. Cor por tipo (construção,
// reforma...); ponto vazado = coordenada fora do município da planilha. Hover:
// produtor, comunidade, tipo e ano. Clique: se o CPF do produtor casou com uma
// família da CAF PF, abre o cadastro dela.
//
// Bucket privado (nome do produtor): sem usuário liberado a camada não carrega.

import { FONTE_CORES, loadFontes } from '../../data/fontesProtegidas.js';
import { EMPTY_FC, defineLayer, fc, fmtInt, tipCard } from '../kit.js';
import { abrirFamiliaCaf } from './caf.js';

const SRC = 'dg-fontes-protegidas';
const PT = 'dg-fontes-protegidas-pt';
let dados = null;
let legenda = [];

/** Features (id = índice em `p`) e contagem por tipo. */
export function fonteFeatures(d) {
  const counts = (d?.tipos ?? []).map(() => 0);
  const features = (d?.p ?? []).map(([lon, lat, , , , t, , , fora], id) => {
    counts[t] += 1;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { t, fora } };
  });
  return { features, counts };
}

/** Legenda dos tipos com fonte; key = t entra antes do filtro (a posição não é o t). */
export const fonteLegenda = (counts, tipos) => counts
  .map((count, i) => ({ key: i, label: tipos[i], color: FONTE_CORES[i], count }))
  .filter((l) => l.count);

const cor = ['match', ['get', 't'], ...FONTE_CORES.flatMap((c, i) => [i, c]), '#e2e8f0'];

export default [defineLayer({
  id: 'datageo-fontes-protegidas',
  name: 'Fontes protegidas (IDR)',
  category: 'IDR-Paraná',
  icon: '💧',
  source: 'IDR-Paraná · Proteção de Fontes',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: PT,
    type: 'circle',
    source: SRC,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.2, 10, 4, 14, 7],
      'circle-color': ['case', ['==', ['get', 'fora'], 1], 'rgba(0,0,0,0)', cor],
      'circle-stroke-color': ['case', ['==', ['get', 'fora'], 1], cor, '#0c4a6e'],
      'circle-stroke-width': ['case', ['==', ['get', 'fora'], 1], 1.5, 1],
    },
  }],
  interactive: [PT],
  async load(ctx) {
    dados = await loadFontes();
    if (!dados) throw new Error('acesso restrito: entre com usuário liberado');
    const { features, counts } = fonteFeatures(dados);
    legenda = fonteLegenda(counts, dados.tipos);
    ctx.setData(SRC, fc(features));
    const caf = dados.p.filter((r) => r[9]).length;
    return { count: features.length, info: `planilha de ${dados.referencia.split('-').reverse().join('/')} · ${fmtInt(caf)} ligadas a família da CAF` };
  },
  tooltip: (_p, feature) => {
    const r = dados?.p?.[feature?.id];
    if (!r) return '';
    const [, , , comunidade, produtor, t, ano, mes, fora, caf] = r;
    return tipCard({
      icon: '💧',
      title: produtor || 'Fonte protegida',
      subtitle: comunidade ? `Comunidade ${comunidade}` : 'Fonte protegida',
      rows: [
        ['Tipo', dados.tipos[t]],
        ['Proteção', [mes, ano].filter(Boolean).join(' ') || ''],
        ['Família CAF', caf ? `CAF ${caf}` : ''],
        fora ? ['Localização', 'fora do município da planilha', 'warn'] : null,
      ],
      note: caf ? 'Clique para o cadastro CAF da família' : 'Solo-cimento para captação',
      source: 'IDR-Paraná · Proteção de Fontes',
    });
  },
  click: (_p, feature, ctx) => {
    const caf = dados?.p?.[feature?.id]?.[9];
    if (caf) abrirFamiliaCaf(caf, ctx);
  },
  rowControls: () => ({ legend: legenda }),
  legendFilter: 't',
})];
