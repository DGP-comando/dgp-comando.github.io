import test from 'node:test';
import assert from 'node:assert/strict';
import { estacaoTooltipHtml, estacoesIdrLayer } from './estacoesIdr.js';

const DADOS = {
  servidores: [
    { nome: 'FULANO', formacao: 'Pesquisador', unidade: 'polo-ponta-grossa' },
    { nome: 'BELTRANA', formacao: '', unidade: 'uf-ponta-grossa' },
    { nome: 'OUTRO', formacao: 'Zootecnia', unidade: 'lapa' },
  ],
};
const PONTO = {
  unidade: 'polo-ponta-grossa,uf-ponta-grossa',
  nome: 'Polo de Pesquisa Ponta Grossa · Unidade Florestal de Ponta Grossa',
  tipo: 'polo,unidade-florestal',
  municipio: 'Ponta Grossa',
  aproximado: true,
};

test('tooltip lista os servidores das unidades do ponto', () => {
  const html = estacaoTooltipHtml(PONTO, DADOS);
  assert.match(html, /2 servidores/);
  assert.match(html, /BELTRANA/);
  assert.match(html, /FULANO/);
  assert.doesNotMatch(html, /OUTRO/);
  assert.match(html, /formação não informada/);
  assert.match(html, /Polo de pesquisa · Unidade florestal · Ponta Grossa/);
  assert.match(html, /Localização aproximada/);
});

test('tooltip sem o arquivo de servidores avisa em vez de mostrar zero', () => {
  const html = estacaoTooltipHtml({ ...PONTO, aproximado: false }, null);
  assert.match(html, /indisponível/);
  assert.doesNotMatch(html, /servidores<\/span>/);
});

test('camada: arquivo privado e hover nos polígonos e pontos', () => {
  assert.deepEqual([...estacoesIdrLayer.interactive], ['dg-estacoes-idr-fill', 'dg-estacoes-idr-pt']);
});
