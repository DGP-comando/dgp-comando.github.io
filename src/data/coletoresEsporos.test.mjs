import assert from 'node:assert/strict';
import test from 'node:test';
import { coletoresPorMunicipio, resumoColetores } from './coletoresEsporos.js';
import { coletoresTexto, municipioTooltipHtml } from './municipioTooltip.js';

const ponto = (ibge, primeiro_esporo) => ({ properties: { ibge, primeiro_esporo } });
const POR = coletoresPorMunicipio({
  features: [ponto('4125209', '2026-11-01'), ponto('4125209'), ponto('4113700', '2026-11-02'), ponto(undefined, 'x')],
});

test('conta coletores e os com esporo por IBGE; ponto sem IBGE fica de fora', () => {
  assert.deepEqual(POR, { 4125209: { total: 2, comEsporo: 1 }, 4113700: { total: 1, comEsporo: 1 } });
});

test('ficha soma os municípios do recorte: zeros sem coletor, null sem acesso', () => {
  assert.deepEqual(resumoColetores(POR, ['4125209', 4113700, '4106902']), { total: 3, comEsporo: 2 });
  assert.deepEqual(resumoColetores(POR, ['4106902']), { total: 0, comEsporo: 0 });
  assert.equal(resumoColetores(null, ['4125209']), null);
});

test('card mostra total e com esporo, e some sem coletor', () => {
  assert.equal(coletoresTexto({ total: 3, comEsporo: 1 }), '3 (1 com esporo)');
  assert.equal(coletoresTexto({ total: 2, comEsporo: 0 }), '2 (0 com esporo)');
  const html = municipioTooltipHtml('São João do Ivaí', null, null, false, null, null, { total: 3, comEsporo: 1 });
  assert.match(html, /Coletores de esporos/);
  assert.match(html, /3 \(1 com esporo\)/);
  assert.match(html, /São João do Ivaí/);
  assert.doesNotMatch(municipioTooltipHtml('Curitiba', null, null, false, null, null, undefined), /Coletores de esporos/);
});
