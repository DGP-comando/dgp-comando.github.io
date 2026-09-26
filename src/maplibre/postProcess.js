// src/maplibre/postProcess.js
//
// PÓS-PROCESSAMENTO DE TELA (substitui os PostProcessStages do Cesium)
// ====================================================================
//
// O MapLibre não tem cadeia de pós-processamento. Este módulo sobrepõe ao
// canvas do mapa um canvas WebGL2 próprio (pointer-events: none, mesmo
// tamanho e DPR) e, a cada quadro que o mapa desenha (evento 'render' do
// engine, disparado logo depois do painter), copia o canvas do mapa para uma
// textura e aplica a cadeia de passes com os MESMOS fragment shaders GLSL de
// src/styles/*.js, do sharpen (ui.js) e do bloom do Cesium (ContrastBias →
// GaussianBlur1D x/y → BloomComposite), portados verbatim.
//
// A cópia não precisa de `preserveDrawingBuffer`: ela acontece dentro do
// evento 'render', na mesma tarefa em que o MapLibre desenhou, antes de o
// navegador compor e descartar o buffer.
//
// Compatibilidade com o código do StyleManager: cada estágio é um objeto no
// formato do Cesium.PostProcessStage — `{ name, uniforms, enabled }` —; quem
// escreve `stage.uniforms.x = v` ou `stage.enabled = b` (ui.js,
// cockpitVisionPolicy.js) continua funcionando, e a escrita pede um quadro ao
// mapa. `post.bloom` imita `scene.postProcessStages.bloom` (uniforms contrast,
// brightness, delta, sigma, stepSize, glowOnly).
//
// Ordem dos passes (a mesma do PostProcessStageCollection do Cesium): bloom
// primeiro, depois os estágios na ordem em que foram adicionados.
//
// Custo zero quando nada está ligado: sem estágio habilitado, o canvas fica
// `display: none`, o listener de 'render' retorna na primeira comparação e
// nenhuma textura é copiada. O relógio (`time`) dos estilos animados é
// escrito pelo StyleManager, que segura o render contínuo (renderGovernor)
// enquanto um estilo animado está visível.
//
//   const post = createPostProcess(engine)
//   const stage = post.addStage({ name, fragmentShader, uniforms })
//   stage.enabled = true; stage.uniforms.intensity = 1
//   post.bloom.enabled = true; post.bloom.uniforms.sigma = 2
//   post.isActive()      alguma etapa ligada (canvas visível)
//   post.getDebugState() {active, passes, frames, width, height}
//   post.destroy()

/** Vértice de tela cheia sem buffers (triângulo gigante via gl_VertexID). */
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
out vec2 v_textureCoordinates;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_textureCoordinates = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// ── Bloom do Cesium (Source/Shaders/PostProcessStages/*.glsl, Cesium 1.x) ──

export const CESIUM_CONTRAST_BIAS_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform float contrast;
uniform float brightness;

in vec2 v_textureCoordinates;

void main(void)
{
    vec3 sceneColor = texture(colorTexture, v_textureCoordinates).xyz;
    sceneColor = czm_RGBToHSB(sceneColor);
    sceneColor.z += brightness;
    sceneColor = czm_HSBToRGB(sceneColor);

    float factor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
    sceneColor = factor * (sceneColor - vec3(0.5)) + vec3(0.5);
    out_FragColor = vec4(sceneColor, 1.0);
}
`;

export const CESIUM_GAUSSIAN_BLUR_1D_SHADER = /* glsl */ `
#define SAMPLES 8

uniform float delta;
uniform float sigma;
uniform float direction; // 0.0 for x direction, 1.0 for y direction

uniform sampler2D colorTexture;

#ifdef USE_STEP_SIZE
uniform float stepSize;
#else
uniform vec2 step;
#endif

in vec2 v_textureCoordinates;

