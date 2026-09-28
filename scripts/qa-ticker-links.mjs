#!/usr/bin/env node
/**
 * qa-ticker-links — as manchetes do letreiro "PR AO VIVO" abrem a página
 * fonte em nova aba. A resposta de news_items é interceptada com manchetes
 * de exemplo (sem login o DataGeo responde 401), incluindo uma URL
 * `javascript:` que NÃO pode virar link.
 *
 * Confere: links com href/target/rel, nada cobrindo o link, pausa da rolagem
 * no hover, clique abrindo a fonte em nova aba e o mapa ainda recebendo
 * eventos fora dos links.
 *
 * Uso: node scripts/qa-ticker-links.mjs [--url http://localhost:5173]
 * Requer dev server rodando.
 */
import { argValue, createReport, launchQaBrowser, openApp, sleep } from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const SOURCE_URL = 'https://example.com/noticia-qa-letreiro'; // domínio reservado: sem redirecionamento
const NEWS = [
  { title: 'Manchete com fonte oficial', source: 'AEN', url: SOURCE_URL, urgency: 'important', published_at: new Date().toISOString() },
  { title: 'Manchete com URL maliciosa', source: 'X', url: 'javascript:alert(1)', urgency: 'normal', published_at: new Date().toISOString() },
  { title: 'Manchete sem URL', source: 'Y', url: null, urgency: 'urgent', published_at: new Date().toISOString() },
];

const { check, finish } = createReport('qa-ticker-links');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 860 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('/rest/v1/news_items')) {
    // Resposta de outra origem (Supabase): CORS e preflight como o PostgREST faria.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: cors });
      return;
    }
    req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(NEWS) });
    return;
  }
  if (req.url().startsWith(SOURCE_URL)) {
    req.respond({ status: 200, contentType: 'text/html', body: '<title>fonte</title>ok' });
    return;
  }
  req.continue();
});

try {
  await openApp(page, url);
  await page.waitForSelector('#datageo-ticker .ticker-item', { timeout: 30_000 });

  const items = await page.$$eval('#datageo-ticker .ticker-item', (els) => els.map((el) => ({
    tag: el.tagName,
    href: el.getAttribute('href'),
    target: el.getAttribute('target'),
    rel: el.getAttribute('rel'),
    title: el.getAttribute('title'),
    text: el.querySelector('.ticker-title')?.textContent,
  })));
  check('3 manchetes renderizadas', items.length === 3, items.map((i) => i.text));
  check('manchete com URL http(s) vira link para a fonte', items[0]?.tag === 'A' && items[0].href === SOURCE_URL, items[0]);
  check('link abre em nova aba sem expor a página', items[0]?.target === '_blank' && items[0].rel === 'noopener noreferrer', items[0]);
  check('tooltip do link nomeia a fonte', items[0]?.title === 'Abrir a notícia em AEN (nova aba)', items[0]?.title);
  check('URL javascript: não vira link', items[1]?.tag === 'SPAN' && items[1].href === null, items[1]);
  check('manchete sem URL não vira link', items[2]?.tag === 'SPAN', items[2]);

  // Espera o link entrar na parte visível da faixa (a rolagem começa fora da tela).
  const point = await page.waitForFunction(() => {
    const a = document.querySelector('#datageo-ticker a.ticker-item');
    const track = document.querySelector('#datageo-ticker .ticker-track').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const x = r.left + Math.min(40, r.width / 2);
    return x > track.left + 10 && x < track.right - 10 ? { x, y: r.top + r.height / 2 } : null;
  }, { timeout: 60_000, polling: 200 }).then((h) => h.jsonValue());

  const topmost = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('a.ticker-item') ? 'link' : `${el?.tagName}#${el?.id}.${el?.className}`;
  }, point);
  check('nada cobre o link no ponto de clique', topmost === 'link', topmost);

  await page.mouse.move(point.x, point.y);
  await sleep(300);
  const paused = await page.$eval('#datageo-ticker .ticker-scroll', (el) => getComputedStyle(el).animationPlayState);
  check('rolagem pausa no hover', paused === 'paused', paused);

  const newTab = new Promise((resolve) => {
    browser.once('targetcreated', (target) => resolve(target.url()));
  });
  await page.mouse.click(point.x, point.y);
  const opened = await Promise.race([newTab, sleep(8000).then(() => null)]);
  check('clique abre a página fonte em nova aba', opened?.startsWith(SOURCE_URL), opened);
  check('a aba do app continua no app', page.url().startsWith(url), page.url());

  // Fora dos links a faixa não captura o mouse: o mapa (ou o chrome do app) recebe.
  const gap = await page.evaluate(() => {
    const track = document.querySelector('#datageo-ticker .ticker-track').getBoundingClientRect();
    const links = [...document.querySelectorAll('#datageo-ticker a.ticker-item')].map((a) => a.getBoundingClientRect());
    for (let x = track.left + 5; x < track.right - 5; x += 7) {
      const y = track.top + track.height / 2;
      if (links.some((r) => x >= r.left && x <= r.right)) continue;
      const el = document.elementFromPoint(x, y);
      return el?.closest('#datageo-ticker') ? 'faixa captura' : 'passa adiante';
    }
    return 'sem vão';
  });
  check('fora dos links a faixa não bloqueia o que está embaixo', gap === 'passa adiante', gap);
  // O dock inferior (voz no centro) não pode descer sobre a faixa em telas largas.
  const overlap = await page.evaluate(() => {
    const top = document.querySelector('#datageo-ticker').getBoundingClientRect().top;
    const lowest = [...document.querySelectorAll('#command-dock, #command-dock *')].reduce((m, e) => {
      const b = e.getBoundingClientRect();
      return b.height && getComputedStyle(e).visibility !== 'hidden' ? Math.max(m, b.bottom) : m;
    }, 0);
    return Math.round(lowest - top);
  });
  check('dock inferior não cobre a faixa (desktop)', overlap <= 0, `${overlap}px`);
  check('sem erros na página', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('execução do QA', false, error.message);
} finally {
  await browser.close();
}
finish();
