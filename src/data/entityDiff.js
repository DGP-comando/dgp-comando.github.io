// src/data/entityDiff.js
//
// Pure helpers for refreshing DataGeo layers without tearing the scene down.
// Nothing here imports Cesium: values are compared by duck typing (`equals`,
// `getValue`) so the logic runs under node:test and the Cesium call sites stay
// thin and defensive.
//
//   - diffById: id-keyed plan (add / update / remove) between the ids already
//     on screen and the rows of a new poll.
//   - sameGraphicValue / graphicsPatchKeys: decide which graphics properties
//     actually changed, so an in-place update does not raise definitionChanged
//     (and re-tessellate clamped geometry) for values that are identical.
//   - createCachedFactory: memoize immutable values (Cesium.Color from a CSS
//     string, DistanceDisplayCondition by distance) instead of allocating one
//     per feature.
//   - createReadyPump: request renders on an interval until an asynchronously
//     built primitive reports `ready`. Needed because the render governor keeps
//     the scene in requestRenderMode, where nothing renders (and so no async
//     primitive progresses) unless someone asks for a frame.

/**
 * Plan an id-keyed refresh.
 *
 * Items whose id is null/undefined/'' are reported in `missingIds`; repeated
 * ids keep the FIRST occurrence and are counted in `duplicates` (adding the
 * same entity id twice would throw in Cesium). Callers decide whether a
 * source with missing ids can use the plan or must fall back to a full
 * rebuild.
 *
 * @template T
 * @param {Set<string>|Iterable<string>|null|undefined} prevIds Ids currently rendered.
 * @param {Iterable<T>|null|undefined} nextItems Items of the new snapshot.
 * @param {(item: T) => (string|number|null|undefined)} getId Stable id extractor.
 * @returns {{
 *   add: Array<{id: string, item: T}>,
 *   update: Array<{id: string, item: T}>,
 *   remove: string[],
 *   nextIds: Set<string>,
 *   missingIds: number,
 *   duplicates: number,
 * }}
 */
export function diffById(prevIds, nextItems, getId) {
  if (typeof getId !== 'function') throw new TypeError('diffById requires a getId function');
  const previous = prevIds instanceof Set ? prevIds : new Set(prevIds ?? []);
  const add = [];
  const update = [];
  const nextIds = new Set();
  let missingIds = 0;
  let duplicates = 0;

  for (const item of nextItems ?? []) {
    const raw = getId(item);
    if (raw === null || raw === undefined || raw === '') {
      missingIds += 1;
      continue;
    }
    const id = String(raw);
    if (nextIds.has(id)) {
      duplicates += 1;
      continue;
    }
    nextIds.add(id);
    if (previous.has(id)) update.push({ id, item });
    else add.push({ id, item });
  }

  const remove = [];
  for (const id of previous) {
    if (!nextIds.has(id)) remove.push(id);
  }
  return { add, update, remove, nextIds, missingIds, duplicates };
}

function isPropertyLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.getValue === 'function';
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof a.equals === 'function') {
    try {
      return a.equals(b) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether assigning `next` to a graphics slot currently holding `current`
 * would be a no-op. `current` is what Cesium stores (a ConstantProperty, a
 * MaterialProperty or undefined); `next` is the raw option value (a Color, a
 * number, a ColorMaterialProperty...).
 *
 * @param {*} current Value stored on the graphics object.
 * @param {*} next Value about to be assigned.
 * @param {*} [time] Clock time handed to getValue (Cesium JulianDate).
 * @returns {boolean}
 */
export function sameGraphicValue(current, next, time) {
  if (current === next) return true;
  if (next === undefined || next === null) {
    if (current === undefined || current === null) return true;
    if (!isPropertyLike(current) || current.isConstant === false) return false;
    try {
      const value = current.getValue(time);
      return value === next || (value === undefined && next === undefined);
    } catch {
      return false;
    }
  }
  if (current === undefined || current === null) return false;
  // Property to Property (e.g. ColorMaterialProperty): Cesium's own equals.
  if (isPropertyLike(next)) return valuesEqual(current, next);
  if (!isPropertyLike(current)) return valuesEqual(current, next);
  // Only constant properties can be compared without a clock.
  if (current.isConstant === false) return false;
  let value;
  try {
    value = current.getValue(time);
  } catch {
    return false;
  }
  return valuesEqual(value, next);
}

/**
 * Keys of `options` whose value differs from what `graphics` holds.
 * @param {object|null|undefined} graphics Existing Cesium graphics (PointGraphics, LabelGraphics...).
 * @param {object|null|undefined} options Raw options for the same graphics.
 * @param {*} [time] Clock time handed to getValue (Cesium JulianDate).
 * @returns {string[]}
 */
export function graphicsPatchKeys(graphics, options, time) {
  if (!options) return [];
  const keys = [];
  for (const key of Object.keys(options)) {
    if (!sameGraphicValue(graphics?.[key], options[key], time)) keys.push(key);
  }
  return keys;
}

// Entity option keys that are Cesium graphics objects (patched field by field).
const GRAPHICS_KEYS = new Set([
  'point', 'label', 'billboard', 'ellipse', 'polygon', 'polyline', 'box', 'model',
]);

function patchPropertyBag(entity, values, time) {
  const bag = entity.properties;
  if (!bag || typeof bag.hasProperty !== 'function' || !Array.isArray(bag.propertyNames)) {
    entity.properties = values;
    return 1;
  }
  let changes = 0;
  for (const name of Object.keys(values)) {
    if (!bag.hasProperty(name)) {
      bag.addProperty(name, values[name]);
      changes += 1;
    } else if (!sameGraphicValue(bag[name], values[name], time)) {
      bag[name] = values[name];
      changes += 1;
    }
  }
  for (const name of [...bag.propertyNames]) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      bag.removeProperty(name);
      changes += 1;
    }
  }
  return changes;
}

/**
 * Update an existing entity in place from the same options object that would
 * have been passed to `entities.add`. Only values that changed are assigned,
 * so unchanged labels keep their glyphs and unchanged clamped ellipses are
 * not re-tessellated.
 *
 * @param {object} entity Existing entity (duck typed).
 * @param {object} options Entity construction options (the `id` key is ignored).
 * @param {*} [time] Clock time for property reads.
 * @returns {number} Number of assignments performed.
 */
export function patchEntity(entity, options, time) {
  if (!entity || !options) return 0;
  let changes = 0;
  for (const key of Object.keys(options)) {
    if (key === 'id') continue;
    const next = options[key];
    const current = entity[key];
    if (key === 'properties' && next && typeof next === 'object' && !isPropertyLike(next)) {
      changes += patchPropertyBag(entity, next, time);
      continue;
    }
    if (GRAPHICS_KEYS.has(key)) {
      if (next === undefined || next === null) {
        if (current !== undefined && current !== null) {
          entity[key] = undefined;
          changes += 1;
        }
        continue;
      }
      if (current === undefined || current === null) {
        entity[key] = next;
        changes += 1;
        continue;
      }
      for (const field of graphicsPatchKeys(current, next, time)) {
        current[field] = next[field];
        changes += 1;
      }
      continue;
    }
    if (!sameGraphicValue(current, next, time)) {
      entity[key] = next;
      changes += 1;
    }
  }
  return changes;
}

/**
 * Apply one snapshot to an entity collection with an id-keyed diff.
 *
 * `entityById` is the layer's live index (id -> entity) and is kept in sync.
 * When any option lacks an `id` the source has no stable identity, so the
 * previous behavior (removeAll + add everything) is used and `newIds` is
 * empty: "new since last refresh" is meaningless without ids.
 *
 * @param {object} args
 * @param {{add: Function, remove: Function, removeAll: Function,
 *   suspendEvents?: Function, resumeEvents?: Function}} args.collection
 * @param {Map<string, object>} args.entityById
 * @param {object[]} args.nextOptions Entity options, each with an `id`.
 * @param {*} [args.time] Clock time for property reads.
 * @returns {{mode: 'diff'|'rebuild', count: number, newIds: Set<string>,
 *   added: number, updated: number, removed: number, duplicates: number}}
 */
