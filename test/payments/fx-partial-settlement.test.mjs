/**
 * K-34, the FINAL-SETTLEMENT base invariant for a foreign-currency position paid in partials.
 *
 * Each partial payment credits the receivable by a proportional share of the invoice's WHOLE booked
 * base, rounded independently (`baseShare` in payment.ts). `Σ round(share_i)` is not `round(Σ share_i)`,
 * so three independently rounded shares of one booked base need not sum back to it: a EUR 100.00
 * invoice booked at CHF 95.01 and settled 33.33 / 33.33 / 33.34 rounds to 31.67 / 31.67 / 31.68 =
 * CHF 95.02, one Rappen MORE than the CHF 95.01 the receivable carries. Before the fix that Rappen
 * sat forever on 1100 Debitoren of a FULLY paid invoice, and the realised FX on 3806/4906 was wrong
 * by the same Rappen.
 *
 * THE INVARIANT (a non-author critic confirms it bites): after a foreign position is fully settled,
 *   (a) the receivable 1100 nets to EXACTLY zero for that invoice's postings plus its payments, and
 *   (b) the realised FX difference on 3806/4906 equals the whole (Σ base cash arrived minus the
 *       booked base), because the rounding drift belongs in the account whose job is to hold a
 *       difference, never on the cleared receivable.
 *
 * The payments here are dated on the invoice's OWN day at the invoice's OWN rate, so no rate MOVED:
 * every Rappen on 3806 is the rounding drift and nothing else, which is what isolates the defect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { setup, issueInvoice, seedRate, legsOf, accountBalance, counts } from './support.mjs';

/** An EUR 100.00 invoice booked at 0.9501 (CHF 95.01), settled in three EUR partials at the SAME rate. */
function eurThirds() {
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.9501', asOf: '2026-07-01' });
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 10000, // EUR 100.00
    taxCode: 'none',
    currency: 'EUR',
    key: 'eur-thirds',
  });
  return { t, inv };
}

function payThird(ctx, t, inv, amountMinor, key) {
  return recordPayment(ctx, {
    direction: 'incoming',
    date: '2026-07-01',
    amountMinor,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: key,
  });
}

