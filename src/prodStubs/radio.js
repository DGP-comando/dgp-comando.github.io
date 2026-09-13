// Production-build stand-in for src/data/radio.js. See ./inertLayer.js.
//
// ui.js wires the Radio tuner unconditionally (the panel DOM is removed only
// after StyleManager is constructed), so this stub keeps the real pure tuner
// math and a full, disabled UI-state snapshot. The slot/pointer helpers below
// are copied verbatim from src/data/radio.js; keep them in sync if those
// change. buildRadioTunerTicks only needs the zero-station branch here.
import { createInertLayer } from './inertLayer.js';

const EMPTY_RADIO_UI_STATE = Object.freeze({
  enabled: false,
  loading: false,
  stale: false,
  degraded: false,
  error: null,
  updatedAt: null,
  filter: 'all',
  categories: Object.freeze([]),
  acceptedCatalogGeneration: null,
  presentationActive: false,
  stationCount: 0,
  filteredCount: 0,
  selected: null,
  selectedIndex: -1,
  audioState: 'stopped',
  audioError: null,
  playingStationId: null,
  volume: 0.8,
  effectiveVolume: 0.8,
  voiceDucked: false,
  voiceRestoring: false,
  tuningActive: false,
  tuningStatic: false,
  tuningAwaitingStationId: null,
  tuningPreviewStationId: null,
  tuningRestoredStationId: null,
  tuningCatalogGeneration: null,
  tuningUnavailableStationId: null,
});

/** Map an integer tuner slot directly to one available directory station. */
export function radioTunerSlot(value, stationCount) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count) return { slot: 0, max: 0, locked: false, stationIndex: -1, leftIndex: -1, rightIndex: -1 };
  const max = Math.max(0, count - 1);
  const slot = Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  return {
    slot,
    max,
    locked: true,
    stationIndex: slot,
    leftIndex: slot,
    rightIndex: slot,
  };
}

/** Snap a tuner release to the nearest available directory station. */
export function radioTunerCommitSlot(value, stationCount) {
  return radioTunerSlot(value, stationCount);
}

/** Map one pointer coordinate to continuous absolute directory progress. */
export function radioTunerPointerPosition(clientX, left, width, stationCount, insetPx = 7) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count) return { ratio: 0, coordinate: 0, stationIndex: -1 };
  if (count === 1) return { ratio: 0.5, coordinate: 0, stationIndex: 0 };
  const inset = Math.max(0, Number(insetPx) || 0);
  const usableWidth = Math.max(1, (Number(width) || 0) - inset * 2);
  const ratio = Math.min(1, Math.max(0, ((Number(clientX) || 0) - (Number(left) || 0) - inset) / usableWidth));
  const coordinate = ratio * (count - 1);
  return {
    ratio,
    coordinate,
    stationIndex: Math.min(count - 1, Math.max(0, Math.floor(coordinate + 0.5))),
  };
}

/**
 * Tuner tape model. With no stations in the production build the tape is
 * always empty, which matches the real function's zero-count branch.
 */
export function buildRadioTunerTicks(coordinate, stationCount, width, { insetPx = 7 } = {}) {
  const inset = Math.max(0, Number(insetPx) || 0);
  return { ticks: [], needleX: inset, pitchPx: 0, ratio: 0 };
}

const noop = () => {};

/** Subscribe to radio state; the current state is delivered immediately. */
function subscribe(listener) {
  if (typeof listener !== 'function') return noop;
  listener(EMPTY_RADIO_UI_STATE);
  return noop;
}

export const radioLayer = createInertLayer('radio', 'Radio', {
  subscribe,
  subscribePlaybackControls: () => noop,
  getUIState: () => EMPTY_RADIO_UI_STATE,
  getParams: () => ({ filter: 'all', volume: 0.8 }),
  setParams: () => false,
  getTunerStations: () => [],
  beginTuning: () => false,
  setTuningStatic: noop,
  previewTuningStation: () => null,
  commitTuningStation: () => ({ ok: false, reason: 'station-unavailable' }),
  cancelTuning: noop,
  endTuning: noop,
  setFilter: () => false,
  selectStation: () => false,
  selectRequestedStation: () => false,
  cycleStation: () => false,
  togglePlayback: async () => false,
  play: async () => false,
  pause: () => false,
  stopPlayback: () => false,
  setVolume: noop,
  setVoiceDucked: noop,
});

export default radioLayer;
