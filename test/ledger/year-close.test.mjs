// @ts-check
// A03 US-A03.3: the year-end hard close. Posts (via A02, source='close') a closing entry that zeroes
// the P&L accounts into 2979, carries 2979 into 2970, seals the year with a hard lock, and is
// idempotent (never a double carry). The carry equals Sigma income - Sigma expense to the Rappen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, hardCloseYear, softCloseMonth, listPeriodLocks, getAuditLog } from '../../dist/core/ledger/index.js';
import { setup, entry, balanceOf, idOf } from './a03-support.mjs';
import { obj, objs, okOf } from '../support/narrow.mjs';

// Book a profit: income 3000 credited 10000, expense 6500 debited 4000 => result +6000.
function bookProfitYear(ctx, byNumber) {
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 10000, date: '2026-05-01', idempotencyKey: 'inc1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 4000, date: '2026-06-01', idempotencyKey: 'exp1' }));
}

test('year-close zeroes the P&L, carries the result to 2970, and seals the year', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  bookProfitYear(ctx, byNumber);

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true);
  assert.equal(closed.result, 6000, 'result = 10000 income - 4000 expense');

  // P&L accounts net to zero after the close.
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '3000')), 0);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '6500')), 0);
  // 2979 nets to zero (opened and carried out).
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2979')), 0);
  // 2970 carries the profit: a profit is a credit balance, i.e. net (debit - credit) = -6000.
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), -6000);

  const yearLock = obj(
    objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026'),
    'the 2026 period lock',
  );
  assert.equal(yearLock.kind, 'hard');
  assert.equal(yearLock.reason, 'year_close');
});

test('a loss carries the opposite way (2970 ends with a debit balance)', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  // income 2000, expense 5000 => result -3000 (loss).
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 2000, date: '2026-05-01', idempotencyKey: 'inc1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 5000, date: '2026-06-01', idempotencyKey: 'exp1' }));

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.result, -3000);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '3000')), 0);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '6500')), 0);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2979')), 0);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), 3000, 'a loss is a debit balance on 2970');
});

test('year-close is idempotent on its key: re-running never double-carries', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  bookProfitYear(ctx, byNumber);

  const first = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  const again = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(again.ok, true);
  assert.equal(again.closingEntryId, first.closingEntryId, 'the same close is replayed');
  // 2970 still carries exactly one result, not two.
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), -6000);
});

test('re-closing a sealed year with a different key returns year_already_closed', () => {
  const { ctx, byNumber } = setup();
  bookProfitYear(ctx, byNumber);
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  const other = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'a-different-key' });
  assert.equal(other.ok, false);
  assert.equal(other.error, 'year_already_closed');
});

test('the closing entry posts even though the year-end month may be soft-locked (source=close exemption)', () => {
  const { ctx, byNumber } = setup();
  bookProfitYear(ctx, byNumber);
  // Soft-close December: a source='close' posting dated 2026-12-31 must still land.
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 1, date: '2026-11-01', idempotencyKey: 'nov' }));
  softCloseMonth(ctx, { period: '2026-12', idempotencyKey: 'dec-close' });

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, 'the year still closes over a soft-locked December');
});

test('an empty year still closes: zero result, no carry entry, but the year is sealed', () => {
  const { ctx } = setup();
  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true);
  assert.equal(closed.result, 0);
  assert.equal(obj(
    objs(listPeriodLocks(ctx).locks, 'listPeriodLocks.locks').find((l) => l.period === '2026'),
    'the 2026 period lock',
  ).kind, 'hard');
});

test('the closing entries carry source=close and stamp audit action=close', () => {
  const { ctx, byNumber } = setup();
  bookProfitYear(ctx, byNumber);
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });

  const log = okOf(getAuditLog(ctx, {}), 'getAuditLog');
  assert.equal(log.chainVerified, true);
  assert.ok(
    objs(log.rows, 'getAuditLog.rows').some((r) => r.action === 'close'),
    'a close action is recorded',
  );
});

test('a non-January fiscal year closes on its own boundary', () => {
  const { ctx, store, workspaceId, byNumber } = setup({ fiscalYearStart: '04-01' });
  // Fiscal year 2026 = Apr 2026 .. Mar 2027. Book income inside it (2026-05) and outside it (2026-02).
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 7000, date: '2026-05-01', idempotencyKey: 'in' }));
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 9999, date: '2026-02-01', idempotencyKey: 'out' }));

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-fy2026' });
  assert.equal(closed.result, 7000, 'only the income inside fiscal year 2026 is included');
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), -7000);
});
