import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { centroidByIbge } from './prCentroids.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { datageoRadiosLayer, dotSize, flattenStations, nextLiveIndex } from './datageoRadios.js';
import { contactLines, isLive, placeTooltipHtml, whatsappNumber } from './radioContact.js';

const data = JSON.parse(readFileSync(new URL('../../public/data/radios-pr.json', import.meta.url), 'utf8'));
const stations = flattenStations(data.places).map((e) => e.station);

test('todo lugar é um município do PR com ao menos uma estação', () => {
  assert.ok(data.places.length > 0);
  for (const place of data.places) {
    assert.ok(centroidByIbge(place.ibge), `${place.ibge} não é município do PR`);
    assert.ok(place.stations.length > 0, `${place.nome} sem estações`);
  }
});

test('estação ou toca em HTTPS ou tem frequência para ser achada no dial', () => {
  for (const s of stations) {
    if (s.url) assert.match(s.url, /^https:\/\//, `${s.name} tem stream que o Pages não toca`);
    else assert.ok(s.freq, `${s.name} não toca nem tem frequência`);
  }
  assert.equal(new Set(stations.map((s) => s.id)).size, stations.length, 'id repetido');
  const urls = stations.filter((s) => s.url).map((s) => s.url);
  assert.equal(new Set(urls).size, urls.length, 'stream duplicado');
});

test('toda comunitária outorgada tem entidade e frequência', () => {
  const radcom = stations.filter((s) => s.comunitaria);
  assert.ok(radcom.length >= 280, `só ${radcom.length} comunitárias`);
  for (const s of radcom) assert.ok(s.entidade && s.freq, s.id);
});

test('as setas pulam as estações só no dial e dão a volta', () => {
  const e = (url) => ({ station: { url } });
  const entries = [e('https://a'), e(''), e('http://b'), e('https://c')];
  assert.equal(nextLiveIndex(entries, 0, 1), 3);
  assert.equal(nextLiveIndex(entries, 3, 1), 0);
  assert.equal(nextLiveIndex(entries, 0, -1), 3);
  assert.equal(nextLiveIndex([e('')], 0, 1), -1);
});

test('contato: WhatsApp normalizado, link de mapa e nada de protocolo estranho', () => {
  assert.equal(whatsappNumber('(44) 99999-8888'), '5544999998888');
  assert.equal(whatsappNumber('5500000000000'), '');
  const lines = contactLines({ endereco: 'Rua A, 10', telefone: '(43) 3232-1111', site: 'javascript:alert(1)' }, 'Abatiá');
  assert.deepEqual(lines.map((l) => l.kind), ['endereco', 'telefone']);
  assert.match(lines[0].href, /^https:\/\/www\.google\.com\/maps\/search\/.*Abati/);
});

test('tooltip escapa texto externo e mostra a entidade quando falta contato', () => {
  const html = placeTooltipHtml({ nome: 'X', stations: [{ name: '<b>R</b>', freq: '87,9 FM', entidade: 'Assoc. Y' }] });
  assert.ok(!html.includes('<b>R</b>'));
  assert.match(html, /Assoc\. Y/);
  assert.match(html, /1 só no dial/);
  assert.ok(!isLive({ url: 'http://x' }));
});

test('o ponto cresce com a contagem, mas devagar', () => {
  assert.ok(dotSize(4) > dotSize(1));
  assert.ok(dotSize(4) - dotSize(1) < 4 * (dotSize(2) - dotSize(1)));
});

test('a camada está registrada no link compartilhável', () => {
  assert.equal(datageoRadiosLayer.id, 'datageo-radios');
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-radios');
  assert.ok(entry, 'datageo-radios fora do LAYER_STATE_REGISTRY');
  assert.equal(entry.disposition, 'enabled-only');
});
