// @ts-check
// A03 defense-in-depth (K-33): a year_close HARD seal must never be masked by a coexisting month lock.
//
// SQLite BINARY collation makes 'YYYY' sort BELOW 'YYYY-MM' (the year label is a prefix of the month
// label), so `assertPeriodOpen`'s old `ORDER BY period DESC LIMIT 1` returned the MONTH lock when a
// month carried its own lock AND its fiscal year carried the year_close seal. postEntry then read
// `reason !== 'year_close'`, its close-relaxation branch (`source !== 'close' || isYearSeal`) went
// false, and a `source='close'` entry could post INTO an already year-close-sealed year: the exact
// invariant the guard's comment credits it with enforcing ("NEVER into an already year-close-sealed
// year"). This suite pins the seal so it can never be masked again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  postEntry,
  softCloseMonth,
  lockPeriod,
  assertPeriodOpen,
} from '../../dist/core/ledger/index.js';
import { setup, entry } from './a03-support.mjs';
import { errOf, okOf } from '../support/narrow.mjs';

test('assertPeriodOpen surfaces the year_close seal even when the month carries its own hard lock', () => {
  const { store, ctx, workspaceId } = setup();
  // The month carries a filing seal (vat_filed); its fiscal year carries the year_close seal.
  lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'ly' });
  lockPeriod(ctx, { period: '2026-12', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lm' });

  const refusal = errOf(assertPeriodOpen({ store, workspaceId }, '2026-12-31'), 'assertPeriodOpen into a sealed year');
  assert.equal(refusal.error, 'period_locked');
  // The lexicographically-highest lock is the MONTH ('2026-12' > '2026'); the seal must win regardless.
  assert.equal(refusal.reason, 'year_close', 'the year_close seal must not be masked by the month lock');
  assert.equal(refusal.period, '2026');
});

test("a source='close' entry is REFUSED into a year-close-sealed year that also carries a month lock", () => {
  const { ctx, byNumber } = setup();
  // Coexisting locks: the year is sealed by year_close, the month by a non-year_close reason.
  lockPeriod(ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'ly' });
  lockPeriod(ctx, { period: '2026-12', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lm' });

  // The close-relaxation lets source='close' post over a soft/filing lock, but NEVER into a year seal.
  const blocked = postEntry(
    ctx,
    entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-12-31', idempotencyKey: 'kc', source: 'close' }),
  );
  const refusal = errOf(blocked, "source='close' post into an already year-close-sealed year");
  assert.equal(refusal.error, 'period_locked');
  assert.equal(refusal.reason, 'year_close');
});

test('guard: a plain month lock with no year seal still reports its own reason (no false positive)', () => {
  const { store, ctx, workspaceId } = setup();
  lockPeriod(ctx, { period: '2026-12', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'lm' });

  const refusal = errOf(assertPeriodOpen({ store, workspaceId }, '2026-12-31'), 'assertPeriodOpen into a filed month');
  assert.equal(refusal.error, 'period_locked');
  assert.equal(refusal.reason, 'vat_filed', 'an ordinary month lock reports its own reason');
  assert.equal(refusal.period, '2026-12');
});

test("guard: the close-relaxation still lets source='close' post over a soft month lock (no year seal)", () => {
  const { ctx, byNumber } = setup();
  softCloseMonth(ctx, { period: '2026-11', idempotencyKey: 'sc' });

  const posted = postEntry(
    ctx,
    entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-11-30', idempotencyKey: 'kc', source: 'close' }),
  );
  okOf(posted, "source='close' post over a soft-closed month with no year seal");
});
