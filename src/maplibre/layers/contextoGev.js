// src/maplibre/layers/contextoGev.js
//
// Camadas de contexto herdadas do GEV que existem em PRODUÇÃO (Pages), portadas
// do app Cesium com as mesmas fontes, cores, tamanhos e rótulos:
//
//   earthquakes                    src/data/earthquakes.js (USGS, 60 s)
//   local-datacenters, local-dams  src/data/localLayers.js + localGeojson.js
//   telegeography-submarine-cables src/data/telegeographySubmarineCables.js
//   local-firms                    src/data/firmsHeatmap.js (Supabase DataGeo)
//
// O que o Cesium resolve por quadro (cartões com declutter em tela, hastes 3D,
// discos no chão, LOD por altura de câmera) aqui vira estilo nativo: círculos
// em metros por expressão de zoom, rótulos com colisão do MapLibre
// (symbol-sort-key = prioridade do app, text-padding ~ grade de declutter) e,
// nos focos, `heatmap` na visão de longe e pontos/cartões ao aproximar.

import { fetchFiresPayload } from '../../data/datageoClient.js';
import {
  EARTHQUAKE_DEPTH_CSS,
  EARTHQUAKE_MIN_MAG,
  EARTHQUAKE_SIGNIFICANT_MAG,
  earthquakeDepthBand,
  earthquakeRadiusM,
} from '../../data/earthquakeStyle.js';
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';
import {
  cellSeverity,
  confidenceBucket,
  detectionSeverity,
  fireIntensity,
  formatAge,
  formatFrp,
  formatLatLon,
  frpPixelSize,
  heatScore,
} from '../../data/firmsFormat.js';
import { accentForSeverity, fireDetectionKey, satelliteShortName } from '../../data/firmsLabels.js';
import {
  labelPriorityFromProperties,
  localInfrastructureCopyFromPlain,
} from '../../data/localInfraLabels.js';
import {
  clampLabel,
  featureLabel,
  featureReference,
  normalizeFeatures,
} from '../../data/submarineCableRefs.js';
import {
  defineLayer,
  EMPTY_FC,
  fc,
  fmtCoord,
  fmtDateTime,
  fmtInt,
  fmtNum,
  LABEL_PAINT,
  point,
  TEXT_FONT,
  TEXT_FONT_BOLD,
  tipCard,
  zoomForHeight,
} from '../kit.js';

// Sem `category` no app, as camadas GEV caem no grupo padrão do painel.
const CONTEXTO = 'Contexto global';

/** Metros por pixel no equador no zoom 0 (tiles de 512 px do MapLibre). */
const M_PER_PX_Z0 = 40075016.686 / 512;

/**
 * Raio de círculo em METROS (disco no chão do Cesium) como expressão de zoom:
 * `r0` (pixels no zoom 0) por feição dobra a cada nível; piso de `minPx` para
 * o evento não sumir de longe.
 */
export function metricRadiusExpression(prop = 'r0', minPx = 2) {
  const stops = [];
  for (let z = 0; z <= 22; z += 2) stops.push(z, ['max', minPx, ['*', ['get', prop], 2 ** z]]);
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}

/** Pixels no zoom 0 de um raio em metros na latitude dada. */
export function radiusPxAtZ0(meters, lat) {
  const cos = Math.max(0.05, Math.cos((Number(lat) * Math.PI) / 180));
  return meters / (M_PER_PX_Z0 * cos);
}

const rgbAccent = (stop) => `rgb(${accentForSeverity(stop)})`;

// ------------------------------------------------------------------ terremotos

/** Teto de rótulos "M4.5" do app (cohort do overlay). */
export const EARTHQUAKE_LABEL_CAP = 96;

/**
 * Feed USGS (GeoJSON) → pontos com cor por profundidade, disco de 2^mag km e
 * rótulo nos EARTHQUAKE_LABEL_CAP maiores (mesmo corte M2.5 do app).
 */
export function buildEarthquakeFeatures(geojson) {
  const features = [];
  let n = 0;
  for (const f of geojson?.features ?? []) {
    const [lon, lat, depthKm] = f?.geometry?.coordinates ?? [];
    const mag = Number(f?.properties?.mag);
    if (!Number.isFinite(mag) || mag < EARTHQUAKE_MIN_MAG) continue;
    n += 1;
    const band = earthquakeDepthBand(depthKm || 0);
    const feature = point(lon, lat, {
      id: String(f.id || `event-${n}`),
      mag,
      place: f.properties.place ?? '',
      time: f.properties.time ?? null,
      depth: Number.isFinite(depthKm) ? depthKm : null,
      url: f.properties.url ?? '',
      magType: f.properties.magType ?? '',
      tsunami: Number(f.properties.tsunami) === 1,
      alert: f.properties.alert ?? '',
      felt: Number.isFinite(Number(f.properties.felt)) && f.properties.felt !== null ? Number(f.properties.felt) : null,
      status: f.properties.status ?? '',
      color: EARTHQUAKE_DEPTH_CSS[band],
      sig: mag >= EARTHQUAKE_SIGNIFICANT_MAG,
      r0: radiusPxAtZ0(earthquakeRadiusM(mag), lat),
      label: `M${mag.toFixed(1)}`,
      lab: false,
    });
    if (feature) features.push(feature);
  }
  // Maiores eventos primeiro, id estável como desempate (selectEarthquakeOverlayCohort).
  const ranked = features
    .slice()
    .sort((a, b) => b.properties.mag - a.properties.mag || a.properties.id.localeCompare(b.properties.id));
  for (const f of ranked.slice(0, EARTHQUAKE_LABEL_CAP)) f.properties.lab = true;
  return fc(features);
}

