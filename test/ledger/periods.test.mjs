// @ts-check
// A03 US-A03.2 / A03.4 / A03.6: period locks and the assertPeriodOpen guard A02 honours.
//
// Soft close is a reversible guardrail; a hard lock with a filing/year seal refuses casual reopen.
// Posting into a locked month or fiscal year returns period_locked (P9), EXCEPT source='close' (the
// year-close sealing act, single-sourced exemption).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  postEntry,
  softCloseMonth,
  reopenMonth,
  lockPeriod,
  unlockPeriod,
  listPeriodLocks,
  assertPeriodOpen,
} from '../../dist/core/ledger/index.js';
import { setup, entry } from './a03-support.mjs';
import { errOf, objs, obj } from '../support/narrow.mjs';

test('softCloseMonth writes a soft lock; posting into that month returns period_locked', () => {
  const { ctx, byNumber } = setup();
  const closed = softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 'c1' });
  assert.equal(closed.ok, true);

  const blocked = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-06-15', idempotencyKey: 'k1' }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'period_locked');
  assert.equal(blocked.period, '2026-06');
  assert.equal(blocked.kind, 'soft');
});

test('a post into a different, open month still succeeds', () => {
  const { ctx, byNumber } = setup();
  softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 'c1' });
  const ok = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-07-01', idempotencyKey: 'k1' }));
  assert.equal(ok.ok, true);
});

test('softCloseMonth is idempotent: re-closing is a no-op, not an error', () => {
  const { ctx } = setup();
  assert.equal(softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 'c1' }).ok, true);
  assert.equal(softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 'c2' }).ok, true);
  assert.equal(objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').filter((l) => l.period === '2026-06').length, 1);
});

test('reopenMonth clears a soft lock and posting works again', () => {
  const { ctx, byNumber } = setup();
  softCloseMonth(ctx, { period: '2026-06', idempotencyKey: 'c1' });
  const reopened = reopenMonth(ctx, { period: '2026-06', idempotencyKey: 'o1' });
  assert.equal(reopened.ok, true);
  const ok = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-06-15', idempotencyKey: 'k1' }));
  assert.equal(ok.ok, true);
});

test('reopenMonth refuses a sealed hard lock (hard_lock_sealed)', () => {
  const { ctx } = setup();
  lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'l1' });
  const reopened = reopenMonth(ctx, { period: '2026-06', idempotencyKey: 'o1' });
  assert.equal(reopened.ok, false);
  assert.equal(reopened.error, 'hard_lock_sealed');
});

test('lockPeriod is idempotent and blocks posting; listPeriodLocks shows it', () => {
  const { ctx, byNumber } = setup();
  assert.equal(lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'l1' }).ok, true);
  assert.equal(lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'l2' }).ok, true);

  const blocked = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-06-15', idempotencyKey: 'k1' }));
  const refusal = errOf(blocked, 'postEntry into a hard-locked month');
  assert.equal(refusal.error, 'period_locked');
  assert.equal(refusal.kind, 'hard');

  const locks = objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks');
  const june = obj(
    locks.find((l) => l.period === '2026-06'),
    'the 2026-06 lock listPeriodLocks reports',
  );
  assert.equal(june.kind, 'hard');
  assert.equal(june.reason, 'vat_filed');
});

test('unlockPeriod refuses a filing/year seal but clears an unsealed manual hard lock', () => {
  const { ctx } = setup();
  lockPeriod(ctx, { period: '2026-06', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'l1' });
  assert.equal(unlockPeriod(ctx, { period: '2026-06', idempotencyKey: 'u1' }).error, 'hard_lock_sealed');

  lockPeriod(ctx, { period: '2026-08', kind: 'hard', idempotencyKey: 'l2' });
  assert.equal(unlockPeriod(ctx, { period: '2026-08', idempotencyKey: 'u2' }).ok, true);
  assert.equal(objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026-08'), undefined);
});

test('a locked fiscal YEAR blocks a post dated anywhere in that year', () => {
  const { ctx, byNumber } = setup();
  lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'l1' });
  const blocked = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-15', idempotencyKey: 'k1' }));
  const refusal = errOf(blocked, 'postEntry into a locked fiscal year');
  assert.equal(refusal.error, 'period_locked');
  assert.equal(refusal.period, '2026');
});

test('assertPeriodOpen resolves the fiscal year for a non-January fiscal_year_start', () => {
  const { ctx, store, workspaceId } = setup({ fiscalYearStart: '04-01' });
  // Fiscal year 2026 = 2026-04-01 .. 2027-03-31. A hard lock on '2026' must block 2027-02, not 2026-02.
  lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'l1' });

  const blockedNextCal = assertPeriodOpen({ store, workspaceId }, '2027-02-15');
  assert.equal(blockedNextCal.error, 'period_locked', '2027-02 is inside fiscal year 2026');

  const openSameCal = assertPeriodOpen({ store, workspaceId }, '2026-02-15');
  assert.equal(openSameCal.ok, true, '2026-02 belongs to fiscal year 2025, still open');
});

test('softCloseMonth rejects a malformed period', () => {
  const { ctx } = setup();
  assert.equal(softCloseMonth(ctx, { period: '2026', idempotencyKey: 'c1' }).ok, false);
  assert.equal(softCloseMonth(ctx, { period: 'June', idempotencyKey: 'c2' }).ok, false);
});
