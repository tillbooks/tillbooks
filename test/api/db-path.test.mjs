// D12: the Studio and the agent must land on ONE database. That is only true if every face resolves
// the path the same way, so the resolution rule itself is the thing under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDbPath, defaultDbPath, MEMORY_DB } from '../../dist/api/db-path.js';

test('TILL_DB_PATH wins when it names a path', () => {
  assert.equal(resolveDbPath({ TILL_DB_PATH: '/tmp/books.db' }), '/tmp/books.db');
});

test('the default is ~/.till/till.db: the same file whatever directory a process starts in', () => {
  // A support dir with no adopted book (D166 point 8), so a book.json on this machine cannot leak in.
  const noAdopted = { TILL_SUPPORT_DIR: mkdtempSync(join(tmpdir(), 'till-dbpath-')) };
  assert.equal(resolveDbPath(noAdopted), join(homedir(), '.till', 'till.db'));
  assert.equal(defaultDbPath(), resolveDbPath(noAdopted));
});

test('a blank TILL_DB_PATH is a misconfiguration, not a request for a file named ""', () => {
  const noAdopted = mkdtempSync(join(tmpdir(), 'till-dbpath-'));
  assert.equal(resolveDbPath({ TILL_DB_PATH: '', TILL_SUPPORT_DIR: noAdopted }), defaultDbPath());
  assert.equal(resolveDbPath({ TILL_DB_PATH: '   ', TILL_SUPPORT_DIR: noAdopted }), defaultDbPath());
});

test(':memory: is honoured verbatim, for a throwaway run', () => {
  assert.equal(resolveDbPath({ TILL_DB_PATH: MEMORY_DB }), MEMORY_DB);
});
