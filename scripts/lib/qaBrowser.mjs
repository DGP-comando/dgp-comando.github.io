// scripts/lib/qaBrowser.mjs
//
// Peças comuns dos harnesses de QA de navegador (scripts/qa-*.mjs) sobre o
// motor MapLibre (src/maplibre/engine.js).
//
//   const { browser, page, errors } = await launchQaBrowser({ headful });
//   await openApp(page, url);                 // espera o motor e o fim do loading
//   await setCamera(page, { lat, lon, alt, heading, pitch });
//   await waitMapIdle(page);                  // tiles e fontes carregados
//   const report = createReport('qa-x');      // check()/skip()/finish()
//
// O app de dev expõe `window.__godsEyeView` ({engine, styleManager,
// dataManager, layerHost, …}) e, só no dev, `window.__gevEngine`
// (= `window.__gevViewer`), `__gevLayerHost` e `__gevDataManager`. A câmera
// fala em semântica Cesium: posição da câmera {lat, lon, alt (m)}, heading
// (graus, 0 = norte) e pitch (graus, -90 = nadir) — `engine.getCameraView()` /
// `setCameraView()` / `flyToCamera()`. O mapa MapLibre é `engine.map`.
//
// Navegador: PUPPETEER_EXECUTABLE_PATH, senão o Chrome for Testing do
// puppeteer. Headless usa SwiftShader (WebGL por software). Se HTTPS_PROXY
// estiver definido ele é repassado ao Chrome (os tiles do mapa base vêm da
// internet), com localhost fora do proxy.
//
// O login do DataGeo só é pulado no dev com `?semlogin`; `appUrl()` acrescenta
// o parâmetro a qualquer URL (e `welcome=0`, que pula o tutorial de entrada).

import fs from 'node:fs';
import puppeteer from 'puppeteer';

export const DEFAULT_APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';

/** Valor de `--nome valor` na linha de comando (ou `dflt`). */
export function argValue(name, dflt = undefined, argv = process.argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

export const hasFlag = (name, argv = process.argv) => argv.includes(name);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * URL do app com `semlogin` na query (preserva o hash de link compartilhado).
 * Também pula o tutorial de primeira visita (`welcome=0`), que prende o
 * primeiro Esc na fase de captura e surge até ~1 s depois da tela de carga;
 * `{ welcome: true }` o mantém (quem testa o próprio tutorial).
 */
export function appUrl(base, { hash = '', welcome = false } = {}) {
  const url = new URL(base);
  if (!url.searchParams.has('semlogin')) url.searchParams.set('semlogin', '');
  if (!welcome && !url.searchParams.has('welcome')) url.searchParams.set('welcome', '0');
  if (hash) url.hash = hash.startsWith('#') ? hash.slice(1) : hash;
  return url.toString();
}

export function resolveChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

/**
 * Abre o Chrome e uma aba. Erros de página e de console (fora o ruído de rede
 * de tiles) vão para `errors`.
 * @param {{headful?: boolean, viewport?: {width: number, height: number}, extraArgs?: string[], ignoreConsole?: RegExp}} [options]
 */
export async function launchQaBrowser({
  headful = false,
  viewport = { width: 1400, height: 860 },
  extraArgs = [],
  ignoreConsole = /Failed to load resource|ERR_|AJAXError|arcgisonline|openstreetmap|openfreemap|elevation-tiles|net::/i,
} = {}) {
  const executablePath = resolveChrome();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--ignore-gpu-blocklist',
    ...(headful ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1'] : []),
    ...extraArgs,
  ];
  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    protocolTimeout: 300_000,
    acceptInsecureCerts: true,
    ...(executablePath ? { executablePath } : {}),
    args,
  });
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  // Vite's HMR socket would reload the page mid-run whenever any source file
  // changes on disk (another editor, another agent); a QA run wants the build
  // it started with. Only the `vite-hmr` protocol is stubbed.
  await page.evaluateOnNewDocument(() => {
    const RealWebSocket = window.WebSocket;
    function QaWebSocket(url, protocols) {
      if (String(protocols || '').includes('vite-hmr')) {
        const fake = new EventTarget();
        fake.readyState = 0;
        fake.send = () => {};
        fake.close = () => {};
        return fake;
      }
      return new RealWebSocket(url, protocols);
    }
    QaWebSocket.prototype = RealWebSocket.prototype;
    Object.assign(QaWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = QaWebSocket;
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (ignoreConsole && ignoreConsole.test(text)) return;
    errors.push(`[console] ${text}`);
  });
  return { browser, page, errors, executablePath };
}

