// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft, listJournal } from '../../dist/core/ledger/index.js';
import { setup } from './support.mjs';
import { obj, objs, okOf } from '../support/narrow.mjs';

const twoLines = (accounts, amt = 5000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

/** The `entries` `listJournal` reports, proved to be a success payload carrying a list of rows. */
const journal = (ctx, filter = {}) =>
  objs(okOf(listJournal(ctx, filter), 'listJournal').entries, 'listJournal.entries');

test('listJournal returns this workspace entries newest-first', () => {
  const { ctx, accounts } = setup();
  postEntry(ctx, { date: '2026-01-05', description: 'jan', source: 'manual', idempotencyKey: 'a', lines: twoLines(accounts) });
  postEntry(ctx, { date: '2026-03-05', description: 'mar', source: 'manual', idempotencyKey: 'b', lines: twoLines(accounts) });
  saveDraft(ctx, { date: '2026-02-05', description: 'feb draft', idempotencyKey: 'd', lines: twoLines(accounts) });

  const all = journal(ctx);
  assert.equal(all.length, 3);
  assert.equal(obj(all[0], 'listJournal.entries[0]').date, '2026-03-05');
  assert.equal(obj(all[2], 'listJournal.entries[2]').date, '2026-01-05');
});

test('listJournal filters by status and by date range', () => {
  const { ctx, accounts } = setup();
  postEntry(ctx, { date: '2026-01-05', description: 'jan', source: 'manual', idempotencyKey: 'a', lines: twoLines(accounts) });
  postEntry(ctx, { date: '2026-03-05', description: 'mar', source: 'manual', idempotencyKey: 'b', lines: twoLines(accounts) });
  saveDraft(ctx, { date: '2026-02-05', description: 'feb draft', idempotencyKey: 'd', lines: twoLines(accounts) });

  assert.equal(journal(ctx, { status: 'posted' }).length, 2);
  assert.equal(journal(ctx, { status: 'draft' }).length, 1);
  assert.equal(journal(ctx, { from: '2026-02-01', to: '2026-12-31' }).length, 2);
});

test('listJournal reports a per-entry total (sum of the debit legs, in Rappen)', () => {
  const { ctx, accounts } = setup();
  postEntry(ctx, { date: '2026-01-05', description: 'jan', source: 'manual', idempotencyKey: 'a', lines: twoLines(accounts, 5000) });

  const all = journal(ctx);
  assert.equal(all.length, 1);
  assert.equal(obj(all[0], 'listJournal.entries[0]').total, 5000, 'the entry total equals the sum of its debit legs');
});

test('listJournal totals a multi-line entry across all its debit legs', () => {
  const { ctx, accounts } = setup();
  // Two debit legs (6500 + 1020) balanced by one credit leg (1000) of 7500.
  postEntry(ctx, {
    date: '2026-02-10',
    description: 'split',
    source: 'manual',
    idempotencyKey: 'm',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1020'], debit: 2500 },
      { account: accounts['1000'], credit: 7500 },
    ],
  });

  const all = journal(ctx);
  const entry = obj(
    all.find((e) => e.description === 'split'),
    'the split entry listJournal reports',
  );
  assert.equal(entry.total, 7500, 'the total sums the two debit legs (5000 + 2500)');
});

test('listJournal never returns another workspace entries', () => {
  const { ctx, store, accounts } = setup();
  postEntry(ctx, { date: '2026-01-05', description: 'ours', source: 'manual', idempotencyKey: 'a', lines: twoLines(accounts) });
  store.db
    .prepare(
      "INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_2', 'Other', 'CHF', '01-01', '2026-07-16T00:00:00.000Z')",
    )
    .run();
  store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES ('e_other', 'ws_2', '2026-05-05', 'posted', 'manual', '2026-07-16T00:00:00.000Z')",
    )
    .run();
  const ours = journal(ctx);
  assert.equal(ours.every((e) => e.id !== 'e_other'), true);
  assert.equal(ours.length, 1);
});
