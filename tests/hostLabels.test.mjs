import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { parseTags, matchesSearch, envBadge, isProduction, MAX_TAGS } = load('hostLabels.ts');

test('tags are parsed from spaces, commas and #, without repeats', () => {
  assert.deepEqual(parseTags('#web, db  WEB #db,, client-a'), ['web', 'db', 'client-a']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ')).length, MAX_TAGS);
  assert.equal(parseTags('x'.repeat(50))[0].length, 32);
});

test('search matches every word against names, hosts, tags and the environment', () => {
  const s = { name: 'Billing DB', folder: 'Work', host: 'db1.example.com', username: 'postgres', tags: ['client-a', 'db'], environment: 'production' };
  assert.ok(matchesSearch(s, 'billing'));
  assert.ok(matchesSearch(s, '#client'));
  assert.ok(matchesSearch(s, 'prod'));
  assert.ok(matchesSearch(s, 'production #db'));
  assert.ok(matchesSearch(s, 'work postgres'));
  assert.ok(!matchesSearch(s, '#work'), '#work only matches tags');
  assert.ok(!matchesSearch(s, 'billing staging'));
  assert.ok(matchesSearch({ name: 'a', folder: '', host: 'h', username: 'u' }, 'a'), 'older sessions without tags still match');
});

test('badges use text and an icon, not only color', () => {
  assert.equal(envBadge('production'), '⚠ PROD');
  assert.equal(envBadge('lab'), '⚗ LAB');
  assert.equal(envBadge(''), '');
  assert.equal(envBadge(undefined), '');
  assert.ok(isProduction('production') && !isProduction('staging'));
});
