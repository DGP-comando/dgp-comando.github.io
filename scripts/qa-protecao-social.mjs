#!/usr/bin/env node
/**
 * qa-protecao-social — a ficha municipal mostra a seção "Proteção social ·
 * MDS" com os números de public/data/protecao-social-pr.json; a regional,
 * a soma do recorte.
 *
 * Uso: node scripts/qa-protecao-social.mjs [--url http://localhost:5173] [--shot arquivo.png]
 * Requer dev server rodando.
 */
import { readFileSync } from 'node:fs';
import { argValue, createReport, launchQaBrowser, openApp } from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', '');
const PS = JSON.parse(readFileSync(new URL('../public/data/protecao-social-pr.json', import.meta.url), 'utf8')).municipios;
const CASOS = [
  { ibge: '4100103', nome: 'Abatiá' },
  { ibge: '4106902', nome: 'Curitiba' },
];
const fmt = (v) => Number(v).toLocaleString('pt-BR');

const { check, finish } = createReport('qa-protecao-social');
const { browser, page, errors } = await launchQaBrowser({
  viewport: { width: 1440, height: 900 },
  ignoreConsole: /Failed to load resource|ERR_|AJAXError|net::|CORS policy|401|DataGeo/i,
});

// `espera`: texto que só a ficha pedida tem (o painel é reaproveitado entre aberturas).
const secao = async (espera) => {
  await page.waitForFunction(
    (e) => {
      const t = document.querySelector('#datageo-ficha')?.textContent ?? '';
      return /Proteção social/.test(t) && t.includes(e);
    },
    { timeout: 60_000 },
    espera,
  );
  return page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
    .find((s) => /Proteção social/.test(s.querySelector('h3')?.textContent ?? ''))?.textContent ?? '');
};

try {
  await openApp(page, url);
  for (const { ibge, nome } of CASOS) {
    await page.evaluate(async (c, n) => {
      const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
      await openMunicipioFicha(c, n);
    }, ibge, nome);
    const texto = await secao(`IBGE ${ibge}`);
    const m = PS[ibge];
    check(`${nome}: famílias no CadÚnico`, texto.includes(`CadÚnico: ${fmt(m.cad_familias)} famílias`), texto);
    check(`${nome}: Bolsa Família`, texto.includes(`Bolsa Família: ${fmt(m.pbf_familias)} famílias`), texto);
    check(`${nome}: PAA`, m.paa_agricultores ? texto.includes(`PAA`) && texto.includes(`${fmt(m.paa_agricultores)} agricultor`) : /Sem compras do PAA/.test(texto), texto);
    check(`${nome}: sem undefined/NaN`, !/undefined|NaN/.test(texto), texto);
    if (shot && ibge === CASOS[0].ibge) {
      await page.evaluate(() => [...document.querySelectorAll('#datageo-ficha .fx-section')]
        .find((x) => /Proteção social/.test(x.textContent))?.scrollIntoView({ block: 'start' }));
      await (await page.$('#datageo-ficha')).screenshot({ path: shot });
      console.log('   screenshot:', shot);
    }
  }

  const regiao = CASOS.map((c) => c.ibge);
  await page.evaluate(async (ibges) => {
    const { openFichaRegiao } = await import('/src/datageoFicha.js');
    await openFichaRegiao({ nome: 'Recorte QA', meta: 'QA', ibges });
  }, regiao);
  const reg = await secao('soma de 2 municípios');
  const soma = regiao.reduce((a, c) => a + PS[c].cad_familias, 0);
  check('regional: soma do CadÚnico', reg.includes(`CadÚnico: ${fmt(soma)} famílias`) && reg.includes('soma de 2 municípios'), reg);
  check('sem erros de página', errors.length === 0, errors);
} finally {
  await browser.close();
}
finish();
