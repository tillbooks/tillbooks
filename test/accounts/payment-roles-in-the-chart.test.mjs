// A01 x A14: the shipped chart has to CONTAIN the accounts the payments engine posts to.
//
// A14 resolves every posting account by NUMBER out of the workspace chart, and refuses with
// `needs_account` when the number is absent. So an account missing from A01's core seed is not a
// cosmetic gap: the settlement does not post at all on a workspace a real user just created.
//
// No A14 test caught this, because `test/payments/support.mjs` used to insert the missing numbers
// by raw SQL before every case, one of them under a name no Swiss chart has ever carried. That
// injection is gone and the fixture now asserts it can never come back. Every workspace below is
// built the way a user actually gets one (createWorkspace and nothing else), so the chart is judged
// on what it really ships. Every assertion reads the POSTED journal rows back out of SQLite: a
// return value would only prove what the engine believed it wrote.
//
// PROVENANCE of the numbers (Schweizer Kontenrahmen KMU, the Sterchi/Mattle/Helbling standard).
// Verified 2026-07-25 against the full Masterkontenrahmen and two independent reproductions:
//   38   Erlösminderungen (class 3, Ertrag)
//     3800 Skonti .............. the sales-side reduction of revenue. Already seeded.
//     3805 Verluste Forderungen, Veränderung Wertberichtigungen ... the write-off target.
//     3806 Kursdifferenzen ..... a CURRENCY account. It is not, and never was, a write-off account.
//   49   Einkaufspreisminderungen (class 4, Aufwand)
//     4900 Skonti .............. the purchase-side reduction of cost.
//     4906 Kursdifferenzen ..... 3806's purchase-side twin.
//   69   Finanzaufwand und Finanzertrag
//     6949 Währungsverluste .... the FINANCIAL-result currency loss (gain twin 6999, an Ertrag).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { createContact, createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { recordPayment, PAYMENT_INTENTS, ROLE_ACCOUNT_NUMBER } from '../../dist/core/payments/index.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';

const byNumber = Object.fromEntries(KMU_CORE_SEED.map((a) => [a.number, a]));

/**
 * A workspace exactly as `createWorkspace` leaves it: the core chart and nothing added by hand.
 * That absence is the whole point of this file, so nothing here may create an account.
 */
function freshWorkspace(at = '2026-07-01T00:00:00.000Z') {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });

  const vat = configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'vat' });
  if (!vat.ok) throw new Error(`vat config failed: ${vat.error}`);
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'c1' });
  if (!contact.ok) throw new Error(`contact failed: ${contact.error}`);

  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;

  return {
    store,
    ctx,
    workspaceId,
    acc,
    bankId: acc('1020'),
    customerId: contact.contact.id,
    at: (iso) => makeContext(store, { workspaceId, actor: 'user_1', clock: fixedClock(iso), ids }),
  };
}

/** The posted journal rows of one entry, joined to the chart, straight out of SQLite. */
function legsOf(store, workspaceId, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, a.name AS name, a.type AS type,
              l.debit_minor AS debit, l.credit_minor AS credit
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ?
        ORDER BY a.number`,
    )
    .all(entryId, workspaceId);
}

/** Net movement on one account number across every POSTED entry. */
function balanceOf(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}

function rowCounts(store, workspaceId) {
  const one = (sql) => store.db.prepare(sql).get(workspaceId).n;
  return {
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    lines: one(
      `SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
    ),
  };
}

function seedRate(ctx, currency, rate, asOf) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate,
    asOf,
    source: 'manual',
    method: 'daily',
    provenance: 'test fixture',
    idempotencyKey: `rate-${currency}-${asOf}`,
  });
  if (!res.ok) throw new Error(`rate failed: ${JSON.stringify(res)}`);
}

function issueInvoice(ctx, { contactId, netMinor, taxCode, currency, key }) {
  const created = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: netMinor, taxCode }],
    ...(currency !== undefined ? { currency } : {}),
    idempotencyKey: `${key}-create`,
  });
  if (!created.ok) throw new Error(`create invoice failed: ${created.error}`);
  const issued = transitionDocument(ctx, { documentId: created.document.id, to: 'issued', idempotencyKey: `${key}-issue` });
  if (!issued.ok) throw new Error(`issue invoice failed: ${issued.error}`);
  return issued.document;
}