const DEPTH_LABEL = Object.freeze({ red: 'rasa (< 70 km)', orange: 'intermediária (70–300 km)', yellow: 'profunda (> 300 km)' });
const PAGER = Object.freeze({
  green: ['verde', 'ok'], yellow: ['amarelo', 'warn'], orange: ['laranja', 'alert'], red: ['vermelho', 'alert'],
});
const QUAKE_STATUS = Object.freeze({ reviewed: 'revisado', automatic: 'automático', deleted: 'removido' });

/** Tooltip de um terremoto (props de buildEarthquakeFeatures; `lonlat` da geometria). */
export function earthquakeTooltip(p, lonlat = []) {
  const mag = Number(p.mag);
  const depth = Number(p.depth);
  const [lon, lat] = lonlat;
  const tone = mag >= 6 ? 'alert' : mag >= EARTHQUAKE_SIGNIFICANT_MAG ? 'warn' : 'info';
  const pager = PAGER[p.alert];
  const tsunami = p.tsunami === true || p.tsunami === 'true';
  return tipCard({
    icon: '🌋',
    title: p.place || 'Terremoto',
    subtitle: 'Terremoto · últimas 24 h',
    badge: Number.isFinite(mag) ? { text: `M${fmtNum(mag, 1)}`, tone } : null,
    rows: [
      ['Magnitude', Number.isFinite(mag) ? `${fmtNum(mag, 1)}${p.magType ? ` (${p.magType})` : ''}` : '', tone],
      ['Profundidade', Number.isFinite(depth) && p.depth !== null ? `${fmtNum(depth, 1, 'km')} · ${DEPTH_LABEL[earthquakeDepthBand(depth)]}` : ''],
      ['Horário', p.time ? `${fmtDateTime(Number(p.time))} (Brasília)` : ''],
      ['Alerta PAGER', pager ? pager[0] : '', pager?.[1]],
      ['Tsunami', tsunami ? 'alerta de tsunami emitido' : '', 'alert'],
      ['Relatos "sentido"', Number(p.felt) > 0 ? fmtInt(p.felt) : ''],
      ['Coordenadas', fmtCoord(lat, lon, 3)],
      ['Revisão', QUAKE_STATUS[p.status] ?? p.status],
      ['Evento USGS', p.id],
    ],
    source: 'USGS · feed de 24 h',
    updated: p.time ? Number(p.time) : null,
  });
}

let quakeCounts = { red: 0, orange: 0, yellow: 0 };
let lastQuakes = [];

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const text = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};
const limitOf = (maxCount) => (Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000);

/** Registro de terremoto para o analista da voz (formato da camada Cesium). */
export function quakeAnalystRecords(features, maxCount = 2000) {
  return features.slice(0, limitOf(maxCount)).map((f, i) => ({
    id: text(f.properties?.id) || `QUAKE-${String(i).padStart(4, '0')}`,
    magnitude: num(f.properties?.mag),
    depthKm: num(f.properties?.depth),
    lat: num(f.geometry?.coordinates?.[1]),
    lon: num(f.geometry?.coordinates?.[0]),
    timeMs: num(f.properties?.time),
    place: text(f.properties?.place),
  }));
}

/** Registro de foco de calor para o analista da voz (formato da camada Cesium). */
export function fireAnalystRecords(fires, maxCount = 2000) {
  return fires.slice(0, limitOf(maxCount)).map((fire, i) => ({
    id: `FIRE-${String(fire?.index ?? i).padStart(5, '0')}`,
    lat: num(fire?.lat),
    lon: num(fire?.lon),
    frp: num(fire?.frp),
    confidence: num(fire?.confidence),
    satellite: text(fire?.satellite) || text(fire?.sensor),
    acqTime: Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? fire.acqMs : null,
  }));
}

const earthquakes = defineLayer({
  id: 'earthquakes',
  name: 'Terremotos (24h)',
  category: CONTEXTO,
  icon: '🌋',
  source: 'USGS',
  sources: { 'dg-earthquakes': { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: 'dg-earthquakes-disc',
      type: 'circle',
      source: 'dg-earthquakes',
      layout: { 'circle-sort-key': ['get', 'mag'] },
      paint: {
        'circle-radius': metricRadiusExpression('r0', 2),
        'circle-color': ['get', 'color'],
        'circle-opacity': ['case', ['==', ['get', 'sig'], true], 0.4, 0.3],
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': ['case', ['==', ['get', 'sig'], true], 3, 2],
        'circle-stroke-opacity': ['case', ['==', ['get', 'sig'], true], 1, 0.8],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: 'dg-earthquakes-label',
      type: 'symbol',
      source: 'dg-earthquakes',
      filter: ['==', ['get', 'lab'], true],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT_BOLD,
        'text-size': 12,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.9],
        'text-padding': 4,
        'symbol-sort-key': ['-', 0, ['get', 'mag']],
      },
      paint: { ...LABEL_PAINT, 'text-color': ['get', 'color'] },
    },
  ],
  refreshMs: 60000,
  async load(ctx) {
    const res = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
    if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json?.features)) throw new Error('Malformed USGS response');
    const data = buildEarthquakeFeatures(json);
    quakeCounts = { red: 0, orange: 0, yellow: 0 };
    for (const f of data.features) quakeCounts[earthquakeDepthBand(f.properties.depth ?? 0)] += 1;
    ctx.setData('dg-earthquakes', data);
    lastQuakes = data.features;
    return data.features.length;
  },
  analystRecords: (maxCount) => quakeAnalystRecords(lastQuakes, maxCount),
  interactive: ['dg-earthquakes-disc'],
  tooltip: (p, f) => earthquakeTooltip(p, f?.geometry?.coordinates),
  rowControls: () => ({
    legend: [
      { label: '< 70 km', color: EARTHQUAKE_DEPTH_CSS.red, count: quakeCounts.red },
      { label: '70–300 km', color: EARTHQUAKE_DEPTH_CSS.orange, count: quakeCounts.orange },
      { label: '> 300 km', color: EARTHQUAKE_DEPTH_CSS.yellow, count: quakeCounts.yellow },
    ],
  }),
});