test('K-34: three partial FX settlements clear the receivable to EXACTLY its booked base', () => {
  const { t, inv } = eurThirds();

  // The invoice put EUR 100.00 on the receivable, booked at CHF 95.01 on its own day.
  assert.equal(inv.currency, 'EUR');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 9501);

  const p1 = payThird(t.ctx, t, inv, 3333, 'k34-p1');
  const p2 = payThird(t.ctx, t, inv, 3333, 'k34-p2');
  const p3 = payThird(t.ctx, t, inv, 3334, 'k34-p3');
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p2.ok, true, JSON.stringify(p2));
  assert.equal(p3.ok, true, JSON.stringify(p3));

  // The invoice is fully paid in its own currency.
  assert.equal(p3.documents[0].openMinor, 0);
  assert.equal(p3.documents[0].status, 'settled');

  // (a) THE INVARIANT: the receivable is flat. Before the fix it carried a permanent CHF 0.01 stub
  // (9501 debited, 9502 credited across the three shares), a Rappen owed on a settled invoice.
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1100'),
    0,
    'a fully settled FC invoice must leave nothing on 1100',
  );

  // (b) The whole rounding drift lives in the realised-FX account, and nowhere else. EUR 100.00 of
  // cash arrived worth CHF 95.02 in total (three converted partials), against a booked base of
  // CHF 95.01, so the realised difference is a CHF 0.01 gain: 3806 carries a credit of 1.
  const bankBase = accountBalance(t.store, t.workspaceId, '1020');
  const bookedBase = 9501;
  const realisedFx = -(accountBalance(t.store, t.workspaceId, '3806') + accountBalance(t.store, t.workspaceId, '4906'));
  assert.equal(bankBase, 9502, 'the base cash that arrived across the three partials');
  assert.equal(
    realisedFx,
    bankBase - bookedBase,
    'the realised FX on 3806/4906 is exactly the base cash arrived minus the booked base',
  );
  assert.equal(realisedFx, 1);

  // The gain surfaces on the CLOSING payment: its own entry carries the FX leg, the two intermediate
  // same-rate partials carried none (their cash base equalled the cash arrived).
  const p3legs = legsOf(t.store, t.workspaceId, p3.entryId).map((l) => [l.number, l.debit, l.credit]);
  assert.deepEqual(p3legs, [
    ['1020', 3168, 0], // EUR 33.34 at 0.9501
    ['1100', 0, 3167], // the base still on the receivable after the first two partials cleared 6334
    ['3806', 0, 1], // the residual rounding drift, realised
  ]);

  // §H-LEDGER: the whole world balances. Summed over EVERY account so it needs no knowledge of which
  // revenue account the invoice credited: base debits equal base credits across all posted entries.
  const worldNet = t.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND e.status = 'posted'`,
    )
    .get(t.workspaceId).net;
  assert.equal(worldNet, 0);
});

test('K-34: re-recording the closing partial is idempotent on ROWS (no double true-up)', () => {
  const { t, inv } = eurThirds();
  payThird(t.ctx, t, inv, 3333, 'k34i-p1');
  payThird(t.ctx, t, inv, 3333, 'k34i-p2');
  const first = payThird(t.ctx, t, inv, 3334, 'k34i-p3');
  assert.equal(first.ok, true, JSON.stringify(first));

  const before = counts(t.store, t.workspaceId);
  const replay = payThird(t.ctx, t, inv, 3334, 'k34i-p3');
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.paymentId, first.paymentId, 'a retry returns the original payment');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'no second payment, allocation or entry');
  // The receivable stays flat: the true-up did not fire a second time on replay.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
});

test('K-34 regression: a SINGLE full FC payment books exactly as before (true-up is a no-op)', () => {
  // The correct single-full-payment path must not shift: with nothing released prior and the whole
  // face settled, the trued-up cash base equals the independent share, so the entry is unchanged.
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.9501', asOf: '2026-07-01' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 10000, taxCode: 'none', currency: 'EUR', key: 'eur-full' });

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-01',
    amountMinor: 10000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 10000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'k34-full',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 9501, 0],
      ['1100', 0, 9501], // clears at exactly the booked base, no FX leg (same rate)
    ],
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
});

test('K-34 regression: a base-currency (CHF) invoice in three partials never enters the true-up', () => {
  // bookedBase === totalMinor for a CHF invoice, so `baseShare` is the identity and the true-up
  // branch is skipped entirely: three CHF partials clear 1100 to zero with no FX leg anywhere, the
  // shipped behaviour that must not change.
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 10000, taxCode: 'none', key: 'chf-thirds' });
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 10000);

  const pay = (amountMinor, key) =>
    recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor,
      bankAccountId: t.bankId,
      allocations: [{ documentId: inv.id, amountMinor }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: key,
    });
  assert.equal(pay(3333, 'chf-p1').ok, true);
  assert.equal(pay(3333, 'chf-p2').ok, true);
  const last = pay(3334, 'chf-p3');
  assert.equal(last.ok, true, JSON.stringify(last));

  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3806'), 0, 'no realised FX on a base-currency settlement');
  assert.equal(last.documents[0].status, 'settled');
});

/**
 * K-34 REMEDIATION, the non-cash-base leak the first fix left open (non-author critic, HIGH).
 *
 * The final-settlement true-up sets the closing cash base to `bookedBase` minus the base ALREADY
 * released off 1100 by prior partials. The first fix summed only `payment_allocation.base_amount_minor`,
 * the CASH base, and its comment ASSERTED that Skonto and a write-off only ever occur on the closing
 * allocation. Nothing in the engine enforces that: `planPayment` accepts Skonto and a write-off on a
 * partial that does NOT close the document (the only guard is `skonto <= open`). When a prior
 * non-closing partial carried Skonto or a write-off, the base it released off 1100 was NOT counted, so
 * the closing true-up over-credited the receivable and mis-stated realised FX by that same base.
 *
 * The repro dates every payment on the invoice's OWN day at its OWN rate, so no rate moved and the
 * CORRECT realised FX is exactly zero: every Rappen away from a flat 1100 and a flat 3806/4906 is the
 * leak and nothing else. Each assertion reads the posted `journal_line` rows straight back from the
 * store (never the write echo), so it witnesses the ledger and not the return value.
 */

/** An EUR 100.00 invoice booked at 0.9501 (CHF 95.01), tax-free so the Skonto carries no VAT leg. */
function eurInvoice(key) {
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.9501', asOf: '2026-07-01' });
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 10000, // EUR 100.00
    taxCode: 'none',
    currency: 'EUR',
    key,
  });
  return { t, inv };
}

function payAlloc(ctx, t, inv, alloc, key) {
  return recordPayment(ctx, {
    direction: 'incoming',
    date: '2026-07-01',
    amountMinor: alloc.amountMinor,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, ...alloc }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: key,
  });
}

test('K-34 remediation: Skonto on a NON-closing intermediate partial still clears the FC receivable to EXACTLY zero', () => {
  const { t, inv } = eurInvoice('eur-skonto-mid');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 9501);

  // Partial 1 releases base off 1100 through TWO lines, cash AND Skonto, and it does NOT close the
  // document (EUR 30.00 cash + EUR 2.00 Skonto settles EUR 32.00 of EUR 100.00, EUR 68.00 stays open).
  const p1 = payAlloc(t.ctx, t, inv, { amountMinor: 3000, skontoMinor: 200 }, 'k34r-p1');
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p1.documents[0].openMinor, 6800, 'the intermediate partial leaves EUR 68.00 open');
  assert.notEqual(p1.documents[0].status, 'settled');

  // The Skonto base actually left 1100: EUR 2.00 at 0.9501 books CHF 1.90 to 3800, and the cash EUR
  // 30.00 books CHF 28.50, so 1100 carries 9501 - 2850 - 190 = 6461 after the first partial.
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, p1.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 2850, 0], // EUR 30.00 at 0.9501
      ['1100', 0, 3040], // cash base 2850 + Skonto base 190, both off the receivable
      ['3800', 190, 0], // the Skonto (Erlösminderung), CHF 1.90 of base
    ],
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 6461);

  // Partial 2 is a plain EUR 68.00 cash payment that CLOSES the document and fires the true-up.
  const p2 = payAlloc(t.ctx, t, inv, { amountMinor: 6800 }, 'k34r-p2');
  assert.equal(p2.ok, true, JSON.stringify(p2));
  assert.equal(p2.documents[0].openMinor, 0);
  assert.equal(p2.documents[0].status, 'settled');

  // THE INVARIANT (the leak the critic caught): the receivable is flat. Before the remediation the
  // true-up counted only the 2850 cash base of partial 1 and MISSED its 190 Skonto base, so it
  // over-credited 1100 by 190 and the account closed at -190 (CHF 1.90 owed on a settled invoice).
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1100'),
    0,
    'the FC receivable must clear to exactly zero even when a prior partial carried Skonto',
  );

  // No rate moved, so the CORRECT realised FX is exactly zero. Pre-remediation it was wrong by the
  // same CHF 1.90: the closing cash base was trued up to 6651 instead of 6461, and the 190 surplus
  // over the 6461 of base cash that actually arrived was dumped into the FX plug as a phantom loss.
  const realisedFx =
    accountBalance(t.store, t.workspaceId, '3806') + accountBalance(t.store, t.workspaceId, '4906');
  assert.equal(realisedFx, 0, 'no rate moved, so realised FX must be zero, not the leaked Rappen');

  // The closing entry books the base still on the receivable (6461) with NO FX leg, because the base
  // cash that arrived (EUR 68.00 at 0.9501 = 6461) equals it exactly once the true-up is correct.
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, p2.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 6461, 0],
      ['1100', 0, 6461],
    ],
  );

  // §H-LEDGER: the whole world still balances, base debits equal base credits over every posting.
  const worldNet = t.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND e.status = 'posted'`,
    )
    .get(t.workspaceId).net;
  assert.equal(worldNet, 0);
});

