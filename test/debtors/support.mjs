// Test support for A16 (Debitoren, open items).
//
// A16 is a pure read model (Pattern P5) over documents A11 really issued and payments A14 really
// posted, so this file BORROWS A14's fixture wholesale rather than seeding rows by hand. That is
// the point: an open amount derived from an invented `document` row would reconcile against nothing,
// and the reconciliation to account 1100 Debitoren is the one invariant this capability exists to
// hold. Everything below is either re-exported from `../payments/support.mjs` (read-only, A14 owns
// that file) or a helper A16 needs and A14 has no use for.

export {
  setup,
  secondWorkspace,
  addCustomer,
  issueInvoice,
  seedRate,
  accountBalance,
  legsOf,
  AT,
  NET_MINOR,
  TAX_MINOR,
  GROSS_MINOR,
} from '../payments/support.mjs';

/**
 * The net movement on account 1100 Debitoren as of a cut-off date, from the POSTED journal only.
 *
 * This is the reconciliation target and it is computed the long way round on purpose: straight off
 * `journal_line`, with no shared helper between it and the read model under test. Two derivations
 * that call the same function agree by construction and prove nothing; these two agree only if the
 * open-item model and the ledger actually say the same thing.
 */
export function receivablesBalance(store, workspaceId, asOf) {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = '1100' AND e.status = 'posted'
          AND e.date <= ?`,
    )
    .get(workspaceId, asOf);
  return row.net;
}

/** Row counts on the one table A16 writes, so an idempotency claim is asserted on ROWS. */
export function configRows(store, workspaceId) {
  return store.db
    .prepare('SELECT COUNT(*) AS n FROM aging_bucket_config WHERE workspace_id = ?')
    .get(workspaceId).n;
}

/** The stored config row itself, so a no-op can be proven to have written nothing at all. */
export function configRow(store, workspaceId) {
  return store.db
    .prepare('SELECT * FROM aging_bucket_config WHERE workspace_id = ?')
    .get(workspaceId);
}

/** Find an item by invoice number in a `listOpenItems` result. */
export function itemFor(result, number) {
  return result.items.find((i) => i.number === number);
}
