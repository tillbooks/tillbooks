// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, getEntry } from '../../dist/core/ledger/index.js';
import { setup, simpleEntry } from './support.mjs';
import { countOf, errOf, id, obj, okOf, rows } from '../support/narrow.mjs';

test('reversing a posted entry creates a mirror that nets to zero per account', () => {
  const { ctx, store, accounts } = setup();
  const posted = postEntry(ctx, simpleEntry(accounts, 5000, 'k-post'));
  const postedId = id(posted, 'entryId', 'postEntry');

  const rev = reverseEntry(ctx, { entryId: postedId, idempotencyKey: 'k-rev' });
  const reversalId = id(rev, 'reversalId', 'reverseEntry');

  const read = obj(okOf(getEntry(ctx, { entryId: reversalId }), 'getEntry').entry, 'getEntry.entry');
  assert.equal(read.status, 'posted');
  assert.equal(read.source, 'reversal');
  assert.equal(read.reversesEntryId, postedId);

  const nets = rows(
    store.db
      .prepare('SELECT account_id, SUM(base_debit_minor - base_credit_minor) AS net FROM journal_line GROUP BY account_id')
      .all(),
    'per-account nets',
  );
  for (const r of nets) {
    assert.equal(r.net, 0, `account ${r.account_id} should net to zero after reversal`);
  }
});

test('a posted entry cannot be reversed twice', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, simpleEntry(accounts, 5000, 'k-post'));
  assert.equal(reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'k1' }).ok, true);

  const second = reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'k2' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_reversed');
});

test('reversing is idempotent: the same key returns the same reversal, not a second one', () => {
  const { ctx, store, accounts } = setup();
  const posted = postEntry(ctx, simpleEntry(accounts, 5000, 'k-post'));
  const a = reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'k-rev' });
  const b = reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'k-rev' });
  assert.equal(a.ok, true);
  assert.deepEqual(b, a);
  assert.equal(
    countOf(store.db, "SELECT COUNT(*) AS c FROM journal_entry WHERE source = 'reversal'"),
    1,
  );
});

test('reversing a draft entry is rejected (not_posted)', () => {
  const { ctx, store } = setup();
  store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES (?, ?, ?, 'draft', 'manual', ?)",
    )
    .run('entry_draft', 'ws_1', '2026-03-01', '2026-07-16T00:00:00.000Z');
  const draftTarget = reverseEntry(ctx, { entryId: 'entry_draft', idempotencyKey: 'k' });
  assert.equal(errOf(draftTarget, 'reverseEntry').error, 'not_posted');
});

test('reversing a nonexistent entry is not_found', () => {
  const { ctx } = setup();
  const missing = reverseEntry(ctx, { entryId: 'nope', idempotencyKey: 'k' });
  assert.equal(errOf(missing, 'reverseEntry').error, 'not_found');
});