void main()
{
    vec2 st = v_textureCoordinates;
    vec2 dir = vec2(1.0 - direction, direction);

#ifdef USE_STEP_SIZE
    vec2 step = vec2(stepSize * (czm_pixelRatio / czm_viewport.zw));
#else
    vec2 step = step;
#endif

    vec3 g;
    g.x = 1.0 / (sqrt(czm_twoPi) * sigma);
    g.y = exp((-0.5 * delta * delta) / (sigma * sigma));
    g.z = g.y * g.y;

    vec4 result = texture(colorTexture, st) * g.x;
    for (int i = 1; i < SAMPLES; ++i)
    {
        g.xy *= g.yz;

        vec2 offset = float(i) * dir * step;
        result += texture(colorTexture, st - offset) * g.x;
        result += texture(colorTexture, st + offset) * g.x;
    }

    out_FragColor = result;
}
`;

export const CESIUM_BLOOM_COMPOSITE_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D bloomTexture;
uniform bool glowOnly;

in vec2 v_textureCoordinates;

void main(void)
{
    vec4 color = texture(colorTexture, v_textureCoordinates);
    vec4 bloom = texture(bloomTexture, v_textureCoordinates);
    out_FragColor = glowOnly ? bloom : bloom + color;
}
`;

/** Defaults do `createBloomStage` do Cesium (o StyleManager sobrescreve). */
export const CESIUM_BLOOM_DEFAULTS = Object.freeze({
  glowOnly: false,
  contrast: 128.0,
  brightness: -0.3,
  delta: 1.0,
  sigma: 2.0,
  stepSize: 1.0,
});

// ── Prelúdio czm_* ─────────────────────────────────────────────────────────
//
// Só o que os shaders do app (e o bloom) usam. Cada entrada declara as suas
// dependências para o prelúdio sair em ordem válida.
const CZM_BUILTINS = {
  czm_pi: { code: 'const float czm_pi = 3.141592653589793;' },
  czm_twoPi: { code: 'const float czm_twoPi = 6.283185307179586;' },
  czm_piOverTwo: { code: 'const float czm_piOverTwo = 1.5707963267948966;' },
  czm_epsilon7: { code: 'const float czm_epsilon7 = 0.0000001;' },
  czm_viewport: { code: 'uniform vec4 czm_viewport;' },
  czm_pixelRatio: { code: 'uniform float czm_pixelRatio;' },
  czm_frameNumber: { code: 'uniform float czm_frameNumber;' },
  czm_RGBToHSB: {
    deps: ['czm_epsilon7'],
    code: `const vec4 K_RGB2HSB = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
vec3 czm_RGBToHSB(vec3 rgb)
{
    vec4 p = mix(vec4(rgb.bg, K_RGB2HSB.wz), vec4(rgb.gb, K_RGB2HSB.xy), step(rgb.b, rgb.g));
    vec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + czm_epsilon7)), d / (q.x + czm_epsilon7), q.x);
}`,
  },
  czm_HSBToRGB: {
    code: `const vec4 K_HSB2RGB = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
vec3 czm_HSBToRGB(vec3 hsb)
{
    vec3 p = abs(fract(hsb.xxx + K_HSB2RGB.xyz) * 6.0 - K_HSB2RGB.www);
    return hsb.z * mix(K_HSB2RGB.xxx, clamp(p - K_HSB2RGB.xxx, 0.0, 1.0), hsb.y);
}`,
  },
};

/** Nomes czm_* referenciados pelo corpo do shader, com dependências, em ordem de emissão. */
export function czmBuiltinsFor(body) {
  const found = new Set(String(body).match(/\bczm_\w+/g) || []);
  const ordered = [];
  const visit = (name) => {
    const entry = CZM_BUILTINS[name];
    if (!entry || ordered.includes(name)) return;
    for (const dep of entry.deps || []) visit(dep);
    ordered.push(name);
  };
  for (const name of found) visit(name);
  return ordered;
}

/**
 * Monta a fonte GLSL ES 3.00 completa de um fragment shader escrito para o
 * PostProcessStage do Cesium: versão, precisão, `out_FragColor`, #defines e
 * os czm_* usados. O corpo do shader não é alterado.
 * @param {string} body
 * @param {{defines?: string[]}} [options]
 * @returns {string}
 */
