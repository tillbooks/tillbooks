// J06, the inventory valuation RUN & GL link (OP11). The MONEY-PATH invariants a non-author critic
// must see BITE. Each test is written to FAIL if its invariant were removed:
//
//   (OP11) after a posted run, the GL inventory control balance EQUALS the J03 sub-ledger valuation
//          at the cut-off, to the Rappen. The test asserts the exact figure both ways, so a wrong
//          delta, a dropped landed cost or a re-round would fail it.
//   (a) APPEND-ONLY / §H-AUDIT: a raw UPDATE or DELETE on a valuation line is aborted by the DB
//       trigger; a posted run's total cannot be raw-mutated. A correction is a reverse plus a run.
//   (b) IDEMPOTENT ON ROWS (§H-IDEMPOTENT): a replayed post mints exactly ONE journal.
//   (c) §H-PERIOD: a create or post into a hard-locked period is refused before any write.
//   (d) §H-TENANT: a run never crosses a workspace; a foreign id is not_found.
//   (e) REVERSE restores the baseline: after a reverse the GL is back where it was, and a fresh run
//       posts the same delta again.
//   (f) DRIFT: an external GL-only posting against the control account shows as drift, and the hard
//       check fails the period close.
//   (g) EMPTY: a zero-value run posts no journal yet records the baseline.
//   (h) STALE DRAFT: a draft whose ledger changed before the post is refused.
//   (i) OPENING: a stated opening baseline posts against the GL and reconciles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import { postEntry, makePeriodPort } from '../../dist/core/ledger/index.js';
import {
  inventoryMove,
  inventoryEnsureDefaultLocation,
  inventoryValuationCreate,
  inventoryValuationPost,
  inventoryValuationReverse,
  inventoryValuationOpening,
  inventoryValuationGet,
  inventoryValuationList,
  inventoryValuationReport,
  inventoryReconciliationReport,
  inventoryReconciliationCheck,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-16T00:00:00.000Z';

function freshCtx(name = 'Acme AG') {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  // A REAL period port, so the §H-PERIOD lock actually bites (makeContext defaults to the open stub).
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, periods: makePeriodPort({ store, workspaceId }) });
  return { ctx, store, workspaceId };
}

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

function accId(ctx, number) {
  return ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number).id;
}

/** The posted GL balance of an account at a cut-off, computed straight from the rows (debit-positive). */
function glBalance(ctx, number, asOf) {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.account_id = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ctx.workspaceId, accId(ctx, number), asOf);
  return row.net;
}

function seedItem(ctx, over = {}) {
  const item = must(
    createItem(ctx, { name: over.name ?? 'Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: over.key ?? 'it-w' }),
    'createItem',
  ).item;
  return item.id;
}

function locationOf(ctx) {
  return must(inventoryEnsureDefaultLocation(ctx), 'ensureLocation').location.id;
}

// --- OP11: the identity BITES -------------------------------------------------------------------

test('J06 OP11: after a posted run, GL inventory control == J03 sub-ledger valuation, to the Rappen', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  // 12 units at 1500 = 18'000 Rappen (CHF 180.00). J03 values it; J06 posts it.
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'move');

  // Before the post the reconciliation reports the full value as an UNPOSTED delta.
  const before = must(inventoryReconciliationReport(ctx, { asOf: '2026-03-31' }), 'recon before');
  assert.equal(before.status, 'unposted');
  assert.equal(before.unpostedDeltaRappen, 18000);
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 0, 'nothing posted yet');

  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'create');
  assert.equal(draft.run.status, 'draft');
  assert.equal(draft.run.totalValueRappen, 18000);
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].valueRappen, 18000);
  assert.equal(draft.lines[0].controlAccountId, accId(ctx, '1200'));

  const posted = must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'post');
  assert.equal(posted.run.status, 'posted');
  assert.equal(posted.run.deltaRappen, 18000);
  assert.notEqual(posted.run.journalEntryId, null);

  // THE IDENTITY, asserted both ways and to the exact figure.
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 18000, 'GL inventory control == posted valuation');
  assert.equal(glBalance(ctx, '4200', '2026-03-31'), -18000, 'the change account carries the counter');
  const after = must(inventoryReconciliationReport(ctx, { asOf: '2026-03-31' }), 'recon after');
  assert.equal(after.status, 'balanced');
  assert.equal(after.accounts[0].subLedgerRappen, after.accounts[0].glBalanceRappen);
  assert.equal(after.accounts[0].deltaRappen, 0);
  // The hard check the period close calls now passes.
  const check = must(inventoryReconciliationCheck(ctx, { period: '2026-03' }), 'check');
  assert.equal(check.status, 'balanced');
});

