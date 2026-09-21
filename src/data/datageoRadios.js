// src/data/datageoRadios.js
//
// Rádios ao vivo do PR, no modelo do radio.garden: o ponto verde é o LUGAR
// (o município), o tamanho do ponto é quantas estações ele tem, e clicar no
// ponto abre o player já tocando a primeira. As setas zapeiam pela lista
// inteira do estado, município a município, como girar o dial; a troca de
// estação toca um chiado curto de estática até o áudio entrar.
//
// Dado estático (public/data/radios-pr.json, scripts/build_radios.py) do
// Radio Browser; só streams HTTPS que passaram na checagem diária deles.
// O áudio vai direto do servidor da emissora para um único <audio>, sempre
// depois de um clique: nada é proxiado, gravado ou redistribuído.
//
// Fica de fora do radio.garden: a mira no centro do globo que sintoniza o
// lugar embaixo dela. Com ~12 lugares no estado, clicar resolve.

import * as Cesium from 'cesium';
import { centroidByIbge } from './prCentroids.js';
import { createEntityHoverTooltip } from './entityHoverTooltip.js';
import { escapeHtml } from './vesselTooltip.js';
import { governorRequestRender } from '../renderGovernor.js';

const ID = 'datageo-radios';
const DATA_URL = '/data/radios-pr.json';
const GREEN = '#3ddc84';
const DOT_COLOR = Cesium.Color.fromCssColorString(GREEN);
const HALO_COLOR = DOT_COLOR.withAlpha(0.3);
const PLAY_TIMEOUT_MS = 12_000;
const STATIC_GAIN = 0.05;
const VOLUME_KEY = 'datageo-radio-volume';

/** Diâmetro do ponto: cresce com a raiz da contagem, como no radio.garden. */
export function dotSize(stationCount) {
  return 7 + 3 * Math.sqrt(Math.max(1, stationCount));
}

/** Achata os lugares numa lista única de estações, na ordem do arquivo. */
export function flattenStations(places) {
  return places.flatMap((place) => place.stations.map((station) => ({ station, place })));
}

function readVolume() {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
  } catch {
    return 0.8;
  }
}

function saveVolume(v) {
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* sem storage */ }
}

