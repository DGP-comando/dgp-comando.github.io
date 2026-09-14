import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatDataHora, formatNumero, progressoOperacao, vesselTooltipHtml } from './vesselTooltip.js';

const atracado = {
  fonte: 'APPA line-up', kind: 'berco', secao: 'atracados', embarcacao: 'MAERSK MALAGA', berco: '141',
  local: 'Berço 141 · Píer de inflamáveis (Paranaguá)', imo: '9447768', loaM: 183.31, dwtT: 51544,
  mercadorias: 'FUEL-OIL (OLEO COMBUSTIVEL)', sentido: 'Exp', operadores: 'PETROBRAS TRANSPORTE S.A - TRANSPETRO',
  agencia: 'LACHMANN', atracacao: '2026-09-13T13:00:00-03:00', janelaFim: '2026-09-15T06:36:00-03:00',
  previsto: 26000, realizado: 5555, unidade: 'tons', emitidoEm: '2026-09-13T20:42:00-03:00',
};

test('formatações pt-BR', () => {
  assert.equal(formatDataHora('2026-09-13T13:00:00-03:00'), '13/09 13:00');
  assert.equal(formatDataHora('lixo'), '');
  assert.equal(formatNumero(51544), '51.544');
  assert.equal(formatNumero(183.31, 1), '183,3');
  assert.equal(formatNumero(null), '');
  assert.equal(progressoOperacao(26000, 5555, 'tons'), '5.555 / 26.000 t (21%)');
  assert.equal(progressoOperacao(600, 0, 'movs'), '0 / 600 movs (0%)');
  assert.equal(progressoOperacao(0, 0, 'tons'), '');
  assert.equal(progressoOperacao(null, null, 'tons'), '');
});

test('tooltip de navio atracado traz berço, ficha, carga, operação e fonte', () => {
  const html = vesselTooltipHtml(atracado);
  assert.match(html, /<div class="vt-nome">MAERSK MALAGA<\/div>/);
  assert.match(html, /Atracado · Berço 141 · Píer de inflamáveis \(Paranaguá\)/);
  assert.match(html, /IMO 9447768 · LOA 183,3 m · DWT 51\.544 t/);
  assert.match(html, /Carga:<\/span> FUEL-OIL/);
  assert.match(html, /Operador:<\/span> PETROBRAS TRANSPORTE S\.A - TRANSPETRO/);
  assert.match(html, /Atracação:<\/span> 13\/09 13:00/);
  assert.match(html, /Previsão de término:<\/span> 15\/09 06:36/);
  assert.match(html, /Operação:<\/span> 5\.555 \/ 26\.000 t \(21%\)/);
  assert.match(html, /Line-up APPA · emitido 13\/09 20:42<br\/>posição aproximada do berço/);
  assert.doesNotMatch(html, /<br\/><br\/>/, 'linhas vazias não viram quebras duplas');
});

test('tooltip de navio ao largo diz que a posição é ilustrativa', () => {
  const html = vesselTooltipHtml({
    fonte: 'APPA line-up', kind: 'fundeio', secao: 'ao_largo', embarcacao: 'TRIDENT STAR', berco: '213',
    local: 'Área de fundeio 5 (posição ilustrativa)', chegada: '2026-09-12T00:01:00-03:00', eta: null,
  });
  assert.match(html, /Ao largo · aguarda berço 213/);
  assert.match(html, /Chegada:<\/span> 12\/09 00:01/);
  assert.doesNotMatch(html, /ETA:/);
  assert.match(html, /Área de fundeio 5 \(posição ilustrativa\)/);
});

test('tooltip AIS', () => {
  const html = vesselTooltipHtml({ mmsi: 710000001, vesselName: 'SÃO JOSÉ', shipType: 'Cargo', sog: 12.3, destination: 'PARANAGUA', observedAt: '2026-09-13T12:00:00Z' });
  assert.match(html, /SÃO JOSÉ/);
  assert.match(html, /Velocidade:<\/span> 12,3 nós/);
  assert.match(html, /AISStream/);
});

test('texto externo é escapado (sem injeção de HTML)', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)> & "a"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;a&quot;');
  const html = vesselTooltipHtml({ ...atracado, embarcacao: '<script>alert(1)</script>', operadores: '"><b>x</b>' });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(vesselTooltipHtml(null), '');
});
