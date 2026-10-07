// src/maplibre/layers/hidrografiaTrechos.js
//
// Tooltip da hidrografia. O desenho é imagem do GeoPR (raster não responde ao
// hover); a partir do zoom 12 os trechos da vista vêm do FeatureServer da
// mesma rede ottocodificada (IAT 2020) para uma linha invisível que recebe o
// hover, e o trecho sob o cursor ganha um realce (geoprVista.js).

import { fmtNum, tipCard } from '../kit.js';
import { consultaDaVista } from './geoprVista.js';

const SERVICO = 'rede_otto_trech_drena_2020_iat';
export const TRECHOS_MINZOOM = 12;
const CAMPOS = ['objectid', 'noriocomp', 'nustrahler', 'nucomptrec', 'nuareamont', 'dedominial', 'cobacia', 'cocursodag'];
const SRC = 'dg-hidrografia-trechos';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Atributos do serviço -> propriedades da feição (nomes curtos, números de verdade). */
export function trechoProps(a = {}) {
  return {
    nome: String(a.noriocomp ?? '').trim(),
    strahler: num(a.nustrahler),
    km: num(a.nucomptrec),
    areaMontKm2: num(a.nuareamont),
    dominio: String(a.dedominial ?? '').trim(),
    cobacia: String(a.cobacia ?? '').trim(),
    curso: String(a.cocursodag ?? '').trim(),
  };
}

/** Trecho em JSON do ArcGIS (paths) -> feição GeoJSON com id (o realce usa feature-state). */
export function trechoFeature(f) {
  const paths = f?.geometry?.paths;
  if (!Array.isArray(paths) || !paths.length) return null;
  return {
    type: 'Feature',
    id: Number(f.attributes?.objectid),
    geometry: { type: 'MultiLineString', coordinates: paths },
    properties: trechoProps(f.attributes),
  };
}

const comprimento = (km) => (km < 1 ? `${fmtNum(km * 1000, 0)} m` : `${fmtNum(km, km < 10 ? 2 : 1)} km`);
const area = (km2) => (km2 < 1 ? `${fmtNum(km2 * 100, 1)} ha` : `${fmtNum(km2, km2 < 10 ? 2 : km2 < 100 ? 1 : 0)} km²`);

export function trechoTooltip(p) {
  return tipCard({
    icon: '🏞️',
    title: p.nome || 'Curso d’água sem nome',
    subtitle: 'Hidrografia · trecho da rede ottocodificada',
    rows: [
      ['Ordem de Strahler', p.strahler ?? ''],
      ['Comprimento do trecho', p.km != null ? comprimento(p.km) : ''],
      ['Área drenada a montante', p.areaMontKm2 != null ? area(p.areaMontKm2) : ''],
      ['Domínio', p.dominio],
      ['Ottobacia', p.cobacia],
      ['Curso d’água (código)', p.curso],
    ],
    source: 'IAT/GeoPR · rede hidrográfica ottocodificada 2020 (base ANA), consulta ao vivo',
  });
}

/**
 * Peças para compor a camada Hidrografia: fontes, layers, tooltip, realce e
 * o ciclo de vida (consulta da vista a cada movimento a partir do zoom 12).
 */
export const trechosDaHidrografia = () => consultaDaVista({
  src: SRC,
  servico: SERVICO,
  campos: CAMPOS,
  minzoom: TRECHOS_MINZOOM,
  feicao: trechoFeature,
  tooltip: (p) => trechoTooltip(p),
  oQue: 'trechos',
  rotulo: 'datageo-hidrografia trechos',
  layers: [
    // Alvo do hover: largo e invisível.
    { id: `${SRC}-hit`, type: 'line', source: SRC, minzoom: TRECHOS_MINZOOM,
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 12 } },
    // Realce do trecho sob o cursor (feature-state hover do anfitrião).
    { id: `${SRC}-realce`, type: 'line', source: SRC, minzoom: TRECHOS_MINZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#7dd3fc',
        'line-width': 4,
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0],
      } },
  ],
});