/** A EUR 1'000.00 invoice booked at 0.95, settled in full on a day the rate has moved to 0.97. */
function settleEurInvoiceAcrossARateMove(t) {
  seedRate(t.ctx, 'EUR', '0.95', '2026-07-01');
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    currency: 'EUR',
    key: 'eur',
  });
  const later = t.at('2026-07-19T00:00:00.000Z');
  seedRate(later, 'EUR', '0.97', '2026-07-19');
  return {
    inv,
    later,
    pay: (idempotencyKey) =>
      recordPayment(later, {
        direction: 'incoming',
        date: '2026-07-19',
        amountMinor: 100000,
        currency: 'EUR',
        bankAccountId: t.bankId,
        allocations: [{ documentId: inv.id, amountMinor: 100000 }],
        intent: PAYMENT_INTENTS.record,
        idempotencyKey,
      }),
  };
}

// --- the defect: a fresh workspace cannot settle in a foreign currency ---------------------------

test('a fresh workspace settles a foreign-currency invoice, and the realised difference posts', () => {
  const t = freshWorkspace();
  const { pay } = settleEurInvoiceAcrossARateMove(t);

  const res = pay('p-fx');
  assert.equal(res.ok, true, `a fresh workspace must be able to settle in a foreign currency: ${JSON.stringify(res)}`);

  const legs = legsOf(t.store, t.workspaceId, res.entryId);

  // THE INVARIANT, not the shape of the seed change: a settlement across a rate move is only
  // correct if the entry balances AND the realised difference is exactly the rate move on the
  // amount that settled. Both figures are computed here from the two rates, never read off the
  // engine, so a wrong plug cannot agree with them by construction.
  const settledForeignMinor = 100000;
  const bookedAtIssueMinor = Math.round(settledForeignMinor * 0.95); // 95'000 Rappen
  const arrivedAtPaymentMinor = Math.round(settledForeignMinor * 0.97); // 97'000 Rappen
  const realisedMinor = arrivedAtPaymentMinor - bookedAtIssueMinor; // a gain of 2'000 Rappen

  assert.equal(
    legs.reduce((n, l) => n + l.debit, 0),
    legs.reduce((n, l) => n + l.credit, 0),
    'the posted entry balances to the Rappen',
  );
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0, 'the receivable is fully released');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), arrivedAtPaymentMinor, 'the bank carries what arrived');

  // The gain is a CREDIT, so the net movement on the account is negative by exactly the rate move.
  const fxNumber = ROLE_ACCOUNT_NUMBER.salesFxRealised;
  assert.equal(
    balanceOf(t.store, t.workspaceId, fxNumber),
    -realisedMinor,
    `the realised currency difference lands in ${fxNumber}`,
  );

  // And it landed on a REAL chart account, not on something conjured to make the posting close.
  const fxLeg = legs.find((l) => l.number === fxNumber);
  assert.ok(fxLeg, `the posting carries a ${fxNumber} leg`);
  assert.equal(fxLeg.credit, realisedMinor);
  assert.ok(byNumber[fxNumber], `${fxNumber} is part of the shipped core seed, not a per-test fixture`);
  assert.equal(fxLeg.name, byNumber[fxNumber].labels.de, 'the posted account carries the seed label');
});

test('re-recording the same foreign-currency settlement does not double-post', () => {
  const t = freshWorkspace();
  const { pay } = settleEurInvoiceAcrossARateMove(t);

  const first = pay('p-fx-once');
  assert.equal(first.ok, true, JSON.stringify(first));
  const after = rowCounts(t.store, t.workspaceId);
  const fxAfter = balanceOf(t.store, t.workspaceId, ROLE_ACCOUNT_NUMBER.salesFxRealised);

  const again = pay('p-fx-once');
  assert.equal(again.ok, true, JSON.stringify(again));

  // Posting is idempotent, and the currency-difference leg is not exempt from that.
  assert.deepEqual(rowCounts(t.store, t.workspaceId), after, 'no second entry and no second line');
  assert.equal(
    balanceOf(t.store, t.workspaceId, ROLE_ACCOUNT_NUMBER.salesFxRealised),
    fxAfter,
    'the difference is not counted twice',
  );
});

