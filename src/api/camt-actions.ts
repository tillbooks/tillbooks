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
  importCamtFiles,
  suggestCamtMatches,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  listBankStatements,
  reviewBankTxn,
  setCamtMatching,
} from '../core/banking/index.js';
import type { ActionKind } from './actionKind.js';

export interface CamtActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
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
      'write:final:books',
      "Import a day-end camt.053 statement onto a registered Bankkonto (A19): parses the XML, checks the file's IBAN against the account, and persists every booked entry, each keyed on its own bank-assigned identity (AcctSvcrRef, falling back to NtryRef, falling back to a content hash) so an overlapping statement cannot re-import the same booking twice. A byte-identical re-import of the same statement (Stmt/Id + ElctrncSeqNb + page number) is a safe no-op (duplicate:true); a same-identity statement whose content has genuinely changed refuses with statement_amended, naming what changed. A genuine same-day twin the identity key would otherwise treat as a repeat is admitted only via allowDuplicateEntries:true. A batch entry (several TxDtls in one booking) fans out into one line per TxDtls; a repeated AcctSvcrRef inside one booking is kept apart (asr:<ref>#<n>), and a batch whose details are in another currency or do not sum to the booking is ONE line of the booking amount. A camt.054 refuses camt054_refused (a detail notification, not a statement). A camt.053 without ElctrncSeqNb or closing balance imports with the warning not_day_end_statement in warnings[]: import that day's day-end statement too. On an account fed over EBICS (A36) the successor rule decides first, at this door as at bank_sync: a statement imports only as the successor of the newest statement in the books (feed.rule, and with the warning statement_number_jump plus feed.jump naming the skipped numbers when its number skips some but its balances chain) or as the filler of a hole; a copy of one already there is a no-op (duplicate:true); otherwise it refuses gap_refused, overlap_refused, before_feed_start, unsupported_multipage_statement, or not_day_end_statement (refused there, not a warning), each naming the statements it compared, and a retry never helps: import the missing statement first. A booked, non-reversal CREDIT is also registered in A21's QR queue, whose row follows the line. Every new line then waits in the bank inbox (list_bank_inbox / book_bank_line); nothing is booked by the import. An archived Bankkonto refuses bank_account_archived; a file whose IBAN belongs to another registered account refuses iban_mismatch naming both IBANs and that account; an IBAN registered nowhere answers needs_bank_account with the file IBAN. Any entry this parser could not read, or an entry it skipped as a duplicate, is named in the skipped[] list, never silently dropped.",
      ctxSchema(
        { bankAccountId: STR, xml: STR, allowDuplicateEntries: BOOL, idempotencyKey: STR },
        ['bankAccountId', 'xml', 'idempotencyKey'],
      ),
      (ctx, input) => importCamt(ctx, as(input)),
    ),
    // A36 §4.7 (D150): the hand repair of a statement gap, several files in one call.
    ctxAction(
      'import_camt_files',
      'write:final:books',
      "Import several day-end camt.053 files onto one registered Bankkonto at once, in statement-number order: the hand repair of a statement gap (A36 §4.7, D150), for the days fetched from eBanking. Each file is split into single statements when it holds several <Stmt> (the envelope kept; a file whose statements disagree on IBAN or currency, or lack ElctrncSeqNb, is refused camt_split_refused rather than guessed), every statement is sorted by its position (year of FrDtTm, ElctrncSeqNb), and ONE ordered pass imports each through import_camt's own door, so on an EBICS-fed account the successor rule decides exactly as for one file (a hole filler lands in number order) and nothing counts twice. The answer is one outcome per statement in pass order: imported (statementId, txnCount, warnings), already_imported (the same statement is in the books; dropping the same files again imports nothing) or refused with the code and reason import_camt gives (gap_refused names the differenceMinor that does not chain, overlap_refused, iban_mismatch, camt054_refused, ...), plus imported/alreadyImported/refused totals. At most 100 files. Each call needs a fresh idempotencyKey; a replay returns the first report. Books nothing: every new line waits in the bank inbox.",
      ctxSchema(
        {
          bankAccountId: STR,
          files: { type: 'array', items: { type: 'object', properties: { name: STR, xml: STR }, required: ['xml'] } },
          idempotencyKey: STR,
        },
        ['bankAccountId', 'files', 'idempotencyKey'],
      ),
      (ctx, input) => importCamtFiles(ctx, as(input)),
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
      'write:correctable:internal',
      "Signal that ONE open bank line (credit or debit) needs a human's review because its A39 proposal is below the workspace threshold (A36). Writes no ledger row and books nothing: it is a pure signal whose success emits bank_txn.needs_review for a G01 rule to react to (e.g. create an E03 task). Idempotent per (bankTxnId, idempotencyKey). import_camt already fires the same event once per new line; call this to re-signal a line later.",
      ctxSchema({ bankTxnId: STR, idempotencyKey: STR }, ['bankTxnId', 'idempotencyKey']),
      (ctx, input) => reviewBankTxn(ctx, as(input)),
    ),
    ctxAction(
      'set_camt_matching',
      'write:reversible:internal',
      'Tune the workspace debit-matching (A36 §6b): valueDateWindowDays (0-60, default 5) widens or narrows the value-date proximity signal, and reviewThreshold (any|medium|high, default any) sets the confidence floor below which a booked debit reports needsReview. These tune ranking and the review event only; they never touch the mandatory exact amount + currency gate. Idempotent; one row per workspace.',
      ctxSchema({ valueDateWindowDays: INT, reviewThreshold: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => setCamtMatching(ctx, as(input)),
    ),
    ctxAction(
      'confirm_match',
      'write:correctable:books',
      "A20's decision verb, now a wrapper over book_bank_line: settle an outgoing DEBIT against a vendor bill (vendorBillId, an open_item booking; a surplus parks as the supplier's Guthaben) or several bills (allocations[] for a multi-bill split) through A14's record_payment, or MATCH an existing journal entry that already books the movement (entryId, credit or debit: the entry must book this line's bank account with the same signed amount and its leg must not back another line). A settlement against a bank fact that is not a DBIT refuses wrong_direction. A line that is no longer open refuses line_not_open. Idempotent per key.",
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
      'write:correctable:books',
      'A20\'s booking verb, now a wrapper over book_bank_line with one accounts leg: book an open line (a bank fee, interest, a refund, a transfer; credit or debit) to the chosen contra account via A02 and link it. taxCode is computed exactly as a manual journal line under the workspace VAT method (Vorsteuer, Umsatzsteuer, Bezugsteuer). A foreign-currency line books in its own currency at the stored rate (VAT on it refuses unsupported). A line that is no longer open refuses line_not_open.',
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