// ── Estática de troca de estação (WebAudio, só depois de um clique) ─────────
function createStatic() {
  let ctx = null;
  let src = null;
  return {
    start(volume) {
      try {
        ctx ??= new AudioContext();
        if (src) return;
        const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const gain = ctx.createGain();
        gain.gain.value = STATIC_GAIN * volume;
        src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(gain).connect(ctx.destination);
        src.start();
      } catch { /* sem WebAudio: troca muda, sem chiado */ }
    },
    stop() {
      try { src?.stop(); } catch { /* já parado */ }
      src = null;
    },
    close() {
      this.stop();
      ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

const PLAYER_CSS = `
  #dg-radio {
    /* Embaixo e no centro, como no radio.garden: a coluna esquerda é do painel
       de camadas (aberto justamente quando se liga esta camada) e a direita
       é da ficha municipal. 96 px deixa livre a barra de LOCALIZAÇÃO. */
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 96px;
    width: 340px; max-width: calc(100vw - 32px); max-height: calc(100vh - 200px); display: none; flex-direction: column; gap: 12px;
    padding: 14px 16px; z-index: 92; color: #f1f5f9;
    background: rgba(18, 20, 22, 0.94); backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 18px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  #dg-radio.open { display: flex; }
  #dg-radio button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  #dg-radio button:focus-visible, #dg-radio input:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 2px; }
  .dgr-head { display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: 0.06em; }
  .dgr-live { display: inline-flex; align-items: center; gap: 5px; color: ${GREEN}; font-weight: 700; }
  .dgr-live i { width: 7px; height: 7px; border-radius: 50%; background: ${GREEN}; }
  #dg-radio[data-state="playing"] .dgr-live i { animation: dgr-pulse 1.4s ease-in-out infinite; }
  #dg-radio:not([data-state="playing"]) .dgr-live { color: #64748b; }
  #dg-radio:not([data-state="playing"]) .dgr-live i { background: #64748b; }
  .dgr-place { flex: 1; color: #94a3b8; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dgr-close { width: 28px; height: 28px; border-radius: 50%; font-size: 18px !important; color: #94a3b8 !important; }
  .dgr-close:hover { background: rgba(255, 255, 255, 0.08) !important; color: #fff !important; }
  .dgr-now { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .dgr-logo { width: 44px; height: 44px; border-radius: 10px; flex: none; object-fit: cover;
    background: #1f2937 center/60% no-repeat; display: grid; place-items: center; font-size: 20px; }
  .dgr-name { font-size: 17px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dgr-meta { font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dgr-controls { display: flex; align-items: center; gap: 10px; }
  .dgr-skip { width: 34px; height: 34px; border-radius: 50%; font-size: 14px !important; color: #cbd5e1 !important; }
  .dgr-skip:hover { background: rgba(255, 255, 255, 0.08) !important; }
  .dgr-play { width: 52px; height: 52px; border-radius: 50%; background: ${GREEN} !important;
    color: #0b0f0c !important; font-size: 20px !important; display: grid; place-items: center;
    box-shadow: 0 0 0 6px rgba(61, 220, 132, 0.15); transition: transform 0.12s; }
  .dgr-play:hover { transform: scale(1.06); }
  .dgr-vol { flex: 1; min-width: 60px; accent-color: ${GREEN}; }
  .dgr-status { font-size: 11px; color: #94a3b8; min-height: 15px; }
  #dg-radio[data-state="error"] .dgr-status { color: #fca5a5; }
  .dgr-list { list-style: none; margin: 0; padding: 0; max-height: 150px; overflow-y: auto; border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .dgr-list button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 4px;
    text-align: left; border-radius: 8px; }
  .dgr-list button:hover { background: rgba(255, 255, 255, 0.06); }
  .dgr-list button[aria-current="true"] { color: ${GREEN}; font-weight: 700; }
  .dgr-eq { display: inline-flex; gap: 2px; align-items: flex-end; width: 12px; height: 11px; flex: none; }
  .dgr-eq i { width: 2px; height: 3px; background: currentColor; }
  #dg-radio[data-state="playing"] [aria-current="true"] .dgr-eq i { animation: dgr-eq 0.9s ease-in-out infinite; }
  .dgr-eq i:nth-child(2) { animation-delay: -0.3s !important; }
  .dgr-eq i:nth-child(3) { animation-delay: -0.6s !important; }
  @keyframes dgr-pulse { 50% { opacity: 0.3; } }
  @keyframes dgr-eq { 50% { height: 11px; } }
  @media (prefers-reduced-motion: reduce) { #dg-radio * { animation: none !important; } }
`;

const PLAYER_HTML = `
  <div class="dgr-head">
    <span class="dgr-live"><i></i>AO VIVO</span>
    <span class="dgr-place"></span>
    <button class="dgr-close" type="button" aria-label="Fechar player">×</button>
  </div>
  <div class="dgr-now">
    <div class="dgr-logo" aria-hidden="true">📻</div>
    <div style="min-width:0"><div class="dgr-name"></div><div class="dgr-meta"></div></div>
  </div>
  <div class="dgr-controls">
    <button class="dgr-skip" type="button" data-step="-1" aria-label="Estação anterior">⏮</button>
    <button class="dgr-play" type="button" aria-label="Tocar">▶</button>
    <button class="dgr-skip" type="button" data-step="1" aria-label="Próxima estação">⏭</button>
    <input class="dgr-vol" type="range" min="0" max="1" step="0.01" aria-label="Volume">
  </div>
  <div class="dgr-status" aria-live="polite"></div>
  <ol class="dgr-list" aria-label="Estações do município"></ol>
`;

function createPlayer({ onSelectionChange }) {
  const style = document.createElement('style');
  style.textContent = PLAYER_CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'dg-radio';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Rádio ao vivo');
  root.innerHTML = PLAYER_HTML;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);

  const audio = new Audio();
  audio.preload = 'none';
  const noise = createStatic();
  let volume = readVolume();
  let entries = [];
  let index = -1;
  let timer = null;

  const setState = (state, status) => {
    root.dataset.state = state;
    $('.dgr-status').textContent = status;
    $('.dgr-play').textContent = state === 'playing' || state === 'loading' ? '❚❚' : '▶';
    $('.dgr-play').setAttribute('aria-label', state === 'playing' || state === 'loading' ? 'Pausar' : 'Tocar');
  };

  const halt = (state, status) => {
    clearTimeout(timer);
    noise.stop();
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // derruba a conexão: rádio pausada não fica baixando
    setState(state, status);
  };

  const renderStation = () => {
    const { station, place } = entries[index];
    $('.dgr-place').textContent = `${place.nome} · PR`;
    $('.dgr-name').textContent = station.name;
    $('.dgr-name').title = station.name;
    const kbps = station.bitrate ? `${station.bitrate} kbps` : '';
    $('.dgr-meta').textContent = [station.tags.slice(0, 2).join(', '), station.codec, kbps].filter(Boolean).join(' · ');
    const logo = $('.dgr-logo');
    logo.style.backgroundImage = station.favicon ? `url("${encodeURI(station.favicon)}")` : '';
    logo.textContent = station.favicon ? '' : '📻';
    $('.dgr-list').innerHTML = place.stations.map((s) => `
      <li><button type="button" data-id="${escapeHtml(s.id)}" aria-current="${s.id === station.id}">
        <span class="dgr-eq" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(s.name)}
      </button></li>`).join('');
  };

  const play = () => {
    const { station } = entries[index];
    clearTimeout(timer);
    noise.start(volume);
    setState('loading', 'Sintonizando…');
    audio.src = station.url;
    audio.volume = volume;
    audio.play().catch(() => {}); // o erro chega pelo evento 'error' ou pelo timeout
    timer = setTimeout(() => halt('error', 'A emissora não respondeu. Tente a próxima.'), PLAY_TIMEOUT_MS);
  };

  const tune = (nextIndex) => {
    if (!entries.length) return;
    index = (nextIndex + entries.length) % entries.length;
    renderStation();
    root.classList.add('open');
    play();
    onSelectionChange(entries[index].place.ibge);
  };

  audio.addEventListener('playing', () => {
    clearTimeout(timer);
    noise.stop();
    setState('playing', 'Ao vivo');
  });
  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) halt('error', 'Emissora fora do ar agora. Tente a próxima.');
  });

  $('.dgr-vol').value = String(volume);
  $('.dgr-vol').addEventListener('input', (ev) => {
    volume = Number(ev.target.value);
    audio.volume = volume;
    saveVolume(volume);
  });
  $('.dgr-play').addEventListener('click', () => {
    if (root.dataset.state === 'playing' || root.dataset.state === 'loading') halt('paused', 'Pausado');
    else play();
  });
  root.querySelectorAll('.dgr-skip').forEach((btn) => {
    btn.addEventListener('click', () => tune(index + Number(btn.dataset.step)));
  });
  $('.dgr-list').addEventListener('click', (ev) => {
    const id = ev.target.closest('button[data-id]')?.dataset.id;
    const found = entries.findIndex((e) => e.station.id === id);
    if (found >= 0) tune(found);
  });

  const close = () => {
    halt('stopped', '');
    root.classList.remove('open');
    onSelectionChange(null);
  };
  $('.dgr-close').addEventListener('click', close);

  return {
    setPlaces(places) {
      // Refresh mantém a estação no ar: o índice segue o id, não a posição.
      const currentId = entries[index]?.station.id;
      entries = flattenStations(places);
      index = entries.findIndex((e) => e.station.id === currentId);
      if (index < 0 && root.classList.contains('open')) close();
    },
    openPlace(ibge) {
      const found = entries.findIndex((e) => e.place.ibge === ibge);
      if (found >= 0) tune(found);
    },
    close,
    destroy() {
      close();
      noise.close();
      root.remove();
      style.remove();
    },
  };
}

