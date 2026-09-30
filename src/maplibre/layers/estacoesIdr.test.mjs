import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { estacaoTooltipHtml, estacoesIdrLayer, unidadeEstilo, unidadeTooltipHtml } from './estacoesIdr.js';

// data/privado/ fica fora do git: o teste com dado real só roda onde o arquivo existe.
const UNIDADES = new URL('../../../data/privado/unidades-idr-pr.geojson', import.meta.url);

test('unidades reais: todo ponto tem estilo e rótulo; tetos de rótulo declarados', { skip: !existsSync(UNIDADES) }, () => {
  const feats = JSON.parse(readFileSync(UNIDADES, 'utf8')).features;
  assert.ok(feats.length > 400);
  for (const f of feats) {
    const s = unidadeEstilo(f.properties);
    assert.ok(s, f.properties.nome);
    assert.ok(s.label);
    assert.ok([400_000, 60_000].includes(s.labelMaxDist));
  }
});

test('tooltip da unidade: contato e aviso de posição aproximada', () => {
  const html = unidadeTooltipHtml({ nome: 'Unidade Municipal de Extensão · Tapira', tipo: 'ume', regional: 'Umuarama',
    endereco: 'Rua X, 1', telefone: '(44) 3000-0000', email: 'tapira@idr.pr.gov.br', aproximado: true, no_site: true });
  assert.match(html, /tapira@idr\.pr\.gov\.br/);
  assert.match(html, /Localização aproximada/);
  assert.doesNotMatch(html, /Não consta/);
});

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

test('tooltip do escritório (UME) lista os extensionistas do município; regional não', () => {
  const dados = { servidores: [
    { nome: 'ANA', municipio: 'Tapira', formacao: 'Zootecnia', extensionista: true },
    { nome: 'BRUNO', municipio: 'TAPIRA', formacao: 'Engenharia Agronômica', extensionista: true },
    { nome: 'CAIO', municipio: 'Tapira', formacao: 'Assist. Administrativo', extensionista: false },
    { nome: 'DORA', municipio: 'Umuarama', formacao: 'Zootecnia', extensionista: true },
  ] };
  const ume = { nome: 'Unidade Municipal de Extensão · Tapira', tipo: 'ume', municipio: 'Tapira' };
  const html = unidadeTooltipHtml(ume, dados);
  assert.match(html, /2 extensionistas/);
  assert.match(html, /ANA/);
  assert.match(html, /BRUNO/);
  assert.doesNotMatch(html, /CAIO|DORA/);
  const regional = unidadeTooltipHtml({ ...ume, tipo: 'regional' }, dados);
  assert.doesNotMatch(regional, /ANA|extensionista/);
  assert.match(unidadeTooltipHtml(ume, null), /indisponível/);
});

test('núcleo de fazenda florestal: uso, contrato, área e servidores da unidade florestal', () => {
  const nucleo = { unidade: 'uf-ponta-grossa', nome: 'Fazenda florestal · Núcleo 9', tipo: 'unidade-florestal',
    municipio: 'Ponta Grossa', unidade_nome: 'Unidade Florestal de Ponta Grossa', uso: 'Parceria',
    contrato: '025/2012', area_ha: 2168, aproximado: false };
  const html = estacaoTooltipHtml(nucleo, DADOS);
  assert.match(html, /Unidade Florestal de Ponta Grossa · Ponta Grossa/);
  assert.match(html, /025\/2012/);
  assert.match(html, /2\.168 ha/);
  assert.match(html, /BELTRANA/);
  const orfao = estacaoTooltipHtml({ ...nucleo, unidade: '', unidade_nome: '', municipio: 'Campo Largo' }, DADOS);
  assert.match(orfao, /não vinculados/);
  assert.doesNotMatch(orfao, /servidores<\/span>|BELTRANA/);
});

test('camada: arquivo privado e hover nos polígonos e pontos', () => {
  assert.deepEqual([...estacoesIdrLayer.interactive], ['dg-estacoes-idr-fill', 'dg-estacoes-idr-pt']);
});

test('tooltip da unidade regional mostra o gerente da regional', () => {
  const ger = { referencia: 'Setembro/2026', regionais: { 'Santo Antonio da Platina': { nome: 'FULANO GERENTE', cargo: 'CHEFE' } } };
  const p = { nome: 'Unidade Regional · Santo Antônio da Platina', tipo: 'regional', regional: 'Santo Antônio da Platina' };
  const html = unidadeTooltipHtml(p, null, ger);
  assert.match(html, /Gerente/);
  assert.match(html, /FULANO GERENTE/);
  assert.match(html, /RH do IDR \(Setembro\/2026\)/);
  assert.doesNotMatch(unidadeTooltipHtml({ ...p, tipo: 'ume', municipio: 'X' }, null, ger), /FULANO/);
  assert.doesNotMatch(unidadeTooltipHtml(p, null, null), /Gerente/);
});
