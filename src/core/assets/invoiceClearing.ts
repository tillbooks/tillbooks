/**
 * D192 point 2 (code critic r1 R2): `invoice_cleared_by_disposal`, the warning A13 (a credit note) and A14
 * (a Skonto or a write-off) give BEFORE and AFTER they reduce an invoice whose sale line a standing
 * fixed-asset disposal cleared. The books stay right either way (the reduction lands where its own verb
 * books it, the profit and loss total is exact); what the person learns is that the gain on the
 * disposal is stated before this reduction, so the split between Erlösminderung and
 * Veräusserungserfolg differs by it. Warned, never refused (D192 point 2).
 *
 * A LEAF module on purpose: it imports nothing from sales, payments or the assets barrel, so A13 and A14
 * can call it without a cycle (`proceedsLink.ts` imports A14, and A14 importing it back would close one).
 * "Cleared" is read off the books, not off a mode: a standing disposal row (no compensating row names
 * it, D170) that stores this invoice AND whose own entry debits an account the invoice's posted entry
 * credited outside 2200 (the clearing under `clear_via_document`, or the manual clearing under
 * `book_proceeds`). §H-TENANT on every table of the one query.
 */

import type { WorkspaceContext } from '../context.js';

export interface InvoiceClearedWarning {
  code: 'invoice_cleared_by_disposal';
  invoiceId: string;
  transactionId: string;
  assetId: string;
  assetNumber: string;
  disposalDate: string;
  hint: string;
}

/** The standing disposal that cleared this invoice's sale line, as a warning, or null. */
export function invoiceClearedByDisposal(ctx: WorkspaceContext, invoiceId: string): InvoiceClearedWarning | null {
  const row = ctx.store.db
    .prepare(
      `SELECT d.id AS id, d.asset_id AS asset_id, d.date AS date, s.number AS asset_number
         FROM asset_transaction d
         JOIN asset s ON s.id = d.asset_id AND s.workspace_id = d.workspace_id
         JOIN document inv ON inv.id = d.source_document_id AND inv.workspace_id = d.workspace_id
        WHERE d.workspace_id = ? AND d.type = 'disposal'
          AND d.source_document_type = 'invoice' AND d.source_document_id = ?
          AND NOT EXISTS (SELECT 1 FROM asset_transaction r WHERE r.workspace_id = d.workspace_id
                           AND r.source_document_type = 'asset_transaction' AND r.source_document_id = d.id)
          AND EXISTS (
            SELECT 1 FROM journal_line dl
              JOIN journal_entry de ON de.id = dl.entry_id AND de.workspace_id = d.workspace_id
              JOIN journal_line il ON il.account_id = dl.account_id AND il.entry_id = inv.posted_entry_id
              JOIN journal_entry ie ON ie.id = il.entry_id AND ie.workspace_id = d.workspace_id
              JOIN account a ON a.id = il.account_id AND a.workspace_id = d.workspace_id
             WHERE dl.entry_id = d.journal_entry_id AND dl.debit_minor > 0 AND il.credit_minor > 0 AND a.number <> '2200')
        ORDER BY d.rowid LIMIT 1`,
    )
    .get(ctx.workspaceId, invoiceId) as { id: string; asset_id: string; date: string; asset_number: string } | undefined;
  if (row === undefined) return null;
  return {
    code: 'invoice_cleared_by_disposal',
    invoiceId,
    transactionId: row.id,
    assetId: row.asset_id,
    assetNumber: row.asset_number,
    disposalDate: row.date,
    hint: `the disposal of fixed asset ${row.asset_number} (${row.date}) cleared this invoice's sale line: this reduction stays on its own account, so the disposal's gain is stated before it; the books stay right`,
  };
}
