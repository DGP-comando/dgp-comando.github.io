import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CESIUM_BLOOM_COMPOSITE_SHADER,
  CESIUM_BLOOM_DEFAULTS,
  CESIUM_CONTRAST_BIAS_SHADER,
  CESIUM_GAUSSIAN_BLUR_1D_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  activePasses,
  buildFragmentSource,
  createPostProcess,
  czmBuiltinsFor,
  needsPostProcess,
  overlaySizeFor,
  planPingPong,
} from './postProcess.js';
import { retroShader } from '../styles/retro.js';
import { animeShader } from '../styles/anime.js';
import { noirShader } from '../styles/noir.js';
import { snowShader } from '../styles/snow.js';
import { nightVisionShader } from '../styles/surveillance.js';
import { thermalShader } from '../styles/thermal.js';

const STYLE_SHADERS = [retroShader, nightVisionShader, thermalShader, animeShader, noirShader, snowShader];

// ── prelúdio ─────────────────────────────────────────────────────────────────

test('the prelude turns a Cesium stage body into a GLSL ES 3.00 fragment shader', () => {
  const src = buildFragmentSource('uniform sampler2D colorTexture;\nin vec2 v_textureCoordinates;\nvoid main() { out_FragColor = texture(colorTexture, v_textureCoordinates); }');
  const lines = src.split('\n');
  assert.equal(lines[0], '#version 300 es', '#version must be the very first line');
  assert.ok(src.includes('precision highp float;'));
  assert.equal((src.match(/out vec4 out_FragColor;/g) || []).length, 1, 'declares out_FragColor exactly once');
  assert.ok(src.indexOf('out vec4 out_FragColor;') < src.indexOf('void main'), 'before the body');
  assert.ok(!/czm_/.test(src), 'no czm_ noise when the body uses none');
});

test('every style shader builds unchanged, with no unknown czm_* symbol', () => {
  for (const shader of STYLE_SHADERS) {
    const src = buildFragmentSource(shader.fragmentShader);
    assert.ok(src.endsWith(shader.fragmentShader), `${shader.name}: body is appended verbatim`);
    assert.ok(src.startsWith('#version 300 es\n'));
    assert.match(shader.fragmentShader, /uniform sampler2D colorTexture;/);
    assert.match(shader.fragmentShader, /in vec2 v_textureCoordinates;/);
  }
});

test('style parameters and their defaults are still exposed for the sliders and the link', () => {
  const expected = {
    retro: { pixelation: 5, distortion: 0, instability: 0.4 },
    surveillance: { gain: 0.55, bloom: 0.3, scanlineStr: 1, pixelation: 2.5 },
    thermal: { sensitivity: 0.75, bloom: 0.65, mode: 0, pixelation: 1.5, palette: 0 },
    anime: { saturation: 1, edgeThick: 0.5 },
    noir: { contrastAmt: 1.2, grainAmt: 0.5, vignetteAmt: 0.5 },
    snow: { density: 0.6, wind: 0.5 },
  };
  for (const shader of STYLE_SHADERS) {
    const defaults = Object.fromEntries(Object.entries(shader.uniforms).map(([k, v]) => [k, v.default]));
    assert.deepEqual(defaults, expected[shader.name], shader.name);
    for (const name of Object.keys(shader.uniforms)) {
      assert.match(shader.fragmentShader, new RegExp(`uniform float ${name};`), `${shader.name}.${name} is a real uniform`);
    }
  }
});

test('the bloom shaders pull exactly the czm_* helpers they use, dependencies first', () => {
  assert.deepEqual(czmBuiltinsFor(CESIUM_CONTRAST_BIAS_SHADER), ['czm_epsilon7', 'czm_RGBToHSB', 'czm_HSBToRGB']);
  assert.deepEqual(czmBuiltinsFor(CESIUM_GAUSSIAN_BLUR_1D_SHADER).sort(), ['czm_pixelRatio', 'czm_twoPi', 'czm_viewport']);
  assert.deepEqual(czmBuiltinsFor(CESIUM_BLOOM_COMPOSITE_SHADER), []);
  const blur = buildFragmentSource(CESIUM_GAUSSIAN_BLUR_1D_SHADER, { defines: ['USE_STEP_SIZE'] });
  assert.ok(blur.indexOf('#define USE_STEP_SIZE') < blur.indexOf('#ifdef USE_STEP_SIZE'));
  assert.ok(blur.includes('uniform vec4 czm_viewport;'));
  assert.throws(() => buildFragmentSource('void main(){ out_FragColor = czm_unknownThing; }'), /czm_unknownThing/);
});

test('the fullscreen vertex shader feeds v_textureCoordinates with no buffers', () => {
  assert.ok(FULLSCREEN_VERTEX_SHADER.startsWith('#version 300 es'));
  assert.match(FULLSCREEN_VERTEX_SHADER, /out vec2 v_textureCoordinates;/);
  assert.match(FULLSCREEN_VERTEX_SHADER, /gl_VertexID/);
});

