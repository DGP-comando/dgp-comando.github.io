#!/usr/bin/env node
/**
 * qa-apresentacao — o roteiro de demonstração (?apresentacao) no app real.
 *
 * Avança só com a seta → por todos os passos, confere que cada um ligou as
 * camadas que declara, que a ficha do município abriu e salva um screenshot
 * por passo. Sem login as camadas do bucket privado ficam vazias; o roteiro
 * tem que seguir mesmo assim.
 *
 * Uso: node scripts/qa-apresentacao.mjs [--url http://localhost:5173] [--out qa-shots/apresentacao] [--headful]
 */
import fs from 'node:fs';
import path from 'node:path';
import { argValue, createReport, hasFlag, launchQaBrowser, openApp, sleep, waitMapIdle } from './lib/qaBrowser.mjs';

const url = argValue('--url', 'http://localhost:5173');
const outDir = argValue('--out', 'qa-shots/apresentacao');
fs.mkdirSync(outDir, { recursive: true });
const report = createReport('qa-apresentacao');

const { browser, page, errors } = await launchQaBrowser({ headful: hasFlag('--headful'), viewport: { width: 1440, height: 860 } });

const estado = () => page.evaluate(() => {
  const root = document.getElementById('first-run-launcher');
  const dm = window.__godsEyeView.dataManager;
  return {
    present: Boolean(root),
    visible: root?.classList.contains('visible') ?? false,
    step: root?.dataset.step ?? null,
    counter: root?.querySelector('[data-tour-counter]')?.textContent ?? null,
    next: root?.querySelector('[data-tour-next]')?.textContent ?? null,
    ligadas: dm.getAll().filter((l) => l.enabled).map((l) => l.id).sort(),
    ficha: document.getElementById('datageo-ficha')?.classList.contains('open') ?? false,
    fichaNome: document.querySelector('#datageo-ficha .fx-nome')?.textContent ?? null,
    sugestoes: document.querySelectorAll('.location-search-option').length,
    highlighted: [...document.querySelectorAll('.tour-highlight')].map((n) => n.id),
    bottom: root ? Math.round(window.innerHeight - root.getBoundingClientRect().bottom) : null,
  };
});

try {
  await openApp(page, `${url}/?apresentacao=1`);
  await page.waitForFunction(() => document.getElementById('first-run-launcher')?.classList.contains('visible'), { timeout: 60_000 });
  await sleep(600);

  let s = await estado();
  report.check('abre no passo inicio, centrado, botão Começar', s.step === 'inicio' && s.next === 'Começar' && s.counter.startsWith('1 /'), s);
  await page.screenshot({ path: path.join(outDir, '01-inicio.png') });

  // Só camadas ESTÁTICAS entram em `ligadas`: as do Supabase e do bucket
  // privado (clima, CEMADEN, focos, CAF, ADAPAR, unidades do IDR…) não
  // carregam sem login e o manager desfaz o ligar. Com login elas entram.
  const esperado = {
    camadas: { highlighted: ['data-panel'] },
    estado: { ligadas: ['datageo-regionais-idr', 'datageo-adapar-unidades', 'datageo-ceasas'] },
    'tempo-real': { desligadas: ['datageo-regionais-idr', 'datageo-adapar-unidades', 'datageo-ceasas'] },
    logistica: { ligadas: ['datageo-rodovias', 'datageo-ferrovias', 'datageo-armazens', 'datageo-ceasas'] },
    localizacao: { sugestoes: true, desligadas: ['datageo-rodovias'] },
    municipio: { ficha: 'Prudentópolis' },
    territorio: { ligadas: ['datageo-rodovias', 'datageo-estradas', 'datageo-car'] },
    'agricultura-familiar': { desligadas: ['datageo-car', 'datageo-estradas'] },
    'defesa-agua': { ligadas: ['datageo-outorgas'] },
    'ambiente-riscos': { ligadas: ['datageo-faxinais', 'datageo-ucs-estaduais', 'datageo-clima-historico'], desligadas: ['datageo-outorgas'] },
    vigilancia: { desligadas: ['datageo-faxinais'], highlighted: ['datageo-area-watch'] },
    encerramento: { highlighted: ['top-center-actions'] },
  };

  let n = 1;
  for (const [id, exp] of Object.entries(esperado)) {
    await page.keyboard.press('ArrowRight');
    await sleep(id === 'municipio' || id === 'territorio' ? 4500 : 2200);
    await waitMapIdle(page, 8000);
    s = await estado();
    const ok = s.step === id
      && (exp.ligadas ?? []).every((l) => s.ligadas.includes(l))
      && (exp.desligadas ?? []).every((l) => !s.ligadas.includes(l))
      && (exp.highlighted ?? []).every((h) => s.highlighted.includes(h))
      && (!exp.sugestoes || s.sugestoes > 0)
      && (!exp.ficha || (s.ficha && s.fichaNome === exp.ficha))
      && s.bottom !== null && s.bottom < 200;
    report.check(`passo ${id}`, ok, { step: s.step, ligadas: s.ligadas, ficha: s.fichaNome, sugestoes: s.sugestoes, highlighted: s.highlighted, bottom: s.bottom });
    n += 1;
    await page.screenshot({ path: path.join(outDir, `${String(n).padStart(2, '0')}-${id}.png`) });
  }

  report.check('último passo mostra Concluir', s.next === 'Concluir', s.next);
  await page.keyboard.press('ArrowRight');
  await sleep(700);
  s = await estado();
  report.check('Concluir fecha o card e mantém a sala', !s.present && s.ficha, { present: s.present, ficha: s.ficha, ligadas: s.ligadas });
  await page.screenshot({ path: path.join(outDir, '99-final.png') });

  const relevantes = errors.filter((e) => !/401|403|privado|Supabase|supabase|fetch/i.test(e));
  report.check('sem erros de página', relevantes.length === 0, relevantes.slice(0, 5));
} finally {
  await browser.close();
  report.finish();
}
