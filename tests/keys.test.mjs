import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { newKeyProblem, keySummary } = load('keyManager.ts');

test('new key settings are checked before anything is written', () => {
  assert.equal(newKeyProblem({ path: ' ', passphrase: '', confirm: '' }), 'Choose where to save the key.');
  assert.match(newKeyProblem({ path: '/k/id.pub', passphrase: '', confirm: '' }), /adds \.pub/);
  assert.equal(newKeyProblem({ path: '/k/id', passphrase: 'a', confirm: 'b' }), "The passphrases don't match.");
  assert.equal(newKeyProblem({ path: '/k/id', passphrase: 'a', confirm: 'a' }), null);
  assert.equal(newKeyProblem({ path: '/k/id', passphrase: '', confirm: '' }), null);
});

test('key summaries name the type, size, fingerprint and comment', () => {
  assert.equal(
    keySummary({ algorithm: 'ssh-ed25519', bits: 256, fingerprint: 'SHA256:abc', comment: 'me@pc' }),
    'ssh-ed25519 256-bit, SHA256:abc, me@pc',
  );
  assert.equal(keySummary({ algorithm: 'ssh-rsa', bits: null, fingerprint: 'SHA256:x', comment: '' }), 'ssh-rsa, SHA256:x');
});
