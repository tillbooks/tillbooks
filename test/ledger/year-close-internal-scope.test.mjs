/**
 * Critic R6-1 (cl-periods, 04.10.2026): the year close posts its P&L sweep and its 2979 carry under an
 * ENGINE-INTERNAL idempotency scope, and reads both back (and the year's balances) before it seals.
 *
 * THE DEFECT. `hardCloseYear` posted the sweep under `${key}:pl` and the carry under `${key}:carry` in
 * the PUBLIC `post_entry` scope. A `post_entry` under `K:pl` posted earlier was then REPLAYED as the
 * sweep: `close_year` answered ok and sealed the year while the P&L was never swept, permanently.
 *
 * THE TWO DEFENCES, each proven to stand on its own:
 *  1. The scope: `close_year_internal`, which no public verb writes. The exact repro below (a public
 *     `post_entry` under `K:pl` and `K:carry`) cannot reach it.
 *  2. The read-back: the entry a key answers with must be posted, `source='close'`, dated the year end
 *     and carry exactly the lines this close asked for; after the posts every P&L account must net to
 *     zero over the year and 2979 must be at zero. The cases below attack from INSIDE the engine (past
 *     the scope, the strongest position there is) by pre-claiming the internal keys directly, so each
 *     read-back guard has to bite with the scope defence already beaten. Any miss rolls the whole close
 *     back: no closing entry, no seal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hardCloseYear, postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import * as ledgerIndex from '../../dist/core/ledger/index.js';
import { postEntryInternal, YEAR_CLOSE_POST_SCOPE } from '../../dist/core/ledger/postEntry.js';
import { ACTIONS } from '../../dist/api/registry.js';
import { setup, idOf } from './a03-support.mjs';

let seq = 0;
const key = (tag) => `r6-${tag}-${(seq += 1)}`;

/** A book with one 2026 expense (6500 CHF 50.00 paid from 1000), ready to close. */
function book() {
  const w = setup();
  const acc = (n) => idOf(w.byNumber, n);
  const expense = postEntry(w.ctx, {
    date: '2026-03-01', source: 'manual', description: 'Büromaterial', idempotencyKey: key('exp'),
    lines: [{ account: acc('6500'), debit: 5000 }, { account: acc('1000'), credit: 5000 }],
  });
  assert.equal(expense.ok, true, JSON.stringify(expense));
  return { ...w, acc };
}

