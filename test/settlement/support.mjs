// Test support for D185, the settlement socket. SYNTHETIC BY CONSTRUCTION: the platform ("Kurswerk"),
// the processor ("Zahlfix"), every person, every id, document number and amount below is invented from
// scratch for these tests. Nothing is derived from any real settlement, statement or producer output.

import assert from 'node:assert/strict';

import { world } from '../banking/bank-inbox-support.mjs';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { setSettlementTemplate } from '../../dist/core/settlement/index.js';

export { must, refused } from '../banking/bank-inbox-support.mjs';

export const SYSTEM = 'Kurswerk';
export const PROCESSOR = 'Zahlfix';

/** The bank world (VAT effektiv/soll, a Bankkonto on 1020) plus the clearing account 1095 and a fee account 6940. */
export function settlementWorld(opts = {}) {
  const t = world(opts);
  const made = createAccount(t.ctx, { number: '1095', name: 'Durchlaufkonto Zahlfix', type: 'asset', idempotencyKey: 'acc-1095' });
  assert.equal(made.ok, true, JSON.stringify(made));
  const fee = createAccount(t.ctx, { number: '6940', name: 'Zahlungsgebühren', type: 'expense', idempotencyKey: 'acc-6940' });
  assert.equal(fee.ok, true, JSON.stringify(fee));
  return t;
}

/** The owner's template for the invented platform: every bookable kind mapped, the rest on their defaults. */
export function templateKinds(t) {
  return {
    sale: { action: 'book', accountId: t.acc('3400'), taxCode: 'UST81' },
    refund: { action: 'book', accountId: t.acc('3400'), taxCode: 'UST81' },
    processing_fee: { action: 'book', accountId: t.acc('6940'), taxCode: 'VST-M' },
    service_fee: { action: 'book', accountId: t.acc('6940'), taxCode: 'VST-M' },
    third_party_payout: { action: 'book', accountId: t.acc('4400'), taxCode: 'VST-M' },
    third_party_payout_reversal: { action: 'book', accountId: t.acc('4400'), taxCode: 'VST-M' },
  };
}

export function setTemplate(t, ctx = t.ctx, acc = t.acc, key = 'tpl') {
  const res = setSettlementTemplate(ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: acc('1095'), kinds: templateKinds({ acc }), idempotencyKey: key });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

const ev = (id, kind, day, amount, net, vat, extra = {}) => ({
  id,
  kind,
  day,
  date: `${day}T10:00:00.000Z`,
  currency: 'CHF',
  amount,
  net,
  vat: vat === null ? null : { code: 'PRODUCER-CODE', rate: 8.1, amount: vat },
  ...extra,
});

/**
 * The invented July file: ONE OF EVERY KIND, and a second sale whose fee and coach transfer use up its
 * whole gross, so its bank payout is 0.00 while its output VAT (8.10) is still owed.
 *
 *   booked on 1095: 216.20 - 3.24 - 86.48 - 1.08 - 10.81 + 10.81 + 108.10 - 3.24 - 104.86 = 125.40
 *   reserve hold -20.00 stays on 1095; other is 0.00 and waits for a person
 *   bank payouts: -60.00 (bank_payout) and -45.40 (bank_payout_summary) = -105.40, and the 0.00 payout
 *   processor balance change: 125.40 - 20.00 - 105.40 = 0.00
 *   after the two bank lines are booked: 1095 = 125.40 - 105.40 = 20.00, the reserve held
 *
 *   output VAT: 16.20 + 8.10 - 0.81 = 23.49 on a base of 200.00 + 100.00 - 10.00 = 290.00
 *   input VAT:  0.24 + 6.48 + 0.08 - 0.81 + 0.24 + 7.86 = 14.09
 */
