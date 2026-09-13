import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHeuristicBriefing, countBy, municipioName } from './briefingHeuristic.js';

const NOW = new Date('2026-09-13T17:32:00Z'); // 14:32 BRT

test('municipioName canonicalizes accents from code or free-text name', () => {
  assert.equal(municipioName({ ibge_code: '4109401' }), 'Guarapuava');
  assert.equal(municipioName({ municipality: 'SAO JOSE DOS PINHAIS' }), 'São José dos Pinhais');
  assert.equal(municipioName({ municipality_name: 'Foz do Iguacu' }), 'Foz do Iguaçu');
  assert.equal(municipioName({ municipality: 'Lugar Nenhum' }), 'Lugar Nenhum');
  assert.equal(municipioName(null), '');
});

test('countBy sorts by count desc then name', () => {
  assert.deepEqual(countBy([{ n: 'b' }, { n: 'a' }, { n: 'b' }, { n: '' }], (r) => r.n), [['b', 2], ['a', 1]]);
});

test('full briefing reports IRTC, CEMADEN, fires, incidents and dengue in pt-BR', () => {
  const irtc = [
    ...Array.from({ length: 10 }, (_, i) => ({ ibge_code: String(4100103 + i), risk_level: 'alto', irtc_score: 60 + i })),
    { ibge_code: '4106902', municipality: 'Curitiba', risk_level: 'crítico', irtc_score: 88 },
    { ibge_code: '4109401', municipality: 'Guarapuava', risk_level: 'critico', irtc_score: 81 },
    { ibge_code: '4113700', risk_level: 'baixo', irtc_score: 10 },
  ];
  const cemaden = [
    { alert_code: 'a', ibge_code: '4106902', municipality: 'Curitiba', severity: 'alerta' },
    { alert_code: 'b', ibge_code: '4106902', municipality: 'Curitiba', severity: 'atencao' },
    { alert_code: 'c', ibge_code: '4109401', municipality: 'Guarapuava', severity: 'observacao' },
  ];
  const fires = {
    fires: [
      ...Array.from({ length: 150 }, () => ({ municipality: 'Guarapuava' })),
      ...Array.from({ length: 34 }, () => ({ municipality: 'Palmas' })),
    ],
  };
  const incidents = [
    { id: 1, title: 'Enchente no Iguaçu', severity: 'critical' },
    { id: 2, title: 'Queimada', severity: 'medium' },
  ];
  const dengue = { year: 2026, week: 36, rows: [
    { ibge_code: '4104808', cases: 120, alert_level: 3 },
    { ibge_code: '4115200', cases: 300, alert_level: 4 },
    { ibge_code: '4106902', cases: 5.4, alert_level: 1 },
  ] };

  const b = buildHeuristicBriefing({ irtc, cemaden, fires, incidents, dengue, now: NOW });
  assert.equal(b.title, 'BRIEFING AUTOMÁTICO · 13/09 14:32');
  assert.equal(b.level, 'elevado');
  assert.match(b.summary, /relatório situacional de hoje ainda não foi publicado/);
  assert.ok(b.bullets.includes('12 municípios com IRTC alto (2 críticos), maior índice em Curitiba (88)'), b.bullets.join('\n'));
  assert.ok(b.bullets.includes('3 alertas CEMADEN ativos (2 em Curitiba)'));
  assert.ok(b.bullets.includes('184 focos de calor nas últimas 48 h, maior concentração em Guarapuava (150)'));
  assert.ok(b.bullets.includes('2 incidentes ativos (1 crítico); mais recente: Enchente no Iguaçu'));
  assert.ok(b.bullets.includes('Dengue SE 36/2026: 2 municípios em alerta nível 3+ (1 em nível 4), 425 casos no estado'));
  assert.equal(b.bullets.length, 5);
  assert.match(b.bullets[0], /IRTC|incidentes/, 'heaviest signals come first');
});

test('fires accept a bare array and singular phrasing', () => {
  const b = buildHeuristicBriefing({
    fires: [{ municipality: 'GUARAPUAVA' }],
    cemaden: [{ ibge_code: '4106902', severity: 'alerta_maximo' }],
    now: NOW,
  });
  assert.ok(b.bullets.includes('1 foco de calor nas últimas 48 h, maior concentração em Guarapuava (1)'));
  assert.ok(b.bullets.includes('1 alerta CEMADEN ativo em Curitiba, 1 de alerta máximo'));
  assert.equal(b.level, 'elevado');
});

test('empty arrays produce calm bullets and normal level', () => {
  const b = buildHeuristicBriefing({ irtc: [{ risk_level: 'baixo' }], cemaden: [], fires: { fires: [] }, incidents: [], now: NOW });
  assert.equal(b.level, 'normal');
  assert.deepEqual(b.bullets, [
    'Nenhum município com IRTC alto ou crítico',
    'Nenhum alerta CEMADEN ativo',
    'Nenhum foco de calor nas últimas 48 h',
    'Nenhum incidente ativo',
  ]);
});

test('missing or errored inputs are skipped gracefully', () => {
  const none = buildHeuristicBriefing();
  assert.deepEqual(none.bullets, []);
  assert.equal(none.level, 'indisponivel');
  assert.match(none.summary, /Sem dados disponíveis/);

  const partial = buildHeuristicBriefing({
    irtc: { error: 'timeout' }, cemaden: null, fires: undefined, incidents: 'x',
    dengue: { year: null, week: null, rows: [] }, now: 'invalid',
  });
  assert.deepEqual(partial.bullets, []);
  assert.equal(partial.title, 'BRIEFING AUTOMÁTICO');
});
