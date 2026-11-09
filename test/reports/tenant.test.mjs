// A08 §H-TENANT: every query is fenced to one workspace, and this file is built so that the fence
// is the ONLY reason it passes.
//
// THREE THINGS MAKE THIS NON-VACUOUS, and A07's tenant test had none of them:
//
//  1. ONE STORE. `setup()` and `secondWorkspace()` share a single `SqliteStore`. A test that builds
//     a fresh store per workspace is comparing two separate databases, and neutralising the
//     `workspace_id` filter in the code under test leaves it green. That is exactly what happened
//     to A07: both workspaces were minted `ws_1` in two different files, and deleting the filter in
//     three reads left 31 of 31 tests passing.
//  2. THE OTHER TENANT IS MINTED FIRST. A neutralised filter on a `.get()` degenerates to
//     "whichever row the query returns first", so a test that creates its own workspace first can
//     pass by accident. Here the neighbour is `ws_1` and the workspace under test is `ws_2`.
//  3. THE NEIGHBOUR'S BOOKS ARE DIFFERENT FIGURES, not a copy. If the two workspaces carried the
//     same amounts, a leak would be invisible: every assertion would hold with or without the
//     fence. The neighbour's numbers below are chosen so that ANY leak moves a total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
  exportStatement,
} from '../../dist/core/reports/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { seedBooks, EXPECTED, PERIOD, AT, rowFor, sectionFor } from './support.mjs';

/**
 * The NEIGHBOUR first, then the workspace under test, inside ONE database.
 *
 * Built here rather than reused from `support.mjs` precisely because the ORDER is the point: the
 * shared `setup()` mints its workspace immediately, which would make the tenant under test `ws_1`.
 */
function twoTenants() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };

  const neighbourId = createWorkspace(deps, { name: 'Nachbar AG' }).workspaceId;
  const neighbour = makeContext(store, { workspaceId: neighbourId, actor: 'user_2', clock, ids });

  const workspaceId = createWorkspace(deps, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });

  assert.equal(neighbourId, 'ws_1', 'the NEIGHBOUR must be the first row, or a dead filter passes by luck');
  assert.equal(workspaceId, 'ws_2');

  const acc = (ws, number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;

  // The neighbour's books: deliberately unlike the fixture's, so any leak shows up as a wrong total
  // rather than as a total that happens to still be right.
  const post = (date, key, lines) => {
    const res = postEntry(neighbour, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: lines.map((l) => ({ account: acc(neighbourId, l.n), ...(l.debit ? { debit: l.debit } : { credit: l.credit }) })),
    });
    if (!res.ok) throw new Error(`neighbour post failed: ${JSON.stringify(res)}`);
  };
  post('2025-12-31', 'n-open', [
    { n: '1020', debit: 7777700 },
    { n: '2800', credit: 7777700 },
  ]);
  post('2026-02-14', 'n-rev', [
    { n: '1020', debit: 3333300 },
    { n: '3000', credit: 3333300 },
  ]);
  post('2026-02-14', 'n-exp', [
    { n: '5000', debit: 1111100 },
    { n: '1020', credit: 1111100 },
  ]);

  const t = { store, deps, ctx, clock, ids, workspaceId, acc: (number) => acc(workspaceId, number) };
  seedBooks(t);
  return { t, neighbour, neighbourId, neighbourAcc: (number) => acc(neighbourId, number) };
}

test('the neighbour is really there, with figures the fixture never produces', () => {
  // A tenant test whose "other tenant" is empty proves nothing at all. This is the guard on the
  // guard: if this case ever goes green with a zero, every case below is vacuous.
  const { neighbour } = twoTenants();
  const res = computeTrialBalance(neighbour, PERIOD);
  assert.equal(rowFor(res, '1020').closingMinor, 9999900); // 7777700 + 3333300 - 1111100
  assert.equal(res.totals.debitMinor, 4444400);
  assert.notEqual(res.totals.debitMinor, EXPECTED.trial.debit);
});

test('trial balance: the neighbour never reaches a row or a total', () => {
  const { t } = twoTenants();
  const res = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(res.totals.debitMinor, EXPECTED.trial.debit);
  assert.equal(rowFor(res, '1020').closingMinor, EXPECTED.balances['1020']);
  // 3000 moved in the NEIGHBOUR only, so the row must not exist here at all.
  assert.equal(rowFor(res, '3000'), undefined, "the neighbour's revenue account leaked onto the report");
  assert.equal(res.reconciles, true);
});

