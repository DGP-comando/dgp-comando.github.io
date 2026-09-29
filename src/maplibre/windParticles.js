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
//   - cada partícula deixa um rastro das últimas TRAIL posições (lon/lat, então
//     o rastro curva com o escoamento e acompanha a câmera sem borrar), fino e
//     transparente na cauda, largura lineWidth (1–2,4 px) e opaco na cabeça,
//     cor da rampa `colors` pela velocidade normalizada. Vento forte anda mais
//     por quadro, então o rastro dele sai naturalmente mais longo.
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
const PIECES = 4; // o rastro em 4 trechos de opacidade crescente
const TRAIL = 10; // posições guardadas por partícula (≈ 1/6 s a 60 fps)
const MAX_JUMP_PX = 80; // segmento maior que isso é salto de projeção, não rastro
const MARGIN_PX = 150; // folga fora da tela para a cabeça ainda desenhar a cauda
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
      this.hLon = new Float64Array(this.count * TRAIL);
      this.hLat = new Float64Array(this.count * TRAIL);
      this.hHead = new Uint8Array(this.count);
      this.hLen = new Uint8Array(this.count);
    }
    for (let k = 0; k < this.count; k += 1) this.respawn(k);
    if (this.running) this.draw();
  }

  respawn(k) {
    const b = this.grid.bounds;
    this.lon[k] = b.west + Math.random() * (b.east - b.west);
    this.lat[k] = b.south + Math.random() * (b.north - b.south);
    this.spd[k] = 0;
    // Recém-nascida não tem rastro: só desenha depois do primeiro passo.
    this.hLen[k] = 0;
    this.remember(k);
  }

  /** Empurra a posição atual no anel do rastro da partícula k. */
  remember(k) {
    const h = this.hLen[k] ? (this.hHead[k] + 1) % TRAIL : 0;
    this.hLon[k * TRAIL + h] = this.lon[k];
    this.hLat[k * TRAIL + h] = this.lat[k];
    this.hHead[k] = h;
    if (this.hLen[k] < TRAIL) this.hLen[k] += 1;
  }

  ensureCanvas() {
    if (this.canvas) return;
    const c = document.createElement('canvas');
    c.className = 'dg-wind-particles';
    c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    // No fim do container, acima do #post-process-canvas (que também se põe
    // logo depois do canvas do mapa e, com um estilo ativo, é opaco).
    this.map.getCanvas().parentNode.appendChild(c);
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
      this.remember(k);
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
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Um path por (faixa de velocidade, trecho do rastro): 32 strokes por quadro.
    const paths = [];
    for (let b = 0; b < BINS; b += 1) {
      paths.push([]);
      for (let p = 0; p < PIECES; p += 1) paths[b].push(new Path2D());
    }
    const pt = [0, 0];
    const xs = new Float32Array(TRAIL);
    const ys = new Float32Array(TRAIL);
    const ok = new Uint8Array(TRAIL);
    const span = this.domain.max - this.domain.min;
    const w = this.cssW;
    const h = this.cssH;
    const { hLon, hLat, hHead, hLen } = this;
    let drawn = 0;
    for (let k = 0; k < this.count; k += 1) {
      const n = hLen[k];
      if (n < 2) continue;
      const base = k * TRAIL;
      const head = hHead[k];
      // Cabeça fora da tela (com folga): a partícula inteira fica de fora.
      if (!this.screenAt(hLon[base + head], hLat[base + head], pt)) continue;
      if (pt[0] < -MARGIN_PX || pt[1] < -MARGIN_PX || pt[0] > w + MARGIN_PX || pt[1] > h + MARGIN_PX) continue;
      // m = 0 é a posição mais antiga, m = n - 1 a cabeça.
      for (let m = 0; m < n; m += 1) {
        const idx = base + ((head - (n - 1 - m) + TRAIL) % TRAIL);
        ok[m] = this.screenAt(hLon[idx], hLat[idx], pt) ? 1 : 0;
        xs[m] = pt[0];
        ys[m] = pt[1];
      }
      const norm = Math.min(1, Math.max(0, (this.spd[k] - this.domain.min) / span));
      const bin = Math.min(BINS - 1, Math.floor(norm * BINS));
      for (let m = 1; m < n; m += 1) {
        if (!ok[m - 1] || !ok[m]) continue;
        const dx = xs[m] - xs[m - 1];
        const dy = ys[m] - ys[m - 1];
        if (dx * dx + dy * dy > MAX_JUMP_PX * MAX_JUMP_PX) continue;
        // Idade do segmento (0 = junto da cabeça) medida contra o rastro cheio:
        // um rastro recém-nascido é curto, mas já tem a cabeça forte.
        const age = n - 1 - m;
        const piece = PIECES - 1 - Math.min(PIECES - 1, Math.floor((age * PIECES) / (TRAIL - 1)));
        const path = paths[bin][piece];
        path.moveTo(xs[m - 1], ys[m - 1]);
        path.lineTo(xs[m], ys[m]);
      }
      drawn += 1;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let b = 0; b < BINS; b += 1) {
      const st = this.binStyle[b];
      ctx.strokeStyle = st.color;
      for (let p = 0; p < PIECES; p += 1) {
        const s = (p + 1) / PIECES;
        ctx.globalAlpha = trailAlpha(s) * st.speedAlpha;
        // Cometa: a cauda afina até 30% da largura, a cabeça tem a largura cheia.
        ctx.lineWidth = st.width * (0.3 + 0.7 * s);
        ctx.stroke(paths[b][p]);
      }
    }
    ctx.globalAlpha = 1;
    this.lastDrawn = drawn;
  }
}
