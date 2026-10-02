// node --test src/data/programasIdr.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  CAFE_LEGENDA, GRAOS_LEGENDA, PECUARIA_LEGENDA, PISCICULTURA_LEGENDA, UR_LABEL_DIST,
  cafeEstilo, coordenadaConferida, graosEstilo, graosGrupo, graosTooltip, pecuariaEstilo, pecuariaTooltip,
  pisciculturaEstilo,
} from './programasIdrEstilos.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import layers, { PROGRAMAS_IDR } from '../maplibre/layers/programasIdr.js';

// data/privado/ fica fora do git: os testes com dado real só rodam onde o arquivo existe.
const PRIV = (n) => new URL(`../../data/privado/${n}`, import.meta.url);
const real = (n) => JSON.parse(readFileSync(PRIV(n), 'utf8')).features;

const PONTOS = [
  ['urs-graos-pr.geojson', graosEstilo, GRAOS_LEGENDA, 150],
  ['urs-cafe-pr.geojson', cafeEstilo, CAFE_LEGENDA, 60],
  ['urs-piscicultura-pr.geojson', pisciculturaEstilo, PISCICULTURA_LEGENDA, 20],
  ['urs-pecuaria-corte-pr.geojson', pecuariaEstilo, PECUARIA_LEGENDA, 60],
];

test('camadas: categoria Programas IDR, arquivos do bucket privado e token no share link', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-urs-graos', 'datageo-urs-cafe', 'datageo-urs-piscicultura', 'datageo-urs-pecuaria-corte',
  ]);
  for (const l of layers) {
    assert.equal(l.category, PROGRAMAS_IDR);
    const token = LAYER_STATE_REGISTRY.find((e) => e.id === l.id)?.token;
    assert.match(token ?? '', /^[a-zA-Z0-9]{2}$/, `${l.id} sem token de 2 caracteres`);
  }
  assert.equal(new Set(layers.map((l) => l.icon)).size, layers.length, 'um ícone por programa');
});

test('grupo dos grãos pelo MIP/MID', () => {
  assert.equal(graosGrupo({ MIP: 'Sim', MID: 'Sim' }), 'mip-mid');
  assert.equal(graosGrupo({ MIP: 'Sim', MID: 'Não' }), 'mip');
  assert.equal(graosGrupo({ MIP: 'Não', MID: 'Sim' }), 'mid');
  assert.equal(graosGrupo({ MIP: 'Não', MID: 'Não' }), 'nenhum');
});

test('coordenada que não confere sai esmaecida e com selo no tooltip', () => {
  const ok = { Produtor: 'João', 'Município': 'Pinhão', 'Checagem da coordenada': 'no município declarado', MIP: 'Sim' };
  const fora = { ...ok, 'Checagem da coordenada': 'FORA do município declarado' };
  assert.equal(coordenadaConferida(ok), true);
  assert.equal(coordenadaConferida({ 'Checagem da coordenada': 'município pelo ponto (planilha sem município)' }), true);
  assert.equal(graosEstilo(ok).alpha, 0.95);
  assert.equal(graosEstilo(fora).alpha, 0.35);
  assert.doesNotMatch(graosTooltip(ok), /Coordenada a conferir/);
  assert.match(graosTooltip(fora), /Coordenada a conferir/);
});

test('produtor desligado: grupo próprio, selo e observação visíveis (UTF-8)', () => {
  const p = {
    Produtor: 'Produtor Exemplo', Programa: 'Programa Purunã', 'Município': 'Bituruna', Regional: 'União da Vitória',
    'Observação': 'Produtor foi desligado do Programa.', 'Checagem da coordenada': 'no município declarado',
  };
  assert.equal(pecuariaEstilo(p).grupo, 'desligado');
  const html = pecuariaTooltip(p);
  assert.match(html, /Desligado/);
  assert.match(html, /Programa Purunã · Bituruna/);
  assert.match(html, /União da Vitória/);
  assert.match(html, /desligado do Programa/);
  assert.equal(pecuariaEstilo({ ...p, 'Observação': '' }).grupo, 'Programa Purunã');
});

