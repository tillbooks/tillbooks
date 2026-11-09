/**
 * A34, the wage journal's undo (D171, 14.10.2026, the D141.3 follow-up; family 4 of 4 of the owner
 * decision "an undo verb for every row-backed source that lacks one").
 *
 * `wage_journal_post` books the month's externally-computed aggregate wage journal as ONE A02 entry
 * (`source='import'`) and records a `wage_journal_posts` row naming it. Before D171 the raw
 * `reverse_entry` could mirror that entry and nothing else knew: the hand-off history still showed the
 * posting as standing. Since D171 the entry is OWNED by `wage_journal_reverse` (resolved BY ROW: only an
 * entry a `wage_journal_posts` row names, never by the shared `import` source, which the A04 opening
 * balances and the migration openings carry too), and this verb is its one correction.
 *
 * WHAT IT TOUCHES: the ledger only. `wage_journal_posts` is append-only by DB trigger (§H-AUDIT, spec
 * §7 tripwire 3), so the row is never edited: whether a posting stands is DERIVED from the ledger chain
 * (`wageJournalReversalOf`), the dunning-fee rule (D169) that the money effect lives in the ledger.
 * `list_payroll_handoffs` names the mirror on the posting row as `reversalEntryId`.
 *
 * TILL COMPUTES NO WAGE and keeps no per-employee pay (A34 §3, revDSG Art. 6). The salary payments,
 * the AHV/BVG/Quellensteuer declarations and the Lohnausweis live in the external payroll system and at
 * the bank; TILL cannot see them by row, so this verb neither refuses on them nor claims to undo them
 * (D171, deferred question). What it CAN see by row is a bank line whose live claim holds the entry:
 * that refuses `owned_by reopen_bank_line` naming the line (the A39 rule, for every caller).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { reverseOwnedEntry, claimHolderOf, WAGE_JOURNAL_REVERSAL_OWNER } from '../ledger/reverseEntry.js';

export interface WageJournalReverseInput {
  wageJournalPostId?: string;
  reason?: string;
  idempotencyKey?: string;
}

interface PostingRow {
  id: string;
  posted_entry_id: string;
  entry_date: string;
}

/** Thrown inside the reverse's transaction to roll it back and answer `result` instead. */
class WageReverseAbort {
  constructor(public readonly result: Result) {}
}

/**
 * The chain of POSTED mirrors from a wage journal entry: W, its reversal R1, R1's reversal R2, and so
 * on. Before D171 the raw `reverse_entry` could reverse W (and a later raw call its mirror). An ODD
 * chain means the journal is gone and `last` is the mirror that took it out; an EVEN chain (0 included)
 * means it stands, and `last` is the newest link standing in W's direction. §H-TENANT on every hop; the
 * bound is a guard, the chain is short by construction (owned since D171, so it stops growing).
 */
export function wageJournalChain(ctx: WorkspaceContext, entryId: string): { links: number; last: string } {
  let last = entryId;
  let links = 0;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = ctx.store.db
      .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' ORDER BY rowid LIMIT 1")
      .get(ctx.workspaceId, last) as { id: string } | undefined;
    if (next === undefined) break;
    last = next.id;
    links += 1;
  }
  return { links, last };
}

/** The mirror that took a wage journal posting out, or null while it stands. D171. */
export function wageJournalReversalOf(ctx: WorkspaceContext, postedEntryId: string): string | null {
  const chain = wageJournalChain(ctx, postedEntryId);
  return chain.links % 2 === 1 ? chain.last : null;
}

/**
 * Reverse a posted wage journal: post the faithful A02 mirror of its ONE entry through
 * `reverseOwnedEntry`, dated today (OR 957a: correct in the open period, `reverse_entry`'s convention).
 *
 * ACCEPTED: a `wage_journal_posts` row of this workspace whose entry stands.
 * REFUSALS, each a pre-check that writes nothing:
 *  - unknown or another workspace's row -> `not_found` (§H-TENANT);
 *  - a blank reason -> `reason_required`;
 *  - an ODD chain of posted mirrors -> `already_reversed` naming the mirror (idempotent on ROWS under a
 *    new key, and the answer for a book whose raw Storno predates D171: there is no row state to move,
 *    so the existing mirror IS the reversal and nothing is posted);
 *  - a live bank-line claim on the link to reverse -> `owned_by reopen_bank_line` naming the line;
 *  - a sealed today -> `period_locked`.
 * An EVEN, non-empty chain (a raw Storno itself reversed raw) means the journal stands again: A02
 * reverses an entry once, so the mirror is posted against the chain's last link (it carries W's
 * direction; its owner walk ends at the wage journal row).
 */
export function wageJournalReverse(ctx: WorkspaceContext, input: WageJournalReverseInput): Result {
  const posting = ctx.capabilities.assert('post');
  if (!posting.ok) return posting;
  const guard = requireString(input.wageJournalPostId, 'wageJournalPostId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) return err('reason_required', { field: 'reason' });
  const reason = input.reason.trim();
  const postId = input.wageJournalPostId as string;

  const scopedKey = JSON.stringify(['wage_journal_reverse', postId, input.idempotencyKey as string]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'wage_journal_reverse');
  if (replayed !== undefined) return replayed;

  // §H-TENANT: the row is read in the caller's workspace only.
  const row = ctx.store.db
    .prepare('SELECT id, posted_entry_id, entry_date FROM wage_journal_posts WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, postId) as PostingRow | undefined;
  if (row === undefined) return err('not_found', { wageJournalPostId: postId });

  const chain = wageJournalChain(ctx, row.posted_entry_id);
  if (chain.links % 2 === 1) {
    return err('already_reversed', { wageJournalPostId: row.id, postedEntryId: row.posted_entry_id, reversalEntryId: chain.last });
  }

  // The one downstream act TILL sees by row: a bank line that booked or matched the entry. Its own undo
  // releases the claim first (A39), so the line never reads booked on money that is gone.
  const holder = claimHolderOf(ctx, chain.last);
  if (holder !== null) {
    return err('owned_by', {
      verb: 'reopen_bank_line',
      bankTxnId: holder,
      entryId: chain.last,
      wageJournalPostId: row.id,
      hint: 'a bank line holds this wage journal entry: reopen that bank line first, then reverse the wage journal',
    });
  }

  const date = ctx.clock.now().slice(0, 10);
  // §H-PERIOD: pre-checked BEFORE the tx, a structured refusal with nothing written.
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'wage_journal_reverse', () => {
      const reversed = reverseOwnedEntry(
        ctx,
        {
          entryId: chain.last,
          date,
          description: `Storno Lohnbuchung ${row.entry_date}: ${reason}`,
          // One mirror per posting and link, whatever key the caller used: the identity is the posting.
          idempotencyKey: JSON.stringify(['wage_journal_reversal', row.id, chain.last]),
        },
        WAGE_JOURNAL_REVERSAL_OWNER,
      );
      if (!reversed.ok) throw new WageReverseAbort(reversed);
      ctx.audit.record({ entityKind: 'payroll_handoff', entityId: row.id, action: 'reverse', actor: ctx.actor, at: ctx.clock.now() });
      return ok({
        wageJournalPostId: row.id,
        postedEntryId: row.posted_entry_id,
        reversalEntryId: reversed.reversalId,
        entryDate: row.entry_date,
        reversalDate: date,
        reason,
      });
    });
  } catch (e) {
    if (e instanceof WageReverseAbort) return e.result;
    throw e;
  }
}
