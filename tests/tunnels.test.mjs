import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const t = load('tunnels.ts');
const pick = (f) => f && { kind: f.kind, bindHost: f.bindHost, bindPort: f.bindPort, destHost: f.destHost, destPort: f.destPort };

test('OpenSSH-style specs are read for each kind', () => {
  assert.deepEqual(pick(t.parseSpec('-L 8080:db.internal:5432')), { kind: 'local', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'db.internal', destPort: 5432 });
  assert.deepEqual(pick(t.parseSpec('L 0.0.0.0:8080:db:5432')), { kind: 'local', bindHost: '0.0.0.0', bindPort: 8080, destHost: 'db', destPort: 5432 });
  assert.deepEqual(pick(t.parseSpec('-R 9000:localhost:3000')), { kind: 'remote', bindHost: '127.0.0.1', bindPort: 9000, destHost: 'localhost', destPort: 3000 });
  assert.deepEqual(pick(t.parseSpec('-D 1080')), { kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 1080, destHost: '', destPort: 0 });
  assert.deepEqual(pick(t.parseSpec('-L 8080:[fd00::5]:22')), { kind: 'local', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'fd00::5', destPort: 22 });
  assert.equal(t.parseSpec('-D *:1080').bindHost, '0.0.0.0');
});

test('incomplete or out-of-range specs are rejected', () => {
  for (const bad of ['-L 8080:db', '-X 1:2:3', '-L 70000:db:22', '-L 80:db:0', '-D', 'hello']) assert.equal(t.parseSpec(bad), null, bad);
});

test('loopback is recognised, other addresses are not', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) assert.equal(t.isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.5', '', 'example.com']) assert.equal(t.isLoopback(h), false, h);
});

test('forwards describe themselves in one line', () => {
  const f = { ...t.newForward('local'), bindPort: 8080, destHost: 'db', destPort: 5432 };
  assert.equal(t.describe(f), '127.0.0.1:8080 → db:5432');
  assert.equal(t.describe({ ...f, kind: 'remote' }), 'server 127.0.0.1:8080 → db:5432');
  assert.equal(t.describe({ ...f, kind: 'dynamic', bindHost: '::1' }), 'SOCKS on [::1]:8080');
});

test('remote forwards may let the server pick the port', () => {
  const f = { ...t.newForward('remote'), bindPort: 0, destHost: 'localhost', destPort: 3000 };
  assert.equal(t.forwardProblem(f), null);
  assert.ok(t.forwardProblem({ ...f, kind: 'local' }));
});
