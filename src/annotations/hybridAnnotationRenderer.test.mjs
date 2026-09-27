import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set();
  }

  reset(value) {
    this.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.names.add(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = new FakeClassList(this);
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.classList.reset(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (className && child.classList.contains(className)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  addEventListener() {}

  getBBox() {
    return { x: 0, y: 0, width: 40, height: 16 };
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }
}

function fakeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const roots = [head, body];
  return {
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    getElementById(id) {
      let found = null;
      const visit = (node) => {
        if (node.getAttribute('id') === id) found = node;
        for (const child of node.children) visit(child);
      };
      for (const root of roots) visit(root);
      return found;
    },
  };
}

function findAnnotationGroup(document) {
  const layer = document.body.children.find((child) => child.classList.contains('gev-screen-whiteboard'));
  const svg = layer.children.find((child) => child.classList.contains('gev-screen-whiteboard-svg'));
  return {
    svg,
    group: svg.children.find((child) => child.classList.contains('gev-anno')),
  };
}

/**
 * Motor MapLibre falso: projeção linear em torno de (lon0, lat0) e um mapa que
 * guarda fontes/layers GeoJSON, o bastante para os dois sub-renderizadores.
 */
function fakeViewer(lon0, lat0) {
  const sources = new Map();
  const layers = new Map();
  const map = {
    getSource: (id) => sources.get(id),
    addSource(id, spec) {
      const source = {
        data: spec.data,
        setData(data) {
          if (map.failNextSetData) {
            map.failNextSetData = false;
            throw new Error('setData failed');
          }
          source.data = data;
        },
      };
      sources.set(id, source);
    },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id),
    addLayer: (spec) => layers.set(spec.id, spec),
    removeLayer: (id) => layers.delete(id),
    setPaintProperty() {},
    failNextSetData: false,
  };
  const project = (lon, lat) => ({ x: 640 + (lon - lon0) * 20, y: 360 - (lat - lat0) * 20, visible: true });
  const viewer = {
    map,
    container: { clientWidth: 1280, clientHeight: 720 },
    trackedTarget: null,
    project,
    getCameraView: () => ({ alt: 1_000_000 }),
    on: () => () => {},
    requestRender() {},
  };
  /** Feições desenhadas no mapa (fonte dg-annotations). */
  const worldFeatures = () => [...sources.entries()].find(([id]) => id.startsWith('dg-annotations'))?.[1]?.data?.features || [];
  return { viewer, map, project, worldFeatures };
}

/** Install the browser globals both renderers touch, restored after the test. */
function installBrowserGlobals(t) {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  globalThis.document = fakeDocument();
  // Sem loop contínuo nos testes: o rAF do callout roda na hora, o do pulso nunca.
  globalThis.requestAnimationFrame = (callback) => {
    if (callback.length === 0) callback();
    return 1;
  };
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; } };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
}

function annotationGroups(svg) {
  return svg.children.filter((child) => child.classList.contains('gev-anno'));
}

function naiveRingCentroid(ring) {
  const totals = ring.reduce(
    (sum, [lon, lat]) => ({ lon: sum.lon + lon, lat: sum.lat + lat }),
    { lon: 0, lat: 0 },
  );
  return { lon: totals.lon / ring.length, lat: totals.lat / ring.length, height: 0 };
}

const TEXAS = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];

function texasArea(id) {
  return {
    id,
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(TEXAS),
    ring: TEXAS,
    footprintKind: 'area',
    synthesized: false,
  };
}