test("J06 OP11 holds through further movements and a second run (delta is against J06's own last posted total)", () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm1');
  const d1 = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c1');
  must(inventoryValuationPost(ctx, { runId: d1.run.id, idempotencyKey: 'p1' }), 'p1');
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 18000);

  // More stock arrives in a later period. A run at 2026-04-30 posts only the DELTA (10 * 1200 = 12000).
  must(inventoryMove(ctx, { itemId, locationId, qty: 10, movementType: 'receipt', unitCostMinor: 1200, effectiveDate: '2026-04-10', idempotencyKey: 'r2' }), 'm2');
  const d2 = must(inventoryValuationCreate(ctx, { asOf: '2026-04-30', idempotencyKey: 'c2' }), 'c2');
  const p2 = must(inventoryValuationPost(ctx, { runId: d2.run.id, idempotencyKey: 'p2' }), 'p2');
  assert.equal(p2.run.deltaRappen, 12000, 'only the incremental value is posted');
  assert.equal(glBalance(ctx, '1200', '2026-04-30'), 30000, 'GL == full sub-ledger 18000 + 12000');
  const recon = must(inventoryReconciliationReport(ctx, { period: '2026-04' }), 'recon');
  assert.equal(recon.status, 'balanced');
  assert.equal(recon.accounts[0].deltaRappen, 0);
});

// --- (b) idempotency on ROWS --------------------------------------------------------------------

