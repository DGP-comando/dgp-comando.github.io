// src/data/mapCardHost.js
//
// CARTÕES ANCORADOS NO MAPA (MapLibre) — substituto local do worldOverlay
// ======================================================================
//
// No app Cesium, CCTV e bikeshare publicavam "entradas" (cartão com miniatura,
// rótulo do selecionado) no host compartilhado src/overlays/worldOverlay.js,
// que projetava, arbitrava colisões e pintava num canvas. No MapLibre cada
// cartão vira um `maplibregl.Marker` com um elemento DOM: o próprio MapLibre
// projeta e acompanha o mapa (globo, inclinação, rotação), e o clique chega
// ao elemento. A interface é a mesma que as camadas já usavam, então o código
// delas (e os testes, que injetam um host falso) não muda:
//
//   host.setEntries(sourceId, entries, options?)   // substitui o conjunto da fonte
//   host.setVisible(sourceId, visible)
//   host.clearSource(sourceId)
//   host.hitTest(x, y, {sourceId}) -> null         // o clique vai direto ao DOM
//   host.onActivate(sourceId, fn(entryId))         // clique num cartão interativo
//   host.setSourceStyle(sourceId, {scale, alpha})  // escala/opacidade por altitude
//   host.destroy()
//
// Campos de entrada lidos (os mesmos que cctvCards/bikeshare já produziam):
//   id, position ({lon, lat} ou função que o devolve), variant
//   ('thumbnail' | 'selected' | 'monitor'), title, details[], accent,
//   image (slot de quadro {frame: canvas|img}), requireImage, pinned, active,
//   gapPx, interactive, monitor {src, video, width}.
// O que era arbitragem do worldOverlay (colisão global, fade de borda, oclusão
// por relevo) fica de fora: quem publica já limita e desafoga os cartões
// (cctvLod/declutterCctvCards), e o MapLibre esconde o que está atrás do globo.
//
// Nada aqui roda na importação (o módulo é importado por um worker via
// cctv.js/bikeshare.js); o DOM só é tocado ao criar o host.

const FONT = '600 10px "JetBrains Mono", ui-monospace, monospace';
const THUMB_W = 96;
const THUMB_H = 54;

