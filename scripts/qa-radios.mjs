#!/usr/bin/env node
/**
 * qa-radios — confere a camada Rádios ao vivo de ponta a ponta:
 *   1. os pontos dos municípios aparecem;
 *   2. clicar no ponto de Curitiba abre o player e o áudio entra no ar;
 *   3. a seta avança de estação e desligar a camada para o som.
 *
 * Uso: node scripts/qa-radios.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando e internet (o áudio vem direto das emissoras).
 */
import {
  argValue, createReport, interactiveFeature, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-radios.png');
const LAYER_ID = 'datageo-radios';
const CURITIBA = '4106902';

const { check, finish } = createReport('qa-radios');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 860 },
  extraArgs: ['--autoplay-policy=user-gesture-required'],
});

try {
  await openApp(page, url);
  await page.keyboard.press('Escape'); // tutorial de primeira visita cobre o mapa
  await sleep(500);

  await setCamera(page, { lon: -49.27, lat: -25.43, alt: 400_000 });
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
  const stats = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      const s = mod?.getStats?.() ?? {};
      if (s.count > 0) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true };
  }, LAYER_ID);
  check('estações carregam', stats.count > 0, stats);
  await sleep(2_000);

  // Clique REAL no ponto (gesto do usuário libera o autoplay).
  await waitMapIdle(page);
  const ponto = await interactiveFeature(page, LAYER_ID, { ibge: CURITIBA });
  const xy = ponto ? await page.evaluate((lo, la) => {
    const { engine } = window.__godsEyeView;
    const p = engine.project(lo, la);
    const r = engine.container.getBoundingClientRect();
    return p ? { x: r.left + p.x, y: r.top + p.y } : null;
  }, ponto.lon, ponto.lat) : null;
  check('ponto de Curitiba na tela', !!xy, xy);
  if (xy) await page.mouse.click(xy.x, xy.y);

  const open = await page.waitForFunction(
    () => document.querySelector('#dg-radio.open .dgr-place')?.textContent,
    { timeout: 10_000 },
  ).then((h) => h.jsonValue()).catch(() => null);
  check('clique abre o player no município', /Curitiba/.test(open ?? ''), open);

  const state = await page.waitForFunction(
    () => ['playing', 'error'].includes(document.querySelector('#dg-radio')?.dataset.state)
      && document.querySelector('#dg-radio').dataset.state,
    { timeout: 20_000 },
  ).then((h) => h.jsonValue()).catch(() => 'timeout');
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);
  const name1 = await page.$eval('.dgr-name', (el) => el.textContent);
  check('áudio entra no ar', state === 'playing', { state, estacao: name1 });

  await page.click('.dgr-skip[data-step="1"]');
  const name2 = await page.$eval('.dgr-name', (el) => el.textContent);
  check('seta avança de estação', name2 !== name1, { de: name1, para: name2 });

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  await sleep(500);
  const off = await page.evaluate(() => ({
    open: document.querySelector('#dg-radio')?.classList.contains('open'),
    state: document.querySelector('#dg-radio')?.dataset.state,
  }));
  check('desligar a camada fecha o player e para o som', !off.open && off.state === 'stopped', off);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

finish();
