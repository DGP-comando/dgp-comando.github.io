import assert from 'node:assert/strict';
import test from 'node:test';
import { fmtAgo, fmtDate, fmtDateTime, fmtInt, fmtNum, fmtPct, tipCard } from './tooltipCard.js';

test('tipCard escapa texto, some com linhas vazias e marca tons', () => {
  const html = tipCard({
    icon: '🌡️',
    title: '<Curitiba>',
    subtitle: 'A807',
    badge: { text: 'ALERTA', tone: 'alert' },
    rows: [['Temp', '23,4 °C'], ['Vazio', ''], ['Nulo', null], ['NaN', NaN], ['Travessão', '—'], ['Rajada', '42 km/h', 'warn'], ['Html', { html: '<b>x</b>' }]],
    source: 'INMET',
  });
  assert.match(html, /tt-title">&lt;Curitiba&gt;</);
  assert.match(html, /tt-badge tt-alert">ALERTA</);
  assert.doesNotMatch(html, /Vazio|Nulo|NaN|Travessão/);
  assert.match(html, /<dt>Rajada<\/dt><dd class="tt-warn">42 km\/h<\/dd>/);
  assert.match(html, /<dd class=""><b>x<\/b><\/dd>/);
  assert.match(html, /tt-foot">INMET</);
});

test('seções sem linhas somem; rodapé junta fonte e atualização', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const html = tipCard({ title: 'T', sections: [{ title: 'Nada', rows: [['a', '']] }, { title: 'S', rows: [['b', 1]] }], source: 'F', updated: now - 5 * 60_000, now });
  assert.doesNotMatch(html, /Nada/);
  assert.match(html, /tt-sec-title">S</);
  assert.match(html, /tt-foot">F · atualizado há 5 min</);
});

test('formatação pt-BR', () => {
  assert.equal(fmtNum(1234.56, 1), '1.234,6');
  assert.equal(fmtNum('x'), '');
  assert.equal(fmtNum(null), '');
  assert.equal(fmtInt(1500, 'ha'), '1.500 ha');
  assert.equal(fmtPct(0.123), '12,3%');
  assert.equal(fmtPct(12.3, 1, true), '12,3%');
  assert.equal(fmtDate('2026-09-27'), '27/09/2026');
  assert.equal(fmtDateTime('2026-09-27T10:05:00Z'), '27/09/2026 07:05');
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(fmtAgo(now - 30_000, now), 'agora');
  assert.equal(fmtAgo(now - 3 * 3600_000, now), 'há 3 h');
  assert.equal(fmtAgo(now - 86_400_000, now), 'há 1 dia');
  assert.equal(fmtAgo('2026-01-02T15:00:00Z', now), 'em 02/01/2026');
  assert.equal(fmtAgo(null, now), '');
});