const seal = (w) => w.store.db.prepare("SELECT kind, reason FROM period_lock WHERE workspace_id = ? AND period = '2026'").get(w.workspaceId);
const closeEntries = (w) => w.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(w.workspaceId).n;
const balance = (w, number, to = '2026-12-31') =>
  w.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= ?`,
    )
    .get(w.workspaceId, w.acc(number), to).n;

/** Make the internal scope answer `K:<suffix>` with `entryId`, as if the key had been spent on it. */
function preClaimInternal(w, closeKey, suffix, entryId) {
  w.store.rememberIdempotent(w.workspaceId, `${closeKey}:${suffix}`, YEAR_CLOSE_POST_SCOPE, () => ({ ok: true, entryId }));
}

/** The close refused, rolled back whole: no closing entry, no seal. */
function assertRolledBack(w, res, entry, reason) {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'year_close_unverified', JSON.stringify(res));
  assert.equal(res.entry, entry, JSON.stringify(res));
  if (reason !== undefined) assert.equal(res.reason, reason, JSON.stringify(res));
  assert.equal(seal(w), undefined, 'a refused close never seals the year');
  assert.equal(closeEntries(w), 0, 'a refused close leaves no closing entry behind');
  assert.equal(balance(w, '6500'), 5000, 'the P&L is untouched');
}

test('R6-1 repro: a public post_entry under K:pl and K:carry cannot be replayed as the sweep or the carry', () => {
  const w = book();
  const closeKey = key('close');
  const decoys = ['pl', 'carry'].map((suffix) => {
    const d = postEntry(w.ctx, {
      date: '2026-12-31', source: 'manual', description: 'harmlos', idempotencyKey: `${closeKey}:${suffix}`,
      lines: [{ account: w.acc('1000'), debit: 1 }, { account: w.acc('1020'), credit: 1 }],
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    return d.entryId;
  });

  const res = hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(decoys.includes(res.closingEntryId), false, 'the sweep is a new entry, not the decoy');
  assert.equal(decoys.includes(res.carryEntryId), false, 'the carry is a new entry, not the decoy');
  assert.equal(balance(w, '6500'), 0, 'the P&L is swept');
  assert.equal(balance(w, '2979', '9999-12-31'), 0, '2979 is carried');
  assert.equal(balance(w, '2970'), 5000, 'the loss (a debit) lands on 2970');
  assert.deepEqual({ ...seal(w) }, { kind: 'hard', reason: 'year_close' });
  // A retry with the same key replays the close itself, never the decoys.
  assert.deepEqual(hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey }), res);
});

test('read-back guard 1: a sweep key answered by an entry that is not a close entry refuses and rolls back', () => {
  const w = book();
  const closeKey = key('close');
  const decoy = postEntry(w.ctx, {
    date: '2026-12-31', source: 'manual', description: 'harmlos', idempotencyKey: key('decoy'),
    lines: [{ account: w.acc('1000'), debit: 1 }, { account: w.acc('1020'), credit: 1 }],
  });
  preClaimInternal(w, closeKey, 'pl', decoy.entryId);
  assertRolledBack(w, hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey }), 'pl', 'not_close_source');
  // The close key is not burned: the same key closes the year once the slot is honest.
  w.store.db.prepare('DELETE FROM idempotency WHERE workspace_id = ? AND verb = ?').run(w.workspaceId, YEAR_CLOSE_POST_SCOPE);
  assert.equal(hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey }).ok, true);
});

test('read-back guard 1b: a sweep key answered by a DRAFT, or by an id the books do not hold, refuses', () => {
  for (const variant of ['draft', 'missing']) {
    const w = book();
    const closeKey = key('close');
    let entryId = 'je_nowhere';
    if (variant === 'draft') {
      const draft = saveDraft(w.ctx, {
        date: '2026-12-31', description: 'Entwurf', idempotencyKey: key('draft'),
        lines: [{ account: w.acc('6500'), credit: 5000 }, { account: w.acc('2979'), debit: 5000 }],
      });
      assert.equal(draft.ok, true, JSON.stringify(draft));
      entryId = draft.entryId;
    }
    preClaimInternal(w, closeKey, 'pl', entryId);
    assertRolledBack(w, hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey }), 'pl', variant === 'draft' ? 'not_posted' : 'missing');
  }
});

test('read-back guard 2: a close entry with other lines (or another date) is not this close and refuses', () => {
  for (const variant of ['lines', 'date']) {
    const w = book();
    const closeKey = key('close');
    const foreign = postEntryInternal(
      w.ctx,
      {
        date: variant === 'date' ? '2026-06-30' : '2026-12-31', source: 'close', description: 'fremd', idempotencyKey: key('foreign'),
        // The right accounts for the 'date' case (so only the date differs), a partial sweep for 'lines'.
        lines: variant === 'date'
          ? [{ account: w.acc('6500'), credit: 5000 }, { account: w.acc('2979'), debit: 5000 }]
          : [{ account: w.acc('6500'), credit: 1 }, { account: w.acc('2979'), debit: 1 }],
      },
      YEAR_CLOSE_POST_SCOPE,
    );
    assert.equal(foreign.ok, true, JSON.stringify(foreign));
    // The foreign close entry is itself in the books, so remove it from the count the helper checks.
    const before = closeEntries(w);
    preClaimInternal(w, closeKey, 'pl', foreign.entryId);
    const res = hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, 'year_close_unverified');
    assert.equal(res.entry, 'pl');
    assert.equal(res.reason, variant === 'date' ? 'wrong_date' : 'lines_differ');
    assert.equal(seal(w), undefined);
    assert.equal(closeEntries(w), before, 'nothing of the refused close stays');
  }
});

test('read-back guard 3: a carry key answered by anything else refuses, and the sweep rolls back with it', () => {
  const w = book();
  const closeKey = key('close');
  const decoy = postEntry(w.ctx, {
    date: '2026-12-31', source: 'manual', description: 'harmlos', idempotencyKey: key('decoy'),
    lines: [{ account: w.acc('1000'), debit: 1 }, { account: w.acc('1020'), credit: 1 }],
  });
  preClaimInternal(w, closeKey, 'carry', decoy.entryId);
  assertRolledBack(w, hardCloseYear(w.ctx, { year: '2026', idempotencyKey: closeKey }), 'carry', 'not_close_source');
});

test('read-back guard 4: a P&L account left standing after the sweep refuses the seal', () => {
  const w = book();
  // A close-sourced P&L posting in the year: the sweep's own query does not count it, so the sweep
  // misses its 100 on 6500 and the year would be sealed with 6500 not at zero.
  const stray = postEntryInternal(
    w.ctx,
    { date: '2026-05-01', source: 'close', description: 'Streuposten', idempotencyKey: key('stray'),
      lines: [{ account: w.acc('6500'), debit: 100 }, { account: w.acc('1020'), credit: 100 }] },
    YEAR_CLOSE_POST_SCOPE,
  );
  assert.equal(stray.ok, true, JSON.stringify(stray));
  const res = hardCloseYear(w.ctx, { year: '2026', idempotencyKey: key('close') });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'year_close_unverified');
  assert.equal(res.entry, 'balances');
  assert.deepEqual(res.accounts, ['6500']);
  assert.equal(seal(w), undefined);
  assert.equal(closeEntries(w), 1, 'only the stray stays; the refused sweep and carry rolled back');
});

test('a 2979 residual from an EARLIER year is carried, not mistaken for an unswept year', () => {
  const w = book();
  const stray = postEntry(w.ctx, {
    date: '2025-06-01', source: 'manual', description: 'Rest auf 2979', idempotencyKey: key('residual'),
    lines: [{ account: w.acc('2979'), debit: 700 }, { account: w.acc('1000'), credit: 700 }],
  });
  assert.equal(stray.ok, true, JSON.stringify(stray));
  const res = hardCloseYear(w.ctx, { year: '2026', idempotencyKey: key('close') });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(balance(w, '2979', '9999-12-31'), 0);
  assert.equal(balance(w, '6500'), 0);
});

test('the internal post entry point is on no wire', () => {
  assert.equal('postEntryInternal' in ledgerIndex, false);
  assert.equal(ACTIONS.some((a) => /internal/i.test(a.name)), false);
  assert.equal(YEAR_CLOSE_POST_SCOPE, 'close_year_internal');
  assert.equal(ACTIONS.some((a) => a.name === YEAR_CLOSE_POST_SCOPE), false);
});
