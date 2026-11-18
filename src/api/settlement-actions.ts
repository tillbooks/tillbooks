/**
 * D185, the settlement socket: `import_settlement` and the owner's booking template, defined here and
 * spread into `ACTIONS` as ONE line (the `camtActions` / `fxActions` precedent), so several agents appending
 * to the append-only registry at once collide over a line rather than a block. The helpers arrive as a
 * parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { ActionKind } from './actionKind.js';
import {
  importSettlement,
  prevalidateImportSettlement,
  setSettlementTemplate,
  prevalidateSetSettlementTemplate,
  getSettlementTemplate,
  setSettlementSource,
  prevalidateSetSettlementSource,
  getSettlementSource,
  pullSettlement,
  prevalidatePullSettlement,
  settlementPayoutForBankLine,
  resolveSettlementEvent,
  prevalidateResolveSettlementEvent,
  setSettlementEventIgnored,
  prevalidateSetSettlementEventIgnored,
  settlementReview,
  settlementFromTable,
  setSettlementTableMapping,
  prevalidateSetSettlementTableMapping,
  getSettlementTableMapping,
  turnoverSummary,
  settlementPeriods,
  TURNOVER_COMPARE,
  TURNOVER_MAX_DAYS,
  TURNOVER_TOP_MAX,
  TABLE_COLUMN_FIELDS,
  TABLE_VAT_MODES,
  TABLE_DATE_FORMATS,
} from '../core/settlement/index.js';
import { SETTLEMENT_KINDS } from '../core/settlement/index.js';
// N01 US-N01.1: an account field takes an id or its number, resolved at the registry input boundary.
import { ACCOUNT_REF } from './input-boundary.js';

export interface SettlementActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** D158/D178: attach a verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
}

export function settlementActions(h: SettlementActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR } = h;
  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** One kind's rule in a template. */
  const KIND_RULE = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['book', 'skip', 'attention'] }, accountId: ACCOUNT_REF, taxCode: STR },
    required: ['action'],
  } as const;
  const KINDS = {
    type: 'object',
    properties: {
      sale: KIND_RULE,
      refund: KIND_RULE,
      processing_fee: KIND_RULE,
      service_fee: KIND_RULE,
      third_party_payout: KIND_RULE,
      third_party_payout_reversal: KIND_RULE,
      reserve: KIND_RULE,
      bank_payout: KIND_RULE,
      bank_payout_summary: KIND_RULE,
      other: KIND_RULE,
    },
  } as const;
  const ATTACHMENT = {
    type: 'object',
    properties: { fileName: STR, contentBase64: STR, documentNumber: STR },
    required: ['fileName', 'contentBase64', 'documentNumber'],
  } as const;

  /** A43 §2, the column mapping of a settlement table. */
  const KIND_ENUM = { type: 'string', enum: [...SETTLEMENT_KINDS] } as const;
  const TABLE_MAPPING = {
    type: 'object',
    properties: {
      // `id` names one header, or several composed into one id.
      columns: { type: 'object', properties: Object.fromEntries(TABLE_COLUMN_FIELDS.map((f) => [f, f === 'id' ? { anyOf: [{ type: 'string' }, { type: 'array', items: STR }] } : STR])) },
      kindMap: { type: 'object', additionalProperties: KIND_ENUM },
      kindDefault: { type: 'object', properties: { positive: KIND_ENUM, negative: KIND_ENUM } },
      vat: { type: 'object', properties: { mode: { type: 'string', enum: [...TABLE_VAT_MODES] }, fees: { type: 'string', enum: ['none', 'from_template'] } } },
      dateFormat: { type: 'string', enum: [...TABLE_DATE_FORMATS] },
      decimalSeparator: { type: 'string', enum: ['.', ','] },
      feeSign: { type: 'string', enum: ['deducted', 'signed'] },
      amountSign: { type: 'string', enum: ['as_stated', 'by_kind'] },
      idDayPrecision: { type: 'string', enum: ['day', 'second'] },
      delimiter: { type: 'string', enum: ['semicolon', 'comma', 'tab'] },
      encoding: { type: 'string', enum: ['utf-8', 'windows-1252'] },
      headerRow: { type: 'integer' },
      // D206: a person confirms the export lists whole days (the whole-day mode, without an id).
      wholeDays: { type: 'boolean' },
      // Answered back by settlement_from_table; a caller's value is ignored (the engine stamps its own scheme).
      idScheme: { type: 'integer' },
    },
    required: ['columns'],
  } as const;

  return [
    withPrevalidate(
      ctxAction(
        'import_settlement',
        'write:correctable:books',
        "Book a till-settlement/v1 file: the money that moved through a payment processor's or a marketplace's balance (sales, refunds, fees, payouts to third parties and their reversals, reserves, bank payouts), event by event, through the owner's booking template for the file's source (set_settlement_template; the file's own clearingAccount and vat.code are labels TILL never books by). Send the file as settlement (the JSON object) or content (its text, at most 10 MB). Each event of a kind the template books becomes ONE balanced entry dated its day, source import: the clearing account carries amount (positive = Soll), the template's contra account carries -net with the template's tax code, and the VAT account (2200 for an output code, 1170/1171 for input) carries -vat.amount, so the MWST-Abrechnung shows the file's exact VAT and base. The stated VAT must be what the code gives on the net or on the gross (one round, to the Rappen), else that event refuses vat_not_exact; VAT on a kind booked without a tax code refuses vat_unmapped. An event with vat null under an INPUT code books its gross as the net with no VAT line (the file states zero input VAT, for example a payout to a seller who is not VAT-registered); under an output code it still refuses vat_not_exact. The entry text is the description and the counterparty; the document number is the entry's ref; the external refs are kept with the event. Idempotent on the external id (workspace + source.system + source.processor + event id): an event booked before is already_imported and books nothing (when a PDF for it then fails to link, the outcome carries code attachment_failed and the cause, and the entry stays as it is); the same id with other kind, day, currency, amount, net or VAT refuses event_amended naming each change, and the posted entry is never edited (correct it with reverse_entry). An event into a locked or closed period refuses period_locked on its own; a malformed event refuses on its own (missing_id, duplicate_id, invalid_day, currency_mismatch, unknown_kind, invalid_amount for more than two decimals or a float spelling, amount_mismatch when amount is not net + vat.amount); every other event still books. The whole call refuses, writing nothing, on a schema other than till-settlement/v1 (unsupported_schema), no template for the source (settlement_template_missing), a kind in the file the template does not map (settlement_template_incomplete, naming the kinds), or a template whose accounts or codes no longer pass (settlement_template_invalid), or (A43) table events minted under an id derivation (refs.tableIdRecipe) the source has not booked under and no saved mapping holds (event_id_derivation_changed: a person saves the mapping with confirmIdChange first). attachments [{ fileName, contentBase64, documentNumber }] (PDFs, at most 200 and 25 MB together) are linked as Belege to every entry whose event carries that document.number (needs manage_files); unmatchedAttachments names the rest. D198: an event dated before the source's fromDate (set_settlement_source) is skipped before_from_date; an event of a TEST payment (refs.test, sticky per transaction key chargeId, paymentIntentId, paymentId or transferId, on any document of the source) is skipped test_event under the setting settlement.test_events skip (the default), except a processing_fee or service_fee while settlement.test_fees is book (the default: the processor's fee on a test payment is real money); an event a person marked handled outside the import (resolve_settlement_event handled_outside) is skipped handled_outside; a stored event still answers already_imported or event_amended first (event_amended whenever its figures differ from the booked ones, whatever the template does with the kind now). Every arrival is first compared with the producer's latest stated figures for its id (the first sighting, or the newest restatement): any difference in kind, day, amount, net or VAT is logged event_amended and named in the event's restated list, whatever the template or the override says, so the vat_return check sees it. A document with complete: false refuses whole (settlement_incomplete). Every event is kept as observed, with its flags and an outcome row, for the vat_return check. A third_party_payout, third_party_payout_reversal or processing_fee without a transaction key is named in warnings. The answer: events[] (booked with entryId | already_imported with entryId | skipped with reason template_skip, needs_attention, zero_amount, handled_outside, before_from_date or test_event | refused with code and sentence), the counts, needsAttention (event ids of kinds the template leaves to a person), totals per kind, the file's warnings, and reconciliation { expectedClearingChangeMinor: every event amount in the file, payouts included (the processor balance change), bookedClearingChangeMinor: what the entries of the file's own events put on the clearing account, booked by this call or an earlier one, net of reversing entries, differenceMinor (booked - expected), bankPayoutsMinor: the file's payouts with no entry, notBookedByImportMinor: every other event with no entry (an event booked earlier never counts here, even after its kind is switched to skip), unexplainedMinor: booked + payouts + not booked - expected, 0 when every Rappen is accounted for (else an amended event, a reversal or a changed clearing account) }: once the bank payout lines are booked (a one-leg Buchungsregel bank to clearing account), the residual on the clearing account is the reserve the processor holds. A42: the answer carries reviewSha256, the digest of what this import does (every event's outcome, figures and booked lines); expectReviewSha256 (the reviewSha256 of the settlement_review the person booked from) refuses review_stale, rolling everything back, when the import would now do anything else. D206, whole-day events (ids day:<day>#<n>, minted by settlement_from_table from a table without an id): booked only while settlement.table_event_id is column_else_day and the source's saved mapping, which a person confirmed lists whole days, minted them (else the whole call refuses day_mode_unconfirmed with cause setting, mapping or recipe); inside the import's own transaction each day of them is compared with what the source already holds (every event the import has seen, any door): a new day books, a held day of exactly these whole-day events goes on to the usual idempotency, any other held day refuses every one of its events day_differs, and a day of today or later day_not_over; the first and the last day of the document's whole-day events, when new, follow settlement.table_edge_days (include books them, exclude refuses edge_day_excluded, ask (the default) refuses edge_day_unconfirmed unless confirmEdgeDays, the ISO days a PERSON says are complete, names them; read from the call, never from the document; a governed seat sending it is refused person_decides and the approval never adds it; each day it lets in is audited); the edges are those of the whole file when fileDays { first, last } (a PERSON's input, the first and last day settlement_from_table answered in edgeDays) is given, so a period's part of a file keeps the file's real edges; fileDays must cover the document's whole-day days (else invalid_input), and a governed seat sending it is refused person_decides (its import keeps the document's own edges). Each call needs an idempotencyKey; a replay returns the first report.",
        ctxSchema(
          {
            settlement: { type: 'object' },
            content: STR,
            attachments: { type: 'array', items: ATTACHMENT },
            expectReviewSha256: STR,
            confirmEdgeDays: { type: 'array', items: STR },
            fileDays: { type: 'object' },
            idempotencyKey: STR,
          },
          ['idempotencyKey'],
        ),
        (ctx, input) => importSettlement(ctx, as(input)),
      ),
      (ctx, input) => prevalidateImportSettlement(ctx, as(input)),
    ),
    withPrevalidate(
      ctxAction(
        'set_settlement_template',
        'write:reversible:books',
        "Save the booking template of ONE settlement source (system and processor, as a till-settlement/v1 file names them in source; matched trimmed and case-insensitively): clearingAccountId, the Durchlaufkonto the processor balance is booked on (an asset or liability account, id or number), and kinds { <kind>: { action: book, accountId, taxCode (an output, input, zero-rated or exempt code, or null for no VAT) } | { action: skip } | { action: attention } } for the kinds sale, refund, processing_fee, service_fee, third_party_payout, third_party_payout_reversal, reserve, bank_payout, bank_payout_summary, other. A kind not named takes its default: bank_payout and bank_payout_summary skip (the bank import books the payout, bank account against the clearing account), reserve skips (the money stays on the clearing account), other is attention (not booked, named for a person); every other kind stays unmapped, and import_settlement refuses a file that carries an unmapped kind. Saving replaces the template; a save of the template in force is a no-op (changed: false). Every change is kept with the old and new template, who and when. Refuses invalid_account, account_archived, unknown_tax_code, archived_tax_code or tax_code_unsupported naming the field, and payout_not_turnover when bank_payout or bank_payout_summary is booked to a revenue account (Nettoerlöse, 30xx to 38xx): a payout is never turnover. Books nothing. Idempotent per key.",
        ctxSchema({ system: STR, processor: STR, clearingAccountId: ACCOUNT_REF, kinds: KINDS, idempotencyKey: STR }, ['system', 'processor', 'clearingAccountId', 'idempotencyKey']),
        (ctx, input) => setSettlementTemplate(ctx, as(input)),
      ),
      (ctx, input) => prevalidateSetSettlementTemplate(ctx, as(input)),
    ),
    ctxAction(
      'get_settlement_template',
      'read',
      'The booking template of one settlement source (system and processor), or of every source when neither is given: templates [{ templateId, system, processor, template { clearingAccountId, clearingAccountNumber, kinds { <kind>: { action: book, accountId, accountNumber, taxCode } | { action: skip | attention | unmapped } } }, updatedBy, updatedAt }]. An unknown source answers an empty list. Writes nothing.',
      ctxSchema({ system: STR, processor: STR }),
      (ctx, input) => getSettlementTemplate(ctx, as(input)),
    ),
    // D198, the settlement feed: where a producer's till-settlement/v1 feed is pulled from, and the pull.
    withPrevalidate(
      ctxAction(
        'set_settlement_source',
        'write:reversible:human-only',
        "A PERSON saves where TILL pulls ONE settlement source's till-settlement/v1 feed from (system and processor as the feed names them in source; matched trimmed and case-insensitively): baseUrl (the producer's address, https; http only to localhost; no user, password, query or fragment; TILL asks baseUrl + /api/accounting/till-settlement?from=YYYY-MM-DD&to=YYYY-MM-DD with Authorization: Bearer <token>), fromDate (the first day TILL ever pulls), and optionally feedPath (A43: the path the feed is served under, default /api/accounting/till-settlement; a path only, a query or a fragment refuses invalid_input; omitted keeps the saved path, so any local process that serves the contract is a pull connector) and feedToken (16 to 512 characters of letters, digits and . _ ~ + / = -) or clearToken: true. The token goes to the host's secret store (the macOS Keychain), never into the book, a file, a log or an answer; get_settlement_source says only whether one is stored. A token is bound to the full address it was saved for: a save that changes baseUrl or feedPath without a new token drops the stored one (tokenDroppedUrlMoved: true). Saving replaces the source; every change is kept (old and new, who and when, never the token). Books nothing. Refused: human_only for an agent seat under every dial (an agent can neither save nor propose it), invalid_input naming the field (the answer never echoes a token), secret_store_unavailable (this host has no secret store), secret_store_failed. Idempotent per key.",
        ctxSchema(
          { system: STR, processor: STR, baseUrl: STR, feedPath: STR, fromDate: STR, feedToken: STR, clearToken: { type: 'boolean' }, idempotencyKey: STR },
          ['system', 'processor', 'baseUrl', 'fromDate', 'idempotencyKey'],
        ),
        (ctx, input) => setSettlementSource(ctx, as(input)),
      ),
      (ctx, input) => prevalidateSetSettlementSource(ctx, as(input)),
    ),
    ctxAction(
      'get_settlement_source',
      'read',
      'The settlement source of one system and processor, or every source when neither is given: sources [{ sourceId, system, processor, baseUrl, fromDate, tokenStored (true or false, never the token), secretStore, watermark (the last day a successful pull covered, or null), lastPull { pullId, from, to, outcome (ok | incomplete | failed), errorCode, trigger (manual | daily), eventsSeen, eventsNew, amendedSeen, booked, alreadyImported, skipped, refused, actor, at } | null, pullMode, templateSaved, updatedBy, updatedAt }], pullMode (the setting settlement.pull_mode: manual | daily), feedAvailable (this host can reach a feed). Writes nothing.',
      ctxSchema({ system: STR, processor: STR }),
      (ctx, input) => getSettlementSource(ctx, as(input)),
    ),
    withPrevalidate(
      ctxAction(
        'pull_settlement',
        'write:correctable:books',
        "Pull ONE settlement source's till-settlement/v1 feed (set_settlement_source) for a range and book it through import_settlement, unchanged: the same template, the same per-event idempotency on workspace + system + processor + event id (an event booked before is already_imported, so a re-pull books nothing twice), the same refusals per event. from and to (YYYY-MM-DD) default to the watermark less settlement.pull_overlap_days (default 7) (late events and payouts arriving later are fetched again) up to today in Switzerland, never before the source's fromDate; a default range is cut at 366 days (more: true, pull again), a range you give longer than that refuses. Every event of the feed is also kept as observed (the kinds the template skips included, such as bank_payout and reserve) for settlement_payout_for_bank_line and the vat_return findings. The answer: pullId, system, processor, from, to, more, eventsSeen, eventsNew, amendedSeen (events seen before with other figures; the import refuses them event_amended), complete, and import (the full import_settlement answer, which decides about test events, the from-date and the events a person marked handled outside the import, on both doors). A document the producer marks complete: false is never imported: the pull keeps its test flags and payout links only, logs the pull incomplete (it covers no days) and answers ok with complete: false and import: null. Refuses, writing nothing: settlement_source_missing, settlement_template_missing (checked before anything is fetched: nothing is fetched or booked without a saved template), token_missing, feed_transport_missing (this host cannot reach a feed), feed_unreachable, feed_unauthorized (401: save the current token again), feed_bad_request (400: a bad range or more than 366 days), feed_http_error (any other status), feed_schema (not JSON, not till-settlement/v1, or a whole-file refusal of the reader with its cause), feed_source_mismatch (the feed names another system or processor), and every whole-file refusal of import_settlement. A42: expectReviewSha256 (the reviewSha256 of the settlement_review the person booked from) rides into the import, which refuses review_stale when what it would book differs from the review; the whole pull is then rolled back, nothing written. Each call needs an idempotencyKey; a replay returns the first report.",
        ctxSchema({ system: STR, processor: STR, from: STR, to: STR, expectReviewSha256: STR, idempotencyKey: STR }, ['system', 'processor', 'idempotencyKey']),
        (ctx, input) => pullSettlement(ctx, as(input)),
      ),
      (ctx, input) => prevalidatePullSettlement(ctx, as(input)),
    ),
    ctxAction(
      'settlement_payout_for_bank_line',
      'read',
      "Which processor payout ONE bank line (bankTxnId) is, from the settlement feed TILL pulled (pull_settlement), and what it is made of. A line coming in, in the workspace currency, matches every observed bank_payout whose amount is the line's (the feed states a payout negative: money leaving the processor balance) and whose day (its arrival date) lies within 3 days of the line's booking date, of every source whose template books on clearingAccountId (an account id; every source with a template when omitted). The answer: bankTxnId, direction (in | out), amountMinor, day, match (none | one | several; propose a booking only on one), matches [{ system, processor, clearingAccountId, payoutEventId, payoutId, day, amountMinor, dayDistance, composition { basis (exact only: refs when the events that state this payoutId explain it to the Rappen, partial when they do not, none when no event states it yet, a payout in transit), events [{ eventId, kind, day, amountMinor, netMinor, vatMinor, feeWaived, test, coachVatRegistered, invoiceNumber, conflict (the event states another payoutId too) }], sumMinor, residualMinor (sum + payout: 0 when the events explain the payout to the Rappen), byKind { <kind>: { events, amountMinor } } } }], nearest day first. A line going out matches nothing. Refuses not_found for a line of another workspace. Writes nothing.",
      ctxSchema({ bankTxnId: STR, clearingAccountId: ACCOUNT_REF }, ['bankTxnId']),
      (ctx, input) => settlementPayoutForBankLine(ctx, as(input)),
    ),
    // D198 stateless check S5 and the owner's answer of 12.11.2026: a person answers the TEST TRACK of one
    // settlement event and its transaction, or OVERRIDES the event as handled outside the import (D172 per-call
    // override with an audited reason). Human-only: an agent seat is refused human_only under every dial,
    // before a draft.
    withPrevalidate(
      ctxAction(
        'resolve_settlement_event',
        'write:reversible:human-only',
        "A PERSON answers for ONE settlement event TILL observed (system, processor, eventId as the feed states it), with an optional reason (never asked; kept with the answer when given, at most 500 characters; who and when are always kept). The test track: not_test clears the test status of the event and of every observed event sharing one of its transaction keys (chargeId, paymentIntentId, paymentId, transferId; the answer lists them in events; a later document carrying them books them); reopen_test returns them to their flags. The override: handled_outside marks the event handled outside the import (booked by hand, or nothing to book): import_settlement and pull_settlement skip it handled_outside and the vat_return check no longer lists it missing; when the producer restates its figures after the override, the check lists it override_check until a person sets the override again; withdraw_handled takes the override back (the event is listed missing again, and a later import books it). Neither track books anything or links any entry; the latest answer per event decides. Refused: human_only for an agent seat under every dial, invalid_input naming the field, event_not_observed, override_not_active (withdraw_handled without an active override); a refusal writes nothing. Way back: the other answer of the track. Idempotent per key.",
        ctxSchema(
          {
            system: STR,
            processor: STR,
            eventId: STR,
            resolution: { type: 'string', enum: ['not_test', 'reopen_test', 'handled_outside', 'withdraw_handled'] },
            reason: STR,
            idempotencyKey: STR,
          },
          ['system', 'processor', 'eventId', 'resolution', 'idempotencyKey'],
        ),
        (ctx, input) => resolveSettlementEvent(ctx, as(input)),
      ),
      (ctx, input) => prevalidateResolveSettlementEvent(ctx, as(input)),
    ),
    // A42, the Umsatz review (owner, 13.11.2026): the period's settlement events as the import would book them
    // (the real import, rolled back), and the one answer per event, include or ignore.
    ctxAction(
      'settlement_review',
      'read',
      "The Umsatz review: ONE period of a settlement source, each event with who paid and what import_settlement will do with it, BEFORE anything is booked. The document is a file (settlement, the JSON object, or content, its text) or, without one, the source's feed fetched now (the pull's own checks and fetch; nothing is booked). It runs the real import_settlement inside a transaction that is always rolled back, so every status, total and check is what the import does (its test flags, the comparison, the overrides and ignores, the from-date, the template, a locked period, the VAT gate); nothing it wrote survives. Input: system and processor (optional when one source is saved; source_ambiguous otherwise; with no file, none named and no source saved the answer is a calm start, mode none, no rows, nothing to book), from and to (both or neither; default: the period of the setting settlement.review_period, the quarter by default, around a file's first day, or around today for the feed; a file is reviewed by the events dated in the period only). Every event the document states is a row, an event the reader refuses included (status refused, its code; an undated file event shows in every period), and check (b) fails closed on it. The answer: mode (file | feed | none), period, reviewSha256 (book a file with import_settlement and the events of the reviewed period from the same file; book the feed with pull_settlement over the same range and expectReviewSha256, which refuses review_stale when the feed answers other events or an answer or setting moved; a file the same way with import_settlement is the person's own copy), rows [{ eventId, kind, day (the first observed day), amountMinor, netMinor, vatMinor, counterparty { email (refs.counterpartyEmail; masked for an agent seat unless settlement.agent_sees_email is shown), emailMasked, name, document, chargeId }, test, included, inclusion { state ignored | included, source booked | handled_outside | override | test_default | default, reason, actor, at }, status booked (by an earlier import) | to_book | skipped | refused, reason, code, sentence, entryId, vatPostedMinor (the VAT the books carry for it through the period's end, output positive, input negative), toggleable, includeVia (inclusion: set_settlement_event_ignored; not_test: a test event is included with resolve_settlement_event not_test, for its whole transaction), derivation (null when the refs state none; else how the producer derived the event, read from its optional refs and never used to book: derivedFrom, sellerRole, vatRule, vatRatePercent, platformFee { bp, amountMinor, waived, waiverReason new_coach_window | override | unknown }, processingFeeMinor, processingFeeSource, payoutNetMinor, coachPayoutExpectedMinor, selfBill { number, amountMinor, hasVat }, coachTransferMinor, coachPayoutAdjustmentMinor, coachVatRegistered, ids { bookingId, sessionId, liveSessionId, paymentIntentId, chargeId, transferId, payoutId }, stated { ok, diffMinor } (the producer's derivationOk), till (TILL's own re-check: payoutNet - platform fee - processing fee = coach payout expected, and that against the self-bill or the transfer less its clawbacks), ok (false when either verdict is false), refsTrimmed) }], toBook, totals { turnoverNetMinor, outputVat { amountMinor, formLines }, inputVat { amountMinor, formLines }, ignored, test, notBooked: { events, vatMinor } }, checks { payouts { state ok | differs | unknown, payouts [{ eventId, day, amountMinor, basis, restMinor, testRestMinor, skippedRestMinor, openingRestMinor, unexplainedMinor }] }: each payout with an exact composition is explained by the members the books carry (a member the import left off by design, judged by its outcome in this review or, for a member of an earlier period, by the facts the import would apply to it now: a test event, a zero amount, or a kind skipped by default and by the template such as a reserve hold, is reported apart in testRestMinor and skippedRestMinor, and one before the source's from-date in openingRestMinor (the opening balance carries it), never a gap; an ignored, refused or otherwise unbooked member is a gap); a payout whose stated members leave a gap (basis partial) or that no event names (basis none) keeps the state unknown, never ok, with unexplainedMinor, and the document's warnings name the producer's stated causes; vat { state, statedMinor, bookedMinor, differing, outOfScope }: the stated VAT of the included events equals the VAT the books carry }, warnings, unreadable, sources. Needs post (it runs the import, rolled back). Refuses as the import or the pull would refuse the document (settlement_template_missing, settlement_template_incomplete, settlement_incomplete, unsupported_schema, settlement_source_missing, token_missing, feed_*). Writes nothing.",
      ctxSchema({ system: STR, processor: STR, from: STR, to: STR, settlement: { type: 'object' }, content: STR, confirmEdgeDays: { type: 'array', items: STR }, fileDays: { type: 'object' } }),
      (ctx, input) => settlementReview(ctx, as(input)),
    ),
    withPrevalidate(
      ctxAction(
        'set_settlement_event_ignored',
        'write:reversible:books',
        "The Umsatz review's ONE answer for ONE settlement event (system, processor, eventId as the feed states it; the event need not be imported yet): ignored true keeps it off the books (import_settlement and pull_settlement skip it, reason ignored; the vat_return check counts its VAT under ignored instead of listing it missing, and lists it override_check when the producer restates it later), ignored false includes it again (back to its defaults: a TEST event stays skipped under settlement.test_events skip and is included with resolve_settlement_event not_test). An optional reason (at most 500 characters, never required; who and when are always kept). The latest answer per event decides; each answer is kept (who, when, why) and writes an audit row. Books nothing. An agent proposes and a person decides: an agent seat's call becomes a Vorschlag, and an agent seat executing it is refused person_decides. Refused: event_booked (the import booked it: correct it with a reversing entry), handled_outside_active (withdraw it with resolve_settlement_event withdraw_handled), invalid_input naming the field; a refusal writes nothing. Way back: the other answer. Idempotent per key.",
        ctxSchema(
          { system: STR, processor: STR, eventId: STR, ignored: { type: 'boolean' }, reason: STR, idempotencyKey: STR },
          ['system', 'processor', 'eventId', 'ignored', 'idempotencyKey'],
        ),
        (ctx, input) => setSettlementEventIgnored(ctx, as(input)),
      ),
      (ctx, input) => prevalidateSetSettlementEventIgnored(ctx, as(input)),
    ),
    // A43 §2 (D205), the table door: a CSV or XLSX export of a turnover source to ONE till-settlement/v1 document,
    // which then goes unchanged to settlement_review and import_settlement. The mapping is saved per source.
    ctxAction(
      'settlement_from_table',
      'read',
      "Turn a CSV or XLSX export of a turnover source (a shop, a payment processor, a till) into ONE till-settlement/v1 document, writing nothing; hand the answer's settlement UNCHANGED to settlement_review and then to import_settlement (there is no other import path, so the template, the idempotency on the event id and every refusal of the import apply). Input: system and processor (the source the document names), content (the CSV text) or contentBase64 (the file bytes, CSV or XLSX; the content is sniffed, a legacy .xls or an encrypted workbook refuses xls_unsupported), sheet (a worksheet of an XLSX; another name refuses sheet_not_found with the sheets), mapping (optional). A table of more than 10'000 rows, or a workbook unpacking past 40 MB, refuses table_too_large; a damaged one table_unreadable. The mapping is the one given (mappingSource given), else the source's saved one (set_settlement_table_mapping; saved; a file whose headers differ refuses table_mapping_mismatch with missing, added and a guessedMapping to start over from, so a different report of the same source never books twice), else a named profile whose headers the file carries (profile: Stripe itemized balance change from activity, Shopify Payments payout transactions; each labelled check on your own export), else a guess from the headers (guessed, the generic profile). A mapping: columns { day, amount (the signed gross, the effect on the processor balance), id (one header, or several composed into one id in their order), kind, net, vat, vatRate, fee, counterparty, description, documentNumber, payoutId, currency } (day and amount required), kindMap { <type cell>: <kind> } (a type the map does not name becomes other, which the template leaves to a person, and is named in warnings), kindDefault { positive, negative } (without a kind column; default sale and refund), vat.mode from_template (the default: the gross split at the rate of the template's tax code for the kind on the event's day, rounded once to the Rappen, so amount = net + vat and vat_not_exact never trips; the rounding is stated in the document's warnings; a kind under an INPUT code, a fee or a payout to a seller, is split only under vat.fees from_template, default none, so no unstated input VAT is invented) | stated (the export's vat or net column) | none, fee (a non-zero fee becomes its own processing_fee event with the id <id>:fee; feeSign deducted (default: a positive fee is taken from the balance) | signed), amountSign as_stated (default) | by_kind (the sign follows the kind), dateFormat yyyy-mm-dd | dd.mm.yyyy | dd.mm.yy | dd/mm/yyyy | mm/dd/yyyy, decimalSeparator, delimiter, encoding, headerRow. A row is identified ONLY by its id: the id column, or up to five columns composed into one id (a JSON array of the parts; a day column contributes its parsed ISO day, and under idDayPrecision second (default day) also the time of day the cell carries, YYYY-MM-DDTHH:MM:SS as written with any zone suffix dropped; a workbook date-typed cell then refuses id_time_unknown). A mapping without an id refuses id_column_missing with candidates to compose and, so the mapping can be completed, the headers, preview rows and the mapping so far; a row whose id cells are all blank refuses missing_id; an id that repeats within the file refuses every such row id_not_unique. A row is refused with its row number and a code (not_a_movement, unreadable_day, unreadable_amount, unreadable_fee, unreadable_vat, currency_mismatch, rate_era_unknown), left out of the document and named in its warnings. The answer: system, processor, container (csv | xlsx), sheets, sheet, headers, rows (the first 20 { row, cells, parsed: the event it was read as { id, day, kind, amountMinor } or the refusal { code } }), typeCells (every distinct type cell, at most 200), idTextAsNumber (text id columns a workbook holds as number cells: Excel may have dropped leading zeros or shortened long ids, warned), rowCount, mappingSource, mapping, profile { id, label, docsUrl, note }, templateSaved (without a template from_template computes no VAT: save one with set_settlement_template and read again), sameAsBooked [{ eventId, row }] (events whose id is already booked with the same figures: the import answers them already_imported and books nothing again; shown, never swallowed), sameIdOtherFigures [{ eventId, row }] (the id is booked with other figures: the import refuses event_amended), feedSaved (the source also has a settlement feed: a second id space, warned); a mapping that is not the saved one (given, a profile, the guess) and derives ids otherwise than what booked for the source (the saved mapping, else the recipe each booked table event carries in refs.tableIdRecipe) refuses event_id_derivation_changed unless confirmIdChange: true (a person's: a governed seat sending it is refused person_decides); savedMapping, savedHeadersDiffer { missing, added } | null (a given mapping is always compared with the saved one's headers), idRecipeDiffers (the given mapping derives ids otherwise than the saved one), bookedEvents (what a replaced mapping could book again), settlement (the document), refusedRows [{ row, code, reason, cells }], totals { rows, events, amountMinor (every event amount of the document: the processor balance change the import then expects), feeMinor, table { events, amountMinor, feeMinor } (the same for every event the table's readable rows state, before any row or day is left out) }, warnings. D206, the whole-day mode: under the setting settlement.table_event_id column_else_day (default column), a mapping without an id and with wholeDays true (a person's confirmation that the export lists every row of each day it covers; refused day_mode_payout_mapped when payoutId is mapped) reads the table by whole days: each row is day:<ISO day>#<n>, n from a sort on parsed values only (the stated amount, the fee, the folded type cell, then the file order), a fee <id>:fee; a day with a row that cannot be read refuses its rows day_incomplete, a row whose day cannot be read refuses the whole table unreadable_day, a day of today or later day_not_over; each day is compared with what the source holds (every event the import has seen, any door): new (books whole), passed (the books hold exactly these whole-day events: handed to the import unchanged, which answers already_imported, ignored, or books a straggler), in_books (otherwise the same amounts: left out, its rows listed in sameAsBooked), differs (left out, its rows refused day_differs; book the difference by hand). The answer adds dayMode, days [{ day, status new | passed | in_books | differs | incomplete | edge_excluded | edge_unconfirmed | not_over, edge first | last | both | null, rows, file { events, amountMinor }, books { events, amountMinor } | null }] and edgeDays { mode, first, last, confirmed } (the first and last day the import treats as possibly cut, kept in the document: under settlement.table_edge_days ask the import books them only when its own confirmEdgeDays names them; confirmEdgeDays here only previews that answer). In the id mode, a day the source holds by whole-day ids stays gated the same way. An id-less refusal carries dayModeAvailable.",
      ctxSchema({ system: STR, processor: STR, content: STR, contentBase64: STR, sheet: STR, mapping: TABLE_MAPPING, confirmIdChange: { type: 'boolean' }, confirmEdgeDays: { type: 'array', items: STR } }, ['system', 'processor']),
      (ctx, input) => settlementFromTable(ctx, as(input)),
    ),
    withPrevalidate(
      ctxAction(
        'set_settlement_table_mapping',
        'write:reversible:books',
        "Save the column mapping a CSV or XLSX export of ONE settlement source (system and processor, matched trimmed and case-insensitively) is read by in settlement_from_table: mapping (the shape settlement_from_table describes: columns, kindMap, kindDefault, vat.mode, fee and amount signs, the reader options) and headers (the table's headers it was made for; every mapped column must be one of them, and a later file with other headers refuses table_mapping_mismatch), or instead profile, a till-import-profile/v1 file of kind settlement_table (as get_settlement_table_mapping exports it). A mapping without an id refuses id_column_missing (with candidates and dayModeAvailable), unless settlement.table_event_id is column_else_day and the mapping says wholeDays: true (the whole-day mode, D206; never with payoutId mapped: day_mode_payout_mapped); turning wholeDays on is a person's confirmation, audited confirm_whole_days, and a governed seat executing it is refused person_decides. While events are booked for the source, a save that changes the id recipe (the scheme, the id columns and which of them is the day) or the header set refuses event_id_derivation_changed (changed, bookedEvents): the new mapping would mint other ids for the same rows and a later export would book them again; confirmIdChange: true saves it anyway, recorded in the change row and as its own audit row (reason optional); a first save with no mapping saved is checked against the recipe the booked table events carry. Confirming is a person's act: an agent seat's call is drafted as a Vorschlag, and a governed seat executing a confirmed id change is refused person_decides. Saving replaces the mapping; a save of the mapping in force is a no-op (changed: false). Every change is kept with the old and new mapping, who and when, and an audit row. Books nothing: what it decides is how later tables become events, which import_settlement then books. Refuses invalid_input naming the field, unsupported_schema for another profile format. Idempotent per key.",
        ctxSchema(
          { system: STR, processor: STR, mapping: TABLE_MAPPING, headers: { type: 'array', items: STR }, profile: { type: 'object' }, confirmIdChange: { type: 'boolean' }, reason: STR, idempotencyKey: STR },
          ['system', 'processor', 'idempotencyKey'],
        ),
        (ctx, input) => setSettlementTableMapping(ctx, as(input)),
      ),
      (ctx, input) => prevalidateSetSettlementTableMapping(ctx, as(input)),
    ),
    ctxAction(
      'get_settlement_table_mapping',
      'read',
      'The saved table mapping of one settlement source (system and processor), or of every source when neither is given: mappings [{ mappingId, system, processor, mapping, headers, profile (the mapping as a till-import-profile/v1 file of kind settlement_table, to export and import with set_settlement_table_mapping profile), updatedBy, updatedAt }], and profiles (the built-in ones: the generic guess, and each named profile with its id, label, docsUrl, note and the headers it matches). An unknown source answers an empty list. Writes nothing.',
      ctxSchema({ system: STR, processor: STR }),
      (ctx, input) => getSettlementTableMapping(ctx, as(input)),
    ),
    // D203, the Umsatz page's figures from the books (never a payout, never the feed) and the periods' state.
    ctxAction(
      'turnover_summary',
      'read',
      `Der Umsatz aus dem Buch (turnover from the books, D203) for a window from..to (YYYY-MM-DD, at most ${TURNOVER_MAX_DAYS} days): sums over POSTED journal entries dated in it, the year-end close excluded like the Erfolgsrechnung (income_statement), so turnoverNetMinor equals the Erfolgsrechnung's 3xxx lines to the Rappen. It never reads a processor payout as turnover and never reads the settlement feed: an event counts once import_settlement booked it (settlement_review shows what is still to book). Input: from, to, compare (${TURNOVER_COMPARE.join(' | ')}, default previous_period: the same length right before, by whole months when the window is whole months; previous_year: the same dates a year earlier), top (0..${TURNOVER_TOP_MAX} customers named, default 10). The answer: period, vatMethod (effektiv | saldo | pauschal | none, the workspace's method now), compare { mode, from, to } or null, totals and previous (the compare window, or null) each { turnoverNetMinor (credit minus debit on the Erfolgsrechnung's Nettoerlöse accounts, 30xx to 38xx of type income or expense), settlementTurnoverMinor (the part the settlement sources carry, at most the turnover), outputVat { amountMinor (2200 ONLY in the entries import_settlement booked for a sale or refund event, and their reversal chains, never an invoice, a manual entry or the MWST-Saldierung), formLines (the ESTV Ziffern of those revenue lines' tax codes, e.g. 303) }, feeInputVat { amountMinor (1170 and 1171 in the processing_fee and service_fee events' entries and their reversals), formLines (e.g. 405) } or null under saldo or pauschal (no input VAT is deducted), sales { count (settlement sale events whose posted entry is dated in the window, carries a positive revenue net and stands through the window end by its reversal chain; invoices and manual entries are turnover but no settlement sale), netMinor, averageMinor }, reductionsMinor (refunds, credit notes, reversals), payouts { count, amountMinor (what left the saved templates' clearing accounts to the bank, never turnover) }, entries }, byMonth [{ month, turnoverNetMinor, bySource }], bySource [{ key (settlement:<system>:<processor> | invoices | other), kind, system, processor, turnoverNetMinor, salesCount }] (sums to the total), byCustomer { top [{ key, name, email, masked, turnoverNetMinor, salesCount }], rest { customers, turnoverNetMinor } } (a settlement payer masked for an agent seat unless settlement.agent_sees_email is shown), accounts { revenue, outputVat, inputVat, clearing }. Writes nothing.`,
      ctxSchema({ from: STR, to: STR, compare: { type: 'string', enum: [...TURNOVER_COMPARE] }, top: { type: 'integer' } }, ['from', 'to']),
      (ctx, input) => turnoverSummary(ctx, as(input)),
    ),
    ctxAction(
      'settlement_periods',
      'read',
      "Which settlement periods are booked, open or empty, for the Umsatz period control (D203): periods of unit (quarter | month | year, default the setting settlement.review_period) around a day (around, default today in Zurich), before (0..36, default 8) and after (0..12, default 4) the one around it, each { from, to, state (to_book: an observed event waits, never booked and its latest import outcome refused or left to a person, without an active ignore or handled-outside answer; booked: events booked or observed and nothing waits; empty: nothing observed), booked, waiting, observed }. It reads what an import or a pull recorded (a period nobody pulled yet is empty; settlement_review fetches it). Writes nothing.",
      ctxSchema({ unit: { type: 'string', enum: ['quarter', 'month', 'year'] }, around: STR, before: { type: 'integer' }, after: { type: 'integer' } }),
      (ctx, input) => settlementPeriods(ctx, as(input)),
    ),
  ];
}
