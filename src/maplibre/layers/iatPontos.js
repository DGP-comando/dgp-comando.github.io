// src/maplibre/layers/iatPontos.js
//
// Pontos do IAT ao vivo do ArcGIS Server do GeoPR (outorgas, licenciamento),
// com chave de classificação nos chips, como a do clima histórico (BR-DWGD):
//   - longe: imagens do MapServer/export, uma dynamicLayer por classe;
//   - perto (VEC_MINZOOM+): pontos da vista pelo FeatureServer, para o tooltip.
//
// Cada modo (chip) é uma legenda [{key, label, curto, color, like}] em ordem de
// prioridade. A classe de um registro é a primeira cujo padrão LIKE casa com o
// campo do modo naquele sistema; sem casar, o `padrao` do sistema. Os MESMOS
// padrões viram o where das imagens (no export a primeira camada desenha por
// cima, então ponto que casa com duas classes aparece na de maior prioridade)
// e o RegExp do cliente (tooltip, ficha): mapa e contagem não divergem.
// Padrões usam % no lugar das letras acentuadas: o GeoPR guarda parte delas
// com UTF-8 quebrado ("Aqu�­fero").

import { EMPTY_FC, defineLayer, fc, fmtInt, point } from '../kit.js';

export const BASE = 'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES';
const VEC_MINZOOM = 12;
const MAX_POR_VISTA = 2000; // maxRecordCount dos serviços

/** O GeoPR devolve UTF-8 quebrado em alguns campos ("Aqu�­fero"): refaz o par C3 xx. */
export const consertaUtf8 = (s) => (typeof s === 'string'
  ? s.replace(/�([\u0080-¿])/g, (_, c) => String.fromCharCode(0xC0 + c.charCodeAt(0) - 0x80))
  : s);

const limpa = (attrs) => Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, consertaUtf8(v)]));

const regexCache = new Map();
/** LIKE do SQL (% e _) em RegExp ancorado. */
export function likeRegex(p) {
  if (!regexCache.has(p)) {
    const corpo = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]');
    regexCache.set(p, new RegExp(`^${corpo}$`));
  }
  return regexCache.get(p);
}

const likesDo = (s, modo) => s.modos[modo.id].like ?? Object.fromEntries(modo.legenda.map((g) => [g.key, g.like]));

/** Classe do registro (atributos crus ou consertados) no modo, para o sistema s. */
export function classifica(s, modo, a) {
  const m = s.modos[modo.id];
  if (m.fixo) return m.fixo;
  const likes = likesDo(s, modo);
  const t = consertaUtf8(String(a?.[m.campo] ?? ''));
  return modo.legenda.find((g) => likes[g.key]?.some((p) => likeRegex(p).test(t)))?.key ?? m.padrao;
}

/** [{where, color}] do sistema no modo, de cima para baixo (a última é o resto). */
export function camadasExport(s, modo) {
  const m = s.modos[modo.id];
  const cor = (k) => modo.legenda.find((g) => g.key === k).color;
  if (m.fixo) return [{ where: s.where, color: cor(m.fixo) }];
  const likes = likesDo(s, modo);
  const classes = modo.legenda.filter((g) => likes[g.key]?.length && g.key !== m.padrao).map((g) => ({
    where: `(${s.where}) AND (${likes[g.key].map((p) => `${m.campo} LIKE '${p}'`).join(' OR ')})`,
    color: g.color,
  }));
  return [...classes, { where: s.where, color: cor(m.padrao) }];
}

const symbol = (cor) => {
  const h = cor.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return { type: 'esriSMS', style: 'esriSMSCircle', color: [...rgb, 235], size: 4, outline: { color: [5, 8, 13, 200], width: 0.5 } };
};

/** URL de tile do MapServer/export (MapLibre troca {bbox-epsg-3857}). */
export function exportTileUrl(servico, camadas) {
  const dynamicLayers = camadas.map(({ where, color }, id) => ({
    id, source: { type: 'mapLayer', mapLayerId: 0 }, definitionExpression: where,
    drawingInfo: { renderer: { type: 'simple', symbol: symbol(color) } },
  }));
  const qs = new URLSearchParams({
    bboxSR: '3857', imageSR: '3857', size: '512,512', format: 'png32', transparent: 'true', f: 'image',
    dynamicLayers: JSON.stringify(dynamicLayers),
  });
  return `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}&${qs}`;
}

