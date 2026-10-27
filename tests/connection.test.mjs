import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the real UI handlers with a fake native bridge and minimal DOM.
function client() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', value: '', addEventListener(event, fn) { this[event] = fn; } });
    return nodes.get(id);
  };
  const attempts = [], disconnected = [];
  class Terminal {
    cols = 80; rows = 24;
    loadAddon() {} reset() {} writeln() {} write() {} focus() {}
    onData() {} onResize() {} attachCustomKeyEventHandler() {}
  }
  const context = vm.createContext({
    document: { getElementById: node }, Terminal,
    FitAddon: class { fit() {} }, WebLinksAddon: class {},
    DEFAULT_FONT_SIZE: 14, FONT_FAMILY: '', kaliDark: {},
    localStorage: { getItem() { return null; } },
    confirm: async () => true,
    api: {
      connect(request, event, output) {
        return new Promise((resolve, reject) => attempts.push({ request, event, output, resolve, reject }));
      },
      disconnect(id) { disconnected.push(id); return Promise.resolve(); },
      resize() { return Promise.resolve(); },
    },
  });
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^start\(\);$/m, '')
    + '\nglobalThis.handlers = { connectTo, disconnect, setStatus };';
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return { ...context.handlers, node, attempts, disconnected };
}
const request = { sessionId: 'saved', host: 'host', port: 22, username: 'user', auth: 'password', keyPath: null, autoOpenTailscale: true };

test('failed connection exposes retry and reuses connection settings', async () => {
  const c = client();
  const first = c.connectTo(request, 'Lab');
  c.attempts[0].reject('offline');
  await first;
  assert.equal(c.node('reconnect').hidden, false);
  assert.equal(c.node('reconnect').textContent, 'Retry connection');
  c.node('reconnect').click();
  assert.equal(c.attempts.length, 2);
  assert.equal(c.attempts[1].request.host, 'host');
  assert.equal(c.attempts[1].request.sessionId, 'saved');
  assert.equal(c.attempts[1].request.autoOpenTailscale, true);
  assert.equal(c.node('reconnect').hidden, true);
  c.attempts[1].resolve(2);
});

test('established connection exposes reconnect after remote close', async () => {
  const c = client();
  const first = c.connectTo(request, 'Lab');
  c.attempts[0].resolve(1);
  await first;
  c.attempts[0].event({ type: 'connected' });
  assert.equal(c.node('disconnect').textContent, 'Disconnect');
  c.attempts[0].event({ type: 'closed', error: 'lost connection' });
  assert.equal(c.node('reconnect').hidden, false);
  assert.equal(c.node('reconnect').textContent, 'Reconnect');
});

test('cancelled pending connection is cleaned up and cannot overwrite retry', async () => {
  const c = client();
  const first = c.connectTo(request, 'Old');
  assert.equal(c.node('disconnect').textContent, 'Cancel');
  c.disconnect();
  const second = c.connectTo(request, 'New');
  c.attempts[0].resolve(1);
  await first;
  assert.deepEqual(c.disconnected, [1]);
  c.attempts[0].event({ type: 'connected' });
  assert.equal(c.node('conn-title').textContent, 'New');
  c.attempts[1].resolve(2);
  await second;
});

test('late failure from cancelled attempt cannot overwrite current status', async () => {
  const c = client();
  const first = c.connectTo(request, 'Old');
  c.disconnect();
  const second = c.connectTo(request, 'New');
  c.attempts[0].reject('old failure');
  await first;
  assert.equal(c.node('conn-title').textContent, 'New');
  assert.equal(c.node('conn-status').textContent, 'Connecting…');
  c.attempts[1].resolve(2);
  await second;
});

test('asynchronous connection failure allows only one retry at a time', async () => {
  const c = client();
  const first = c.connectTo(request, 'Lab');
  c.attempts[0].resolve(1);
  await first;
  c.attempts[0].event({ type: 'closed', error: 'authentication failed' });
  assert.equal(c.node('reconnect').textContent, 'Retry connection');
  c.node('reconnect').click();
  c.node('reconnect').click();
  assert.equal(c.attempts.length, 2);
  c.attempts[1].resolve(2);
});

test('manual disconnect offers reconnect and ignores subsequent old events', async () => {
  const c = client();
  const first = c.connectTo(request, 'Lab');
  c.attempts[0].resolve(1);
  await first;
  c.attempts[0].event({ type: 'connected' });
  c.disconnect();
  assert.deepEqual(c.disconnected, [1]);
  assert.equal(c.node('reconnect').textContent, 'Reconnect');
  c.attempts[0].event({ type: 'status', message: 'stale' });
  assert.equal(c.node('conn-status').textContent, 'Disconnected');
});
