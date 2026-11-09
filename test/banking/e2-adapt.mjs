// D178 point 19, the E2 re-cut (A20 §11.4): coverage decides first. A statement that does not extend the
// balance chain is an OVERLAP on the days the books already cover, and its lines there wait for the person's
// answer. Older fixtures imported consecutive statements with an opening balance of 0 each (a broken chain)
// over the same month; these two helpers adapt them honestly:
//  - `chainedOpening`: the opening a consecutive statement really has (the account's last stored closing),
//    so the fixture extends the chain as a bank's statements do;
//  - `answerDistinct`: the person's "Kein Duplikat" on a line a deliberate overlap flagged, before the test
//    goes on with what it is about.
// SYNTHETIC DATA ONLY.

import { listBankInbox } from '../../dist/core/banking/index.js';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';

let n = 0;

/** The last stored closing balance of a Bankkonto (0 when none): the opening of its next statement. */
export function chainedOpening(t, bankAccountId = t.bankAccountId) {
  const row = t.store.db
    .prepare('SELECT closing_balance_minor AS c FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ? AND closing_balance_minor IS NOT NULL ORDER BY rowid DESC LIMIT 1')
    .get(t.workspaceId, bankAccountId);
  return row?.c ?? 0;
}

/** The person answers "Kein Duplikat" for a line that waits for its answer (a no-op for any other line). */
export function answerDistinct(t, bankTxnId, ctx = t.ctx) {
  const listed = listBankInbox(ctx, { bankTxnId, status: 'all' });
  if (!listed.ok || listed.lines[0]?.needsDuplicateDecision !== true) return;
  const res = resolvePossibleDuplicate(ctx, { bankTxnId, decision: 'distinct', idempotencyKey: `adapt-distinct-${(n += 1)}` });
  if (!res.ok) throw new Error(`answerDistinct: ${JSON.stringify(res)}`);
}

/**
 * The next statement of a Bankkonto's chain, as importLines takes it: the next sequence number and the opening
 * where the last statement closed (so a fixture importing several statements over one month extends the chain).
 */
export function chained(t, bankAccountId = t.bankAccountId) {
  const row = t.store.db
    .prepare('SELECT MAX(CAST(electronic_seq_nb AS INTEGER)) AS s FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?')
    .get(t.workspaceId, bankAccountId);
  return { seqNb: String((row?.s ?? 0) + 1), openingMinor: chainedOpening(t, bankAccountId) };
}