// ------------------------------------------------ datacenters e barragens

/** JSON Lines (.geojsonl) → lista de feições; linhas vazias ignoradas. */
export function parseGeoJsonLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function ringCenter(ring) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of ring ?? []) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return Number.isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null;
}

/**
 * Feições locais → um ponto por entidade que o Cesium desenharia (ponto nativo
 * ou centro de cada polígono; linhas não ganham marcador) com o card do app
 * (título, detalhe, prioridade) e a camada de polígonos para o contorno.
 * `count` é o total de entidades, como o painel do app.
 */
export function buildLocalInfraFeatures(features, layerId) {
  const points = [];
  const polygons = [];
  let count = 0;
  for (const [i, f] of (features ?? []).entries()) {
    const g = f?.geometry;
    if (!g) continue;
    const props = f.properties ?? {};
    const copy = localInfrastructureCopyFromPlain(props, layerId);
    const tags = props.tags ?? {};
    const base = {
      title: copy.title,
      detail: copy.details.join(' · '),
      prio: labelPriorityFromProperties(props, layerId),
      type: String(props.type ?? tags.telecom ?? tags.waterway ?? ''),
      osm: props.osm_id ?? '',
      ...localInfraDetails(props),
    };
    const centers = [];
    if (g.type === 'Point') {
      count += 1;
      centers.push(g.coordinates);
    } else if (g.type === 'Polygon') {
      count += 1;
      centers.push(ringCenter(g.coordinates?.[0]));
      polygons.push({ type: 'Feature', geometry: g, properties: {} });
    } else if (g.type === 'MultiPolygon') {
      count += g.coordinates?.length ?? 0;
      for (const poly of g.coordinates ?? []) centers.push(ringCenter(poly?.[0]));
      polygons.push({ type: 'Feature', geometry: g, properties: {} });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      count += g.type === 'LineString' ? 1 : g.coordinates?.length ?? 0;
    }
    for (const c of centers) {
      const p = c && point(c[0], c[1], { ...base, fid: String(f.id ?? i) });
      if (p) points.push(p);
    }
  }
  return { points: fc(points), polygons: fc(polygons), count };
}

const clean = (v) => {
  const t = String(v ?? '').trim();
  return t && t !== 'undefined' && t !== 'null' ? t : '';
};
const first = (...vals) => vals.map(clean).find(Boolean) || '';

/**
 * Campos do OSM que interessam no tooltip, já planos (queryRenderedFeatures
 * não devolve objetos aninhados como `tags`).
 */
export function localInfraDetails(props) {
  const p = props ?? {};
  const t = p.tags ?? {};
  const output = first(t['plant:output:electricity'], p.output, t['generator:output:electricity']);
  return {
    name: first(p.name, t.name, t.official_name, t['name:en']),
    nameEn: clean(t['name:en']),
    operator: first(t.operator, p.operator, t['operator:short']),
    owner: clean(t.owner),
    capacity: first(t['capacity:it_load'], t.it_load, t.capacity, p.capacity),
    output: /^\d/.test(output) ? output : '',
    plant: first(t.power, p.source_layer === 'power_plant' ? 'plant' : ''),
    plantSource: first(t['plant:source'], p.source),
    method: first(t['plant:method'], p.method, t['generator:method']),
    river: first(t.associated_river, p.associated_river, t.river, p.river, t['river:name']),
    height: clean(t.height),
    levels: clean(t['building:levels']),
    start: clean(t.start_date),
    website: first(t.website, t['contact:website'], t['operator:website']),
    wiki: clean(t.wikipedia),
    ref: first(t['ref:US:NID'], t.ref),
  };
}

const PLANT_METHOD = Object.freeze({
  'run-of-the-river': 'fio d\'água', 'water-storage': 'reservatório', 'water-pumped-storage': 'reversível (bombeamento)',
});

/** "14000 MW" -> "14.000 MW"; "330KW" -> "330 kW". */
function fmtPower(raw) {
  const m = /^([\d.,]+)\s*(k|m|g)?w/i.exec(String(raw ?? '').trim());
  if (!m) return clean(raw);
  const n = Number(m[1].replace(',', '.'));
  const unit = { k: 'kW', m: 'MW', g: 'GW' }[(m[2] || '').toLowerCase()] || 'W';
  return Number.isFinite(n) ? fmtNum(n, Number.isInteger(n) ? 0 : 1, unit) : clean(raw);
}

