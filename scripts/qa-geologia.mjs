#!/usr/bin/env node
/**
 * qa-geologia — geologia e recursos minerais da aba Aspectos físicos: imagens
 * do GeoPR (litologia, geomorfologia, falhas/diques, processos ANM), tooltip da
 * consulta da vista e as ocorrências minerais do SGB.
 *
 * Uso: node scripts/qa-geologia.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando e acesso a geopr.iat.pr.gov.br e geoservicos.sgb.gov.br.
 */
import {
  argValue, createReport, hoverTooltip, interactiveFeature, launchQaBrowser, openApp, setCamera, setLayer, sleep,
  waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const { check, finish } = createReport('qa-geologia');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });
const tiles = {};
const SERVICOS = ['litologia_pr', 'zee_unidades_geomorfologicas', 'zee_falhas_geologicas', 'zee_diques_geologicos', 'Processos_Miner%C3%A1rios_ANM'];
page.on('response', (r) => {
  const s = SERVICOS.find((x) => r.url().includes(`/${x}/MapServer/`));
  if (s) (tiles[s] ??= []).push(r.status());
});
const ok = (s) => (tiles[s] ?? []).length > 0 && tiles[s].every((c) => c === 200);

const feicao = async (id) => {
  for (let i = 0; i < 40; i++) {
    const f = await interactiveFeature(page, id);
    if (f) return f;
    await sleep(500);
  }
  return null;
};
const tooltip = async (id, re) => {
  const f = await feicao(id);
  check(`${id}: feições da vista para o hover`, Boolean(f), f?.props);
  return f ? hoverTooltip(page, f.lon, f.lat, re) : '';
};

try {
  await openApp(page, url);

  // Litologia em Curitiba (Formação Guabirotuba na bacia de Curitiba).
  await setLayer(page, 'datageo-litologia', true);
  await setCamera(page, { lon: -49.27, lat: -25.43, alt: 40_000 });
  await waitMapIdle(page, 90_000);
  check('litologia: tiles do cache (200)', ok('litologia_pr'), tiles.litologia_pr);
  const lit = await tooltip('datageo-litologia', /Idade|Litotipos/);
  check('litologia: tooltip com unidade e idade', /Idade|Litotipos/.test(lit), lit.slice(0, 200));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-litologia.png') });
  await setLayer(page, 'datageo-litologia', false);

  // Geomorfologia na vista do estado.
  await setLayer(page, 'datageo-geomorfologia', true);
  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 90_000);
  check('geomorfologia: export (200)', ok('zee_unidades_geomorfologicas'), tiles.zee_unidades_geomorfologicas);
  const geo = await tooltip('datageo-geomorfologia', /Morfoestrutura|Dissecação/);
  check('geomorfologia: tooltip com planalto', /[Pp]lanalto|[Pp]lan[íi]cie|Serra/.test(geo), geo.slice(0, 200));
  await setLayer(page, 'datageo-geomorfologia', false);

  // Falhas e diques a partir do zoom 8 (Arco de Ponta Grossa).
  await setLayer(page, 'datageo-estruturas-geologicas', true);
  await setCamera(page, { lon: -50.2, lat: -24.9, alt: 150_000 });
  await waitMapIdle(page, 120_000);
  check('falhas e diques: export (200)', ok('zee_falhas_geologicas') && ok('zee_diques_geologicos'), [tiles.zee_falhas_geologicas, tiles.zee_diques_geologicos]);
  await setLayer(page, 'datageo-estruturas-geologicas', false);

  // Processos ANM perto da região calcária de Rio Branco do Sul.
  await setLayer(page, 'datageo-processos-minerarios', true);
  await setCamera(page, { lon: -49.31, lat: -25.19, alt: 25_000 });
  await waitMapIdle(page, 120_000);
  check('ANM: export com nome acentuado codificado (200)', ok('Processos_Miner%C3%A1rios_ANM'), tiles['Processos_Miner%C3%A1rios_ANM']);
  const anm = await tooltip('datageo-processos-minerarios', /Processo ANM/);
  check('ANM: tooltip com processo e substância', /Processo ANM \d+\/\d{4}/.test(anm) && /Substância/.test(anm), anm.slice(0, 200));
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-anm.png') });
  await setLayer(page, 'datageo-processos-minerarios', false);

  // Ocorrências minerais do SGB.
  await setLayer(page, 'datageo-ocorrencias-minerais', true);
  const st = await waitForStats(page, 'datageo-ocorrencias-minerais', 's => s.count > 0 || s.error', 90_000);
  check('SGB: ~233 ocorrências no PR', st.stats?.count > 200 && st.stats?.count < 400, st.stats);
  await setCamera(page, { lon: -51.5, lat: -24.6, alt: 900_000 });
  await waitMapIdle(page, 60_000);
  const oc = await tooltip('datageo-ocorrencias-minerais', /SGB/);
  check('SGB: tooltip com substância e acentos íntegros', /SGB/.test(oc) && !/�|Ã/.test(oc), oc.slice(0, 200));
  if (shot) await page.screenshot({ path: shot });

  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
