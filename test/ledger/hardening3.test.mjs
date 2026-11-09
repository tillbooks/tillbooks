// Regression tests for the third-round (final) verification findings on A02.

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, saveDraft, getEntry, listJournal } from '../../dist/core/ledger/index.js';
import { setup, withVat } from './support.mjs';

function withCostCenters(store, workspaceId = 'ws_1') {
  store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_1', ?, 'CC1', 'Dept 1')").run(workspaceId);
  store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_2', ?, 'CC2', 'Dept 2')").run(workspaceId);
}

// Defect 1: reversal must carry cost centers so every cost center nets to zero.
test('reversing carries cost centers, so each cost center nets to zero (D1)', () => {
  const { ctx, store, accounts } = setup();
  withCostCenters(store);
  const p = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [
      { account: accounts['6500'], debit: 1000, costCenter: 'cc_1' },
      { account: accounts['1000'], credit: 1000 },
    ],
  });
  assert.equal(reverseEntry(ctx, { entryId: p.entryId, idempotencyKey: 'r' }).ok, true);
  const nets = store.db
    .prepare(
      "SELECT account_id, IFNULL(cost_center_id, '') AS cc, SUM(base_debit_minor - base_credit_minor) AS net FROM journal_line GROUP BY account_id, cc",
    )
    .all();
  for (const n of nets) {
    assert.equal(n.net, 0, `${n.account_id}/${n.cc} must net to zero`);
  }
});

// Defect 1: reversal must carry (and negate) the VAT trace.
test('reversing carries the VAT trace, negated, so the tax reverses too (D1)', () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  // A B2-reconciled input booking: base 1000 tagged V81 (8.1%), its 81 on 1170, gross on the counter.
  const p = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [
      { account: accounts['6500'], debit: 1000, taxCode: vat.code, taxBase: 1000, taxAmount: 81 },
      { account: vat.vorsteuer, debit: 81 },
      { account: accounts['1000'], credit: 1081 },
    ],
  });
  assert.equal(p.ok, true);
  const rev = reverseEntry(ctx, { entryId: p.entryId, idempotencyKey: 'r' });
  const line = store.db
    .prepare('SELECT tax_code, tax_base_minor, tax_amount_minor FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(rev.reversalId, accounts['6500']);
  assert.equal(line.tax_code, 'V81');
  assert.equal(line.tax_base_minor, -1000);
  assert.equal(line.tax_amount_minor, -81);
});

// Defect 3: a direct reversal that redistributes cost centers is not a faithful mirror.
test('a direct reversal redistributing cost centers is rejected (D3)', () => {
  const { ctx, store, accounts } = setup();
  withCostCenters(store);
  const target = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 't',
    lines: [
      { account: accounts['6500'], debit: 1000, costCenter: 'cc_1' },
      { account: accounts['1000'], credit: 1000 },
    ],
  });
  const bad = postEntry(ctx, {
    date: '2026-03-01',
    description: 'bad',
    source: 'reversal',
    reversesEntryId: target.entryId,
    idempotencyKey: 'b',
    lines: [
      { account: accounts['6500'], credit: 1000, costCenter: 'cc_2' },
      { account: accounts['1000'], debit: 1000 },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'not_a_mirror');
});

// Defect 3 (tax dimension): a direct reversal that strips or alters the VAT trace is not a mirror.
test('a direct reversal that strips the VAT trace is rejected (D3-tax)', () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  const target = postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 't',
    lines: [
      { account: accounts['6500'], debit: 1000, taxCode: vat.code, taxBase: 1000, taxAmount: 81 },
      { account: vat.vorsteuer, debit: 81 },
      { account: accounts['1000'], credit: 1081 },
    ],
  });
  assert.equal(target.ok, true);
  const bad = postEntry(ctx, {
    date: '2026-03-01',
    description: 'bad',
    source: 'reversal',
    reversesEntryId: target.entryId,
    idempotencyKey: 'b',
    lines: [
      { account: accounts['6500'], credit: 1000 },
      { account: vat.vorsteuer, credit: 81 },
      { account: accounts['1000'], debit: 1081 },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'not_a_mirror');
  assert.equal(reverseEntry(ctx, { entryId: target.entryId, idempotencyKey: 'r' }).ok, true);
});

// Defect 2: id/key/filter fields must return structured errors, never throw (P9).
test('malformed or missing id/key/filter fields return structured errors, never throw (D2)', () => {
  const { ctx, accounts } = setup();
  const lines = [
    { account: accounts['6500'], debit: 100 },
    { account: accounts['1000'], credit: 100 },
  ];
  assert.equal(postEntry(ctx, { date: '2026-03-01', description: 'x', source: 'manual', lines }).ok, false);
  assert.equal(postEntry(ctx, { date: {}, description: 'x', source: 'manual', idempotencyKey: 'k', lines }).ok, false);
  assert.equal(
    postEntry(ctx, { entryId: {}, date: '2026-03-01', description: 'x', source: 'manual', idempotencyKey: 'k', lines }).ok,
    false,
  );
  assert.equal(getEntry(ctx, { entryId: {} }).ok, false);
  assert.equal(reverseEntry(ctx, { entryId: [], idempotencyKey: 'k' }).ok, false);
  assert.equal(reverseEntry(ctx, { entryId: 'x', idempotencyKey: {} }).ok, false);
  assert.equal(saveDraft(ctx, { date: '2026-03-01', description: 'x', idempotencyKey: {}, lines }).ok, false);
  assert.equal(listJournal(ctx, { account: {} }).ok, false);
});
