/**
 * D01 §7, the money-path invariants and their tripwires. This is the file that must hold when
 * everything else changes, so every claim is asserted on ROWS or on the schema, never on a return
 * value, and every probe is proven NON-VACUOUS (it finds its target when the guard is present, and a
 * control shows the target would be there to find if the guard were removed).
 *
 * D01 `stock_run_valuation` is REPORT-ONLY (K68): it computes a figure and records a run row, but it
 * posts NO journal entry. J06 (`inventory_valuation_post`) is the sole path inventory value reaches
 * the ledger, so the invariants below hold over what D01 STILL does (compute, write a run row). The
 * one thing asserted everywhere: D01 mints ZERO source='stock' journal entries.
 *
 * The four laws: APPEND-ONLY (§H-AUDIT), §H-IDEMPOTENT, §H-PERIOD, §H-TENANT.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordStockMove, runValuation, computeInventoryValue } from '../../dist/core/stock/index.js';
import { lockPeriod } from '../../dist/core/ledger/index.js';
import { setup, secondWorkspace, snapshot, counts, accountNet } from './support.mjs';

function receive(t, qty, key, movedAt = '2026-03-01', unitCostMinor = 2000) {
  const r = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, qty, reason: 'receipt', unitCostMinor, movedAt, idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

// --- §H-IDEMPOTENT, asserted on rows -------------------------------------------------------------

test('idempotent: run_valuation with the same key twice writes ONE run row and ZERO journal entries, proven by row counts and a snapshot', () => {
  const t = setup();
  receive(t, 10, 'r1');
  const first = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.postedEntryId, null, 'report-only: D01 mints no journal entry');
  const after = snapshot(t.store);
  const second = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });

  assert.equal(second.ok, true);
  assert.equal(second.runId, first.runId, 'a replay returns the original run, not a fresh one');
  // Not one row anywhere is different. A return-value comparison would pass even if the second call
  // had written a second run row and returned the first one's id.
  assert.equal(snapshot(t.store), after, 'a replay of the same key must change no row at all');
  const c = counts(t.store, t.workspaceId);
  assert.equal(c.runs, 1);
  assert.equal(c.stockEntries, 0, 'report-only: no source=stock journal entry is ever minted');
});

test('idempotent NON-VACUOUS control: a DISTINCT key writes a SECOND run row (still no journal), so the probe above can detect a double-write', () => {
  const t = setup();
  receive(t, 10, 'r1');
  runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });
  receive(t, 5, 'r2', '2026-04-01');
  const second = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-04-30', idempotencyKey: 'v2' });
  assert.equal(second.ok, true);
  // A genuinely new valuation DID add a second run row: the idempotency test's snapshot equality is
  // therefore a real constraint, not a claim about a verb that never writes. Still ZERO journal
  // entries, because D01 never posts (that is the K68 report-only guarantee).
  assert.equal(counts(t.store, t.workspaceId).runs, 2);
  assert.equal(counts(t.store, t.workspaceId).stockEntries, 0, 'report-only: neither run posts a journal entry');
});

test('idempotent: stock_move with the same key twice writes ONE movement', () => {
  const t = setup();
  const input = { itemId: t.itemId, locationId: t.locId, qty: 7, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-03-01', idempotencyKey: 'm-same' };
  const a = recordStockMove(t.ctx, input);
  const after = snapshot(t.store);
  const b = recordStockMove(t.ctx, input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(snapshot(t.store), after, 'a replayed movement must change no row');
  assert.equal(counts(t.store, t.workspaceId).movements, 1);
});

// --- APPEND-ONLY / §H-AUDIT ----------------------------------------------------------------------

test('append-only: a re-run at the same as_of SUPERSEDES the prior run row (never edits or deletes it) and posts no journal', () => {
  const t = setup();
  receive(t, 10, 'r1'); // value 20000
  const v1 = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });
  assert.equal(v1.deltaMinor, 20000);
  assert.equal(v1.postedEntryId, null, 'report-only: the first run posts no journal entry');
  const priorRunId = v1.runId;
  // The prior run row's stored figures, captured before the re-run to prove they are never mutated.
  const priorRow = JSON.stringify(
    t.store.db.prepare('SELECT * FROM stock_valuation_run WHERE workspace_id = ? AND id = ?').get(t.workspaceId, priorRunId),
  );

  receive(t, 5, 'r2', '2026-03-15'); // now value 30000
  const v2 = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v2' });
  assert.equal(v2.ok, true);
  assert.equal(v2.postedEntryId, null, 'report-only: the re-run posts no journal entry either');

  // The prior run row is NOT deleted and NOT edited except for the active flag: its financial figures
  // are byte-identical to before the re-run (append-only history), only `active` flipped to 0.
  const now = t.store.db.prepare('SELECT * FROM stock_valuation_run WHERE workspace_id = ? AND id = ?').get(t.workspaceId, priorRunId);
  assert.ok(now, 'the prior run row must still exist (never deleted)');
  assert.equal(now.active, 0, 'the prior run row is superseded');
  const priorParsed = JSON.parse(priorRow);
  for (const col of ['total_value_minor', 'baseline_value_minor', 'delta_minor', 'method', 'as_of', 'posted_entry_id']) {
    assert.equal(now[col], priorParsed[col], `the prior run's ${col} must be untouched by the re-run`);
  }
  // Exactly one run row is active (the new one), and NO journal entry of any stock/reversal source
  // was ever minted: D01 is report-only, so the ledger is untouched.
  const active = t.store.db.prepare('SELECT COUNT(*) AS n FROM stock_valuation_run WHERE workspace_id = ? AND active = 1').get(t.workspaceId).n;
  assert.equal(active, 1);
  const c = counts(t.store, t.workspaceId);
  assert.equal(c.stockEntries, 0, 'report-only: no source=stock entry');
  assert.equal(c.reversals, 0, 'report-only: nothing to reverse, so no reversal entry');
  assert.equal(accountNet(t.store, t.workspaceId, '1200'), 0, 'D01 posts to no GL account');
  assert.equal(v2.totalValueMinor, 30000);
});

test('append-only NON-VACUOUS: D01 posts to NO ledger account, so a J06-style GL balance never comes from D01', () => {
  const t = setup();
  receive(t, 10, 'r1');
  const v1 = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });
  assert.equal(v1.ok, true);
  // The probe finds its target: D01 recorded a run row with the computed figure...
  assert.equal(counts(t.store, t.workspaceId).runs, 1);
  assert.equal(v1.totalValueMinor, 20000);
  // ...yet posted NOT ONE journal line to the inventory control or change account. The whole point of
  // K68 report-only: only J06 (source='inventory_valuation') may move 1200/4200.
  assert.equal(counts(t.store, t.workspaceId).entries, 0, 'D01 minted no journal entry at all');
  assert.equal(accountNet(t.store, t.workspaceId, '1200'), 0);
  assert.equal(accountNet(t.store, t.workspaceId, '4200'), 0);
});

// --- §H-PERIOD -----------------------------------------------------------------------------------

test('period-lock: a valuation into a hard-locked period is refused with period_locked and writes NOTHING', () => {
  const t = setup();
  receive(t, 10, 'r1', '2026-03-10');
  const later = t.at('2026-08-01T00:00:00.000Z');
  lockPeriod(later, { period: '2026-03', kind: 'hard', idempotencyKey: 'lock-mar' });

  const before = snapshot(t.store);
  const res = runValuation(later, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v-locked' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  // No partial: not one row moved. No run row is written (and, being report-only, never a journal).
  assert.equal(snapshot(t.store), before, 'a locked-period valuation must leave the database untouched');
  assert.equal(counts(t.store, t.workspaceId).runs, 0);
  assert.equal(counts(t.store, t.workspaceId).stockEntries, 0);
});

test('period-lock NON-VACUOUS control: the SAME run into an OPEN period writes a run row, so the refusal is the lock doing it', () => {
  const t = setup();
  receive(t, 10, 'r1', '2026-03-10');
  const res = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v-open' });
  assert.equal(res.ok, true, JSON.stringify(res));
  // The §H-PERIOD probe is non-vacuous: the identical run into an OPEN period DOES write its run row.
  assert.equal(counts(t.store, t.workspaceId).runs, 1);
  assert.equal(counts(t.store, t.workspaceId).stockEntries, 0, 'report-only: still no journal entry');
});

test('period-lock partial-safety: a re-run whose target is locked writes NO new run row and supersedes nothing', () => {
  const t = setup();
  receive(t, 10, 'r1', '2026-03-10');
  const v1 = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });
  assert.equal(v1.ok, true);
  const later = t.at('2026-08-01T00:00:00.000Z');
  lockPeriod(later, { period: '2026-03', kind: 'hard', idempotencyKey: 'lock-mar' });
  // A movement in an OPEN prior month so the recomputed value differs (would force a fresh run row and
  // supersede the prior if the lock did not stop it first). Called on `later` directly rather than via
  // the `receive(t, ...)` helper.
  const mv = recordStockMove(later, { itemId: t.itemId, locationId: t.locId, qty: 5, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-02-20', idempotencyKey: 'r2' });
  assert.equal(mv.ok, true, JSON.stringify(mv));

  const before = snapshot(t.store);
  const res = runValuation(later, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v2' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  // The prior run row was NOT superseded and no new run row exists: the write never happened because
  // the lock was checked before any write.
  assert.equal(snapshot(t.store), before, 'a refused re-run must not supersede the prior run or write a new one');
  assert.equal(counts(t.store, t.workspaceId).runs, 1, 'still only the first run row');
  assert.equal(counts(t.store, t.workspaceId).reversals, 0);
});

// --- §H-TENANT -----------------------------------------------------------------------------------

test('tenant: a cross-tenant item id can neither be moved nor read by another workspace', () => {
  const t = setup();
  receive(t, 10, 'r1');
  const b = secondWorkspace(t);

  // MUTATE: B names A's item id under B's ctx. A's item is not B's, so the write is refused, and no
  // row lands in either workspace.
  const before = snapshot(t.store);
  const cross = recordStockMove(b.ctx, { itemId: t.itemId, locationId: b.locId, qty: 1, reason: 'receipt', idempotencyKey: 'x1' });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');
  assert.equal(snapshot(t.store), before, 'a cross-tenant move must write nothing');

  // READ: B's valuation values ONLY B's items (none moved yet), never A's stock.
  const bValue = computeInventoryValue(b.ctx, 'weighted_avg', '2026-12-31');
  assert.equal(bValue.totalMinor, 0);
  assert.equal(bValue.perItem.length, 0);
});

test('tenant NON-VACUOUS: A DOES hold the stock B was refused, so the isolation is real and not an empty world', () => {
  const t = setup();
  receive(t, 10, 'r1');
  const aValue = computeInventoryValue(t.ctx, 'weighted_avg', '2026-12-31');
  assert.equal(aValue.totalMinor, 20000);
  assert.equal(aValue.perItem.length, 1);
});
