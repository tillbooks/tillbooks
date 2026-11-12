// D192 code critic r1 (non-author): probes against the clear-via-document build. They recompute (a), (g)
// and (h) from the journal rows per account and per year with the Umsatzabstimmung on the same books,
// drive the races through the write lock, and give the invariants the paper named a test that bites.
//
// Every fixture is SYNTHETIC by construction: an invented company, customer, vehicle and amounts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace } from '../payments/support.mjs';
import { createDocument, transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, previewPayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { createAccount, createCostCenter } from '../../dist/core/accounts/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { createAssetCategory, createAsset, assetOpeningBalance, assetDispose, assetTransactionReverse } from '../../dist/core/assets/index.js';
import { vatAnnualReconciliation } from '../../dist/core/accruals/index.js';

const COST = 4_000_000;
const ACCUM = 2_500_000;

function world() {
  const t = setup({ realPeriods: true });
  t.at2 = (iso) => t.at(iso, { realPeriods: true });
  for (const [number, name, type] of [['1539', 'WB Fahrzeuge', 'asset'], ['8510', 'Ausserordentlicher Ertrag', 'income']]) {
    assert.equal(createAccount(t.ctx, { number, name, type, idempotencyKey: `acc-${number}` }).ok, true);
  }
  let n = 0;
  t.vehicle = () => {
    n += 1;
    const cat = createAssetCategory(t.ctx, {
      code: `FZ-${n}`, name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: t.acc('1530'), glAccumDeprAccountId: t.acc('1539'), glDeprExpenseAccountId: t.acc('6800'), idempotencyKey: `cat-${n}`,
    });
    const a = createAsset(t.ctx, { categoryId: cat.category.id, name: `Lieferwagen ${n}`, acquisitionDate: '2022-01-01', acquisitionCostRappen: COST, idempotencyKey: `as-${n}` });
    const ob = assetOpeningBalance(t.ctx, { assetId: a.asset.id, date: '2026-01-01', costRappen: COST, accumulatedDeprRappen: ACCUM, offsetAccountId: t.acc('2979'), idempotencyKey: `ob-${n}` });
    assert.equal(ob.ok, true, JSON.stringify(ob));
    return a.asset.id;
  };
  t.invoice = (ctx, key, net = 1_800_000) => {
    const c = createDocument(ctx, { type: 'invoice', contactId: t.customerId, lines: [{ description: 'Lieferwagen', unitPriceMinor: net, taxCode: 'UST81' }], idempotencyKey: `${key}-c` });
    assert.equal(c.ok, true, JSON.stringify(c));
    const i = transitionDocument(ctx, { documentId: c.document.id, to: 'issued', idempotencyKey: `${key}-i` });
    assert.equal(i.ok, true, JSON.stringify(i));
    return i.document;
  };
  t.fullCredit = (ctx, invoiceId, key) => {
    const cn = createCreditNote(ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${key}-cn` });
    assert.equal(cn.ok, true, JSON.stringify(cn));
    assert.equal(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: `${key}-cni` }).ok, true);
    return cn.document.id;
  };
  t.dispose = (ctx, assetId, date, extra = {}, key = `d-${assetId}-${date}`) =>
    assetDispose(ctx, { assetId, disposalDate: date, gainLossAccountId: t.acc('8510'), ...extra, idempotencyKey: key });
  t.net = (from, to) => {
    const rows = t.store.db.prepare(
      `SELECT a.number AS number, SUM(l.base_debit_minor - l.base_credit_minor) AS net FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? GROUP BY a.number`,
    ).all(t.workspaceId, from, to);
    const o = Object.fromEntries(rows.map((r) => [r.number, r.net]));
    return (k) => o[k] ?? 0;
  };
  t.profit = (from, to) => t.store.db.prepare(
    `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS p FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.type IN ('income','expense')`,
  ).get(t.workspaceId, from, to).p;
  t.count = (table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  t.umsatz = (ctx, year) => {
    const r = vatAnnualReconciliation(ctx, { year });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.umsatz;
  };
  return t;
}

const Y26 = ['2026-01-01', '2026-12-31'];
const Y27 = ['2027-01-01', '2027-12-31'];

test('(a) recomputed from the rows: every account once, profit = the gain, Umsatzabstimmung 1800000 against 1800000', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'a');
  const p = recordPayment(w.ctx, { direction: 'incoming', date: '2026-07-19', amountMinor: 1_945_800, currency: 'CHF', bankAccountId: w.acc('1020'), counterpartyKind: 'customer', counterpartyId: w.customerId, allocations: [{ documentId: inv.id, amountMinor: 1_945_800 }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'a-p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const y = w.net(...Y26);
  assert.deepEqual(['1100', '1020', '2200', '3200', '1530', '1539', '8510'].map(y), [0, 1_945_800, -145_800, 0, COST - COST, -ACCUM + ACCUM, -300_000]);
  assert.equal(w.profit(...Y26), 300_000);
  const u = w.umsatz(w.ctx, '2026');
  assert.equal(u.revenuePerStatementsMinor, 1_800_000);
  assert.equal(u.declaredZiffer200Minor, 1_800_000);
  assert.equal(u.differenceMinor, 0);
});

test('(g) recomputed per year, then reversed on 20.02.2027 after a full credit note: both years and both Umsatzabstimmungen hold', () => {
  const w = world();
  const assetId = w.vehicle();
  const jan3 = w.at2('2027-01-03T00:00:00.000Z');
  const inv = w.invoice(jan3, 'g');
  const jan5 = w.at2('2027-01-05T00:00:00.000Z');
  const d = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  let y26 = w.net(...Y26);
  // The opening balance seated 1530 +COST and 1539 -ACCUM on 01.01.2026; the disposal takes both out.
  assert.equal(y26('1530'), 0);
  assert.equal(y26('1539'), 0);
  assert.equal(y26('8510'), -300_000);
  assert.equal(y26('3200'), 0);
  assert.equal(y26('1300'), 1_800_000);
  assert.equal(w.profit(...Y26), 300_000);
  const y27 = w.net(...Y27);
  assert.equal(y27('3200'), 0);
  assert.equal(y27('1300'), -1_800_000);
  assert.equal(w.profit(...Y27), 0);
  for (const year of ['2026', '2027']) assert.equal(w.umsatz(jan5, year).differenceMinor, 0, year);

  const feb = w.at2('2027-02-20T00:00:00.000Z');
  w.fullCredit(feb, inv.id, 'g');
  const r = assetTransactionReverse(feb, { assetId, transactionId: d.transaction.id, reason: 'Verkauf geplatzt', idempotencyKey: 'g-r' });
  assert.equal(r.ok, true, JSON.stringify(r));
  y26 = w.net(...Y26);
  assert.equal(w.profit(...Y26), 300_000, '2026 as booked');
  assert.equal(y26('1300'), 1_800_000);
  const y27r = w.net(...Y27);
  assert.equal(y27r('3200'), 0);
  assert.equal(y27r('1300'), -1_800_000);
  assert.equal(y27r('1530'), COST, 'the vehicle back on 1530 in 2027');
  assert.equal(w.profit(...Y27), -300_000);
  const u27 = w.umsatz(feb, '2027');
  assert.equal(u27.declaredZiffer200Minor, 0);
  assert.equal(u27.differenceMinor, 0, JSON.stringify(u27));
  assert.equal(w.umsatz(feb, '2026').differenceMinor, 0);
});

test('(h) reversed in 2027 after a full credit note: 2026 profit 0 with 2300 standing at 31.12., 2027 profit 0, both Umsatzabstimmungen match', () => {
  const w = world();
  const assetId = w.vehicle();
  const dec = w.at2('2026-12-15T00:00:00.000Z');
  const inv = w.invoice(dec, 'h');
  const jan = w.at2('2027-01-10T00:00:00.000Z');
  const d = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const mar = w.at2('2027-03-02T00:00:00.000Z');
  w.fullCredit(mar, inv.id, 'h');
  const r = assetTransactionReverse(mar, { assetId, transactionId: d.transaction.id, reason: 'Rücknahme', idempotencyKey: 'h-r' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const y26 = w.net(...Y26);
  assert.equal(y26('3200'), 0);
  assert.equal(y26('2300'), -1_800_000);
  assert.equal(w.profit(...Y26), 0);
  const y27 = w.net(...Y27);
  assert.equal(y27('3200'), 0);
  assert.equal(y27('2300'), 1_800_000);
  assert.equal(y27('8510'), 0);
  assert.equal(w.profit(...Y27), 0);
  for (const year of ['2026', '2027']) assert.equal(w.umsatz(mar, year).differenceMinor, 0, year);
});

/** Run `body` as the write lock is taken by `fn`'s own transaction: the D12 interleaving, deterministically. */
function interleave(store, body, fn) {
  const realTx = store.tx;
  store.tx = function (inner) {
    store.tx = realTx;
    body();
    return realTx.call(store, inner);
  };
  try {
    return fn();
  } finally {
    store.tx = realTx;
  }
}

test('race G1: a second asset disposed on the same invoice between the friendly check and the write: one clearing only, the loser refused by name', () => {
  const w = world();
  const x = w.vehicle();
  const y = w.vehicle();
  const inv = w.invoice(w.ctx, 'race');
  const e0 = w.count('journal_entry');
  let lost;
  try {
    lost = interleave(w.store, () => {
      const won = w.dispose(w.ctx, y, '2026-07-19', { proceedsInvoiceId: inv.id }, 'race-y');
      assert.equal(won.ok, true, JSON.stringify(won));
    }, () => w.dispose(w.ctx, x, '2026-07-19', { proceedsInvoiceId: inv.id }, 'race-x'));
  } catch (e) {
    lost = { thrown: String(e) };
  }
  assert.equal(lost.reason, 'invoice_already_cleared', JSON.stringify(lost));
  assert.equal(w.count('journal_entry') - e0, 1, 'one disposal entry');
  assert.equal(w.net(...Y26)('3200'), 0, '3200 cleared once');
});

test('race: a full credit note issued between the friendly check and the write: the dispose is refused not_standing, nothing written', () => {
  const w = world();
  const x = w.vehicle();
  const inv = w.invoice(w.ctx, 'cn');
  const before = w.count('journal_entry');
  const r = interleave(w.store, () => w.fullCredit(w.ctx, inv.id, 'cn'), () => w.dispose(w.ctx, x, '2026-07-19', { proceedsInvoiceId: inv.id }, 'cn-d'));
  assert.equal(r.reason, 'not_standing', JSON.stringify(r));
  assert.equal(w.count('journal_entry') - before, 1, 'only the credit note');
  assert.equal(w.count('asset_transaction WHERE type = \'disposal\''), 0);
});

test('accrual_one_per_disposal bites: a second accrual on a disposal\'s source_ref is refused at the table', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15T00:00:00.000Z'), 'one');
  const jan = w.at2('2027-01-10T00:00:00.000Z');
  const d = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const row = w.store.db.prepare('SELECT * FROM accrual WHERE id = ?').get(d.abgrenzung.accrualId);
  const clone = { ...row, id: 'accrual_clone', idempotency_key: 'clone', status: 'draft', entry_id: null, reversal_entry_id: null, post_idempotency_key: null };
  const cols = Object.keys(clone);
  assert.throws(
    () => w.store.db.prepare(`INSERT INTO accrual (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => clone[c])),
    /accrual_one_per_disposal/,
  );
  assert.throws(
    () => w.store.db.prepare("UPDATE accrual SET source_ref = 'manual' WHERE id = ?").run(row.id),
    /accrual_disposal_ref_frozen/,
  );
});

