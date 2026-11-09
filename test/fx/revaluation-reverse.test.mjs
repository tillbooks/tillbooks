// A22 / D129 Q2, `fx_revaluation_reverse`: the money-path evidence for the revert of a posted revaluation
// run. The revert is a MIRROR PAIR (the Storno C dated the period end, its own reversal D the day after),
// never an edit and never `reverseEntry(E)` (E already carries its reversal R): every account nets to
// zero on BOTH dates, the trio (C, D, the run-row link) commits together or not at all, a replay under
// the same key writes nothing, a second key is already_reversed, a later standing run blocks with its
// name, and §H-TENANT holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { OWNED_REVERSAL_SOURCES } from '../../dist/core/ledger/reverseEntry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

function seedPosition(deps, ws, accId, { closingRate = '0.9520', periodEnd = '2026-06-30', key = 'seed' } = {}) {
  const posted = call(deps, ws, 'post_entry', {
    date: '2026-06-15',
    source: 'manual',
    currency: 'EUR',
    fxRate: '0.9600',
    description: 'EUR position',
    idempotencyKey: `${key}-pos`,
    lines: [
      { account: accId('1000'), debit: 1000000 },
      { account: accId('3200'), credit: 1000000 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const rate = call(deps, ws, 'record_exchange_rate', {
    baseCurrency: 'EUR',
    rate: closingRate,
    asOf: periodEnd,
    source: 'manual',
    method: 'daily',
    idempotencyKey: `${key}-rate`,
  });
  assert.equal(rate.ok, true, JSON.stringify(rate));
}

function postedRun(deps, ws, accId, over = {}) {
  seedPosition(deps, ws, accId, over);
  const run = call(deps, ws, 'post_fx_revaluation', { periodEnd: over.periodEnd ?? '2026-06-30', idempotencyKey: `${over.key ?? 'seed'}-post` });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.posted, true);
  return run;
}

/** Net (debit - credit) base Rappen on `number`, over posted lines dated at or before `upTo`. */
function balance(deps, ws, number, upTo) {
  return deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND a.number = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ws, number, upTo).net;
}

function entryCount(deps, ws) {
  return deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ws).n;
}

test('the revert books the mirror pair: C (source fx, period end) and D (its reversal, the day after); 1000 and 6949 net to zero on BOTH dates', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  // The seed: a EUR 10'000.00 asset booked at 0.9600 = CHF 9'600.00, revalued at 0.9520 = CHF 9'520.00.
  assert.equal(run.totalUnrealisedMinor, -8000);
  assert.equal(balance(deps, ws, '1000', '2026-06-30'), 952000);
  assert.equal(balance(deps, ws, '6949', '2026-06-30'), 8000);

  const reverted = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-1' });
  assert.equal(reverted.ok, true, JSON.stringify(reverted));
  assert.equal(reverted.runId, run.runId);
  assert.equal(reverted.entryId, run.entryId);
  assert.equal(reverted.reversalId, run.reversalId);
  assert.equal(reverted.stornoReversalDate, '2026-07-01');

  const storno = deps.store.db.prepare('SELECT date, source, reverses_entry_id, description FROM journal_entry WHERE id = ?').get(reverted.stornoEntryId);
  assert.deepEqual(storno, { date: '2026-06-30', source: 'fx', reverses_entry_id: null, description: 'Storno FX-Neubewertung per 2026-06-30' });
  const stornoRev = deps.store.db.prepare('SELECT date, source, reverses_entry_id FROM journal_entry WHERE id = ?').get(reverted.stornoReversalId);
  assert.deepEqual(stornoRev, { date: '2026-07-01', source: 'reversal', reverses_entry_id: reverted.stornoEntryId });

  // On the period end: E + C cancel. On the day after: E + R + C + D cancel. Book basis restored.
  assert.equal(balance(deps, ws, '1000', '2026-06-30'), 960000);
  assert.equal(balance(deps, ws, '6949', '2026-06-30'), 0);
  assert.equal(balance(deps, ws, '1000', '2026-07-01'), 960000);
  assert.equal(balance(deps, ws, '6949', '2026-07-01'), 0);
  // The mirror is line for line: C's lines are E's with the sides flipped, in order.
  const linesOf = (id) =>
    deps.store.db.prepare('SELECT a.number, l.base_debit_minor AS d, l.base_credit_minor AS c FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.rowid').all(id);
  assert.deepEqual(
    linesOf(reverted.stornoEntryId),
    linesOf(run.entryId).map((l) => ({ number: l.number, d: l.c, c: l.d })),
  );
  // The run row links the pair and the audit chain stamps the revert.
  const row = deps.store.db.prepare('SELECT storno_entry_id, storno_reversal_id, reversed_by, entry_id, reversal_id FROM fx_revaluation WHERE id = ?').get(run.runId);
  assert.deepEqual(row, { storno_entry_id: reverted.stornoEntryId, storno_reversal_id: reverted.stornoReversalId, reversed_by: 'agent', entry_id: run.entryId, reversal_id: run.reversalId });
  const audit = call(deps, ws, 'get_audit_log', { entityKind: 'fx_revaluation' });
  assert.ok(audit.rows.some((e) => e.entityId === run.runId && e.action === 'reverse'), JSON.stringify(audit));
});

