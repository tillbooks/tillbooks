/**
 * A25's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * THE NAMING RULE THE TWO EXPORT SURFACES SHARE, stated because the near-collision is real: A08
 * already owns `export_statement` (SINGULAR, one statement per call, any of the four kinds).
 * `export_statements` (PLURAL) is deliberately not a near-twin of it: it is the Treuhänder's filing
 * PAIR, Bilanz plus Erfolgsrechnung in one call, and its engine verb DELEGATES to A08's own
 * `exportStatement` per statement, so the two tools can never disagree about a figure. The
 * descriptions below say so, because an agent choosing between the two tools has only these
 * sentences to choose with.
 *
 * FOUR WRITES, FOUR READS. The writes are review METADATA (an `entry_review` event row each,
 * §H-AUDIT: posted entries are never mutated, correction stays A02's reversal); the reads are the
 * coverage model and the three filing exports (P5, artifacts idempotent to the byte). Locking a
 * reviewed period is A03's own `lock_period`: A25 deliberately mints no second lock verb.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  commentEntry,
  flagEntry,
  approveEntry,
  reviewStatus,
  preparePeriod,
  exportJournal,
  exportStatements,
  exportVat,
} from '../core/review/index.js';

export interface ReviewActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

export function reviewActions(h: ReviewActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'comment_entry',
      'write',
      'Ask or note something about a posted journal entry without touching it: appends one comment to the entry review thread (Prüfvermerk) and never changes the entry itself or its review status. The Treuhänder queries, the client answers with a correcting reversal (reverse_entry), never an edit.',
      ctxSchema({ entryId: STR, text: STR, idempotencyKey: STR }, ['entryId', 'text', 'idempotencyKey']),
      (ctx, input) => commentEntry(ctx, input as never),
    ),
    ctxAction(
      'flag_entry',
      'write',
      'Flag a posted journal entry as questioned (beanstandet) with a reason: review metadata only, the posted rows stay untouched. The entry shows as flagged in review_status until someone approves it; the books are corrected by reversal, never by edit.',
      ctxSchema({ entryId: STR, reason: STR, idempotencyKey: STR }, ['entryId', 'reason', 'idempotencyKey']),
      (ctx, input) => flagEntry(ctx, input as never),
    ),
    ctxAction(
      'approve_entry',
      'write',
      'Sign off one checked entry (freigeben): sets its review status to approved, as metadata, neither locking nor altering the entry. Approving an already-reversed entry is allowed and reported with alreadyReversed. A sign-off is a human act: requires the review capability (Treuhänder/owner) and no automation rule may fire it.',
      ctxSchema({ entryId: STR, note: STR, idempotencyKey: STR }, ['entryId', 'idempotencyKey']),
      (ctx, input) => approveEntry(ctx, input as never),
    ),
    ctxAction(
      'review_status',
      'read',
      "Review coverage for a period ('YYYY-MM' or 'YYYY'): approved/flagged/open counts plus every posted entry with its current review state, last reviewer and comment/flag counts. This is the bar behind the review surface, and what says whether a period is ready for lock_period (A03) and export. savedViewId applies a saved review view (G00): its stored period is used when none is named here; an explicit period always wins.",
      ctxSchema({ period: STR, savedViewId: STR }, []),
      (ctx, input) => reviewStatus(ctx, input as never),
    ),
    ctxAction(
      'prepare_period',
      'write',
      "Ready a period for the Treuhänder's review: builds one packet (review coverage, draft count, unmatched bank items from the camt and QR queues, open debtors, MWST preview) and leaves machine flags on anomalies it detects (a duplicate-looking posting, a line missing a tax code where the account declares a default). It never approves, locks, or exports: those stay human acts. Idempotent per period, a re-run refreshes the packet and never duplicates a flag.",
      ctxSchema({ period: STR, idempotencyKey: STR }, ['period', 'idempotencyKey']),
      (ctx, input) => preparePeriod(ctx, input as never),
    ),
    ctxAction(
      'export_journal',
      'read',
      "The Buchungsjournal of a period ('YYYY-MM' or 'YYYY') as a locale-neutral CSV file, base64-encoded: one row per posted line exactly as the ledger holds it (integer Rappen in line and base currency, ISO dates, stored fx_rate and VAT trace values verbatim, OR Art. 958f: a faithful copy, never a recomputation), plus a footing total record. Same period, same bytes. Nothing is transmitted anywhere.",
      ctxSchema({ period: STR, format: STR }, ['period']),
      (ctx, input) => exportJournal(ctx, input as never),
    ),
    ctxAction(
      'export_statements',
      'read',
      "The filing pair for a period: the Bilanz as of the period end AND the Erfolgsrechnung over it, one artifact each, format 'pdf' or 'csv'. Each statement is rendered by A08's own export_statement engine (this tool only packages the pair), so the figures cannot differ from the screen or from export_statement, and A08's statutory caveats apply unchanged: do not present the Bilanz as the OR minimum structure.",
      ctxSchema({ period: STR, format: STR }, ['period']),
      (ctx, input) => exportStatements(ctx, input as never),
    ),
    ctxAction(
      'export_vat',
      'read',
      "The MWST-Abrechnung figures of a period as a per-form-line CSV working paper: every Ziffer line exactly as vat_return computes it (stored trace values, never recomputed), plus the payable (Ziffer 500) and credit (Ziffer 510) totals. The file a Treuhänder lays beside the annual accounts; the ESTV ePortal upload artifact itself is vat_export_ech0217, not this.",
      ctxSchema({ period: STR, format: STR }, ['period']),
      (ctx, input) => exportVat(ctx, input as never),
    ),
  ];
}
