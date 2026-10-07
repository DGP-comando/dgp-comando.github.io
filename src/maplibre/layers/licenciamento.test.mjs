import test from 'node:test';
import assert from 'node:assert/strict';
import { LICENCAS, MODOS_LICENCA, licencaProps, licencaTooltipHtml } from './licenciamento.js';
import { camadasExport, classifica } from './iatPontos.js';

const [MODALIDADE, ATIVIDADE] = MODOS_LICENCA;
const mod = (sigla) => classifica(LICENCAS, MODALIDADE, { sigla_modalidade: sigla });
const ativ = (g) => classifica(LICENCAS, ATIVIDADE, { desc_grupo_atividade: g });

test('modalidade pela sigla', () => {
  assert.deepEqual(['LO', 'RLO', 'LO-A', 'LOR', 'LI-A', 'RLI', 'LP', 'LPI', 'CP', 'LAS', 'RLAS', 'LAC', 'AA', 'AF', 'DLAE', 'DILA', null].map(mod),
    ['oper', 'oper', 'oper', 'oper', 'inst', 'inst', 'previa', 'previa', 'previa', 'simp', 'simp', 'simp', 'aut', 'aut', 'disp', 'disp', 'disp']);
});

test('grupo de atividade, inclusive com UTF-8 quebrado do GeoPR', () => {
  assert.equal(ativ('Agropecuária'), 'agro');
  assert.equal(ativ('Aqüicultura'), 'agro');
  assert.equal(ativ('Indústria de madeira'), 'indus');
  assert.equal(ativ('Beneficiamento de minerais não metálicos'), 'minera');
  assert.equal(ativ('Disposição de res�­duos sólidos industriais, urbanos e de serviços de saúde'), 'resid');
  assert.equal(ativ('Empreedimentos comerciais e de serviços'), 'comercio');
  assert.equal(ativ('Obras viárias'), 'imob');
  assert.equal(ativ('Linhas de transmissão'), 'energia');
  assert.equal(ativ('Manejo de Fauna Silvestre'), 'flor');
  assert.equal(ativ(null), 'outro');
});

test('imagens por modalidade e tooltip sem razão social', () => {
  const cs = camadasExport(LICENCAS, MODALIDADE);
  assert.equal(cs.length, MODALIDADE.legenda.length);
  assert.match(cs[0].where, /^\(dt_validade >= CURRENT_DATE\) AND \(sigla_modalidade LIKE 'LO%'/);
  const p = licencaProps({ sigla_modalidade: 'LO', desc_modalidade: 'Licença de Operação', desc_atividade: 'Suinocultura',
    nome_razao_social: 'FULANO', dt_validade: 1893456000000 });
  assert.ok(!JSON.stringify(p).includes('FULANO'));
  assert.match(licencaTooltipHtml(p), /Suinocultura/);
});

test('legenda: modalidade escondida sai das imagens e o resto a exclui', () => {
  const cs = camadasExport(LICENCAS, MODALIDADE, new Set(['oper']));
  assert.equal(cs.length, MODALIDADE.legenda.length - 1);
  assert.ok(!cs.some((c) => c.color === MODALIDADE.legenda[0].color));
  assert.ok(cs.every((c) => /sigla_modalidade IS NULL OR NOT \(sigla_modalidade LIKE 'LO%'/.test(c.where)));
});
