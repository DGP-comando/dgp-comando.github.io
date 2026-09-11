import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS, validateLayerStateRegistry } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const torres = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'data', 'conectividade-torres.json'), 'utf8'),
);
const cobertura = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'data', 'conectividade-sem-cobertura.geojson'), 'utf8'),
);

/**
 * Os dois arquivos sao gerados (scripts/build_conectividade.py) e commitados,
 * entao sao eles que o browser le. O que estas travas protegem: coordenada
 * fora do Parana (um ponto no oceano estraga o enquadramento), mascara de
 * tecnologia corrompida, e a DATA do levantamento, que e o campo mais facil de
 * perder numa regeracao e o mais perigoso de omitir num mapa de cobertura.
 */

test('as torres estao todas dentro do Parana, com coordenada utilizavel', () => {
  assert.ok(torres.torres.length > 5000, `poucas torres: ${torres.torres.length}`);
  for (const [lat, lon] of torres.torres) {
    assert.ok(Number.isFinite(lat) && lat >= -27.5 && lat <= -22.0, `latitude fora do PR: ${lat}`);
    assert.ok(Number.isFinite(lon) && lon >= -55.5 && lon <= -47.5, `longitude fora do PR: ${lon}`);
  }
});

test('a mascara de tecnologia so carrega bits declarados', () => {
  const validos = Object.values(torres.tecBits).reduce((a, b) => a | b, 0);
  assert.equal(validos, 15, '2G|3G|4G|5G');
  for (const [, , operadora, mask] of torres.torres) {
    assert.ok(Number.isInteger(mask) && (mask & ~validos) === 0, `mascara invalida: ${mask}`);
    assert.ok(torres.operadoras[operadora], `operadora ${operadora} nao existe na tabela`);
  }
  // A base tem 5G: se um dia sumir, a geracao mais nova parou de ser importada.
  const com5g = torres.torres.filter(([, , , m]) => m & torres.tecBits['5G']).length;
  assert.ok(com5g > 100, `torres com 5G: ${com5g}`);
});

test('a area sem cobertura e um recorte estadual plausivel, nao o estado inteiro', () => {
  assert.equal(cobertura.type, 'FeatureCollection');
  assert.ok(cobertura.features.length > 100, `poucos poligonos: ${cobertura.features.length}`);
  // O Parana tem 199.307 km2. Uma area sem 3G+ maior que o estado, ou perto de
  // zero, significa que o recorte ou a projecao quebrou na regeracao.
  assert.ok(cobertura.areaKm2 > 20000 && cobertura.areaKm2 < 199307,
    `area sem cobertura implausivel: ${cobertura.areaKm2} km2`);
  // Coordenadas em WGS84 e dentro do PR.
  const [primeiro] = cobertura.features;
  const flat = JSON.stringify(primeiro.geometry.coordinates).match(/-?\d+\.\d+/g).map(Number);
  const lons = flat.filter((_, i) => i % 2 === 0);
  const lats = flat.filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...lons) >= -55.5 && Math.max(...lons) <= -47.5, 'longitudes fora do PR');
  assert.ok(Math.min(...lats) >= -27.5 && Math.max(...lats) <= -22.0, 'latitudes fora do PR');
});

test('os dois arquivos declaram a data do levantamento', () => {
  // Um mapa de cobertura sem vintage e a informacao mais facil de ler errado
  // desta camada — o painel mostra essa data justamente por isso.
  assert.match(torres.geradoDe, /^\d{4}-\d{2}$/);
  assert.match(cobertura.geradoDe, /^\d{4}-\d{2}$/);
  assert.equal(torres.geradoDe, cobertura.geradoDe, 'as duas metades vem do mesmo levantamento');
  assert.match(torres.fonte, /ANATEL/);
  assert.match(cobertura.fonte, /ANATEL/);
});

test('a camada esta registrada com token proprio e o registro segue valido', () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.ok(REGISTERED_LAYER_IDS.includes('datageo-conectividade'));
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-conectividade');
  assert.equal(entry.token, 'D');
  assert.equal(entry.disposition, 'enabled-only');
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'token repetido quebra o share link');
});

test('a escala de cor das torres nao invade o ciano nem o violeta de outras camadas', async () => {
  // Ciano e dos municipios e do vento; violeta/fucsia e da precipitacao. A
  // familia verde/lima existe para esta camada poder ser lida sobre as outras.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'data', 'datageoConectividade.js'), 'utf8');
  const cores = [...src.matchAll(/color: '(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
  assert.ok(cores.length >= 5, 'a escala precisa ter as quatro geracoes mais o indefinido');
  for (const hex of cores) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!(b > 150 && g > 140 && r < g - 40), `${hex} caiu na familia ciano`);
    assert.ok(!(r > 120 && b > 140 && g < r - 30), `${hex} caiu na familia violeta`);
  }
});
