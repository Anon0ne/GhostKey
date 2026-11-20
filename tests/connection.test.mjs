import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const diagnostics = load('diagnostics.ts');
const { Connection } = load('connection.ts', { './diagnostics': diagnostics });

// A Connection with a fake native bridge that records every call.
function client(extraHooks = {}) {
  const attempts = [], disconnected = [], sent = [], resized = [], logCalls = [], lines = [];
  const api = {
    connect(request, event, output) {
      return new Promise((resolve, reject) => attempts.push({ request, event, output, resolve, reject }));
    },
    disconnect(id) { disconnected.push(id); return Promise.resolve(); },
    resize(id, cols, rows) { resized.push([id, cols, rows]); return Promise.resolve(); },
    sendInput(id, data) { sent.push([id, data]); return Promise.resolve(); },
    startLog(id) { logCalls.push(['start', id]); return Promise.resolve(); },
    stopLog(id) { logCalls.push(['stop', id]); return Promise.resolve(); },
  };
  let promptsClosed = 0;
  const hooks = {
    write() {}, writeln(s) { lines.push(s); }, reset() {}, fit() {}, focus() {},
    size: () => ({ cols: 80, rows: 24 }),
    showBanner() {}, hideBanner() {}, prompt() {},
    closePrompts() { promptsClosed++; }, changed() {},
    ...extraHooks,
  };
  const conn = new Connection(api, hooks);
  return { conn, attempts, disconnected, sent, resized, logCalls, lines, promptsClosed: () => promptsClosed };
}
const request = { sessionId: 'saved', host: 'host', port: 22, username: 'user', auth: 'password', keyPath: null, autoOpenTailscale: true, log: false, label: 'Lab' };

async function online(c, id = 1) {
  const p = c.conn.connect(request, 'Lab');
  c.attempts.at(-1).resolve(id);
  await p;
  c.attempts.at(-1).event({ type: 'connected' });
}

