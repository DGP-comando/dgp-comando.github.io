// node --test src/data/protecaoSocial.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resumirProtecaoSocial } from './protecaoSocial.js';

const dados = JSON.parse(readFileSync(new URL('../../public/data/protecao-social-pr.json', import.meta.url), 'utf8'));

test('arquivo real: 399 municípios com CadÚnico e Bolsa Família, períodos AAAAMM', () => {
  const ms = Object.entries(dados.municipios);
  assert.equal(ms.length, 399);
  for (const [ibge, m] of ms) {
    assert.match(ibge, /^41\d{5}$/);
    assert.ok(m.cad_familias > 0 && m.pbf_familias >= 0 && m.populacao > 0, ibge);
    assert.ok(m.cad_pessoas <= m.populacao * 1.2, `${ibge}: pessoas no CadÚnico > população`);
  }
  for (const p of Object.values(dados.periodos)) assert.match(p, /^20\d{2}(0[1-9]|1[0-2])$/);
  assert.ok(dados.periodos.paa.endsWith('12'));
});

test('resumo: um município passa direto, vários somam, sem dado é null', () => {
  const d = {
    fonte: 'F', periodos: { cadunico: '202609' },
    municipios: { 1: { cad_familias: 10, paa_valor: 1.5 }, 2: { cad_familias: 5, pbf_familias: 3 } },
  };
  assert.deepEqual(resumirProtecaoSocial(d, ['1']), { n: 1, cad_familias: 10, paa_valor: 1.5, periodos: d.periodos, fonte: 'F' });
  const r = resumirProtecaoSocial(d, [1, 2, 99]);
  assert.equal(r.n, 2);
  assert.equal(r.cad_familias, 15);
  assert.equal(r.pbf_familias, 3);
  assert.equal(resumirProtecaoSocial(d, ['99']), null);
  assert.equal(resumirProtecaoSocial(null, ['1']), null);
});
