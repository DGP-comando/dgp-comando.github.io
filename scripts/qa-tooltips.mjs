#!/usr/bin/env node
/**
 * qa-tooltips — o tooltip do anfitrião (#dg-tooltip) aparece e a camada de
 * municípios (camada-base, quase sempre ligada) não esconde as de baixo:
 *   1. só municípios: o hover destaca sem tooltip (a base é só clicável) e o
 *      clique abre a ficha do município;
 *   2. com terras indígenas / assentamentos / regionais / associações ligadas,
 *      o hover sobre um polígono delas mostra o tooltip DELAS (não o do município);
 *   3. clique sobre assentamento (sem clique próprio) segue abrindo a ficha
 *      do município; sobre a regional do IDR abre a ficha regional por cima.
 *
 * Uso: node scripts/qa-tooltips.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-tooltips.png');

const { check, finish } = createReport('qa-tooltips');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

const tooltip = () => page.evaluate(() => {
  const el = document.getElementById('dg-tooltip');
  if (!el || el.hidden) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    text: el.textContent,
    html: el.innerHTML,
    position: cs.position,
    semHover: matchMedia('(hover: none), (pointer: coarse)').matches,
    rect: [r.left, r.top, r.width, r.height].map(Math.round),
    display: cs.display,
    bg: cs.backgroundColor,
    inView: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0
      && r.right <= innerWidth && r.bottom <= innerHeight,
  };
});

/**
 * Pixel (coordenadas da página) onde o pick acha a camada `layerId` e também
 * o preenchimento dos municípios: o caso em que a base encobria a camada.
 */
const pixelOver = (layerId) => page.evaluate((lid) => {
  const { engine, layerHost } = window.__godsEyeView;
  const map = engine.map;
  const def = layerHost.ctx.getLayer(lid);
  const ids = (def?.interactive ?? []).filter((id) => map.getLayer(id));
  if (!ids.length) return null;
  const { clientWidth: w, clientHeight: h } = engine.container;
  const r = engine.container.getBoundingClientRect();
  // Da tela central para fora: longe do painel lateral e do dock.
  for (let ring = 0; ring < 30; ring++) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      // Pixel inteiro: é onde o mouse do puppeteer cai (e.point do MapLibre).
      const x = Math.round(w / 2 + Math.cos(a) * ring * 12);
      const y = Math.round(h / 2 + Math.sin(a) * ring * 12);
      const here = map.queryRenderedFeatures([x, y]).map((f) => f.layer.id);
      if (here.some((id) => ids.includes(id)) && here.includes('dg-municipios-fill')) {
        return { x: r.left + x, y: r.top + y };
      }
    }
  }
  return null;
}, layerId);

async function hoverAt(pt) {
  await page.mouse.move(pt.x - 40, pt.y - 40);
  await sleep(150);
  await page.mouse.move(pt.x, pt.y, { steps: 5 });
  await sleep(700);
  return tooltip();
}

const LAYERS = [
  { id: 'datageo-terras-indigenas', expect: /TI |FUNAI/, view: { lon: -51.0, lat: -25.2, alt: 450_000 } },
  { id: 'datageo-assentamentos', expect: /INCRA\/SIPRA/, view: { lon: -52.3, lat: -25.3, alt: 220_000 } },
  { id: 'datageo-regionais-idr', expect: /IDR-Paraná/, view: { lon: -51.5, lat: -24.7, alt: 900_000 } },
  { id: 'datageo-associacoes', expect: /SECID-PR/, view: { lon: -51.5, lat: -24.7, alt: 900_000 } },
];

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');
  // O Chrome headless se declara sem hover (e o CDP não emula `hover`); a
  // regra de toque do style.css esconderia o tooltip como num celular.
  // Anula só essa regra, como num desktop com mouse.
  await page.addStyleTag({ content: '#dg-tooltip:not([hidden]) { display: block !important; }' });

  // 1. Só municípios: sem tooltip, cursor de clique, clique abre a ficha.
  await setCamera(page, { lon: -51.5, lat: -24.7, alt: 900_000 });
  await waitMapIdle(page);
  const base = await pixelOver('datageo-municipios');
  const tipBase = base ? await hoverAt(base) : null;
  const cursor = await page.evaluate(() => window.__godsEyeView.engine.map.getCanvas().style.cursor);
  check('município sem tooltip, com cursor de clique', base && !tipBase && cursor === 'pointer', { tip: tipBase?.text, cursor });
  if (base) {
    await page.mouse.click(base.x, base.y);
    await sleep(800);
    const nome = await page.evaluate(() => document.querySelector('.fx-nome')?.textContent ?? '');
    check('clique no município abre a ficha', !!nome && !/^Regional/.test(nome), nome);
    await page.keyboard.press('Escape');
  }

  // 2. Cada camada de polígono sob os municípios.
  for (const layer of LAYERS) {
    await setLayer(page, layer.id, true);
    const loaded = await waitForStats(page, layer.id, '(s) => s.count > 0', 60_000);
    await setCamera(page, layer.view);
    await waitMapIdle(page);
    const pt = await pixelOver(layer.id);
    const tip = pt ? await hoverAt(pt) : null;
    check(`${layer.id}: tooltip da camada vence o do município`,
      loaded.ok && tip && layer.expect.test(tip.text) && !/Prefeito/.test(tip.text),
      { count: loaded.stats?.count, pt: !!pt, tip: tip?.text?.slice(0, 80) });
    if (layer.id === 'datageo-terras-indigenas' && tip) {
      check('tooltip estilizado e dentro da tela',
        tip.position === 'fixed' && tip.inView && tip.bg !== 'rgba(0, 0, 0, 0)',
        { position: tip.position, bg: tip.bg, inView: tip.inView, rect: tip.rect });
      await page.screenshot({ path: shot });
    }

    if (layer.id === 'datageo-assentamentos' && pt) {
      await page.mouse.click(pt.x, pt.y);
      await sleep(800);
      const nome = await page.evaluate(() => document.querySelector('.fx-nome')?.textContent ?? '');
      check('clique sobre assentamento abre a ficha do município', nome && !/^Regional/.test(nome), nome);
      await page.keyboard.press('Escape');
    }
    if (layer.id === 'datageo-regionais-idr' && pt) {
      await page.mouse.click(pt.x, pt.y);
      await sleep(800);
      const nome = await page.evaluate(() => document.querySelector('.fx-nome')?.textContent ?? '');
      check('clique sobre a regional abre a ficha regional', /^Regional/.test(nome), nome);
      await page.keyboard.press('Escape');
    }
    await setLayer(page, layer.id, false);
  }
  check('sem erros na página', errors.length === 0, errors.slice(0, 3));
} catch (err) {
  check('execução sem exceção', false, String(err?.stack || err));
} finally {
  await browser.close();
}
finish();
