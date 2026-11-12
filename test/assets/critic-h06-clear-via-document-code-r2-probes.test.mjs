// D192 code critic r2 (non-author): the R1 rule against the cross-year paths redone after a reverse in the
// later year, a redo ON the reverse date, and the R2 warning across workspaces and on replay.
//
// Every fixture is SYNTHETIC by construction: an invented company, customer, vehicle and amounts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace } from '../payments/support.mjs';
import { createDocument, transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { createAssetCategory, createAsset, assetOpeningBalance, assetDispose, assetTransactionReverse } from '../../dist/core/assets/index.js';
import { vatAnnualReconciliation } from '../../dist/core/accruals/index.js';

const COST = 4_000_000;
const ACCUM = 2_500_000;
const Y26 = ['2026-01-01', '2026-12-31'];
const Y27 = ['2027-01-01', '2027-12-31'];

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
  t.dispose = (ctx, assetId, date, extra = {}, key = `d-${assetId}-${date}`) =>
    assetDispose(ctx, { assetId, disposalDate: date, gainLossAccountId: t.acc('8510'), ...extra, idempotencyKey: key });
  t.reverse = (ctx, assetId, transactionId, key) =>
    assetTransactionReverse(ctx, { assetId, transactionId, reason: 'Korrektur', overrideProceedsCheck: true, overrideReason: 'Neu datieren', idempotencyKey: key });
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
  t.umsatz = (ctx, year) => vatAnnualReconciliation(ctx, { year }).umsatz;
  return t;
}

test('(g) redone after a reverse in 2027 (invoice standing, override): the redo clears in 2027 with no second Abgrenzung; 2026 +300000, 2027 0, 1530 cleared once per year', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2027-01-03T00:00:00.000Z'), 'g');
  const jan5 = w.at2('2027-01-05T00:00:00.000Z');
  const d1 = w.dispose(jan5, assetId, '2026-12-28', { proceedsInvoiceId: inv.id });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const feb = w.at2('2027-02-20T00:00:00.000Z');
  assert.equal(w.reverse(feb, assetId, d1.transaction.id, 'g-r').ok, true);
  const early = w.dispose(feb, assetId, '2027-02-19', { proceedsInvoiceId: inv.id }, 'g-early');
  assert.equal(early.error, 'disposal_date_before_reversal', JSON.stringify(early));
  const redo = w.dispose(feb, assetId, '2027-02-20', { proceedsInvoiceId: inv.id }, 'g-redo');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.equal(redo.abgrenzung, null, 'invoice and redo in one year');
  const y26 = w.net(...Y26);
  const y27 = w.net(...Y27);
  assert.deepEqual([y26('1530'), y26('3200'), y26('1300'), w.profit(...Y26)], [0, 0, 1_800_000, 300_000]);
  assert.deepEqual([y27('1530'), y27('3200'), y27('1300'), w.profit(...Y27)], [0, 0, -1_800_000, 0]);
  for (const y of ['2026', '2027']) assert.equal(w.umsatz(feb, y).differenceMinor, 0, y);
});

test('FIXED S1: (h) redone after a reverse in 2027 (invoice standing, override): the year 2026 keeps ONE deferral of the invoice, profit 0 in 2026 and +300000 in 2027', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.at2('2026-12-15T00:00:00.000Z'), 'h');
  const jan = w.at2('2027-01-10T00:00:00.000Z');
  const d1 = w.dispose(jan, assetId, '2027-01-10', { proceedsInvoiceId: inv.id });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const mar = w.at2('2027-03-01T00:00:00.000Z');
  const r = w.reverse(mar, assetId, d1.transaction.id, 'h-r');
  assert.equal(r.ok, true, JSON.stringify(r));
  // The first Abgrenzung: its Storno pair is dated today (2027) and nets there; entry A stays in 2026.
  const redo = w.dispose(mar, assetId, '2027-03-01', { proceedsInvoiceId: inv.id }, 'h-redo');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  const y26 = w.net(...Y26);
  const y27 = w.net(...Y27);
  const facts = `2026: 3200 ${y26('3200')}, 2300 ${y26('2300')}, profit ${w.profit(...Y26)}; 2027: 3200 ${y27('3200')}, profit ${w.profit(...Y27)}; redo Abgrenzung ${JSON.stringify(redo.abgrenzung && { kind: redo.abgrenzung.kind, periodEnd: redo.abgrenzung.periodEnd })}`;
  assert.equal(w.profit(...Y26), 0, facts);
  assert.equal(y26('2300'), -1_800_000, facts);
  assert.equal(w.profit(...Y27), 300_000, facts);
  assert.equal(redo.abgrenzung, null, 'the redo posts no second deferral: the first still stands in 2026');
});

