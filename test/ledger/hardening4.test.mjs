// @ts-check
// Regression tests for the independent (Fable 5) validation findings on A02.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { setup, withVat } from './support.mjs';
import { errOf, id, obj, objs, okOf, row, str } from '../support/narrow.mjs';

const twoLines = (accounts, amt = 1000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

// F1: retrying a successful draft-promotion must replay, not return already_posted (H-IDEMPOTENT).
test('re-posting a promoted draft with the same key replays the result (F1)', () => {
  const { ctx, accounts } = setup();
  const d = saveDraft(ctx, { date: '2026-03-01', description: 'x', idempotencyKey: 'd', lines: twoLines(accounts) });
  const first = postEntry(ctx, {
    entryId: id(d, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: twoLines(accounts),
  });
  const second = postEntry(ctx, {
    entryId: id(d, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: twoLines(accounts),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

// F2: tax-trace fields must be validated (no floats or strings into the immutable money columns).
test('non-integer or non-string tax fields are rejected (F2)', () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  const mk = (i, taxFields) =>
    postEntry(ctx, {
      date: '2026-03-01',
      description: 'x',
      source: 'manual',
      idempotencyKey: `k${i}`,
      lines: [
        { account: accounts['6500'], debit: 1000, ...taxFields },
        { account: accounts['1000'], credit: 1000 },
      ],
    });
  assert.equal(errOf(mk(1, { taxBase: 100.5 }), 'postEntry with a fractional taxBase').error, 'invalid_line');
  assert.equal(errOf(mk(2, { taxAmount: 'abc' }), 'postEntry with a non-numeric taxAmount').error, 'invalid_line');
  assert.equal(errOf(mk(3, { taxCode: '' }), 'postEntry with an empty taxCode').error, 'invalid_line');
  // a valid, B2-reconciled tax trace still posts (negatives allowed for reversals)
  const good = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'k4',
    lines: [
      { account: accounts['6500'], debit: 1000, taxCode: vat.code, taxBase: 1000, taxAmount: 81 },
      { account: vat.vorsteuer, debit: 81 },
      { account: accounts['1000'], credit: 1081 },
    ],
  });
  assert.equal(good.ok, true);
});

// F3: cost centers must be validated and workspace-scoped, never stored cross-tenant or thrown.
test('a nonexistent or cross-tenant cost center is rejected, never stored or thrown (F3)', () => {
  const { ctx, store, accounts } = setup();
  store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_1', 'ws_1', 'C1', 'D1')").run();
  store.db
    .prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_2', 'O', 'CHF', '01-01', '2026-07-16T00:00:00.000Z')")
    .run();
  store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_foreign', 'ws_2', 'C1', 'D1')").run();

  const post = (i, cc) =>
    postEntry(ctx, {
      date: '2026-03-01',
      description: 'x',
      source: 'manual',
      idempotencyKey: `k${i}`,
      lines: [
        { account: accounts['6500'], debit: 1000, costCenter: cc },
        { account: accounts['1000'], credit: 1000 },
      ],
    });
  assert.equal(errOf(post(1, 'cc_foreign'), 'postEntry with a foreign cost centre').error, 'invalid_cost_center');
  assert.equal(errOf(post(2, 'ghost'), 'postEntry with an unknown cost centre').error, 'invalid_cost_center');
  assert.equal(errOf(post(3, {}), 'postEntry with a non-string cost centre').error, 'invalid_line');
  assert.equal(post(4, 'cc_1').ok, true);
});

// F4: saveDraft must validate account existence + tenancy, never throw a raw FK error.
test('saveDraft rejects a nonexistent account with a structured error, never throws (F4)', () => {
  const { ctx } = setup();
  const res = saveDraft(ctx, { date: '2026-03-01', description: 'x', idempotencyKey: 'k', lines: [{ account: 'ghost', debit: 100 }] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_account');
});

// F5: a reversal with no explicit date is dated today, not the original entry's date.
test('a reversal with no date is dated today, not the original date (F5)', () => {
  const { ctx, store, accounts } = setup(); // clock fixed at 2026-07-16
  const p = postEntry(ctx, { date: '2025-01-15', description: 'x', source: 'manual', idempotencyKey: 'p', lines: twoLines(accounts) });
  const rev = reverseEntry(ctx, { entryId: id(p, 'entryId', 'postEntry'), idempotencyKey: 'r' });
  const revRow = row(
    store.db.prepare('SELECT date FROM journal_entry WHERE id = ?').get(id(rev, 'reversalId', 'reverseEntry')),
    'the reversal entry row',
  );
  const revDate = str(revRow.date, 'journal_entry.date');
  assert.equal(revDate, '2026-07-16');
});

// F6: dates must be valid ISO-8601 calendar dates (this engine is the sole writer of §D0).
test('an invalid date is rejected (F6)', () => {
  const { ctx, accounts } = setup();
  const post = (i, date) =>
    postEntry(ctx, { date, description: 'x', source: 'manual', idempotencyKey: `k${i}`, lines: twoLines(accounts) });
  assert.equal(post(1, 'not-a-date').ok, false);
  assert.equal(post(2, '2026-13-45').ok, false);
  assert.equal(post(3, '2026-02-30').ok, false);
  assert.equal(post(4, '2026-03-01').ok, true);
});

// Low: getEntry must return lines in insertion order, not lexicographic id order.
test('getEntry returns lines in insertion order (F-line-order)', () => {
  const { ctx, accounts } = setup();
  const lines = [];
  for (let i = 0; i < 11; i++) lines.push({ account: accounts['6500'], debit: 100 });
  lines.push({ account: accounts['1000'], credit: 1100 });
  const p = postEntry(ctx, { date: '2026-03-01', description: 'x', source: 'manual', idempotencyKey: 'k', lines });
  const read = getEntry(ctx, { entryId: id(p, 'entryId', 'postEntry') });
  const readLines = objs(okOf(read, 'getEntry').lines, 'getEntry.lines');
  assert.equal(readLines.length, 12);
  assert.equal(obj(readLines[11], 'getEntry.lines[11]').credit, 1100);
});
