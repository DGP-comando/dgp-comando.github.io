// src/maplibre/layers/geoprVista.js
//
// Feições da vista vindas do FeatureServer do GeoPR, para dar hover e tooltip a
// camadas que o mapa desenha como imagem (raster não responde ao hover). A
// partir de `minzoom`, uma consulta por movimento (a anterior é abortada) traz
// as feições da vista, generalizadas ao tamanho de ~1 pixel, para uma fonte
// GeoJSON com um alvo de hover invisível e um realce por feature-state.
// Usado pela hidrografia (trechos) e pelas ottobacias por trecho (áreas).

import { EMPTY_FC } from '../kit.js';
import { query } from './iatPontos.js';

const MAX_POR_VISTA = 2000; // maxRecordCount dos serviços do GeoPR

/** Área com sinal de um anel [[x, y], ...] (positiva = anti-horário). */
const areaComSinal = (anel) => anel.reduce((a, [x1, y1], i) => {
  const [x2, y2] = anel[(i + 1) % anel.length];
  return a + (x1 * y2 - x2 * y1);
}, 0) / 2;

/**
 * Anéis do ArcGIS -> geometria GeoJSON. No ArcGIS o anel externo é horário e o
 * buraco anti-horário; cada externo abre um polígono, buracos vão no anterior.
 */
export function ringsParaGeojson(rings) {
  const poligonos = [];
  for (const anel of rings ?? []) {
    if (!Array.isArray(anel) || anel.length < 4) continue;
    if (areaComSinal(anel) < 0 || !poligonos.length) poligonos.push([anel]);
    else poligonos.at(-1).push(anel);
  }
  if (!poligonos.length) return null;
  return poligonos.length === 1
    ? { type: 'Polygon', coordinates: poligonos[0] }
    : { type: 'MultiPolygon', coordinates: poligonos };
}

/**
 * @param {object} o
 * @param {string} o.src      id da fonte GeoJSON (dg-...)
 * @param {string} o.servico  serviço em 00_PUBLICACOES
 * @param {string[]} o.campos outFields (inclua objectid: vira o id da feição)
 * @param {number} o.minzoom  zoom a partir do qual consulta
 * @param {(f: object) => object|null} o.feicao   feição do ArcGIS -> GeoJSON
 * @param {(p: object) => string} o.tooltip
 * @param {Array<object>} o.layers  layers de estilo sobre `src` (o primeiro é o alvo do hover)
 * @param {string} o.oQue     "trechos", "áreas"... (texto da legenda)
 * @param {string} o.rotulo   para os avisos no console
 */
export function consultaDaVista({ src, servico, campos, minzoom, feicao, tooltip, layers, oQue, rotulo }) {
  const st = { ctx: null, aborter: null, truncado: false };

  async function busca(map, signal) {
    const b = map.getBounds();
    const grau = 360 / (512 * 2 ** map.getZoom());
    const j = await query(servico, '1=1', campos, {
      geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true', maxAllowableOffset: String(grau), geometryPrecision: '6',
      resultRecordCount: String(MAX_POR_VISTA),
    }, signal);
    return { features: j.features.map(feicao).filter(Boolean), truncado: Boolean(j.exceededTransferLimit) };
  }

  const onMove = () => {
    const map = st.ctx?.map;
    if (!map || map.getZoom() < minzoom) return;
    st.aborter?.abort();
    st.aborter = new AbortController();
    busca(map, st.aborter.signal)
      .then((r) => {
        if (!st.ctx) return;
        st.ctx.setData(src, { type: 'FeatureCollection', features: r.features });
        if (r.truncado !== st.truncado) {
          st.truncado = r.truncado;
          st.ctx.refreshPanel();
        }
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') console.warn(`[maplibre:${rotulo}]`, err);
      });
  };
  const onZoom = () => st.ctx?.refreshPanel();

  return {
    sources: { [src]: { type: 'geojson', data: EMPTY_FC } },
    layers,
    interactive: [layers[0].id],
    hoverState: src,
    tooltip,
    legenda: () => {
      const z = st.ctx?.map?.getZoom?.() ?? 0;
      if (z < minzoom) return [{ label: `Aproxime (zoom ${minzoom}+) para o tooltip dos ${oQue}`, color: '#64748b' }];
      return st.truncado ? [{ label: `Vista com mais de ${MAX_POR_VISTA} ${oQue}: aproxime para o tooltip de todos`, color: '#64748b' }] : [];
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
