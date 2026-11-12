// D191 test support: one synthetic book with an asset register, an invoice and a payment path, shared by
// the proceeds-link setting and invariant suites. Every fixture is SYNTHETIC by construction (an
// invented company, customer and amounts).
import assert from 'node:assert/strict';

import { setup, GROSS_MINOR } from '../payments/support.mjs';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetDispose,
  assetTransactionReverse,
} from '../../dist/core/assets/index.js';

export const PROCEEDS_CHECK = 'assets.proceeds_check';

export const PROCEEDS_BOOKING = 'assets.proceeds_booking';

/**
 * D192: the D191 suites drive the disposal the D191 way (the caller's proceeds on 1100 or the bank),
 * which is the `book_proceeds` mode of `assets.proceeds_booking`. Pinned here, before the audit wrapper,
 * so every D191 assertion keeps testing the behaviour it was written for. The default
 * (`clear_via_document`) is tested by `disposal-clear-via-document.test.mjs`.
 */
export function pinBookProceeds(ctx, key = 'pin-book-proceeds') {
  const r = settingsSet(ctx, { key: PROCEEDS_BOOKING, value: 'book_proceeds', reason: 'D191-Suite', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
}

export function world() {
  const t = setup();
  pinBookProceeds(t.ctx);
  const audits = [];
  const inner = t.ctx.audit;
  t.ctx.audit = { record: (e) => { audits.push(e); inner.record(e); } };
  let n = 0;
  const activeAsset = () => {
    n += 1;
    const cat = createAssetCategory(t.ctx, {
      code: `FZ-${n}`, name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: t.acc('1500'), glAccumDeprAccountId: t.acc('1510'), glDeprExpenseAccountId: t.acc('6800'),
      idempotencyKey: `cat-${n}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const a = createAsset(t.ctx, { categoryId: cat.category.id, name: `Lieferwagen ${n}`, acquisitionDate: '2026-01-10', acquisitionCostRappen: 2_000_000, idempotencyKey: `as-${n}` });
    assert.equal(a.ok, true, JSON.stringify(a));
    const acq = assetAcquire(t.ctx, { assetId: a.asset.id, date: '2026-01-10', acquisitionCostRappen: 2_000_000, creditAccountId: t.acc('1020'), idempotencyKey: `acq-${n}` });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return a.asset.id;
  };
  const dispose = (assetId, link = {}, proceedsRappen = GROSS_MINOR, key = `disp-${assetId}-${JSON.stringify(link)}`) =>
    assetDispose(t.ctx, {
      assetId, disposalDate: '2026-07-15', proceedsRappen, proceedsAccountId: t.acc('1100'), gainLossAccountId: t.acc('6900'),
      ...link, idempotencyKey: key,
    });
  const pay = (ctx, { invoiceId = null, customerId, bankId, key }) => {
    const p = recordPayment(ctx, {
      direction: 'incoming', date: '2026-07-16', amountMinor: GROSS_MINOR, currency: 'CHF', bankAccountId: bankId,
      counterpartyKind: 'customer', counterpartyId: customerId,
      allocations: invoiceId ? [{ documentId: invoiceId, amountMinor: GROSS_MINOR }] : [],
      intent: PAYMENT_INTENTS.record, idempotencyKey: key,
    });
    assert.equal(p.ok, true, JSON.stringify(p));
    return p.paymentId;
  };
  const reverse = (assetId, transactionId, extra = {}, key = `rev-${transactionId}-${JSON.stringify(extra)}`) =>
    assetTransactionReverse(t.ctx, { assetId, transactionId, reason: 'Verkauf geplatzt', idempotencyKey: key, ...extra });
  const setCheck = (ctx, value, key = `pc-${value}`) => {
    const r = settingsSet(ctx, { key: PROCEEDS_CHECK, value, reason: 'Testfall', idempotencyKey: key });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const row = (id) => t.store.db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(t.workspaceId, id);
  // The ROWS a double call must not double: every table the dispose and the reverse write.
  const rows = () => {
    const one = (sql) => t.store.db.prepare(sql).get(t.workspaceId).n;
    return {
      assetTransactions: one('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?'),
      entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
      lines: one('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?'),
      // The fixture's audit port is in memory (`setup` in ../payments/support.mjs): count what it received.
      audit: audits.length,
      overrideAudits: audits.filter((e) => e.action === 'override_proceeds_check').length,
      settingChanges: one('SELECT COUNT(*) AS n FROM workspace_setting_change WHERE workspace_id = ?'),
    };
  };
  return { ...t, audits, activeAsset, dispose, pay, reverse, setCheck, row, rows };
}
