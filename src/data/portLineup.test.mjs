import test from 'node:test';
import assert from 'node:assert/strict';
import { LINEUP_MAX_AGE_MS, lineupEntityRows, lineupSummary, validLineup } from './portLineup.js';

const now = Date.parse('2026-09-13T22:30:00Z');

function payload(overrides = {}) {
  return {
    version: 1,
    fetched_at: new Date(now - 10 * 60_000).toISOString(),
    counts: { atracados: 16, ao_largo: 31, ao_largo_reatracacao: 0, programados: 16, esperados: 134 },
    navios: [
      {
        secao: 'atracados', programacao: '78891', embarcacao: 'MAERSK LINS', berco: '216', imo: '9527025',
        loa_m: 299.9, sentido: 'Imp/Exp', operadores: ['TCP (SCS)'], mercadorias: ['CONTÊINERES (CONTENTORES) INCL'],
        atracacao: '2026-09-13T08:50:00-03:00',
        posicao: { lat: -25.50046, lon: -48.4985, tipo: 'berco', local: 'Berço 216 · Cais comercial de Paranaguá' },
      },
      {
        secao: 'ao_largo', programacao: '80499', embarcacao: 'TRIDENT STAR', berco: '213', operadores: [], mercadorias: [],
        chegada: '2026-09-12T00:01:00-03:00',
        posicao: { lat: -25.49939, lon: -48.46363, tipo: 'fundeio', local: 'Área de fundeio 5 (posição ilustrativa)' },
      },
      { secao: 'atracados', programacao: 'x', embarcacao: 'SEM POSICAO', posicao: { lat: null, lon: null } },
    ],
    ...overrides,
  };
}

test('validLineup aceita payload recente e rejeita versão, formato ou idade', () => {
  assert.ok(validLineup(payload(), now));
  assert.equal(validLineup(null, now), null);
  assert.equal(validLineup(payload({ version: 2 }), now), null);
  assert.equal(validLineup(payload({ navios: 'x' }), now), null);
  assert.equal(validLineup(payload({ fetched_at: new Date(now - LINEUP_MAX_AGE_MS - 1).toISOString() }), now), null);
});

test('lineupEntityRows: atracado no berço, fundeio marcado como ilustrativo, sem posição descartado', () => {
  const rows = lineupEntityRows(payload());
  assert.equal(rows.length, 2);
  const [lins, trident] = rows;
  assert.equal(lins.id, 'appa:78891');
  assert.equal(lins.kind, 'berco');
  assert.equal(lins.label, 'MAERSK LINS\nBerço 216 · CONTÊINERES (CONTENTORES) INCL');
  assert.equal(lins.props.quando, 'atracou 13/09 08:50');
  assert.equal(lins.props.operadores, 'TCP (SCS)');
  assert.equal(trident.kind, 'fundeio');
  assert.match(trident.label, /ao largo · aguarda berço 213 · posição ilustrativa/);
  assert.equal(trident.props.quando, 'chegou 12/09 00:01');
  assert.notEqual(lins.labelAbove, trident.labelAbove, 'vizinhos alternam o lado do rótulo');
});

test('lineupSummary conta atracados, ao largo e programados', () => {
  assert.equal(lineupSummary(payload()), '16 atracados · 31 ao largo · 16 programados');
  assert.equal(lineupSummary({ counts: { atracados: 1 } }), '1 atracado');
  assert.equal(lineupSummary(null), '');
});