test('J06 §H-IDEMPOTENT: a replayed post mints exactly ONE journal', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 5, movementType: 'receipt', unitCostMinor: 2000, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');

  const first = must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'post 1');
  const second = must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'post 2 (replay)');
  assert.equal(first.run.journalEntryId, second.run.journalEntryId, 'same journal on replay');

  const journals = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'inventory_valuation'`)
    .get(ctx.workspaceId).n;
  assert.equal(journals, 1, 'exactly one valuation journal after the replay');
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 10000, 'the figure did not double');
});

test('J06 §H-IDEMPOTENT: a replayed create writes exactly ONE draft run', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 5, movementType: 'receipt', unitCostMinor: 2000, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const a = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c1');
  const b = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c1 replay');
  assert.equal(a.run.id, b.run.id, 'same run on replay');
  const runs = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM inventory_valuation_run WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(runs, 1);
});

// --- (c) §H-PERIOD ------------------------------------------------------------------------------

test('J06 §H-PERIOD: create and post into a hard-locked period are refused before any write', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 5, movementType: 'receipt', unitCostMinor: 2000, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  // Draft first while open, then hard-seal the month, then try to post.
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');
  ctx.store.db
    .prepare(`INSERT INTO period_lock (workspace_id, period, kind, locked_at, locked_by, reason) VALUES (?, '2026-03', 'hard', ?, 'u', 'year_close')`)
    .run(ctx.workspaceId, AT);

  const post = inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' });
  assert.equal(post.ok, false);
  assert.equal(post.error, 'period_locked');
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 0, 'nothing posted');

  const create = inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c2' });
  assert.equal(create.ok, false);
  assert.equal(create.error, 'period_locked');
});

// --- (a) append-only ----------------------------------------------------------------------------

test('J06 APPEND-ONLY: a valuation line is immutable and a posted total cannot be raw-mutated', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 5, movementType: 'receipt', unitCostMinor: 2000, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');
  must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'p');

  assert.throws(
    () => ctx.store.db.prepare('UPDATE inventory_valuation_line SET value_rappen = 1 WHERE run_id = ?').run(draft.run.id),
    /inventory_valuation_line_immutable/,
  );
  assert.throws(
    () => ctx.store.db.prepare('DELETE FROM inventory_valuation_line WHERE run_id = ?').run(draft.run.id),
    /inventory_valuation_line_immutable/,
  );
  assert.throws(
    () => ctx.store.db.prepare(`UPDATE inventory_valuation_run SET total_value_rappen = 1 WHERE id = ?`).run(draft.run.id),
    /inventory_valuation_run_posted_immutable/,
  );
  assert.throws(
    () => ctx.store.db.prepare('DELETE FROM inventory_valuation_run WHERE id = ?').run(draft.run.id),
    /inventory_valuation_run_immutable/,
  );
});

// --- (d) §H-TENANT ------------------------------------------------------------------------------

test('J06 §H-TENANT: a run never crosses a workspace', () => {
  const a = freshCtx('A AG');
  const b = freshCtx('B AG');
  const itemId = seedItem(a.ctx);
  const locationId = locationOf(a.ctx);
  must(inventoryMove(a.ctx, { itemId, locationId, qty: 5, movementType: 'receipt', unitCostMinor: 2000, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const draft = must(inventoryValuationCreate(a.ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');

  const cross = inventoryValuationGet(b.ctx, { runId: draft.run.id });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');

  const list = must(inventoryValuationList(b.ctx, {}), 'list B');
  assert.equal(list.items.length, 0, 'B sees none of A runs');
  const reconB = must(inventoryReconciliationReport(b.ctx, { asOf: '2026-03-31' }), 'recon B');
  assert.equal(reconB.accounts[0].subLedgerRappen, 0, 'B sub-ledger is its own, empty');
});

// --- (e) reverse restores the baseline ----------------------------------------------------------

test('J06 REVERSE restores the baseline; a fresh run posts the same delta again', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const d1 = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c1');
  must(inventoryValuationPost(ctx, { runId: d1.run.id, idempotencyKey: 'p1' }), 'p1');
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 18000);

  const rev = must(inventoryValuationReverse(ctx, { runId: d1.run.id, reason: 'Falsche Bewertung', idempotencyKey: 'v1' }), 'reverse');
  assert.equal(rev.run.status, 'reversed');
  assert.notEqual(rev.run.reversingJournalEntryId, null);
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 0, 'GL restored to the prior baseline');

  // Idempotent reverse.
  const rev2 = must(inventoryValuationReverse(ctx, { runId: d1.run.id, reason: 'Falsche Bewertung', idempotencyKey: 'v1' }), 'reverse replay');
  assert.equal(rev2.run.status, 'reversed');

  // A fresh run computes the delta against the restored GL and posts it again.
  const d2 = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c2' }), 'c2');
  const p2 = must(inventoryValuationPost(ctx, { runId: d2.run.id, idempotencyKey: 'p2' }), 'p2');
  assert.equal(p2.run.deltaRappen, 18000);
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 18000);
});

// --- (f) drift detection ------------------------------------------------------------------------

test('J06 DRIFT: an external GL-only posting shows as drift and fails the hard check', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const d1 = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c1');
  must(inventoryValuationPost(ctx, { runId: d1.run.id, idempotencyKey: 'p1' }), 'p1');
  const check1 = must(inventoryReconciliationCheck(ctx, { period: '2026-03' }), 'check balanced');
  assert.equal(check1.status, 'balanced');

  // A manual entry moves the inventory control account with no valuation run behind it.
  must(
    postEntry(ctx, {
      date: '2026-03-15',
      source: 'manual',
      description: 'stray',
      lines: [
        { account: accId(ctx, '1200'), debit: 5000 },
        { account: accId(ctx, '1000'), credit: 5000 },
      ],
      idempotencyKey: 'stray',
    }),
    'manual post',
  );

  const recon = must(inventoryReconciliationReport(ctx, { period: '2026-03' }), 'recon drift');
  assert.equal(recon.status, 'drift');
  assert.equal(recon.accounts[0].deltaRappen, -5000, 'GL is 5000 above the sub-ledger');

  const check2 = inventoryReconciliationCheck(ctx, { period: '2026-03' });
  assert.equal(check2.ok, false);
  assert.equal(check2.error, 'reconciliation_drift');

  // A subsequent run must NOT absorb the external drift: its delta is measured against J06's own last
  // posted total (18000), not the live GL (23000). The sub-ledger is unchanged, so the new run posts
  // nothing, the stray 5000 stays put, and the drift remains visible. Were the delta measured against
  // the live GL it would post -5000 and silently mask the very drift the recon exists to catch.
  const d2 = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c2' }), 'c2');
  const p2 = must(inventoryValuationPost(ctx, { runId: d2.run.id, idempotencyKey: 'p2' }), 'p2');
  assert.equal(p2.run.deltaRappen, 0, 'the sub-ledger did not move, so nothing is posted');
  assert.equal(glBalance(ctx, '1200', '2026-03-31'), 23000, 'the external 5000 is untouched, not absorbed');
  const check3 = inventoryReconciliationCheck(ctx, { period: '2026-03' });
  assert.equal(check3.ok, false);
  assert.equal(check3.error, 'reconciliation_drift', 'the drift is still flagged after a fresh run');
});

// --- (g) empty run ------------------------------------------------------------------------------

test('J06 EMPTY: a zero-value run posts no journal yet records the baseline', () => {
  const { ctx } = freshCtx();
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'create empty');
  assert.equal(draft.run.totalValueRappen, 0);
  assert.equal(draft.lines.length, 0);
  const posted = must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'post empty');
  assert.equal(posted.run.status, 'posted');
  assert.equal(posted.run.deltaRappen, 0);
  assert.equal(posted.run.journalEntryId, null, 'no journal for a zero delta');
  const journals = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'inventory_valuation'`)
    .get(ctx.workspaceId).n;
  assert.equal(journals, 0);
  const check = must(inventoryReconciliationCheck(ctx, { period: '2026-03' }), 'check empty');
  assert.equal(check.status, 'balanced');
});