export function buildFragmentSource(body, { defines = [] } = {}) {
  const src = String(body).replace(/^\s*#version[^\n]*\n/, '');
  const unknown = (src.match(/\bczm_\w+/g) || []).filter((n) => !CZM_BUILTINS[n]);
  if (unknown.length) throw new Error(`[postProcess] czm_* sem prelúdio: ${[...new Set(unknown)].join(', ')}`);
  const lines = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    ...defines.map((d) => `#define ${d}`),
    'out vec4 out_FragColor;',
    ...czmBuiltinsFor(src).map((n) => CZM_BUILTINS[n].code),
    '#line 1',
    src,
  ];
  return lines.join('\n');
}

/**
 * Passes efetivos de um quadro, na ordem do Cesium: bloom antes de tudo e
 * depois os estágios habilitados na ordem de inclusão. Lista vazia = nada a
 * fazer (canvas oculto, custo zero).
 * @param {{enabled:boolean}|null} bloom
 * @param {Array<{enabled:boolean}>} stages
 * @returns {Array<object>}
 */
export function activePasses(bloom, stages) {
  const out = [];
  if (bloom?.enabled) out.push(bloom);
  for (const stage of stages || []) if (stage?.enabled) out.push(stage);
  return out;
}

/** Algum estágio ligado? (decisão de mostrar o canvas de pós). */
export function needsPostProcess(bloom, stages) {
  return activePasses(bloom, stages).length > 0;
}

/**
 * Planeja os alvos de render de uma cadeia de `n` passes simples com
 * ping-pong: o primeiro lê a fonte (-1), o último escreve na tela (null).
 * Pure — testado direto.
 * @param {number} n
 * @returns {Array<{input:number, output:number|null}>}
 */
export function planPingPong(n) {
  const plan = [];
  let input = -1;
  for (let i = 0; i < n; i += 1) {
    const output = i === n - 1 ? null : (input === 0 ? 1 : 0);
    plan.push({ input, output });
    input = output;
  }
  return plan;
}

/** Canvas que o mapa desenha usa o mesmo tamanho de backing store e CSS. */
export function overlaySizeFor(mapCanvas) {
  return {
    width: Math.max(1, mapCanvas?.width | 0),
    height: Math.max(1, mapCanvas?.height | 0),
    cssWidth: mapCanvas?.style?.width || '100%',
    cssHeight: mapCanvas?.style?.height || '100%',
  };
}

// ── Estágios (objetos no formato do Cesium.PostProcessStage) ──────────────

function createStageObject({ name, fragmentShader, uniforms = {}, kind = 'single' }, onChange) {
  const raw = { ...uniforms };
  let enabled = false;
  const proxy = new Proxy(raw, {
    set(target, key, value) {
      if (target[key] === value) return true;
      target[key] = value;
      onChange(false);
      return true;
    },
  });
  return {
    name,
    kind,
    fragmentShader,
    uniforms: proxy,
    _raw: raw,
    get enabled() {
      return enabled;
    },
    set enabled(value) {
      const next = Boolean(value);
      if (next === enabled) return;
      enabled = next;
      onChange(true);
    },
    get ready() {
      return true;
    },
  };
}

/**
 * @param {object} engine - motor de src/maplibre/engine.js (canvas, container, on, requestRender)
 * @param {object} [options]
 * @param {HTMLCanvasElement} [options.sourceCanvas=engine.canvas]
 * @returns {object}
 */
