import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { planRows, problem, toSessions } = load('importPlan.ts');

const found = (over = {}) => ({
  name: 'lab', host: '10.0.0.5', port: 22, username: 'kali', keyPath: null, source: '~/.ssh/config', notes: [], ...over,
});
const saved = (over = {}) => ({
  id: 'old', name: 'Lab box', folder: 'Work', host: '10.0.0.5', port: 22, username: 'kali',
  auth: 'password', keyPath: null, autoOpenTailscale: true, autoLog: true, ...over,
});
let n = 0;
const newId = () => `new-${++n}`;

test('new sessions start selected and duplicates start skipped', () => {
  const rows = planRows([found(), found({ name: 'other', host: 'other' })], [saved()]);
  assert.equal(rows[0].existing.id, 'old');
  assert.equal(rows[0].selected, false);
  assert.equal(rows[0].action, 'skip');
  assert.equal(rows[1].existing, null);
  assert.equal(rows[1].selected, true);
});

test('a saved session with the same name counts as a duplicate', () => {
  const rows = planRows([found({ name: 'LAB BOX', host: 'elsewhere' })], [saved()]);
  assert.equal(rows[0].existing.id, 'old');
});

test('the same server from two sources is listed once', () => {
  const rows = planRows([found(), found({ source: 'PuTTY' }), found({ name: 'lab2' })], []);
  assert.equal(rows.length, 2);
});

test('sessions without a user start unselected and block import until filled in', () => {
  const rows = planRows([found({ username: '' })], []);
  assert.equal(rows[0].selected, false);
  rows[0].selected = true;
  assert.match(problem(rows), /name and user/);
  rows[0].username = 'root';
  assert.equal(problem(rows), null);
});

test('nothing chosen is a problem', () => {
  assert.match(problem(planRows([found()], [saved()])), /at least one/);
});

test('adding makes new sessions with unique names in the chosen folder', () => {
  const rows = planRows([found({ name: 'Lab box', host: 'h2', keyPath: '/k/id_ed25519' })], [saved()]);
  rows[0].selected = true;
  rows[0].action = 'add';
  const [s] = toSessions(rows, '/Imported/', newId, [saved()]);
  assert.equal(s.name, 'Lab box (2)');
  assert.equal(s.folder, 'Imported');
  assert.equal(s.auth, 'key');
  assert.equal(s.keyPath, '/k/id_ed25519');
  assert.equal(s.autoLog, false);
  assert.match(s.id, /^new-/);
});

test('updating keeps the saved session and its options, changing only the connection', () => {
  const rows = planRows([found({ port: 22, keyPath: '/k/key' })], [saved()]);
  rows[0].selected = true;
  rows[0].action = 'update';
  const [s] = toSessions(rows, 'Imported', newId, [saved()]);
  assert.deepEqual(s, { ...saved(), auth: 'key', keyPath: '/k/key' });
});

test('skipped and unselected rows are not saved', () => {
  const rows = planRows([found(), found({ name: 'b', host: 'b' })], [saved()]);
  rows[1].selected = false;
  assert.deepEqual(toSessions(rows, '', newId, [saved()]), []);
});
