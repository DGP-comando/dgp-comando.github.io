import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightNewArrivals, countWithArrivals } from './newArrivalHighlight.js';

function fakeTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimer: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    flush: () => { while (pending.length) pending.shift().fn(); },
    pending,
  };
}

test('destaca pontos e restaura o estilo original apos o prazo', () => {
  const timers = fakeTimers();
  const reasons = [];
  const a = { point: { outlineColor: 'black', outlineWidth: 1 } };
  const b = { point: { outlineColor: 'white', outlineWidth: 0 } };
  const semPonto = { label: {} };
  const r = highlightNewArrivals([a, b, semPonto], {
    outlineColor: 'cyan', ...timers, onChange: (x) => reasons.push(x),
  });
  assert.equal(r.count, 2);
  assert.equal(a.point.outlineColor, 'cyan');
  assert.equal(b.point.outlineWidth, 3);
  assert.equal(timers.pending[0].ms, 60_000);
  timers.flush();
  assert.deepEqual(a.point, { outlineColor: 'black', outlineWidth: 1 });
  assert.deepEqual(b.point, { outlineColor: 'white', outlineWidth: 0 });
  assert.deepEqual(reasons, ['new-arrival-on', 'new-arrival-off']);
});

test('cancel restaura na hora e so uma vez', () => {
  const timers = fakeTimers();
  let offs = 0;
  const a = { point: { outlineColor: 'black', outlineWidth: 1 } };
  const r = highlightNewArrivals([a], {
    outlineColor: 'cyan', ...timers, onChange: (x) => { if (x === 'new-arrival-off') offs += 1; },
  });
  r.cancel();
  r.cancel();
  timers.flush();
  assert.equal(a.point.outlineColor, 'black');
  assert.equal(offs, 1);
  assert.equal(timers.pending.length, 0);
});

test('sem pontos nao agenda nada', () => {
  const timers = fakeTimers();
  const r = highlightNewArrivals([{}, null], { outlineColor: 'cyan', ...timers });
  assert.equal(r.count, 0);
  assert.equal(timers.pending.length, 0);
});

test('contador mostra +N so para refresh recente e nao inicial', () => {
  const fmt = (n) => n.toLocaleString('pt-BR');
  const now = 1_000_000_000;
  assert.deepEqual(countWithArrivals({ count: 1234, newCount: 3, lastUpdate: now - 1000 }, fmt, now),
    { text: '1.234 +3', fresh: 3 });
  assert.equal(countWithArrivals({ count: 12, newCount: 12, initialRefresh: true, lastUpdate: now }, fmt, now).text, '12');
  assert.equal(countWithArrivals({ count: 12, newCount: 2, lastUpdate: now - 11 * 60_000 }, fmt, now).text, '12');
  assert.equal(countWithArrivals({ count: 0, newCount: 0 }, fmt, now).text, '—');
  assert.equal(countWithArrivals(null, fmt, now).text, '—');
});