export function createPostProcess(engine, { sourceCanvas } = {}) {
  const stages = [];
  let bloom = null;
  let destroyed = false;
  let frames = 0;
  let lastError = null;
  let active = false;
  let shown = false;

  const mapCanvas = sourceCanvas || engine?.canvas;
  const canvas = document.createElement('canvas');
  canvas.id = 'post-process-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    pointerEvents: 'none',
    display: 'none',
  });
  // Logo acima do canvas do mapa, dentro do mesmo container: marcadores HTML,
  // controles, máscara scope (z1), anel celestial (z2), detecção e interface
  // continuam por cima.
  if (mapCanvas?.parentNode) mapCanvas.after(canvas);
  else engine?.container?.appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) console.warn('[postProcess] WebGL2 indisponível: estilos visuais desativados');

  const vao = gl?.createVertexArray();
  const programs = new Map(); // chave -> {program, locations: Map}
  const targets = []; // {tex, fbo, w, h}
  let sourceTex = null;

  function onStageChange(structural) {
    if (destroyed) return;
    if (structural) refreshActive();
    if (active) engine?.requestRender?.();
  }

  function refreshActive() {
    const next = needsPostProcess(bloom, stages);
    if (next === active) return;
    active = next;
    if (!active) {
      canvas.style.display = 'none';
      shown = false;
    }
    // Ligar pede um quadro: o canvas só aparece depois da primeira cadeia
    // completa (sem piscar conteúdo velho).
    engine?.requestRender?.();
  }

  function compile(key, fragmentBody, defines) {
    if (programs.has(key)) return programs.get(key);
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, FULLSCREEN_VERTEX_SHADER);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, buildFragmentSource(fragmentBody, { defines }));
    gl.compileShader(fs);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    let entry = { program, locations: new Map(), ok: true };
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program);
      console.warn(`[postProcess] shader ${key} não compilou:`, log);
      lastError = `${key}: ${log}`;
      entry = { program: null, locations: new Map(), ok: false };
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    programs.set(key, entry);
    return entry;
  }

  function loc(entry, name) {
    if (!entry.locations.has(name)) entry.locations.set(name, gl.getUniformLocation(entry.program, name));
    return entry.locations.get(name);
  }

  function makeTexture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function target(i, w, h) {
    let t = targets[i];
    if (!t) {
      t = { tex: makeTexture(), fbo: gl.createFramebuffer(), w: 0, h: 0 };
      targets[i] = t;
    }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w;
      t.h = h;
    }
    return t;
  }

  function texOf(index) {
    return index === -1 ? sourceTex : targets[index].tex;
  }

  function setUniforms(entry, values) {
    for (const [name, value] of Object.entries(values)) {
      const l = loc(entry, name);
      if (l == null) continue;
      if (typeof value === 'boolean') gl.uniform1i(l, value ? 1 : 0);
      else if (typeof value === 'number') gl.uniform1f(l, value);
      else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        if (value.length === 2) gl.uniform2fv(l, value);
        else if (value.length === 3) gl.uniform3fv(l, value);
        else if (value.length === 4) gl.uniform4fv(l, value);
      }
    }
  }

  function draw(entry, inputs, output, w, h, uniforms) {
    if (!entry?.ok) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, output == null ? null : target(output, w, h).fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(entry.program);
    let unit = 0;
    for (const [name, tex] of Object.entries(inputs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const l = loc(entry, name);
      if (l != null) gl.uniform1i(l, unit);
      unit += 1;
    }
    const l = loc(entry, 'colorTextureDimensions');
    if (l != null) gl.uniform2f(l, w, h);
    const vp = loc(entry, 'czm_viewport');
    if (vp != null) gl.uniform4f(vp, 0, 0, w, h);
    const pr = loc(entry, 'czm_pixelRatio');
    if (pr != null) gl.uniform1f(pr, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const fn = loc(entry, 'czm_frameNumber');
    if (fn != null) gl.uniform1f(fn, frames);
    setUniforms(entry, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Executa o bloom do Cesium lendo `input` e escrevendo em `output`. */
  function runBloom(stage, input, output, w, h) {
    const u = stage._raw;
    // Alvos auxiliares 2 e 3 nunca coincidem com o ping-pong (0/1).
    const cb = compile('bloom-contrast-bias', CESIUM_CONTRAST_BIAS_SHADER);
    const blur = compile('bloom-blur', CESIUM_GAUSSIAN_BLUR_1D_SHADER, ['USE_STEP_SIZE']);
    const comp = compile('bloom-composite', CESIUM_BLOOM_COMPOSITE_SHADER);
    draw(cb, { colorTexture: texOf(input) }, 2, w, h, { contrast: u.contrast, brightness: u.brightness });
    draw(blur, { colorTexture: targets[2].tex }, 3, w, h,
      { delta: u.delta, sigma: u.sigma, stepSize: u.stepSize, direction: 0 });
    draw(blur, { colorTexture: targets[3].tex }, 2, w, h,
      { delta: u.delta, sigma: u.sigma, stepSize: u.stepSize, direction: 1 });
    draw(comp, { colorTexture: texOf(input), bloomTexture: targets[2].tex }, output, w, h, { glowOnly: !!u.glowOnly });
  }

  function syncSize() {
    const size = overlaySizeFor(mapCanvas);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    if (canvas.style.width !== size.cssWidth) canvas.style.width = size.cssWidth;
    if (canvas.style.height !== size.cssHeight) canvas.style.height = size.cssHeight;
    return size;
  }

  function renderFrame() {
    if (destroyed || !active || !gl || !mapCanvas) return;
    const passes = activePasses(bloom, stages);
    if (!passes.length) return;
    const { width: w, height: h } = syncSize();

    // Cópia do canvas do mapa: estamos dentro do 'render' do MapLibre, então
    // o drawing buffer ainda é o do quadro recém-desenhado.
    if (!sourceTex) sourceTex = makeTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, mapCanvas);
    } catch (err) {
      lastError = String(err?.message || err);
      return;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    const plan = planPingPong(passes.length);
    for (let i = 0; i < passes.length; i += 1) {
      const pass = passes[i];
      const { input, output } = plan[i];
      if (output != null) target(output, w, h);
      if (pass.kind === 'bloom') {
        target(2, w, h);
        target(3, w, h);
        runBloom(pass, input, output, w, h);
      } else {
        const entry = compile(`stage:${pass.name}`, pass.fragmentShader);
        if (!draw(entry, { colorTexture: texOf(input) }, output, w, h, pass._raw)) {
          // Shader quebrado: passa adiante sem efeito em vez de apagar a tela.
          const copy = compile('copy', COPY_SHADER);
          draw(copy, { colorTexture: texOf(input) }, output, w, h, {});
        }
      }
    }
    gl.bindVertexArray(null);
    frames += 1;
    if (!shown) {
      canvas.style.display = 'block';
      shown = true;
    }
  }

  const removeRender = engine?.on?.('render', renderFrame);
  const removeResize = engine?.on?.('resize', () => {
    if (active) engine?.requestRender?.();
  });

  const post = {
    canvas,
    gl,
    /**
     * @param {{name:string, fragmentShader:string, uniforms?:object}} spec
     * @returns {{name:string, uniforms:object, enabled:boolean}}
     */
    addStage(spec) {
      const stage = createStageObject({ ...spec, kind: 'single' }, onStageChange);
      stages.push(stage);
      return stage;
    },
    get bloom() {
      if (!bloom) {
        bloom = createStageObject({ name: 'czm_bloom', kind: 'bloom', uniforms: { ...CESIUM_BLOOM_DEFAULTS } }, onStageChange);
      }
      return bloom;
    },
    get stages() {
      return stages.slice();
    },
    isActive: () => active,
    requestRender: () => {
      if (active) engine?.requestRender?.();
    },
    getDebugState() {
      return {
        active,
        shown,
        frames,
        width: canvas.width,
        height: canvas.height,
        passes: activePasses(bloom, stages).map((s) => s.name),
        programs: [...programs.entries()].map(([k, v]) => ({ key: k, ok: v.ok })),
        lastError,
      };
    },
    destroy() {
      destroyed = true;
      removeRender?.();
      removeResize?.();
      if (gl) {
        for (const { program } of programs.values()) if (program) gl.deleteProgram(program);
        for (const t of targets) {
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        }
        if (sourceTex) gl.deleteTexture(sourceTex);
        if (vao) gl.deleteVertexArray(vao);
      }
      programs.clear();
      targets.length = 0;
      canvas.remove();
    },
  };
  return post;
}

const COPY_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() { out_FragColor = texture(colorTexture, v_textureCoordinates); }
`;
