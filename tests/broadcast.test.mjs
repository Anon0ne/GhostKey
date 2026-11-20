import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { Broadcast } = load('broadcast.ts');
const pane = (id, online = true) => ({ conn: { id, online } });

test('broadcast reaches only chosen, still-connected panes', () => {
  const b = new Broadcast();
  const [a, c, d, off] = [pane(1), pane(2), pane(3), pane(4, false)];
  b.choose([a, c, off]);
  assert.equal(b.on, true);
  assert.deepEqual(b.members(), [a, c]);
  // Typing in a member reaches every member; typing elsewhere stays put.
  assert.deepEqual(b.targets(a), [a, c]);
  assert.deepEqual(b.targets(d), [d]);
  assert.equal(b.has(d), false);
});

test('a pane that reconnects leaves the group and does not rejoin on its own', () => {
  const b = new Broadcast();
  const [a, c, d] = [pane(1), pane(2), pane(3)];
  b.choose([a, c, d]);
  c.conn.id = 22; // reconnected: a new connection
  assert.deepEqual(b.members(), [a, d]);
  b.prune();
  c.conn.id = 2; // even the same id later is not trusted
  assert.deepEqual(b.members(), [a, d]);
  d.conn.online = false; // partial disconnect leaves one: broadcast ends
  assert.deepEqual(b.members(), []);
  assert.equal(b.on, false);
  assert.deepEqual(b.targets(a), [a]);
});

test('choosing fewer than two panes, stopping, and closing panes', () => {
  const b = new Broadcast();
  const [a, c, d] = [pane(1), pane(2), pane(3)];
  b.choose([a]);
  assert.equal(b.on, false);
  b.choose([a, c, d]);
  b.drop(d);
  assert.deepEqual(b.members(), [a, c]);
  b.stop();
  assert.equal(b.on, false);
  assert.deepEqual(b.targets(a), [a]);
});
