import assert from 'node:assert/strict';
import test from 'node:test';
import { cnpjFeatures, cnpjTooltip, fmtCnpj } from './cnpjAgro.js';

const d = {
  fonte: 'Receita Federal',
  classes: ['Lavouras', 'Pecuária'],
  precisao: ['rua', 'cep', 'municipio'],
  cnaes: { '0151201': 'Criação de bovinos para corte', '0161003': 'Serviço de preparação de terreno' },
  p: [
    { x: -50, y: -25, prec: 0, esp: 0, c: 1, cnpj: '12345678000190', razao: 'JOÃO DA SILVA 12345678901', fantasia: '', mf: 'Matriz',
      situacao: 'Ativa', inicio: '10/07/2025', cnae: '0151201', sec: ['0161003'], end: 'RUA DAS FLORES, 10', mun: 'CASCAVEL',
      tel: ['(45) 33334444'], email: 'joao@exemplo.com', natureza: 'Empresário (Individual)', capital: 5000, mei: true, dtMei: '10/07/2025' },
    { x: -51, y: -24, prec: 2, esp: 1, c: 0, cnpj: '98765432000110', razao: 'COOP', mf: 'Filial', situacao: 'Ativa', cnae: '0161003', sec: [] },
  ],
};

test('features: id = índice, classe e aproximado', () => {
  const { features, counts } = cnpjFeatures(d);
  assert.equal(features.length, 2);
  assert.deepEqual(features.map((f) => f.properties), [{ c: 1, aprox: 0 }, { c: 0, aprox: 1 }]);
  assert.deepEqual(counts, [1, 1]);
});

test('tooltip: todos os campos, CPF da razão social mantido (autorizado), acentos', () => {
  const html = cnpjTooltip(d.p[0], d);
  assert.match(html, /12\.345\.678\/0001-90/);
  assert.match(html, /JOÃO DA SILVA 12345678901/);
  assert.match(html, /0151201 Criação de bovinos para corte/);
  assert.match(html, /joao@exemplo\.com/);
  assert.match(html, /\(45\) 33334444/);
  assert.match(html, /Sim, desde 10\/07\/2025/);
  assert.match(html, /CNAEs secundários \(1\)/);
});

test('tooltip: posição aproximada avisada', () => {
  assert.match(cnpjTooltip(d.p[1], d), /centro do município \(aproximada\) · espalhado/);
  assert.equal(fmtCnpj('98765432000110'), '98.765.432/0001-10');
});
