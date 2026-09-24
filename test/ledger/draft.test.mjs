// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft, deleteDraft, getEntry } from '../../dist/core/ledger/index.js';
import { setup } from './support.mjs';
import { countOf, errOf, id, obj, okOf } from '../support/narrow.mjs';

/** The `entry` `getEntry` reports, proved to be a success payload carrying an entry object. */
const entryOf = (ctx, entryId) => obj(okOf(getEntry(ctx, { entryId }), 'getEntry').entry, 'getEntry.entry');

const twoLines = (accounts, amt = 5000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

test('saveDraft stores an unbalanced idea without posting it', () => {
  const { ctx, store, accounts } = setup();
  const res = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'half an idea',
    idempotencyKey: 'd1',
    lines: [{ account: accounts['6500'], debit: 5000 }],
  });
  assert.equal(res.ok, true);
  assert.equal(entryOf(ctx, id(res, 'entryId', 'saveDraft')).status, 'draft');
  assert.equal(countOf(store.db, "SELECT COUNT(*) AS c FROM journal_entry WHERE status='posted'"), 0);
});

test('posting a saved draft promotes it in place (same id), not a duplicate', () => {
  const { ctx, store, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'idea',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  const posted = postEntry(ctx, {
    entryId: id(draft, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'idea',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  assert.equal(posted.ok, true);
  assert.equal(id(posted, 'entryId', 'postEntry'), id(draft, 'entryId', 'saveDraft'));
  assert.equal(entryOf(ctx, id(draft, 'entryId', 'saveDraft')).status, 'posted');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 1);
});

test('deleteDraft hard-deletes a draft and its lines', () => {
  const { ctx, store, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'x',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  assert.equal(deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' }).ok, true);
  assert.equal(errOf(getEntry(ctx, { entryId: id(draft, 'entryId', 'saveDraft') }), 'getEntry').error, 'not_found');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_line'), 0);
});

test('a retried delete of an already-deleted draft returns ok, not not_found', () => {
  const { ctx, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'x',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  const first = deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' });
  const second = deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

test('saveDraft cannot target a posted row (draft mutation is fenced)', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const res = saveDraft(ctx, {
    entryId: id(posted, 'entryId', 'postEntry'),
    date: '2026-03-01',
    description: 'sneaky',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_a_draft');
});

test('deleteDraft cannot delete a posted row', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const res = deleteDraft(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'del1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_a_draft');
});

test('posting an already-posted entryId is rejected (promotion is one-way)', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const again = postEntry(ctx, {
    entryId: id(posted, 'entryId', 'postEntry'),
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p2',
    lines: twoLines(accounts),
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_posted');
});
