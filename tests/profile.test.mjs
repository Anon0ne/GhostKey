import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const layout = load('layout.ts');
const hostLabels = load('hostLabels.ts');
const ws = load('workspace.ts', { './layout': layout });
const p = load('profile.ts', { './workspace': ws, './hostLabels': hostLabels, './protocols': load('protocols.ts') });

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = (n, extra = {}) => ({
  id: ID(n), name: `s${n}`, folder: 'Lab', host: `10.0.0.${n}`, port: 22, username: 'kali', auth: 'password', keyPath: null,
  autoOpenTailscale: false, autoLog: false, forwards: [], jumpSession: null, tags: ['web'], environment: '', ...extra,
});

test('a workspace layout round-trips with session references and ratios only', () => {
  const tree = { kind: 'split', dir: 'row', ratio: 0.3, a: layout.leaf('A'), b: { kind: 'split', dir: 'column', ratio: 0.99, a: layout.leaf('B'), b: layout.leaf('C') } };
  const saved = ws.capture(tree, (pane) => ({ session: pane === 'C' ? null : `id-${pane}`, label: `pane ${pane}` }));
  assert.equal(saved.b.ratio, 0.9, 'ratios are clamped');
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'plain JSON only');
  let made = [];
  const back = ws.restore(saved, (l) => (made.push(l), l.label));
  assert.deepEqual(layout.panes(back), ['pane A', 'pane B', 'pane C']);
  assert.deepEqual(made.map((m) => m.session), ['id-A', 'id-B', null]);
  assert.equal(back.ratio, 0.3);
});

test('damaged layouts are refused and missing sessions are flagged', () => {
  assert.equal(ws.cleanWorkspace({ id: 'x', name: 'w', tabs: [{ kind: 'split', dir: 'diagonal' }] }), null);
  assert.equal(ws.cleanWorkspace({ id: 'x', name: ' ', tabs: [{ kind: 'leaf' }] }), null);
  assert.equal(ws.cleanWorkspace({ id: 'x', name: 'w', tabs: [] }), null);
  let deep = { kind: 'leaf', session: null, label: '' };
  for (let i = 0; i < 20; i++) deep = { kind: 'split', dir: 'row', ratio: 0.5, a: deep, b: deep };
  assert.equal(ws.cleanNode(deep), null, 'absurdly deep trees are refused');
  const w = ws.cleanWorkspace({ id: 'x', name: ' Daily ', tabs: [{ kind: 'split', dir: 'row', ratio: 'wide', a: { kind: 'leaf', session: 'a', label: 'A' }, b: { kind: 'leaf', session: 'gone', label: 'B' } }] });
  assert.equal(w.name, 'Daily');
  assert.equal(w.tabs[0].ratio, 0.5);
  const pv = ws.preview(w, new Set(['a']));
  assert.deepEqual(pv[0].panes.map((x) => x.missing), [false, true]);
});

test('exports omit secrets, use portable paths and import back unchanged', () => {
  const s1 = session(1, { auth: 'key', keyPath: '/home/justin/.ssh/id_ed25519', password: 'hunter2', passphrase: 'x' });
  const s2 = session(2, { keyPath: 'C:\\Users\\Justin\\keys\\a.ppk', auth: 'key' });
  const snippet = { id: ID(9), name: 'who', group: '', command: 'id', run: true, favorite: false };
  const w = { id: ID(7), name: 'Daily', tabs: [{ kind: 'leaf', session: ID(1), label: 's1' }] };
  const prof = p.buildProfile({ sessions: [s1, s2], snippets: [snippet], workspaces: [w] }, '/home/justin', new Date(0));
  const text = JSON.stringify(prof);
  assert.ok(!/hunter2|passphrase|password"/.test(text), 'no secrets');
  assert.equal(prof.sessions[0].keyPath, '~/.ssh/id_ed25519');
  assert.equal(p.portablePath('C:\\Users\\Justin\\keys\\a.ppk', 'C:\\Users\\justin'), '~/keys/a.ppk');
  assert.equal(p.portablePath('/opt/keys/a', '/home/justin'), '/opt/keys/a');

  const back = p.parseProfile(text);
  assert.ok(back.ok);
  assert.deepEqual(back.skipped, []);
  assert.deepEqual(back.profile.sessions, prof.sessions);
  assert.deepEqual(back.profile.snippets, prof.snippets);
  assert.deepEqual(back.profile.workspaces, prof.workspaces);
});

test('other files, newer versions and bad entries are handled', () => {
  assert.match(p.parseProfile('not json').error, /isn't valid JSON/);
  assert.match(p.parseProfile('{"sessions":[]}').error, /isn't a GhostKey profile/);
  assert.match(p.parseProfile('{"format":"ghostkey-profile","version":7}').error, /newer GhostKey/);
  const r = p.parseProfile(JSON.stringify({
    format: 'ghostkey-profile', version: 1,
    sessions: [session(1), { ...session(2), host: 'bad host' }, { ...session(3), id: 'nope' }, { ...session(4), environment: 'chaos', tags: ['a', 5, '#b'] }],
    snippets: [{ id: ID(5), name: '', command: 'x' }],
    workspaces: [{ id: 'w', name: 'x', tabs: [{ kind: 'nope' }] }],
  }));
  assert.ok(r.ok);
  assert.deepEqual(r.profile.sessions.map((s) => s.name), ['s1', 's4']);
  assert.equal(r.profile.sessions[1].environment, '');
  assert.deepEqual(r.profile.sessions[1].tags, ['a', 'b']);
  assert.equal(r.skipped.length, 4);
});

test('imports are compared with what is already saved', () => {
  const mine = [session(1), session(2)];
  assert.equal(p.compare(session(3), mine), 'new');
  // Same content with keys in another order is unchanged.
  const reordered = Object.fromEntries(Object.entries(session(1)).reverse());
  assert.equal(p.compare(reordered, mine), 'same');
  assert.equal(p.compare(session(2, { host: '10.9.9.9' }), mine), 'changed');
  assert.equal(p.compare(session(2, { forwards: [{ id: 'f', kind: 'local' }] }), mine), 'changed');
});
