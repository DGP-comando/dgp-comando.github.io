// src/maplibre/layers/outorgas.js
//
// Outorgas de uso da água do IAT, ao vivo do ArcGIS Server do GeoPR (nada
// armazenado aqui). O IAT emite pelo SIGARH desde 2023; o legado CRH ainda
// tem captações, lançamentos de efluentes e aproveitamentos hidrelétricos
// vigentes, então as quatro bases entram juntas (SISTEMAS).
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
  { grupo: 'sup', label: 'Captação superficial', curto: 'Capt. superficial', color: '#22d3ee' },
  { grupo: 'sub', label: 'Captação subterrânea', curto: 'Capt. subterrânea', color: '#a78bfa' },
  { grupo: 'efl', label: 'Lançamento de efluentes', curto: 'Efluentes', color: '#f97316' },
  { grupo: 'hid', label: 'Aproveitamento hidrelétrico', curto: 'Hidrelétricas', color: '#facc15' },
  { grupo: 'obr', label: 'Obras e intervenções', curto: 'Obras/interv.', color: '#94a3b8' },
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
  if (t.startsWith('Aproveitamento hidrelétrico')) return 'hid';
  return 'obr';
}

// CRH: só captação; poço é subterrânea, rio e mina (nascente) superficial.
export const grupoCrh = (manancial) => (String(manancial ?? '').toUpperCase().startsWith('PO') ? 'sub' : 'sup');

/** O GeoPR devolve UTF-8 quebrado em alguns campos ("Aqu�­fero"): refaz o par C3 xx. */
export const consertaUtf8 = (s) => (typeof s === 'string'
  ? s.replace(/�([\u0080-¿])/g, (_, c) => String.fromCharCode(0xC0 + c.charCodeAt(0) - 0x80))
  : s);

const limpa = (attrs) => Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, consertaUtf8(v)]));
const positivo = (v) => (Number(v) > 0 ? Number(v) : null);

export function sigarhProps(a) {
  const vazoes = MESES.map((m) => Number(a[`vlr_vazao_capt_lanc_${m}`])).filter((v) => v > 0);
  const corpo = [a.nm_tipo_corpo_hidrico, a.nm_corpo_hidrico_popular].filter(Boolean).join(' ');
  return {
    sistema: 'SIGARH',
    grupo: grupoSigarh(a.nm_tipo_interferencia),
    tipo: a.nm_tipo_interferencia,
    finalidade: String(a.desc_finalidades ?? '').split(',').filter(Boolean).join(', '),
    usuario: a.nm_tipo_usuario,
    corpo: corpo || a.nm_aquifero,
    documento: a.nm_tipo_documento,
    portaria: a.nr_portaria,
    situacao: a.st_portaria,
    vencimento: a.dt_vencimento,
    municipio: a.nm_municipio_emp,
    bacia: a.nm_bacia_hidrografica,
    vazao: vazoes.length ? Math.max(...vazoes) : null,
  };
}

// Campos comuns às três bases do CRH.
const crhBase = (a) => ({
  sistema: 'CRH',
  usuario: a.uso,
  documento: a.modalidade,
  portaria: a.portaria,
  situacao: a.condicao,
  vencimento: a.vencimento,
  municipio: a.municipio,
  bacia: a.bac_nome,
});

export function crhProps(a) {
  const grupo = grupoCrh(a.tipo_manancial);
  return {
    ...crhBase(a),
    grupo,
    tipo: `Captação ${grupo === 'sub' ? 'subterrânea' : 'superficial'} (${String(a.tipo_manancial ?? '').toLowerCase()})`,
    finalidade: a.finalidades || a.finalidade_principal,
    corpo: a.rio_nome || a.aqu_descricao,
    vazao: positivo(a.vazao_outorgada__m3_h_),
  };
}

export function crhEfluenteProps(a) {
  return {
    ...crhBase(a),
    grupo: 'efl',
    tipo: 'Lançamento de efluentes',
    finalidade: [a.tpo_nome, a.atv_nome].filter(Boolean).join(' · '),
    corpo: a.rio_nome,
    vazao: positivo(a.eflo_out_vazao__m3_h_),
  };
}

export function crhHidreletricoProps(a) {
  return {
    ...crhBase(a),
    grupo: 'hid',
    tipo: 'Aproveitamento hidrelétrico',
    empreendimento: a.localidade,
    corpo: a.rio_nome,
    potencia: positivo(a.potencial_instalado__mww_),
  };
}

const symbol = (cor) => {
  const h = cor.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return { type: 'esriSMS', style: 'esriSMSCircle', color: [...rgb, 235], size: 4, outline: { color: [5, 8, 13, 200], width: 0.5 } };
};
const simples = (grupo) => ({ type: 'simple', symbol: symbol(COR[grupo]) });

