// src/maplibre/layers/transporte.js
//
// Grupo TRANSPORTE do protótipo (categoria Infraestrutura), portado do app:
//   - datageo-ferrovias      (src/data/datageoLayers.js)
//   - datageo-rodovias       (src/data/datageoRodovias.js)
//   - datageo-estradas       (src/data/datageoEstradas.js + slicedLineLayer.js)
//   - datageo-estradas-conveniadas (src/data/datageoEstradasConveniadas.js)
// Cores, larguras (px, como as ground polylines do app) e tetos de escala
// seguem o código Cesium. Todas as quatro têm tooltip de hover (tipCard): as
// linhas finas respondem por uma faixa invisível de 12 px (layer `-hit`), e o
// município sob o cursor vem do preenchimento dos municípios (cursorContext).

import { dgFetchData } from '../../data/datageoClient.js';
import { GRUPOS } from '../../data/estradasConveniadasTooltip.js';
import { lineStringsFromGeojson } from '../../data/geojsonLines.js';
import { createSlicedLinesLayer } from '../slicedLines.js';
import { EMPTY_FC, defineLayer, fc, fmtCoord, fmtNum, tipCard } from '../kit.js';

const LINE_LAYOUT = Object.freeze({ 'line-cap': 'round', 'line-join': 'round' });

/** Faixa invisível e larga só para o pick das linhas finas (mesma fonte/filtro). */
export const HIT_PAINT = Object.freeze({ 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 12 });

// ------------------------------------------------------------------ cursor

// O anfitrião chama tooltip(props, feature, ctx) sem a posição do mouse. As
// camadas daqui guardam o último mousemove do mapa (um ouvinte por mapa) para
// dizer a coordenada e o município sob o cursor. O ouvinte roda antes do
// requestAnimationFrame em que o anfitrião monta o tooltip.
const cursors = new WeakMap();

/** Liga (uma vez por mapa) o rastreio do cursor; devolve o estado vivo. */
export function trackCursor(map) {
  if (!map?.on) return null;
  let st = cursors.get(map);
  if (!st) {
    st = { point: null, lngLat: null };
    map.on('mousemove', (e) => {
      st.point = e.point;
      st.lngLat = e.lngLat;
    });
    map.on('mouseout', () => {
      st.point = null;
      st.lngLat = null;
    });
    cursors.set(map, st);
  }
  return st;
}

/**
 * {lat, lon, municipio, ibge} do cursor (campos null quando não se sabe). O
 * município vem do preenchimento da camada de municípios (ligada quase sempre).
 */
export function cursorContext(ctx) {
  const map = ctx?.map;
  const st = map ? cursors.get(map) : null;
  const out = { lat: null, lon: null, municipio: null, ibge: null };
  if (!st?.lngLat) return out;
  out.lat = st.lngLat.lat;
  out.lon = st.lngLat.lng;
  try {
    if (st.point && map.getLayer?.('dg-municipios-fill')) {
      const m = map.queryRenderedFeatures([st.point.x, st.point.y], { layers: ['dg-municipios-fill'] })[0];
      out.municipio = m?.properties?.NM_MUN ?? null;
      out.ibge = m?.properties?.CD_MUN ?? null;
    }
  } catch {
    // mapa trocando de estilo: fica sem município
  }
  return out;
}

const municipioRow = (cur) => ['Município', cur.municipio ? (cur.ibge ? `${cur.municipio} (IBGE ${cur.ibge})` : cur.municipio) : null];
const coordRow = (cur) => ['Coordenada', fmtCoord(cur.lat, cur.lon)];

// ------------------------------------------------------------------ extensão

const R_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Comprimento (km) de uma LineString/MultiLineString em graus (haversine). */
export function lineKm(geometry) {
  const parts = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  let km = 0;
  for (const line of parts) {
    for (let k = 1; k < (line?.length ?? 0); k += 1) {
      const [lon1, lat1] = line[k - 1];
      const [lon2, lat2] = line[k];
      const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2
        + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
      km += 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
    }
  }
  return km;
}