// --- chart invariants the payment roles depend on -----------------------------------------------

test('the chart carries a receivable-loss account that is NOT the discount account', () => {
  // A residual a customer never paid is a loss on the receivable. Absorbing it into 3800 would
  // report it as a discount the business chose to grant, which is a different economic event and a
  // different line in the Erfolgsrechnung.
  const loss = byNumber['3805'];
  const discount = byNumber['3800'];
  assert.ok(loss, '3805 Verluste Forderungen is in the seed');
  assert.ok(discount, '3800 Skonti is in the seed');
  assert.notEqual(loss.number, discount.number, 'a write-off target and a discount are separate accounts');
  assert.equal(loss.type, 'income', '3805 is an Erlösminderung in the 3xxx block');
  assert.match(loss.labels.de, /Forderung/, 'the de-CH label names what is lost');
});

test('the sales-side and purchase-side reductions sit on opposite sides of the Erfolgsrechnung', () => {
  // A Skonto a customer takes reduces REVENUE; a Skonto the business takes on a supplier bill
  // reduces COST. Booking one through the other inflates both turnover and expenses.
  const sales = byNumber[ROLE_ACCOUNT_NUMBER.salesSkonto];
  const purchase = byNumber[ROLE_ACCOUNT_NUMBER.purchaseSkonto];
  assert.ok(sales, `${ROLE_ACCOUNT_NUMBER.salesSkonto} is in the seed`);
  assert.ok(purchase, `${ROLE_ACCOUNT_NUMBER.purchaseSkonto} is in the seed`);
  assert.equal(sales.type, 'income');
  assert.equal(purchase.type, 'expense');
});

// --- A14's role table, against the chart it resolves out of -------------------------------------

test('every posting role resolves to an account the shipped chart actually carries', () => {
  // A14 looks its posting accounts up by NUMBER and refuses with `needs_account` when the number
  // is absent, so a role pointing at a number the seed does not carry is not a cosmetic gap: the
  // settlement does not post at all on a workspace a real user just created. This is the whole
  // table, so a role added later cannot slip through untested.
  const t = freshWorkspace();
  for (const [role, number] of Object.entries(ROLE_ACCOUNT_NUMBER)) {
    const seeded = byNumber[number];
    assert.ok(seeded, `role ${role} resolves ${number}, which the core seed does not carry`);
    assert.ok(t.acc(number), `role ${role} resolves ${number}, which a fresh workspace does not have`);
  }
});

test('the write-off role resolves to the receivable-loss account, not to a currency account', () => {
  // 3806 is Kursdifferenzen in the Kontenrahmen KMU. Writing an uncollectable receivable into it
  // would misstate two lines at once: a bad debt reported as an exchange movement, and the
  // currency account carrying something no rate ever moved.
  const writeOff = byNumber[ROLE_ACCOUNT_NUMBER.writeOff];
  const fx = byNumber[ROLE_ACCOUNT_NUMBER.salesFxRealised];
  const discount = byNumber[ROLE_ACCOUNT_NUMBER.salesSkonto];
  assert.notEqual(writeOff.number, fx.number, 'a receivable loss is not an exchange difference');
  assert.notEqual(writeOff.number, discount.number, 'and it is not a discount granted');
  assert.match(writeOff.labels.de, /Forderung/, 'the de-CH label names what is lost');
  assert.doesNotMatch(writeOff.labels.de, /Kursdifferenz/, 'and it is not a currency account');
});

test('a fresh workspace can write off a residual a customer never paid', () => {
  const t = freshWorkspace('2026-07-19T00:00:00.000Z');
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'UST81',
    key: 'chf',
  });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 108000, writeOffMinor: 100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-residual',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  const writeOffLeg = legs.find((l) => l.debit === 100 && l.number !== '1020');
  assert.ok(writeOffLeg, 'the residual is written off on its own leg');
  assert.equal(writeOffLeg.number, '3805', 'a receivable loss lands on the receivable-loss account');
  assert.equal(writeOffLeg.name, byNumber['3805'].labels.de, 'and it is the seeded account, not a fixture');
  assert.equal(
    legs.reduce((n, l) => n + l.debit, 0),
    legs.reduce((n, l) => n + l.credit, 0),
  );
});
