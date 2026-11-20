import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const d = load('diagnostics.ts');
const { Trace, report, redact } = d;
const { Connection } = load('connection.ts', { './diagnostics': d });

const target = { host: 'db.internal.example.com', port: 2222, username: 'alice', jump: null };
const step = (stage, done, detail = null, hop = null) => ({ stage, done, hop, detail });

test('a failed login marks the stage it stopped at, with timings and advice', () => {
  const t = new Trace();
  t.start(target, 1000);
  t.step(step('dns', false), 1000);
  t.step(step('dns', true, '10.1.2.3'), 1012);
  t.step(step('tcp', false), 1012);
  t.step(step('tcp', true, '10.1.2.3:2222'), 1040);
  t.step(step('handshake', false), 1040);
  t.step(step('handshake', true), 1100);
  t.step(step('hostKey', false), 1100);
  t.step(step('hostKey', true, 'ssh-ed25519, already trusted'), 1101);
  t.step(step('auth', false), 1101);
  t.closed('Login to db.internal.example.com failed: no more login methods to try', false, 1500);

  assert.equal(t.outcome, 'failed');
  assert.equal(t.failedStep.stage, 'auth');
  assert.equal(t.failedStep.ms, 399);
  assert.deepEqual(t.steps.map((s) => s.state), ['ok', 'ok', 'ok', 'ok', 'failed']);
  assert.equal(t.steps[0].ms, 12);
  assert.equal(t.summary, 'Failed: log in');
  assert.match(t.advice(), /user name, password or key/);
});

test('advice follows the error at each stage', () => {
  const at = (stage, error, port = 22) => {
    const t = new Trace();
    t.start({ ...target, port }, 0);
    t.step(step(stage, false), 0);
    t.closed(error, false, 5);
    return t.advice();
  };
  assert.match(at('dns', "Couldn't find nowhere.invalid"), /typos/);
  assert.match(at('tcp', 'Connection refused (os error 111)', 2200), /port 2200/);
  assert.match(at('tcp', 'Timed out connecting to x:22'), /didn't answer/);
  assert.match(at('handshake', 'early eof'), /before SSH could start/);
  assert.match(at('hostKey', 'WARNING: the host key for x has CHANGED.'), /identity has changed/);
  assert.match(at('hostKey', 'Host key not trusted'), /wasn't trusted/);
  assert.match(at('auth', 'Login cancelled'), /cancelled/);
  assert.match(at('forward', "The jump host j couldn't reach x:22"), /as the jump host sees it/);
  assert.match(at('shell', 'channel open failure'), /didn't open a shell/);
});

test('a connection that drops after it was up is lost, not failed at a stage', () => {
  const t = new Trace();
  t.start(target, 0);
  for (const s of ['dns', 'tcp', 'handshake', 'hostKey', 'auth', 'shell']) {
    t.step(step(s, false), 0);
    t.step(step(s, true), 1);
  }
  t.connected(2);
  t.closed('The connection was lost', true, 60000);
  assert.equal(t.outcome, 'lost');
  assert.equal(t.failedStep, undefined);
  assert.match(t.advice(), /dropped after it was up/);
});

test('jump host stages are labelled and finish separately from the server', () => {
  const t = new Trace();
  t.start({ ...target, jump: 'bastion' }, 0);
  t.step(step('dns', false, null, 'bastion'), 0);
  t.step(step('dns', true, '192.0.2.1', 'bastion'), 3);
  t.step(step('forward', false), 3);
  t.closed("The jump host bastion couldn't reach db:22", false, 10);
  assert.equal(d.stageLabel(t.steps[0]), 'Jump host: look up the address');
  assert.deepEqual(t.steps.map((s) => s.state), ['ok', 'failed']);
});

test('the report hides host details and tokens unless asked', () => {
  const t = new Trace();
  t.start({ ...target, jump: 'bastion.example.com' }, 0);
  t.step(step('dns', false), 0);
  t.step(step('dns', true, '10.1.2.3'), 4);
  t.step(step('tcp', false), 4);
  t.step(step('tcp', true, '10.1.2.3:2222'), 9);
  t.step(step('handshake', false), 9);
  t.step(step('handshake', true), 20);
  t.step(step('hostKey', false), 20);
  t.closed('WARNING: the host key for db.internal.example.com has CHANGED. Remove line 4 from /home/alice/.local/share/ghostkey/known_hosts. See https://login.tailscale.com/a/abc123SECRET?x=1&token=zzz', false, 30);

  const safe = report(t, { includeHost: false, version: '0.3.0', platform: 'linux' });
  for (const secret of ['db.internal.example.com', 'alice', '10.1.2.3', 'bastion', 'abc123SECRET', 'zzz']) {
    assert.ok(!safe.includes(secret), `${secret} leaked:\n${safe}`);
  }
  assert.match(safe, /GhostKey 0\.3\.0 on linux/);
  assert.match(safe, /\[user\]@\[host\]:2222 via a jump host/);
  assert.match(safe, /\[FAIL\] Check the server's identity \(10 ms\)/);
  assert.match(safe, /\[ok  \] Look up the address \(4 ms\)/);
  assert.match(safe, /~\/\.local\/share\/ghostkey\/known_hosts/);
  assert.match(safe, /Next step: /);

  const full = report(t, { includeHost: true, version: '0.3.0', platform: 'linux' });
  assert.match(full, /alice@db\.internal\.example\.com:2222 via bastion\.example\.com/);
  assert.match(full, /10\.1\.2\.3/);
  assert.ok(!full.includes('abc123SECRET'), 'sign-in tokens are always removed');
});

test('redact removes Windows home folders and query secrets', () => {
  assert.equal(redact('C:\\Users\\Alice\\.ssh\\id_ed25519'), '~\\.ssh\\id_ed25519');
  assert.equal(redact('remove line 2 from /root/.config/x/known_hosts'), 'remove line 2 from ~/.config/x/known_hosts');
  assert.equal(redact('https://x.test/cb?code=123&state=ok'), 'https://x.test/cb?code=[removed]&state=ok');
});

test('a retry starts a fresh trace, so old errors do not linger', async () => {
  let now = 0;
  const attempts = [];
  const conn = new Connection(
    {
      connect(request, event) { return new Promise((resolve) => attempts.push({ event, resolve })); },
      disconnect: async () => {}, resize: async () => {}, sendInput: async () => {}, startLog: async () => {}, stopLog: async () => {},
    },
    {
      write() {}, writeln() {}, reset() {}, fit() {}, focus() {}, size: () => ({ cols: 80, rows: 24 }),
      showBanner() {}, hideBanner() {}, prompt() {}, closePrompts() {}, changed() {}, now: () => now,
    },
  );
  const req = { sessionId: null, host: 'h', port: 22, username: 'u', auth: 'password', keyPath: null, autoOpenTailscale: true, log: false, label: '', forwards: [], jump: null };
  const p = conn.connect(req, 'h');
  attempts[0].resolve(1);
  await p;
  attempts[0].event({ type: 'step', stage: 'tcp', done: false, hop: null, detail: null });
  now = 15000;
  attempts[0].event({ type: 'closed', error: 'Timed out connecting to h:22', lost: false, retryable: true });
  assert.equal(conn.status, 'Failed: open a network connection');
  assert.equal(conn.trace.failedStep.ms, 15000);

  conn.retry();
  await Promise.resolve();
  assert.equal(conn.trace.outcome, 'connecting');
  assert.equal(conn.trace.error, null);
  assert.deepEqual(conn.trace.steps, []);
});