/** Soma de km por chave (nome, sigla); chaves vazias ficam de fora. */
export function kmPorChave(features, keyOf) {
  const out = new Map();
  for (const f of features ?? []) {
    const km = lineKm(f?.geometry);
    for (const key of keyOf(f?.properties ?? {})) {
      if (key) out.set(key, (out.get(key) ?? 0) + km);
    }
  }
  return out;
}

const fmtKm = (km) => (Number.isFinite(km) && km > 0 ? fmtNum(km, km < 10 ? 1 : 0, 'km') : '');
const splitList = (v) => String(v ?? '').split(';').map((x) => x.trim()).filter(Boolean);

async function fetchJson(url, fetcher = fetch) {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ ferrovias

export const FERROVIAS_URL = '/data/ferrovias-pr.geojson';

const USO_FERROVIA = Object.freeze({
  main: 'Linha principal',
  branch: 'Ramal',
  industrial: 'Ramal industrial / pátio',
  freight: 'Linha de carga',
});

/**
 * Tooltip de um trecho de ferrovia (OSM: name, operator, usage). `kmLinha` =
 * extensão da linha inteira (mesmo nome) no PR; `cur` = cursorContext.
 */
export function ferroviaTooltip(p, { kmLinha = null, cur = {} } = {}) {
  const operadoras = splitList(p?.operator);
  return tipCard({
    icon: '🚆',
    title: p?.name || 'Ferrovia sem nome no OSM',
    subtitle: [USO_FERROVIA[p?.usage] ?? 'Ferrovia', cur.municipio].filter(Boolean).join(' · '),
    rows: [
      [operadoras.length > 1 ? 'Operadoras' : 'Operadora', operadoras.join(', ')],
      ['Uso', USO_FERROVIA[p?.usage] ?? (p?.usage || null)],
      ['Extensão da linha no PR', fmtKm(kmLinha)],
      ['Segmento', fmtKm(p?.km)],
      municipioRow(cur),
      coordRow(cur),
    ],
    source: 'OpenStreetMap · DataGeo PR',
  });
}

export const ferroviasLayer = (() => {
  let kmPorNome = new Map();
  return defineLayer({
  id: 'datageo-ferrovias',
  name: 'Ferrovias',
  category: 'Infraestrutura',
  icon: '🚆',
  source: 'OpenStreetMap',
  sources: { 'dg-ferrovias': { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: 'dg-ferrovias-line',
      type: 'line',
      source: 'dg-ferrovias',
      layout: LINE_LAYOUT,
      paint: { 'line-color': '#f59e0b', 'line-opacity': 0.65, 'line-width': 2 },
    },
    { id: 'dg-ferrovias-hit', type: 'line', source: 'dg-ferrovias', paint: HIT_PAINT },
  ],
  interactive: ['dg-ferrovias-hit'],
  onEnable: (ctx) => trackCursor(ctx.map),
  // O app conta as entidades do GeoJsonDataSource: uma por feição.
  async load(ctx) {
    trackCursor(ctx.map);
    const geo = await fetchJson(FERROVIAS_URL);
    for (const f of geo.features ?? []) {
      if (f?.properties) f.properties.km = Math.round(lineKm(f.geometry) * 100) / 100;
    }
    kmPorNome = kmPorChave(geo.features, (p) => [p.name]);
    ctx.setData('dg-ferrovias', geo);
    return geo.features?.length ?? 0;
  },
  tooltip: (p, _f, ctx) => ferroviaTooltip(p, { kmLinha: kmPorNome.get(p?.name), cur: cursorContext(ctx) }),
  });
})();

// ------------------------------------------------------------------ rodovias

export const RODOVIAS_FED_URL = '/data/rodovias-federais-pr.geojson';
export const RODOVIAS_EST_URL = '/data/rodovias-estaduais-pr.geojson';

export const RODOVIAS_STYLE = Object.freeze({
  federais: Object.freeze({ color: '#fbbf24', opacity: 0.85, width: 2.4, label: 'Federais (BR)' }),
  estaduais: Object.freeze({ color: '#7dd3fc', opacity: 0.6, width: 1.6, label: 'Estaduais (PR/PRC)' }),
});

const rodoviaPaint = (st) => ({ 'line-color': st.color, 'line-opacity': st.opacity, 'line-width': st.width });

/** Esfera e órgão de uma sigla: BR (DNIT), PRC (coincidente, DER-PR), PR (DER-PR). */
export function jurisdicaoDe(ref) {
  const r = String(ref ?? '').trim().toUpperCase();
  if (r.startsWith('BR')) return { esfera: 'Federal', orgao: 'DNIT', tipo: 'Rodovia federal' };
  if (r.startsWith('PRC')) return { esfera: 'Estadual (coincidente com diretriz federal)', orgao: 'DER-PR', tipo: 'Rodovia estadual coincidente' };
  if (r.startsWith('PR')) return { esfera: 'Estadual', orgao: 'DER-PR', tipo: 'Rodovia estadual' };
  return null;
}

/**
 * Tooltip de um trecho de rodovia (OSM: ref, name). `nivel` = 'federais' ou
 * 'estaduais'; `kmPorSigla` = extensão de cada sigla no PR (km).
 */
export function rodoviaTooltip(p, { nivel = 'estaduais', kmPorSigla = new Map(), cur = {} } = {}) {
  const siglas = splitList(p?.ref);
  const principal = siglas[0] ?? '';
  const jur = jurisdicaoDe(principal)
    ?? (nivel === 'federais'
      ? { esfera: 'Federal', orgao: 'DNIT', tipo: 'Rodovia federal' }
      : { esfera: 'Estadual', orgao: 'DER-PR', tipo: 'Rodovia estadual' });
  const nome = String(p?.name ?? '').trim();
  const ext = siglas.length === 1
    ? [fmtKm(kmPorSigla.get(principal))].filter(Boolean)
    : siglas.map((s) => (kmPorSigla.get(s) ? `${s}: ${fmtKm(kmPorSigla.get(s))}` : '')).filter(Boolean);
  return tipCard({
    icon: '🛣️',
    title: principal || nome || jur.tipo,
    subtitle: [jur.tipo, cur.municipio].filter(Boolean).join(' · '),
    badge: principal ? { text: nivel === 'federais' || principal.startsWith('BR') ? 'FEDERAL' : 'ESTADUAL', tone: 'info' } : null,
    rows: [
      ['Denominação', principal ? nome : null],
      ['Trecho coincidente com', siglas.length > 1 ? siglas.slice(1).join(', ') : null],
      ['Jurisdição', `${jur.esfera} · ${jur.orgao}`],
      ['Extensão no PR', ext.join(' · ')],
      ['Segmento', fmtKm(p?.km)],
      municipioRow(cur),
      coordRow(cur),
    ],
    source: `OpenStreetMap · ${jur.orgao} · DataGeo PR`,
  });
}

export const rodoviasLayer = (() => {
  let kmPorSigla = new Map();
  const tip = (nivel) => (p, _f, ctx) => rodoviaTooltip(p, { nivel, kmPorSigla, cur: cursorContext(ctx) });
  const tipFed = tip('federais');
  const tipEst = tip('estaduais');
  return defineLayer({
  id: 'datageo-rodovias',
  name: 'Rodovias',
  category: 'Infraestrutura',
  icon: '🛣️',
  source: 'OSM · DNIT/DER-PR',
  sources: {
    'dg-rodovias-fed': { type: 'geojson', data: EMPTY_FC },
    'dg-rodovias-est': { type: 'geojson', data: EMPTY_FC },
  },
  // Mesma ordem de desenho do app: federais primeiro, estaduais por cima.
  layers: [
    { id: 'dg-rodovias-fed-line', type: 'line', source: 'dg-rodovias-fed', layout: LINE_LAYOUT, paint: rodoviaPaint(RODOVIAS_STYLE.federais) },
    { id: 'dg-rodovias-est-line', type: 'line', source: 'dg-rodovias-est', layout: LINE_LAYOUT, paint: rodoviaPaint(RODOVIAS_STYLE.estaduais) },
    { id: 'dg-rodovias-fed-hit', type: 'line', source: 'dg-rodovias-fed', paint: HIT_PAINT },
    { id: 'dg-rodovias-est-hit', type: 'line', source: 'dg-rodovias-est', paint: HIT_PAINT },
  ],
  interactive: ['dg-rodovias-fed-hit', 'dg-rodovias-est-hit'],
  onEnable: (ctx) => trackCursor(ctx.map),
  // Contagem do app: trechos desenháveis (lineStringsFromGeojson) dos dois níveis.
  async load(ctx) {
    trackCursor(ctx.map);
    const [fed, est] = await Promise.all([fetchJson(RODOVIAS_FED_URL), fetchJson(RODOVIAS_EST_URL)]);
    for (const f of [...(fed.features ?? []), ...(est.features ?? [])]) {
      if (f?.properties) f.properties.km = Math.round(lineKm(f.geometry) * 100) / 100;
    }
    kmPorSigla = kmPorChave([...(fed.features ?? []), ...(est.features ?? [])], (p) => splitList(p.ref));
    ctx.setData('dg-rodovias-fed', fed);
    ctx.setData('dg-rodovias-est', est);
    return lineStringsFromGeojson(fed).length + lineStringsFromGeojson(est).length;
  },
  // Os dois níveis são a mesma camada: o layer atingido diz o nível.
  tooltip: (p, f, ctx) => (f?.layer?.id === 'dg-rodovias-fed-hit' ? tipFed : tipEst)(p, f, ctx),
  });
})();

// ------------------------------------------------------------------ estradas municipais

// datageoEstradas.js: frio para o asfalto urbano, quente para a terra das
// vicinais; urbanas só abaixo de 30 km, a camada toda abaixo de 90 km.
export const ESTRADAS_GRUPOS = Object.freeze([
  Object.freeze({ value: 'urbanas', label: 'Urbanas', color: '#f1f5f9', opacity: 0.5, width: 1.0, maxHeight: 30_000 }),
  Object.freeze({ value: 'rurais', label: 'Rurais', color: '#a8a29e', opacity: 0.55, width: 1.2 }),
]);

// build_estradas.py: tags `highway` do OSM de cada classe.
const ESTRADAS_INFO = Object.freeze({
  rurais: Object.freeze({
    titulo: 'Estrada rural (vicinal)',
    classe: 'Vicinal / estrada de terra (OSM unclassified, track, road)',
  }),
  urbanas: Object.freeze({
    titulo: 'Via urbana',
    classe: 'Rua de cidade ou vila (OSM residential, living_street, pedestrian)',
  }),
});

/** Tooltip da malha municipal fatiada (props: grupo, cell, trechos). */
export function estradaTooltip(p, { cur = {} } = {}) {
  const info = ESTRADAS_INFO[p?.grupo];
  return tipCard({
    icon: '🛤️',
    title: info?.titulo ?? 'Estrada municipal',
    subtitle: ['Malha municipal', cur.municipio].filter(Boolean).join(' · '),
    rows: [
      ['Classe', info?.classe ?? (p?.grupo ? String(p.grupo) : null)],
      ['Jurisdição', 'Municipal (prefeitura)'],
      municipioRow(cur),
      ['Trechos da classe na célula', Number(p?.trechos) > 0 ? `${fmtNum(p.trechos, 0)} (quadro de 0,25°)` : null],
      coordRow(cur),
    ],
    note: 'O extrato não traz nome, pavimento nem extensão por trecho.',
    source: 'OpenStreetMap (Geofabrik) · DataGeo PR',
  });
}

export const estradasLayer = (() => {
  const base = createSlicedLinesLayer({
    id: 'datageo-estradas',
    name: 'Estradas municipais',
    category: 'Infraestrutura',
    icon: '🛤️',
    source: 'OpenStreetMap',
    baseUrl: '/data/estradas',
    groupsKey: 'classes',
    grupos: ESTRADAS_GRUPOS,
    maxHeight: 90_000,
    tooltip: (p, _f, ctx) => estradaTooltip(p, { cur: cursorContext(ctx) }),
  });
  return defineLayer({
    ...base,
    onEnable(ctx) {
      trackCursor(ctx.map);
      return base.onEnable(ctx);
    },
  });
})();

// ------------------------------------------------------------------ estradas conveniadas

export const CONVENIADAS_URL = '/privado/estradas-conveniadas-pr.geojson';
const CONV_SRC = 'dg-estradas-conveniadas';
const CONV_HIT = 'dg-estradas-conveniadas-hit';

/** Layer de linha de um conjunto (grupo de GRUPOS). */
export function conveniadaLayerSpec(g) {
  return {
    id: `dg-estradas-conveniadas-${g.id}`,
    type: 'line',
    source: CONV_SRC,
    filter: ['==', ['get', 'grupo'], g.id],
    layout: LINE_LAYOUT,
    paint: { 'line-color': g.css, 'line-opacity': g.alpha, 'line-width': g.width },
  };
}

/** Filtro do layer de hover: só os conjuntos visíveis. */
export const conveniadasHitFilter = (visivel) => ['in', ['get', 'grupo'], ['literal', GRUPOS.filter((g) => visivel[g.id]).map((g) => g.id)]];

/** Contagem de feições por conjunto (a legenda do app). */
export function contarPorGrupo(features) {
  const counts = Object.fromEntries(GRUPOS.map((g) => [g.id, 0]));
  for (const f of features ?? []) {
    if (f?.properties?.grupo in counts) counts[f.properties.grupo] += 1;
  }
  return counts;
}

// Campos do build_estradas_conveniadas.py (rótulos já legíveis). Os que não
// estão em nenhuma lista caem em "Outros campos", para nada se perder.
const CONV_TOM = Object.freeze({ conveniadas: 'ok', protocolos: 'info', automatizado: 'muted' });
const CONV_TOPO = Object.freeze([
  'Tipo', 'Extensão (m)', 'Distância (km)', 'Situação', 'SIT (TCE)', 'Programa', 'Projeto', 'Objeto', 'Detalhes',
  'Setor', 'Nº convênio', 'Protocolo', 'Colaborador', 'Vigência (meses)', 'Origem (id)', 'Destino (id)',
]);
const CONV_RECURSOS = Object.freeze([
  'Valor global', 'Valor SEAB', 'SEAB (investimento)', 'SEAB (custeio)', 'Contrapartida',
  '% contrapartida obrigatória', '% contrapartida calculada', 'Fonte de recurso',
  'Empenhado', 'Valor empenhado', 'Valor pago', 'Falta empenhar',
  'Empenhado 2', 'Valor empenhado 2', 'Valor pago 2', 'Falta empenhar 2',
]);
const CONV_DATAS = Object.freeze([
  'Assinatura', 'Publicação', 'Nº empenho', 'Data empenho', 'Data pagamento',
  'Nº empenho 2', 'Data empenho 2', 'Data pagamento 2',
]);
const CONV_FORA = new Set(['grupo', 'Trecho', 'Município', 'Núcleo regional', 'Descrição']);
const TEXTO_MAX = 280;

const isMoneyKey = (k) => /^(Valor|SEAB \(|Contrapartida$|Falta empenhar|Empenhado)/.test(k);
const isDateKey = (k) => /^(Data |Assinatura$|Publicação$)/.test(k);
const clip = (t) => (t.length > TEXTO_MAX ? `${t.slice(0, TEXTO_MAX)}…` : t);

/** "1.234.567,89" / 1234567.89 -> "R$ 1.234.567,89"; texto não numérico passa. */
export function fmtReais(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Valor de um campo das conveniadas já formatado (pt-BR). */
export function conveniadaValor(key, v) {
  if (v === null || v === undefined || v === '') return '';
  if (key === 'Extensão (m)') {
    const m = Number(v);
    return Number.isFinite(m) ? (m >= 1000 ? fmtNum(m / 1000, 2, 'km') : fmtNum(m, 0, 'm')) : String(v);
  }
  if (key === 'Distância (km)') return Number.isFinite(Number(v)) ? fmtNum(v, 2, 'km') : String(v);
  if (key.startsWith('%')) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return `${fmtNum(n <= 1 ? n * 100 : n, 1)}%`;
  }
  if (isMoneyKey(key)) return fmtReais(v);
  if (isDateKey(key)) {
    const t = String(v).trim();
    const iso = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(t);
    return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : t;
  }
  // Identificadores (convênio, protocolo, empenho, ids) ficam sem milhar.
  if (typeof v === 'number' && !/^Nº|^Protocolo|\(id\)$/.test(key)) return fmtNum(v, Number.isInteger(v) ? 0 : 2);
  return clip(String(v));
}

/** Tooltip (tipCard) de um trecho das Estradas Rurais Conveniadas (SEAB-PR). */
export function conveniadaTooltip(props) {
  const grupo = GRUPOS.find((g) => g.id === props?.grupo);
  if (!grupo) return '';
  const rowsOf = (keys) => keys.map((k) => [k === 'Extensão (m)' ? 'Extensão' : k, conveniadaValor(k, props[k])]);
  const conhecidos = new Set([...CONV_TOPO, ...CONV_RECURSOS, ...CONV_DATAS, ...CONV_FORA]);
  const outros = Object.keys(props).filter((k) => !conhecidos.has(k));
  const desc = props['Descrição'] ? clip(String(props['Descrição']).trim()) : '';
  return tipCard({
    icon: '🚜',
    title: props.Trecho || 'Trecho sem nome',
    subtitle: [props['Município'], props['Núcleo regional'] ? `NR ${props['Núcleo regional']}` : ''].filter(Boolean).join(' · ')
      || grupo.label,
    badge: { text: grupo.label.toUpperCase(), tone: CONV_TOM[grupo.id] },
    rows: rowsOf(CONV_TOPO),
    sections: [
      { title: 'Recursos', rows: rowsOf(CONV_RECURSOS) },
      { title: 'Datas e empenhos', rows: rowsOf(CONV_DATAS) },
      { title: 'Outros campos', rows: rowsOf(outros) },
    ],
    note: desc,
    source: 'SEAB-PR · DataGeo PR (dado restrito)',
    wide: true,
  });
}

export const estradasConveniadasLayer = (() => {
  const visivel = Object.fromEntries(GRUPOS.map((g) => [g.id, true]));
  let counts = Object.fromEntries(GRUPOS.map((g) => [g.id, 0]));
  // z do app: automatizado por baixo, conveniadas por cima.
  const porZ = [...GRUPOS].sort((a, b) => a.z - b.z);

  function applyVisibility(map) {
    for (const g of GRUPOS) {
      const lid = conveniadaLayerSpec(g).id;
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', visivel[g.id] ? 'visible' : 'none');
    }
    if (map.getLayer(CONV_HIT)) map.setFilter(CONV_HIT, conveniadasHitFilter(visivel));
  }

  return defineLayer({
    id: 'datageo-estradas-conveniadas',
    name: 'Estradas Rurais Conveniadas',
    category: 'Infraestrutura',
    icon: '🚜',
    source: 'SEAB-PR',
    sources: { [CONV_SRC]: { type: 'geojson', data: EMPTY_FC } },
    layers: [
      ...porZ.map(conveniadaLayerSpec),
      {
        // Faixa invisível de 12 px para o hover pegar as linhas finas.
        id: CONV_HIT,
        type: 'line',
        source: CONV_SRC,
        filter: conveniadasHitFilter(visivel),
        paint: HIT_PAINT,
      },
    ],
    interactive: [CONV_HIT],
    // O registro liga todos os layers juntos; os chips desligados voltam a sumir.
    onEnable(ctx) {
      applyVisibility(ctx.map);
    },
    async load(ctx) {
      const geo = await fetchJson(CONVENIADAS_URL, dgFetchData);
      const features = geo.features ?? [];
      counts = contarPorGrupo(features);
      ctx.setData(CONV_SRC, fc(features));
      return GRUPOS.reduce((n, g) => n + (visivel[g.id] ? counts[g.id] : 0), 0);
    },
    tooltip: (props) => conveniadaTooltip(props),
    rowControls: () => ({
      chips: GRUPOS.map((g) => ({ id: g.id, label: g.label, active: visivel[g.id] })),
      legend: GRUPOS.map((g) => ({ label: g.label, color: g.css, count: counts[g.id] })),
    }),
    onChip(chipId, ctx) {
      if (!(chipId in visivel)) return;
      visivel[chipId] = !visivel[chipId];
      applyVisibility(ctx.map);
    },
  });
})();

export default [ferroviasLayer, rodoviasLayer, estradasLayer, estradasConveniadasLayer];