test('a redo ON the reverse date is accepted; the mirror and the redo net that day', () => {
  const w = world();
  const assetId = w.vehicle();
  const inv = w.invoice(w.ctx, 'on');
  const d1 = w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv.id }, 'on-1');
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const aug = w.at2('2026-08-03T00:00:00.000Z');
  assert.equal(w.reverse(aug, assetId, d1.transaction.id, 'on-r').ok, true);
  const redo = w.dispose(aug, assetId, '2026-08-03', { proceedsInvoiceId: inv.id }, 'on-2');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  const y = w.net(...Y26);
  assert.deepEqual([y('1530'), y('1539'), y('3200'), y('8510'), w.profit(...Y26)], [0, 0, 0, -300_000, 300_000]);
});

test('R2 §H-TENANT: a foreign disposal row naming this invoice id never warns here; R2 on replay answers the stored warning', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = w.invoice(w.ctx, 't');
  const cat = createAssetCategory(other.ctx, { code: 'FZ-O', name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60, glAssetAccountId: other.acc('1530'), glAccumDeprAccountId: other.acc('1510'), glDeprExpenseAccountId: other.acc('6800'), idempotencyKey: 'o-cat' });
  const fa = createAsset(other.ctx, { categoryId: cat.category.id, name: 'Fremdwagen', acquisitionDate: '2026-01-01', acquisitionCostRappen: 100, idempotencyKey: 'o-as' });
  // A planted foreign disposal row on THIS invoice id whose entry is this invoice's own entry (worst case).
  w.store.db.prepare(
    `INSERT INTO asset_transaction (id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen, proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type, source_document_id, description, created_at, created_by, idempotency_key)
     VALUES ('atxn_foreign', ?, ?, 'disposal', '2026-07-19', 0, 0, 0, 0, ?, 'invoice', ?, 'fremd', '2026-07-19', 'x', 'foreign')`,
  ).run(other.workspaceId, fa.asset.id, inv.postedEntryId, inv.id);
  const cn = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 't-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal((cn.warnings ?? []).length, 0, JSON.stringify(cn.warnings ?? null));

  // Replay: a cleared invoice's credit note, created twice under one key, answers the same warning.
  const assetId = w.vehicle();
  const inv2 = w.invoice(w.ctx, 't2');
  assert.equal(w.dispose(w.ctx, assetId, '2026-07-19', { proceedsInvoiceId: inv2.id }, 't2-d').ok, true);
  const a = createCreditNote(w.ctx, { fromInvoiceId: inv2.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 't2-cn' });
  const b = createCreditNote(w.ctx, { fromInvoiceId: inv2.id, mode: 'partial', amountMinor: 100_000, idempotencyKey: 't2-cn' });
  assert.deepEqual(b, a);
  assert.equal(a.warnings?.[0]?.code, 'invoice_cleared_by_disposal');
  const i1 = issueCreditNote(w.ctx, { creditNoteId: a.document.id, idempotencyKey: 't2-cni' });
  const i2 = issueCreditNote(w.ctx, { creditNoteId: a.document.id, idempotencyKey: 't2-cni' });
  assert.equal(i1.warnings?.[0]?.code, 'invoice_cleared_by_disposal');
  assert.deepEqual(i2.warnings, i1.warnings);
});
