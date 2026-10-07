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
  CORES_ALTITUDE, DECLIVIDADE, FAIXAS_ALTITUDE, USO_SOLO, loadAspectosFisicos, rotuloFaixa,
} from '../../data/aspectosFisicos.js';
import { getMunicipioSelecionado, MUNICIPIO_SELECIONADO_EVENT } from '../../datageoFicha.js';
import { EMPTY_FC, defineLayer, fmtInt, tipCard } from '../kit.js';
import { MUNICIPIOS_URL } from './municipios.js';
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
const USO_AREA = 'dg-uso-solo-area';
const USO_CONTORNO = 'dg-uso-solo-contorno';
const uso = {
  ctx: null, ibge: null, nome: null, classes: [], seq: 0, semDado: false,
  bbox: null, img: null, lngLat: null, realce: 0, tipVisto: false,
};

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * Pixel [x, y] do PNG (Web Mercator, cantos [w, s, e, n]) sob [lon, lat],
 * ou null fora da imagem. Mesma conta do image source do MapLibre.
 */
export function pixelDe([lon, lat], [w, s, e, n], [largura, altura]) {
  const x = Math.floor(((lon - w) / (e - w)) * largura);
  const y = Math.floor(((mercY(n) - mercY(lat)) / (mercY(n) - mercY(s))) * altura);
  return x >= 0 && y >= 0 && x < largura && y < altura ? [x, y] : null;
}

// A paleta do PNG usa exatamente as cores de USO_SOLO: cor do pixel -> classe.
const CLASSE_DA_COR = new Map(Object.entries(USO_SOLO).map(([classe, cor]) => [cor.toLowerCase(), classe]));
const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Manchas: pixels vizinhos da mesma cor viram um polígono, inclusive na
 * diagonal (8-conexos: rio e estrada finos em diagonal saem do raster como
 * escada de pixels que só se tocam pelo canto). Devolve
 * o rótulo de cada pixel (0 = transparente) e quantas manchas há.
 * @param {Uint8ClampedArray} rgba  pixels RGBA, linha a linha
 */
export function rotulaManchas(rgba, w, h) {
  const n = w * h;
  const cor = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    cor[i] = rgba[k + 3] ? ((rgba[k] << 16) | (rgba[k + 1] << 8) | rgba[k + 2]) + 1 : 0;
  }
  const rotulo = new Int32Array(n);
  const pilha = new Int32Array(n);
  let manchas = 0;
  const empilha = (j, c, topo) => {
    if (cor[j] === c && !rotulo[j]) {
      rotulo[j] = manchas;
      pilha[topo++] = j;
    }
    return topo;
  };
  for (let i0 = 0; i0 < n; i0++) {
    if (!cor[i0] || rotulo[i0]) continue;
    const c = cor[i0];
    rotulo[i0] = ++manchas;
    let topo = 0;
    pilha[topo++] = i0;
    while (topo) {
      const i = pilha[--topo];
      const x = i % w;
      if (x > 0) topo = empilha(i - 1, c, topo);
      if (x < w - 1) topo = empilha(i + 1, c, topo);
      if (i >= w) topo = empilha(i - w, c, topo);
      if (i < n - w) topo = empilha(i + w, c, topo);
      if (i >= w && x > 0) topo = empilha(i - w - 1, c, topo);
      if (i >= w && x < w - 1) topo = empilha(i - w + 1, c, topo);
      if (i < n - w && x > 0) topo = empilha(i + w - 1, c, topo);
      if (i < n - w && x < w - 1) topo = empilha(i + w + 1, c, topo);
    }
  }
  return { rotulo, manchas };
}

/**
 * Área (ha) de cada mancha, indexada pelo rótulo. O pixel é constante em Web
 * Mercator; no chão ele encolhe com cos(lat), então cada linha tem sua área.
 */
export function areasManchas({ rotulo, manchas }, w, h, [oeste, sul, leste, norte]) {
  const R = 6378137;
  const yN = mercY(norte);
  const yS = mercY(sul);
  const largPx = (R * (((leste - oeste) * Math.PI) / 180)) / w;
  const altPx = (R * (yN - yS)) / h;
  const ha = new Float64Array(manchas + 1);
  for (let y = 0; y < h; y++) {
    const lat = 2 * Math.atan(Math.exp(yN - ((y + 0.5) / h) * (yN - yS))) - Math.PI / 2;
    const pxHa = (largPx * altPx * Math.cos(lat) ** 2) / 1e4;
    for (let i = y * w, fim = i + w; i < fim; i++) if (rotulo[i]) ha[rotulo[i]] += pxHa;
  }
  return ha;
}