test('the cost-centre copy and the sale-line tenant read, made reachable: an invoice whose posted entry carries a cost centre clears on it; a foreign entry is never read', () => {
  const w = world();
  assert.equal(createAccount(w.ctx, { number: '3210', name: 'Erlös Anlagenverkauf', type: 'income', costCenterAllowed: true, idempotencyKey: 'acc-3210' }).ok, true);
  const cc = createCostCenter(w.ctx, { code: 'WERK', name: 'Werkstatt', idempotencyKey: 'cc' });
  assert.equal(cc.ok, true, JSON.stringify(cc));
  const ccId = cc.costCenterId;
  const manual = postEntry(w.ctx, {
    date: '2026-07-19', source: 'manual', idempotencyKey: 'cc-e',
    lines: [
      { account: w.acc('1100'), debit: 1_945_800 },
      { account: w.acc('3210'), credit: 1_800_000, taxCode: 'UST81', costCenter: ccId },
      { account: w.acc('2200'), credit: 145_800 },
    ],
  });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'cc');
  // Plant: the invoice's posted entry is the cost-centred one (A11 stamps no cost centre today).
  w.store.db.prepare('UPDATE document SET posted_entry_id = ? WHERE id = ?').run(manual.entryId, inv.id);
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const clearing = w.store.db.prepare(`SELECT l.cost_center_id AS cc FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '3210'`).get(d.journalEntry.id);
  assert.equal(clearing.cc, ccId, 'the clearing carries the sale line\'s cost centre');

  // Tenant: point another invoice at a FOREIGN workspace's sale entry.
  const other = secondWorkspace(w);
  const foreign = postEntry(other.ctx, {
    date: '2026-07-19', source: 'manual', idempotencyKey: 'f-e',
    lines: [{ account: other.acc('1100'), debit: 99_900 }, { account: other.acc('3200'), credit: 99_900 }],
  });
  assert.equal(foreign.ok, true, JSON.stringify(foreign));
  const asset2 = w.vehicle();
  const inv2 = w.invoice(w.ctx, 'foreign');
  w.store.db.prepare('UPDATE document SET posted_entry_id = ? WHERE id = ?').run(foreign.entryId, inv2.id);
  const r = w.dispose(w.ctx, asset2, '2026-07-19', { proceedsInvoiceId: inv2.id });
  assert.equal(r.reason, 'no_sale_line', JSON.stringify(r));
});