test('§H-IDEMPOTENT on ROWS: the same key replays byte-identically and writes nothing; a different key is already_reversed', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  const first = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-k' });
  assert.equal(first.ok, true);
  const entries = entryCount(deps, ws);
  const replay = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-k' });
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(entryCount(deps, ws), entries);
  const other = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-other' });
  assert.equal(other.ok, false);
  assert.equal(other.error, 'already_reversed');
  assert.equal(other.stornoEntryId, first.stornoEntryId);
  assert.equal(entryCount(deps, ws), entries);
});

test('later_run_exists: a LATER standing run blocks the revert and is named; reverting newest first clears it', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const june = postedRun(deps, ws, accId, { key: 'jun' });
  const rate = call(deps, ws, 'record_exchange_rate', { baseCurrency: 'EUR', rate: '0.9400', asOf: '2026-09-30', source: 'manual', method: 'daily', idempotencyKey: 'sep-rate' });
  assert.equal(rate.ok, true);
  const sept = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-09-30', idempotencyKey: 'sep-post' });
  assert.equal(sept.ok, true, JSON.stringify(sept));
  assert.equal(sept.posted, true);

  const blocked = call(deps, ws, 'fx_revaluation_reverse', { runId: june.runId, idempotencyKey: 'rev-jun-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'later_run_exists');
  assert.equal(blocked.blockingRunId, sept.runId);
  assert.equal(blocked.blockingPeriodEnd, '2026-09-30');

  assert.equal(call(deps, ws, 'fx_revaluation_reverse', { runId: sept.runId, idempotencyKey: 'rev-sep' }).ok, true);
  const now = call(deps, ws, 'fx_revaluation_reverse', { runId: june.runId, idempotencyKey: 'rev-jun-2' });
  assert.equal(now.ok, true, JSON.stringify(now));
  assert.equal(balance(deps, ws, '6949', '2026-10-01'), 0);
});

test('§H-PERIOD and §H-ATOMIC: a locked period end refuses period_locked, and a locked NEXT day rolls the Storno back too (no orphan, no memo)', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  assert.equal(call(deps, ws, 'lock_period', { period: '2026-06', kind: 'soft', idempotencyKey: 'lock-jun' }).ok, true);
  const before = entryCount(deps, ws);
  const locked = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-locked' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'period_locked');
  assert.equal(entryCount(deps, ws), before);
  assert.equal(call(deps, ws, 'unlock_period', { period: '2026-06', idempotencyKey: 'unlock-jun' }).ok, true);

  assert.equal(call(deps, ws, 'lock_period', { period: '2026-07', kind: 'soft', idempotencyKey: 'lock-jul' }).ok, true);
  const orphan = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-orphan' });
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error, 'period_locked');
  assert.equal(orphan.period, '2026-07');
  assert.equal(entryCount(deps, ws), before, 'the Storno C is rolled back with its blocked reversal D');
  const row = deps.store.db.prepare('SELECT storno_entry_id FROM fx_revaluation WHERE id = ?').get(run.runId);
  assert.equal(row.storno_entry_id, null);
  // No memo either: once unlocked, the SAME key succeeds rather than replaying the refusal.
  assert.equal(call(deps, ws, 'unlock_period', { period: '2026-07', idempotencyKey: 'unlock-jul' }).ok, true);
  const retry = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-orphan' });
  assert.equal(retry.ok, true, JSON.stringify(retry));
});

test('not_found for an unknown run, and §H-TENANT: another workspace cannot revert this one\'s run', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  assert.equal(call(deps, ws, 'fx_revaluation_reverse', { runId: 'nope', idempotencyKey: 'x' }).error, 'not_found');
  const { workspaceId: other } = mintWorkspace(deps, 'Other GmbH', 'ws-other');
  const r = call(deps, other, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'y' });
  assert.equal(r.error, 'not_found');
  const row = deps.store.db.prepare('SELECT storno_entry_id FROM fx_revaluation WHERE id = ?').get(run.runId);
  assert.equal(row.storno_entry_id, null);
});