/** Retângulo [x0, y0, x1, y1] (pixels, inclusivo) de cada mancha: o contorno só varre ali. */
export function caixasManchas({ rotulo, manchas }, w, h) {
  const cx = new Int32Array((manchas + 1) * 4);
  for (let r = 1; r <= manchas; r++) cx.set([w, h, -1, -1], r * 4);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const k = rotulo[i] * 4;
      if (!k) continue;
      if (x < cx[k]) cx[k] = x;
      if (y < cx[k + 1]) cx[k + 1] = y;
      if (x > cx[k + 2]) cx[k + 2] = x;
      if (y > cx[k + 3]) cx[k + 3] = y;
    }
  }
  return cx;
}

/**
 * Contorno da mancha `r` como segmentos em coordenadas de pixel (cantos):
 * cada aresta entre um pixel da mancha e um de fora, com as arestas em linha
 * emendadas num segmento só. Em diagonal cada degrau ainda é um segmento: a
 * maior mancha do estado passa de 60 mil, por isso encadeia + simplifica.
 * @returns {Array<[[number, number], [number, number]]>}
 */
export function contornoPixels(rotulo, w, h, caixa, r) {
  const [x0, y0, x1, y1] = caixa;
  const em = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rotulo[y * w + x] === r;
  const seg = [];
  // Arestas horizontais: topo (vizinho de cima fora) e base, por linha.
  for (let y = y0; y <= y1 + 1; y++) {
    for (const lado of [-1, 0]) { // -1: topo da linha y; 0: base da linha y - 1
      let ini = -1;
      for (let x = x0; x <= x1 + 1; x++) {
        const dentro = lado < 0 ? em(x, y) && !em(x, y - 1) : em(x, y - 1) && !em(x, y);
        if (dentro && ini < 0) ini = x;
        if (!dentro && ini >= 0) {
          seg.push([[ini, y], [x, y]]);
          ini = -1;
        }
      }
    }
  }
  // Arestas verticais: esquerda e direita, por coluna.
  for (let x = x0; x <= x1 + 1; x++) {
    for (const lado of [-1, 0]) {
      let ini = -1;
      for (let y = y0; y <= y1 + 1; y++) {
        const dentro = lado < 0 ? em(x, y) && !em(x - 1, y) : em(x - 1, y) && !em(x, y);
        if (dentro && ini < 0) ini = y;
        if (!dentro && ini >= 0) {
          seg.push([[x, ini], [x, y]]);
          ini = -1;
        }
      }
    }
  }
  return seg;
}

/**
 * Emenda os segmentos do contorno em linhas contínuas (anéis, nos polígonos
 * fechados): cada canto de pixel liga a próxima aresta pela ponta.
 * @returns {Array<Array<[number, number]>>}
 */
export function encadeia(segs) {
  // Lista de pontas por canto em arrays: ponta e = 2*segmento + lado.
  const chave = ([x, y]) => y * 1e6 + x; // cantos de pixel são inteiros < 1e6
  const cabeca = new Map();
  const prox = new Int32Array(segs.length * 2);
  segs.forEach((s, i) => {
    for (let lado = 0; lado < 2; lado++) {
      const k = chave(s[lado]);
      const e = i * 2 + lado;
      prox[e] = cabeca.get(k) ?? -1;
      cabeca.set(k, e);
    }
  });
  const usado = new Uint8Array(segs.length);
  const anda = (linha, ponta) => {
    for (;;) {
      let e = cabeca.get(chave(ponta)) ?? -1;
      while (e >= 0 && usado[e >> 1]) e = prox[e];
      if (e < 0) return;
      usado[e >> 1] = 1;
      ponta = segs[e >> 1][1 - (e & 1)]; // a outra ponta do segmento
      linha.push(ponta);
    }
  };
  const linhas = [];
  for (let i = 0; i < segs.length; i++) {
    if (usado[i]) continue;
    usado[i] = 1;
    const [a, b] = segs[i];
    const frente = [a, b];
    anda(frente, b);
    const tras = [a];
    anda(tras, a);
    linhas.push([...tras.reverse(), ...frente.slice(1)]);
  }
  return linhas;
}

/** Douglas-Peucker (tolerância em pixels): a escada dos pixels vira reta. */
export function simplifica(linha, tol) {
  if (linha.length < 3) return linha;
  const manter = new Uint8Array(linha.length);
  manter[0] = 1;
  manter[linha.length - 1] = 1;
  const pilha = [[0, linha.length - 1]];
  while (pilha.length) {
    const [i0, i1] = pilha.pop();
    const [ax, ay] = linha[i0];
    const [bx, by] = linha[i1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maior = -1;
    let iMaior = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = linha[i];
      const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > maior) {
        maior = d;
        iMaior = i;
      }
    }
    if (maior > tol) {
      manter[iMaior] = 1;
      pilha.push([i0, iMaior], [iMaior, i1]);
    }
  }
  return linha.filter((_, i) => manter[i]);
}

