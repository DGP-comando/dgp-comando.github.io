import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { gdFeatures, gdTooltip, lerJsonGz, registro } from './gdSolar.js';

const d = {
  fonte: 'ANEEL',
  classes: ['Residencial', 'Rural', 'Comercial', 'Industrial', 'Poder público e serviços', 'Outros'],
  campos: ['x', 'y', 'kw', 'c', 'cod', 'titular', 'doc', 'tipoCons', 'cep', 'mun', 'ag', 'cls', 'sub',
    'mod', 'porte', 'qtdUC', 'dtAtual', 'dtConex', 'local', 'se', 'nPonto', 'aprox', 'obs'],
  dic: { mun: ['Marialva', 'Toledo'], ag: ['COPEL DISTRIBUICAO S.A.'], cls: ['Residencial', 'Rural'], sub: ['B1', 'A4'],
    mod: ['Geração na própria UC', 'Autoconsumo remoto'], porte: ['Microgeração (até 75 kW)', 'Minigeração (acima de 75 kW)'],
    local: ['Área urbanizada', ''], se: ['', 'SE TOLEDO'], obs: ['', 'a ANEEL informa 75 kW (teto)'] },
  p: [
    [-51.8, -23.48, 5.5, 0, 'GD.PR.001', '', '***.087.939-**', 'PF', '87235***', 0, 0, 0, 0, 0, 0, 1, '2021-12-22', '2021-12-01', 0, 0, 36, 0, 1],
    [-53.7, -24.7, 1500, 1, 'GD.PR.002', 'COOPERATIVA AGROINDUSTRIAL', '76.446.020/0001-52', 'PJ', '85900000', 1, 0, 1, 1, 1, 1, 12, '2024-05-02', '2024-03-10', 1, 1, 1, 1, 0],
  ],
};

test('features: classe e potência', () => {
  const { features, counts } = gdFeatures(d);
  assert.deepEqual(features.map((f) => [f.id, f.properties.c, f.properties.kw, f.properties.aprox]), [[0, 0, 5.5, 0], [1, 1, 1500, 1]]);
  assert.deepEqual(counts.slice(0, 2), [1, 1]);
});

test('registro resolve o dicionário', () => {
  const r = registro(d, 1);
  assert.equal(r.mun, 'Toledo');
  assert.equal(r.se, 'SE TOLEDO');
  assert.equal(r.mod, 'Autoconsumo remoto');
  assert.equal(registro(d, 9), null);
});

test('tooltip PF: mascarado, datas e espalhamento', () => {
  const html = gdTooltip(registro(d, 0), d);
  for (const s of ['pessoa física', '***.087.939-**', '5,50 kW', '01/12/2021', '22/12/2021', 'Marialva · 87235***', 'SIGEL arredonda', 'entre 36 no mesmo ponto', 'Geração na própria UC', 'a ANEEL informa 75 kW']) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes('UCs que recebem crédito'));
});

test('tooltip PJ: nome, CNPJ, MW, UCs, subestação', () => {
  const html = gdTooltip(registro(d, 1), d);
  assert.ok(!html.includes('Observação'));
  for (const s of ['COOPERATIVA AGROINDUSTRIAL', '76.446.020/0001-52', '1,50 MW', 'Minigeração', 'UCs que recebem crédito', 'SE TOLEDO', 'A4', 'no município (fora do SIGEL']) {
    assert.ok(html.includes(s), s);
  }
});

test('lerJsonGz: com e sem gzip', async () => {
  const obj = { a: 'ação' };
  assert.deepEqual(await lerJsonGz(new Response(gzipSync(JSON.stringify(obj)))), obj);
  assert.deepEqual(await lerJsonGz(new Response(JSON.stringify(obj))), obj);
});