function resolvePosition(position) {
  const p = typeof position === 'function' ? position() : position;
  const lon = Number(p?.lon);
  const lat = Number(p?.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function el(tag, style = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {{map: object, maplibregl: object}} engine motor (src/maplibre/engine.js)
 */
export function createMapCardHost(engine) {
  const { map, maplibregl } = engine;
  /** sourceId -> {visible, style, byId: Map<id, {marker, parts, entry}>} */
  const sources = new Map();
  const activators = new Map();

  function source(sourceId) {
    let s = sources.get(sourceId);
    if (!s) {
      s = { visible: true, style: { scale: 1, alpha: 1 }, byId: new Map() };
      sources.set(sourceId, s);
    }
    return s;
  }

  function buildElement(sourceId, entry) {
    const accent = entry.accent || '#6be8ff';
    const root = el('div', { pointerEvents: 'none' });
    root.className = `dg-map-card dg-map-card-${entry.variant || 'card'}`;
    const body = el('div', {
      pointerEvents: entry.interactive ? 'auto' : 'none',
      cursor: entry.interactive ? 'pointer' : 'default',
      background: 'rgba(4, 11, 17, 0.88)',
      border: `1px solid ${accent}`,
      borderRadius: '3px',
      padding: '3px',
      color: '#dff8ff',
      font: FONT,
      boxShadow: '0 2px 8px rgba(0,0,0,0.55)',
      transformOrigin: '50% 100%',
      maxWidth: '340px',
    });
    const parts = { root, body, canvas: null, media: null, title: null, details: null, drawnFrame: undefined };
    if (entry.variant === 'thumbnail') {
      const canvas = el('canvas', { display: 'block', width: `${THUMB_W}px`, height: `${THUMB_H}px`, background: '#02070b' });
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      parts.canvas = canvas;
      body.appendChild(canvas);
    }
    if (entry.variant === 'monitor') {
      const width = Number(entry.monitor?.width) || 280;
      const media = entry.monitor?.video
        ? el('video', { display: 'block', width: `${width}px`, background: '#02070b' })
        : el('img', { display: 'block', width: `${width}px`, minHeight: `${Math.round(width * 9 / 16)}px`, background: '#02070b', objectFit: 'cover' });
      if (entry.monitor?.video) {
        media.muted = true;
        media.autoplay = true;
        media.loop = true;
        media.playsInline = true;
      }
      media.alt = '';
      parts.media = media;
      body.appendChild(media);
    }
    parts.title = el('div', {
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      maxWidth: entry.variant === 'thumbnail' ? `${THUMB_W}px` : '320px',
      color: accent, padding: '2px 1px 0',
    });
    body.appendChild(parts.title);
    parts.details = el('div', { whiteSpace: 'pre', color: '#b9d3dc', padding: '0 1px' });
    body.appendChild(parts.details);
    const leader = el('div', {
      width: '1px', height: `${Math.max(4, Number(entry.gapPx) || 10)}px`,
      margin: '0 auto', background: accent, opacity: '0.7',
    });
    root.append(body, leader);
    body.addEventListener('click', (event) => {
      if (!parts.entry?.interactive) return;
      event.stopPropagation();
      activators.get(sourceId)?.(parts.entry.id);
    });
    // Arrastar o mapa a partir de um cartão continua funcionando.
    body.addEventListener('mousedown', (event) => {
      if (!parts.entry?.interactive) event.stopPropagation();
    });
    return parts;
  }

  function paint(parts, entry, style) {
    parts.entry = entry;
    parts.title.textContent = String(entry.title || '');
    parts.title.style.display = entry.title ? '' : 'none';
    const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
    parts.details.textContent = details.join('\n');
    parts.details.style.display = details.length ? '' : 'none';
    if (parts.canvas) {
      const frame = entry.image?.frame ?? null;
      if (frame !== parts.drawnFrame) {
        parts.drawnFrame = frame;
        const ctx = parts.canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#02070b';
          ctx.fillRect(0, 0, THUMB_W, THUMB_H);
          if (frame) {
            try {
              ctx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
            } catch {
              // quadro corrompido: fica o fundo
            }
          }
        }
      }
    }
    if (parts.media && entry.monitor?.src && parts.media.dataset.src !== entry.monitor.src) {
      // Troca de quadro só depois do anterior assentar (evita cancelar um
      // download lento a cada atualização).
      const busy = parts.media.dataset.loading === 'true';
      if (!busy || parts.media.dataset.cameraId !== String(entry.id)) {
        parts.media.dataset.src = entry.monitor.src;
        parts.media.dataset.cameraId = String(entry.id);
        parts.media.dataset.loading = 'true';
        const done = () => { parts.media.dataset.loading = 'false'; };
        parts.media.onload = done;
        parts.media.onerror = done;
        parts.media.onloadeddata = done;
        parts.media.src = entry.monitor.src;
      }
    }
    const hideForImage = entry.requireImage && !entry.pinned && !entry.image?.frame;
    parts.root.style.visibility = hideForImage ? 'hidden' : '';
    const scale = entry.active || entry.pinned ? Math.max(1, style.scale) : style.scale;
    parts.body.style.transform = scale !== 1 ? `scale(${scale})` : '';
    parts.root.style.opacity = String(entry.active || entry.pinned ? 1 : style.alpha);
    parts.root.style.zIndex = entry.variant === 'monitor' || entry.variant === 'selected' ? '4'
      : entry.active ? '3' : entry.pinned ? '2' : '1';
  }

  function setEntries(sourceId, entries = []) {
    const s = source(sourceId);
    const next = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.id) continue;
      const lngLat = resolvePosition(entry.position);
      if (!lngLat) continue;
      let item = s.byId.get(entry.id);
      if (item && item.variant !== entry.variant) {
        item.marker.remove();
        item = null;
      }
      if (!item) {
        const parts = buildElement(sourceId, entry);
        const marker = new maplibregl.Marker({ element: parts.root, anchor: 'bottom' }).setLngLat(lngLat);
        if (s.visible) marker.addTo(map);
        item = { marker, parts, variant: entry.variant, onMap: s.visible };
      } else {
        item.marker.setLngLat(lngLat);
      }
      paint(item.parts, entry, s.style);
      next.set(entry.id, item);
    }
    for (const [id, item] of s.byId) if (!next.has(id)) item.marker.remove();
    s.byId = next;
  }

  function setVisible(sourceId, visible) {
    const s = source(sourceId);
    s.visible = Boolean(visible);
    for (const item of s.byId.values()) {
      if (s.visible && !item.onMap) item.marker.addTo(map);
      if (!s.visible && item.onMap) item.marker.remove();
      item.onMap = s.visible;
    }
  }

  function clearSource(sourceId) {
    const s = sources.get(sourceId);
    if (!s) return;
    for (const item of s.byId.values()) item.marker.remove();
    s.byId = new Map();
  }

  function setSourceStyle(sourceId, { scale = 1, alpha = 1 } = {}) {
    const s = source(sourceId);
    s.style = { scale, alpha };
    for (const item of s.byId.values()) paint(item.parts, item.parts.entry, s.style);
  }

  return {
    setEntries,
    setVisible,
    clearSource,
    setSourceStyle,
    hitTest: () => null,
    onActivate(sourceId, fn) {
      if (typeof fn === 'function') activators.set(sourceId, fn);
      else activators.delete(sourceId);
    },
    entryCount: (sourceId) => sources.get(sourceId)?.byId.size ?? 0,
    destroy() {
      for (const id of [...sources.keys()]) clearSource(id);
      sources.clear();
      activators.clear();
    },
  };
}

/**
 * Altura da câmera acima do solo (m) para as travas por altitude das camadas
 * (tráfego < 8 km, bikeshare < 50 km, escala dos cartões CCTV). Usa o motor
 * (`cameraHeightAboveGround`, `getCameraView().alt`) e, se ele não souber
 * (projeção globo sem altitude), a relação zoom↔altura de kit.zoomForHeight
 * (h = 1e8 / 2^zoom). Infinity sem motor.
 */
export function cameraAltitudeM(engine) {
  const h = engine?.cameraHeightAboveGround?.();
  if (Number.isFinite(h) && h > 0) return h;
  const alt = engine?.getCameraView?.()?.alt;
  if (Number.isFinite(alt) && alt > 0) return alt;
  const zoom = engine?.map?.getZoom?.();
  return Number.isFinite(zoom) ? 1e8 / 2 ** zoom : Infinity;
}

let shared = null;
let sharedEngine = null;
/** Host único por motor (CCTV e bikeshare dividem o mesmo). */
export function getMapCardHost(engine) {
  if (!engine?.map || !engine?.maplibregl) return null;
  if (shared && sharedEngine === engine) return shared;
  shared?.destroy();
  shared = createMapCardHost(engine);
  sharedEngine = engine;
  return shared;
}
