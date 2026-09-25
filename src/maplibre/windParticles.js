// src/maplibre/windParticles.js
//
// Campo de partículas de vento do protótipo MapLibre, no lugar do
// cesium-wind-layer do app. Mesma física e mesmo visual (src/data/ventosOptions.js):
//
//   - 64² = 4096 partículas soltas no recorte da grade u/v (linha 0 = SUL);
//   - advecção Runge-Kutta 2 com o vento bilinear, deslocamento por quadro de
//     0,5 · |v| · (pixelSize + 50) · speedFactor metros, onde pixelSize é o da
//     lib: 1000 × fração visível da grade (libPixelSize). Velocidade de TELA
//     quase constante em qualquer zoom, como no app;
//   - descarte aleatório por quadro dropRate + 0,01 · velocidade normalizada, e
//     renascimento em ponto aleatório da grade ao sair dela;
//   - cada partícula é um traço de lineLength · pixelSize metros (30–120 px
//     com a grade inteira na tela a ~1 km/px) na direção do movimento, largura lineWidth (1–2,4 px), transparente atrás e opaco na
//     frente, cor da rampa `colors` pela velocidade normalizada.
//
// DESENHO: canvas 2D sobreposto ao canvas do mapa (pointer-events: none).
// Projetar 4096 partículas por quadro com map.project no globo seria caro; em
// vez disso uma malha 2x mais fina que a grade é projetada (≈1.250 pontos, só
// quando a câmera muda) e cada partícula interpola a posição de tela na célula
// da malha. Em Mercator a malha é quase linear; no globo, suave o bastante na
// escala do estado. Funciona igual nas duas projeções.
//
// Sincronia com a câmera: o passo da física roda no requestAnimationFrame; com
// o mapa em movimento o traço é redesenhado no evento `render` do próprio mapa
// (depois do quadro dele), para as partículas não "escorregarem" um quadro
// atrás no arraste. Parado, o rAF desenha sozinho e o mapa não re-renderiza.
// Aba escondida ou camada desligada: rAF cancelado.

import { WIND_PARTICLE_STYLE } from '../data/ventosOptions.js';

// ------------------------------------------------------------ funções puras

/**
 * Vento (u, v) em m/s no ponto, bilinear entre os nós da grade. Fora do
 * recorte devolve null. Grade no formato do cesium-wind-layer.
 * @param {{u: {array: ArrayLike<number>}, v: {array: ArrayLike<number>}, width: number, height: number, bounds: object}} grid
 */
export function windAt(grid, lon, lat) {
  const { width, height, bounds } = grid;
  const fx = ((lon - bounds.west) / (bounds.east - bounds.west)) * (width - 1);
  const fy = ((lat - bounds.south) / (bounds.north - bounds.south)) * (height - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= width - 1 && fy <= height - 1)) return null;
  const i = Math.min(width - 2, Math.floor(fx));
  const j = Math.min(height - 2, Math.floor(fy));
  const s = fx - i;
  const t = fy - j;
  const U = grid.u.array;
  const V = grid.v.array;
  const k00 = j * width + i;
  const k10 = k00 + 1;
  const k01 = k00 + width;
  const k11 = k01 + 1;
  const u = (U[k00] * (1 - s) + U[k10] * s) * (1 - t) + (U[k01] * (1 - s) + U[k11] * s) * t;
  const v = (V[k00] * (1 - s) + V[k10] * s) * (1 - t) + (V[k01] * (1 - s) + V[k11] * s) * t;
  return [u, v];
}

/** Metros por grau de longitude e de latitude (mesma série da lib). */
export function metersPerDegree(lat) {
  const r = lat * (Math.PI / 180);
  const latLen = 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r) - 0.0023 * Math.cos(6 * r);
  const lonLen = 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) + 0.118 * Math.cos(5 * r);
  return [lonLen, latLen];
}

