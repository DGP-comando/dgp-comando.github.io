// src/maplibre/layers/outorgas.js
//
// Outorgas de uso da água do IAT, ao vivo do ArcGIS Server do GeoPR (nada
// armazenado aqui). O IAT emite pelo SIGARH desde 2023; o legado CRH ainda
// tem outorgas de captação vigentes, então as duas bases entram juntas.
//   - longe: imagens do MapServer/export (fazem o papel do WMS), com símbolo
//     por tipo via dynamicLayers para casar com a legenda;
//   - perto (VEC_MINZOOM+): pontos da vista pelo FeatureServer (GeoJSON), para
//     o tooltip.
// Nome do requerente/razão social fica de fora (pessoa física, LGPD).

import { EMPTY_FC, defineLayer, fc, fmtDate, fmtInt, fmtNum, point, tipCard } from '../kit.js';

const BASE = 'https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES';
const VEC_MINZOOM = 12;
const MAX_POR_VISTA = 2000; // maxRecordCount dos serviços
const SRC_VEC = 'dg-outorgas';
const PT = 'dg-outorgas-pt';

export const OUTORGA_LEGENDA = Object.freeze([
  { grupo: 'sup', label: 'Captação superficial', color: '#22d3ee' },
  { grupo: 'sub', label: 'Captação subterrânea', color: '#a78bfa' },
  { grupo: 'efl', label: 'Lançamento de efluentes', color: '#f97316' },
  { grupo: 'obr', label: 'Obras e intervenções', color: '#94a3b8' },
]);
const COR = Object.fromEntries(OUTORGA_LEGENDA.map((g) => [g.grupo, g.color]));

// Vigentes: deferidas (ou em renovação/regularização) e só documentos que
// autorizam uso; ficam fora anuência de perfuração, cancelamentos, revogações.
const SIGARH_WHERE = "st_portaria IN ('DEFERIDA','EM RENOVAÇÃO','EM REGULARIZAÇÃO') AND nm_tipo_documento IN "
  + "('Portaria de outorga de direito','Portaria de outorga prévia','Declaração de uso independente de outorga',"
  + "'Declaração de interferência independente de outorga','Portaria de revigoramento')";
const CRH_WHERE = "condicao IN ('VIGENTE','EM RENOVAÇÃO')";

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function grupoSigarh(tipo) {
  const t = String(tipo ?? '');
  if (t.startsWith('Captação subterrânea')) return 'sub';
  if (t === 'Captação superficial') return 'sup';
  if (t === 'Lançamento de efluentes') return 'efl';
  return 'obr';
}

// CRH: só captação; poço é subterrânea, rio e mina (nascente) superficial.
export const grupoCrh = (manancial) => (String(manancial ?? '').toUpperCase().startsWith('PO') ? 'sub' : 'sup');

/** O SIGARH devolve UTF-8 quebrado em alguns campos ("Aqu�­fero"): refaz o par C3 xx. */
export const consertaUtf8 = (s) => (typeof s === 'string'
  ? s.replace(/�([\u0080-¿])/g, (_, c) => String.fromCharCode(0xC0 + c.charCodeAt(0) - 0x80))
  : s);

const symbol = (cor) => {
  const h = cor.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return { type: 'esriSMS', style: 'esriSMSCircle', color: [...rgb, 235], size: 4, outline: { color: [5, 8, 13, 200], width: 0.5 } };
};

/** URL de tile do MapServer/export (MapLibre troca {bbox-epsg-3857}). */
export function exportTileUrl(servico, where, renderer) {
  const dynamicLayers = [{ id: 0, source: { type: 'mapLayer', mapLayerId: 0 }, definitionExpression: where, drawingInfo: { renderer } }];
  const qs = new URLSearchParams({
    bboxSR: '3857', imageSR: '3857', size: '512,512', format: 'png32', transparent: 'true', f: 'image',
    dynamicLayers: JSON.stringify(dynamicLayers),
  });
  return `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}&${qs}`;
}

