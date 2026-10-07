#!/usr/bin/env node
/**
 * qa-legenda-filtro — filtro de classes pela legenda em todas as camadas.
 *
 * Para cada camada cuja legenda tem itens clicáveis (`[data-key]`):
 *   - vetor (legendFilter): esconder todas as classes zera as feições
 *     renderizadas dos layers filtráveis; mostrar de novo devolve; Shift+clique
 *     num item deixa só feições daquela classe;
 *   - imagem / onLegend: o item fica marcado como escondido, a camada troca o
 *     desenho (URL de tiles, imagem, paint) e nada quebra no console.
 * Camadas privadas (sem login no ?semlogin) e sem feição na vista viram SKIP.
 *
 * Uso: node scripts/qa-legenda-filtro.mjs [--url http://localhost:5173] [--only id1,id2]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitForStats, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const only = argValue('--only', '')?.split(',').filter(Boolean) ?? [];
const { check, skip, finish } = createReport('qa-legenda-filtro');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 900 } });

// Vistas para achar feições: estado inteiro e um recorte mais perto (Ponta Grossa).
const VISTAS = [
  { lon: -51.4, lat: -24.6, alt: 900_000 },
  { lon: -50.16, lat: -25.09, alt: 40_000 },
  { lon: -50.16, lat: -25.09, alt: 6_000 },
];

const itens = (id) => page.evaluate((lid) => [...document.querySelectorAll(`[data-layer-id="${lid}"] .data-toggle-legend-item[data-key]`)]
  .map((el) => ({ key: el.dataset.key, oculto: el.classList.contains('is-oculto') })), id);
const clica = (id, key, shift = false) => page.evaluate(([lid, k, s]) => {
  const el = document.querySelector(`[data-layer-id="${lid}"] .data-toggle-legend-item[data-key="${CSS.escape(k)}"]`);
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: s }));
  return Boolean(el);
}, [id, key, shift]);

/** Feições renderizadas nos layers filtráveis da camada, com o valor da classe. */
const feicoes = (id) => page.evaluate((lid) => {
  const { engine, layerHost } = window.__godsEyeView;
  const def = layerHost.ctx.getLayer(lid);
  const tipos = new Set(['circle', 'symbol', 'line', 'fill', 'fill-extrusion']);
  const ids = (def?.layers ?? []).filter((l) => tipos.has(l.type) && l.metadata?.['dg:legenda'] !== false)
    .map((l) => l.id).filter((x) => engine.map.getLayer(x) && engine.map.getLayoutProperty(x, 'visibility') !== 'none');
  const prop = typeof def?.legendFilter === 'string' ? def.legendFilter : null;
  const fs = ids.length ? engine.map.queryRenderedFeatures({ layers: ids }) : [];
  return { n: fs.length, classes: prop ? [...new Set(fs.map((f) => String(f.properties?.[prop])))] : [], prop, onLegend: Boolean(def?.onLegend) };
}, id);

const repinta = async () => {
  await page.evaluate(() => window.__godsEyeView.dataManager._refreshTogglePanel?.());
  await waitMapIdle(page, 30_000);
  await sleep(400);
};

try {
  await openApp(page, url);
  const ids = await page.evaluate(() => [...window.__godsEyeView.dataManager.layers.keys()]);
  const alvo = only.length ? ids.filter((x) => only.includes(x)) : ids;
  for (const id of alvo) {
    await setLayer(page, id, true);
    const st = await waitForStats(page, id, 's => !s.loading && (s.count > 0 || s.error || s.lastUpdate)', 45_000);
    await repinta();
    let lista = await itens(id);
    if (!lista.length) {
      // Sem legenda clicável (cor única, fonte externa fora, dado privado sem login).
      if (st.stats?.error) skip(`${id}: sem legenda para testar (${String(st.stats.error).slice(0, 60)})`);
      await setLayer(page, id, false);
      continue;
    }
    let base = await feicoes(id);
    for (const v of VISTAS) {
      if (base.n || base.onLegend) break;
      await setCamera(page, v);
      await repinta();
      base = await feicoes(id);
    }
    const errosAntes = errors.length;
    for (const it of lista) await clica(id, it.key);
    await repinta();
    lista = await itens(id);
    check(`${id}: itens marcados como escondidos`, lista.every((it) => it.oculto), lista);
    if (!base.onLegend) {
      if (!base.n) skip(`${id}: sem feição na vista para conferir o filtro`);
      else check(`${id}: esconder todas zera as feições (${base.n} antes)`, (await feicoes(id)).n === 0);
    }
    for (const it of lista) await clica(id, it.key);
    await repinta();
    if (!base.onLegend && base.n) check(`${id}: mostrar de novo devolve as feições`, (await feicoes(id)).n > 0);
    // Shift+clique: só a classe com mais feições na vista.
    if (!base.onLegend && base.prop && base.classes.length >= 2) {
      const so = base.classes.find((c) => lista.some((it) => it.key === c)) ?? lista[0].key;
      await clica(id, so, true);
      await repinta();
      const f = await feicoes(id);
      check(`${id}: Shift+clique deixa só "${so}"`, f.n > 0 && f.classes.every((c) => c === so), f.classes);
      await clica(id, so, true); // volta a mostrar todas
      await repinta();
    }
    check(`${id}: sem erro de página ao filtrar`, errors.length === errosAntes, errors.slice(errosAntes, errosAntes + 3));
    await setLayer(page, id, false);
    await setCamera(page, VISTAS[0]);
  }
  check('sem erros de página', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  check('execução sem exceção', false, err?.stack ?? String(err));
} finally {
  await browser.close();
  finish();
}