for (const [arq, estilo, legenda, minimo] of PONTOS) {
  test(`dado real ${arq}: grupos da legenda, rótulos e UTF-8`, { skip: !existsSync(PRIV(arq)) }, () => {
    const feats = real(arq);
    assert.ok(feats.length >= minimo, `${feats.length} < ${minimo}`);
    const grupos = new Set(legenda.map((g) => g.grupo));
    for (const f of feats) {
      const s = estilo(f.properties);
      assert.ok(grupos.has(s.grupo), `grupo ${s.grupo} fora da legenda`);
      assert.equal(s.labelMaxDist, UR_LABEL_DIST, 'labelDists da camada cobre o teto do estilo');
      assert.ok(s.label, 'todo ponto tem rótulo');
      const [lon, lat] = f.geometry.coordinates;
      assert.ok(lon > -55 && lon < -48 && lat > -27 && lat < -22, `${lon},${lat} fora do PR`);
      assert.ok(f.properties['Município'] && f.properties['Checagem da coordenada']);
    }
    const texto = readFileSync(PRIV(arq), 'utf8');
    assert.doesNotMatch(texto, /Ã[£§©¡³]|�/, 'mojibake');
  });
}

test('dado real: pecuária com os três programas e acentos', { skip: !existsSync(PRIV('urs-pecuaria-corte-pr.geojson')) }, () => {
  const progs = new Set(real('urs-pecuaria-corte-pr.geojson').map((f) => f.properties.Programa));
  for (const p of ['Programa Purunã', 'Pecuária Moderna', 'Associação Purunã']) assert.ok(progs.has(p), p);
});

test('grupo Programas IDR: ícone próprio por camada e contorno próprio por programa de URs', async () => {
  const { default: energia } = await import('../maplibre/layers/energiaLogistica.js');
  const grupo = [...energia, ...layers].filter((l) => l.category === PROGRAMAS_IDR);
  const icons = grupo.map((l) => l.icon);
  assert.equal(new Set(icons).size, icons.length, `ícones repetidos: ${icons.join(' ')}`);
  const contornos = layers.flatMap((l) => l.layers.filter((s) => s.type === 'circle'))
    .map((s) => `${s.paint['circle-stroke-color']}/${s.paint['circle-stroke-width']}`);
  assert.equal(contornos.length, 4);
  assert.equal(new Set(contornos).size, 4, contornos.join(' '));
});

test('tooltip do município: URs por programa, sem o desligado', async () => {
  const { ursPorMunicipio } = await import('./programasIdr.js');
  const { municipioTooltipHtml, ursTexto } = await import('./municipioTooltip.js');
  const pt = (ibge, extra = {}) => ({ properties: { ibge, ...extra } });
  const por = ursPorMunicipio([
    { features: [pt('4113700'), pt('4113700'), pt('')] },
    { features: [pt('4113700')] },
    null,
    { features: [pt('4102307', { 'Observação': 'Produtor foi desligado do Programa.' }), pt('4102307')] },
  ]);
  assert.deepEqual(por['4113700'], { total: 3, programas: { 'Grãos': 2, 'Café': 1 } });
  assert.deepEqual(por['4102307'], { total: 1, programas: { 'Pecuária de Corte': 1 } });
  assert.equal(ursTexto(por['4113700']), '3 (Grãos 2 · Café 1)');
  assert.equal(ursTexto(undefined), '');
  assert.match(municipioTooltipHtml('Londrina', null, null, false, null, por['4113700']),
    /<dt>URs dos programas \(IDR\)<\/dt><dd[^>]*>3 \(Grãos 2 · Café 1\)<\/dd>/);
  assert.doesNotMatch(municipioTooltipHtml('Curitiba', null, null, false, null, undefined), /URs dos programas/);
});

test('dado real: soma das URs por município bate com os pontos ativos', { skip: !PONTOS.every(([a]) => existsSync(PRIV(a))) }, async () => {
  const { ursPorMunicipio } = await import('./programasIdr.js');
  const colecoes = PONTOS.map(([a]) => ({ features: real(a) }));
  const ativos = colecoes.flatMap((c) => c.features)
    .filter((f) => f.properties.ibge && !/desligad/i.test(f.properties['Observação'] ?? '')).length;
  const por = ursPorMunicipio(colecoes);
  assert.equal(Object.values(por).reduce((a, m) => a + m.total, 0), ativos);
  assert.ok(ativos >= 340, `só ${ativos} URs ativas`);
});