/** Tooltip de datacenter/barragem (props de buildLocalInfraFeatures). */
export function localInfraTooltip(layerId, p, lonlat = []) {
  const dam = layerId === 'local-dams';
  const [lon, lat] = lonlat;
  const isPlant = p.plant === 'plant' || p.plantSource === 'hydro';
  const height = Number(String(p.height ?? '').replace(',', '.'));
  return tipCard({
    icon: dam ? '▰' : '▣',
    title: p.name || p.title,
    subtitle: dam ? (isPlant ? 'Barragem · usina hidrelétrica' : 'Barragem') : 'Datacenter',
    rows: [
      ['Nome em inglês', p.nameEn && p.nameEn !== p.name ? p.nameEn : ''],
      ['Operador', p.operator],
      ['Proprietário', p.owner && p.owner !== p.operator ? p.owner : ''],
      ['Carga de TI', p.capacity],
      ['Potência instalada', fmtPower(p.output)],
      ['Tipo de usina', PLANT_METHOD[p.method] ?? p.method],
      ['Rio', p.river],
      ['Altura', Number.isFinite(height) && height > 0 ? fmtNum(height, 0, 'm') : ''],
      ['Pavimentos', p.levels],
      ['Início de operação', p.start],
      ['Site', p.website],
      ['Wikipédia', p.wiki],
      ['Registro', p.ref],
      ['Coordenadas', fmtCoord(lat, lon, 4)],
      ['OSM', p.osm !== '' && p.osm != null ? String(p.osm) : ''],
    ],
    source: 'OpenStreetMap',
  });
}

/** Texto do card: título (negrito) e, se houver, a linha de detalhe menor. */
function cardTextField(detailColor = '#9fb3c8') {
  return [
    'case',
    ['==', ['get', 'detail'], ''],
    ['format', ['get', 'title'], { 'text-font': ['literal', TEXT_FONT_BOLD] }],
    [
      'format',
      ['get', 'title'], { 'text-font': ['literal', TEXT_FONT_BOLD] },
      '\n', {},
      ['get', 'detail'], { 'font-scale': 0.85, 'text-color': detailColor },
    ],
  ];
}

function localInfraLayer({ id, name, color, icon, source, url, labelGridPx }) {
  const src = `dg-${id}`;
  // Rótulos em fonte própria: os nomes do OSM vêm em vários alfabetos, e um
  // tile só termina quando todos os glyphs chegam — assim os pontos não
  // esperam pelas faixas de glyphs.
  const lbl = `dg-${id}-lbl`;
  const poly = `dg-${id}-poly`;
  return defineLayer({
    id,
    name,
    category: CONTEXTO,
    icon,
    source,
    sources: {
      [src]: { type: 'geojson', data: EMPTY_FC },
      [lbl]: { type: 'geojson', data: EMPTY_FC },
      [poly]: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        // GeoJsonDataSource do app: preenchimento padrão (amarelo translúcido)
        // com contorno na cor da camada — só visível de perto.
        id: `${poly}-fill`,
        type: 'fill',
        source: poly,
        minzoom: 11,
        paint: { 'fill-color': 'rgba(255,255,0,0.39)' },
      },
      {
        id: `${poly}-line`,
        type: 'line',
        source: poly,
        minzoom: 11,
        paint: { 'line-color': color, 'line-width': 1.5 },
      },
      {
        id: `${src}-pt`,
        type: 'circle',
        source: src,
        paint: {
          'circle-radius': 5,
          'circle-color': color,
          'circle-stroke-color': '#000000',
          'circle-stroke-width': 2,
        },
      },
      {
        // Cards ambientes do app: grade de declutter (labelGridPx) -> colisão
        // do MapLibre com o mesmo espaçamento; nomeados primeiro.
        id: `${src}-label`,
        type: 'symbol',
        source: lbl,
        layout: {
          'text-field': cardTextField(),
          'text-font': TEXT_FONT,
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.9],
          'text-max-width': 16,
          'text-padding': Math.round(labelGridPx / 4),
          'symbol-sort-key': ['-', 0, ['get', 'prio']],
        },
        paint: { ...LABEL_PAINT, 'text-color': color },
      },
    ],
    async load(ctx) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`dataset unavailable (HTTP ${res.status})`);
      let features;
      try {
        features = parseGeoJsonLines(await res.text());
      } catch (err) {
        throw new Error(err?.name === 'SyntaxError' ? 'dataset is malformed' : 'dataset unavailable');
      }
      const built = buildLocalInfraFeatures(features, id);
      ctx.setData(src, built.points);
      ctx.setData(lbl, built.points);
      ctx.setData(poly, built.polygons);
      return built.count;
    },
    interactive: [`${src}-pt`],
    tooltip: (p, f) => localInfraTooltip(id, p, f?.geometry?.coordinates),
  });
}

// URLs literais completas: o Vite só resolve `new URL('<arquivo>', import.meta.url)`.
const datacenters = localInfraLayer({
  id: 'local-datacenters',
  name: 'Datacenters',
  color: '#00ffff',
  icon: '▣',
  source: 'Local',
  url: new URL('../../data/local_data/datacenters/datacenters.geojsonl', import.meta.url).href,
  labelGridPx: 138,
});

const dams = localInfraLayer({
  id: 'local-dams',
  name: 'Barragens',
  color: '#0088ff',
  icon: '▰',
  source: 'USACE',
  url: new URL('../../data/local_data/dams/dams.geojsonl', import.meta.url).href,
  labelGridPx: 132,
});

// ------------------------------------------------------------ cabos submarinos

const CABLE_COLOR = '#39d5ff';
const LANDING_COLOR = '#8fffd2';

