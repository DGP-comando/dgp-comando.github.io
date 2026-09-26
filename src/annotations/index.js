import { createAnnotationEngine } from './annotationEngine.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/**
 * Initialize the map-annotation engine and expose it for the voice agent and
 * for manual/dev use via `window.__gevAnnotations`.
 *
 * This module is the single swap point between annotation rendering strategies.
 * The HYBRID renderer draws footprints/routes as MapLibre GeoJSON layers
 * (`dg-annotations*`) and callouts/rings/arrows as a screen-space SVG overlay
 * re-projected with `engine.project`. The engine, resolver, and voice tool
 * wiring are shared across rendering strategies.
 *
 * @param {object} options
 * @param {object} options.engine Motor MapLibre (src/maplibre/engine.js).
 * @param {object} [options.viewer] Sinônimo antigo de `engine`.
 */
export function initAnnotations({ engine = null, viewer = null } = {}) {
  const mapEngine = engine || viewer;
  const renderer = createHybridAnnotationRenderer(mapEngine);
  const annotations = createAnnotationEngine({ viewer: mapEngine, renderer });
  window.__gevAnnotations = annotations;
  return annotations;
}