/** Velocidade mínima e máxima da grade (m/s), o domínio da rampa. */
export function speedRange(grid) {
  const U = grid.u.array;
  const V = grid.v.array;
  let min = Infinity;
  let max = 0;
  for (let k = 0; k < U.length; k += 1) {
    const s = Math.hypot(U[k], V[k]);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

/**
 * Um passo de advecção (RK2 de ponto médio, como calculateSpeedByRungeKutta2
 * da lib). `scale` = (m/px + 50) · speedFactor; `frames` corrige a taxa de
 * quadros (1 = 60 fps). Devolve [lon, lat, |v| na origem] ou null se sair da
 * grade ou o vento for nulo.
 */
export function advect(grid, lon, lat, scale, frames = 1) {
  const h = 0.5;
  const f0 = windAt(grid, lon, lat);
  if (!f0) return null;
  const speed = Math.hypot(f0[0], f0[1]);
  if (speed === 0) return null;
  const [mLon, mLat] = metersPerDegree(lat);
  const midLon = lon + (0.5 * h * f0[0] * scale) / mLon;
  const midLat = lat + (0.5 * h * f0[1] * scale) / mLat;
  const f1 = windAt(grid, midLon, midLat) ?? f0;
  const nextLon = lon + ((h * f1[0] * scale) / mLon) * frames;
  const nextLat = lat + ((h * f1[1] * scale) / mLat) * frames;
  return [nextLon, nextLat, speed];
}

/**
 * `pixelSize` do cesium-wind-layer: 1000 × a menor fração (lon ou lat) da
 * grade que está na tela, com 5% de folga. null se a grade está fora da vista.
 * @param {{west: number, south: number, east: number, north: number}} view
 * @param {{west: number, south: number, east: number, north: number}} data
 */
export function libPixelSize(view, data) {
  let w = Math.max(data.west, view.west);
  let e = Math.min(data.east, view.east);
  let s = Math.max(data.south, view.south);
  let n = Math.min(data.north, view.north);
  if (!(e > w && n > s)) return null;
  const bLon = (e - w) * 0.05;
  const bLat = (n - s) * 0.05;
  w = Math.max(data.west, w - bLon);
  e = Math.min(data.east, e + bLon);
  s = Math.max(data.south, s - bLat);
  n = Math.min(data.north, n + bLat);
  const ratio = Math.min((e - w) / (data.east - data.west), (n - s) / (data.north - data.south));
  return Math.max(0, Math.min(1000, 1000 * ratio));
}

/** Metros por pixel CSS no zoom/latitude do MapLibre (tiles de 512 px). */
export function metersPerPixel(zoom, lat) {
  return (40075016.686 * Math.cos(lat * (Math.PI / 180))) / (512 * 2 ** zoom);
}

function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/**
 * Cor da rampa numa velocidade normalizada 0..1, amostrada como a textura
 * colorTable da lib (LINEAR, CLAMP_TO_EDGE, centros de texel em (i+0,5)/n).
 * @returns {[number, number, number]}
 */
export function rampColor(colors, norm) {
  const n = colors.length;
  const x = Math.min(n - 1, Math.max(0, Math.min(1, Math.max(0, norm)) * n - 0.5));
  const i = Math.min(n - 2, Math.floor(x));
  if (n === 1) return hexRgb(colors[0]);
  const t = x - i;
  const a = hexRgb(colors[i]);
  const b = hexRgb(colors[i + 1]);
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * t));
}

/** Opacidade ao longo do traço (0 = cauda, 1 = frente), como o shader da lib. */
export function trailAlpha(s) {
  const x = Math.min(1, Math.max(0, s));
  return (x * x * (3 - 2 * x)) ** 1.5;
}

/**
 * Nó (fracionário) da malha de projeção para um ponto: devolve o índice da
 * célula e os pesos, ou null fora da malha.
 */
export function latticeCell(lat0, lon0, dLat, dLon, nx, ny, lon, lat) {
  const fx = (lon - lon0) / dLon;
  const fy = (lat - lat0) / dLat;
  if (!(fx >= 0 && fy >= 0 && fx <= nx - 1 && fy <= ny - 1)) return null;
  const i = Math.min(nx - 2, Math.floor(fx));
  const j = Math.min(ny - 2, Math.floor(fy));
  return { i, j, s: fx - i, t: fy - j };
}

// ------------------------------------------------------------- sobreposição

const BINS = 8; // faixas de velocidade: uma cor/largura por faixa
const PIECES = 3; // o traço em 3 trechos de opacidade crescente
const DROP_RATE_BUMP = 0.01; // default da lib (o app não sobrescreve)
const MAX_FRAMES = 3; // teto do passo após uma pausa longa

export class WindParticleField {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {object} [style] opções no formato do cesium-wind-layer
   */
  constructor(map, style = WIND_PARTICLE_STYLE) {
    this.map = map;
    this.style = style;
    this.count = style.particlesTextureSize ** 2;
    this.grid = null;
    this.running = false;
    this.raf = null;
    this.lastT = 0;
    this.canvas = null;
    this.latticeKey = '';
    this.pixelSize = 1000;
    this.lengthScale = 1;
    this.binStyle = [];
    for (let b = 0; b < BINS; b += 1) {
      const norm = (b + 0.5) / BINS;
      const [r, g, bl] = rampColor(style.colors, norm);
      this.binStyle.push({
        norm,
        color: `rgb(${r},${g},${bl})`,
        width: style.lineWidth.min + (style.lineWidth.max - style.lineWidth.min) * norm,
        speedAlpha: 0.3 + 0.7 * norm,
      });
    }
    this.onFrame = this.onFrame.bind(this);
    this.onRender = this.onRender.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
  }