/** Distância de grande círculo em km. */
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Extensão (km) de uma LineString/MultiLineString, somando os trechos. */
export function lineLengthKm(geometry) {
  const parts = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  let km = 0;
  for (const line of parts ?? []) {
    for (let i = 1; i < (line?.length ?? 0); i++) km += haversineKm(line[i - 1], line[i]);
  }
  return km;
}

/** Tooltip de cabo (linha ou ponto de referência) ou estação de ancoragem. */
export function cableTooltip(p) {
  const cable = p.kind === 'cable';
  const tbd = p.tbd === true || p.tbd === 'true';
  const km = Number(p.km);
  return tipCard({
    icon: cable ? '≋' : '⚓',
    title: p.name || p.label,
    subtitle: cable ? 'Cabo submarino de telecomunicações' : 'Estação de ancoragem de cabos submarinos',
    badge: tbd ? { text: 'A DEFINIR', tone: 'warn' } : null,
    rows: [
      ['Extensão aprox.', cable && km > 0 ? fmtInt(km, 'km') : ''],
      [cable ? 'Referência' : 'Coordenadas', fmtCoord(p.rlat, p.rlon, 3)],
      ['Local', tbd ? 'posição ainda a definir' : '', 'warn'],
    ],
    note: 'Clique para aproximar.',
    source: '© TeleGeography — submarinecablemap.com',
  });
}

/**
 * Cabos (linhas com a cor de cada cabo) e referências: um ponto por cabo (a
 * coordenada de referência do TeleGeography) e um por estação de ancoragem,
 * com o rótulo do app. `count` = cabos + estações, como o painel do app.
 */
export function buildCableData(cableJson, landingJson) {
  const cables = normalizeFeatures(cableJson, 'cable');
  const landings = normalizeFeatures(landingJson, 'landing');
  const lines = [];
  const refs = [];
  for (const [kindName, list] of [['cable', cables], ['landing-point', landings]]) {
    for (const feature of list) {
      const reference = featureReference(feature);
      if (!reference) continue;
      const label = clampLabel(featureLabel(feature));
      const props = {
        kind: kindName,
        label,
        name: String(feature.properties?.name ?? label),
        tbd: Boolean(feature.properties?.is_tbd),
        rlon: reference.lon,
        rlat: reference.lat,
      };
      if (kindName === 'cable') {
        props.color = String(feature.properties?.color || CABLE_COLOR);
        props.km = Math.round(lineLengthKm(feature.geometry));
        lines.push({ type: 'Feature', id: lines.length, geometry: feature.geometry, properties: { ...props } });
      }
      const p = point(reference.lon, reference.lat, props);
      if (p) refs.push(p);
    }
  }
  return { lines: fc(lines), refs: fc(refs), count: cables.length + landings.length };
}

const CABLE_URL = new URL(
  '../../data/local_data/telegeography_submarine_cables/cable-geo.json',
  import.meta.url,
).href;
const LANDING_URL = new URL(
  '../../data/local_data/telegeography_submarine_cables/landing-point-geo.json',
  import.meta.url,
).href;

async function fetchJsonOrThrow(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const submarineCables = defineLayer({
  id: 'telegeography-submarine-cables',
  name: 'Cabos submarinos',
  category: CONTEXTO,
  icon: '≋',
  source: 'TeleGeography',
  sources: {
    'dg-cables': { type: 'geojson', data: EMPTY_FC },
    'dg-cable-refs': { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: 'dg-cables-line',
      type: 'line',
      source: 'dg-cables',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.92, 'line-width': 2.5 },
    },
    {
      // Faixa invisível e larga só para o hover/clique pegar a linha fina.
      id: 'dg-cables-hit',
      type: 'line',
      source: 'dg-cables',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#000000', 'line-opacity': 0.01, 'line-width': 12 },
    },
    {
      id: 'dg-cable-refs-pt',
      type: 'circle',
      source: 'dg-cable-refs',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'cable'], 3.5, ['==', ['get', 'tbd'], true], 3.5, 4],
        'circle-color': ['case', ['==', ['get', 'kind'], 'cable'], CABLE_COLOR, LANDING_COLOR],
        'circle-opacity': ['case', ['==', ['get', 'kind'], 'cable'], 0.84, 0.94],
        'circle-stroke-color': 'rgba(0,0,0,0.65)',
        'circle-stroke-width': 1,
      },
    },
    {
      // Rótulos de referência do app: até ~9 000 km de câmera, colisão no
      // lugar do arbitramento por distância.
      id: 'dg-cable-refs-label',
      type: 'symbol',
      source: 'dg-cable-refs',
      minzoom: zoomForHeight(9000000),
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT,
        'text-size': 11,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.8],
        'text-padding': 6,
      },
      paint: {
        ...LABEL_PAINT,
        'text-color': ['case', ['==', ['get', 'kind'], 'cable'], CABLE_COLOR, LANDING_COLOR],
      },
    },
  ],
  async load(ctx) {
    const [cableJson, landingJson] = await Promise.all([
      fetchJsonOrThrow(CABLE_URL),
      fetchJsonOrThrow(LANDING_URL),
    ]);
    const built = buildCableData(cableJson, landingJson);
    ctx.setData('dg-cables', built.lines);
    ctx.setData('dg-cable-refs', built.refs);
    return built.count;
  },
  interactive: ['dg-cable-refs-pt', 'dg-cables-hit'],
  tooltip: (p) => cableTooltip(p),
  // Clique voa até a referência (6,5 km de altura, 52° de inclinação), como o app.
  click: (p, f, ctx) => {
    const lon = Number(p.rlon);
    const lat = Number(p.rlat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    ctx.map.flyTo({ center: [lon, lat], zoom: zoomForHeight(6500), pitch: 52, duration: 1350 });
  },
});