const SIGARH_TILES = exportTileUrl('outorgas_sigarh', SIGARH_WHERE, {
  type: 'uniqueValue',
  field1: 'nm_tipo_interferencia',
  defaultSymbol: symbol(COR.obr),
  uniqueValueInfos: [
    ['Captação superficial', 'sup'], ['Captação subterrânea (Poço tubular)', 'sub'],
    ['Captação subterrânea (Poço cacimba)', 'sub'], ['Lançamento de efluentes', 'efl'],
  ].map(([value, g]) => ({ value, symbol: symbol(COR[g]) })),
});
const CRH_TILES = exportTileUrl('out_captacao_crh', CRH_WHERE, {
  type: 'uniqueValue',
  field1: 'tipo_manancial',
  defaultSymbol: symbol(COR.sup),
  uniqueValueInfos: [{ value: 'POÇO', symbol: symbol(COR.sub) }],
});

const SIGARH_FIELDS = ['nm_tipo_interferencia', 'desc_finalidades', 'nm_tipo_usuario', 'nm_corpo_hidrico_popular',
  'nm_tipo_corpo_hidrico', 'nm_aquifero', 'nm_tipo_documento', 'nr_portaria', 'st_portaria', 'dt_vencimento',
  'nm_municipio_emp', 'nm_bacia_hidrografica', ...MESES.map((m) => `vlr_vazao_capt_lanc_${m}`)];
const CRH_FIELDS = ['uso', 'finalidades', 'finalidade_principal', 'tipo_manancial', 'rio_nome', 'aqu_descricao',
  'vazao_outorgada__m3_h_', 'portaria', 'modalidade', 'condicao', 'vencimento', 'municipio', 'bac_nome'];

export function sigarhProps(a) {
  const vazoes = MESES.map((m) => Number(a[`vlr_vazao_capt_lanc_${m}`])).filter((v) => v > 0);
  const corpo = [a.nm_tipo_corpo_hidrico, a.nm_corpo_hidrico_popular].filter(Boolean).join(' ');
  return {
    sistema: 'SIGARH',
    grupo: grupoSigarh(a.nm_tipo_interferencia),
    tipo: a.nm_tipo_interferencia,
    finalidade: String(a.desc_finalidades ?? '').split(',').filter(Boolean).join(', '),
    usuario: a.nm_tipo_usuario,
    corpo: corpo || consertaUtf8(a.nm_aquifero),
    documento: a.nm_tipo_documento,
    portaria: a.nr_portaria,
    situacao: a.st_portaria,
    vencimento: a.dt_vencimento,
    municipio: a.nm_municipio_emp,
    bacia: a.nm_bacia_hidrografica,
    vazao: vazoes.length ? Math.max(...vazoes) : null,
  };
}

export function crhProps(a) {
  const grupo = grupoCrh(a.tipo_manancial);
  return {
    sistema: 'CRH',
    grupo,
    tipo: `Captação ${grupo === 'sub' ? 'subterrânea' : 'superficial'} (${String(a.tipo_manancial ?? '').toLowerCase()})`,
    finalidade: a.finalidades || a.finalidade_principal,
    usuario: a.uso,
    corpo: a.rio_nome || a.aqu_descricao,
    documento: a.modalidade,
    portaria: a.portaria,
    situacao: a.condicao,
    vencimento: a.vencimento,
    municipio: a.municipio,
    bacia: a.bac_nome,
    vazao: Number(a.vazao_outorgada__m3_h_) > 0 ? Number(a.vazao_outorgada__m3_h_) : null,
  };
}

export function outorgaTooltipHtml(p, now = Date.now()) {
  const venc = Number(p.vencimento);
  const vencida = Number.isFinite(venc) && venc > 0 && venc < now;
  return tipCard({
    icon: '💧',
    title: p.tipo || 'Outorga de uso da água',
    subtitle: `IAT · ${p.sistema}${p.municipio ? ` · ${p.municipio}` : ''}`,
    badge: vencida ? { text: 'VENCIDA', tone: 'warn' } : { text: String(p.situacao ?? ''), tone: 'ok' },
    rows: [
      ['Finalidade', p.finalidade],
      ['Usuário', p.usuario],
      ['Corpo hídrico', p.corpo],
      ['Bacia', p.bacia],
      ['Vazão', p.vazao ? `${fmtNum(p.vazao, p.vazao < 10 ? 2 : 0)} m³/h${p.sistema === 'SIGARH' ? ' (máx. mensal)' : ''}` : ''],
      ['Documento', p.documento],
      ['Portaria', p.portaria],
      ['Validade', venc > 0 ? fmtDate(venc) : ''],
    ],
    source: 'IAT · GeoPR (SIGARH + CRH), consulta ao vivo',
  });
}

