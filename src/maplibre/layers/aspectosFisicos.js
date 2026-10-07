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
// Tooltip: um polígono invisível da divisa recebe o hover e a classe sai da cor
// do pixel do PNG sob o cursor (paleta = cores de USO_SOLO).
// Resumos por município: datageoFicha.js (src/data/aspectosFisicos.js).

import {
  CORES_ALTITUDE, DECLIVIDADE, DECLIVIDADE_SEM_RELEVO, FAIXAS_ALTITUDE, USO_SOLO, loadAspectosFisicos, rotuloFaixa,
} from '../../data/aspectosFisicos.js';
import { defineLayer, fmtInt, tipCard } from '../kit.js';
import { BASE } from './iatPontos.js';
import { manchasDoMunicipio } from './manchasRaster.js';


const CATEGORY = 'Aspectos físicos';
const FONTE_IAT = 'IAT/GeoPR';

// Texto dos tooltips com área por polígono (declividade e uso do solo).
const haTxt = (v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ha`;
const pctTxt = (parte, total) => (total
  ? ` (${((parte / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)` : '');
const somaHa = (classes) => Object.values(classes ?? {}).reduce((a, v) => a + v, 0);
const FONTE_MANCHA = 'polígono = mancha contínua da classe em pixels de 30 m, recortada na divisa';

const tileCache = (servico) => `${BASE}/${servico}/MapServer/tile/{z}/{y}/{x}`;
const tileExport = (servico) => `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}` +
  '&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image&layers=show:0';

/**
 * Camada só de imagem do GeoPR: fontes [{servico, cache, minzoom, maxzoom}]
 * empilhadas. `cache` é o último nível do cache de tiles do serviço (o maxScale
 * dele): acima disso o GeoPR devolve 404, então a fonte para ali e o MapLibre
 * amplia o último tile. Sem `cache`, MapServer/export (sem teto, mais lento).
 */
function geoprSpec({ id, sufixo, fontes, opacity = 1, legend = null, ...rest }) {
  const src = (i) => `dg-${sufixo}${i ? `-${i}` : ''}`;
  return {
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
  };
}

const geoprRaster = (opts) => defineLayer(geoprSpec(opts));

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

// Tooltip com área por polígono dentro do município selecionado: o desenho é
// o do GeoPR, e um PNG da mesma ZEE recortada (public/data/declividade, não
// aparece) diz a classe e a mancha sob o cursor. Polígono da ZEE inteiro não
// serve: o de 0-10 % chega a 3,2 milhões de ha.
const DECL_CORES = Object.fromEntries([...DECLIVIDADE, ...DECLIVIDADE_SEM_RELEVO].map((c) => [c.key, c.color]));
const DECL_LABEL = Object.fromEntries([...DECLIVIDADE, ...DECLIVIDADE_SEM_RELEVO].map((c) => [c.key, c.label]));

const decl = manchasDoMunicipio({
  prefixo: 'declividade-mancha',
  cores: DECL_CORES,
  png: (ibge) => `/data/declividade/${ibge}.png`,
  dados: async (ibge) => {
    const m = (await loadAspectosFisicos()).municipios?.[ibge];
    return m?.declBbox ? { bbox: m.declBbox, classes: m.decl ?? {} } : null;
  },
  tooltip: ({ classe, ha }, st) => {
    const haClasse = st.m.classes[classe] ?? 0;
    return tipCard({
      icon: '📐',
      title: `Declividade ${DECL_LABEL[classe] ?? classe}`,
      subtitle: `ZEE-PR · ${st.nome ?? ''}`,
      rows: [
        ['Área deste polígono', `≈ ${haTxt(ha)}`],
        ['Classe no município', `${fmtInt(haClasse)} ha${pctTxt(haClasse, somaHa(st.m.classes))}`],
      ],
      source: `IAT/GeoPR · ZEE-PR (zee_declividade) · ${FONTE_MANCHA}`,
    });
  },
});

const declSpec = geoprSpec({
  id: 'datageo-declividade',
  sufixo: 'declividade',
  name: 'Declividade · ZEE-PR',
  icon: '📐',
  source: 'IAT/GeoPR · ZEE-PR (zee_declividade), ao vivo',
  fontes: [{ servico: 'zee_declividade' }],
  opacity: 0.55,
});

export const declividadeLayer = defineLayer({
  ...declSpec,
  sources: { ...declSpec.sources, ...decl.sources },
  layers: [...declSpec.layers, ...decl.layers],
  interactive: decl.interactive,
  hoverYield: true,
  tooltip: decl.tooltip,
  onEnable: (ctx) => decl.ligar(ctx),
  onDisable: (ctx) => decl.desligar(ctx),
  rowControls: () => ({
    legend: [
      ...DECLIVIDADE.map(({ label, color }) => ({ label, color })),
      ...(decl.estado.ibge ? [] : [{ label: 'Clique num município para ver a área de cada polígono', color: '#64748b' }]),
    ],
  }),
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

const uso = manchasDoMunicipio({
  prefixo: 'uso-solo',
  cores: USO_SOLO,
  png: (ibge) => `/data/uso-solo/${ibge}.png`,
  dados: async (ibge) => {
    const m = (await loadAspectosFisicos()).municipios?.[ibge];
    return m?.usoBbox ? { bbox: m.usoBbox, classes: m.uso ?? {} } : null;
  },
  aoTrocar: (st) => {
    st.ctx.map.getSource(USO_SRC)?.updateImage(st.m
      ? { url: `/data/uso-solo/${st.ibge}.png`, coordinates: cantos(st.m.bbox) }
      : { url: VAZIO, coordinates: cantos(PR) });
  },
  tooltip: ({ classe, ha }, st) => {
    const haClasse = st.m.classes[classe] ?? 0;
    return tipCard({
      icon: '🌾',
      title: classe,
      subtitle: `Uso do solo · ${st.nome ?? ''}`,
      rows: [
        ['Área deste polígono', `≈ ${haTxt(ha)}`],
        ['Classe no município', `${fmtInt(haClasse)} ha${pctTxt(haClasse, somaHa(st.m.classes))}`],
      ],
      source: `IAT/GeoPR · Uso e Cobertura da Terra 2012-2016 (nível II) · ${FONTE_MANCHA}`,
    });
  },
});

export const carregaUso = uso.selecionar;

export const usoSoloLayer = defineLayer({
  id: 'datageo-uso-solo',
  name: 'Uso do solo · IAT 2012-2016 (município selecionado)',
  category: CATEGORY,
  icon: '🌾',
  source: 'IAT/GeoPR · Mapeamento de Uso e Cobertura da Terra 2012-2016 (nível II, 30 m)',
  sources: { [USO_SRC]: { type: 'image', url: VAZIO, coordinates: cantos(PR) }, ...uso.sources },
  layers: [
    { id: 'dg-uso-solo-img', type: 'raster', source: USO_SRC,
      paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
    ...uso.layers,
  ],
  interactive: uso.interactive,
  // A área cobre o município inteiro: terras indígenas, CAR etc. ligados por
  // cima ou por baixo mantêm o tooltip; o uso do solo vence só as bases.
  hoverYield: true,
  tooltip: uso.tooltip,
  onEnable: (ctx) => uso.ligar(ctx),
  onDisable: (ctx) => uso.desligar(ctx),
  rowControls: () => {
    const st = uso.estado;
    if (!st.ibge) return { legend: [{ label: 'Clique num município para ver o uso do solo', color: '#64748b' }] };
    if (!st.m) return { legend: [{ label: `Sem uso do solo para ${st.nome}`, color: '#64748b' }] };
    return {
      legend: Object.entries(st.m.classes).sort((x, y) => y[1] - x[1])
        .map(([classe, ha]) => ({ label: classe, color: USO_SOLO[classe] ?? '#94a3b8', count: `${fmtInt(ha)} ha` })),
    };
  },
});

export default [altimetriaLayer, declividadeLayer, hidrografiaLayer, nascentesLayer, curvasLayer, usoSoloLayer];