// --- (h) stale draft ----------------------------------------------------------------------------

test('J06 STALE DRAFT: a draft whose ledger changed before the post is refused', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm1');
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');
  // A new movement dated within the cut-off arrives after the draft was calculated.
  must(inventoryMove(ctx, { itemId, locationId, qty: 3, movementType: 'receipt', unitCostMinor: 1000, effectiveDate: '2026-03-20', idempotencyKey: 'r2' }), 'm2');
  const post = inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' });
  assert.equal(post.ok, false);
  assert.equal(post.error, 'stale_draft');
});

// --- (i) opening --------------------------------------------------------------------------------

test('J06 OPENING: a stated opening baseline posts against the GL and reconciles', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const opening = must(
    inventoryValuationOpening(ctx, {
      asOf: '2026-01-01',
      lines: [{ itemId, qty: 10, valueRappen: 25000 }],
      idempotencyKey: 'o1',
    }),
    'opening',
  );
  assert.equal(opening.run.status, 'posted');
  assert.equal(opening.run.isOpening, true);
  assert.equal(glBalance(ctx, '1200', '2026-01-01'), 25000, 'opening value on the balance sheet');
  // Idempotent.
  const replay = must(inventoryValuationOpening(ctx, { asOf: '2026-01-01', lines: [{ itemId, qty: 10, valueRappen: 25000 }], idempotencyKey: 'o1' }), 'opening replay');
  assert.equal(replay.run.id, opening.run.id);
  assert.equal(glBalance(ctx, '1200', '2026-01-01'), 25000, 'the figure did not double');
});

// --- report -------------------------------------------------------------------------------------

test('J06 REPORT: the frozen run report and the live report agree at the cut-off', () => {
  const { ctx } = freshCtx();
  const itemId = seedItem(ctx);
  const locationId = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 12, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-02', idempotencyKey: 'r1' }), 'm');
  const draft = must(inventoryValuationCreate(ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' }), 'c');
  must(inventoryValuationPost(ctx, { runId: draft.run.id, idempotencyKey: 'p1' }), 'p');

  const live = must(inventoryValuationReport(ctx, { asOf: '2026-03-31' }), 'live report');
  assert.equal(live.source, 'live');
  assert.equal(live.totalValueRappen, 18000);
  const frozen = must(inventoryValuationReport(ctx, { runId: draft.run.id }), 'frozen report');
  assert.equal(frozen.source, 'run');
  assert.equal(frozen.totalValueRappen, live.totalValueRappen);
});
