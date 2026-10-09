// src/maplibre/layers/pivos.js
//
// Pivôs centrais de irrigação do PR (ANA/INPE, base 2022), cruzados com as
// outorgas (IAT SIGARH/CRH e ANA) pelo projeto pivos-pr
// (scripts/build_pivos.py). Cada pivô vem duas vezes no GeoJSON: ponto na
// vista do estado (50 ha somem ali) e o círculo de perto. Cor = classe do
// vínculo com a outorga. A demanda é estimada (3,4 m³/h por ha), não é vazão
// outorgada. Sem o requerente da outorga (LGPD).

import { defineLayer, fmtInt, fmtNum, tipCard } from '../kit.js';

const SRC = 'dg-pivos';
const URL_PIVOS = '/data/pivos-pr.geojson';
const ZOOM_CIRCULO = 11;

export const VINCULOS = Object.freeze([
  { key: 'ALTA', label: 'Outorga compatível (≤ 1 km)', color: '#22c55e' },
  { key: 'VAZÃO INCOMPATÍVEL', label: 'Outorga perto, vazão incompatível', color: '#facc15' },
  { key: 'DISTANTE', label: 'Outorga só a 1–5 km', color: '#f97316' },
  { key: 'SEM OUTORGA', label: 'Sem outorga encontrada', color: '#ef4444' },
]);
const cor = ['match', ['get', 'vinculo'], ...VINCULOS.flatMap((v) => [v.key, v.color]), '#94a3b8'];
const ehPonto = ['==', ['geometry-type'], 'Point'];

const m3h = (v) => (v == null ? '' : `${fmtInt(v)} m³/h`);

export function pivoTooltip(p) {
  const v = VINCULOS.find((x) => x.key === p.vinculo);
  const temOutorga = p.vinculo !== 'SEM OUTORGA' && p.ato;
  return tipCard({
    icon: '🌀',
    title: `Pivô ${p.id} · ${p.ha != null ? `${fmtNum(p.ha, 1)} ha` : ''}`,
    subtitle: [p.municipio, p.pivosSistema > 1 ? `sistema de ${p.pivosSistema} pivôs` : ''].filter(Boolean).join(' · '),
    badge: v ? { text: p.vinculo === 'ALTA' ? 'outorga compatível' : p.vinculo.toLowerCase(), tone: p.vinculo === 'ALTA' ? 'ok' : 'warn' } : null,
    rows: [
      ['Demanda estimada', m3h(p.demanda)],
      ...(temOutorga ? [
        ['Outorga mais provável', `${p.fonte} · ${p.tipoAto ?? 'ato'} ${p.ato}`],
        ['Situação', [p.situacao, p.vigente === 'SIM' ? 'vigente hoje' : ''].filter(Boolean).join(' · ')],
        ['Vazão outorgada (sistema)', m3h(p.qOutorgada)],
        ['Cobertura da demanda', p.cobertura != null ? `${fmtInt(p.cobertura * 100)}%` : ''],
        ['Distância da captação', p.dist != null ? `${fmtInt(p.dist)} m` : ''],
        ['Corpo hídrico', [p.corpoHidrico, p.manancial].filter(Boolean).join(' · ')],
        ['Empreendimento', p.empreendimento ?? ''],
        ['Vencimento', p.vencimento ?? ''],
      ] : []),
    ],
    source: 'ANA/INPE · pivôs centrais 2022 · vínculo com outorgas IAT/ANA estimado (demanda 3,4 m³/h por ha)',
  });
}

let contagem = null;

export const pivosLayer = defineLayer({
  id: 'datageo-pivos',
  name: 'Pivôs centrais de irrigação',
  category: 'Recursos hídricos',
  icon: '🌀',
  source: 'ANA/INPE (2022) × outorgas IAT/ANA',
  sources: { [SRC]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, generateId: true } },
  layers: [
    { id: `${SRC}-fill`, type: 'fill', source: SRC, minzoom: ZOOM_CIRCULO - 1, filter: ['!', ehPonto],
      paint: { 'fill-color': cor, 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.3] } },
    { id: `${SRC}-line`, type: 'line', source: SRC, minzoom: ZOOM_CIRCULO - 1, filter: ['!', ehPonto],
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#fde047', cor],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.5],
      } },
    { id: `${SRC}-pt`, type: 'circle', source: SRC, maxzoom: ZOOM_CIRCULO, filter: ehPonto,
      paint: {
        'circle-color': cor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 10, 6],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#fde047', '#0f172a'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1],
      } },
  ],
  interactive: [`${SRC}-pt`, `${SRC}-fill`],
  hoverState: SRC,
  legendFilter: 'vinculo',
  async load(ctx) {
    const r = await fetch(URL_PIVOS);
    if (!r.ok) throw new Error(`${URL_PIVOS}: HTTP ${r.status}`);
    const fc = await r.json();
    ctx.setData(SRC, fc);
    const pontos = fc.features.filter((f) => f.geometry.type === 'Point');
    contagem = Object.fromEntries(VINCULOS.map((v) => [v.key, pontos.filter((f) => f.properties.vinculo === v.key).length]));
    return pontos.length;
  },
  tooltip: (p) => pivoTooltip(p),
  rowControls: () => ({ legend: VINCULOS.map((v) => ({ ...v, count: contagem?.[v.key] ?? '' })) }),
});

export default [pivosLayer];
