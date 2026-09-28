import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS } from './index.js';
import { REGISTERED_LAYER_IDS } from '../../data/layerState.js';

// Camada fora do registro de estado derruba o boot ("Layer serialization
// registry mismatch"): toda camada nova precisa de um token em layerState.js.
test('toda camada MapLibre está no registro de estado (share link / localStorage)', () => {
  const faltando = LAYERS.map((l) => l.id).filter((id) => !REGISTERED_LAYER_IDS.includes(id));
  assert.deepEqual(faltando, []);
});
