import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const p = load('prefs.ts');
const themes = ['kali-dark', 'dracula'];

test('damaged or missing prefs fall back to defaults', () => {
  assert.deepEqual(p.normalizePrefs(null, themes), p.DEFAULT_PREFS);
  assert.deepEqual(p.normalizePrefs('nope', themes), p.DEFAULT_PREFS);
  const odd = p.normalizePrefs({ theme: 'gone', fontSize: 400, scrollback: -5, cursorStyle: 'wave', defaultPort: 70000, fontFamily: 'Comic Sans', copyOnSelect: 'yes' }, themes);
  assert.equal(odd.theme, 'kali-dark');
  assert.equal(odd.fontSize, p.MAX_FONT_SIZE);
  assert.equal(odd.scrollback, p.MIN_SCROLLBACK);
  assert.equal(odd.cursorStyle, 'block');
  assert.equal(odd.defaultPort, 65535);
  assert.equal(odd.fontFamily, p.DEFAULT_PREFS.fontFamily);
  assert.equal(odd.copyOnSelect, false);
});

test('prefs round-trip through storage and carry over the old font size', () => {
  const data = new Map([['ghostkey.fontSize', '18']]);
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const first = p.loadPrefs(store, themes);
  assert.equal(first.fontSize, 18);
  p.savePrefs(store, { ...first, theme: 'dracula', defaultUser: '  kali  ' });
  const again = p.loadPrefs(store, themes);
  assert.equal(again.theme, 'dracula');
  assert.equal(again.defaultUser, 'kali');
  assert.deepEqual(p.loadPrefs({ getItem() { throw new Error('denied'); }, setItem() {} }, themes), p.DEFAULT_PREFS);
  assert.deepEqual(p.loadPrefs(null, themes), p.DEFAULT_PREFS);
});

test('menu keyboard navigation skips separators and disabled items', () => {
  const { nextItem } = load('menu.ts', { './modal': { el() {} } });
  const items = [{ label: 'a' }, '-', { label: 'b', enabled: () => false }, { label: 'c' }];
  assert.equal(nextItem(items, -1, 1), 0);
  assert.equal(nextItem(items, 0, 1), 3);
  assert.equal(nextItem(items, 3, 1), 0);
  assert.equal(nextItem(items, 0, -1), 3);
  assert.equal(nextItem(['-', { label: 'x', enabled: () => false }], -1, 1), -1);
});

test('every theme defines the full terminal palette and shell colors', () => {
  const { THEMES, themeById } = load('theme.ts');
  const keys = Object.keys(THEMES[0].term);
  const vars = Object.keys(THEMES[0].chrome);
  assert.ok(THEMES.length >= 4);
  for (const t of THEMES) {
    assert.deepEqual(Object.keys(t.term).sort(), [...keys].sort(), t.id);
    assert.deepEqual(Object.keys(t.chrome).sort(), [...vars].sort(), t.id);
  }
  assert.equal(themeById('missing').id, 'kali-dark');
});