// ── ordem dos passes e decisão de ligar ─────────────────────────────────────

test('pass order follows Cesium: bloom first, then stages in insertion order', () => {
  const bloom = { name: 'bloom', enabled: true };
  const crt = { name: 'crt', enabled: true };
  const nvg = { name: 'nvg', enabled: false };
  const sharpen = { name: 'sharpen', enabled: true };
  assert.deepEqual(activePasses(bloom, [crt, nvg, sharpen]).map((p) => p.name), ['bloom', 'crt', 'sharpen']);
  assert.deepEqual(activePasses({ enabled: false }, [nvg]), []);
  assert.equal(needsPostProcess(null, []), false, 'Normal + no bloom/sharpen = nothing to run');
  assert.equal(needsPostProcess(null, [sharpen]), true);
});

test('ping-pong plan reads the source first, writes the screen last, never reads its own output', () => {
  assert.deepEqual(planPingPong(0), []);
  assert.deepEqual(planPingPong(1), [{ input: -1, output: null }]);
  assert.deepEqual(planPingPong(3), [
    { input: -1, output: 0 },
    { input: 0, output: 1 },
    { input: 1, output: null },
  ]);
  for (const step of planPingPong(6)) assert.notEqual(step.input, step.output);
});

test('overlay copies the map canvas backing size and CSS size', () => {
  assert.deepEqual(overlaySizeFor({ width: 2400, height: 1600, style: { width: '1200px', height: '800px' } }),
    { width: 2400, height: 1600, cssWidth: '1200px', cssHeight: '800px' });
  assert.deepEqual(overlaySizeFor(null), { width: 1, height: 1, cssWidth: '100%', cssHeight: '100%' });
});

// ── estágios no formato do Cesium.PostProcessStage (sem WebGL) ─────────────

function withStubDom(fn) {
  const saved = globalThis.document;
  const makeEl = () => ({
    style: {},
    setAttribute() {},
    remove() { this.removed = true; },
    getContext: () => null, // sem WebGL em node: só a lógica de estágios roda
    after(el) { this.next = el; },
  });
  globalThis.document = { createElement: makeEl };
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn(makeEl);
  } finally {
    console.warn = warn;
    globalThis.document = saved;
  }
}

function stubEngine(makeEl) {
  const listeners = {};
  const mapCanvas = { ...makeEl(), parentNode: {}, width: 100, height: 50 };
  return {
    canvas: mapCanvas,
    container: { appendChild() {} },
    renders: 0,
    listeners,
    on(type, fn) {
      (listeners[type] ||= new Set()).add(fn);
      return () => listeners[type].delete(fn);
    },
    requestRender() { this.renders += 1; },
  };
}

test('stages keep the Cesium shape and toggling decides visibility and frame requests', () => {
  withStubDom((makeEl) => {
    const engine = stubEngine(makeEl);
    const post = createPostProcess(engine);
    assert.equal(engine.canvas.next, post.canvas, 'overlay sits right after the map canvas');
    assert.equal(post.canvas.style.pointerEvents, 'none');
    assert.equal(post.canvas.style.display, 'none', 'hidden until something is enabled');

    const crt = post.addStage({ name: 'crt', fragmentShader: retroShader.fragmentShader, uniforms: { intensity: 0, time: 0 } });
    const sharpen = post.addStage({ name: 'sharpen', fragmentShader: 'x', uniforms: { amount: 1.3 } });
    assert.equal(crt.enabled, false);
    assert.equal(post.isActive(), false);

    const before = engine.renders;
    crt.uniforms.intensity = 0.5; // inactive chain: a uniform write costs no frame
    assert.equal(engine.renders, before);

    crt.enabled = true;
    assert.equal(post.isActive(), true);
    assert.ok(engine.renders > before, 'enabling asks the map for the frame to capture');

    const r = engine.renders;
    crt.uniforms.time = 1.25;
    assert.equal(engine.renders, r + 1, 'a uniform write on an active chain re-renders');
    crt.uniforms.time = 1.25;
    assert.equal(engine.renders, r + 1, 'an unchanged value does not');
    assert.equal(crt.uniforms.time, 1.25);
    assert.ok('time' in crt.uniforms, 'StyleManager detects animated stages by `uniforms.time`');

    post.bloom.enabled = true;
    sharpen.enabled = true;
    assert.deepEqual(post.getDebugState().passes, ['czm_bloom', 'crt', 'sharpen']);
    for (const [k, v] of Object.entries(CESIUM_BLOOM_DEFAULTS)) assert.equal(post.bloom.uniforms[k], v);

    post.bloom.enabled = false;
    crt.enabled = false;
    sharpen.enabled = false;
    assert.equal(post.isActive(), false);
    assert.equal(post.canvas.style.display, 'none', 'Normal without bloom/sharpen hides the overlay');

    post.destroy();
    assert.equal(post.canvas.removed, true);
    assert.equal(engine.listeners.render.size, 0, 'render listener removed');
  });
});
