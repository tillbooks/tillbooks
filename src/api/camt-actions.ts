/**
 * A20, the camt reconciliation verb surface: import, suggest, confirm, book, and the reconciled read.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A14, A19 and A21 all
 * established: the registry is the one append-only tool list and several agents append to it at once,
 * so the smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  importCamt,
  suggestCamtMatches,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  listBankStatements,
  reviewBankTxn,
  setCamtMatching,
} from '../core/banking/index.js';

export interface CamtActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

export function camtActions(h: CamtActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** One allocation of a debit's cash onto a vendor bill (the A14 `ALLOCATIONS` shape, US-A20.5). */
  const ALLOCATIONS = {
    type: 'array',
    items: {
      type: 'object',
      properties: { vendorBillId: STR, targetId: STR, amountMinor: INT },
      required: [],
    },
  } as const;

  return [
    ctxAction(
      'import_camt',
      'write',
      "Import a camt.053 (statement) or camt.054 (debit/credit notification) file onto a registered Bankkonto (A19): parses the XML, checks the file's IBAN against the account, and persists every booked entry, each keyed on its own bank-assigned identity (AcctSvcrRef, falling back to NtryRef, falling back to a content hash) so an overlapping statement or the camt.054-then-camt.053 pair cannot re-import the same booking twice. A byte-identical re-import of the same statement (Stmt/Id + ElctrncSeqNb + page number) is a safe no-op (duplicate:true); a same-identity statement whose content has genuinely changed refuses with statement_amended, naming what changed. A genuine same-day twin the identity key would otherwise treat as a repeat is admitted only via allowDuplicateEntries:true. A batch entry (several TxDtls in one booking) fans out into one txn per TxDtls. A booked, non-reversal CREDIT is routed into A21's QR-Abgleich queue automatically; everything else waits for suggest_matches / confirm_match / create_entry_for_txn. Any entry this parser could not read, or an entry it skipped as a duplicate, is named in the skipped[] list, never silently dropped.",
      ctxSchema(
        { bankAccountId: STR, xml: STR, allowDuplicateEntries: BOOL, idempotencyKey: STR },
        ['bankAccountId', 'xml', 'idempotencyKey'],
      ),
      (ctx, input) => importCamt(ctx, as(input)),
    ),
    ctxAction(
      'suggest_matches',
      'read',
      "Propose a match for every txn of an imported statement, writing nothing. A routed credit shows A21's live score (an invoice, or none). A debit or a reversed entry is RANKED (A36): the exact amount + currency gate is mandatory, then value-date proximity (workspace window, default +/- 5 days), counterparty-name overlap and reference hits order the gated bills, each proposal carrying a signals[] list (amount/value_date/counterparty/reference) and its confidence. A debit whose batch PmtInfId matches a generated A18 payment batch proposes the batch itself (kind:payment_batch); a batch-total mismatch is shown blocked (one-click disabled, use the manual split). Each txn also carries needsReview: true when no proposal reaches the workspace review threshold.",
      ctxSchema({ statementId: STR }, ['statementId']),
      (ctx, input) => suggestCamtMatches(ctx, as(input)),
    ),
    ctxAction(
      'review_bank_txn',
      'write',
      "Signal that ONE booked bank debit needs a human's review because the ranked suggestion found no candidate at or above the workspace threshold (A36). Writes no ledger row and books nothing: it is a pure signal whose success emits bank_txn.needs_review for a G01 rule to react to (e.g. create an E03 task). Idempotent per (bankTxnId, idempotencyKey). A credit-classified txn refuses with use_qr_queue (the credit review moment is A21's qr_match.needs_review). A caller runs the suggestion pass and calls this once per booked debit, so N unmatched txns fire N occurrences.",
      ctxSchema({ bankTxnId: STR, idempotencyKey: STR }, ['bankTxnId', 'idempotencyKey']),
      (ctx, input) => reviewBankTxn(ctx, as(input)),
    ),
    ctxAction(
      'set_camt_matching',
      'write',
      'Tune the workspace debit-matching (A36 §6b): valueDateWindowDays (0-60, default 5) widens or narrows the value-date proximity signal, and reviewThreshold (any|medium|high, default any) sets the confidence floor below which a booked debit reports needsReview. These tune ranking and the review event only; they never touch the mandatory exact amount + currency gate. Idempotent; one row per workspace.',
      ctxSchema({ valueDateWindowDays: INT, reviewThreshold: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => setCamtMatching(ctx, as(input)),
    ),
    ctxAction(
      'confirm_match',
      'write',
      "Settle an outgoing DEBIT against one or more vendor bills (vendorBillId, or allocations[] for a multi-bill split) through A14's record_payment, or annotate a LINK to an existing journal entry that already books the movement (entryId). A CREDIT-classified txn refuses with use_qr_queue: decide it in the A21 Abgleich queue (apply_qr_match / override_qr_match) instead. A settlement (vendorBillId/allocations) against a bank fact that is not a DBIT (e.g. a reversal-flagged returned payment, money arriving) refuses with wrong_direction; correct a returned payment via reverse_payment, or use entryId, which stays open to either direction. Idempotent per txn.",
      ctxSchema(
        {
          bankTxnId: STR,
          vendorBillId: STR,
          allocations: ALLOCATIONS,
          entryId: STR,
          idempotencyKey: STR,
        },
        ['bankTxnId', 'idempotencyKey'],
      ),
      (ctx, input) => confirmCamtMatch(ctx, as(input)),
    ),
    ctxAction(
      'create_entry_for_txn',
      'write',
      'Book an unmatched txn (a bank fee, interest, a standing transfer) as a balanced two-leg journal entry via A02 (the bank leg plus the chosen contra account) and link it. Refuses currency_mismatch for a txn whose currency differs from the workspace base, and refuses taxCode (declared for a future increment, not modelled yet): book the net and add VAT as a separate manual entry.',
      ctxSchema(
        { bankTxnId: STR, contraAccountId: STR, description: STR, taxCode: STR, idempotencyKey: STR },
        ['bankTxnId', 'contraAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => createEntryForTxn(ctx, as(input)),
    ),
    ctxAction(
      'list_reconciliation',
      'read',
      'The reconciliation board: matched, unmatched and partial txns. A single-statement call (statementId) also returns reconciled (true once the ledger bank account matches the statement\'s closing balance to the Rappen, D64 as-of; absent when the Bankkonto is foreign-currency or the message carried no balance). A cross-statement call (bankAccountId/from/to, or savedViewId) omits it and returns the filtered lists only.',
      ctxSchema({ statementId: STR, bankAccountId: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listReconciliation(ctx, as(input)),
    ),
    ctxAction(
      'list_bank_statements',
      'read',
      'The imported camt statements of the workspace, newest period first, each with its open-line count (lines still unmatched or partial) and the D64 reconciled indicator. This is the door to a statement: take its statementId into list_reconciliation and suggest_matches. bankAccountId narrows to one Bankkonto. Writes nothing.',
      ctxSchema({ bankAccountId: STR }),
      (ctx, input) => listBankStatements(ctx, as(input)),
    ),
  ];
}