// ------------------------------------------------------------ focos de calor

/**
 * Faixas de LOD do app (altura de câmera): células de 2° acima de 9 000 km,
 * de 1° acima de 3 000 km (aqui o `heatmap` nativo faz o papel das células) e
 * detecções individuais abaixo de 750 km.
 */
export const FIRMS_ZOOM = Object.freeze({
  global: zoomForHeight(9000000),
  regional: zoomForHeight(3000000),
  detections: zoomForHeight(750000),
});

/**
 * Registros adaptados (firmsAdapt.js) → pontos com severidade, tamanho,
 * peso do heatmap e o texto do card ambiente e do card selecionado do app.
 */
export function buildFireFeatures(fires, nowMs = Date.now()) {
  const features = [];
  for (const fire of fires ?? []) {
    const sev = detectionSeverity(fire);
    const meta = [confidenceBucket(fire.confidence)];
    const age = fire.acqMs > 0 ? formatAge(nowMs - fire.acqMs) : '';
    if (age) meta.push(age);
    const sat = satelliteShortName(fire.satellite);
    if (sat || fire.sensor) meta.push(sat || fire.sensor);
    const selMeta = [`${confidenceBucket(fire.confidence)} conf`];
    if (age) selMeta.push(`${age} ago`);
    selMeta.push(sat ? `${fire.sensor || 'VIIRS'} ${sat}` : fire.sensor || 'sensor n/a');
    const f = point(fire.lon, fire.lat, {
      key: fireDetectionKey(fire),
      frp: fire.frp,
      sev,
      color: rgbAccent(sev),
      size: frpPixelSize(fire.frp),
      w: Math.min(1, fireIntensity(fire) / 10),
      title: `▲ ${formatFrp(fire.frp)} MW`,
      detail: meta.join(' · '),
      selTitle: `FIRE · ${formatFrp(fire.frp)} MW`,
      selDetail: `${selMeta.join(' · ')}\n${formatLatLon(fire.lat, fire.lon)}${fire.night ? ' · NIGHT' : ''}`,
      muni: fire.municipality ?? '',
    }, fire.index);
    if (f) features.push(f);
  }
  return fc(features);
}

/**
 * Agregação em células (a mesma de firmsHeatmap.aggregateFires) → um ponto no
 * centro de cada célula com o card "14 FIRES / max X MW · new 3h", severidade
 * pelo placar normalizado e prioridade pelo placar.
 */
export function buildFireCells(fires, gridDegrees, nowMs = Date.now()) {
  const cells = new Map();
  for (const fire of fires ?? []) {
    const latCell = Math.floor(fire.lat / gridDegrees) * gridDegrees;
    const lonCell = Math.floor(fire.lon / gridDegrees) * gridDegrees;
    const key = `${latCell.toFixed(3)}:${lonCell.toFixed(3)}`;
    const c = cells.get(key) || { latCell, lonCell, count: 0, intensity: 0, maxFrp: 0, night: 0, newestAcqMs: 0 };
    c.count += 1;
    c.intensity += fireIntensity(fire);
    c.maxFrp = Math.max(c.maxFrp, fire.frp);
    c.newestAcqMs = Math.max(c.newestAcqMs, fire.acqMs);
    if (fire.night) c.night += 1;
    cells.set(key, c);
  }
  const list = [...cells.values()];
  const maxScore = Math.max(1, ...list.map(heatScore));
  return fc(
    list.map((c) => {
      const score = heatScore(c);
      const sev = cellSeverity(Math.min(1, Math.sqrt(score / maxScore)));
      const parts = [`max ${formatFrp(c.maxFrp)} MW`];
      const age = c.newestAcqMs > 0 ? formatAge(nowMs - c.newestAcqMs) : '';
      if (age) parts.push(`new ${age}`);
      return point(c.lonCell + gridDegrees / 2, c.latCell + gridDegrees / 2, {
        score,
        color: rgbAccent(sev),
        title: `${c.count} ${c.count === 1 ? 'FIRE' : 'FIRES'}`,
        detail: parts.join(' · '),
      });
    }),
  );
}

const SAT_NOME = Object.freeze({ N20: 'NOAA-20', N21: 'NOAA-21', SNPP: 'Suomi NPP', AQUA: 'Aqua', TERRA: 'Terra' });
const CONF_PT = Object.freeze({ high: ['alta', 'ok'], nominal: ['nominal', 'info'], low: ['baixa', 'muted'] });
const SEV_BADGE = Object.freeze({ red: ['ALTA', 'alert'], orange: ['MÉDIA', 'warn'], yellow: ['BAIXA', 'info'] });

/**
 * Tooltip de um foco (registro adaptado de firmsAdapt + município). A FRP só
 * aparece quando o ETL a grava (fire_spots ainda não persiste, vem 0).
 */
