import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMADAS_PRIVADAS } from '../../data/acessoExterno.js';
import { pointFeatures } from './energiaLogistica.js';
import camadas, { armadilhaTooltip, coletorTooltip, pulverizacaoTooltip } from './manejo.js';

test('toda camada Manejo é privada: usuário externo não recebe', () => {
  assert.equal(camadas.length, 5);
  for (const c of camadas) assert.ok(CAMADAS_PRIVADAS.has(c.id), c.id);
});

test('tooltip mantém acentos e escapa HTML vindo da fonte', () => {
  const html = coletorTooltip({ produtor: 'João <b>Conceição</b>', municipio: 'São Mateus do Sul', primeiro_esporo: '2026-11-01' });
  assert.ok(html.includes('São Mateus do Sul'));
  assert.ok(html.includes('Conceição'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('Esporo detectado'));
});

test('tooltips aceitam feição sem as listas opcionais', () => {
  assert.ok(armadilhaTooltip({ produtor: 'A' }).includes('A'));
  assert.ok(pulverizacaoTooltip({ produtor: 'B', registros: [{ data_aplicacao: '2026-11-01', produto_comercial: 'X', alvo: 'Ferrugem' }] }).includes('Ferrugem'));
});

test('sem rótulo no mapa: nome do produtor só aparece no tooltip', () => {
  const gj = { features: [{ geometry: { coordinates: [-51.5, -24.5] }, properties: { produtor: 'Fulano', primeiro_esporo: 'x' } }] };
  const coletor = camadas.find((c) => c.id === 'datageo-manejo-coletores');
  assert.ok(coletor);
  const { features, counts } = pointFeatures(gj, (p) => ({ grupo: p.primeiro_esporo ? 'com' : 'sem', size: 8, color: '#ef4444' }));
  assert.equal(features[0].properties.__label, '');
  assert.deepEqual(counts, { com: 1 });
});
