/**
 * Inert stand-ins for proxy-dependent GEV layers in the production build.
 *
 * The static deploy never registers these layers (see
 * PROXY_DEPENDENT_LAYER_IDS in src/main.js), yet src/ui.js and src/main.js
 * import them statically. vite.config.js redirects those imports here for
 * `vite build` only, so the real multi-thousand-line modules stay out of the
 * production bundle. `vite` (dev) and node tests always load the real modules.
 *
 * Contract: every member a production code path can reach without a
 * registered layer exists and returns a "nothing available" value. Optional
 * members that ui.js reads through `?.` or `typeof` guards are intentionally
 * omitted so those guards keep taking their "layer absent" branch.
 *
 * @module prodStubs/inertLayer
 */

const noop = () => {};

/**
 * Build a frozen inert layer object.
 * @param {string} id Layer id used by the real module.
 * @param {string} name Display name used by the real module.
 * @param {object} [extra] Additional inert members for this layer.
 * @returns {object}
 */
export function createInertLayer(id, name, extra = {}) {
  return Object.freeze({
    id,
    name,
    prodStub: true,
    init: noop,
    enable: noop,
    disable: noop,
    update: async () => {},
    destroy: noop,
    getStats: () => ({}),
    // detection.js iterates the layers passed to initDetection().
    getDetectableObjects: () => [],
    ...extra,
  });
}
