// src/data/entityHoverTooltip.js
//
// Tooltip DOM de hover para entidades de uma camada DataGeo (hoje: navios).
// Mesmo desenho do tooltip dos municípios (datageoMunicipios.js):
// - MOUSE_MOVE com throttle de 40 ms e pick "de cauda";
// - nada de scene.pick com a câmera em movimento (moveEnd refaz);
// - mouse parado não repete o pick.
// Como scene.pick devolve o objeto do topo, sobre um navio o hover do
// município some sozinho, e fora dele este tooltip some.
//
// O HTML vem de `render(properties)`; quem renderiza é responsável por
// escapar texto externo (ver vesselTooltip.escapeHtml).

import * as Cesium from 'cesium';

const THROTTLE_MS = 40;
const STYLE_ID = 'datageo-entity-tooltip-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .datageo-entity-tooltip {
      position: fixed;
      display: none;
      max-width: 340px;
      padding: 10px 12px;
      background: rgba(3, 10, 18, 0.92);
      border: 1px solid rgba(34, 211, 238, 0.35);
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      line-height: 1.5;
      color: #cbd5e1;
      z-index: 149; /* acima dos painéis (< 150), abaixo da pílula de voz e dos toasts */
      pointer-events: none;
      white-space: normal;
    }
    .datageo-entity-tooltip .vt-nome {
      color: #22d3ee;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin-bottom: 2px;
    }
    .datageo-entity-tooltip .vt-status { margin-bottom: 4px; }
    .datageo-entity-tooltip .vt-berco { color: #fbbf24; }
    .datageo-entity-tooltip .vt-fundeio { color: #94a3b8; }
    .datageo-entity-tooltip .vt-ais { color: #7dd3fc; }
    .datageo-entity-tooltip .vt-dim { color: #64748b; }
    .datageo-entity-tooltip .vt-fontes {
      margin-top: 6px;
      color: #475569;
      font-size: 9px;
      letter-spacing: 0.04em;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Posição do tooltip junto ao cursor, virando para dentro da tela perto das
 * bordas. Pura.
 */
export function tooltipPlacement(pointer, box, viewport, offset = { x: 16, y: 12 }) {
  let left = pointer.x + offset.x;
  let top = pointer.y + offset.y;
  if (left + box.width > viewport.width - 8) left = Math.max(8, pointer.x - offset.x - box.width);
  if (top + box.height > viewport.height - 8) top = Math.max(8, pointer.y - offset.y - box.height);
  return { left, top };
}

// Camadas de LINHA clamped (estradas conveniadas) ficam, no pick, embaixo do
// preenchimento dos municípios: scene.pick devolve o GroundPrimitive do
// município. Elas pedem `drill` e são achadas com drillPick; o hover do
// município consulta `drillHoverAt` para ceder a vez sobre elas.
const DRILL_LIMIT = 4;
const drillOwners = new Set();

const idOf = (picked) => (typeof picked?.id?.id === 'string' ? picked.id.id : null);

/** Há, sob `position`, entidade de alguma camada `drill` ligada? */
export function drillHoverAt(scene, position) {
  const owners = [...drillOwners].filter((o) => o.isActive());
  if (!owners.length || !position) return false;
  return scene.drillPick(position, DRILL_LIMIT).some((picked) => {
    const id = idOf(picked);
    return id && owners.some((o) => id.startsWith(o.idPrefix));
  });
}

/**
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {string} options.idPrefix prefixo dos ids de entidade desta camada
 * @param {(props: object) => string} options.render HTML (texto já escapado)
 * @param {() => boolean} options.isActive camada visível?
 * @param {(entity: Cesium.Entity|null) => void} [options.onHover] avisado quando
 *   a entidade sob o mouse muda (null ao sair), para a camada destacar algo
 * @param {boolean} [options.drill] procurar a entidade também embaixo do topo
 *   (drillPick), para linhas clamped sob o preenchimento dos municípios
 * @param {number} [options.maxWidth] largura máxima em px (padrão 340 do CSS)
 * @returns {{destroy: () => void, hide: () => void}}
 */
export function createEntityHoverTooltip({ viewer, idPrefix, render, isActive, onHover = null, drill = false, maxWidth }) {
  injectStyles();
  const owner = { idPrefix, isActive };
  if (drill) drillOwners.add(owner);
  const el = document.createElement('div');
  el.className = 'datageo-entity-tooltip';
  el.setAttribute('role', 'tooltip');
  if (maxWidth) el.style.maxWidth = `${maxWidth}px`;
  document.body.appendChild(el);

  let pointer = null;
  let pickedPointer = null;
  let hoveredId = null;
  let lastPick = 0;
  let trailing = null;
  let cameraMoving = false;
  let destroyed = false;

  const hide = () => {
    if (hoveredId) onHover?.(null);
    hoveredId = null;
    el.style.display = 'none';
  };

  const place = () => {
    if (!pointer || !hoveredId) return;
    el.style.display = 'block';
    const { left, top } = tooltipPlacement(
      pointer,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const entityFromPick = (picked) => {
    const entity = picked?.id;
    const id = typeof entity?.id === 'string' ? entity.id : null;
    return id && id.startsWith(idPrefix) ? entity : null;
  };

  const runPick = () => {
    if (destroyed || !pointer || cameraMoving) return;
    if (!isActive()) {
      hide();
      return;
    }
    if (pickedPointer && Cesium.Cartesian2.equals(pickedPointer, pointer)) return;
    lastPick = performance.now();
    pickedPointer = Cesium.Cartesian2.clone(pointer, pickedPointer ?? new Cesium.Cartesian2());

    const entity = entityFromPick(viewer.scene.pick(pointer))
      ?? (drill ? viewer.scene.drillPick(pointer, DRILL_LIMIT).map(entityFromPick).find(Boolean) : null);
    if (!entity) {
      hide();
      return;
    }
    if (entity.id !== hoveredId) {
      const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) ?? {};
      const html = render(props);
      if (!html) {
        hide();
        return;
      }
      el.innerHTML = html;
      hoveredId = entity.id;
      onHover?.(entity);
    }
    place();
  };

  const schedule = () => {
    if (cameraMoving) return;
    const wait = THROTTLE_MS - (performance.now() - lastPick);
    if (wait <= 0) {
      runPick();
      return;
    }
    if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        runPick();
      }, wait);
    }
  };

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const position = movement?.endPosition;
    if (!position) return;
    pointer = Cesium.Cartesian2.clone(position, pointer ?? new Cesium.Cartesian2());
    if (hoveredId) place(); // acompanha o mouse sem esperar o pick
    schedule();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  const canvas = viewer.scene.canvas;
  const onLeave = () => {
    pointer = null;
    pickedPointer = null;
    hide();
  };
  canvas.addEventListener('mouseleave', onLeave);

  const removeMoveStart = viewer.camera.moveStart.addEventListener(() => {
    cameraMoving = true;
    hide();
  });
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    cameraMoving = false;
    pickedPointer = null;
    if (pointer) schedule();
  });

  return {
    hide,
    destroy() {
      destroyed = true;
      drillOwners.delete(owner);
      clearTimeout(trailing);
      handler.destroy();
      canvas.removeEventListener('mouseleave', onLeave);
      removeMoveStart();
      removeMoveEnd();
      el.remove();
    },
  };
}
