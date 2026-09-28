/**
 * A39 critic A39R2-5 (owner decision, 25.09.2026): a STORED G01 RULE never posts a leg onto a Bankkonto's
 * ledger account. A bank ledger moves only when money really moved at the bank, and that is decided on the
 * bank line (book_bank_line, the A21 queue, a payment run): never by a stored template firing on an event,
 * whose figures can be bound to event data (probe q5: a rule on invoice.issued settled every invoice
 * into the bank with no money arriving).
 *
 * The denylist refuses the verbs whose whole purpose is that (record, allocate or reverse a payment, the
 * bank opening balance). This module is the FIRE-TIME half, which no denylist can be: a verb like
 * `post_entry` stays automatable, and whether a firing touches a bank ledger depends on the resolved
 * template. The automation invoker (`src/api/registry.ts`) counts the posted bank-ledger legs of the
 * workspace before and after a firing, inside a savepoint, and rolls the firing back when the count grew.
 * Counting posted legs (not new rows) also catches a firing that posts an existing draft or reverses a
 * bank entry.
 */

import type Database from 'better-sqlite3';

/** Posted journal lines of `workspaceId` on the ledger account of any of its Bankkonten. */
export function postedBankLedgerLegs(db: Database.Database, workspaceId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM journal_line jl
         JOIN journal_entry e ON e.id = jl.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND jl.account_id IN (SELECT ba.ledger_account_id FROM bank_account ba WHERE ba.workspace_id = ?)`,
    )
    .get(workspaceId, workspaceId) as { n: number };
  return row.n;
}
