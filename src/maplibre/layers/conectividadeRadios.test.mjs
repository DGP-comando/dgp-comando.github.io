import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import layers, {
  aneisFc, buildTorres, circuloGraus, classeDaTorre, conectividadeInfo, conectividadeLegend, radiosFc, radiosTooltip,
  stationCount, torreTooltip,
} from './conectividadeRadios.js';
import { dotSize, flattenStations, nextLiveIndex } from '../../data/radioPlayer.js';

const torres = JSON.parse(readFileSync(new URL('../../../public/data/conectividade-torres.json', import.meta.url), 'utf8'));

test('exporta as duas camadas na ordem, com os ids do app', () => {
  assert.deepEqual(layers.map((l) => l.id), ['datageo-conectividade', 'datageo-radios']);
  for (const l of layers) assert.equal(l.category, 'Energia e conectividade');
});

// Os valores esperados são os da camada Cesium antiga (datageoConectividade.js,
// removida): geração mais alta da torre e as mesmas cores/rótulos.
test('classe e legenda iguais às do app antigo', () => {
  const esperado = {
    0: ['na', 'SEM INFO', '#52525b'], 1: ['2G', '2G', '#71717a'], 2: ['3G', '3G', '#15803d'],
    3: ['3G', '3G', '#15803d'], 4: ['4G', '4G', '#4ade80'], 7: ['4G', '4G', '#4ade80'],
    8: ['5G', '5G', '#a3e635'], 15: ['5G', '5G', '#a3e635'],
  };
  for (const [mask, [key, label, color]] of Object.entries(esperado)) {
    const c = classeDaTorre(Number(mask));
    assert.deepEqual([c.key, c.label, c.color], [key, label, color], `máscara ${mask}`);
  }
  const counts = { '5G': 3, '4G': 2, na: 1 };
  assert.deepEqual(conectividadeLegend(counts), [
    { label: '5G', color: '#a3e635', count: 3 },
    { label: '4G', color: '#4ade80', count: 2 },
    { label: 'SEM INFO', color: '#52525b', count: 1 },
  ]);
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

test('tooltip da torre: tipCard com operadora, gerações, 📡 e ESTIMADO (qa-torres)', () => {
  const t = { operadora: 'TIM', mask: 15, lat: -25.39, lon: -51.46, vizinhas: ['Vivo', 'Claro'], vintage: '2024-01', municipio: 'Guarapuava' };
  const tip = torreTooltip(t);
  assert.match(tip, /class="tt"/);
  assert.match(tip, /tt-icon">📡</);
  assert.match(tip, /tt-title">TIM</);
  assert.match(tip, /tt-badge tt-ok">5G</);
  assert.match(tip, /Guarapuava - PR/);
  assert.match(tip, /5G · 4G · 3G · 2G/);
  assert.match(tip, /Vivo, Claro/);
  assert.match(tip, /2G 15 km/);
  assert.match(tip, /5G 1,5 km/);
  assert.match(tip, /-25,39000°, -51,46000°/);
  assert.match(tip, /ESTIMADO/);
  assert.match(tip, /levantamento 01\/2024/);
  assert.doesNotMatch(tip, /dgx-vt|vt-nome/);
  const so2g = torreTooltip({ ...t, mask: 1, vizinhas: [] });
  assert.match(so2g, /tt-badge tt-warn">2G</);
  assert.match(so2g, /sem dados móveis/);
  assert.doesNotMatch(so2g, /Mesma estrutura/);
  assert.match(torreTooltip({ ...t, mask: 0 }), /SEM INFO[\s\S]*sem tecnologia declarada/);
  // Ligado de verdade à camada: índice da feição -> props do closure.
  const b = buildTorres(torres);
  const layer = layers[0];
  assert.equal(layer.interactive[0], 'dg-conect-torres');
  assert.equal(torreTooltip(b.props[0]).includes(b.props[0].operadora), true);
});

test('tooltip das rádios: contagem, emissoras com contato e nota do player', () => {
  const place = {
    ibge: '4106902', nome: 'Curitiba',
    stations: [
      { name: 'Rádio A', url: 'https://a', freq: 'FM 98,1', telefone: '(41) 3333-1111', whatsapp: '41999998888', endereco: 'Rua X, 1', email: 'a@r.com' },
      { name: 'Comunitária B', freq: 'FM 87,9', comunitaria: true, entidade: 'Associação B' },
      { name: 'C', freq: 'AM 1000' }, { name: 'D', freq: 'FM 90' }, { name: 'E & F', freq: 'FM 91' }, { name: 'G', freq: 'FM 92' },
    ],
  };
  const tip = radiosTooltip(place);
  assert.match(tip, /tt-icon">📻</);
  assert.match(tip, /tt-title">Curitiba</);
  assert.match(tip, /6 emissoras · IBGE 4106902/);
  assert.match(tip, /tt-badge tt-ok">1 AO VIVO</);
  assert.match(tip, /tt-sec-title">● Rádio A</);
  assert.match(tip, /FM 98,1/);
  assert.match(tip, /\(41\) 3333-1111/);
  assert.match(tip, /\(41\) 99999-8888/);
  assert.match(tip, /a@r\.com/);
  assert.match(tip, /Rua X, 1/);
  assert.match(tip, /○ Comunitária B/);
  assert.match(tip, /FM 87,9 · comunitária/);
  assert.match(tip, /Associação B/);
  assert.doesNotMatch(tip, /E &amp; F|>G</, 'só as 4 primeiras');
  assert.match(tip, /\+2 no player/);
  assert.match(tip, /Clique para abrir o player e ouvir/);
  const dial = radiosTooltip({ ibge: 1, nome: 'X', stations: [{ name: 'Y', freq: 'FM 1' }] });
  assert.match(dial, /tt-badge tt-muted">SÓ DIAL</);
  assert.match(dial, /1 emissora ·/);
  assert.equal(layers[1].tooltip({ ibge: '0' }), '');
});
