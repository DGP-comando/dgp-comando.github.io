// Faxinais do IAT: integridade dos dois GeoJSONs (scripts/build_faxinais.py),
// estilo/tooltip dos pontos e dos perímetros e registro das camadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faxinalTooltip, TERRITORIO_SPECS } from './territoriosSpec.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { pointFeatures } from '../maplibre/layers/energiaLogistica.js';
import { faxinalPontoEstilo, faxinalPontoTooltip, faxinaisLayer, FAXINAL_LEGENDA } from '../maplibre/layers/faxinais.js';
import { LAYERS } from '../maplibre/layers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', name), 'utf8'));
const noPr = ([lon, lat]) => lon > -54.7 && lon < -48 && lat > -26.8 && lat < -22.4;
const ibges = new Set(read('municipios-pr.geojson').features.map((f) => String(f.properties.CD_MUN)));

test('pontos: 227 faxinais do ZEE-PR 2010, no PR, com município do IBGE', () => {
  const gj = read('faxinais-pr.geojson');
  assert.equal(gj.features.length, 227);
  assert.match(gj.fonte, /ZEE-PR/);
  for (const f of gj.features) {
    const p = f.properties;
    assert.ok(p.nome, 'sem nome');
    assert.ok(ibges.has(p.ibge), `IBGE inválido: ${p.ibge}`);
    assert.ok(['Faxinal', 'ARESUR', ''].includes(p.tipo), `tipo ${p.tipo}`);
    assert.ok(['1', '2', '3', '4'].includes(p.situacao), `situação ${p.situacao}`);
    assert.equal(f.geometry.type, 'Point');
    assert.ok(noPr(f.geometry.coordinates), `fora do PR: ${f.geometry.coordinates}`);
  }
  assert.ok(gj.features.some((f) => f.properties.nome === 'Faxinal dos Stresser' && f.properties.municipio === 'Inácio Martins'),
    'acentos preservados');
  // Ponto sem município na origem, logo além da divisa: o mais próximo.
  assert.equal(gj.features.find((f) => f.properties.nome === 'Taquaral dos Bugre')?.properties.municipio, 'São Mateus do Sul');
});

test('perímetros: 29 territórios do CAR + ARESUR sem território, sem duplicar', () => {
  const gj = read('faxinais-territorios-pr.geojson');
  const car = gj.features.filter((f) => f.properties.base === 'CAR');
  const aresur = gj.features.filter((f) => f.properties.base === 'ARESUR');
  assert.equal(car.length, 29);
  // Um polígono por faxinal: o imóvel do CAR dentro do território vira área.
  assert.equal(new Set(gj.features.map((f) => `${f.properties.nome}|${f.properties.municipio}`)).size, gj.features.length);
  const campestre = car.find((f) => f.properties.nome.startsWith('Faxinal Campestre Dos Paulas')).properties;
  assert.equal(campestre.perimetro, 'Área do Território');
  assert.ok(campestre.area_imovel_ha > 14 && campestre.area_imovel_ha < 15);
  assert.equal(aresur.length, 2);
  for (const f of gj.features) {
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
    assert.ok(ibges.has(f.properties.ibge));
  }
  // A grafia "São Jose do Triunfo" da origem vira o município certo.
  assert.equal(aresur.find((f) => f.properties.nome === 'Faxinal dos Seixas')?.properties.municipio, 'São João do Triunfo');
  // O ARESUR casado empresta resolução e área ao território do CAR.
  const salso = car.find((f) => f.properties.nome === 'Faxinal Salso').properties;
  assert.equal(salso.resolucao, '036/2018');
  assert.equal(salso.area_resolucao_ha, 268);
});

test('estilo dos pontos: cor por situação, ARESUR maior, legenda cobre os grupos', () => {
  const { features, counts } = pointFeatures(read('faxinais-pr.geojson'), faxinalPontoEstilo);
  assert.equal(features.length, 227);
  assert.deepEqual(counts, { 1: 11, 2: 55, 3: 51, 4: 110 });
  const grupos = new Set(FAXINAL_LEGENDA.map((l) => l.grupo));
  for (const g of Object.keys(counts)) assert.ok(grupos.has(g), `grupo ${g} fora da legenda`);
  assert.ok(faxinalPontoEstilo({ tipo: 'ARESUR', situacao: '2' }).size > faxinalPontoEstilo({ tipo: 'Faxinal', situacao: '2' }).size);
});

test('tooltips trazem nome, município e situação na ARESUR', () => {
  const pt = faxinalPontoTooltip({ nome: 'Faxinal dos Stresser', municipio: 'Inácio Martins', tipo: 'Faxinal', situacao: '1', nro: '111' });
  assert.match(pt, /Faxinal dos Stresser/);
  assert.match(pt, /Inácio Martins/);
  assert.match(pt, /criador aberto/);
  const poli = faxinalTooltip({
    nome: 'Faxinal Dos Krüger', municipio: 'Boa Ventura de São Roque', base: 'CAR', perimetro: 'Área do Território',
    aresur: 'Sim', resolucao: '038/2013', area_ha: 568.5734, area_resolucao_ha: 500.7, recibo_car: 'PR-4103040-X', obs: '',
  });
  assert.match(poli, /Faxinal dos Krüger/);
  assert.match(poli, /038\/2013/);
  assert.match(poli, /ARESUR/);
  assert.match(faxinalTooltip({ nome: 'Faxinal Espigão Das Antas', aresur: 'Em análise', base: 'CAR', perimetro: 'Área do Território' }),
    /em análise/);
});

test('camadas no painel e no share link', () => {
  const ids = new Set(LAYERS.map((l) => l.id));
  for (const id of ['datageo-faxinais', TERRITORIO_SPECS.faxinais.id]) {
    assert.ok(ids.has(id), `${id} fora do painel`);
    assert.ok(LAYER_STATE_REGISTRY.find((e) => e.id === id), `${id} sem token`);
  }
  assert.equal(faxinaisLayer.category, 'Limites');
});