export function julyFile() {
  return {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, entity: 'Muster Grafik GmbH', processor: PROCESSOR },
    generatedAt: '2026-08-01T06:00:00.000Z',
    period: { from: '2026-07-01', to: '2026-07-31' },
    currency: 'CHF',
    clearingAccount: '9999',
    signConvention: 'amount = effect on the Zahlfix balance (positive = into it); gross incl. VAT',
    warnings: ['Zahlfix-Buchung zf_bt_x9 ohne Beleg-Nummer (erfunden).'],
    events: [
      ev('kw:sale:1001', 'sale', '2026-07-03', 216.2, 200, 16.2, { document: { type: 'client_invoice', number: 'KW-R-0001' }, counterparty: 'Lena Beispiel', description: 'Kundenzahlung', refs: { zahlfixChargeId: 'zf_ch_0001' } }),
      ev('zf_bt_0001:fee', 'processing_fee', '2026-07-03', -3.24, -3, -0.24, { description: 'Zahlungsgebühr' }),
      ev('zf_tr_0001', 'third_party_payout', '2026-07-05', -86.48, -80, -6.48, { document: { type: 'coach_self_bill', number: 'KW-G-0001' }, counterparty: 'Coach Erfunden', description: 'Auszahlung an Coach' }),
      ev('zf_bt_0007', 'service_fee', '2026-07-31', -1.08, -1, -0.08, { description: 'Plattformgebühr Juli', month: '2026-07' }),
      ev('kw:refund:1002', 'refund', '2026-07-08', -10.81, -10, -0.81, { document: { type: 'client_credit_note', number: 'KW-GS-0001' }, counterparty: 'Max Erfunden', description: 'Rückerstattung an Kunde' }),
      ev('zf_trr_0001', 'third_party_payout_reversal', '2026-07-09', 10.81, 10, 0.81, { counterparty: 'Coach Erfunden', description: 'Rückbuchung Coach-Auszahlung' }),
      ev('zf_res_0001', 'reserve', '2026-07-10', -20, -20, null, { description: 'Mindestguthaben' }),
      ev('zf_oth_0001', 'other', '2026-07-11', 0, 0, null, { description: 'unbekannte Buchungsart: adjustment' }),
      ev('kw:sale:2001', 'sale', '2026-07-14', '108.10', '100.00', '8.10', { document: { type: 'client_invoice', number: 'KW-R-0002' }, counterparty: 'Ida Muster', description: 'Kundenzahlung' }),
      ev('zf_bt_0002:fee', 'processing_fee', '2026-07-14', '-3.24', '-3.00', '-0.24', { description: 'Zahlungsgebühr' }),
      ev('zf_tr_0002', 'third_party_payout', '2026-07-14', '-104.86', '-97.00', '-7.86', { document: { type: 'coach_self_bill', number: 'KW-G-0002' }, counterparty: 'Coach Zweite', description: 'Auszahlung an Coach' }),
      ev('zf_po_0002', 'bank_payout', '2026-07-15', 0, 0, null, { description: 'Auszahlung auf Bankkonto' }),
      ev('zf_po_0001', 'bank_payout', '2026-07-20', -60, -60, null, { description: 'Auszahlung auf Bankkonto' }),
      ev('zf_po_0003', 'bank_payout_summary', '2026-07-27', -45.4, -45.4, null, { description: 'Auszahlung auf Bankkonto (Summe)' }),
    ],
  };
}

/** A tiny, invented PDF (a valid header, nothing real in it). */
export const TINY_PDF_BASE64 = Buffer.from('%PDF-1.4\n% invented test receipt KW-R-0001\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1').toString('base64');

/** Row counts of every table an import can write (§H-IDEMPOTENT is asserted on ROWS). */
export function rows(store, workspaceId) {
  const one = (sql) => store.db.prepare(sql).get(workspaceId).n;
  return {
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    lines: one('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?'),
    events: one('SELECT COUNT(*) AS n FROM settlement_event WHERE workspace_id = ?'),
    files: one('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?'),
    templates: one('SELECT COUNT(*) AS n FROM settlement_template WHERE workspace_id = ?'),
    templateChanges: one('SELECT COUNT(*) AS n FROM settlement_template_change WHERE workspace_id = ?'),
  };
}

/** Every line of an entry with its account number, in a stable order. */
export function legsOf(store, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit, l.tax_code AS taxCode,
              l.tax_base_minor AS taxBase, l.tax_amount_minor AS taxAmount
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? ORDER BY a.number, l.debit_minor DESC`,
    )
    .all(entryId);
}

/** Net movement (debit - credit, base) on one account number, posted entries only. */
export function balanceOf(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}
