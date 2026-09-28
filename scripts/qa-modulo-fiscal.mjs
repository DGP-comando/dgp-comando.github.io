#!/usr/bin/env node
/**
 * qa-modulo-fiscal — a ficha municipal mostra o módulo fiscal do INCRA
 * imediatamente antes da estrutura fundiária do CAR, com o valor do
 * município (public/data/modulos-fiscais-pr.json); a ficha regional mostra
 * a faixa.
 *
 * Uso: node scripts/qa-modulo-fiscal.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando.
 */
import { readFileSync } from 'node:fs';
import { argValue, createReport, launchQaBrowser, openApp } from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const MF = JSON.parse(readFileSync(new URL('../public/data/modulos-fiscais-pr.json', import.meta.url), 'utf8')).municipios;
const CASOS = [
  { ibge: '4109401', nome: 'Guarapuava' },
  { ibge: '4106902', nome: 'Curitiba' },
];
const fmt = (v) => `${v.toLocaleString('pt-BR')} ha`;

const { check, finish } = createReport('qa-modulo-fiscal');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

const lerFicha = () => page.evaluate(() => {
  const secoes = [...document.querySelectorAll('#datageo-ficha .fx-section')];
  const titulos = secoes.map((s) => s.querySelector('h3')?.textContent ?? '');
  const mod = secoes.find((s) => /Módulo fiscal/.test(s.querySelector('h3')?.textContent ?? ''));
  return { titulos, texto: mod?.textContent ?? null };
});
const esperarSecoes = () => page.waitForFunction(
  () => /Módulo fiscal/.test(document.querySelector('#datageo-ficha .fx-body')?.textContent ?? '')
    && /Estrutura fundi/.test(document.querySelector('#datageo-ficha .fx-body')?.textContent ?? ''),
  { timeout: 60_000 },
);

try {
  await openApp(page, url);
  for (const { ibge, nome } of CASOS) {
    await page.evaluate(async (c, n) => {
      const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
      await openMunicipioFicha(c, n);
    }, ibge, nome);
    await esperarSecoes();
    const { titulos, texto } = await lerFicha();
    const iMod = titulos.findIndex((t) => /Módulo fiscal/.test(t));
    const iCar = titulos.findIndex((t) => /Estrutura fundi/.test(t));
    check(`${nome}: módulo fiscal logo antes do CAR`, iMod >= 0 && iMod === iCar - 1, titulos);
    const m = MF[ibge];
    check(`${nome}: 1 MF = ${fmt(m.mf)} (INCRA)`, texto?.includes(`1 módulo fiscal = ${fmt(m.mf)}`), texto);
    check(`${nome}: limites de porte em ha`,
      texto?.includes(`até ${fmt(4 * m.mf)} (4 MF)`) && texto.includes(`até ${fmt(15 * m.mf)} (15 MF)`), texto);
    check(`${nome}: módulo rural e FMP`,
      texto?.includes(`exploração indefinida): ${fmt(m.mei)}`) && texto.includes(`parcelamento: ${fmt(m.fmp)}`), texto);
    if (shot && ibge === CASOS[0].ibge) {
      const card = await page.$('#datageo-ficha');
      await page.evaluate(() => {
        const s = [...document.querySelectorAll('#datageo-ficha .fx-section')].find((x) => /Módulo fiscal/.test(x.textContent));
        s?.scrollIntoView({ block: 'start' });
      });
      await card.screenshot({ path: shot });
      console.log('   screenshot:', shot);
    }
  }

  // Ficha regional: faixa do MF nos municípios do recorte.
  const regiao = ['4109401', '4106902', '4100103'];
  await page.evaluate(async (ibges) => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Recorte QA', meta: 'QA', ibges });
  }, regiao);
  await esperarSecoes();
  const reg = await lerFicha();
  const mfs = regiao.map((c) => MF[c].mf);
  const esperado = `de ${fmt(Math.min(...mfs))} a ${fmt(Math.max(...mfs))} nos 3 municípios`;
  check('regional: faixa do módulo fiscal', reg.texto?.includes(esperado), { esperado, texto: reg.texto });
  check('sem erros na página', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('execução do QA', false, error.message);
} finally {
  await browser.close();
}
finish();