test('K-34 remediation: a write-off on a NON-closing intermediate partial is counted too', () => {
  const { t, inv } = eurInvoice('eur-writeoff-mid');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 9501);

  // Partial 1: EUR 30.00 cash + EUR 2.00 written off, settling EUR 32.00 and leaving EUR 68.00 open.
  // The write-off base (CHF 1.90) leaves 1100 through the write-off account, not the cash line.
  const p1 = payAlloc(t.ctx, t, inv, { amountMinor: 3000, writeOffMinor: 200 }, 'k34rw-p1');
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p1.documents[0].openMinor, 6800);
  assert.notEqual(p1.documents[0].status, 'settled');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 6461, 'cash 2850 + write-off 190 off 1100');

  // Partial 2 closes with EUR 68.00 cash and fires the true-up.
  const p2 = payAlloc(t.ctx, t, inv, { amountMinor: 6800 }, 'k34rw-p2');
  assert.equal(p2.ok, true, JSON.stringify(p2));
  assert.equal(p2.documents[0].openMinor, 0);
  assert.equal(p2.documents[0].status, 'settled');

  // The invariant: the prior write-off base is counted, so 1100 clears to zero and realised FX is
  // zero. Before the remediation this closed at -190 exactly as the Skonto case did.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0, 'a prior write-off base must clear too');
  assert.equal(
    accountBalance(t.store, t.workspaceId, '3806') + accountBalance(t.store, t.workspaceId, '4906'),
    0,
    'no rate moved, so realised FX must be zero',
  );
});