function createRadiosLayer() {
  let viewer = null;
  let dataSource = null;
  let handler = null;
  let tooltip = null;
  let player = null;
  let places = [];
  let lastUpdate = null;
  let lastError = null;
  let selected = null;

  const highlight = (ibge) => {
    selected = ibge;
    for (const entity of dataSource?.entities.values ?? []) {
      const isSel = entity.id === `${ID}:${ibge}`;
      entity.point.color = isSel ? Cesium.Color.WHITE : DOT_COLOR;
      entity.point.outlineColor = isSel ? DOT_COLOR.withAlpha(0.6) : HALO_COLOR;
    }
    governorRequestRender(`${ID}:select`);
  };

  const build = () => {
    dataSource.entities.removeAll();
    for (const place of places) {
      const c = centroidByIbge(place.ibge);
      if (!c) continue;
      dataSource.entities.add({
        id: `${ID}:${place.ibge}`,
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
        point: {
          pixelSize: dotSize(place.stations.length),
          color: DOT_COLOR,
          outlineColor: HALO_COLOR,
          outlineWidth: 5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { nome: place.nome, n: place.stations.length },
      });
    }
    if (selected) highlight(selected);
  };

  return {
    id: ID,
    name: 'Rádios ao vivo',
    category: 'Cultura',
    icon: '📻',
    source: 'Radio Browser',
    updateInterval: 24 * 3600_000,

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      player = createPlayer({ onSelectionChange: highlight });
      tooltip = createEntityHoverTooltip({
        viewer,
        idPrefix: `${ID}:`,
        render: (p) => `<div class="vt-nome">📻 ${escapeHtml(p.nome)}</div>`
          + `<div>${p.n} ${p.n === 1 ? 'estação' : 'estações'} ao vivo · clique para ouvir</div>`,
        isActive: () => Boolean(dataSource?.show),
      });
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (!dataSource?.show) return;
        const id = viewer.scene.pick(click.position)?.id?.id;
        if (typeof id === 'string' && id.startsWith(`${ID}:`)) player.openPlace(id.slice(ID.length + 1));
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (dataSource) dataSource.show = true;
    },

    disable() {
      if (dataSource) dataSource.show = false;
      tooltip?.hide();
      player?.close(); // camada desligada não segue tocando
    },

    async update() {
      if (!dataSource) return false;
      try {
        const resp = await fetch(DATA_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        places = (await resp.json()).places ?? [];
      } catch (err) {
        lastError = err?.message || String(err);
        console.warn(`[Data:${ID}]`, err);
        return false;
      }
      if (!dataSource) return false; // destruída durante o fetch
      player.setPlaces(places);
      build();
      lastUpdate = Date.now();
      lastError = null;
      return true;
    },

    destroy(v) {
      handler?.destroy();
      tooltip?.destroy();
      player?.destroy();
      if (dataSource) v.dataSources.remove(dataSource, true);
      handler = tooltip = player = dataSource = null;
    },

    getStats() {
      const count = places.reduce((sum, p) => sum + p.stations.length, 0);
      return { count, lastUpdate, error: lastError };
    },
  };
}

export const datageoRadiosLayer = createRadiosLayer();