/** Canto de pixel (x, y) -> [lon, lat] na imagem em Web Mercator. */
export function cantoLonLat(x, y, w, h, [oeste, sul, leste, norte]) {
  const yN = mercY(norte);
  const ym = yN - (y / h) * (yN - mercY(sul));
  return [oeste + (x / w) * (leste - oeste), (360 / Math.PI) * Math.atan(Math.exp(ym)) - 90];
}

/** Classe e área da mancha sob [lon, lat], ou null (fora, transparente, PNG ainda carregando). */
function usoEm(lngLat) {
  const { img, bbox } = uso;
  if (!img || !bbox || !lngLat) return null;
  const p = pixelDe(lngLat, bbox, [img.w, img.h]);
  if (!p) return null;
  const i = p[1] * img.w + p[0];
  const k = i * 4;
  if (!img.data[k + 3]) return null;
  const classe = CLASSE_DA_COR.get(hex(img.data[k], img.data[k + 1], img.data[k + 2]));
  const r = img.manchas.rotulo[i];
  return classe ? { classe, ha: img.ha[r], r } : null;
}

/**
 * Pixels do PNG e as manchas dele, para o tooltip. Uma vez por município.
 */
function lePixels(url, bbox) {
  return new Promise((resolve, reject) => {
    const imagem = new Image();
    imagem.onload = () => {
      const w = imagem.naturalWidth;
      const h = imagem.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext('2d', { willReadFrequently: true });
      c2d.drawImage(imagem, 0, 0);
      const { data } = c2d.getImageData(0, 0, w, h);
      // ponytail: rótulo na thread principal, uma vez por município; Worker se travar o mapa.
      const manchas = rotulaManchas(data, w, h);
      resolve({
        data, w, h, manchas, ha: areasManchas(manchas, w, h, bbox), caixas: caixasManchas(manchas, w, h), contornos: new Map(),
      });
    };
    imagem.onerror = () => reject(new Error(`${url}: imagem não carregou`));
    imagem.src = url;
  });
}

let _malha = null;
/** Divisa do município (a mesma malha da camada Municípios; o navegador já tem em cache). */
async function divisa(ibge) {
  _malha ??= fetch(MUNICIPIOS_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((err) => {
      _malha = null;
      throw err;
    });
  return (await _malha).features.find((f) => String(f.properties.CD_MUN) === ibge) ?? null;
}

/** Mostra o PNG do município (ou nada) e a legenda com os hectares da ficha. */
export async function carregaUso(sel) {
  // Clicar no próprio município reabre a ficha e reanuncia a mesma seleção:
  // a imagem e as manchas já estão aqui (ou chegando).
  if (sel?.ibge && sel.ibge === uso.ibge && uso.ctx) return;
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
  uso.bbox = m?.usoBbox ?? null;
  uso.img = null;
  uso.classes = Object.entries(m?.uso ?? {}).map(([classe, ha]) => ({ classe, ha })).sort((a, b) => b.ha - a.ha);
  uso.ctx.map.getSource(USO_SRC)?.updateImage(m?.usoBbox
    ? { url: `/data/uso-solo/${uso.ibge}.png`, coordinates: cantos(m.usoBbox) }
    : { url: VAZIO, coordinates: cantos(PR) });
  uso.ctx.setData(USO_AREA, EMPTY_FC);
  realca(0);
  uso.ctx.refreshPanel();
  if (!uso.bbox) return;
  // Tooltip: a área do município responde ao hover e o pixel do PNG diz a classe.
  // Falha aqui só tira o tooltip; o desenho já está no mapa.
  try {
    const url = `/data/uso-solo/${uso.ibge}.png`;
    const [area, img] = await Promise.all([divisa(uso.ibge), lePixels(url, uso.bbox)]);
    if (seq !== uso.seq || !uso.ctx) return;
    uso.img = img;
    if (area) uso.ctx.setData(USO_AREA, { type: 'FeatureCollection', features: [area] });
  } catch (err) {
    console.warn('[maplibre:datageo-uso-solo] tooltip indisponível', err);
  }
}

/** Desenha o contorno da mancha `r` (0 apaga). Só refaz quando a mancha muda. */
function realca(r) {
  if (r === uso.realce || !uso.ctx) return;
  uso.realce = r;
  const { img, bbox } = uso;
  if (!r || !img) {
    uso.ctx.setData(USO_CONTORNO, EMPTY_FC);
    return;
  }
  let fc = img.contornos.get(r);
  if (!fc) {
    const caixa = img.caixas.subarray(r * 4, r * 4 + 4);
    const linhas = encadeia(contornoPixels(img.manchas.rotulo, img.w, img.h, caixa, r))
      .map((l) => simplifica(l, 1).map(([x, y]) => cantoLonLat(x, y, img.w, img.h, bbox)));
    fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: linhas } }],
    };
    // ponytail: cache sem limite de tamanho por município; LRU se a memória pesar.
    img.contornos.set(r, fc);
  }
  uso.ctx.setData(USO_CONTORNO, fc);
}

