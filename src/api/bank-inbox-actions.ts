/**
 * A39, the bank inbox verb surface: one line, one proposal, confirm, undo by reversal. Five verbs (four
 * writes, one read), defined here and spread into `ACTIONS` as ONE line (the `fxActions` / `camtActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line rather
 * than a block. The helpers arrive as a parameter to keep the module graph acyclic: `registry.ts` imports
 * this file and this file must not import it back.
 *
 * Every write takes an `idempotencyKey` and replays its stored answer; every write is on the G01 denylist
 * and dial-governed (spec A39 §3, D-A39.4, D139).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { listBankInbox, bookBankLine, ignoreBankLine, reopenBankLine, suggestBankLines } from '../core/banking/index.js';
import type { ActionKind } from './actionKind.js';

export interface BankInboxActionHelpers {
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

export function bankInboxActions(h: BankInboxActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** One leg of an `accounts` booking (amount in the line's direction; negative runs against it). */
  const LEG = {
    type: 'object',
    properties: { accountId: STR, amountMinor: INT, taxCode: STR, description: STR },
    required: ['accountId', 'amountMinor'],
  } as const;

  /** What a line is booked to (spec A39 §4.3); `kind` selects which of the other fields apply. */
  const TARGET = {
    type: 'object',
    properties: {
      kind: STR,
      documentId: STR,
      remainder: STR,
      writeOffAccountId: STR,
      batchId: STR,
      entryId: STR,
      acceptDifference: BOOL,
      differenceReason: STR,
      legs: { type: 'array', items: LEG },
    },
    required: ['kind'],
  } as const;

  return [
    ctxAction(
      'list_bank_inbox',
      'read',
      "The bank inbox: every line of every imported statement in one list, newest first, each with its ONE state (open, booked, matched, ignored), dates, counterparty (name, IBAN), remittance text and reference, signed amount (+ in, - out); an open line carries ONE proposal { target, certainty (sure | learned | check | open), reasonCode, reasonParams, vatCode } the caller can pass straight to book_bank_line, a decided line its decision. Only sure proposals are reference-proven; an own-account transfer is never sure. status defaults to open (all lists every state); bankTxnId narrows to ONE line (with status all, whatever its state: a deep link to a line beyond the first page); query searches counterparty, remittance, reference, IBAN and amount; limit (default 50, max 200) and the opaque cursor page. summary lists per Bankkonto three numbers at the latest statement date: the statement's closing balance, the ledger balance of the linked account that day, and the sum of the lines still open; differenceMinor = bank - ledger - open, zero when bank and books agree (an ignored line whose money is not on the books, or an entry no line backs, shows as a difference). Writes nothing.",
      ctxSchema({ bankAccountId: STR, bankTxnId: STR, status: STR, query: STR, from: STR, to: STR, limit: INT, cursor: STR, savedViewId: STR }),
      (ctx, input) => listBankInbox(ctx, as(input)),
    ),
    ctxAction(
      'book_bank_line',
      'write:correctable:books',
      "Book ONE open bank line, credit or debit alike, on its own booking date. target.kind: open_item (documentId = an issued invoice for money in, a posted vendor bill for money out; A14 books the payment; remainder leave_open (default) | write_off (a receivable shortfall to 3805, up to A14's one-click threshold, else write_off_above_threshold) | on_account (a surplus as Guthaben); a bill in a live payment run refuses already_batched naming the run), payment_batch (batchId: a debit of the run's own Bankkonto in the run's currency, equal to the run total or, by its EndToEndId, to one payment of the run; a generated A18 run is marked paid on the line's date, a run already paid is MATCHED and posts nothing), existing_entry (entryId: link an entry already on the books, e.g. a migrated one; its leg on this line's bank account must carry the same signed amount, else amount_mismatch names both amounts unless acceptDifference: true with a differenceReason, recorded and shown as a difference in the balance; a leg moving the account the other way refuses direction_mismatch; a leg backing another line refuses entry_already_linked), accounts (legs[]: accountId, amountMinor in the line's direction summing to the line amount, taxCode per leg computed exactly as a manual journal line: Vorsteuer, Umsatzsteuer, Bezugsteuer; a leg on the 1100/2000 control account books with the warning control_account_leg; a transfer the other own account already booked refuses transfer_already_booked naming the entry to match; matching side two of an own-account transfer to side one's entry booked in ANOTHER month refuses transfer_crosses_period with both dates). A line that is not open refuses line_not_open (reopen_bank_line first); a locked period refuses period_locked unchanged. Idempotent on idempotencyKey.",
      ctxSchema({ bankTxnId: STR, target: TARGET, text: STR, idempotencyKey: STR }, ['bankTxnId', 'target', 'idempotencyKey']),
      (ctx, input) => bookBankLine(ctx, as(input)),
    ),
    ctxAction(
      'ignore_bank_line',
      'write:reversible:books',
      'Take ONE open bank line out of the inbox without booking it, with a reason: booked_elsewhere | clearing_account | before_start | duplicate | other (note optional). Posts nothing and works in any period. Its money must reach the books elsewhere; the balance line shows whether it did. An imported credit leaves the QR queue with it. An already ignored line answers ok with alreadyIgnored. Undo with reopen_bank_line.',
      ctxSchema({ bankTxnId: STR, reason: STR, note: STR, idempotencyKey: STR }, ['bankTxnId', 'reason', 'idempotencyKey']),
      (ctx, input) => ignoreBankLine(ctx, as(input)),
    ),
    ctxAction(
      'reopen_bank_line',
      'write:correctable:books',
      "Undo the decision on ONE bank line without editing history: a booked line's entry is reversed, or its payment reversed (which reopens the settled invoice or bill), on the date of what is reversed; a matched or ignored line only has its decision superseded and posts nothing. The old decision stays on record with who, when and reason; the line is open again and an imported credit's QR row follows it. A run booked through payment_batch keeps its payments (reverse_payment undoes one). A transfer whose other bank leg the other account's line still holds refuses owned_by naming that line: reopen that line first. A locked period refuses period_locked unchanged.",
      ctxSchema({ bankTxnId: STR, reason: STR, idempotencyKey: STR }, ['bankTxnId', 'reason', 'idempotencyKey']),
      (ctx, input) => reopenBankLine(ctx, as(input)),
    ),
    ctxAction(
      'suggest_bank_lines',
      'write:correctable:derived',
      'Let the LOCAL decision model (E05, D144) suggest an account for the open bank lines no reference and no earlier booking can place (their proposal is open, no_proposal). For each such line, newest first, at most 50 are put to the model per call (remaining counts the rest; a line already decided on the same input does not count, so the next call reaches them), TILL builds up to 8 candidate accounts from this book\'s own bookings and its chart, the model picks one with a calibrated probability, and the answer is recorded (model, pinned sha256, every probability) BEFORE list_bank_inbox shows it as the proposal reason model_suggested, always certainty check, never sure; a choice below 50 % is recorded and shows nothing. Posts nothing and books nothing: book the line with book_bank_line as always. bankAccountId or bankTxnIds (at most 200, e.g. the lines in view) narrow the scope. A line already decided on the same input by the same model adds no row. Refuses needs_local_runtime (no local runtime installed; there is no cloud fallback), needs_model_selection, needs_decide_model (the model cannot decide or its calibration was never measured), unsupported_model_language (the model does not read German and French). Idempotent on idempotencyKey.',
      ctxSchema({ bankAccountId: STR, bankTxnIds: { type: 'array', items: STR }, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => suggestBankLines(ctx, as(input)),
    ),
  ];
}