// A client that reconnects on its own, with timers the test fires by hand.
function recovering() {
  const timers = [];
  const c = client({
    autoReconnect: () => true,
    schedule(fn, ms) {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
  });
  const fire = () => {
    const t = timers.filter((x) => !x.cancelled).at(-1);
    t.cancelled = true;
    t.fn();
  };
  return { ...c, timers, fire };
}

test('a lost connection reconnects on its own with growing waits', async () => {
  const c = recovering();
  await online(c);
  c.attempts[0].event({ type: 'closed', error: 'link down', lost: true, retryable: true });
  assert.equal(c.conn.recovering, true);
  assert.equal(c.conn.active, true);
  assert.equal(c.conn.stopLabel, 'Cancel');
  assert.equal(c.conn.retryLabel, 'Reconnect now');
  assert.equal(c.timers[0].ms, 2000);
  assert.match(c.conn.status, /Reconnecting in 2 s \(try 1 of 5\)/);
  c.fire();
  assert.equal(c.attempts.length, 2);
  // The network is still down: the next wait is longer.
  c.attempts[1].resolve(2);
  await Promise.resolve();
  c.attempts[1].event({ type: 'closed', error: 'unreachable', lost: false, retryable: true });
  assert.equal(c.timers[1].ms, 4000);
  c.fire();
  c.attempts[2].resolve(3);
  await Promise.resolve();
  c.attempts[2].event({ type: 'connected' });
  assert.equal(c.conn.online, true);
  assert.equal(c.conn.recovering, false);
  assert.ok(c.lines.some((l) => l.includes('new shell')));
  // Settings are reused, and a later drop starts counting from the first try again.
  assert.equal(c.attempts[2].request.sessionId, 'saved');
  c.attempts[2].event({ type: 'closed', error: 'again', lost: true, retryable: true });
  assert.equal(c.timers.at(-1).ms, 2000);
});

test('reconnecting gives up after the last try and on a refused login', async () => {
  const c = recovering();
  await online(c);
  c.attempts[0].event({ type: 'closed', error: 'down', lost: true, retryable: true });
  for (let i = 1; i <= 5; i++) {
    c.fire();
    c.attempts[i].resolve(i + 1);
    await Promise.resolve();
    c.attempts[i].event({ type: 'closed', error: 'unreachable', lost: false, retryable: true });
  }
  assert.equal(c.conn.recovering, false);
  assert.equal(c.conn.state, 'error');
  assert.equal(c.attempts.length, 6);
  assert.ok(c.lines.some((l) => l.includes('Gave up')));

  const d = recovering();
  await online(d);
  d.attempts[0].event({ type: 'closed', error: 'down', lost: true, retryable: true });
  d.fire();
  d.attempts[1].resolve(2);
  await Promise.resolve();
  d.attempts[1].event({ type: 'closed', error: 'Login cancelled', lost: false, retryable: false });
  assert.equal(d.conn.recovering, false);
  assert.equal(d.timers.filter((t) => !t.cancelled).length, 0);
  assert.equal(d.conn.canRetry, true);
});

test('cancelling the wait stops reconnecting, and a shell exit never reconnects', async () => {
  const c = recovering();
  await online(c);
  c.attempts[0].event({ type: 'closed', error: 'down', lost: true, retryable: true });
  c.conn.disconnect();
  assert.equal(c.conn.recovering, false);
  assert.equal(c.conn.active, false);
  assert.equal(c.timers[0].cancelled, true);
  assert.equal(c.attempts.length, 1);

  const e = recovering();
  await online(e);
  e.attempts[0].event({ type: 'closed', error: null, lost: false, retryable: false });
  assert.equal(e.timers.length, 0);
  assert.equal(e.conn.state, 'idle');

  // Off in Settings: a lost connection just offers Reconnect.
  const f = client({ autoReconnect: () => false });
  await online(f);
  f.attempts[0].event({ type: 'closed', error: 'down', lost: true, retryable: true });
  assert.equal(f.conn.recovering, false);
  assert.equal(f.conn.status, 'Connection lost');
});

test('reconnect now skips the wait, and a late event from the old attempt is ignored', async () => {
  const c = recovering();
  await online(c);
  c.attempts[0].event({ type: 'closed', error: 'down', lost: true, retryable: true });
  c.conn.retry();
  assert.equal(c.timers[0].cancelled, true);
  assert.equal(c.attempts.length, 2);
  c.attempts[0].event({ type: 'connected' });
  assert.equal(c.conn.connected, false);
  c.attempts[1].resolve(2);
  await Promise.resolve();
  c.attempts[1].event({ type: 'connected' });
  assert.equal(c.conn.online, true);
});

test('failed connection exposes retry and reuses connection settings', async () => {
  const c = client();
  const first = c.conn.connect(request, 'Lab');
  c.attempts[0].reject('offline');
  await first;
  assert.equal(c.conn.canRetry, true);
  assert.equal(c.conn.retryLabel, 'Retry connection');
  assert.equal(c.conn.state, 'error');
  c.conn.retry();
  assert.equal(c.attempts.length, 2);
  assert.equal(c.attempts[1].request.host, 'host');
  assert.equal(c.attempts[1].request.sessionId, 'saved');
  assert.equal(c.attempts[1].request.autoOpenTailscale, true);
  assert.equal(c.attempts[1].request.cols, 80);
  assert.equal(c.conn.canRetry, false);
  c.attempts[1].resolve(2);
});

test('established connection exposes reconnect after remote close', async () => {
  const c = client();
  await online(c);
  assert.equal(c.conn.stopLabel, 'Disconnect');
  assert.deepEqual(c.resized, [[1, 80, 24]]);
  c.attempts[0].event({ type: 'closed', error: 'lost connection' });
  assert.equal(c.conn.canRetry, true);
  assert.equal(c.conn.retryLabel, 'Reconnect');
  assert.equal(c.conn.state, 'error');
});

test('cancelled pending connection is cleaned up and cannot overwrite the new one', async () => {
  const c = client();
  const first = c.conn.connect(request, 'Old');
  assert.equal(c.conn.stopLabel, 'Cancel');
  c.conn.disconnect();
  const second = c.conn.connect(request, 'New');
  c.attempts[0].resolve(1);
  await first;
  assert.deepEqual(c.disconnected, [1]);
  c.attempts[0].event({ type: 'connected' });
  assert.equal(c.conn.title, 'New');
  assert.equal(c.conn.connected, false);
  c.attempts[1].resolve(2);
  await second;
  assert.equal(c.conn.id, 2);
});

test('late failure from cancelled attempt cannot overwrite current status', async () => {
  const c = client();
  const first = c.conn.connect(request, 'Old');
  c.conn.disconnect();
  const second = c.conn.connect(request, 'New');
  c.attempts[0].reject('old failure');
  await first;
  assert.equal(c.conn.title, 'New');
  assert.equal(c.conn.status, 'Connecting…');
  c.attempts[1].resolve(2);
  await second;
});

test('connecting again while active disconnects the old connection first', async () => {
  const c = client();
  await online(c);
  const next = c.conn.connect(request, 'Other');
  assert.deepEqual(c.disconnected, [1]);
  c.attempts[0].event({ type: 'status', message: 'stale' });
  assert.equal(c.conn.status, 'Connecting…');
  c.attempts[1].resolve(2);
  await next;
});

test('asynchronous connection failure allows only one retry at a time', async () => {
  const c = client();
  const first = c.conn.connect(request, 'Lab');
  c.attempts[0].resolve(1);
  await first;
  c.attempts[0].event({ type: 'closed', error: 'authentication failed' });
  assert.equal(c.conn.retryLabel, 'Retry connection');
  c.conn.retry();
  c.conn.retry();
  assert.equal(c.attempts.length, 2);
  c.attempts[1].resolve(2);
});

test('manual disconnect offers reconnect and ignores subsequent old events', async () => {
  const c = client();
  await online(c);
  c.conn.disconnect();
  assert.deepEqual(c.disconnected, [1]);
  assert.equal(c.conn.retryLabel, 'Reconnect');
  assert.ok(c.promptsClosed() > 0);
  c.attempts[0].event({ type: 'status', message: 'stale' });
  assert.equal(c.conn.status, 'Disconnected');
});

test('input and resize reach only an open connection', async () => {
  const c = client();
  c.conn.input('ignored');
  const p = c.conn.connect(request, 'Lab');
  c.conn.input('too early');
  c.attempts[0].resolve(7);
  await p;
  c.conn.input('still logging in');
  c.attempts[0].event({ type: 'connected' });
  c.conn.input('ls\r');
  c.conn.disconnect();
  c.conn.input('after');
  c.conn.resize(100, 30);
  assert.deepEqual(c.sent, [[7, 'ls\r']]);
  assert.deepEqual(c.resized, [[7, 80, 24]]);
});

test('log toggle follows what the backend reports', async () => {
  const c = client();
  c.conn.toggleLog();
  assert.deepEqual(c.logCalls, []);
  await online(c, 3);
  c.conn.toggleLog();
  assert.deepEqual(c.logCalls, [['start', 3]]);
  assert.equal(c.conn.logPath, null);
  c.attempts[0].event({ type: 'logging', path: '/logs/Lab.log', error: null });
  assert.equal(c.conn.logPath, '/logs/Lab.log');
  c.conn.toggleLog();
  assert.deepEqual(c.logCalls, [['start', 3], ['stop', 3]]);
  c.attempts[0].event({ type: 'logging', path: null, error: null });
  assert.equal(c.conn.logPath, null);
});

test('log errors are shown without dropping the connection', async () => {
  const c = client();
  await online(c);
  c.attempts[0].event({ type: 'logging', path: '/logs/Lab.log', error: null });
  c.attempts[0].event({ type: 'logging', path: null, error: 'Logging stopped: disk full' });
  assert.equal(c.conn.logPath, null);
  assert.equal(c.conn.online, true);
  assert.ok(c.lines.some((l) => l.includes('disk full')));
});

test('closing the connection clears the log state', async () => {
  const c = client();
  await online(c);
  c.attempts[0].event({ type: 'logging', path: '/logs/Lab.log', error: null });
  c.attempts[0].event({ type: 'closed', error: null });
  assert.equal(c.conn.logPath, null);
  assert.equal(c.conn.state, 'idle');
});

// ------------------------------------------------------------ split layout

const layout = load('layout.ts');

test('splitting and closing panes keeps the rest of the layout', () => {
  let root = layout.leaf('a');
  root = layout.split(root, 'a', 'b', 'row');
  root = layout.split(root, 'b', 'c', 'column');
  assert.deepEqual(layout.panes(root), ['a', 'b', 'c']);
  assert.equal(root.dir, 'row');
  assert.equal(root.b.dir, 'column');
  root = layout.remove(root, 'b');
  assert.deepEqual(layout.panes(root), ['a', 'c']);
  assert.equal(root.dir, 'row');
  root = layout.remove(root, 'a');
  assert.deepEqual(root, layout.leaf('c'));
  assert.equal(layout.remove(root, 'c'), null);
});

test('split ratios stay within bounds', () => {
  assert.equal(layout.clampRatio(-1), layout.MIN_RATIO);
  assert.equal(layout.clampRatio(2), 1 - layout.MIN_RATIO);
  assert.equal(layout.clampRatio(0.3), 0.3);
});

test('moving focus picks the adjacent pane', () => {
  // a | b
  //   | c
  const rects = [
    { left: 0, top: 0, width: 50, height: 100 },
    { left: 50, top: 0, width: 50, height: 50 },
    { left: 50, top: 50, width: 50, height: 50 },
  ];
  assert.equal(layout.nearest(rects, 0, 'right'), 1);
  assert.equal(layout.nearest(rects, 2, 'left'), 0);
  assert.equal(layout.nearest(rects, 1, 'down'), 2);
  assert.equal(layout.nearest(rects, 2, 'up'), 1);
  assert.equal(layout.nearest(rects, 0, 'left'), null);
  assert.equal(layout.nearest(rects, 1, 'up'), null);
});
