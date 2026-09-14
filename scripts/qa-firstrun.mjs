#!/usr/bin/env node
/**
 * qa-firstrun — o tutorial de entrada no app real.
 *
 * Percorre os quatro passos, confere o realce dos painéis, os botões de ação
 * (abrir camadas, abrir busca), que ESC na busca não fecha o tutorial, que
 * Concluir grava só a flag de sessão e que um reload na mesma sessão não o
 * mostra de novo. Salva screenshots de cada passo (desktop e celular).
 *
 * Uso: node scripts/qa-firstrun.mjs [--url http://localhost:5173] [--out qa-shots/tutorial]
 * Requer dev server rodando. PUPPETEER_EXECUTABLE_PATH aponta um Chrome local.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const outDir = arg('--out', 'qa-shots/tutorial');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--window-size=1440,900', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
});

const state = (page) => page.evaluate(() => {
  const root = document.getElementById('first-run-launcher');
  if (!root) return { present: false };
  const visibleStep = [...root.querySelectorAll('[data-tour-step]')].find((s) => !s.hidden);
  return {
    present: true,
    visible: root.classList.contains('visible'),
    step: visibleStep?.dataset.tourStep ?? null,
    counter: root.querySelector('[data-tour-counter]')?.textContent,
    next: root.querySelector('[data-tour-next]')?.textContent,
    backHidden: root.querySelector('[data-tour-back]')?.hidden,
    highlighted: [...document.querySelectorAll('.tour-highlight')].map((n) => n.id),
    labelledBy: root.getAttribute('aria-labelledby'),
  };
});

async function waitCard(page) {
  await page.waitForFunction(
    () => document.getElementById('first-run-launcher')?.classList.contains('visible'),
    { timeout: 90_000 },
  );
  await sleep(500);
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(`${url}/?welcome=1`, { waitUntil: 'domcontentloaded' });
  await waitCard(page);

  let s = await state(page);
  check('passo 1 visível com contador e botão Começar',
    s.step === 'inicio' && s.counter === '1 / 4' && s.next === 'Começar' && s.backHidden === true, s);
  check('card de missões não existe mais',
    await page.evaluate(() => !document.querySelector('[data-first-run-choice]')));
  await page.screenshot({ path: path.join(outDir, '1-inicio.png') });

  await page.click('[data-tour-next]');
  await sleep(400);
  s = await state(page);
  check('passo 2 camadas realça #data-panel', s.step === 'camadas' && s.highlighted.includes('data-panel')
    && s.labelledBy === 'tour-title-camadas', s);
  await page.click('[data-tour-action="layers"]');
  await sleep(600);
  const panelOpen = await page.evaluate(() => !document.getElementById('data-panel').classList.contains('collapsed'));
  check('"Abrir o painel de camadas" abre o painel', panelOpen);
  s = await state(page);
  check('tutorial segue aberto depois da ação', s.present && s.visible && s.step === 'camadas', s);
  await page.screenshot({ path: path.join(outDir, '2-camadas.png') });

  await page.click('[data-tour-next]');
  await sleep(400);
  s = await state(page);
  check('passo 3 localização realça #location-bar', s.step === 'localizacao' && s.highlighted.includes('location-bar')
    && !s.highlighted.includes('data-panel'), s);
  await page.click('[data-tour-action="search"]');
  await sleep(600);
  const search = await page.evaluate(() => ({
    focused: document.activeElement?.id,
    expanded: document.getElementById('location-search').classList.contains('expanded'),
  }));
  check('"Experimentar a busca" foca a busca', search.focused === 'location-search' && search.expanded, search);
  await page.keyboard.type('Guarapu');
  await sleep(500);
  const sugestoes = await page.evaluate(() => [...document.querySelectorAll('#location-search-results [role="option"], #location-search-results li')]
    .map((li) => li.textContent.trim()).slice(0, 3));
  check('busca sugere municípios com acento', sugestoes.some((t) => /Guarapuava/.test(t)), sugestoes);
  await page.screenshot({ path: path.join(outDir, '3-localizacao.png') });
  await page.keyboard.press('Escape');
  await sleep(300);
  s = await state(page);
  check('ESC dentro da busca não fecha o tutorial', s.present && s.visible, s);

  await page.click('[data-tour-next]');
  await sleep(400);
  s = await state(page);
  check('passo 4 preferências com Concluir', s.step === 'preferencias' && s.next === 'Concluir' && s.counter === '4 / 4', s);
  await page.screenshot({ path: path.join(outDir, '4-preferencias.png') });

  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  s = await state(page);
  check('seta ← volta um passo com o foco no card', s.step === 'localizacao', s);
  await page.click('[data-tour-next]');
  await sleep(300);

  await page.click('[data-tour-next]');
  await sleep(700);
  const closed = await page.evaluate(() => ({
    present: Boolean(document.getElementById('first-run-launcher')),
    highlights: document.querySelectorAll('.tour-highlight').length,
    session: sessionStorage.getItem('gev:first-run-tour-session:v1'),
    durable: localStorage.getItem('gev:first-run-tour:v1'),
  }));
  check('Concluir fecha, limpa o realce e grava só a sessão',
    !closed.present && closed.highlights === 0 && closed.session === 'dismissed' && closed.durable === null, closed);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(14_000);
  check('reload na mesma sessão não mostra o tutorial',
    await page.evaluate(() => !document.getElementById('first-run-launcher')?.classList.contains('visible')));

  // ESC com foco no card fecha; celular.
  const mobile = await browser.newPage();
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mobile.goto(`${url}/?welcome=1`, { waitUntil: 'domcontentloaded' });
  await waitCard(mobile);
  await mobile.click('[data-tour-next]');
  await sleep(400);
  const fits = await mobile.evaluate(() => {
    const r = document.getElementById('first-run-launcher').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: innerHeight, vw: innerWidth };
  });
  check('card cabe na tela do celular', fits.top >= 0 && fits.bottom <= fits.vh && fits.left >= 0 && fits.right <= fits.vw, fits);
  await mobile.screenshot({ path: path.join(outDir, 'mobile-camadas.png') });
  await mobile.focus('[data-tour-next]');
  await mobile.keyboard.press('Escape');
  await sleep(700);
  check('ESC com foco no card fecha', await mobile.evaluate(() => !document.getElementById('first-run-launcher')));

  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-firstrun: ${passed}/${results.length} passed · screenshots em ${outDir}`);
process.exit(passed === results.length ? 0 : 1);
