// @ts-check
// Regression tests for the second-round (fix-verification) findings on A02.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { setup, simpleEntry } from './support.mjs';
import { countOf, id, obj, okOf } from '../support/narrow.mjs';

// CRITICAL: INSERT OR REPLACE / REPLACE routed around the immutability triggers.
test('R3: INSERT OR REPLACE cannot overwrite a posted entry (F-replace)', () => {
  const { ctx, store, accounts } = setup();
  const p = postEntry(ctx, simpleEntry(accounts, 5000, 'kp'));
  assert.throws(
    () =>
      store.db
        .prepare(
          "INSERT OR REPLACE INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES (?, 'ws_1', '1999-01-01', 'posted', 'import', 'x')",
        )
        .run(id(p, 'entryId', 'postEntry')),
    /posted_immutable/,
  );
  assert.throws(
    () =>
      store.db
        .prepare(
          "REPLACE INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES (?, 'ws_1', '1999-01-01', 'draft', 'import', 'x')",
        )
        .run(id(p, 'entryId', 'postEntry')),
    /posted_immutable/,
  );
  const reread = obj(okOf(getEntry(ctx, { entryId: id(p, 'entryId', 'postEntry') }), 'getEntry').entry, 'getEntry.entry');
  assert.equal(reread.date, '2026-03-01');
});

// MEDIUM: reverse_entry idempotency collided across different targets sharing a key.
test('reversing two different entries with the same key reverses both (F-revkey)', () => {
  const { ctx, store, accounts } = setup();
  const t1 = postEntry(ctx, simpleEntry(accounts, 5000, 'p1'));
  const t2 = postEntry(ctx, simpleEntry(accounts, 7000, 'p2'));
  const r1 = reverseEntry(ctx, { entryId: id(t1, 'entryId', 'postEntry'), idempotencyKey: 'SAME' });
  const r2 = reverseEntry(ctx, { entryId: id(t2, 'entryId', 'postEntry'), idempotencyKey: 'SAME' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.reversalId, r2.reversalId);
  assert.equal(countOf(store.db, "SELECT COUNT(*) AS c FROM journal_entry WHERE source = 'reversal'"), 2);
  // a retry of t1 with the same key still replays r1, not a third reversal
  assert.deepEqual(reverseEntry(ctx, { entryId: id(t1, 'entryId', 'postEntry'), idempotencyKey: 'SAME' }), r1);
});

// LOW: a direct source='reversal' post whose lines are not the true mirror.
test('a reversal post whose lines are not the true mirror is rejected (F-mirror)', () => {
  const { ctx, accounts } = setup();
  const target = postEntry(ctx, simpleEntry(accounts, 5000, 'kt'));
  const fake = postEntry(ctx, {
    date: '2026-03-01',
    description: 'fake',
    source: 'reversal',
    reversesEntryId: id(target, 'entryId', 'postEntry'),
    idempotencyKey: 'kf',
    lines: [
      { account: accounts['1020'], debit: 5000 },
      { account: accounts['3000'], credit: 5000 },
    ],
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.error, 'not_a_mirror');
  assert.equal(reverseEntry(ctx, { entryId: id(target, 'entryId', 'postEntry'), idempotencyKey: 'kr' }).ok, true);
});

// LOW: structurally malformed input must not throw.
//
// Every `@ts-expect-error` below marks input `PostEntryInput` and `SaveDraftInput` DECLARE to be
// impossible, which is the entire subject of this test: a caller that is not the compiler, an MCP
// client or a hand-written JSON body, can send it anyway, and the engine has to answer with a
// structured rejection rather than a stack trace. The directives are load bearing in both
// directions. If one of these shapes ever becomes legal (say `lines` is widened to optional), its
// directive goes unused, `tsc` reports TS2578, and someone has to decide whether the engine still
// rejects what the type now permits.
test('structurally malformed input returns a structured error, never throws (F-shape)', () => {
  const { ctx, accounts } = setup();
  assert.equal(
    // @ts-expect-error `lines` is required: this is the untyped caller sending no lines at all
    postEntry(ctx, { date: '2026-03-01', description: 'x', source: 'manual', idempotencyKey: 'k1', lines: undefined }).ok,
    false,
  );
  assert.equal(
    postEntry(ctx, {
      date: '2026-03-01',
      description: 'x',
      source: 'manual',
      idempotencyKey: 'k2',
      lines: [
        // @ts-expect-error `account` is a string id: this is an object arriving where an id belongs
        { account: {}, debit: 100 },
        { account: accounts['1000'], credit: 100 },
      ],
    }).ok,
    false,
  );
  assert.equal(
    // @ts-expect-error same non-string `account`, on the draft path, which validates separately
    saveDraft(ctx, { date: '2026-03-01', description: 'x', idempotencyKey: 'k3', lines: [{ account: {}, debit: 100 }] }).ok,
    false,
  );
});
