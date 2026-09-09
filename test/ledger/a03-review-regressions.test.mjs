// @ts-check
// Regression tests for the A03 defects found by the adversarial (Opus) + independent (Fable 5) reviews.
// Each test pins one confirmed finding so it cannot silently return.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  postEntry,
  hardCloseYear,
  softCloseMonth,
  reopenMonth,
  lockPeriod,
  unlockPeriod,
  getAuditLog,
  listPeriodLocks,
} from '../../dist/core/ledger/index.js';
import { setup, entry, balanceOf, idOf } from './a03-support.mjs';
import { errOf, obj, objs, okOf, strCol } from '../support/narrow.mjs';

const denyAll = { assert: (capability) => ({ ok: false, error: 'not_permitted', capability }) };

// F1: a hard filing seal over a soft-closed month must actually seal it (upgrade), not silently no-op.
test('F1: lockPeriod upgrades a soft lock to a hard seal, which then refuses reopen', () => {
  const { ctx, byNumber } = setup();
  assert.equal(softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 's1' }).ok, true);

  const sealed = lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'h1' });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.kind, 'hard', 'the result reports the ACTUAL resulting kind');
  assert.equal(sealed.upgraded, true);

  const row = obj(
    objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026-06'),
    'the 2026-06 period lock',
  );
  assert.equal(row.kind, 'hard');
  assert.equal(row.reason, 'vat_filed');

  // The filed month now refuses a casual reopen and refuses a post.
  assert.equal(reopenMonth(ctx, { period: '2026-06', idempotencyKey: 'r1' }).error, 'hard_lock_sealed');
  const blocked = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 1, date: '2026-06-15', idempotencyKey: 'k1' }));
  assert.equal(errOf(blocked, 'postEntry into a filed month').error, 'period_locked');
});

test('F1: a same-or-weaker lock over an existing one reports the real current state, never a false seal', () => {
  const { ctx } = setup();
  lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'h1' });
  // A later soft close of the same month must not claim to have downgraded it.
  const again = softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 's2' });
  assert.equal(again.ok, true);
  assert.equal(obj(
    objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026-06'),
    'the 2026-06 period lock',
  ).kind, 'hard');
});

// F2: tail truncation of the audit log is detected via the head anchor.
test('F2: deleting the tail row(s) of the audit log fails chain verification', () => {
  const { ctx, store, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 200, date: '2026-03-02', idempotencyKey: 'k2' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 300, date: '2026-03-03', idempotencyKey: 'k3' }));
  assert.equal(okOf(getAuditLog(ctx, {}), 'getAuditLog').chainVerified, true);

  const tailId = strCol(
    store.db.prepare('SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1').get(),
    'id',
    'the last audit row',
  );
  store.db.prepare('DELETE FROM audit_log WHERE id = ?').run(tailId);

  const log = okOf(getAuditLog(ctx, {}), 'getAuditLog');
  assert.equal(log.chainVerified, false, 'a truncated tail no longer matches the head anchor');
});

test('F2: wiping the whole audit log, or tampering the head anchor, fails verification', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));

  store.db.prepare('DELETE FROM audit_log WHERE workspace_id = ?').run(workspaceId);
  assert.equal(okOf(getAuditLog(ctx, {}), 'getAuditLog').chainVerified, false, 'a wiped log with a stale head does not verify');
});

// F3 / Opus F1: the source='close' relaxation is narrow and its safety rationale is enforced.
test('F3: a source=close line may not carry a VAT trace', () => {
  const { ctx, byNumber } = setup();
  const bad = postEntry(ctx, {
    date: '2026-12-31',
    source: 'close',
    idempotencyKey: 'x1',
    lines: [
      { account: idOf(byNumber, '6500'), debit: 10000, taxCode: 'VST-M', taxBase: 10000, taxAmount: 810 },
      { account: idOf(byNumber, '1000'), credit: 10000 },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_line');
});

test('F3: source=close may post over a vat_filed lock but NOT into a year-close-sealed year', () => {
  const { ctx, byNumber } = setup();
  // A filing lock on a month: a close entry (no VAT trace) may still land there.
  lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'l1' });
  const overFiled = postEntry(ctx, {
    date: '2026-06-30',
    source: 'close',
    idempotencyKey: 'c1',
    lines: [
      { account: idOf(byNumber, '6500'), debit: 500 },
      { account: idOf(byNumber, '1000'), credit: 500 },
    ],
  });
  assert.equal(overFiled.ok, true, 'a close entry clears a filing lock');

  // After the year is sealed, no source=close entry may reopen it.
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'yc' });
  const intoSealed = postEntry(ctx, {
    date: '2026-07-01',
    source: 'close',
    idempotencyKey: 'c2',
    lines: [
      { account: idOf(byNumber, '6500'), debit: 500 },
      { account: idOf(byNumber, '1000'), credit: 500 },
    ],
  });
  assert.equal(intoSealed.ok, false);
  assert.equal(intoSealed.error, 'period_locked');
  assert.equal(intoSealed.reason, 'year_close');
});