test('hybrid outline upgrade preserves the screen group and adds world geometry', (t) => {
  installBrowserGlobals(t);
  const { viewer, project, worldFeatures } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = {
    id: 'anno-hybrid-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
    footprintKind: null,
    synthesized: false,
  };

  renderer.add(anno);
  const before = findAnnotationGroup(globalThis.document);
  const originalCallout = before.group.querySelector('.gev-anno-callout');
  const originalDot = before.group.querySelector('.gev-anno-dot');
  assert.equal(before.group.querySelectorAll('.gev-anno-ring').length, 2);
  assert.equal(worldFeatures().length, 0, 'a pending area draws nothing on the map yet');

  const centroid = naiveRingCentroid(TEXAS);
  anno.ring = TEXAS;
  anno.anchor = centroid;
  anno.footprintKind = 'area';
  renderer.update(anno);

  const after = findAnnotationGroup(globalThis.document);
  const expectedWindow = project(centroid.lon, centroid.lat);
  assert.equal(after.group, before.group, 'the real hybrid keeps the existing SVG group');
  assert.equal(after.svg.children.filter((child) => child.classList.contains('gev-anno')).length, 1);
  assert.equal(after.group.querySelectorAll('.gev-anno-ring').length, 0, 'screen reticle rings are removed');
  assert.equal(after.group.querySelector('.gev-anno-callout'), originalCallout, 'the callout node is retained');
  assert.equal(after.group.querySelector('.gev-anno-dot'), originalDot, 'the anchor dot is retained');
  assert.equal(originalDot.getAttribute('cx'), expectedWindow.x.toFixed(1));
  assert.equal(originalDot.getAttribute('cy'), expectedWindow.y.toFixed(1));
  assert.deepEqual(centroid, { lon: -100.8, lat: 29.4, height: 0 }, 'closed-ring vertex mean stays pinned');
  const features = worldFeatures();
  assert.equal(features.length, 2, 'world area adds one fill and one outline');
  assert.equal(features.filter((f) => f.geometry.type === 'Polygon').length, 1);
  assert.equal(features.filter((f) => f.geometry.type === 'LineString').length, 1);
  assert.ok(features.every((f) => f.properties.annoId === 'anno-hybrid-fb3'));
  renderer.destroy();
});

// ── Partial-add rollback (second review) ─────────────────────────────────────
//
// The hybrid builds a mark across TWO sub-renderers. A throw in the second one
// must not leave the first one's content live with nothing pointing at it:
// remove() has to reach it by id, and a retry must draw exactly ONE mark.

test('a sub-renderer throw mid-add leaves state the rollback can still remove', (t) => {
  installBrowserGlobals(t);
  const { viewer, worldFeatures } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = texasArea('anno-partial-add');

  const { svg } = findAnnotationGroup(globalThis.document);
  const appendChild = svg.appendChild.bind(svg);
  let failNextInsert = true;
  svg.appendChild = (child) => {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error('screen insert failed');
    }
    return appendChild(child);
  };

  assert.throws(() => renderer.add(anno), /screen insert failed/);
  assert.equal(worldFeatures().length, 2, 'the world layer is already live');
  assert.equal(annotationGroups(svg).length, 0, 'the half-built screen group detached itself');

  renderer.remove(anno);
  assert.equal(worldFeatures().length, 0, 'partial world state must be released');

  renderer.add(anno);
  assert.equal(worldFeatures().length, 2, 'the retry draws exactly one world mark');
  assert.equal(annotationGroups(svg).length, 1, 'and exactly one screen caption');
  renderer.remove(anno);
  assert.equal(worldFeatures().length, 0);
  renderer.destroy();
});

test('a release that throws keeps the mark addressable for a retry cleanup', (t) => {
  installBrowserGlobals(t);
  const { viewer, worldFeatures } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = texasArea('anno-release-throw');

  renderer.add(anno);
  const { svg } = findAnnotationGroup(globalThis.document);
  assert.equal(worldFeatures().length, 2);
  assert.equal(annotationGroups(svg).length, 1);

  const workingSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = () => { throw new Error('teardown scheduling failed'); };
  assert.throws(() => renderer.remove(anno), /teardown scheduling failed/);
  assert.equal(worldFeatures().length, 0, 'the world route did release');
  assert.equal(annotationGroups(svg).length, 1, 'the screen route did NOT — that is the orphan');

  globalThis.window.setTimeout = workingSetTimeout;
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0, 'the retry cleanup must reach the orphan');
  assert.equal(worldFeatures().length, 0, 'without double-releasing the world route');

  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0);
  renderer.destroy();
});

test('a map write that fails mid-add never orphans the world mark', (t) => {
  installBrowserGlobals(t);
  const { viewer, map, worldFeatures } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = texasArea('anno-partial-world-add');

  // The style is mid-swap: the GeoJSON write fails. The mark is still owned by
  // the renderer, so the next write (another mark, or a sync) draws it…
  renderer.add(texasArea('warm-up'));
  map.failNextSetData = true;
  renderer.add(anno);
  assert.equal(worldFeatures().length, 2, 'the failed write left the previous board intact');
  assert.ok(worldFeatures().every((f) => f.properties.annoId === 'warm-up'));
  renderer.sync(new Map());
  assert.equal(worldFeatures().filter((f) => f.properties.annoId === anno.id).length, 2);

  // …and the rollback reaches it by id.
  renderer.remove(anno);
  assert.equal(worldFeatures().filter((f) => f.properties.annoId === anno.id).length, 0);
  renderer.destroy();
});
