import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resumirModulos } from './modulosFiscais.js';

const DADOS = {
  fonte: 'INCRA',
  municipios: {
    4106902: { mf: 5, mei: 5, fmp: 2, ie2022: false },
    4100103: { mf: 18, mei: 15, fmp: 2, ie2022: true },
    4104808: { mf: 18, mei: 10, fmp: 2, ie2022: false },
  },
};

test('um município: módulo fiscal, rural e FMP, com os limites de porte em hectares', () => {
  assert.deepEqual(resumirModulos(DADOS, ['4100103']), {
    n: 1,
    mf: 18,
    mei: 15,
    fmp: 2,
    pequenaAteHa: 72,
    mediaAteHa: 270,
    fonte: 'INCRA',
  });
  assert.equal(resumirModulos(DADOS, [4106902]).mf, 5, 'código numérico também serve');
});

test('vários municípios (regional): faixa do módulo fiscal', () => {
  assert.deepEqual(resumirModulos(DADOS, ['4106902', '4100103', '4104808']), {
    n: 3, mfMin: 5, mfMax: 18, fonte: 'INCRA',
  });
});

test('códigos sem dado são ignorados; nenhum dado → null', () => {
  assert.equal(resumirModulos(DADOS, ['4100103', '9999999']).mf, 18);
  assert.equal(resumirModulos(DADOS, ['9999999']), null);
  assert.equal(resumirModulos(DADOS, []), null);
  assert.equal(resumirModulos(null, ['4100103']), null);
});

test('o arquivo publicado cobre os 399 municípios com valores plausíveis', () => {
  const dados = JSON.parse(fs.readFileSync(new URL('../../public/data/modulos-fiscais-pr.json', import.meta.url), 'utf8'));
  const info = JSON.parse(fs.readFileSync(new URL('../../public/data/municipios-info.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(dados.municipios).sort(), Object.keys(info.municipios).sort());
  for (const [ibge, m] of Object.entries(dados.municipios)) {
    assert.ok(m.mf >= 5 && m.mf <= 110, `${ibge}: MF ${m.mf}`);
    assert.ok(m.mei > 0 && m.fmp > 0, `${ibge}: ${JSON.stringify(m)}`);
  }
  assert.equal(dados.municipios['4106902'].mf, 5, 'Curitiba: 5 ha (INCRA)');
});
