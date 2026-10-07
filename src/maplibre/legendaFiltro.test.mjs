import assert from 'node:assert/strict';
import test from 'node:test';
import { filtroComLegenda } from './layerHost.js';
import { alternaLegenda, toManagerModule } from './managerAdapter.js';

const EXPR = ['to-string', ['get', '__grupo']];

test('filtro da legenda: sem nada escondido devolve o filtro original (ou nenhum)', () => {
  assert.equal(filtroComLegenda(undefined, EXPR, []), null);
  const orig = ['==', ['get', '__ld'], 25000];
  assert.equal(filtroComLegenda(orig, EXPR, []), orig);
});

test('filtro da legenda: combina com o filtro do layer por "all"', () => {
  const orig = ['==', ['get', '__ld'], 25000];
  assert.deepEqual(filtroComLegenda(orig, EXPR, ['a', 'b']),
    ['all', orig, ['!', ['in', EXPR, ['literal', ['a', 'b']]]]]);
  assert.deepEqual(filtroComLegenda(null, EXPR, ['a']), ['!', ['in', EXPR, ['literal', ['a']]]]);
});

test('alternar e "só esta" na legenda', () => {
  const todas = ['a', 'b', 'c'];
  assert.deepEqual([...alternaLegenda(new Set(), 'a', todas)], ['a']);
  assert.deepEqual([...alternaLegenda(new Set(['a']), 'a', todas)], []);
  // Só b: esconde as outras; de novo, mostra todas.
  const soB = alternaLegenda(new Set(['a']), 'b', todas, true);
  assert.deepEqual([...soB].sort(), ['a', 'c']);
  assert.deepEqual([...alternaLegenda(soB, 'b', todas, true)], []);
});

test('adaptador: itens com key ficam filtráveis e o clique muda o anfitrião', () => {
  const ocultos = new Map();
  const host = {
    ctx: {},
    register() {},
    legendHidden: (id) => new Set(ocultos.get(id) ?? []),
    setLegendHidden: (id, keys) => ocultos.set(id, new Set(keys)),
  };
  const def = {
    id: 'x',
    legendFilter: '__grupo',
    rowControls: () => ({ legend: [{ label: 'A', color: '#f00', key: 1 }, { label: 'B', color: '#0f0', key: 2 }, { label: 'dica', color: '#999' }] }),
  };
  const mod = toManagerModule(def, host);
  assert.deepEqual(mod.getRowControls().legend.map((l) => [l.label, l.filtravel ?? false, l.oculto ?? false]),
    [['A', true, false], ['B', true, false], ['dica', false, false]]);
  mod.setParams({ legenda: '2' });
  assert.deepEqual(mod.getRowControls().legend.map((l) => l.oculto ?? false), [false, true, false]);
  // Com só "2" escondida, "1" já é a única visível: Shift+clique nela mostra todas.
  mod.setParams({ legenda: '1', so: true });
  assert.deepEqual([...ocultos.get('x')], []);
  mod.setParams({ legenda: '2', so: true });
  assert.deepEqual([...ocultos.get('x')], ['1']);
});

test('camada sem legendFilter nem onLegend: legenda continua só informativa', () => {
  const host = { ctx: {}, register() {}, legendHidden: () => new Set(), setLegendHidden() {} };
  const mod = toManagerModule({ id: 'y', rowControls: () => ({ legend: [{ label: 'A', color: '#f00', key: 1 }] }) }, host);
  assert.equal(mod.getRowControls().legend[0].filtravel, undefined);
});

test('legenda de uma classe só não vira filtro', () => {
  const host = { ctx: {}, register() {}, legendHidden: () => new Set(), setLegendHidden() {} };
  const mod = toManagerModule({ id: 'z', legendFilter: '__grupo', rowControls: () => ({ legend: [{ label: 'Ceasa', color: '#f00', key: 'ceasa' }] }) }, host);
  assert.equal(mod.getRowControls().legend[0].filtravel, undefined);
});
