// node --test src/data/programasIdr.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  CAFE_LEGENDA, GRAOS_LEGENDA, PECUARIA_LEGENDA, PISCICULTURA_LEGENDA, UR_LABEL_DIST, USO_SOLO_CLASSES,
  cafeEstilo, coordenadaConferida, graosEstilo, graosGrupo, graosTooltip, pecuariaEstilo, pecuariaTooltip,
  pisciculturaEstilo, usoSoloCor, usoSoloTooltip,
} from './programasIdrEstilos.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import layers, { PROGRAMAS_IDR, usoSoloFeatures } from '../maplibre/layers/programasIdr.js';

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
    'datageo-usosolo-queijarias',
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

test('uso do solo: cor por classe, legenda com ha e tooltip com o imóvel do CAR', () => {
  const gj = {
    features: [
      { properties: { Classe: 'Floresta Nativa', 'Área (ha)': 2.5 }, geometry: { type: 'Polygon', coordinates: [] } },
      { properties: { Classe: 'Floresta Nativa', 'Área (ha)': 1 }, geometry: { type: 'Polygon', coordinates: [] } },
      { properties: { Classe: 'Mangue', 'Área (ha)': 1 }, geometry: { type: 'Polygon', coordinates: [] } },
      { properties: { Classe: 'Pastagem/Campo' }, geometry: null },
    ],
  };
  const { features, props, legend } = usoSoloFeatures(gj);
  assert.equal(features.length, 3);
  assert.equal(props.length, 3);
  assert.equal(features[0].properties.__color, usoSoloCor({ Classe: 'Floresta Nativa' }));
  assert.deepEqual(legend.map((l) => [l.label, l.count]), [['Floresta Nativa · 3,5 ha', 2], ['Mangue · 1,0 ha', 1]]);
  const html = usoSoloTooltip({
    Classe: 'Corpos d’Água', 'Área (ha)': 0.36, 'Município': 'Pinhão', 'Imóvel CAR': 'PR-4119301-X', 'Módulos fiscais': 0.36,
  });
  assert.match(html, /Corpos d’Água/);
  assert.match(html, /Pinhão/);
  assert.match(html, /PR-4119301-X/);
  assert.match(html, /0,36 ha/);
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

test('dado real: uso do solo das queijarias com classes conhecidas', { skip: !existsSync(PRIV('usodosolo-queijarias-pr.geojson')) }, () => {
  const feats = real('usodosolo-queijarias-pr.geojson');
  assert.ok(feats.length >= 100);
  const conhecidas = new Set(USO_SOLO_CLASSES.map((c) => c.classe));
  for (const f of feats) {
    assert.ok(conhecidas.has(f.properties.Classe), f.properties.Classe);
    assert.match(f.properties['Imóvel CAR'], /^PR-\d{7}-/);
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  }
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