test('balance sheet: neither side picks up the neighbour', () => {
  const { t } = twoTenants();
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(res.aktivenMinor, EXPECTED.bilanz.aktiven);
  assert.equal(res.passivenMinor, EXPECTED.bilanz.passiven);
  assert.equal(sectionFor(res, 'umlaufvermoegen').subtotalMinor, EXPECTED.bilanz.umlaufvermoegen);
  assert.equal(sectionFor(res, 'eigenkapital').subtotalMinor, EXPECTED.bilanz.eigenkapital);
  assert.equal(res.reconciles, true);
});

test('income statement: the neighbour cannot move the Reingewinn', () => {
  const { t } = twoTenants();
  const res = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(res.reingewinnMinor, EXPECTED.erfolgsrechnung.reingewinn);
  assert.equal(sectionFor(res, 'netto_erloese').subtotalMinor, EXPECTED.erfolgsrechnung.netto_erloese);
  assert.equal(sectionFor(res, 'personalaufwand').subtotalMinor, EXPECTED.erfolgsrechnung.personalaufwand);
  assert.equal(res.reconciles, true);
});

test("general ledger: a neighbour's account id is not_found, never someone else's Kontoblatt", () => {
  const { t, neighbourAcc } = twoTenants();
  const foreign = computeGeneralLedger(t.ctx, { accountId: neighbourAcc('1020'), ...PERIOD });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  // And the workspace's own 1020 shows only its own movements.
  const own = computeGeneralLedger(t.ctx, { accountId: t.acc('1020'), ...PERIOD });
  assert.equal(own.openingMinor, 2000000);
  assert.equal(own.closingMinor, EXPECTED.balances['1020']);
  assert.equal(own.lines.length, 4);
});

test('export: the artifact is fenced exactly like the model it renders', () => {
  const { t } = twoTenants();
  const csv = exportStatement(t.ctx, { kind: 'trial', format: 'csv', ...PERIOD });
  const text = Buffer.from(csv.artifact.base64, 'base64').toString('utf8');
  assert.ok(!text.includes('9999900'), "the neighbour's bank balance reached the artifact");
  assert.ok(!text.includes('3333300'), "the neighbour's revenue reached the artifact");
  assert.ok(text.includes(String(EXPECTED.balances['1020'])));
});

test("ledgerNetsToZero cannot be rescued or ruined by the neighbour's books", () => {
  // A GAP THIS FILE HAD. Every other case here works because the neighbour's FIGURES differ, and
  // `ledgerNetThrough` does not compare figures: it asks whether the whole ledger nets to zero. The
  // neighbour's books balance too, so summing both tenants together still netted to zero and the
  // tenant fence on that one query could be deleted with all 93 A08 cases green.
  //
  // Closing it needs a neighbour whose ledger does NOT net to zero, which is the corrupt-import
  // state (see `importRawEntry`). Our books stay clean, so our flag must stay GREEN, and it can only
  // do that if the query really is fenced.
  const { t, neighbour, neighbourId } = twoTenants();
  const db = t.store.db;
  const neighbourCash = db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(neighbourId, '1000').id;
  db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at)
     VALUES ('n_bad', ?, '2026-02-01', 'draft', 'import', ?)`,
  ).run(neighbourId, AT);
  db.prepare(
    `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency,
                               base_debit_minor, base_credit_minor)
     VALUES ('n_bad_line', 'n_bad', ?, 8888800, 0, 'CHF', 8888800, 0)`,
  ).run(neighbourCash);
  db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = 'n_bad'").run();

  // The neighbour is genuinely broken, or this case proves nothing.
  const theirs = computeBalanceSheet(neighbour, { asOf: '2026-03-31' });
  assert.equal(theirs.reconciliation.ledgerNetsToZero, false, "the neighbour's ledger must really be corrupt");

  // Ours is untouched: the corruption is one workspace away and must not cross.
  const ours = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(ours.reconciliation.ledgerNetsToZero, true, "the neighbour's corruption reached our flag");
  assert.equal(ours.reconciliation.aktivenEqualPassiven, true);
  assert.equal(ours.reconciles, true);
  assert.equal(ours.aktivenMinor, EXPECTED.bilanz.aktiven);
});

test('the two workspaces are genuinely in ONE database', () => {
  // The structural claim the whole file rests on, asserted rather than assumed.
  const { t, neighbourId } = twoTenants();
  const ids = t.store.db.prepare('SELECT id FROM workspace ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [neighbourId, t.workspaceId]);
  const entries = t.store.db
    .prepare('SELECT workspace_id, COUNT(*) AS n FROM journal_entry GROUP BY workspace_id ORDER BY workspace_id')
    .all();
  assert.equal(entries.length, 2, 'both tenants must have entries in the same journal table');
  assert.ok(entries.every((row) => row.n > 0));
});