export function applyIdRefresh({ collection, entityById, nextOptions, time }) {
  const options = Array.isArray(nextOptions) ? nextOptions : [];
  const plan = diffById(new Set(entityById.keys()), options, (o) => o?.id);
  collection.suspendEvents?.();
  try {
    if (plan.missingIds > 0) {
      collection.removeAll();
      entityById.clear();
      for (const opts of options) {
        const entity = collection.add(opts);
        if (opts?.id !== undefined && opts?.id !== null && opts?.id !== '') {
          entityById.set(String(opts.id), entity);
        }
      }
      return {
        mode: 'rebuild',
        count: options.length,
        newIds: new Set(),
        added: options.length,
        updated: 0,
        removed: 0,
        duplicates: plan.duplicates,
      };
    }
    for (const id of plan.remove) {
      const entity = entityById.get(id);
      if (entity) collection.remove(entity);
      entityById.delete(id);
    }
    let updated = 0;
    for (const { id, item } of plan.update) {
      if (patchEntity(entityById.get(id), item, time) > 0) updated += 1;
    }
    const newIds = new Set();
    for (const { id, item } of plan.add) {
      entityById.set(id, collection.add(item));
      newIds.add(id);
    }
    return {
      mode: 'diff',
      count: plan.nextIds.size,
      newIds,
      added: plan.add.length,
      updated,
      removed: plan.remove.length,
      duplicates: plan.duplicates,
    };
  } finally {
    collection.resumeEvents?.();
  }
}

/**
 * Memoize an immutable-value factory by a string key.
 * @template V
 * @param {(...args: any[]) => V} create Factory for a missing key.
 * @param {(...args: any[]) => string} [keyOf] Cache key; defaults to joined args.
 * @returns {((...args: any[]) => V) & {size: () => number, clear: () => void}}
 */
export function createCachedFactory(create, keyOf = (...args) => args.join('|')) {
  const cache = new Map();
  const cached = (...args) => {
    const key = keyOf(...args);
    if (cache.has(key)) return cache.get(key);
    const value = create(...args);
    cache.set(key, value);
    return value;
  };
  cached.size = () => cache.size;
  cached.clear = () => cache.clear();
  return cached;
}

/**
 * Request renders until every tracked primitive is ready (or a timeout).
 *
 * @param {object} options
 * @param {() => boolean} options.isReady True once the work is done.
 * @param {() => void} options.requestRender Asks the scene for one frame.
 * @param {() => void} [options.onReady] Called once when ready.
 * @param {number} [options.intervalMs=120] Frame request cadence.
 * @param {number} [options.timeoutMs=60000] Give up after this long.
 * @param {(fn: () => void, ms: number) => any} [options.setIntervalFn]
 * @param {(handle: any) => void} [options.clearIntervalFn]
 * @param {() => number} [options.now]
 * @returns {{start: () => void, stop: () => void, isRunning: () => boolean}}
 */
export function createReadyPump({
  isReady,
  requestRender,
  onReady = () => {},
  intervalMs = 120,
  timeoutMs = 60_000,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (handle) => clearInterval(handle),
  now = () => Date.now(),
} = {}) {
  if (typeof isReady !== 'function' || typeof requestRender !== 'function') {
    throw new TypeError('createReadyPump requires isReady and requestRender');
  }
  let handle = null;
  let startedAt = 0;

  const stop = () => {
    if (handle !== null) clearIntervalFn(handle);
    handle = null;
  };

  const tick = () => {
    let ready = false;
    try {
      ready = isReady() === true;
    } catch {
      ready = false;
    }
    if (ready) {
      stop();
      // One last frame so the finished primitive is actually on screen.
      requestRender();
      onReady();
      return;
    }
    if (now() - startedAt > timeoutMs) {
      stop();
      return;
    }
    requestRender();
  };

  return {
    start() {
      if (handle !== null) return;
      startedAt = now();
      handle = setIntervalFn(tick, intervalMs);
      tick();
    },
    stop,
    isRunning: () => handle !== null,
  };
}
