import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const f = load('files.ts');
const entry = (name, kind = 'file', extra = {}) => ({ name, kind, linkDir: false, size: 0, modified: null, permissions: null, ...extra });

test('folders, including links to folders, sort first; names sort naturally', () => {
  const sorted = f.sortEntries([entry('b.txt'), entry('file10'), entry('Docs', 'dir'), entry('file2'), entry('link', 'link', { linkDir: true }), entry('a', 'dir')]);
  assert.deepEqual(sorted.map((e) => e.name), ['a', 'Docs', 'link', 'b.txt', 'file2', 'file10']);
  assert.equal(f.isDir(entry('l', 'link')), false);
});

test('remote paths use slashes whatever the local OS', () => {
  assert.equal(f.remoteJoin('/home/kali', 'x'), '/home/kali/x');
  assert.equal(f.remoteJoin('/', 'etc'), '/etc');
  assert.equal(f.remoteParent('/home/kali/'), '/home');
  assert.equal(f.remoteParent('/home'), '/');
  assert.equal(f.remoteParent('/'), '/');
});

test('local paths keep their own separator', () => {
  assert.equal(f.localName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(f.localName('/home/me/notes.txt'), 'notes.txt');
  assert.equal(f.localJoin('C:\\Users\\me\\Downloads', 'a.txt'), 'C:\\Users\\me\\Downloads\\a.txt');
  assert.equal(f.localJoin('/home/me/', 'a.txt'), '/home/me/a.txt');
});

test('remote names are made safe to save on Windows', () => {
  assert.equal(f.safeLocalName('a:b?.txt'), 'a_b_.txt');
  assert.equal(f.safeLocalName('trailing. '), 'trailing');
  assert.equal(f.safeLocalName('CON.txt'), '_CON.txt');
  assert.equal(f.safeLocalName('...'), 'download');
});

test('new names are one path part', () => {
  assert.equal(f.nameProblem('ok.txt'), null);
  assert.ok(f.nameProblem(' '));
  assert.ok(f.nameProblem('a/b'));
  assert.ok(f.nameProblem('..'));
});

test('sizes, modes, and progress format for the panel', () => {
  assert.equal(f.formatSize(512), '512 B');
  assert.equal(f.formatSize(1536), '1.5 KB');
  assert.equal(f.formatSize(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.equal(f.formatMode(entry('d', 'dir', { permissions: 0o40755 })), 'drwxr-xr-x');
  assert.equal(f.formatMode(entry('f', 'file', { permissions: 0o100640 })), '-rw-r-----');
  assert.equal(f.formatMode(entry('f')), '');
  assert.equal(f.percent(50, 200), 25);
  assert.equal(f.percent(0, 0), 0);
  assert.equal(f.percent(5, 0), 100);
});