test('§H-TENANT, the accrual lookup on reverse: a foreign accrual planted on the same source_ref is never taken back here', () => {
  const w = world();
  const other = secondWorkspace(w);
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15T00:00:00.000Z'), 'ten');
  const jan = w.at2('2027-01-10T00:00:00.000Z');
  // The disposal's row id is the next `atxn` id: plant the foreign accrual FIRST (a lower rowid), on it.
  const peek = Number(w.ids.next('atxn').split('_')[1]);
  const predicted = `atxn_${peek + 1}`;
  const foreignEntry = postEntry(other.ctx, {
    date: '2026-12-31', source: 'manual', idempotencyKey: 'f-acc',
    lines: [{ account: other.acc('1300'), debit: 777 }, { account: other.acc('3200'), credit: 777 }],
  });
  assert.equal(foreignEntry.ok, true, JSON.stringify(foreignEntry));
  w.store.db.prepare(
    `INSERT INTO accrual (id, workspace_id, kind, period_end, reversal_date, amount_minor, balance_account_id, contra_account_id,
       description, source_ref, status, entry_id, idempotency_key, created_by, created_at, updated_at)
     VALUES ('accrual_foreign', ?, 'accrued_income', '2026-12-31', '2027-01-01', 777, ?, ?, 'fremd', ?, 'posted', ?, 'foreign-acc', 'x', '2026-12-31', '2026-12-31')`,
  ).run(other.workspaceId, other.acc('1300'), other.acc('3200'), `asset_transaction:${predicted}`, foreignEntry.entryId);
  const d = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.transaction.id, predicted, 'the probe planted on the right id');
  const r = assetTransactionReverse(jan, { assetId, transactionId: d.transaction.id, reason: 'Test', overrideProceedsCheck: true, overrideReason: 'Test', idempotencyKey: 'ten-r' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.abgrenzungReversed.accrualId, d.abgrenzung.accrualId, 'its own accrual taken back');
  assert.equal(w.store.db.prepare("SELECT status FROM accrual WHERE id = 'accrual_foreign'").get().status, 'posted', 'the foreign row untouched');
});