  setData(grid) {
    this.grid = grid;
    const { min, max } = speedRange(grid);
    this.domain = { min, max: max > min ? max : min + 1 };
    // Malha de projeção 2x mais fina que a grade.
    this.nx = (grid.width - 1) * 2 + 1;
    this.ny = (grid.height - 1) * 2 + 1;
    this.lon0 = grid.bounds.west;
    this.lat0 = grid.bounds.south;
    this.dLon = (grid.bounds.east - grid.bounds.west) / (this.nx - 1);
    this.dLat = (grid.bounds.north - grid.bounds.south) / (this.ny - 1);
    this.sx = new Float32Array(this.nx * this.ny);
    this.sy = new Float32Array(this.nx * this.ny);
    this.ok = new Uint8Array(this.nx * this.ny);
    this.latticeKey = '';
    if (!this.lon || this.lon.length !== this.count) {
      this.lon = new Float64Array(this.count);
      this.lat = new Float64Array(this.count);
      this.spd = new Float32Array(this.count);
      this.fresh = new Uint8Array(this.count);
    }
    for (let k = 0; k < this.count; k += 1) this.respawn(k);
    if (this.running) this.draw();
  }

  respawn(k) {
    const b = this.grid.bounds;
    this.lon[k] = b.west + Math.random() * (b.east - b.west);
    this.lat[k] = b.south + Math.random() * (b.north - b.south);
    this.spd[k] = 0;
    this.fresh[k] = 1; // recém-nascida não desenha neste quadro (como a lib)
  }

  ensureCanvas() {
    if (this.canvas) return;
    const c = document.createElement('canvas');
    c.className = 'dg-wind-particles';
    c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    const mapCanvas = this.map.getCanvas();
    mapCanvas.parentNode.insertBefore(c, mapCanvas.nextSibling);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    this.onResize();
  }

  onResize() {
    if (!this.canvas) return;
    const mapCanvas = this.map.getCanvas();
    const w = mapCanvas.clientWidth;
    const h = mapCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.latticeKey = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ensureCanvas();
    this.canvas.style.display = '';
    this.map.on('render', this.onRender);
    this.map.on('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.lastT = 0;
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.map.off('render', this.onRender);
    this.map.off('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.canvas) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.style.display = 'none';
    }
  }

  destroy() {
    this.stop();
    this.canvas?.remove();
    this.canvas = null;
  }

  schedule() {
    if (this.running && !this.raf && !document.hidden) this.raf = requestAnimationFrame(this.onFrame);
  }

  onVisibility() {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    } else {
      this.lastT = 0;
      this.schedule();
    }
  }

  onFrame(t) {
    this.raf = null;
    if (!this.running) return;
    const frames = this.lastT ? Math.min(MAX_FRAMES, ((t - this.lastT) / 1000) * 60) : 1;
    this.lastT = t;
    if (this.grid) {
      this.step(frames);
      // Em movimento o evento `render` do mapa desenha (câmera já atualizada).
      if (!this.map.isMoving()) this.draw();
    }
    this.schedule();
  }

  onRender() {
    if (this.running && this.grid && this.map.isMoving()) this.draw();
  }

  step(frames) {
    const { grid, style } = this;
    const scale = (this.pixelSize + 50) * style.speedFactor;
    const span = this.domain.max - this.domain.min;
    for (let k = 0; k < this.count; k += 1) {
      const next = advect(grid, this.lon[k], this.lat[k], scale, frames);
      const norm = next ? Math.min(1, Math.max(0, (next[2] - this.domain.min) / span)) : 0;
      const drop = (style.dropRate + DROP_RATE_BUMP * norm) * frames;
      if (!next || Math.random() < drop || !windAt(grid, next[0], next[1])) {
        this.respawn(k);
        continue;
      }
      this.lon[k] = next[0];
      this.lat[k] = next[1];
      this.spd[k] = next[2];
      this.fresh[k] = 0;
    }
  }

