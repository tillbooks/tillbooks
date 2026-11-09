// Test support for A17 (vendor bills and expenses).
//
// A17 is the creditor mirror of the A14/A16 pair, so this file BORROWS A14's fixture wholesale the
// way `test/debtors/support.mjs` does: same workspace, same shipped KMU chart, same canonical
// arithmetic. A vendor bill invented straight into a table would reconcile against nothing, and the
// tie-back to account 2000 Kreditoren is the one invariant this capability exists to hold.
//
// The canonical bill across the whole suite is the design's, seen from the purchase side:
// gross CHF 1'081.00 at the 8.1% Normalsatz, back-derived to net 1'000.00 and Vorsteuer 81.00. It is
// the SAME figure A14's scenarios use from the sales side, on purpose: one arithmetic to check by
// eye across both halves of the ledger.

import { createContact } from '../../dist/core/sales/index.js';
import { setup as paymentsSetup } from '../payments/support.mjs';

export {
  secondWorkspace,
  seedRate,
  accountBalance,
  legsOf,
  counts as paymentCounts,
  AT,
  NET_MINOR,
  TAX_MINOR,
  GROSS_MINOR,
} from '../payments/support.mjs';

/**
 * A14's world, with the REAL ledger ports always wired (A17-C7).
 *
 * The plain A14 `setup()` leaves `ctx.audit` as `noAudit` unless `realPeriods` is asked for, which
 * made `billCounts().audits` a constant 1 (the workspace's own create row) and the audit half of
 * every idempotency assertion in `invariants.test.mjs` unfalsifiable: the file's central claim is
 * that the audit trail, an append-only hash chain with no uniqueness constraint, is exactly where a
 * hidden re-run leaves its trace, and a column that cannot move asserts nothing. So A17's fixture
 * always wires `ledgerPorts` (the real audit stamp AND the real period guard; no world here locks a
 * period it does not mean to). `t.at(...)` keeps A14's own contract: pass `{ realPeriods: true }`
 * when a later-day context needs the real ports too.
 */
export function setup(opts = {}) {
  return paymentsSetup({ ...opts, realPeriods: true });
}

/** The canonical bill, restated from the purchase side. `GROSS_MINOR` is what the paper bill says. */
export const BILL_DATE = '2026-07-01';
export const DUE_DATE = '2026-07-31';

/** A vendor contact (or `both`), because A17 refuses a customer-only counterparty. */
export function addVendor(ctx, name = 'Lieferant GmbH', key = 'v1', partyRole = 'vendor') {
  const c = createContact(ctx, { partyRole, name, idempotencyKey: key });
  if (!c.ok) throw new Error(`vendor failed: ${c.error}`);
  return c.contact.id;
}

/**
 * The canonical `createVendorBill` / `recordExpense` input: gross 1'081.00, VST-M, expense 6500.
 *
 * `t` is the world `setup()` returns; `overrides` widen it per case. The idempotency key defaults to
 * something unique per call so the tests that are ABOUT idempotency pass their own.
 */
export function billInput(t, vendorId, overrides = {}) {
  return {
    vendorId,
    billDate: BILL_DATE,
    dueDate: DUE_DATE,
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: t.acc('6500'),
    idempotencyKey: `bill-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/**
 * The posted balance of 2000 Kreditoren, computed the LONG way round on purpose: straight off
 * `journal_line` by account NUMBER, sharing no helper with the read model under test. Two
 * derivations that call the same function agree by construction and prove nothing; these two agree
 * only if the payables model and the ledger actually say the same thing.
 */
export function payablesBalance(store, workspaceId, asOf = '9999-12-31') {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = '2000' AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(workspaceId, asOf);
  return row.net;
}

/**
 * Row counts across every table an A17 write can touch, so an idempotency claim is asserted on
 * ROWS and never on a returned id (§H-IDEMPOTENT, the outcome-based reading). The audit trail is
 * counted too: it is an append-only hash chain with no uniqueness constraint of any kind, so it is
 * exactly where a hidden re-run would leave its trace.
 */
export function billCounts(store, workspaceId) {
  const one = (sql, ...params) => store.db.prepare(sql).get(...params).n;
  return {
    bills: one('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?', workspaceId),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId),
    lines: one(
      `SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
      workspaceId,
    ),
    audits: one('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?', workspaceId),
  };
}

/** The stored vendor_bill row, raw, for asserting exactly what a write did (or did not) change. */
export function billRow(store, workspaceId, id) {
  return store.db.prepare('SELECT * FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
}
