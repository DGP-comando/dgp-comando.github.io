// Production-build stand-in for src/data/cctv.js. See ./inertLayer.js.
import { createInertLayer } from './inertLayer.js';

// Same frozen values as the real module. src/voice/gevActions.js imports it,
// and gevActions stays in the production graph because hud.js imports
// getBasemapLabelContext from it.
export const CCTV_FOCUS_RESULT = Object.freeze({
  FOCUSED: 'focused',
  NO_ACTIVE_CAMERA: 'no-active-camera',
  TRACKING_HOLDS_VIEW: 'tracking-holds-view',
  COCKPIT_ACTIVE: 'cockpit-active',
});

// subscribe/getUIState are omitted on purpose: ui.js guards both with
// typeof checks and already renders the empty panel via _renderCctvState(null).
export default createInertLayer('cctv', 'CCTV', {
  focusCamera: () => CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA,
  focusNearest: () => null,
  cycleCamera: () => null,
  selectCamera: () => false,
});