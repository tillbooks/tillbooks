// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, getEntry } from '../../dist/core/ledger/index.js';
import { setup, simpleEntry } from './support.mjs';
import { countOf, errOf, id, obj, objs, okOf } from '../support/narrow.mjs';

test('a balanced two-line entry posts and reads back as posted', () => {
  const { ctx, accounts } = setup();
  const res = postEntry(ctx, simpleEntry(accounts, 5000));
  assert.equal(res.ok, true);
  assert.ok(res.entryId);

  const read = okOf(getEntry(ctx, { entryId: id(res, 'entryId', 'postEntry') }), 'getEntry');
  const entry = obj(read.entry, 'getEntry.entry');
  assert.equal(entry.status, 'posted');
  assert.equal(entry.source, 'manual');
  assert.equal(objs(read.lines, 'getEntry.lines').length, 2);
});

test('a compound (N-line) entry balances across all lines in Rappen', () => {
  const { ctx, accounts } = setup();
  // expense net 4630 + input VAT 370 = credit bank 5000
  const res = postEntry(ctx, {
    date: '2026-03-02',
    description: 'Einkauf mit Vorsteuer',
    source: 'manual',
    idempotencyKey: 'k-compound',
    lines: [
      { account: accounts['6500'], debit: 4630 },
      { account: accounts['1000'], debit: 370 },
      { account: accounts['1020'], credit: 5000 },
    ],
  });
  assert.equal(res.ok, true);
});

test('an unbalanced entry is rejected and nothing is written', () => {
  const { ctx, store, accounts } = setup();
  const res = postEntry(ctx, {
    date: '2026-03-01',
    description: 'off by 100',
    source: 'manual',
    idempotencyKey: 'k-bad',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1000'], credit: 4900 },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unbalanced');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 0);
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_line'), 0);
});

test('the boundary lines are rejected before any write', () => {
  const { ctx, accounts } = setup();
  const base = { date: '2026-03-01', description: 'x', source: 'manual' };

  // single line
  assert.equal(
    errOf(
      postEntry(ctx, { ...base, idempotencyKey: 'k1', lines: [{ account: accounts['1000'], debit: 100 }] }),
      'postEntry with a single line',
    ).error,
    'unbalanced',
  );
  // a zero-amount line
  assert.equal(
    errOf(
      postEntry(ctx, {
        ...base,
        idempotencyKey: 'k2',
        lines: [
          { account: accounts['6500'], debit: 0 },
          { account: accounts['1000'], credit: 0 },
        ],
      }),
      'postEntry with a zero-amount line',
    ).error,
    'invalid_line',
  );
  // a line marking BOTH debit and credit
  assert.equal(
    errOf(
      postEntry(ctx, {
        ...base,
        idempotencyKey: 'k3',
        lines: [
          { account: accounts['6500'], debit: 100, credit: 100 },
          { account: accounts['1000'], credit: 100 },
        ],
      }),
      'postEntry with a two-sided line',
    ).error,
    'invalid_line',
  );
  // a non-integer (float) amount never reaches the ledger
  assert.equal(
    errOf(
      postEntry(ctx, {
        ...base,
        idempotencyKey: 'k4',
        lines: [
          { account: accounts['6500'], debit: 100.5 },
          { account: accounts['1000'], credit: 100.5 },
        ],
      }),
      'postEntry with a fractional amount',
    ).error,
    'invalid_line',
  );
});

test('a line naming an account from another workspace is rejected (tenant scoping)', () => {
  const { ctx, store, accounts } = setup();
  // an account that exists, but in a different workspace
  store.db
    .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('ws_2', 'Other', 'CHF', '01-01', '2026-07-16T00:00:00.000Z');
  store.db
    .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
    .run('acc_foreign', 'ws_2', '1000', 'Kasse', 'asset');

  const res = postEntry(ctx, {
    date: '2026-03-01',
    description: 'cross-tenant',
    source: 'manual',
    idempotencyKey: 'k-x',
    lines: [
      { account: 'acc_foreign', debit: 100 },
      { account: accounts['1000'], credit: 100 },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_account');
});

test('post is denied (before any write) when the actor lacks the post capability', () => {
  const denied = { assert: (cap) => ({ ok: false, error: 'permission_denied', capability: cap }) };
  const { ctx, store, accounts } = setup({ capabilities: denied });
  const res = postEntry(ctx, simpleEntry(accounts));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
  assert.equal(res.capability, 'post');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 0);
});

test('post into a locked period returns period_locked and writes nothing', () => {
  const locked = { assertOpen: () => ({ ok: false, error: 'period_locked', period: '2026-03', kind: 'hard' }) };
  const { ctx, store, accounts } = setup({ periods: locked });
  const res = postEntry(ctx, simpleEntry(accounts));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 0);
});

test('re-posting with the same idempotency key returns the original entry, never a duplicate', () => {
  const { ctx, store, accounts } = setup();
  const first = postEntry(ctx, simpleEntry(accounts, 5000, 'same-key'));
  const second = postEntry(ctx, simpleEntry(accounts, 5000, 'same-key'));
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 1);
});

test('a validation failure does not burn the idempotency key', () => {
  const { ctx, accounts } = setup();
  const bad = {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'reused',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1000'], credit: 4000 },
    ],
  };
  assert.equal(errOf(postEntry(ctx, bad), 'postEntry with an unbalanced entry').error, 'unbalanced');
  // fix it and retry with the SAME key: it must now succeed
  const good = { ...simpleEntry(accounts, 5000, 'reused') };
  assert.equal(postEntry(ctx, good).ok, true);
});
