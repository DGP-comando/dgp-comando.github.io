// src/maplibre/layers/hidrografiaTrechos.js
//
// Tooltip da hidrografia. O desenho é imagem do GeoPR (raster não responde ao
// hover); a partir do zoom 12 os trechos da vista vêm do FeatureServer da
// mesma rede ottocodificada (IAT 2020) para uma linha invisível que recebe o
// hover, e o trecho sob o cursor ganha um realce. Mesma mecânica dos pontos de
// outorga (iatPontos.js): uma consulta por movimento, a anterior abortada.

import { EMPTY_FC, fmtNum, tipCard } from '../kit.js';
import { query } from './iatPontos.js';

const SERVICO = 'rede_otto_trech_drena_2020_iat';
export const TRECHOS_MINZOOM = 12;
const MAX_POR_VISTA = 2000; // maxRecordCount do serviço
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
export function trechosDaHidrografia() {
  const st = { ctx: null, aborter: null, truncado: false };

  async function busca(bounds, signal, map) {
    // Generalização do tamanho de ~1 pixel: menos vértices sem mudar o hover.
    const grau = 360 / (512 * 2 ** map.getZoom());
    const j = await query(SERVICO, '1=1', CAMPOS, {
      geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true', maxAllowableOffset: String(grau), geometryPrecision: '6',
      resultRecordCount: String(MAX_POR_VISTA),
    }, signal);
    return { features: j.features.map(trechoFeature).filter(Boolean), truncado: Boolean(j.exceededTransferLimit) };
  }

  const onMove = () => {
    const map = st.ctx?.map;
    if (!map || map.getZoom() < TRECHOS_MINZOOM) return;
    st.aborter?.abort();
    st.aborter = new AbortController();
    busca(map.getBounds(), st.aborter.signal, map)
      .then((r) => {
        if (!st.ctx) return;
        st.ctx.setData(SRC, { type: 'FeatureCollection', features: r.features });
        if (r.truncado !== st.truncado) {
          st.truncado = r.truncado;
          st.ctx.refreshPanel();
        }
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') console.warn('[maplibre:datageo-hidrografia] trechos', err);
      });
  };
  const onZoom = () => st.ctx?.refreshPanel();

  return {
    sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
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
    interactive: [`${SRC}-hit`],
    hoverState: SRC,
    tooltip: (p) => trechoTooltip(p),
    legenda: () => {
      const z = st.ctx?.map?.getZoom?.() ?? 0;
      if (z < TRECHOS_MINZOOM) return [{ label: `Aproxime (zoom ${TRECHOS_MINZOOM}+) para o tooltip dos trechos`, color: '#64748b' }];
      return st.truncado ? [{ label: `Vista com mais de ${MAX_POR_VISTA} trechos: aproxime para o tooltip de todos`, color: '#64748b' }] : [];
    },
    ligar(ctx) {
      st.ctx = ctx;
      ctx.map.off('moveend', onMove);
      ctx.map.on('moveend', onMove);
      ctx.map.off('zoomend', onZoom);
      ctx.map.on('zoomend', onZoom);
      onMove();
    },
    desligar(ctx) {
      ctx.map.off('moveend', onMove);
      ctx.map.off('zoomend', onZoom);
      st.aborter?.abort();
      st.ctx = null;
    },
  };
}