/** Navega até o app e espera o motor, o estilo e o fim da tela de carga. */
export async function openApp(page, base = DEFAULT_APP_URL, { hash = '', timeout = 120_000 } = {}) {
  await page.goto(appUrl(base, { hash }), { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), { timeout });
  await page.evaluate(() => window.__godsEyeView.engine.ready);
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout },
  ).catch(() => {});
}

/** Salto instantâneo da câmera (semântica Cesium: alt em m, pitch -90 = nadir). */
export function setCamera(page, view) {
  return page.evaluate((v) => {
    const engine = window.__godsEyeView.engine;
    engine.cancelFlight?.();
    engine.setCameraView({ heading: 0, pitch: -90, roll: 0, ...v });
    engine.requestRender?.();
    return engine.getCameraView();
  }, view);
}

/** Leitura da câmera: {lat, lon, alt, heading, pitch, roll, zoom, targetLat, targetLon}. */
export function getCamera(page) {
  return page.evaluate(() => window.__godsEyeView.engine.getCameraView());
}

/** Espera o mapa ficar ocioso (tiles e fontes carregados) ou o tempo acabar. */
export function waitMapIdle(page, timeoutMs = 20_000) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const { map } = window.__godsEyeView.engine;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => finish(false), ms);
    if (map.loaded() && !map.isMoving()) {
      clearTimeout(timer);
      finish(true);
      return;
    }
    map.once('idle', () => { clearTimeout(timer); finish(true); });
    map.triggerRepaint();
  }), timeoutMs);
}

/** Liga/desliga uma camada pelo mesmo caminho do painel. */
export function setLayer(page, id, on, origin = 'user') {
  return page.evaluate((layerId, enabled, o) => window.__godsEyeView.dataManager.setEnabled(layerId, enabled, { origin: o }), id, on, origin);
}

/** `getStats()` do módulo da camada (ou null). */
export function layerStats(page, id) {
  return page.evaluate((layerId) => window.__godsEyeView.dataManager.layers.get(layerId)?.module?.getStats?.() ?? null, id);
}

/** Espera `predicate(stats)` (código-fonte de função) ficar verdadeiro. */
export async function waitForStats(page, id, predicateSource, timeoutMs = 60_000) {
  const t0 = Date.now();
  let stats = null;
  while (Date.now() - t0 < timeoutMs) {
    stats = await layerStats(page, id);
    // eslint-disable-next-line no-new-func
    if (stats && new Function('s', `return (${predicateSource})(s);`)(stats)) return { ok: true, stats, ms: Date.now() - t0 };
    await sleep(250);
  }
  return { ok: false, stats, ms: Date.now() - t0 };
}

/**
 * Feições renderizadas dos layers de estilo cujo id começa com `prefix` (na
 * tela inteira). Devolve {layers: [ids visíveis], count}.
 */
export function renderedFeatures(page, prefix) {
  return page.evaluate((p) => {
    const { map } = window.__godsEyeView.engine;
    const ids = map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith(p));
    const visible = ids.filter((id) => map.getLayoutProperty(id, 'visibility') !== 'none');
    const features = visible.length ? map.queryRenderedFeatures({ layers: visible }) : [];
    return { layers: visible, all: ids, count: features.length };
  }, prefix);
}

/**
 * Layers de estilo cujo id casa com `pattern` (fonte de RegExp), separados
 * pelo teto de escala: `shown` = visibilidade ligada e zoom atual dentro de
 * [minzoom, maxzoom); `gated` = ligados mas fora da faixa de zoom; `off` =
 * visibilidade 'none'. É o equivalente MapLibre do `primitive.show` do Cesium.
 */