export function fireTooltip(fire, nowMs = Date.now()) {
  if (!fire) return '';
  const conf = CONF_PT[confidenceBucket(fire.confidence)];
  const sat = satelliteShortName(fire.satellite);
  const satTxt = [fire.sensor, SAT_NOME[sat] ?? sat].filter(Boolean).join(' · ');
  const acq = fire.acqMs > 0 ? fire.acqMs : null;
  const ageH = acq ? (nowMs - acq) / 3600_000 : NaN;
  // Com FRP gravada, o selo é a severidade da legenda; sem ela (fire_spots
  // ainda não grava) a severidade sairia sempre "baixa": o selo vira recência.
  const sev = SEV_BADGE[detectionSeverity(fire)];
  const badge = fire.frp > 0 ? { text: sev[0], tone: sev[1] }
    : ageH >= 0 && ageH < 6 ? { text: 'ÚLTIMAS 6 H', tone: 'alert' }
      : ageH >= 0 && ageH < 24 ? { text: 'ÚLTIMAS 24 H', tone: 'warn' } : null;
  return tipCard({
    icon: '🔥',
    title: fire.municipality ? `${fire.municipality}` : 'Foco de calor',
    subtitle: fire.municipality ? 'Foco de calor (satélite)' : 'Foco de calor (satélite) · município não informado',
    badge,
    rows: [
      ['Detecção', acq ? `${fmtDateTime(acq)} (Brasília)` : ''],
      ['Intensidade', fire.frp > 0 ? sev[0].toLowerCase() : '', sev[1]],
      ['Confiança', conf[0], conf[1]],
      ['Potência radiativa', fire.frp > 0 ? fmtNum(fire.frp, fire.frp >= 10 ? 0 : 1, 'MW') : ''],
      ['Temperatura de brilho', fire.brightness > 0 ? fmtNum(fire.brightness, 1, 'K') : ''],
      ['Satélite', satTxt],
      ['Coordenadas', fmtCoord(fire.lat, fire.lon, 4)],
    ],
    source: 'NASA FIRMS · DataGeo PR',
    updated: acq,
    now: nowMs,
  });
}

let firmsState = { count: 0, sev: { red: 0, orange: 0, yellow: 0 }, info: null };
let lastFires = [];
let selectedKey = null;
let clearHandler = null;

/**
 * Aplica um payload no formato de fetchFiresPayload ({fetchedAt, stale,
 * fires}) às fontes da camada. Exportado para o QA desenhar dados de exemplo
 * sem sessão no Supabase.
 */
export function applyFiresPayload(ctx, payload, nowMs = Date.now()) {
  const fires = adaptFirmsRecords(payload?.fires);
  // adaptFirmsRecords descarta o município (o card do app não o mostra); o
  // tooltip usa. Mesmo filtro de coordenadas, então os índices batem.
  const raw = (payload?.fires ?? []).filter(
    (r) => Number.isFinite(Number(r?.lat)) && Number.isFinite(Number(r?.lon)),
  );
  fires.forEach((fire, i) => {
    fire.municipality = raw[i]?.municipality ?? '';
  });
  lastFires = fires;
  const points = buildFireFeatures(fires, nowMs);
  ctx.setData('dg-firms', points);
  ctx.setData('dg-firms-lbl', points);
  ctx.setData('dg-firms-cells2', buildFireCells(fires, 2.0, nowMs));
  ctx.setData('dg-firms-cells1', buildFireCells(fires, 1.0, nowMs));
  const sev = { red: 0, orange: 0, yellow: 0 };
  for (const f of points.features) sev[f.properties.sev] += 1;
  firmsState = { count: fires.length, sev, info: payload?.stale ? 'dado antigo (cache)' : null };
  if (selectedKey && !points.features.some((f) => f.properties.key === selectedKey)) selectFire(ctx, null);
  ctx.refreshPanel?.();
  return firmsState;
}

/** Seleciona (card completo, anel) ou limpa; o card ambiente do selecionado some. */
function selectFire(ctx, feature) {
  selectedKey = feature?.properties?.key ?? null;
  ctx.setData(
    'dg-firms-sel',
    feature ? fc([{ type: 'Feature', geometry: feature.geometry, properties: { ...feature.properties } }]) : EMPTY_FC,
  );
  if (ctx.map.getLayer('dg-firms-label')) {
    ctx.map.setFilter('dg-firms-label', selectedKey ? ['!=', ['get', 'key'], selectedKey] : null);
  }
}

const fireCardLayout = (padding) => ({
  'text-field': cardTextField('#cbd5e1'),
  'text-font': TEXT_FONT,
  'text-size': 11,
  'text-anchor': 'bottom',
  'text-offset': [0, -0.9],
  'text-padding': padding,
});

