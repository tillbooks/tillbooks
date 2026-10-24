/**
 * A39, the bank inbox verb surface: one line, one proposal, confirm, undo by reversal. Eight verbs (six
 * writes, two reads; D167 added the three standard verbs, D175 widened them into Buchungsregeln), defined here and spread into `ACTIONS` as ONE line (the `fxActions` / `camtActions`
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
import {
  listBankInbox,
  bookBankLine,
  prevalidateBookBankLine,
  prevalidateIgnoreBankLine,
  ignoreBankLine,
  reopenBankLine,
  suggestBankLines,
  setBankStandard,
  clearBankStandard,
  listBankStandards,
} from '../core/banking/index.js';
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
  /** D177: attach the verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

export function bankInboxActions(h: BankInboxActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR, INT, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** One leg of an `accounts` booking (amount in the line's direction; negative runs against it). */
  const LEG = {
    type: 'object',
    properties: {
      accountId: STR,
      amountMinor: INT,
      taxCode: STR,
      description: STR,
      // D178 E3 (A39 §17.4): the leg's amount in the card transaction's currency.
      fx: { type: 'object', properties: { currency: STR, amountMinor: INT }, required: ['currency', 'amountMinor'] },
    },
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
      // D175 (A39 §14.2): an `accounts` booking through a Durchlaufkonto, and the `rule` target.
      viaAccountId: STR,
      standardId: STR,
      asks: { type: 'object' },
      // D178 E3 (A39 §17.1 to §17.4): several documents, a contact, Spesen, the FX acknowledgement.
      allocations: { type: 'array', items: { type: 'object', properties: { documentId: STR, amountMinor: INT }, required: ['documentId', 'amountMinor'] } },
      contactId: STR,
      counterpartyKind: STR,
      mode: STR,
      overrideReason: STR,
      refundVat: STR,
      beyondGuthaben: BOOL,
      claimIds: { type: 'array', items: STR },
      acknowledgeFx: BOOL,
    },
    required: ['kind'],
  } as const;

  /** D175 (A39 §14.1): one leg of a Buchungsregel's recipe. */
  const RECIPE_LEG = {
    type: 'object',
    properties: {
      accountId: STR,
      taxCode: STR,
      // D177 (A39 §16.1): a computed amount, { kind: factor, label, num, den, explain? { vatBp?, feeBp? } }.
      amount: {
        type: 'object',
        properties: { kind: STR, label: STR, legIndex: INT, num: INT, den: INT, explain: { type: 'object', properties: { vatBp: INT, feeBp: INT } } },
        required: ['kind'],
      },
      against: BOOL,
      // D176 (A39 §15.1): a Vorlage's leg states its side.
      side: STR,
      description: STR,
    },
    required: ['accountId', 'amount'],
  } as const;

  return [
    ctxAction(
      'list_bank_inbox',
      'read',
      "The bank inbox: every line of every imported statement in one list, newest first, each with its ONE state (open, booked, matched, ignored), dates, counterparty (name, IBAN), remittance text and reference, signed amount (+ in, - out); an open line carries ONE proposal { target, certainty (sure | learned | check | open), reasonCode, reasonParams, vatCode } the caller can pass straight to book_bank_line, a decided line its decision. A sure proposal is reference-proven, or comes from a standard a person set for this counterparty and direction (reasonCode standard, see set_bank_standard); reasonCode journal_history (a posted journal entry on this bank account naming the counterparty) and model_suggested are always check; an own-account transfer is never sure. A Buchungsregel (set_bank_standard) speaks as reasonCode standard (one complete rule: target accounts, sure, or check when the workspace setting bank.buchungsregel_mode is suggest or a taxed rule meets a foreign-currency line, vatDropped), rule_needs_amount (one rule that asks for amounts: target { kind: rule, standardId, asks: {} }, check, reasonParams.asks [{ legIndex, label }]; fill the asks and pass it to book_bank_line) or several_rules (target null, check, reasonParams.standardIds: pick one) or rule_computed (one rule whose only unknowns are computed amounts: target { kind: rule, standardId, asks: {} }, bookable as it stands, the engine computes each factor leg; reasonParams.computed [{ legIndex, label, amountMinor, explain }]; check, or sure when the setting bank.buchungsregel_computed_mode is bulk; a rule_needs_amount proposal whose rule also computes carries computed too) or rule_ignore (a \"Nicht buchen\" rule: target { kind: ignore, reason, note, standardId }, NOT a book_bank_line target: decide the line with ignore_bank_line { reason, note, standardId }; check, or sure when the setting bank.buchungsregel_ignore_mode is bulk). Every line carries standardId (the rule its proposal used, else the newest live rule for its counterparty and direction, or null) and ruleIds (every live rule for its counterparty and direction); a decided line's decision carries ruleId (the rule it was booked or ignored by), and followUp { standardId, label } names the Vorlage that rule offers as the next step (post_entry with template), else null; vorschlagActionId names the newest pending agent Vorschlag for the line (approve_drafted_action / reject_drafted_action), else null. status defaults to open (all lists every state); bankTxnId narrows to ONE line (with status all, whatever its state: a deep link to a line beyond the first page); query searches counterparty, remittance, reference, IBAN and amount; from and to bound the booking date; direction in (money in, Gutschriften) or out (money out, Belastungen); limit (default 50, max 200 per call) and either the opaque cursor or offset (a numbered page) page past it in one stable order (booking date newest first, then import order). total counts every active filter across all pages; directionCounts { in, out } counts the same filters without the direction (for the two chips). A decided line's decision also names contactId (a contact booking). summary lists per Bankkonto three numbers at the latest statement date: the statement's closing balance, the ledger balance of the linked account that day, and the sum of the lines still open; differenceMinor = bank - ledger - open, zero when bank and books agree (an ignored line whose money is not on the books, or an entry no line backs, shows as a difference). Beside it, never a term of it, start { date, bankMinor, ledgerMinor, gapMinor } (or null) says where bank and books stood when the feed starts: the earliest dated statement's opening balance against the ledger the day before; a gap alone is not missing money (an opening entry dated that day reads as one), and only when gapMinor equals differenceMinor does the whole difference lie before the first imported statement (history the feed never saw: import earlier statements or check the entries before it). Writes nothing. D178 point 19: each line carries possibleDuplicates [{ bankTxnId, reason, format, date, amountMinor, currency }] (the stored lines it may be: matched one to one on a day the books already cover, or of another statement format), possibleDuplicateOf { bankTxnId | null, reason }, needsDuplicateDecision (open, flagged, not decided distinct: never sure, and book_bank_line refuses duplicate_decision_pending until resolve_possible_duplicate decides) and duplicateDecision; facet: duplicates lists only the lines waiting for that decision, and its total is their count.",
      ctxSchema({ bankAccountId: STR, bankTxnId: STR, status: STR, query: STR, from: STR, to: STR, direction: STR, limit: INT, cursor: STR, offset: INT, savedViewId: STR, facet: STR }),
      (ctx, input) => listBankInbox(ctx, as(input)),
    ),
    // D177 (A39 §16.1): a governed seat's booking is validated like a direct call BEFORE it is drafted.
    withPrevalidate(ctxAction(
      'book_bank_line',
      'write:correctable:books',
      "Book ONE open bank line, credit or debit alike, on its own booking date. target.kind: open_item (documentId = an issued invoice for money in, a posted vendor bill for money out; A14 books the payment; remainder leave_open (default) | write_off (a receivable shortfall to 3805, up to A14's one-click threshold, else write_off_above_threshold) | on_account (a surplus as Guthaben); a bill in a live payment run refuses already_batched naming the run), payment_batch (batchId: a debit of the run's own Bankkonto in the run's currency, equal to the run total or, by its EndToEndId, to one payment of the run; a generated A18 run is marked paid on the line's date, a run already paid is MATCHED and posts nothing), existing_entry (entryId: link an entry already on the books, e.g. a migrated one; its leg on this line's bank account must carry the same signed amount, else amount_mismatch names both amounts unless acceptDifference: true with a differenceReason, recorded and shown as a difference in the balance; a leg moving the account the other way refuses direction_mismatch; a leg backing another line refuses entry_already_linked), accounts (legs[]: accountId, amountMinor in the line's direction summing to the line amount, taxCode per leg computed exactly as a manual journal line: Vorsteuer, Umsatzsteuer, Bezugsteuer; a leg on the 1100/2000 control account books with the warning control_account_leg; a transfer the other own account already booked refuses transfer_already_booked naming the entry to match; matching side two of an own-account transfer to side one's entry booked in ANOTHER month refuses transfer_crosses_period with both dates; viaAccountId routes the whole booking through a Durchlaufkonto in ONE entry: bank against it for the line amount, it against each leg with the leg's VAT, so it nets to zero; it must be a balance account that is no leg, no Bankkonto, no control and no VAT account, else invalid_account), rule (standardId of a Buchungsregel from list_bank_standards, asks { legIndex: amountMinor } for every asked leg, positive, in the line's direction unless the leg runs against it; a computed leg (amount factor) takes round-half-up(line amount x num / den) in Rappen, or asks[legIndex] when given (an override); the rest leg takes the line amount minus the others, either sign; a leg whose amount is same takes the asked leg it names; expanded and booked as accounts, the rule kept on the decision (book a standard proposal as { kind: rule, standardId } to keep its next step); refuses rule_not_found (another workspace or a superseded rule), rule_not_applicable (another counterparty or direction), ask_missing (an asked leg without a positive amount, or a computed leg that comes to 0, computed: true), rest_is_zero, wrong_scope (a Vorlage, scope manual, never books a bank line), wrong_outcome (a \"Nicht buchen\" rule: use ignore_bank_line)). D178 (A39 §17): open_item also takes allocations [{ documentId, amountMinor }] instead of documentId: several issued invoices (money in) or posted vendor bills (money out) of ONE contact in ONE A14 payment, each amount at most what the document still asks (allocation_exceeds_open); the deviation is line minus allocations: cash left over books only with remainder on_account (the contact's Guthaben, else deviation_needs_remainder), over-allocation never books (allocations_exceed_line), at 0 remainder leave_open (default) or write_off (invoices, within A14's threshold); refuses allocation_contact_mismatch, wrong_direction (the sides never mix), currency_mismatch, already_paid, not_settleable, already_batched. contact (contactId, counterpartyKind? customer | supplier, mode? guthaben | anzahlung, overrideReason?): a line booked to a contact with no document, money in or out, customers and suppliers; mode guthaben (the workspace setting bank.contact_booking_mode, default) makes the amount the contact's Guthaben through an A14 payment without allocation (apply it later with allocate_payment), mode anzahlung books it to the Anzahlungen account of the settings bank.anzahlung_customer_account (2030) or bank.anzahlung_supplier_account (1190) instead; a mode other than the setting needs overrideReason (reason_required), recorded on the decision; refuses not_found, counterparty_merged (naming survivorId), contact_archived, needs_anzahlung_account, invalid_anzahlung_account, and unsupported (reason foreign_currency_settlement) for a Guthaben or several documents on a Bankkonto not in the base currency (A14 books payments in the base currency; book an Anzahlung or to accounts). With bank.anzahlung_vat on, money in from a customer books the Umsatzsteuer on receipt (cleared when allocate_payment applies the Guthaben), and a refund to that customer corrects the matching share (Entgeltsminderung) by the setting bank.anzahlung_vat_refund: reverse (default), refuse (refundVat reverse | keep must be stated, else anzahlung_vat_refund_needs_decision) or warn; a stated refundVat other than the setting's needs overrideReason. A refund (money out to a customer, money in from a supplier) nets against that contact's open Guthaben oldest first, so allocate_payment can no longer apply the refunded cash; a refund larger than the open Guthaben refuses refund_exceeds_guthaben unless beyondGuthaben: true books the rest on account. expense_claims (claimIds): approved Spesen paid from a DEBIT line in the base currency through E02's own reimbursement (one payment per claim clearing 2260, dated the line's date); the claims must total the line (amount_mismatch); refuses claim_not_approved, claim_posting_reversed, wrong_direction; needs spesen.approve. An accounts leg may carry fx { currency, amountMinor } (its amount in the card transaction's currency; amountMinor stays the CHF the bank booked): booked at the effective rate (CHF over foreign) through a conversion entry against 3806/4906 beside the CHF bank entry, so the ledger matches the bank and nothing is revalued; it needs acknowledgeFx: true (fx_ack_required carries the consequence) and refuses fx_leg_vat_refused, invalid_fx_leg_account (only income or expense accounts), fx_currency_mismatch, fx_leg_needs_base_line, fx_leg_amounts_inconsistent. Every new refusal carries sentence { en, de-CH }. Preview any target first with compose_entry { mode: expand, bankTxnId, target } (booking: bookable, blockedBy, deviationMinor, remainderOptions, documents, contact, claims, fx, consequences). A line that is not open refuses line_not_open (reopen_bank_line first); a locked period refuses period_locked unchanged. An agent seat whose booking is drafted is refused at draft time with exactly these refusals, and its newer Vorschlag for a line replaces the older (rejected, reason ersetzt). Idempotent on idempotencyKey.",
      ctxSchema({ bankTxnId: STR, target: TARGET, text: STR, idempotencyKey: STR }, ['bankTxnId', 'target', 'idempotencyKey']),
      (ctx, input) => bookBankLine(ctx, as(input)),
    ), (ctx, input) => prevalidateBookBankLine(ctx, as(input))),
    // D177 (critic D177-C1): validated like a direct call before it is drafted, so a Vorschlag that can
    // only fail never queues, and never supersedes a good one.
    withPrevalidate(ctxAction(
      'ignore_bank_line',
      'write:reversible:books',
      'Take ONE open bank line out of the inbox without booking it, with a reason: booked_elsewhere | clearing_account | before_start | duplicate | other (note optional). standardId names the "Nicht buchen" Buchungsregel whose proposal (reason rule_ignore) the line follows: it must be a live bank rule with outcome ignore for the counterparty and direction (else rule_not_found, wrong_scope, wrong_outcome, rule_not_applicable), and it is kept on the decision so the next step of the rule is offered. Posts nothing and works in any period. Its money must reach the books elsewhere; the balance line shows whether it did. An imported credit leaves the QR queue with it. An already ignored line answers ok with alreadyIgnored. Undo with reopen_bank_line.',
      ctxSchema({ bankTxnId: STR, reason: STR, note: STR, standardId: STR, idempotencyKey: STR }, ['bankTxnId', 'reason', 'idempotencyKey']),
      (ctx, input) => ignoreBankLine(ctx, as(input)),
    ), (ctx, input) => prevalidateIgnoreBankLine(ctx, as(input))),
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
    // D167 (A39 §13.1): the standard per counterparty. It PREFILLS lines (proposal reason `standard`,
    // certainty sure, so the bulk button books it), never posts by itself. Both writes ride `post` on the
    // dial and A24, and both are G01-denied: a standard steers what the bulk button books.
    ctxAction(
      'set_bank_standard',
      'write:reversible:books',
      "Save a Buchungsregel (a STANDARD) from ONE bank line (bankTxnId), or edit a live one by its standardId (no line needed; the edit replaces it, kept on record): from now on every open line of this line's counterparty (its IBAN, else its normalised name) in the same direction (money in or money out) is proposed booked like this. Simplest form: accountId with taxCode (a code, or null for no MWST): the whole line to that account, certainty sure, reason standard, so the bulk button books it (unless the setting bank.buchungsregel_mode is suggest). A recipe instead: legs (1 to 20) [{ accountId, taxCode, amount: { kind: rest } | { kind: ask, label }, against?, description? }] with exactly ONE rest leg; an asked leg's amount is typed when the line is booked (book_bank_line target rule), so such a rule proposes check, never sure; with legs, accountId and taxCode are ignored. viaAccountId routes the booking through a Durchlaufkonto (a balance account, no leg, no Bankkonto, no control or VAT account). matchText limits the rule to lines whose REMITTANCE text contains it (never the payer name); a counterparty may hold one rule without text and one per distinct text, and a text rule that matches beats the rule without text. label names the rule. Posts nothing and books nothing by itself; the line itself is not booked. A new rule for the same counterparty, direction and text replaces the old one (kept on record); the same recipe, label, text and Durchlaufkonto again answers unchanged: true. Refuses no_counterparty (the line has no IBAN and no name), invalid_account (archived, a Bankkonto's ledger account, the 1100/2000 control accounts, a VAT account 1170/1171/2200/2201), invalid_tax_code (not in this book or archived), vat_not_applicable (a code on an account where MWST cannot apply: only income, expense and asset accounts 12xx, 14xx to 17xx carry one); with legs or viaAccountId, the same checks answer invalid_recipe with detail (legs_count, leg_shape, rest_count, ask_label, against_on_rest, description, invalid_account, invalid_tax_code, vat_not_applicable, via_account) and legIndex. A leg's amount may also be { kind: same, legIndex } (the amount of the asked leg it names; detail same_target otherwise), or COMPUTED from the line: { kind: factor, label, num, den, explain? { vatBp?, feeBp? } }, the amount round-half-up(line amount x num / den) in Rappen (num and den positive integers, e.g. 1081/180 for a gross of MWST 8.1 % plus a 9.9 % fee on the net; explain only words it; detail factor otherwise, and always on a Vorlage); a rule whose only unknowns are computed proposes reason rule_computed, check, or sure under the setting bank.buchungsregel_computed_mode bulk. outcome ignore (instead of legs) makes a \"Nicht buchen\" rule: ignoreReason (booked_elsewhere | clearing_account | before_start | duplicate | other) and ignoreNote, proposed as reason rule_ignore (check, or sure under the setting bank.buchungsregel_ignore_mode bulk); detail ignore_outcome when legs are given or the reason is missing. followUpStandardId names a live Vorlage of this workspace offered as the next step once the line is decided (detail follow_up otherwise). scope manual saves a VORLAGE for the Buchungssatz composer instead: no bankTxnId, label required (one live Vorlage per name, folded: saving or renaming onto a name another live Vorlage holds refuses label_taken naming it (standardId); to replace that Vorlage pass its id as replaceStandardId, and when the name is held by another row at write time, because the Vorlage was edited since, the save refuses label_taken again), legs 2 to 20, every leg with side (debit | credit), exactly one rest leg (what balances the entry), asked and same legs; no matchText, viaAccountId, outcome ignore or followUp; a Vorlage never names a bank ledger, control or VAT account. Book from it with post_entry { template: { standardId, asks } }. Editing refuses rule_not_found (not a live rule of this workspace) and wrong_scope (a Vorlage edited as a bank rule or the other way round). Idempotent on idempotencyKey.",
      ctxSchema(
        {
          bankTxnId: STR,
          standardId: STR,
          scope: { type: 'string', enum: ['bank', 'manual'] },
          outcome: { type: 'string', enum: ['legs', 'ignore'] },
          ignoreReason: STR,
          ignoreNote: STR,
          followUpStandardId: STR,
          replaceStandardId: STR,
          accountId: STR,
          taxCode: STR,
          label: STR,
          matchText: STR,
          viaAccountId: STR,
          legs: { type: 'array', items: RECIPE_LEG },
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => setBankStandard(ctx, as(input)),
    ),
    ctxAction(
      'clear_bank_standard',
      'write:reversible:books',
      'Remove ONE standard (standardId from list_bank_standards or a line\'s standardId): later lines of that counterparty are no longer proposed by it. The standard stays on record as cleared, never deleted; nothing booked changes. An already cleared standard answers ok with alreadyCleared: true. Idempotent on idempotencyKey.',
      ctxSchema({ standardId: STR, idempotencyKey: STR }, ['standardId', 'idempotencyKey']),
      (ctx, input) => clearBankStandard(ctx, as(input)),
    ),
    ctxAction(
      'list_bank_standards',
      'read',
      'Every live Buchungsregel, newest first, valid or not; scope (bank | manual) narrows to the bank rules or the Vorlagen (default both): { id, scope, outcome (legs | ignore), counterpartyKey (iban:... or name:..., null for a Vorlage), counterpartyLabel, direction (in | out, null for a Vorlage), label, matchText, viaAccountId, viaAccountNumber, viaAccountName, legs [{ accountId, accountNumber, accountName, taxCode, amount { kind rest | ask | same, label, legIndex }, side? (a Vorlage), against?, description? }], ignoreReason and ignoreNote (an ignore rule), followUpStandardId and followUpLabel (the next step, while that Vorlage is live), invalidReason (null, or why the rule is silent: account_archived | account_not_bookable | tax_code_inactive | vat_not_applicable | recipe_unreadable), accountId, accountNumber, accountName, taxCode (the rest leg; null for an ignore rule), setBy, setAt }. A bank rule prefills the bank lines of its counterparty and direction (proposal reasons standard, rule_needs_amount, several_rules, rule_ignore); a Vorlage is booked through post_entry { template }. Writes nothing.',
      ctxSchema({ scope: { type: 'string', enum: ['bank', 'manual'] } }),
      (ctx, input) => listBankStandards(ctx, as(input)),
    ),
  ];
}
