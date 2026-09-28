#!/usr/bin/env node
/**
 * qa-tooltips-todas — varre as camadas do anfitrião (menos a base, municípios)
 * e confere que o hover em uma feição mostra o cartão único (tipCard):
 * `.tt` com título, ao menos uma linha ou subtítulo, e rodapé com a fonte.
 *
 * Camadas do bucket privado (/privado) só carregam com login: sem sessão
 * (o `?semlogin` do dev) elas aparecem como SKIP, não como falha.
 *
 * Uso: node scripts/qa-tooltips-todas.mjs [--url http://localhost:5173]
 *        [--only id1,id2] [--shots pasta/]
 * Requer dev server rodando.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const only = argValue('--only', '')?.split(',').filter(Boolean) ?? [];
const shots = argValue('--shots', '');
if (shots) mkdirSync(shots, { recursive: true });

// Vistas tentadas em ordem até a camada ter feição interativa na tela.
const VIEWS = [
  { lon: -51.5, lat: -24.7, alt: 900_000 }, // PR inteiro
  { lon: -49.27, lat: -25.43, alt: 120_000 }, // Curitiba
  { lon: -51.46, lat: -25.39, alt: 60_000 }, // Guarapuava
  { lon: -51.5, lat: -24.7, alt: 2_500_000 }, // Sul do Brasil
  { lon: -49.27, lat: -25.43, alt: 15_000 }, // Curitiba de perto (CAR, estradas)
  { lon: -40, lat: -15, alt: 12_000_000 }, // globo (contexto global)
  { lon: -130, lat: 45, alt: 9_000_000 }, // Pacífico Norte: terremotos diários (Alasca, Califórnia)
];

const { check, finish } = createReport('qa-tooltips-todas');
// APIs externas bloqueadas por rede/CORS (Open-Meteo, USGS...) não são erro do app.
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 860 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|arcgisonline|openstreetmap|openfreemap|elevation-tiles|net::|open-meteo|CORS policy/i,
});

/** Pixel inteiro (página) sobre uma feição interativa da camada, perto do centro. */
const pixelOn = (layerId) => page.evaluate((lid) => {
  const { engine, layerHost } = window.__godsEyeView;
  const map = engine.map;
  const def = layerHost.ctx.getLayer(lid);
  const ids = (def?.interactive ?? []).filter((id) => map.getLayer(id));
  if (!ids.length) return { none: 'sem layers interativos' };
  const { clientWidth: w, clientHeight: h } = engine.container;
  const r = engine.container.getBoundingClientRect();
  for (let ring = 0; ring < 45; ring++) {
    const n = Math.max(1, ring * 6);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = Math.round(w / 2 + Math.cos(a) * ring * 9);
      const y = Math.round(h / 2 + Math.sin(a) * ring * 9);
      if (x < 330 || x > w - 20 || y < 90 || y > h - 110) continue; // painel e dock
      const hit = layerHost.pickAt(x, y);
      if (hit?.def?.id === lid) return { x: r.left + x, y: r.top + y };
    }
  }
  return null;
}, layerId);

const readTip = () => page.evaluate(() => {
  const el = document.getElementById('dg-tooltip');
  if (!el || el.hidden) return null;
  const tt = el.querySelector('.tt');
  return {
    text: el.textContent,
    card: !!tt,
    title: tt?.querySelector('.tt-title')?.textContent?.trim() ?? '',
    rows: tt?.querySelectorAll('.tt-rows dt').length ?? 0,
    sub: !!tt?.querySelector('.tt-sub'),
    foot: tt?.querySelector('.tt-foot')?.textContent?.trim() ?? '',
    legacyCss: [...document.querySelectorAll('style')].some((s) => /#dg-tooltip \.(vt|dg-vt|dgx-vt)\b/.test(s.textContent)),
  };
});

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');
  await page.addStyleTag({ content: '#dg-tooltip:not([hidden]) { display: block !important; }' });

  const layers = await page.evaluate(() => {
    const { dataManager, layerHost } = window.__godsEyeView;
    return [...dataManager.layers.keys()].filter((id) => layerHost.ctx.getLayer(id) && id !== 'datageo-municipios');
  });
  const todo = only.length ? layers.filter((id) => only.includes(id)) : layers;
  let legacy = false;

  for (const id of todo) {
    await setLayer(page, id, true);
    const loaded = await waitForStats(page, id, '(s) => s.count > 0 || !!s.error || !!s.lastError', 60_000);
    const stats = loaded.stats ?? {};
    const err = stats.error || stats.lastError;
    if (!loaded.ok || !(stats.count > 0)) {
      console.log(`  [SKIP] ${id}: não carregou aqui (${err || 'sem feições'}) — bucket privado/rede`);
      await setLayer(page, id, false);
      continue;
    }
    let pt = null;
    for (const view of VIEWS) {
      await setCamera(page, view);
      await waitMapIdle(page);
      await sleep(400);
      pt = await pixelOn(id);
      if (pt && !pt.none) break;
    }
    if (!pt || pt.none) {
      check(`${id}: feição interativa na tela`, false, pt?.none ?? 'nenhuma vista mostrou a camada');
      await setLayer(page, id, false);
      continue;
    }
    await page.mouse.move(pt.x - 30, pt.y - 30);
    await sleep(120);
    await page.mouse.move(pt.x, pt.y, { steps: 4 });
    await sleep(700);
    const tip = await readTip();
    legacy ||= !!tip?.legacyCss;
    check(`${id}: cartão de tooltip completo`,
      tip?.card && tip.title && (tip.rows > 0 || tip.sub) && tip.foot,
      tip ? { title: tip.title.slice(0, 50), rows: tip.rows, foot: tip.foot.slice(0, 60) } : 'sem tooltip');
    if (shots && tip) await page.screenshot({ path: path.join(shots, `${id}.png`) });
    await page.mouse.move(5, 5);
    await setLayer(page, id, false);
  }
  check('nenhuma camada injeta CSS de tooltip antigo', !legacy);
  check('sem erros na página', errors.length === 0, errors.slice(0, 3));
} catch (err) {
  check('execução sem exceção', false, String(err?.stack || err));
} finally {
  await browser.close();
}
finish();