const firms = defineLayer({
  id: 'local-firms',
  name: 'Focos de calor (queimadas)',
  analystRecords: (maxCount) => fireAnalystRecords(lastFires, maxCount),
  category: 'Ambiente',
  icon: '▲',
  source: 'NASA FIRMS · DataGeo PR',
  sources: {
    'dg-firms': { type: 'geojson', data: EMPTY_FC },
    // Cards em fonte própria (pontos e calor não esperam pelos glyphs).
    'dg-firms-lbl': { type: 'geojson', data: EMPTY_FC },
    'dg-firms-cells2': { type: 'geojson', data: EMPTY_FC },
    'dg-firms-cells1': { type: 'geojson', data: EMPTY_FC },
    'dg-firms-sel': { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      // Visão de longe: calor agregado (as células translúcidas do app) no
      // heatmap nativo, mesma rampa amarelo → laranja → vermelho.
      id: 'dg-firms-heat',
      type: 'heatmap',
      source: 'dg-firms',
      maxzoom: FIRMS_ZOOM.detections + 0.6,
      paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.12, 5, 0.3, 7.5, 0.8],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 5, 9, 7.5, 18],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(255,255,0,0)',
          0.12, 'rgba(255,255,0,0.3)',
          0.42, 'rgba(255,165,0,0.5)',
          0.72, 'rgba(255,0,0,0.62)',
          1, 'rgba(255,40,40,0.72)',
        ],
        'heatmap-opacity': [
          'interpolate', ['linear'], ['zoom'],
          FIRMS_ZOOM.detections - 0.4, 1,
          FIRMS_ZOOM.detections + 0.6, 0,
        ],
      },
    },
    {
      // Perto: brilho radial do sprite (cor da severidade), tamanho por FRP.
      id: 'dg-firms-glow',
      type: 'circle',
      source: 'dg-firms',
      minzoom: FIRMS_ZOOM.detections - 0.4,
      layout: { 'circle-sort-key': ['get', 'frp'] },
      paint: {
        'circle-radius': ['get', 'size'],
        'circle-color': ['get', 'color'],
        'circle-blur': 0.75,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], FIRMS_ZOOM.detections - 0.4, 0, FIRMS_ZOOM.detections + 0.4, 0.95],
      },
    },
    {
      id: 'dg-firms-core',
      type: 'circle',
      source: 'dg-firms',
      minzoom: FIRMS_ZOOM.detections - 0.4,
      paint: {
        'circle-radius': ['*', ['get', 'size'], 0.3],
        'circle-color': 'rgba(255,255,235,0.95)',
        'circle-blur': 0.4,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], FIRMS_ZOOM.detections - 0.4, 0, FIRMS_ZOOM.detections + 0.4, 1],
      },
    },
    {
      id: 'dg-firms-sel-ring',
      type: 'circle',
      source: 'dg-firms-sel',
      paint: {
        'circle-radius': ['+', ['get', 'size'], 5],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2,
      },
    },
    {
      // Cards ambientes das células (o app limita a 18 com 150 px de
      // separação; aqui a colisão com folga larga e o placar como prioridade).
      id: 'dg-firms-cells2-label',
      type: 'symbol',
      source: 'dg-firms-cells2',
      maxzoom: FIRMS_ZOOM.global,
      layout: { ...fireCardLayout(45), 'symbol-sort-key': ['-', 0, ['get', 'score']] },
      paint: { ...LABEL_PAINT, 'text-color': ['get', 'color'] },
    },
    {
      id: 'dg-firms-cells1-label',
      type: 'symbol',
      source: 'dg-firms-cells1',
      minzoom: FIRMS_ZOOM.global,
      maxzoom: FIRMS_ZOOM.detections,
      layout: { ...fireCardLayout(45), 'symbol-sort-key': ['-', 0, ['get', 'score']] },
      paint: { ...LABEL_PAINT, 'text-color': ['get', 'color'] },
    },
    {
      id: 'dg-firms-label',
      type: 'symbol',
      source: 'dg-firms-lbl',
      minzoom: FIRMS_ZOOM.detections,
      layout: { ...fireCardLayout(60), 'symbol-sort-key': ['-', 0, ['get', 'frp']] },
      paint: { ...LABEL_PAINT, 'text-color': ['get', 'color'] },
    },
    {
      // Card do foco clicado: por cima de tudo e sem colisão.
      id: 'dg-firms-sel-label',
      type: 'symbol',
      source: 'dg-firms-sel',
      layout: {
        'text-field': [
          'format',
          ['get', 'selTitle'], { 'text-font': ['literal', TEXT_FONT_BOLD] },
          '\n', {},
          ['get', 'selDetail'], { 'font-scale': 0.85, 'text-color': '#e2e8f0' },
        ],
        'text-font': TEXT_FONT,
        'text-size': 12,
        'text-anchor': 'bottom',
        'text-offset': [0, -1.2],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { ...LABEL_PAINT, 'text-color': ['get', 'color'] },
    },
  ],
  refreshMs: 600000,
  async load(ctx) {
    let payload;
    try {
      payload = await fetchFiresPayload();
    } catch (err) {
      console.warn('[maplibre:local-firms] FIRMS live load failed:', err);
      throw new Error('live feed unavailable');
    }
    const st = applyFiresPayload(ctx, payload);
    return { count: st.count, info: st.info };
  },
  onEnable(ctx) {
    if (clearHandler) return;
    // Clique fora de um foco limpa a seleção (o do foco chega pelo registro).
    clearHandler = (e) => {
      if (!selectedKey || !ctx.map.getLayer('dg-firms-glow')) return;
      if (ctx.map.queryRenderedFeatures(e.point, { layers: ['dg-firms-glow'] }).length) return;
      selectFire(ctx, null);
    };
    ctx.map.on('click', clearHandler);
  },
  onDisable(ctx) {
    if (clearHandler) ctx.map.off('click', clearHandler);
    clearHandler = null;
    selectFire(ctx, null);
  },
  interactive: ['dg-firms-glow'],
  tooltip: (p, f) => fireTooltip(lastFires[f?.id] ?? lastFires.find((x) => fireDetectionKey(x) === p.key)),
  // Clique seleciona (card completo) e centraliza no foco (requestWorldFocus do app).
  click: (p, f, ctx) => {
    selectFire(ctx, { geometry: f.geometry, properties: p });
    ctx.map.easeTo({ center: f.geometry.coordinates, duration: 700 });
  },
  rowControls: () => ({
    legend: [
      { label: 'alta', color: rgbAccent('red'), count: firmsState.sev.red },
      { label: 'média', color: rgbAccent('orange'), count: firmsState.sev.orange },
      { label: 'baixa', color: rgbAccent('yellow'), count: firmsState.sev.yellow },
    ],
  }),
});

export default [earthquakes, datacenters, dams, submarineCables, firms];