test('after a revert the period end is revaluable again through a fresh run once the old run is out of the way? No: the run row stays, and a re-post is already_posted', () => {
  // Stated rather than assumed: the UNIQUE (workspace, period_end) on fx_revaluation is A22's contract
  // and the revert does not delete the row (§H-AUDIT). A corrected revaluation of the same period end
  // is a product question for A22, not a side effect this verb takes on.
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  assert.equal(call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev' }).ok, true);
  const again = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'post-again' });
  assert.equal(again.error, 'already_posted');
});

// Ownership (critic BLOCKING, 2026-09-10). The pre-fix map owned `vat_settlement`, `accrual` and
// `provision` but not `fx`, and the run minted B and D through the raw `reverseEntry`. Reproduced: raw
// `reverse_entry` on the run's own auto-reversal B answered ok, the run row still read `storno_entry_id
// null`, `fx_revaluation_reverse` then answered ok too, and the open period at 2026-07-31 carried
// 6949 = +8'000 and 1000 = 952'000 instead of 0 and 960'000. Every assertion below failed on that dist.
test('ownership: the raw reverse_entry is refused owned_by fx_revaluation_reverse on A, B, C and D; the owner verb still nets the pair to zero on both dates', () => {
  assert.equal(OWNED_REVERSAL_SOURCES.fx, 'fx_revaluation_reverse');
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const run = postedRun(deps, ws, accId);
  const before = entryCount(deps, ws);
  const raw = (entryId, key) => call(deps, ws, 'reverse_entry', { entryId, idempotencyKey: key });

  const onA = raw(run.entryId, 'raw-a');
  assert.equal(onA.ok, false, JSON.stringify(onA));
  assert.equal(onA.error, 'owned_by');
  assert.equal(onA.verb, 'fx_revaluation_reverse');
  assert.equal(onA.source, 'fx');
  // B is `source='reversal'`: it inherits the owner of the entry it reverses.
  const onB = raw(run.reversalId, 'raw-b');
  assert.equal(onB.ok, false, JSON.stringify(onB));
  assert.equal(onB.error, 'owned_by');
  assert.equal(onB.verb, 'fx_revaluation_reverse');
  assert.equal(onB.ownedEntryId, run.entryId);
  assert.equal(entryCount(deps, ws), before, 'nothing was minted');
  assert.equal(deps.store.db.prepare('SELECT storno_entry_id FROM fx_revaluation WHERE id = ?').get(run.runId).storno_entry_id, null);

  // The owner verb is the ONE door, and it still works.
  const reverted = call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-owned' });
  assert.equal(reverted.ok, true, JSON.stringify(reverted));
  for (const [entryId, key] of [
    [reverted.stornoEntryId, 'raw-c'],
    [reverted.stornoReversalId, 'raw-d'],
  ]) {
    const r = raw(entryId, key);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'owned_by');
    assert.equal(r.verb, 'fx_revaluation_reverse');
  }
  assert.equal(entryCount(deps, ws), before + 2, 'C and D, nothing else');
  // After the revert every account nets to zero on the period end AND the day after: 6949 carries
  // nothing and 1000 is back at book basis, in the closed period, the open one and a month later.
  for (const upTo of ['2026-06-30', '2026-07-01', '2026-07-31']) {
    assert.equal(balance(deps, ws, '6949', upTo), 0, `6949 nets to zero at ${upTo}`);
    assert.equal(balance(deps, ws, '1000', upTo), 960000, `1000 is at book basis at ${upTo}`);
  }
  const fxNet = deps.store.db
    .prepare(
      `SELECT a.number, SUM(l.base_debit_minor - l.base_credit_minor) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.id IN (?, ?, ?, ?)
        GROUP BY a.number HAVING net <> 0`,
    )
    .all(ws, run.entryId, run.reversalId, reverted.stornoEntryId, reverted.stornoReversalId);
  assert.deepEqual(fxNet, [], 'A, B, C and D net to zero on every account');
  // A second revert is still already_reversed: the owner's own semantics are unchanged.
  assert.equal(call(deps, ws, 'fx_revaluation_reverse', { runId: run.runId, idempotencyKey: 'rev-again' }).error, 'already_reversed');

  // §H-TENANT: a foreign workspace is told not_found before it can learn who owns the entry.
  const { workspaceId: other } = mintWorkspace(deps, 'Other GmbH', 'ws-other');
  for (const entryId of [run.entryId, run.reversalId, reverted.stornoEntryId, reverted.stornoReversalId]) {
    const r = call(deps, other, 'reverse_entry', { entryId, idempotencyKey: `foreign-${entryId}` });
    assert.equal(r.error, 'not_found', JSON.stringify(r));
  }
  assert.equal(entryCount(deps, ws), before + 2);
});
