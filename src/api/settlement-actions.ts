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
} from '../core/settlement/index.js';
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

  return [
    withPrevalidate(
      ctxAction(
        'import_settlement',
        'write:correctable:books',
        "Book a till-settlement/v1 file: the money that moved through a payment processor's or a marketplace's balance (sales, refunds, fees, payouts to third parties and their reversals, reserves, bank payouts), event by event, through the owner's booking template for the file's source (set_settlement_template; the file's own clearingAccount and vat.code are labels TILL never books by). Send the file as settlement (the JSON object) or content (its text, at most 10 MB). Each event of a kind the template books becomes ONE balanced entry dated its day, source import: the clearing account carries amount (positive = Soll), the template's contra account carries -net with the template's tax code, and the VAT account (2200 for an output code, 1170/1171 for input) carries -vat.amount, so the MWST-Abrechnung shows the file's exact VAT and base. The stated VAT must be what the code gives on the net or on the gross (one round, to the Rappen), else that event refuses vat_not_exact; VAT on a kind booked without a tax code refuses vat_unmapped. An event with vat null under an INPUT code books its gross as the net with no VAT line (the file states zero input VAT, for example a payout to a seller who is not VAT-registered); under an output code it still refuses vat_not_exact. The entry text is the description and the counterparty; the document number is the entry's ref; the external refs are kept with the event. Idempotent on the external id (workspace + source.system + source.processor + event id): an event booked before is already_imported and books nothing (when a PDF for it then fails to link, the outcome carries code attachment_failed and the cause, and the entry stays as it is); the same id with other kind, day, currency, amount, net or VAT refuses event_amended naming each change, and the posted entry is never edited (correct it with reverse_entry). An event into a locked or closed period refuses period_locked on its own; a malformed event refuses on its own (missing_id, duplicate_id, invalid_day, currency_mismatch, unknown_kind, invalid_amount for more than two decimals or a float spelling, amount_mismatch when amount is not net + vat.amount); every other event still books. The whole call refuses, writing nothing, on a schema other than till-settlement/v1 (unsupported_schema), no template for the source (settlement_template_missing), a kind in the file the template does not map (settlement_template_incomplete, naming the kinds), or a template whose accounts or codes no longer pass (settlement_template_invalid). attachments [{ fileName, contentBase64, documentNumber }] (PDFs, at most 200 and 25 MB together) are linked as Belege to every entry whose event carries that document.number (needs manage_files); unmatchedAttachments names the rest. The answer: events[] (booked with entryId | already_imported with entryId | skipped with reason template_skip, needs_attention or zero_amount | refused with code and sentence), the counts, needsAttention (event ids of kinds the template leaves to a person), totals per kind, the file's warnings, and reconciliation { expectedClearingChangeMinor: every event amount in the file, payouts included (the processor balance change), bookedClearingChangeMinor: what the entries of the file's own events put on the clearing account, booked by this call or an earlier one, net of reversing entries, differenceMinor (booked - expected), bankPayoutsMinor: the file's payouts with no entry, notBookedByImportMinor: every other event with no entry (an event booked earlier never counts here, even after its kind is switched to skip), unexplainedMinor: booked + payouts + not booked - expected, 0 when every Rappen is accounted for (else an amended event, a reversal or a changed clearing account) }: once the bank payout lines are booked (a one-leg Buchungsregel bank to clearing account), the residual on the clearing account is the reserve the processor holds. Each call needs an idempotencyKey; a replay returns the first report.",
        ctxSchema(
          {
            settlement: { type: 'object' },
            content: STR,
            attachments: { type: 'array', items: ATTACHMENT },
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
        "Save the booking template of ONE settlement source (system and processor, as a till-settlement/v1 file names them in source; matched trimmed and case-insensitively): clearingAccountId, the Durchlaufkonto the processor balance is booked on (an asset or liability account, id or number), and kinds { <kind>: { action: book, accountId, taxCode (an output, input, zero-rated or exempt code, or null for no VAT) } | { action: skip } | { action: attention } } for the kinds sale, refund, processing_fee, service_fee, third_party_payout, third_party_payout_reversal, reserve, bank_payout, bank_payout_summary, other. A kind not named takes its default: bank_payout and bank_payout_summary skip (the bank import books the payout, bank account against the clearing account), reserve skips (the money stays on the clearing account), other is attention (not booked, named for a person); every other kind stays unmapped, and import_settlement refuses a file that carries an unmapped kind. Saving replaces the template; a save of the template in force is a no-op (changed: false). Every change is kept with the old and new template, who and when. Refuses invalid_account, account_archived, unknown_tax_code, archived_tax_code or tax_code_unsupported naming the field. Books nothing. Idempotent per key.",
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
  ];
}