/** URL de tile do MapServer/export (MapLibre troca {bbox-epsg-3857}). */
export function exportTileUrl(servico, where, renderer) {
  const dynamicLayers = [{ id: 0, source: { type: 'mapLayer', mapLayerId: 0 }, definitionExpression: where, drawingInfo: { renderer } }];
  const qs = new URLSearchParams({
    bboxSR: '3857', imageSR: '3857', size: '512,512', format: 'png32', transparent: 'true', f: 'image',
    dynamicLayers: JSON.stringify(dynamicLayers),
  });
  return `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}&${qs}`;
}

const SIGARH_TIPOS = ['Captação superficial', 'Captação subterrânea (Poço tubular)', 'Captação subterrânea (Poço cacimba)',
  'Lançamento de efluentes', 'Aproveitamento hidrelétrico com barragem/soleira', 'Aproveitamento hidrelétrico sem barragem/soleira'];

export const SISTEMAS = Object.freeze([
  {
    key: 'sigarh',
    servico: 'outorgas_sigarh',
    where: SIGARH_WHERE,
    props: sigarhProps,
    mun: { campo: 'cod_municipio_emp', texto: true },
    porTipo: { campo: 'nm_tipo_interferencia', grupo: grupoSigarh },
    fields: ['nm_tipo_interferencia', 'desc_finalidades', 'nm_tipo_usuario', 'nm_corpo_hidrico_popular',
      'nm_tipo_corpo_hidrico', 'nm_aquifero', 'nm_tipo_documento', 'nr_portaria', 'st_portaria', 'dt_vencimento',
      'nm_municipio_emp', 'nm_bacia_hidrografica', ...MESES.map((m) => `vlr_vazao_capt_lanc_${m}`)],
    renderer: {
      type: 'uniqueValue',
      field1: 'nm_tipo_interferencia',
      defaultSymbol: symbol(COR.obr),
      uniqueValueInfos: SIGARH_TIPOS.map((value) => ({ value, symbol: symbol(COR[grupoSigarh(value)]) })),
    },
  },
  {
    key: 'crh-captacao',
    servico: 'out_captacao_crh',
    where: CRH_WHERE,
    props: crhProps,
    mun: { campo: 'mun_ibge' },
    porTipo: { campo: 'tipo_manancial', grupo: grupoCrh },
    fields: ['uso', 'finalidades', 'finalidade_principal', 'tipo_manancial', 'rio_nome', 'aqu_descricao',
      'vazao_outorgada__m3_h_', 'portaria', 'modalidade', 'condicao', 'vencimento', 'municipio', 'bac_nome'],
    renderer: {
      type: 'uniqueValue',
      field1: 'tipo_manancial',
      defaultSymbol: symbol(COR.sup),
      uniqueValueInfos: [{ value: 'POÇO', symbol: symbol(COR.sub) }],
    },
  },
  {
    key: 'crh-efluentes',
    servico: 'out_efluentes_crh',
    where: CRH_WHERE,
    props: crhEfluenteProps,
    mun: { campo: 'mun_codigo' },
    grupo: 'efl',
    fields: ['uso', 'tpo_nome', 'atv_nome', 'rio_nome', 'eflo_out_vazao__m3_h_', 'portaria', 'modalidade', 'condicao',
      'vencimento', 'municipio', 'bac_nome'],
    renderer: simples('efl'),
  },
  {
    key: 'crh-hidreletrico',
    servico: 'out_aproveitamento_hidreletrico',
    where: CRH_WHERE,
    props: crhHidreletricoProps,
    mun: { campo: 'mun_ibge' },
    grupo: 'hid',
    fields: ['uso', 'localidade', 'rio_nome', 'potencial_instalado__mww_', 'portaria', 'modalidade', 'condicao',
      'vencimento', 'municipio', 'bac_nome'],
    renderer: simples('hid'),
  },
]);

