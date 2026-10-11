import assert from 'node:assert/strict';
import test from 'node:test';
import { cnesFeatures, cnesTooltip } from './cnesSaude.js';

const d = {
  fonte: 'CNES/DATASUS',
  classes: ['Unidades básicas de saúde', 'Hospitais'],
  p: [
    { x: -49, y: -25, esp: 0, c: 1, cnes: '0013633', fantasia: 'HOSPITAL ANGELINA CARON', razao: 'SOCIEDADE HOSPITALAR ANGELINA CARON',
      tipo: 'Hospital geral', cnpj: '07.088.017/0001-91', natureza: '3999 Associação Privada', esfera: 'Estadual', gestao: 'Estadual',
      sus: true, turno: 'Atendimento continuo de 24 horas', ensino: 'Hospital de ensino', servicos: ['centro cirúrgico', 'centro obstétrico'],
      leitos: [300, 200, 40, 30], end: 'RODOVIA DO CAQUI, 1150', bairro: 'ARACATUBA', cep: '83434-286', mun: 'Campina Grande do Sul',
      rs: '2ª RS METROPOLITANA', tel: '(41) 36798100', email: 'juridico@hospitalcaron.org.br' },
    { x: -50, y: -24, esp: 1, c: 0, cnes: '0000001', fantasia: '', razao: 'JOSÉ DA SILVA', tipo: 'Posto de saúde', sus: false, leitos: null, servicos: [] },
  ],
};

test('features: id = índice e classe', () => {
  const { features, counts } = cnesFeatures(d);
  assert.deepEqual(features.map((f) => [f.id, f.properties.c]), [[0, 1], [1, 0]]);
  assert.deepEqual(counts, [1, 1]);
});

test('tooltip: todos os campos, leitos, contato e acentos', () => {
  const html = cnesTooltip(d.p[0], d);
  for (const s of ['CNES 0013633', 'Hospital geral', '300 (200 SUS)', '40 (30 SUS)', 'centro cirúrgico, centro obstétrico',
    'Hospital de ensino', '3999 Associação Privada', '07.088.017/0001-91', '83434-286', '2ª RS METROPOLITANA',
    '(41) 36798100', 'juridico@hospitalcaron.org.br']) assert.ok(html.includes(s), s);
});

test('tooltip: sem nome fantasia usa a razão social; não SUS e espalhado avisados', () => {
  const html = cnesTooltip(d.p[1], d);
  assert.match(html, /JOSÉ DA SILVA/);
  assert.match(html, /Não/);
  assert.match(html, /espalhado/);
  assert.doesNotMatch(html, /Leitos de UTI/);
});
