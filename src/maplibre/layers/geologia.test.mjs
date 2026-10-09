import assert from 'node:assert/strict';
import test from 'node:test';
import geologia, {
  SERVICO_ANM, litologiaTooltip, ocorrenciaTooltip, processoMinerarioTooltip, processosMinerariosLayer,
} from './geologia.js';

test('ANM: nome do serviço com acento vai codificado em toda URL de tile', () => {
  assert.equal(SERVICO_ANM, 'Processos_Miner%C3%A1rios_ANM');
  const tiles = Object.values(processosMinerariosLayer.sources).flatMap((s) => s.tiles ?? []);
  assert.ok(tiles.length && tiles.every((t) => t.includes(SERVICO_ANM)));
});

test('ANM: tooltip sem titular, mesmo se o servidor mandar `nome`', () => {
  const html = processoMinerarioTooltip({ processo: '826001/2010', fase: 'CONCESSÃO DE LAVRA', subs: 'CALCÁRIO', nome: 'Fulano de Tal' });
  assert.match(html, /826001\/2010/);
  assert.match(html, /CALCÁRIO/);
  assert.doesNotMatch(html, /Fulano/);
});

test('litologia: unidade, idade e intervalo em Ma com acento', () => {
  const html = litologiaTooltip({
    nome_unida: 'Guabirotuba', hierarquia: 'Formação', sigla_unid: 'E23g',
    era_maxima: 'Cenozóico', periodo_ma: 'Paleogeno', idade_max: '33.7', idade_min: '5',
  });
  assert.match(html, /Guabirotuba/);
  assert.match(html, /Cenozóico · Paleogeno/);
  assert.match(html, /33,7 Ma a 5 Ma/);
});

test('ocorrência SGB: substância no título', () => {
  assert.match(ocorrenciaTooltip({ substancias: 'Turfa', status_economico: 'Não explotado', municipio: 'Tibagi' }), /Turfa/);
});

test('camadas da geologia na aba Aspectos físicos, ids únicos', () => {
  assert.equal(geologia.length, 5);
  assert.ok(geologia.every((l) => l.category === 'Aspectos físicos'));
  assert.equal(new Set(geologia.map((l) => l.id)).size, 5);
});
