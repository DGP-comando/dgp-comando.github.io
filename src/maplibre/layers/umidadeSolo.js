// src/maplibre/layers/umidadeSolo.js
//
// Umidade do solo no PR (NASA SMAP L4, sucessor do NASA-USDA Global Soil
// Moisture no Earth Engine): grade 0,09° do último dia, JSON estático de
// scripts/build_umidade_solo.py. Cor pelo percentil da zona de raiz (seco ou
// úmido para a época, frente à climatologia do modelo); tooltip com todas as
// variáveis da célula.

import { EMPTY_FC, defineLayer, fc, fmtCoord, fmtNum, tipCard } from '../kit.js';
import { gridCellFeatures } from './gradesClima.js';

const SRC = 'dg-umidade-solo';
const FILL = `${SRC}-fill`;
export const CLASSES = Object.freeze([
  { max: 10, label: 'Muito seco (abaixo do percentil 10)', color: '#8c510a' },
  { max: 30, label: 'Seco (percentil 10 a 30)', color: '#d8b365' },
  { max: 70, label: 'Normal (percentil 30 a 70)', color: '#d9d9c3' },
  { max: 90, label: 'Úmido (percentil 70 a 90)', color: '#5ab4ac' },
  { max: Infinity, label: 'Muito úmido (acima do percentil 90)', color: '#01665e' },
]);

let dados = null;
let legenda = [];

export const classeDe = (pctl) => CLASSES.findIndex((c) => pctl < c.max);

/** Células do PR (valor não nulo), `c` = classe do percentil. */
export function umidadeFeatures(d) {
  const counts = new Array(CLASSES.length).fill(0);
  const features = gridCellFeatures(d, (k) => d.pctl[k] != null).map((f) => {
    const c = classeDe(d.pctl[f.id]);
    counts[c] += 1;
    return { ...f, properties: { ...f.properties, c } };
  });
  return { features, counts };
}

const pct = (v) => (v == null ? '' : `${fmtNum(v, 1)}%`);

export function umidadeTooltip(k, d) {
  if (k == null || !d || d.pctl[k] == null) return '';
  const c = CLASSES[classeDe(d.pctl[k])];
  const lon = d.bounds.west + (k % d.width) * ((d.bounds.east - d.bounds.west) / (d.width - 1));
  const lat = d.bounds.south + Math.floor(k / d.width) * ((d.bounds.north - d.bounds.south) / (d.height - 1));
  const anom = d.anom[k];
  return tipCard({
    icon: '💧',
    title: 'Umidade do solo',
    subtitle: `${fmtCoord(lat, lon)} · ${d.data.split('-').reverse().join('/')}`,
    badge: { text: c.label.split(' (')[0], tone: d.pctl[k] < 30 ? 'warn' : 'info' },
    rows: [
      ['Zona de raiz (0 a 100 cm)', pct(d.raiz[k])],
      ['Percentil da zona de raiz', `${fmtNum(d.pctl[k], 0)} (de 0 = mais seco a 100 = mais úmido)`],
      ['Saturação da zona de raiz', pct(d.molh[k])],
      ['Superfície (0 a 5 cm)', pct(d.sup[k])],
      ['Anomalia da superfície', anom == null ? '' : `${anom > 0 ? '+' : ''}${fmtNum(anom, 1)} p.p.`],
      ['Perfil (até a rocha)', pct(d.perfil[k])],
    ],
    source: d.fonte,
  });
}

export const umidadeSoloLayer = defineLayer({
  id: 'datageo-umidade-solo',
  name: 'Umidade do solo (SMAP)',
  category: 'Recursos hídricos',
  icon: '💧',
  source: 'NASA SMAP L4',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: FILL,
    type: 'fill',
    source: SRC,
    paint: {
      'fill-color': ['match', ['get', 'c'], ...CLASSES.flatMap((cl, i) => [i, cl.color]), '#94a3b8'],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.85, 0.6],
    },
  }],
  interactive: [FILL],
  legendFilter: 'c',
  async load(ctx) {
    const resp = await fetch('/data/umidade-solo-pr.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    dados = await resp.json();
    const { features, counts } = umidadeFeatures(dados);
    legenda = counts.map((count, i) => ({ key: i, label: CLASSES[i].label, color: CLASSES[i].color, count }));
    ctx.setData(SRC, fc(features));
    return { count: features.length, info: `dia ${dados.data.split('-').reverse().join('/')}, células de 0,09° (~10 km)` };
  },
  tooltip: (_p, feature) => umidadeTooltip(feature?.id, dados),
  rowControls: () => ({ legend: legenda }),
});

export default [umidadeSoloLayer];
