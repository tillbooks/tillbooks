// @ts-check
// Regression tests for the adversarial-critic findings on A02. Each maps to a confirmed defect.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { setup, simpleEntry } from './support.mjs';
import { countOf, errOf, id, obj, okOf } from '../support/narrow.mjs';

const twoLines = (accounts, amt = 5000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

// Finding 1: cross-verb idempotency-key collision.
test('an idempotency key used for saveDraft does not swallow a later postEntry (F1)', () => {
  const { ctx, accounts } = setup();
  const d = saveDraft(ctx, { date: '2026-03-01', description: 'doc', idempotencyKey: 'doc-1', lines: twoLines(accounts) });
  const p = postEntry(ctx, {
    entryId: id(d, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'doc',
    source: 'manual',
    idempotencyKey: 'doc-1',
    lines: twoLines(accounts),
  });
  assert.equal(p.ok, true);
  const reread = obj(okOf(getEntry(ctx, { entryId: id(d, 'entryId', 'saveDraft') }), 'getEntry').entry, 'getEntry.entry');
  assert.equal(reread.status, 'posted');
});

test('rememberIdempotent is scoped per verb at the store layer (F1)', () => {
  const store = new SqliteStore();
  let a = 0;
  let b = 0;
  const ra = store.rememberIdempotent('ws_1', 'k', 'verbA', () => {
    a++;
    return { ok: true, v: 'a' };
  });
  const rb = store.rememberIdempotent('ws_1', 'k', 'verbB', () => {
    b++;
    return { ok: true, v: 'b' };
  });
  assert.equal(ra.v, 'a');
  assert.equal(rb.v, 'b');
  assert.equal(a, 1);
  assert.equal(b, 1);
  store.close();
});

test('reversing with the same key as the original post still writes the reversal (F1)', () => {
  const { ctx, store, accounts } = setup();
  const p = postEntry(ctx, simpleEntry(accounts, 5000, 'shared'));
  const r = reverseEntry(ctx, { entryId: id(p, 'entryId', 'postEntry'), idempotencyKey: 'shared' });
  assert.equal(r.ok, true);
  assert.equal(countOf(store.db, "SELECT COUNT(*) AS c FROM journal_entry WHERE source = 'reversal'"), 1);
});

// Finding 2: caller-supplied reversesEntryId / unvalidated source.
test('postEntry rejects a reversesEntryId supplied with a non-reversal source (F2)', () => {
  const { ctx, accounts } = setup();
  const target = postEntry(ctx, simpleEntry(accounts, 5000, 'k-target'));
  const poison = postEntry(ctx, {
    date: '2026-03-01',
    description: 'poison',
    source: 'manual',
    reversesEntryId: id(target, 'entryId', 'postEntry'),
    idempotencyKey: 'k-poison',
    lines: twoLines(accounts),
  });
  assert.equal(poison.ok, false);
  assert.equal(poison.error, 'invalid_source');
  // the legitimate correction is still available
  assert.equal(reverseEntry(ctx, { entryId: id(target, 'entryId', 'postEntry'), idempotencyKey: 'k-rev' }).ok, true);
});

test('postEntry rejects an unknown source (F2)', () => {
  const { ctx, accounts } = setup();
  const res = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'wat',
    idempotencyKey: 'k',
    lines: twoLines(accounts),
  });
  assert.equal(errOf(res, 'postEntry with an unknown source').error, 'invalid_source');
});

test('a direct reversal post of an already-reversed entry is rejected (F2/F6)', () => {
  const { ctx, accounts } = setup();
  const target = postEntry(ctx, simpleEntry(accounts, 5000, 'kt'));
  reverseEntry(ctx, { entryId: id(target, 'entryId', 'postEntry'), idempotencyKey: 'kr' });
  const dup = postEntry(ctx, {
    date: '2026-03-01',
    description: 'dup',
    source: 'reversal',
    reversesEntryId: id(target, 'entryId', 'postEntry'),
    idempotencyKey: 'kd',
    lines: [
      { account: accounts['1000'], debit: 5000 },
      { account: accounts['6500'], credit: 5000 },
    ],
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'already_reversed');
});

// Findings 4 and 5: amount bounds and structured errors.
test('an amount beyond the safe-integer range is rejected as invalid_line (F4/F5)', () => {
  const { ctx, accounts } = setup();
  assert.equal(
    errOf(
      postEntry(ctx, {
        date: '2026-03-01',
        description: 'x',
        source: 'manual',
        idempotencyKey: 'k1',
        lines: [
          { account: accounts['6500'], debit: 1e21 },
          { account: accounts['1000'], credit: 1e21 },
        ],
      }),
      'postEntry at 1e21',
    ).error,
    'invalid_line',
  );
  assert.equal(
    errOf(
      postEntry(ctx, {
        date: '2026-03-01',
        description: 'x',
        source: 'manual',
        idempotencyKey: 'k2',
        lines: [
          { account: accounts['6500'], debit: 2 ** 53 },
          { account: accounts['1000'], credit: 2 ** 53 },
        ],
      }),
      'postEntry at 2^53',
    ).error,
    'invalid_line',
  );
});

test('saveDraft with an entryId that is not a draft here returns a structured error, never throws (F4)', () => {
  const { ctx } = setup();
  const res = saveDraft(ctx, {
    entryId: 'nonexistent',
    date: '2026-03-01',
    description: 'x',
    idempotencyKey: 'k',
    lines: [],
  });
  assert.equal(res.ok, false);
  assert.ok(res.error === 'not_found' || res.error === 'not_a_draft');
});

test('a reversal targeting a nonexistent entry returns a structured error, not an FK throw (F4)', () => {
  const { ctx, accounts } = setup();
  const res = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'reversal',
    reversesEntryId: 'ghost',
    idempotencyKey: 'k',
    lines: twoLines(accounts),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});

// Finding 3: line re-parented into a posted entry via UPDATE.
test('R3: a draft line cannot be re-parented into a posted entry via UPDATE (F3)', () => {
  const { ctx, store, accounts } = setup();
  const posted = postEntry(ctx, simpleEntry(accounts, 5000, 'kp'));
  store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES ('e_d', 'ws_1', '2026-03-01', 'draft', 'manual', '2026-07-16T00:00:00.000Z')",
    )
    .run();
  // The currency is stated, because since M-3 generation 4 `journal_line.currency` has no default
  // and this raw INSERT is refused without it. That refusal is the point of the generation: this
  // fixture omitted the column and was quietly handed francs, which is exactly the third writer the
  // default existed to hide. A test fixture getting the wrong currency for free is harmless; the
  // next production insert path doing the same is not.
  store.db
    .prepare(
      "INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor) VALUES ('l_d', 'e_d', ?, 100, 0, 'CHF', 100, 0)",
    )
    .run(accounts['6500']);
  assert.throws(
    () => store.db.prepare('UPDATE journal_line SET entry_id = ? WHERE id = ?').run(id(posted, 'entryId', 'postEntry'), 'l_d'),
    /posted_immutable/,
  );
});