async function query(servico, where, outFields, extra = {}, signal) {
  const qs = new URLSearchParams({ where, outFields: outFields.join(','), f: 'json', ...extra });
  const r = await fetch(`${BASE}/${servico}/FeatureServer/0/query`, {
    method: 'POST', body: qs, signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) throw new Error(`${servico} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${servico}: ${j.error.message}`);
  return j;
}

const count = (servico, where) => query(servico, where, [], { returnCountOnly: 'true' }).then((j) => j.count ?? 0);

async function pontosDaVista(bounds, signal) {
  const geo = {
    geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'true', resultRecordCount: String(MAX_POR_VISTA),
  };
  const [sig, crh] = await Promise.all([
    query('outorgas_sigarh', SIGARH_WHERE, SIGARH_FIELDS, geo, signal),
    query('out_captacao_crh', CRH_WHERE, CRH_FIELDS, geo, signal),
  ]);
  const feats = (j, props, sis) => j.features.map((f, i) => point(f.geometry?.x, f.geometry?.y, props(f.attributes), `${sis}${i}`));
  return {
    features: [...feats(sig, sigarhProps, 's'), ...feats(crh, crhProps, 'c')].filter(Boolean),
    truncado: Boolean(sig.exceededTransferLimit || crh.exceededTransferLimit),
  };
}

let ctxRef = null;
let aborter = null;
let truncado = false;

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
      if (err?.name !== 'AbortError') console.warn('[maplibre:datageo-outorgas]', err);
    });
};

const raster = (id, source) => ({
  id, type: 'raster', source, maxzoom: VEC_MINZOOM, paint: { 'raster-fade-duration': 0 },
});

export const outorgasLayer = defineLayer({
  id: 'datageo-outorgas',
  name: 'Outorgas de uso da água (IAT)',
  category: 'Ambiente',
  icon: '💧',
  source: 'IAT · SIGARH + CRH',
  sources: {
    'dg-outorgas-sigarh': { type: 'raster', tiles: [SIGARH_TILES], tileSize: 512, attribution: 'IAT/GeoPR' },
    'dg-outorgas-crh': { type: 'raster', tiles: [CRH_TILES], tileSize: 512 },
    [SRC_VEC]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    raster('dg-outorgas-sigarh-img', 'dg-outorgas-sigarh'),
    raster('dg-outorgas-crh-img', 'dg-outorgas-crh'),
    {
      id: PT,
      type: 'circle',
      source: SRC_VEC,
      minzoom: VEC_MINZOOM,
      paint: {
        'circle-color': ['match', ['get', 'grupo'], ...OUTORGA_LEGENDA.flatMap((g) => [g.grupo, g.color]), COR.obr],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], VEC_MINZOOM, 3.5, 16, 6],
        'circle-stroke-color': 'rgba(5,8,13,0.8)',
        'circle-stroke-width': 0.8,
      },
    },
  ],
  interactive: [PT],
  async load() {
    const [s, c] = await Promise.all([count('outorgas_sigarh', SIGARH_WHERE), count('out_captacao_crh', CRH_WHERE)]);
    return { count: s + c, info: `SIGARH ${fmtInt(s)} · CRH ${fmtInt(c)}` };
  },
  onEnable(ctx) {
    ctxRef = ctx;
    ctx.map.off('moveend', onMove);
    ctx.map.on('moveend', onMove);
    onMove();
  },
  onDisable(ctx) {
    ctx.map.off('moveend', onMove);
    aborter?.abort();
    ctxRef = null;
  },
  tooltip: (p) => outorgaTooltipHtml(p),
  rowControls: () => ({
    legend: [
      ...OUTORGA_LEGENDA.map(({ label, color }) => ({ label, color })),
      ...(truncado ? [{ label: `Vista com mais de ${fmtInt(MAX_POR_VISTA)} pontos: aproxime`, color: '#64748b' }] : []),
    ],
  }),
});

export default [outorgasLayer];