// --- Defects found by the code critic r1, FIXED: these were `todo` probes asserting the right behaviour ---

test('FIXED R1: the redo dated before its predecessor\'s reverse is refused disposal_date_before_reversal; dated on or after the reverse (2027) it posts the Abgrenzung into 2026 and both years hold', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'r1');
  // A beta.5-style linked disposal: proceeds booked on 1100 (the double count the hint corrects).
  const d1 = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id, proceedsBooking: 'book_proceeds', proceedsBookingReason: 'beta.5', proceedsRappen: 1_800_000, proceedsAccountId: w.acc('1100') }, 'r1-d1');
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const jan = w.at2('2027-01-20T00:00:00.000Z');
  const r = assetTransactionReverse(jan, { assetId, transactionId: d1.transaction.id, reason: 'Doppelzählung', overrideProceedsCheck: true, overrideReason: 'Migration', idempotencyKey: 'r1-r' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const before = w.count('journal_entry');
  const early = w.dispose(jan, assetId, '2026-07-19', { proceedsInvoiceId: inv.id }, 'r1-d2');
  assert.equal(early.error, 'disposal_date_before_reversal', JSON.stringify(early));
  assert.equal(early.reversedOn, '2027-01-20');
  assert.match(early.hint, /on or after 2027-01-20/);
  assert.equal(w.count('journal_entry'), before, 'nothing written');
  // The route the hint names: dated on or after the reverse, in 2027, with the Abgrenzung into 2026.
  const redo = w.dispose(jan, assetId, '2027-01-20', { proceedsInvoiceId: inv.id }, 'r1-d3');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung.kind, 'deferred_income');
  assert.equal(redo.abgrenzung.periodEnd, '2026-12-31');
  const y26 = w.net(...Y26);
  const y27 = w.net(...Y27);
  assert.equal(y26('1530'), 0, 'opened and cleared once in 2026');
  assert.equal(y27('1530'), 0, 'back with the mirror and cleared once in 2027');
  assert.equal(y26('3200'), 0);
  assert.equal(y27('3200'), 0);
  assert.equal(w.profit(...Y26), 300_000, 'the gain once in 2026');
  assert.equal(w.profit(...Y27), 0, 'the mirror and the redo net in 2027');
});

