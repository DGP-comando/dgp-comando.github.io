#!/usr/bin/env node
/**
 * qa-torres — hover numa torre da camada Conectividade:
 *   1. o tooltip abre com operadora, gerações e o aviso de estimativa;
 *   2. os anéis de alcance são desenhados (um por geração);
 *   3. tirar o mouse apaga os anéis e o tooltip.
 *
 * Uso: node scripts/qa-torres.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, interactiveFeature, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-torres.png');
const LAYER_ID = 'datageo-conectividade';

const { check, finish } = createReport('qa-torres');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

// Anéis de alcance: feições da fonte GeoJSON `dg-conect-aneis` (um anel por geração).
const aneis = () => page.evaluate(async () => {
  const src = window.__godsEyeView.engine.map.getSource('dg-conect-aneis');
  if (!src) return -1;
  const data = await src.getData();
  return data?.features?.length ?? 0;
});
const tooltip = () => page.evaluate(() => {
  const el = document.getElementById('dg-tooltip');
  return el && !el.hidden ? el.textContent : '';
});

try {
  await openApp(page, url);
  await page.keyboard.press('Escape');

  // Guarapuava, visão de ~60 km: torres rurais separadas o bastante para o pick.
  await setCamera(page, { lon: -51.46, lat: -25.39, alt: 60_000 });
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);
  const count = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    for (let t = 0; t < 120; t++) {
      if (mod?.getStats?.().count > 0) return mod.getStats().count;
      await new Promise((r) => setTimeout(r, 250));
    }
    return 0;
  }, LAYER_ID);
  check('torres carregam', count > 1000, { count });
  await waitMapIdle(page);

  // Torre mais perto do centro da tela.
  const torre = await interactiveFeature(page, LAYER_ID);
  const xy = torre ? await page.evaluate((lo, la) => {
    const { engine } = window.__godsEyeView;
    const p = engine.project(lo, la);
    const r = engine.container.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, torre.lon, torre.lat) : null;
  check('há torre na tela', !!xy, xy);
  if (xy) {
    await page.mouse.move(xy.x - 30, xy.y - 30);
    await sleep(200);
    await page.mouse.move(xy.x, xy.y, { steps: 5 });
    await sleep(1_500);

    const hover = { tip: await tooltip(), aneis: await aneis() };
    check('tooltip com operadora e aviso de estimativa', /📡/.test(hover.tip) && /ESTIMADO/.test(hover.tip), hover.tip.slice(0, 120));
    // Um anel por geração da torre (a de 2G só tem um).
    check('anéis de alcance desenhados', hover.aneis >= 1, { feicoes: hover.aneis });
    await page.screenshot({ path: shot });
    console.log('   screenshot:', shot);
    await page.mouse.move(xy.x + 250, xy.y + 120, { steps: 4 });
    await sleep(1_500);
    // O tooltip é do anfitrião (um só para todas as camadas): fora da torre
    // pode aparecer o do município por baixo, mas não mais o da torre.
    const tipFora = await tooltip();
    const out = { aneis: await aneis(), tipDaTorre: /📡|ESTIMADO/.test(tipFora) };
    check('sair da torre apaga anéis e tooltip', out.aneis === 0 && !out.tipDaTorre, out);
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

finish();