export function zoomGatedLayers(page, pattern) {
  return page.evaluate((src) => {
    const { map } = window.__godsEyeView.engine;
    const re = new RegExp(src);
    const zoom = map.getZoom();
    const out = { zoom: +zoom.toFixed(2), shown: [], gated: [], off: [] };
    for (const layer of map.getStyle().layers) {
      if (!re.test(layer.id)) continue;
      if (map.getLayoutProperty(layer.id, 'visibility') === 'none') { out.off.push(layer.id); continue; }
      const live = map.getLayer(layer.id);
      const min = live?.minzoom ?? 0;
      const max = live?.maxzoom ?? 24;
      (zoom >= min && zoom < max ? out.shown : out.gated).push(layer.id);
    }
    return out;
  }, pattern);
}

/**
 * Uma feição renderizada dos layers interativos da camada `layerId` (contrato
 * kit.js: `def.interactive`), a mais próxima do centro da tela:
 * {lon, lat, props, layer} ou null. Para linhas usa o vértice do meio da
 * primeira linha; para polígonos, o primeiro vértice do anel externo.
 * `match` ({prop: valor}) filtra pelas propriedades.
 */
export function interactiveFeature(page, layerId, match = null) {
  return page.evaluate((lid, want) => {
    const { engine, layerHost } = window.__godsEyeView;
    const def = layerHost?.ctx?.getLayer?.(lid);
    const ids = (def?.interactive ?? []).filter((id) => engine.map.getLayer(id));
    if (!ids.length) return null;
    const feats = engine.map.queryRenderedFeatures({ layers: ids });
    const { clientWidth: w, clientHeight: h } = engine.container;
    let best = null;
    for (const f of feats) {
      if (want && !Object.entries(want).every(([k, v]) => f.properties?.[k] === v)) continue;
      let c = f.geometry?.coordinates;
      if (!Array.isArray(c)) continue;
      // Desce até uma lista de posições; dela, o vértice do meio.
      while (Array.isArray(c[0]?.[0])) c = c[0];
      if (Array.isArray(c[0])) c = c[Math.floor(c.length / 2)];
      const p = engine.project(c[0], c[1]);
      if (!p) continue;
      const d = Math.hypot(p.x - w / 2, p.y - h / 2);
      if (!best || d < best.d) best = { d, lon: c[0], lat: c[1], props: f.properties, layer: f.layer?.id };
    }
    return best;
  }, layerId, match);
}

/**
 * Passa o mouse sobre (lon, lat) com pequenos desvios até o tooltip do
 * anfitrião (`#dg-tooltip`) casar com `expect` (RegExp); devolve o texto.
 */
export async function hoverTooltip(page, lon, lat, expect = /./) {
  let text = '';
  for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [4, 4], [-4, -4]]) {
    const pt = await page.evaluate((lo, la) => {
      const { engine } = window.__godsEyeView;
      const p = engine.project(lo, la);
      const r = engine.container.getBoundingClientRect();
      return p ? { x: r.left + p.x, y: r.top + p.y } : null;
    }, lon, lat);
    if (!pt) return '';
    await page.mouse.move(pt.x + dx, pt.y + dy);
    await sleep(500);
    text = await page.evaluate(() => {
      const el = document.getElementById('dg-tooltip');
      return el && !el.hidden ? el.textContent : '';
    });
    if (expect.test(text)) break;
  }
  return text;
}

/** Relatório PASS/FAIL/SKIP com saída padronizada. */
export function createReport(name) {
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass: Boolean(pass) });
    const tag = pass ? 'PASS' : 'FAIL';
    const extra = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    console.log(`  [${tag}] ${label}${extra}`);
    return Boolean(pass);
  };
  const skip = (label, why) => {
    results.push({ label, pass: null });
    console.log(`  [SKIP] ${label} — ${why}`);
  };
  const finish = () => {
    const failed = results.filter((r) => r.pass === false);
    const passed = results.filter((r) => r.pass === true).length;
    console.log(`\n${name}: ${passed}/${results.length} passaram${failed.length ? ` — falhas: ${failed.map((r) => r.label).join('; ')}` : ''}`);
    process.exitCode = failed.length ? 1 : 0;
    return failed.length === 0;
  };
  return { check, skip, finish, results };
}
