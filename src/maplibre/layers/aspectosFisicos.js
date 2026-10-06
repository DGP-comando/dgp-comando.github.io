// src/maplibre/layers/aspectosFisicos.js
//
// Aba Aspectos físicos. Declividade, drenagem, nascentes e curvas de nível
// vêm ao vivo do GeoPR (IAT) em imagem: cache de tiles onde o serviço tem
// (drenagem, curvas), MapServer/export onde não tem. Não há MDE estadual no
// GeoPR: a altimetria pinta o relevo dos tiles de elevação já usados pelo
// mapa, nas mesmas faixas do resumo da ficha (que sai do MDE 12,5 m do IDR).
// Uso do solo: o mapeamento do IAT 2012-2016 recortado pela malha do
// município selecionado (public/data/uso-solo/{ibge}.png, PNG paleta de 30 m
// em mercator); sem município selecionado, a camada fica vazia. Imagem e não
// vetor: o mapeamento é muito fragmentado (1,5 MB por município mesmo
// simplificado). O export do GeoPR leva 20 s por tile e não recorta pela divisa.
// Resumos por município: datageoFicha.js (src/data/aspectosFisicos.js).

import {
  CORES_ALTITUDE, DECLIVIDADE, FAIXAS_ALTITUDE, USO_SOLO, loadAspectosFisicos, rotuloFaixa,
} from '../../data/aspectosFisicos.js';
import { getMunicipioSelecionado, MUNICIPIO_SELECIONADO_EVENT } from '../../datageoFicha.js';
import { defineLayer, fmtInt } from '../kit.js';
import { BASE } from './iatPontos.js';

const CATEGORY = 'Aspectos físicos';
const FONTE_IAT = 'IAT/GeoPR';

const tileCache = (servico) => `${BASE}/${servico}/MapServer/tile/{z}/{y}/{x}`;
const tileExport = (servico) => `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}` +
  '&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image&layers=show:0';

/**
 * Camada só de imagem do GeoPR: fontes [{servico, cache, minzoom, maxzoom}]
 * empilhadas. `cache` é o último nível do cache de tiles do serviço (o maxScale
 * dele): acima disso o GeoPR devolve 404, então a fonte para ali e o MapLibre
 * amplia o último tile. Sem `cache`, MapServer/export (sem teto, mais lento).
 */
function geoprRaster({ id, sufixo, fontes, opacity = 1, legend = null, ...rest }) {
  const src = (i) => `dg-${sufixo}${i ? `-${i}` : ''}`;
  return defineLayer({
    id,
    category: CATEGORY,
    ...rest,
    sources: Object.fromEntries(fontes.map((f, i) => [src(i), {
      type: 'raster',
      tiles: [f.cache ? tileCache(f.servico) : tileExport(f.servico)],
      tileSize: f.cache ? 256 : 512,
      maxzoom: f.cache ?? 22,
      ...(i === 0 ? { attribution: FONTE_IAT } : {}),
    }])),
    layers: fontes.map((f, i) => ({
      id: `${src(i)}-img`,
      type: 'raster',
      source: src(i),
      ...(f.minzoom ? { minzoom: f.minzoom } : {}),
      ...(f.maxzoom ? { maxzoom: f.maxzoom } : {}),
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 },
    })),
    ...(legend ? { rowControls: () => ({ legend }) } : {}),
  });
}

// --- altimetria ------------------------------------------------------------

// color-relief interpola: dois pontos colados em cada limite viram degraus,
// as mesmas faixas da ficha.
const reliefColor = ['interpolate', ['linear'], ['elevation'],
  ...CORES_ALTITUDE.flatMap((cor, i) => [
    ...(i ? [FAIXAS_ALTITUDE[i - 1], cor] : [-50, cor]),
    ...(i < FAIXAS_ALTITUDE.length ? [FAIXAS_ALTITUDE[i] - 0.1, cor] : [3000, cor]),
  ]),
];

const DEM = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 13,
  attribution: 'Relevo: Mapzen/AWS Terrain Tiles',
};

export const altimetriaLayer = defineLayer({
  id: 'datageo-altimetria',
  name: 'Altimetria (hipsometria)',
  category: CATEGORY,
  icon: '⛰️',
  source: 'Mapzen/AWS Terrain Tiles · resumo: MDE ALOS 12,5 m',
  sources: { 'dg-altimetria-dem': DEM },
  layers: [
    { id: 'dg-altimetria-cor', type: 'color-relief', source: 'dg-altimetria-dem',
      paint: { 'color-relief-color': reliefColor, 'color-relief-opacity': 0.6 } },
    { id: 'dg-altimetria-sombra', type: 'hillshade', source: 'dg-altimetria-dem',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0,0,0,0.45)' } },
  ],
  rowControls: () => ({ legend: CORES_ALTITUDE.map((color, i) => ({ label: rotuloFaixa(i), color })) }),
});

// --- GeoPR -----------------------------------------------------------------

export const declividadeLayer = geoprRaster({
  id: 'datageo-declividade',
  sufixo: 'declividade',
  name: 'Declividade · ZEE-PR',
  icon: '📐',
  source: 'IAT/GeoPR · ZEE-PR (zee_declividade), ao vivo',
  fontes: [{ servico: 'zee_declividade' }],
  opacity: 0.55,
  legend: DECLIVIDADE.map(({ label, color }) => ({ label, color })),
});

