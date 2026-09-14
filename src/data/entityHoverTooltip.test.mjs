import test from 'node:test';
import assert from 'node:assert/strict';
import { tooltipPlacement } from './entityHoverTooltip.js';

const viewport = { width: 1400, height: 900 };
const box = { width: 300, height: 180 };

test('tooltip fica à direita e abaixo do cursor quando cabe', () => {
  assert.deepEqual(tooltipPlacement({ x: 200, y: 300 }, box, viewport), { left: 216, top: 312 });
});

test('perto da borda direita vira para a esquerda do cursor', () => {
  assert.deepEqual(tooltipPlacement({ x: 1300, y: 300 }, box, viewport), { left: 984, top: 312 });
});

test('perto da borda de baixo sobe para cima do cursor', () => {
  assert.deepEqual(tooltipPlacement({ x: 200, y: 850 }, box, viewport), { left: 216, top: 658 });
});

test('nunca sai pela esquerda ou pelo topo', () => {
  const big = { width: 1500, height: 1000 };
  assert.deepEqual(tooltipPlacement({ x: 100, y: 100 }, big, viewport), { left: 8, top: 8 });
});
