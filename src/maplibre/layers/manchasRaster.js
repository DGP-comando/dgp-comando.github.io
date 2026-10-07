// src/maplibre/layers/manchasRaster.js
//
// Tooltip com área e contorno sobre um PNG de classes por município (uso do
// solo, declividade). O PNG está em Web Mercator com cantos conhecidos: a cor
// do pixel sob o cursor diz a classe; as manchas (pixels vizinhos da mesma
// cor) são rotuladas uma vez por município, e cada uma tem área e contorno.
// O hover precisa de uma feição: um polígono invisível com a divisa do
// município (raster não responde a queryRenderedFeatures).

import { getMunicipioSelecionado, MUNICIPIO_SELECIONADO_EVENT } from '../../datageoFicha.js';
import { EMPTY_FC } from '../kit.js';
import { MUNICIPIOS_URL } from './municipios.js';

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

/**
 * Tooltip com a área e o contorno da mancha sob o cursor, lidos de um PNG por
 * município (a cor do pixel diz a classe; a paleta é `cores`). Devolve os
 * pedaços que a camada compõe: fontes e layers (alvo do hover invisível com a
 * divisa e o contorno), tooltip, ligar/desligar e o estado para a legenda.
 *
 *   prefixo   ids `dg-${prefixo}-area` e `dg-${prefixo}-contorno`
 *   png       (ibge) => url do PNG
 *   dados     async (ibge) => {bbox, ...} do município, ou null sem dado
 *   tooltip   ({classe, ha}, estado) => html do cartão
 *   aoTrocar  (estado) => void, depois de cada troca de município (ex.: desenho)
 */
export function manchasDoMunicipio({ prefixo, cores, png, dados, tooltip, aoTrocar = () => {} }) {
  const AREA = `dg-${prefixo}-area`;
  const CONTORNO = `dg-${prefixo}-contorno`;
  const classeDaCor = new Map(Object.entries(cores).map(([classe, cor]) => [cor.toLowerCase(), classe]));
  const st = {
    ctx: null, ibge: null, nome: null, m: null, seq: 0, img: null, lngLat: null, realce: 0, tipVisto: false,
  };

  /** Classe, área e rótulo da mancha sob [lon, lat], ou null (fora, transparente, PNG chegando). */
  function manchaEm(lngLat) {
    const { img } = st;
    const bbox = st.m?.bbox;
    if (!img || !bbox || !lngLat) return null;
    const p = pixelDe(lngLat, bbox, [img.w, img.h]);
    if (!p) return null;
    const i = p[1] * img.w + p[0];
    const k = i * 4;
    if (!img.data[k + 3]) return null;
    const classe = classeDaCor.get(hex(img.data[k], img.data[k + 1], img.data[k + 2]));
    const r = img.manchas.rotulo[i];
    return classe ? { classe, ha: img.ha[r], r } : null;
  }

  /** Desenha o contorno da mancha `r` (0 apaga). Só refaz quando a mancha muda; em cache por mancha. */
  function realca(r) {
    if (r === st.realce || !st.ctx) return;
    st.realce = r;
    const { img } = st;
    if (!r || !img) {
      st.ctx.setData(CONTORNO, EMPTY_FC);
      return;
    }
    let fc = img.contornos.get(r);
    if (!fc) {
      const caixa = img.caixas.subarray(r * 4, r * 4 + 4);
      const linhas = encadeia(contornoPixels(img.manchas.rotulo, img.w, img.h, caixa, r))
        .map((l) => simplifica(l, 1).map(([x, y]) => cantoLonLat(x, y, img.w, img.h, st.m.bbox)));
      fc = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: linhas } }],
      };
      // ponytail: cache sem limite de tamanho por município; LRU se a memória pesar.
      img.contornos.set(r, fc);
    }
    st.ctx.setData(CONTORNO, fc);
  }

  async function selecionar(sel) {
    // Clicar no próprio município reabre a ficha e reanuncia a mesma seleção:
    // a imagem e as manchas já estão aqui (ou chegando).
    if (sel?.ibge && sel.ibge === st.ibge && st.ctx) return;
    const seq = ++st.seq;
    st.ibge = sel?.ibge && /^\d{7}$/.test(sel.ibge) ? sel.ibge : null;
    st.nome = sel?.nome ?? null;
    let m = null;
    if (st.ibge) {
      try {
        m = await dados(st.ibge);
      } catch (err) {
        console.warn(`[maplibre:${prefixo}]`, err);
      }
    }
    if (seq !== st.seq || !st.ctx) return;
    st.m = m;
    st.img = null;
    st.ctx.setData(AREA, EMPTY_FC);
    realca(0);
    aoTrocar(st);
    st.ctx.refreshPanel();
    if (!m?.bbox) return;
    // Falha aqui só tira o tooltip; o que a camada desenha não depende disto.
    try {
      const [area, img] = await Promise.all([divisa(st.ibge), lePixels(png(st.ibge), m.bbox)]);
      if (seq !== st.seq || !st.ctx) return;
      st.img = img;
      if (area) st.ctx.setData(AREA, { type: 'FeatureCollection', features: [area] });
    } catch (err) {
      console.warn(`[maplibre:${prefixo}] tooltip indisponível`, err);
    }
  }

  // O contorno acompanha o tooltip: o anfitrião chama o tooltip no quadro do
  // mousemove (o rAF dele vem antes deste); se não chamou, ou outra camada
  // venceu o hover, o contorno some.
  const onMouse = (e) => {
    st.lngLat = [e.lngLat.lng, e.lngLat.lat];
    st.tipVisto = false;
    requestAnimationFrame(() => {
      if (!st.tipVisto) realca(0);
    });
  };
  const onSai = () => realca(0);
  const onSelecao = (e) => selecionar(e.detail);

  return {
    estado: st,
    selecionar,
    sources: {
      [AREA]: { type: 'geojson', data: EMPTY_FC },
      [CONTORNO]: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      // Invisível: só dá ao hover um alvo dentro da divisa (raster não é consultável).
      { id: AREA, type: 'fill', source: AREA, paint: { 'fill-color': '#000000', 'fill-opacity': 0 } },
      // Contorno do polígono do tooltip: halo escuro + linha clara, legível sobre qualquer classe.
      { id: `${CONTORNO}-halo`, type: 'line', source: CONTORNO, paint: { 'line-color': 'rgba(5,8,13,0.85)', 'line-width': 4.5 } },
      { id: CONTORNO, type: 'line', source: CONTORNO, paint: { 'line-color': '#fde047', 'line-width': 2 } },
    ],
    interactive: [AREA],
    tooltip() {
      const aqui = manchaEm(st.lngLat);
      if (!aqui) return '';
      st.tipVisto = true;
      realca(aqui.r);
      return tooltip(aqui, st);
    },
    ligar(ctx) {
      st.ctx = ctx;
      ctx.map.off('mousemove', onMouse);
      ctx.map.on('mousemove', onMouse);
      ctx.map.off('mouseout', onSai);
      ctx.map.on('mouseout', onSai);
      document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
      document.addEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
      return selecionar(getMunicipioSelecionado());
    },
    desligar(ctx) {
      realca(0);
      ctx.map.off('mousemove', onMouse);
      ctx.map.off('mouseout', onSai);
      document.removeEventListener(MUNICIPIO_SELECIONADO_EVENT, onSelecao);
      st.ctx = null;
      st.img = null;
      st.ibge = null; // religar no mesmo município tem que recarregar (a guarda de selecionar)
      st.seq++;
    },
  };
}