// A rede completa (1 milhão de trechos) só a partir do zoom 9; antes, a
// generalizada do mesmo serviço. O cache da generalizada começa no zoom 8
// (minScale); na vista do estado ela vem do export.
export const hidrografiaLayer = geoprRaster({
  id: 'datageo-hidrografia',
  sufixo: 'hidrografia',
  name: 'Hidrografia · rede ottocodificada 2020',
  icon: '🏞️',
  source: 'IAT/GeoPR · rede_otto_trech_drena_2020_iat, ao vivo',
  fontes: [
    { servico: 'rede_otto_trech_drena_2020_iat_generalizada', maxzoom: 8 },
    { servico: 'rede_otto_trech_drena_2020_iat_generalizada', cache: 15, minzoom: 8, maxzoom: 9 },
    { servico: 'rede_otto_trech_drena_2020_iat', cache: 14, minzoom: 9 },
  ],
});

// 348 mil pontos: no estado inteiro viram mancha (e o export leva 7 s).
export const nascentesLayer = geoprRaster({
  id: 'datageo-nascentes',
  sufixo: 'nascentes',
  name: 'Nascentes · FBDS',
  icon: '💧',
  source: 'FBDS via IAT/GeoPR (fbds_nascentes), ao vivo · a partir do zoom 10',
  fontes: [{ servico: 'fbds_nascentes', minzoom: 10 }],
});

export const curvasLayer = geoprRaster({
  id: 'datageo-curvas-nivel',
  sufixo: 'curvas-nivel',
  name: 'Curvas de nível · 10/20 m',
  icon: '〰️',
  source: 'IAT/GeoPR · curvas 1:25.000 e 1:50.000, ao vivo · a partir do zoom 11',
  fontes: [{ servico: 'curvas_de_nivel_1_50000_20m', cache: 14, minzoom: 11 }],
});

// --- uso do solo (município selecionado) ------------------------------------

const USO_SRC = 'dg-uso-solo';
// PNG transparente 1×1: o image source exige url e cantos já na criação.
const VAZIO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const cantos = ([w, s, e, n]) => [[w, n], [e, n], [e, s], [w, s]];
const PR = [-54.62, -26.72, -48.02, -22.52];
const uso = { ctx: null, ibge: null, nome: null, classes: [], seq: 0, semDado: false };

/** Mostra o PNG do município (ou nada) e a legenda com os hectares da ficha. */
export async function carregaUso(sel) {
  const seq = ++uso.seq;
  uso.ibge = sel?.ibge && /^\d{7}$/.test(sel.ibge) ? sel.ibge : null;
  uso.nome = sel?.nome ?? null;
  let m = null;
  if (uso.ibge) {
    try {
      m = (await loadAspectosFisicos()).municipios?.[uso.ibge] ?? null;
    } catch (err) {
      console.warn('[maplibre:datageo-uso-solo]', err);
    }
  }
  if (seq !== uso.seq || !uso.ctx) return;
  uso.semDado = Boolean(uso.ibge) && !m?.usoBbox;
  uso.classes = Object.entries(m?.uso ?? {}).map(([classe, ha]) => ({ classe, ha })).sort((a, b) => b.ha - a.ha);
  uso.ctx.map.getSource(USO_SRC)?.updateImage(m?.usoBbox
    ? { url: `/data/uso-solo/${uso.ibge}.png`, coordinates: cantos(m.usoBbox) }
    : { url: VAZIO, coordinates: cantos(PR) });
  uso.ctx.refreshPanel();
}

const onSelecao = (e) => carregaUso(e.detail);

export const usoSoloLayer = defineLayer({
  id: 'datageo-uso-solo',
  name: 'Uso do solo · IAT 2012-2016 (município selecionado)',
  category: CATEGORY,
  icon: '🌾',
  source: 'IAT/GeoPR · Mapeamento de Uso e Cobertura da Terra 2012-2016 (nível II, 30 m)',
  sources: { [USO_SRC]: { type: 'image', url: VAZIO, coordinates: cantos(PR) } },
  layers: [
    { id: 'dg-uso-solo-img', type: 'raster', source: USO_SRC,
      paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
  ],
  onEnable(ctx) {
    uso.ctx = ctx;
    document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    document.addEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    carregaUso(getMunicipioSelecionado());
  },
  onDisable() {
    document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    uso.ctx = null;
    uso.seq++;
  },
  rowControls: () => {
    if (!uso.ibge) return { legend: [{ label: 'Clique num município para ver o uso do solo', color: '#64748b' }] };
    if (uso.semDado) return { legend: [{ label: `Sem uso do solo para ${uso.nome}`, color: '#64748b' }] };
    return { legend: uso.classes.map(({ classe, ha }) => ({ label: classe, color: USO_SOLO[classe] ?? '#94a3b8', count: `${fmtInt(ha)} ha` })) };
  },
});

export default [altimetriaLayer, declividadeLayer, hidrografiaLayer, nascentesLayer, curvasLayer, usoSoloLayer];