// O GeoPR barra (sem cabeçalho CORS) URLs de export perto de 7,7 kB; acima
// deste teto as classes se dividem em fatias, cada uma numa fonte raster.
const URL_MAX = 4000;
const VAZIO = Object.freeze([{ where: '1=0', color: '#000000' }]);

/** URLs de tile das camadas, em fatias de até URL_MAX (a primeira é a de cima). */
export function fatiasExport(servico, camadas) {
  const fatias = [[]];
  for (const c of camadas) {
    const atual = fatias.at(-1);
    if (atual.length && exportTileUrl(servico, [...atual, c]).length > URL_MAX) fatias.push([c]);
    else atual.push(c);
  }
  return fatias.map((f) => exportTileUrl(servico, f));
}

export async function query(servico, where, outFields, extra = {}, signal) {
  const qs = new URLSearchParams({ where, outFields: outFields.join(','), f: 'json', ...extra });
  const r = await fetch(`${BASE}/${servico}/FeatureServer/0/query`, {
    method: 'POST', body: qs, signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) throw new Error(`${servico} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${servico}: ${j.error.message}`);
  return j;
}

/** Cláusula `campo IN (...)` com os códigos IBGE (só dígitos: nada de texto livre na consulta). */
export function filtroMunicipios({ campo, texto }, ibges) {
  const cods = [...new Set(ibges.map(String).filter((c) => /^\d{7}$/.test(c)))];
  if (!cods.length) return null;
  return `${campo} IN (${cods.map((c) => (texto ? `'${c}'` : c)).join(',')})`;
}

const COUNT_STAT = JSON.stringify([{ statisticType: 'count', onStatisticField: 'objectid', outStatisticFieldName: 'n' }]);

/**
 * Contagens de um sistema nos municípios, por classe de cada modo:
 * {total, [modo.id]: {classe: n}}. Uma consulta só, agrupada pelos campos dos modos.
 */
export async function contagemSistema(s, modos, ibges) {
  const f = filtroMunicipios(s.mun, ibges);
  const vazio = { total: 0, ...Object.fromEntries(modos.map((m) => [m.id, {}])) };
  if (!f) return vazio;
  const where = `(${s.where}) AND ${f}`;
  const campos = [...new Set(modos.map((m) => s.modos[m.id].campo).filter(Boolean))];
  const linhas = campos.length
    ? (await query(s.servico, where, [], { groupByFieldsForStatistics: campos.join(','), outStatistics: COUNT_STAT }))
      .features.map((x) => x.attributes)
    : [{ n: (await query(s.servico, where, [], { returnCountOnly: 'true' })).count }];
  const out = vazio;
  for (const a of linhas) {
    const n = Number(a.n ?? 0);
    out.total += n;
    for (const m of modos) {
      const k = classifica(s, m, a);
      out[m.id][k] = (out[m.id][k] ?? 0) + n;
    }
  }
  return out;
}

/** Linhas da legenda com contagem > 0, somando várias contagens do mesmo modo. */
export const linhasDoModo = (modo, contagens) => modo.legenda
  .map(({ key, label, curto, color }) => ({ grupo: key, label, curto, color, n: contagens.reduce((a, c) => a + (c[modo.id][key] ?? 0), 0) }))
  .filter((l) => l.n > 0);

/**
 * Camada de pontos do IAT com chave de classificação. `modos[i].prop` é a
 * propriedade que o modo grava no ponto (a cor do círculo lê dela);
 * `props(a)` normaliza os atributos para o tooltip.
 */
export function iatPontosLayer({ id, sigla, sistemas, modos, attribution, load, tooltip, ...rest }) {
  const SRC_VEC = `dg-${sigla}`;
  const PT = `dg-${sigla}-pt`;
  // Fatias de imagem por sistema: o máximo entre os modos (fatia sobrando
  // num modo recebe um where vazio).
  const fatias = sistemas.flatMap((s) => {
    const n = Math.max(...modos.map((m) => fatiasExport(s.servico, camadasExport(s, m)).length));
    return Array.from({ length: n }, (_, k) => ({ s, k, id: `dg-${sigla}-${s.key}${k ? `-${k}` : ''}` }));
  });
  let modo = modos[0];
  let ctxRef = null;
  let aborter = null;
  let truncado = false;

  const corCirculo = (m) => ['match', ['get', m.prop], ...m.legenda.flatMap((g) => [g.key, g.color]), '#94a3b8'];
  const tiles = ({ s, k }, m) => [fatiasExport(s.servico, camadasExport(s, m))[k] ?? exportTileUrl(s.servico, VAZIO)];

  function aplicaModo(map) {
    for (const f of fatias) map.getSource(f.id)?.setTiles(tiles(f, modo));
    if (map.getLayer(PT)) map.setPaintProperty(PT, 'circle-color', corCirculo(modo));
  }

  async function pontosDaVista(bounds, signal) {
    const geo = {
      geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true', resultRecordCount: String(MAX_POR_VISTA),
    };
    const respostas = await Promise.all(sistemas.map((s) => query(s.servico, s.where, s.fields, geo, signal)));
    const features = respostas.flatMap((j, k) => j.features.map((f, i) => {
      const s = sistemas[k];
      const a = limpa(f.attributes);
      const classes = Object.fromEntries(modos.map((m) => [m.prop, classifica(s, m, a)]));
      return point(f.geometry?.x, f.geometry?.y, { ...s.props(a), ...classes }, `${s.key}-${i}`);
    })).filter(Boolean);
    return { features, truncado: respostas.some((j) => j.exceededTransferLimit) };
  }

  const onMove = () => {
    const map = ctxRef?.map;
    if (!map || map.getZoom() < VEC_MINZOOM) return;
    aborter?.abort();
    aborter = new AbortController();
    pontosDaVista(map.getBounds(), aborter.signal)
      .then((r) => {
        if (!ctxRef) return;
        ctxRef.setData(SRC_VEC, fc(r.features));
        if (r.truncado !== truncado) {
          truncado = r.truncado;
          ctxRef.refreshPanel();
        }
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') console.warn(`[maplibre:${id}]`, err);
      });
  };

  return defineLayer({
    id,
    ...rest,
    sources: {
      ...Object.fromEntries(fatias.map((f, i) => [f.id, {
        type: 'raster', tiles: tiles(f, modo), tileSize: 512, ...(i === 0 ? { attribution } : {}),
      }])),
      [SRC_VEC]: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      // Layer adicionado depois fica por cima: fatias de baixo (resto) primeiro.
      ...[...fatias].reverse().map((f) => ({
        id: `${f.id}-img`, type: 'raster', source: f.id, maxzoom: VEC_MINZOOM,
        paint: { 'raster-fade-duration': 0 },
      })),
      {
        id: PT,
        type: 'circle',
        source: SRC_VEC,
        minzoom: VEC_MINZOOM,
        paint: {
          'circle-color': corCirculo(modo),
          'circle-radius': ['interpolate', ['linear'], ['zoom'], VEC_MINZOOM, 3.5, 16, 6],
          'circle-stroke-color': 'rgba(5,8,13,0.8)',
          'circle-stroke-width': 0.8,
        },
      },
    ],
    interactive: [PT],
    load,
    onEnable(ctx) {
      ctxRef = ctx;
      aplicaModo(ctx.map); // o chip pode ter mudado com a camada desligada
      ctx.map.off('moveend', onMove);
      ctx.map.on('moveend', onMove);
      onMove();
    },
    onDisable(ctx) {
      ctx.map.off('moveend', onMove);
      aborter?.abort();
      ctxRef = null;
    },
    tooltip,
    rowControls: () => ({
      chips: modos.map((m) => ({ id: `modo-${m.id}`, label: m.chip, active: m === modo })),
      legend: [
        ...modo.legenda.map(({ label, color }) => ({ label, color })),
        ...(truncado ? [{ label: `Vista com mais de ${fmtInt(MAX_POR_VISTA)} pontos: aproxime`, color: '#64748b' }] : []),
      ],
    }),
    onChip(chipId, ctx) {
      const novo = modos.find((m) => `modo-${m.id}` === chipId);
      if (!novo || novo === modo) return;
      modo = novo;
      aplicaModo(ctx.map);
    },
  });
}
