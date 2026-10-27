import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const paste = load('paste.ts');
const { payload, lineCount, needsPreview, risky, grouped } = load('snippets.ts', { './paste': paste });

const snip = (over = {}) => ({ id: '1', name: 'ports', group: '', command: 'ss -tulpn', run: false, favorite: false, ...over });

test('inserting types the text without pressing Enter', () => {
  assert.deepEqual(payload(snip()), { text: 'ss -tulpn', enter: false });
  assert.equal(needsPreview(snip()), false);
});

test('a trailing newline never runs a command by itself', () => {
  assert.deepEqual(payload(snip({ command: 'id\n\n' })), { text: 'id', enter: false });
  assert.deepEqual(payload(snip({ command: 'id\r\n', run: true })), { text: 'id', enter: true });
});

test('running or pasting several lines is previewed first', () => {
  assert.equal(needsPreview(snip({ run: true })), true);
  const multi = snip({ command: 'cd /tmp\r\nls\n' });
  assert.equal(lineCount(multi), 2);
  assert.equal(payload(multi).text, 'cd /tmp\nls');
  assert.equal(needsPreview(multi), true);
});

test('groups list ungrouped snippets first, then by name', () => {
  const g = grouped([snip({ name: 'a', group: 'Web' }), snip({ name: 'b' }), snip({ name: 'c', group: 'Recon' }), snip({ name: 'd', group: 'Web' })]);
  assert.deepEqual(g.map(([name, items]) => [name, items.map((s) => s.name)]), [['', ['b']], ['Recon', ['c']], ['Web', ['a', 'd']]]);
});

test('control characters get the same review as a paste, and Enter cancels', () => {
  const esc = snip({ command: 'printf "\x1b]0;x\x07"' });
  assert.equal(needsPreview(esc), true);
  assert.equal(risky(esc), true);
  assert.equal(risky(snip({ run: true })), false);
  assert.equal(risky(snip({ command: 'a\nb' })), true);
});
