// D12: the Studio and the agent must land on ONE database. That is only true if every face resolves
// the path the same way, so the resolution rule itself is the thing under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveDbPath, defaultDbPath, MEMORY_DB } from '../../dist/api/db-path.js';

test('TILL_DB_PATH wins when it names a path', () => {
  assert.equal(resolveDbPath({ TILL_DB_PATH: '/tmp/books.db' }), '/tmp/books.db');
});

test('the default is ~/.till/till.db: the same file whatever directory a process starts in', () => {
  assert.equal(resolveDbPath({}), join(homedir(), '.till', 'till.db'));
  assert.equal(defaultDbPath(), resolveDbPath({}));
});

test('a blank TILL_DB_PATH is a misconfiguration, not a request for a file named ""', () => {
  assert.equal(resolveDbPath({ TILL_DB_PATH: '' }), defaultDbPath());
  assert.equal(resolveDbPath({ TILL_DB_PATH: '   ' }), defaultDbPath());
});

test(':memory: is honoured verbatim, for a throwaway run', () => {
  assert.equal(resolveDbPath({ TILL_DB_PATH: MEMORY_DB }), MEMORY_DB);
});