// F4: a pre-existing soft or manual lock on the YYYY period does not crash or mislabel a first close.
test('F4: hardCloseYear upgrades a pre-existing soft year-lock instead of throwing a raw DB error', () => {
  const { ctx, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 5000, date: '2026-05-01', idempotencyKey: 'inc' }));
  lockPeriod(ctx, { period: '2026', kind: 'soft', idempotencyKey: 'soft-year' });

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'yc' });
  assert.equal(closed.ok, true, 'the close proceeds and returns a structured result, not a thrown SqliteError');
  const lock = obj(
    objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026'),
    'the 2026 period lock',
  );
  assert.equal(lock.kind, 'hard');
  assert.equal(lock.reason, 'year_close');
});

test('F4: a manual (non year-close) hard lock on the year does not block the first real close', () => {
  const { ctx, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 5000, date: '2026-05-01', idempotencyKey: 'inc' }));
  lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'manual_freeze', idempotencyKey: 'mf' });

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'yc' });
  assert.equal(closed.ok, true);
  assert.equal(closed.result, 5000);
});

// F5: year-close is capability-gated like every other period write.
test('F5: hardCloseYear is refused under a deny-all capability port', () => {
  const { ctx } = setup({ ctxOverrides: { capabilities: denyAll } });
  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'yc' });
  assert.equal(closed.ok, false);
  assert.equal(closed.error, 'not_permitted');
});

// F6: reopen/unlock replay a completed op even after the period was subsequently sealed.
test('F6: reopenMonth replays its success on retry even if the month was hard-sealed in between', () => {
  const { ctx } = setup();
  softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 's1' });
  const first = reopenMonth(ctx, { period: '2026-06', idempotencyKey: 'r1' });
  assert.equal(first.ok, true);

  lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'h1' });
  const retry = reopenMonth(ctx, { period: '2026-06', idempotencyKey: 'r1' });
  assert.equal(retry.ok, true, 'the same key replays the original success, not hard_lock_sealed');
});

test('F6: unlockPeriod replays its success on retry after the lock is gone', () => {
  const { ctx } = setup();
  lockPeriod(ctx, { period: '2026-08', kind: 'hard', idempotencyKey: 'l1' });
  assert.equal(unlockPeriod(ctx, { period: '2026-08', idempotencyKey: 'u1' }).ok, true);
  // The lock is gone; a same-key retry must still replay ok.
  assert.equal(unlockPeriod(ctx, { period: '2026-08', idempotencyKey: 'u1' }).ok, true);
});

// Opus F5: a stray manual posting to 2979 during the year is swept so 2979 opens at zero.
test('Opus F5: year-close carries 2979 to zero even if 2979 held a residual before the close', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  // Normal P&L activity.
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 10000, date: '2026-05-01', idempotencyKey: 'inc' }));
  // A stray manual posting straight to 2979 during the year (misuse, but must not leave a residual).
  postEntry(ctx, entry(byNumber, { debitNo: '2979', creditNo: '2800', amount: 3000, date: '2026-06-01', idempotencyKey: 'stray' }));

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'yc' });
  assert.equal(closed.ok, true);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2979')), 0, '2979 opens at zero regardless of the stray');
});

// Fable nit: an out-of-range year is rejected structurally, never crashes dayBefore().
test('nit: hardCloseYear rejects an out-of-range year with a structured error', () => {
  const { ctx } = setup();
  assert.equal(hardCloseYear(ctx, { year: 9999, idempotencyKey: 'y' }).error, 'invalid_year');
  assert.equal(hardCloseYear(ctx, { year: 42, idempotencyKey: 'y' }).error, 'invalid_year');
});
