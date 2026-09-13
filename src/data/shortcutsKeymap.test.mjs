import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEYMAP,
  RESERVED_GEV_KEYS,
  SHORTCUT_HELP,
  createShortcutDispatcher,
  isEditableTarget,
  resolveShortcut,
} from './shortcutsKeymap.js';

const body = { tagName: 'BODY', closest: () => null };
const key = (k, extra = {}) => ({
  key: k, target: body, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
  stopImmediatePropagation() { this.stopped = true; },
  ...extra,
});

test('keymap never binds a key already used by GEV ui.js', () => {
  for (const k of Object.keys(DEFAULT_KEYMAP)) {
    assert.ok(!RESERVED_GEV_KEYS.includes(k), `key "${k}" collides with GEV`);
  }
  for (const action of Object.values(DEFAULT_KEYMAP)) {
    assert.ok(SHORTCUT_HELP.some((h) => h.action === action), `help lists ${action}`);
  }
});

test('maps letters case-insensitively and ? with shift', () => {
  assert.equal(resolveShortcut(key('l')), 'toggleLayers');
  assert.equal(resolveShortcut(key('L')), 'toggleLayers');
  assert.equal(resolveShortcut(key('b')), 'openSearch');
  assert.equal(resolveShortcut(key('p')), 'resetCamera');
  assert.equal(resolveShortcut(key('m')), 'toggleFullscreen');
  assert.equal(resolveShortcut(key('a')), 'toggleWatch');
  assert.equal(resolveShortcut(key('?', { shiftKey: true })), 'toggleHelp');
  assert.equal(resolveShortcut(key('z')), null);
  assert.equal(resolveShortcut(key('F1')), null);
});

test('ignores modifiers, shifted letters, repeats, IME and handled events', () => {
  assert.equal(resolveShortcut(key('l', { ctrlKey: true })), null);
  assert.equal(resolveShortcut(key('l', { altKey: true })), null);
  assert.equal(resolveShortcut(key('l', { metaKey: true })), null);
  assert.equal(resolveShortcut(key('L', { shiftKey: true })), null);
  assert.equal(resolveShortcut(key('l', { repeat: true })), null);
  assert.equal(resolveShortcut(key('l', { isComposing: true })), null);
  assert.equal(resolveShortcut(key('l', { defaultPrevented: true })), null);
  assert.equal(resolveShortcut(null), null);
});

test('ignores editable targets: input, textarea, select, contenteditable', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(resolveShortcut(key('l', { target: { tagName } })), null, tagName);
  }
  assert.equal(resolveShortcut(key('l', { target: { tagName: 'DIV', isContentEditable: true } })), null);
  const insideEditor = { tagName: 'SPAN', closest: () => ({ getAttribute: () => 'true' }) };
  assert.ok(isEditableTarget(insideEditor));
  assert.equal(isEditableTarget({ tagName: 'BUTTON', closest: () => null }), false);
  assert.equal(isEditableTarget(null), false);
});

test('Escape resolves to closeHelp only while help is open, even from inputs', () => {
  assert.equal(resolveShortcut(key('Escape')), null);
  assert.equal(resolveShortcut(key('Escape', { target: { tagName: 'INPUT' } }), { helpOpen: true }), 'closeHelp');
});

test('dispatcher calls the action, consumes the event and skips missing callbacks', () => {
  const calls = [];
  let helpOpen = false;
  const dispatch = createShortcutDispatcher({
    actions: {
      toggleLayers: () => calls.push('layers'),
      toggleHelp: () => { helpOpen = !helpOpen; calls.push('help'); },
      closeHelp: () => { helpOpen = false; calls.push('close'); },
      resetCamera: () => { throw new Error('boom'); },
    },
    isHelpOpen: () => helpOpen,
  });

  const e1 = key('l');
  assert.equal(dispatch(e1), 'toggleLayers');
  assert.equal(e1.defaultPrevented, true);
  assert.equal(e1.stopped, true);

  const e2 = key('b'); // no callback
  assert.equal(dispatch(e2), null);
  assert.equal(e2.defaultPrevented, false, 'unhandled keys stay available to other listeners');

  assert.equal(dispatch(key('?', { shiftKey: true })), 'toggleHelp');
  assert.equal(dispatch(key('Escape')), 'closeHelp');
  assert.equal(dispatch(key('Escape')), null, 'Esc passes through once help is closed');

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(dispatch(key('p')), 'resetCamera', 'a throwing action does not break the dispatcher');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(calls, ['layers', 'help', 'close']);
});

test('custom keymap overrides defaults', () => {
  assert.equal(resolveShortcut(key('k'), { keymap: { k: 'custom' } }), 'custom');
  assert.equal(resolveShortcut(key('l'), { keymap: { k: 'custom' } }), null);
});