export function outorgaTooltipHtml(p, now = Date.now()) {
  const venc = Number(p.vencimento);
  const vencida = Number.isFinite(venc) && venc > 0 && venc < now;
  return tipCard({
    icon: '💧',
    title: p.tipo || 'Outorga de uso da água',
    subtitle: `IAT · ${p.sistema}${p.municipio ? ` · ${p.municipio}` : ''}`,
    badge: vencida ? { text: 'VENCIDA', tone: 'warn' } : { text: String(p.situacao ?? ''), tone: 'ok' },
    rows: [
      ['Empreendimento', p.empreendimento],
      ['Finalidade', p.finalidade],
      ['Usuário', p.usuario],
      ['Corpo hídrico', p.corpo],
      ['Bacia', p.bacia],
      ['Vazão', p.vazao ? `${fmtNum(p.vazao, p.vazao < 10 ? 2 : 0)} m³/h${p.sistema === 'SIGARH' ? ' (máx. mensal)' : ''}` : ''],
      ['Potência', p.potencia ? fmtNum(p.potencia, 2, 'MW') : ''],
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

async function pontosDaVista(bounds, signal) {
  const geo = {
    geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'true', resultRecordCount: String(MAX_POR_VISTA),
  };
  const respostas = await Promise.all(SISTEMAS.map((s) => query(s.servico, s.where, s.fields, geo, signal)));
  const features = respostas.flatMap((j, k) => j.features.map((f, i) => point(
    f.geometry?.x, f.geometry?.y, SISTEMAS[k].props(limpa(f.attributes)), `${SISTEMAS[k].key}-${i}`,
  ))).filter(Boolean);
  return { features, truncado: respostas.some((j) => j.exceededTransferLimit) };
}

const COUNT_STAT = JSON.stringify([{ statisticType: 'count', onStatisticField: 'objectid', outStatisticFieldName: 'n' }]);

/** Cláusula `campo IN (...)` com os códigos IBGE (só dígitos: nada de texto livre na consulta). */
export function filtroMunicipios({ campo, texto }, ibges) {
  const cods = [...new Set(ibges.map(String).filter((c) => /^\d{7}$/.test(c)))];
  if (!cods.length) return null;
  return `${campo} IN (${cods.map((c) => (texto ? `'${c}'` : c)).join(',')})`;
}

/** Contagens de um sistema por grupo da legenda: {sup: n, sub: n, ...}. */
async function contagemSistema(s, filtroMun) {
  const where = `(${s.where}) AND ${filtroMun}`;
  if (!s.porTipo) {
    const j = await query(s.servico, where, [], { returnCountOnly: 'true' });
    return { [s.grupo]: j.count ?? 0 };
  }
  const j = await query(s.servico, where, [], { groupByFieldsForStatistics: s.porTipo.campo, outStatistics: COUNT_STAT });
  const out = {};
  for (const { attributes: a } of j.features ?? []) {
    const g = s.porTipo.grupo(consertaUtf8(a[s.porTipo.campo]));
    out[g] = (out[g] ?? 0) + Number(a.n ?? 0);
  }
  return out;
}

/**
 * Outorgas vigentes por tipo nos municípios (ficha municipal e regional), ao
 * vivo. Devolve {total, linhas: [{grupo, label, color, n}], sigarh, crh} ou
 * null se o GeoPR não responder (a ficha só omite a seção).
 */
export async function getOutorgasMunicipios(ibges) {
  try {
    const partes = await Promise.all(SISTEMAS.map((s) => {
      const f = filtroMunicipios(s.mun, ibges);
      return f ? contagemSistema(s, f) : {};
    }));
    const soma = (p) => Object.values(p).reduce((a, b) => a + b, 0);
    const linhas = OUTORGA_LEGENDA
      .map(({ grupo, label, curto, color }) => ({ grupo, label, curto, color, n: partes.reduce((a, p) => a + (p[grupo] ?? 0), 0) }))
      .filter((l) => l.n > 0);
    const sigarh = soma(partes[0]);
    const crh = partes.slice(1).reduce((a, p) => a + soma(p), 0);
    return { total: sigarh + crh, linhas, sigarh, crh };
  } catch (err) {
    console.warn('[DataGeo:ficha] outorgas IAT indisponíveis:', err?.message);
    return null;
  }
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

const imgSource = (s) => `dg-outorgas-${s.key}`;

export const outorgasLayer = defineLayer({
  id: 'datageo-outorgas',
  name: 'Outorgas de uso da água (IAT)',
  category: 'Recursos hídricos',
  icon: '💧',
  source: 'IAT · SIGARH + CRH',
  sources: {
    ...Object.fromEntries(SISTEMAS.map((s, i) => [imgSource(s), {
      type: 'raster', tiles: [exportTileUrl(s.servico, s.where, s.renderer)], tileSize: 512,
      ...(i === 0 ? { attribution: 'IAT/GeoPR' } : {}),
    }])),
    [SRC_VEC]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    ...SISTEMAS.map((s) => ({
      id: `${imgSource(s)}-img`, type: 'raster', source: imgSource(s), maxzoom: VEC_MINZOOM,
      paint: { 'raster-fade-duration': 0 },
    })),
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
    const n = await Promise.all(SISTEMAS.map((s) => query(s.servico, s.where, [], { returnCountOnly: 'true' })
      .then((j) => j.count ?? 0)));
    const crh = n.slice(1).reduce((a, b) => a + b, 0);
    return { count: n[0] + crh, info: `SIGARH ${fmtInt(n[0])} · CRH ${fmtInt(crh)}` };
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