// O contorno acompanha o tooltip: o anfitrião chama usoTooltip no quadro do
// mousemove (o rAF dele vem antes deste); se ele não chamou, ou outra camada
// venceu o hover, o contorno some.
const onMouse = (e) => {
  uso.lngLat = [e.lngLat.lng, e.lngLat.lat];
  uso.tipVisto = false;
  requestAnimationFrame(() => {
    if (!uso.tipVisto) realca(0);
  });
};
const onSai = () => realca(0);

function usoTooltip() {
  const aqui = usoEm(uso.lngLat);
  if (!aqui) return '';
  uso.tipVisto = true;
  realca(aqui.r);
  const total = uso.classes.reduce((a, c) => a + c.ha, 0);
  const haClasse = uso.classes.find((c) => c.classe === aqui.classe)?.ha ?? 0;
  const ha = (v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ha`;
  const pct = total ? ` (${((haClasse / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)` : '';
  return tipCard({
    icon: '🌾',
    title: aqui.classe,
    subtitle: `Uso do solo · ${uso.nome ?? ''}`,
    rows: [
      ['Área deste polígono', `≈ ${ha(aqui.ha)}`],
      ['Classe no município', `${fmtInt(haClasse)} ha${pct}`],
    ],
    source: 'IAT/GeoPR · Uso e Cobertura da Terra 2012-2016 (nível II) · polígono = mancha contínua da classe em pixels de 30 m, recortada na divisa',
  });
}

const onSelecao = (e) => carregaUso(e.detail);

export const usoSoloLayer = defineLayer({
  id: 'datageo-uso-solo',
  name: 'Uso do solo · IAT 2012-2016 (município selecionado)',
  category: CATEGORY,
  icon: '🌾',
  source: 'IAT/GeoPR · Mapeamento de Uso e Cobertura da Terra 2012-2016 (nível II, 30 m)',
  sources: {
    [USO_SRC]: { type: 'image', url: VAZIO, coordinates: cantos(PR) },
    [USO_AREA]: { type: 'geojson', data: EMPTY_FC },
    [USO_CONTORNO]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    { id: 'dg-uso-solo-img', type: 'raster', source: USO_SRC,
      paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
    // Invisível: só dá ao hover um alvo dentro da divisa (raster não é consultável).
    { id: 'dg-uso-solo-area', type: 'fill', source: USO_AREA, paint: { 'fill-color': '#000000', 'fill-opacity': 0 } },
    // Contorno do polígono do tooltip: halo escuro + linha clara, legível sobre qualquer classe.
    { id: 'dg-uso-solo-contorno-halo', type: 'line', source: USO_CONTORNO,
      paint: { 'line-color': 'rgba(5,8,13,0.85)', 'line-width': 4.5 } },
    { id: 'dg-uso-solo-contorno', type: 'line', source: USO_CONTORNO,
      paint: { 'line-color': '#fde047', 'line-width': 2 } },
  ],
  interactive: ['dg-uso-solo-area'],
  // A área cobre o município inteiro: terras indígenas, CAR etc. ligados por
  // cima ou por baixo mantêm o tooltip; o uso do solo vence só as bases.
  hoverYield: true,
  tooltip: usoTooltip,
  onEnable(ctx) {
    uso.ctx = ctx;
    ctx.map.off('mousemove', onMouse);
    ctx.map.on('mousemove', onMouse);
    ctx.map.off('mouseout', onSai);
    ctx.map.on('mouseout', onSai);
    document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    document.addEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    carregaUso(getMunicipioSelecionado());
  },
  onDisable(ctx) {
    realca(0);
    ctx.map.off('mousemove', onMouse);
    ctx.map.off('mouseout', onSai);
    document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
    uso.ctx = null;
    uso.img = null;
    uso.ibge = null; // religar no mesmo município tem que recarregar (a guarda de carregaUso)
    uso.seq++;
  },
  rowControls: () => {
    if (!uso.ibge) return { legend: [{ label: 'Clique num município para ver o uso do solo', color: '#64748b' }] };
    if (uso.semDado) return { legend: [{ label: `Sem uso do solo para ${uso.nome}`, color: '#64748b' }] };
    return { legend: uso.classes.map(({ classe, ha }) => ({ label: classe, color: USO_SOLO[classe] ?? '#94a3b8', count: `${fmtInt(ha)} ha` })) };
  },
});

export default [altimetriaLayer, declividadeLayer, hidrografiaLayer, nascentesLayer, curvasLayer, usoSoloLayer];
