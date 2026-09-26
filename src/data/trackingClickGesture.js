// src/data/trackingClickGesture.js
//
// MIGRAÇÃO MAPLIBRE (2026-09): sem Cesium. `bindTrackingClickGesture` aceita
//  - o `engine` do app (src/maplibre/engine.js): escuta pointerdown/move/up no
//    canvas e o 'click' do motor; o callback recebe
//    `click = {position: {x, y}, lon, lat, originalEvent}` (px CSS do container);
//  - ou, como antes, qualquer objeto com `setInputAction(fn, tipo)` (o antigo
//    ScreenSpaceEventHandler, e os testes), com `options.eventTypes`
//    {LEFT_DOWN, MOUSE_MOVE, LEFT_UP, LEFT_CLICK}.
// Devolve uma função que desfaz as escutas (no modo engine).

/** Tipos de evento padrão do modo `setInputAction` (antes Cesium.ScreenSpaceEventType). */
export const TRACKING_EVENT_TYPES = Object.freeze({
  LEFT_DOWN: 'LEFT_DOWN',
  MOUSE_MOVE: 'MOUSE_MOVE',
  LEFT_UP: 'LEFT_UP',
  LEFT_CLICK: 'LEFT_CLICK',
});

export const MAX_TRACKING_CLICK_TRAVEL_PX = 6;
export const MAX_TRACKING_CLICK_DURATION_MS = 400;

/**
 * Decide whether a completed press stayed spatially click-like. Duration is
 * deliberately ignored so a stationary long press may still select a contact;
 * callers apply the full click classifier before destructive deselection.
 * @param {{travelPx?: number}} gesture - Accumulated pointer path.
 * @returns {boolean} True when travel stays within the click limit.
 */
export function isTrackingSelectionGesture(gesture = {}) {
  const travelPx = Number.isFinite(gesture.travelPx)
    ? Math.max(0, gesture.travelPx)
    : Number.POSITIVE_INFINITY;
  return travelPx <= MAX_TRACKING_CLICK_TRAVEL_PX;
}

/**
 * Decide whether a completed press is a clean click suitable for deselection
 * or another action that requires both short duration and low travel.
 * @param {{travelPx?: number, durationMs?: number}} gesture - Accumulated path and press time.
 * @returns {boolean} True when the gesture stays within both click limits.
 */
export function isTrackingClickGesture(gesture = {}) {
  const durationMs = Number.isFinite(gesture.durationMs)
    ? Math.max(0, gesture.durationMs)
    : Number.POSITIVE_INFINITY;
  return isTrackingSelectionGesture(gesture)
    && durationMs <= MAX_TRACKING_CLICK_DURATION_MS;
}

/** Adapta o `engine` ao contrato setInputAction (eventos em px do container). */
function engineInputAdapter(engine) {
  const el = engine.canvas || engine.container;
  const removers = [];
  const localPoint = (ev) => {
    const box = (engine.container || el).getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  };
  return {
    setInputAction(fn, type) {
      if (type === 'LEFT_CLICK') {
        removers.push(engine.on('click', (e) => fn({
          position: { x: e.x, y: e.y }, lon: e.lon, lat: e.lat, originalEvent: e.originalEvent,
        })));
        return;
      }
      const domType = { LEFT_DOWN: 'pointerdown', MOUSE_MOVE: 'pointermove', LEFT_UP: 'pointerup' }[type];
      if (!domType || !el) return;
      const handler = (ev) => {
        if (type !== 'MOUSE_MOVE' && ev.button !== 0) return;
        const p = localPoint(ev);
        fn(type === 'MOUSE_MOVE' ? { endPosition: p, position: p, originalEvent: ev } : { position: p, originalEvent: ev });
      };
      el.addEventListener(domType, handler, { passive: true });
      removers.push(() => el.removeEventListener(domType, handler));
    },
    destroy() {
      for (const r of removers.splice(0)) r?.();
    },
  };
}

/**
 * Bind LEFT_DOWN/MOUSE_MOVE/LEFT_UP accounting ahead of a scene click.
 * Travel is accumulated segment-by-segment, so an orbit nudge that returns to
 * its starting pixel cannot masquerade as a zero-distance click. Every scene
 * click reaches `onClick` with its gesture metadata; the caller decides whether
 * selection (travel-only) or deselection (travel + duration) is allowed.
 * @param {Object} handler - `engine` do app, ou objeto com setInputAction(fn, tipo).
 * @param {(click: Object, gesture: {travelPx: number, durationMs: number}) => void} onClick - Scene-click callback.
 * @param {{now?: () => number, eventTypes?: Object, onMouseMove?: (event: Object) => void}} [options] - Test/interop seams.
 * @returns {() => void} Desfaz as escutas (modo engine; no-op no modo setInputAction).
 */
export function bindTrackingClickGesture(handlerOrEngine, onClick, options = {}) {
  const now = options.now || (() => performance.now());
  const adapter = typeof handlerOrEngine?.setInputAction === 'function' ? null : engineInputAdapter(handlerOrEngine);
  const handler = adapter || handlerOrEngine;
  const eventTypes = adapter ? TRACKING_EVENT_TYPES : (options.eventTypes || TRACKING_EVENT_TYPES);
  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (!pressActive || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    if (previousPosition) {
      travelPx += Math.hypot(
        position.x - previousPosition.x,
        position.y - previousPosition.y,
      );
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = {
      travelPx,
      durationMs: Math.max(0, now() - pressStartedAt),
    };
    pressActive = false;
    previousPosition = null;
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
    options.onMouseMove?.(event);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    onClick(click, gesture);
  }, eventTypes.LEFT_CLICK);

  return () => adapter?.destroy();
}