test('FIXED R2: a credit note and a Skonto after a cleared disposal carry invoice_cleared_by_disposal naming the disposal (D192 point 2); an invoice no disposal cleared carries none', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'r2');
  const d = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const named = (warnings) => (warnings ?? []).find((x) => x.code === 'invoice_cleared_by_disposal');
  const cn = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 'r2-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(named(cn.warnings)?.transactionId, d.transaction.id, JSON.stringify(cn.warnings ?? null));
  const issued = issueCreditNote(w.ctx, { creditNoteId: cn.document.id, idempotencyKey: 'r2-cni' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(named(issued.warnings)?.transactionId, d.transaction.id);
  const skonto = {
    direction: 'incoming', date: '2026-07-19', amountMinor: 1_798_884, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: inv.id, amountMinor: 1_798_884, skontoMinor: 36_000 }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'r2-pay',
  };
  const preview = previewPayment(w.ctx, skonto);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(named(preview.warnings)?.transactionId, d.transaction.id, 'before the click');
  const paid = recordPayment(w.ctx, skonto);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(named(paid.warnings)?.assetId, assetId, 'and after it');
  // An invoice no disposal cleared: no such warning.
  const plain = w.invoice(w.ctx, 'r2-plain');
  const cn2 = createCreditNote(w.ctx, { fromInvoiceId: plain.id, mode: 'full', idempotencyKey: 'r2-cn2' });
  assert.equal(named(cn2.warnings), undefined);
});
