#!/usr/bin/env node
/**
 * qa-el-nino — perspectiva El Niño (JSONs estáticos de build_el_nino_*.py):
 * células do PR, chips de variável e de mês trocam cor e legenda, véu de baixa
 * confiança, tooltip com previsão, faixa, histórico, leitura agronômica e ENSO.
 *
 * Uso: node scripts/qa-el-nino.mjs [--url http://localhost:5173] [--shot arquivo.png]
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const LAYER = 'datageo-el-nino';
const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-el-nino');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

const visiveis = () => page.evaluate(() => {
  const fs = window.__gevEngine.map.queryRenderedFeatures({ layers: ['dg-el-nino-fill'] });
  return { classes: [...new Set(fs.map((f) => f.properties.c))].sort(), veu: fs.filter((f) => f.properties.v === 1).length, n: fs.length };
});
const chips = () => page.$$eval(`[data-layer-id="${LAYER}"] .data-toggle-chip`,
  (els) => els.map((e) => ({ id: e.dataset.chipId, on: e.getAttribute('aria-pressed') })));
const clicar = async (id) => {
  await page.evaluate((lid, cid) => document.querySelector(`[data-layer-id="${lid}"] .data-toggle-chip[data-chip-id="${cid}"]`)?.click(), LAYER, id);
  await sleep(700);
};
const legenda = () => page.$$eval(`[data-layer-id="${LAYER}"] .data-toggle-legend-item`, (els) => els.map((e) => e.textContent.trim()));

try {
  await openApp(page, url);
  await setLayer(page, LAYER, true);
  const st = await waitForStats(page, LAYER, 's => s.count > 0 || s.error', 60_000);
  check('mais de 1.500 células do PR', st.stats?.count > 1500 && !st.stats?.error, st.stats);

  const cs = await chips();
  check('4 chips de variável + 6 de mês, CHUVA e 1º mês ativos',
    cs.length === 10 && cs.find((c) => c.id === 'v-chuva')?.on === 'true' && cs.find((c) => c.id === 'm-0')?.on === 'true', cs);

  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const chuva = await visiveis();
  const legChuva = await legenda();
  check('CHUVA: células e legenda em % da normal', chuva.n > 500 && legChuva.some((l) => /%/.test(l)), { chuva, legChuva });

  await clicar('m-1');
  await clicar('v-excesso');
  const exc = await visiveis();
  const legExc = await legenda();
  check('EXCESSO no 2º mês: legenda de chance', exc.n > 500 && legExc.some((l) => /70%|50%|33%/.test(l)), { exc, legExc });

  await clicar('m-0');
  const legOut = await legenda();
  check('EXCESSO no mês corrente: aviso sem dado', legOut.some((l) => /Sem dado neste mês/.test(l)), legOut);

  await clicar('v-temp');
  check('TEMP: legenda em °C', (await legenda()).some((l) => /°C/.test(l)), await legenda());

  await clicar('m-1');
  await clicar('v-sinal');
  const sin = await visiveis();
  check('SINAL em novembro: quase sem véu (r significativo)', sin.n > 500 && sin.veu < sin.n * 0.2, sin);

  await clicar('v-chuva');
  await setCamera(page, { lon: -49.27, lat: -25.43, alt: 200_000 });
  await waitMapIdle(page, 60_000);
  const f = await interactiveFeature(page, LAYER);
  const tip = f ? await hoverTooltip(page, f.lon, f.lat, /Chuva esperada/) : '';
  check('tooltip: previsão, faixa, normal, chances, NMME e confiança',
    /Chuva esperada\s*\d+ mm/.test(tip) && /p10–p90/.test(tip) && /Normal 1991–2020/.test(tip)
    && /Terço mais chuvoso/.test(tip) && /NMME/.test(tip) && /Confiança\s*\d\/3/.test(tip), tip.slice(0, 400));
  check('tooltip: histórico, leitura agronômica, próximos meses e ONI',
    /El Niños/.test(tip) && /Leitura para o campo/.test(tip) && /Próximos meses/.test(tip) && /ONI \(oficial\)/.test(tip), tip.slice(0, 400));
  check('tooltip: acentos íntegros', /Niño/.test(tip) && !/�|Ã§|Ã£|Ã©|Ã±/.test(tip), tip.slice(0, 120));
  if (shot) await page.screenshot({ path: shot });
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