  /** Reprojeta a malha só quando a câmera (ou a projeção) mudou. */
  updateLattice() {
    const map = this.map;
    const c = map.getCenter();
    const globe = map.getProjection?.()?.type === 'globe';
    const key = `${c.lng},${c.lat},${map.getZoom()},${map.getBearing()},${map.getPitch()},${this.cssW},${this.cssH},${globe}`;
    if (key === this.latticeKey) return;
    this.latticeKey = key;
    const b = map.getBounds();
    const ps = libPixelSize({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, this.grid.bounds);
    if (ps) this.pixelSize = ps;
    // Traço em px: lineLength · pixelSize metros na escala do centro da tela.
    this.lengthScale = Math.min(4, this.pixelSize / metersPerPixel(map.getZoom(), c.lat));
    // No globo, pontos além do horizonte não entram (ângulo ao centro > ~80°).
    const cosMax = Math.cos((80 * Math.PI) / 180);
    const toRad = Math.PI / 180;
    const cLat = c.lat * toRad;
    const cLng = c.lng * toRad;
    for (let j = 0; j < this.ny; j += 1) {
      const lat = this.lat0 + j * this.dLat;
      for (let i = 0; i < this.nx; i += 1) {
        const lon = this.lon0 + i * this.dLon;
        const n = j * this.nx + i;
        if (globe) {
          const cosAng = Math.sin(cLat) * Math.sin(lat * toRad)
            + Math.cos(cLat) * Math.cos(lat * toRad) * Math.cos(lon * toRad - cLng);
          if (cosAng < cosMax) {
            this.ok[n] = 0;
            continue;
          }
        }
        const p = map.project([lon, lat]);
        const good = Number.isFinite(p.x) && Number.isFinite(p.y);
        this.ok[n] = good ? 1 : 0;
        this.sx[n] = p.x;
        this.sy[n] = p.y;
      }
    }
  }

  /** Posição de tela interpolada na malha, em `out`; false se fora. */
  screenAt(lon, lat, out) {
    const cell = latticeCell(this.lat0, this.lon0, this.dLat, this.dLon, this.nx, this.ny, lon, lat);
    if (!cell) return false;
    const { i, j, s, t } = cell;
    const n00 = j * this.nx + i;
    const n10 = n00 + 1;
    const n01 = n00 + this.nx;
    const n11 = n01 + 1;
    if (!(this.ok[n00] && this.ok[n10] && this.ok[n01] && this.ok[n11])) return false;
    const { sx, sy } = this;
    out[0] = (sx[n00] * (1 - s) + sx[n10] * s) * (1 - t) + (sx[n01] * (1 - s) + sx[n11] * s) * t;
    out[1] = (sy[n00] * (1 - s) + sy[n10] * s) * (1 - t) + (sy[n01] * (1 - s) + sy[n11] * s) * t;
    return true;
  }

  draw() {
    if (!this.canvas || !this.grid) return;
    this.updateLattice();
    const { ctx, style, grid } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Um path por (faixa de velocidade, trecho do traço): 24 strokes por quadro.
    const paths = [];
    for (let b = 0; b < BINS; b += 1) {
      paths.push([]);
      for (let p = 0; p < PIECES; p += 1) paths[b].push(new Path2D());
    }
    const head = [0, 0];
    const probe = [0, 0];
    const span = this.domain.max - this.domain.min;
    const { min: lmin, max: lmax } = style.lineLength;
    const margin = lmax * this.lengthScale;
    const w = this.cssW;
    const h = this.cssH;
    let drawn = 0;
    for (let k = 0; k < this.count; k += 1) {
      if (this.fresh[k]) continue;
      const lon = this.lon[k];
      const lat = this.lat[k];
      if (!this.screenAt(lon, lat, head)) continue;
      if (head[0] < -margin || head[1] < -margin || head[0] > w + margin || head[1] > h + margin) continue;
      const wind = windAt(grid, lon, lat);
      if (!wind) continue;
      const speed = Math.hypot(wind[0], wind[1]);
      if (speed === 0) continue;
      // Direção do movimento na TELA: ponto um pouco à frente na malha.
      const [mLon, mLat] = metersPerDegree(lat);
      const ahead = 2000 / speed; // segundos para andar 2 km
      if (!this.screenAt(lon + (wind[0] * ahead) / mLon, lat + (wind[1] * ahead) / mLat, probe)) continue;
      let dx = probe[0] - head[0];
      let dy = probe[1] - head[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) continue;
      dx /= len;
      dy /= len;
      const norm = Math.min(1, Math.max(0, (speed - this.domain.min) / span));
      const L = (lmin + (lmax - lmin) * norm) * this.lengthScale;
      const bin = Math.min(BINS - 1, Math.floor(norm * BINS));
      for (let p = 0; p < PIECES; p += 1) {
        const path = paths[bin][p];
        path.moveTo(head[0] + dx * L * (p / PIECES), head[1] + dy * L * (p / PIECES));
        path.lineTo(head[0] + dx * L * ((p + 1) / PIECES), head[1] + dy * L * ((p + 1) / PIECES));
      }
      drawn += 1;
    }
    ctx.lineCap = 'round';
    for (let b = 0; b < BINS; b += 1) {
      const st = this.binStyle[b];
      ctx.strokeStyle = st.color;
      for (let p = 0; p < PIECES; p += 1) {
        const s = (p + 0.5) / PIECES;
        ctx.globalAlpha = trailAlpha(s) * st.speedAlpha;
        // Traço afina para trás: metade da largura na cauda, cheia na frente.
        ctx.lineWidth = st.width * (0.5 + 0.5 * s);
        ctx.stroke(paths[b][p]);
      }
    }
    ctx.globalAlpha = 1;
    this.lastDrawn = drawn;
  }
}
