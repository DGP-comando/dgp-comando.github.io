import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import layers, {
  aneisFc, buildTorres, circuloGraus, classeDaTorre, conectividadeInfo, conectividadeLegend, radiosFc, stationCount,
} from './conectividadeRadios.js';
import { classeDaTorre as classeApp, conectividadeLegend as legendApp } from '../../data/datageoConectividade.js';
import { dotSize, flattenStations, nextLiveIndex } from '../../data/radioPlayer.js';

const torres = JSON.parse(readFileSync(new URL('../../../public/data/conectividade-torres.json', import.meta.url), 'utf8'));

test('exporta as duas camadas na ordem, com os ids do app', () => {
  assert.deepEqual(layers.map((l) => l.id), ['datageo-conectividade', 'datageo-radios']);
  for (const l of layers) assert.equal(l.category, 'Infraestrutura');
});

test('classe e legenda iguais às do app Cesium', () => {
  for (const mask of [0, 1, 2, 3, 4, 7, 8, 15]) assert.deepEqual(classeDaTorre(mask), classeApp(mask));
  const counts = { '5G': 3, '4G': 2, na: 1 };
  assert.deepEqual(conectividadeLegend(counts), legendApp(counts));
});

test('buildTorres: uma feição por torre, vizinhas e município', () => {
  const b = buildTorres(torres);
  assert.equal(b.fc.features.length, torres.torres.length);
  assert.equal(b.props.length, torres.torres.length);
  assert.equal(b.vintage, torres.geradoDe);
  assert.equal(b.legend.reduce((s, l) => s + l.count, 0), torres.torres.length);
  const f = b.fc.features[0];
  assert.equal(f.id, 0);
  assert.ok(b.props[0].municipio);
  assert.ok(b.props.some((p) => p.vizinhas.length > 0), 'nenhuma estrutura compartilhada');
  for (const p of b.props) assert.ok(!p.vizinhas.includes(p.operadora));
});

test('anéis: fechados, do maior para o menor, raio certo', () => {
  const ring = circuloGraus(-25, -50, 10);
  assert.deepEqual(ring[0].map((v) => v.toFixed(9)), ring.at(-1).map((v) => v.toFixed(9)));
  assert.ok(Math.abs(ring[0][0] - (-50) - 10 / (111.32 * Math.cos((25 * Math.PI) / 180))) < 1e-9);
  const a = aneisFc({ lat: -25, lon: -50, mask: 15 });
  assert.deepEqual(a.features.map((f) => f.properties.tec), ['2G', '4G', '3G', '5G']);
  assert.equal(aneisFc(null).features.length, 0);
});

test('info da linha: área e data do levantamento', () => {
  assert.equal(conectividadeInfo(132692.4, '2024-01'), `${(132692).toLocaleString('pt-BR')} km² sem 3G+ · levantamento 2024-01`);
  assert.equal(conectividadeInfo(null, null), '');
});

test('rádios: ponto por município, tamanho e estado ao vivo', () => {
  const places = [
    { ibge: '4106902', nome: 'Curitiba', stations: [{ id: 'a', url: 'https://x' }, { id: 'b', freq: '98,1' }] },
    { ibge: 4113700, nome: 'Londrina', stations: [{ id: 'c', freq: '101' }] },
    { ibge: '9999999', nome: 'Fora', stations: [{ id: 'd' }] },
  ];
  const g = radiosFc(places);
  assert.equal(g.features.length, 2);
  assert.deepEqual(g.features[0].properties, { ibge: '4106902', size: dotSize(2), live: true });
  assert.equal(g.features[1].properties.ibge, '4113700');
  assert.equal(g.features[1].properties.live, false);
  assert.equal(stationCount(places), 4);
  const entries = flattenStations(places);
  assert.equal(nextLiveIndex(entries, 0, 1), 0);
});
