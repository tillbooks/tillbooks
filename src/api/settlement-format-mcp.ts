/**
 * A43 section 5, the settlement contract on the MCP surface: the prompt `settlement_from_source` and the
 * resource `till://formats/till-settlement-v1`. Pure text and data: `mcp.ts` lists and serves them beside
 * the checklist prompts and the workspace brief, and every verb the prompt names runs through the
 * governed dispatch like any tool call (so an agent's import becomes a Vorschlag under A35).
 */

import { settlementJsonSchemaText } from '../core/settlement/contract.js';

/** The MCP resource that serves the published JSON Schema. */
export const SETTLEMENT_FORMAT_RESOURCE_URI = 'till://formats/till-settlement-v1';

/** The resource as `resources/list` shows it. */
export const SETTLEMENT_FORMAT_RESOURCE = {
  uri: SETTLEMENT_FORMAT_RESOURCE_URI,
  name: 'till-settlement/v1 JSON Schema',
  description:
    'The contract every turnover source reaches TILL by: a document of the money that moved through a payment processor, a marketplace or any balance. Read it before you build a document from a source.',
  mimeType: 'application/schema+json',
} as const;

/** `resources/read` of the schema resource. */
export function readSettlementFormatResource(): { uri: string; mimeType: string; text: string } {
  return { uri: SETTLEMENT_FORMAT_RESOURCE_URI, mimeType: SETTLEMENT_FORMAT_RESOURCE.mimeType, text: settlementJsonSchemaText() };
}

export const SETTLEMENT_FROM_SOURCE_PROMPT = 'settlement_from_source';

/** The prompt as `prompts/list` shows it. */
export const SETTLEMENT_FROM_SOURCE_PROMPT_DEF = {
  name: SETTLEMENT_FROM_SOURCE_PROMPT,
  description:
    "Bring the turnover of ANY source (Stripe's or Shopify's MCP, a POS, a platform API) into TILL: build a till-settlement/v1 document, validate it, review it, import it as a Vorschlag.",
  arguments: [
    { name: 'workspaceId', description: 'The workspace to book into.', required: true },
    { name: 'system', description: 'The platform the money came through, for example the shop name. Use the same name every time: it keys the booking template and the idempotency.', required: true },
    { name: 'processor', description: 'The processor or balance, for example the payment provider. Same name every time.', required: true },
    { name: 'from', description: 'First day, YYYY-MM-DD.', required: false },
    { name: 'to', description: 'Last day, YYYY-MM-DD.', required: false },
  ],
} as const;

/** The prompt's text: the whole walk, as one message. A missing workspaceId THROWS (protocol misuse, as for the checklist prompts). */
export function renderSettlementFromSourcePrompt(args: Record<string, unknown>): { description: string; text: string } {
  const str = (k: string): string => (typeof args[k] === 'string' && (args[k] as string).trim().length > 0 ? (args[k] as string).trim() : '');
  const workspaceId = str('workspaceId');
  if (workspaceId === '') throw new Error('invalid_input: workspaceId is required');
  const system = str('system') || '<system>';
  const processor = str('processor') || '<processor>';
  const range = str('from') !== '' || str('to') !== '' ? `${str('from') || 'the first day'} to ${str('to') || 'the last day'}` : 'the period the person named';
  const text = [
    `Bring the turnover of ${system} / ${processor} for ${range} into TILL workspace ${workspaceId}. TILL reads one contract, till-settlement/v1, whatever the source is.`,
    '',
    `1. Read the contract: the MCP resource ${SETTLEMENT_FORMAT_RESOURCE_URI} (a JSON Schema; "till settlement schema" prints the same text). The kinds are sale, refund, processing_fee, service_fee, third_party_payout, third_party_payout_reversal, reserve, bank_payout, bank_payout_summary and other.`,
    "2. Fetch the movements with the source's own tools (its MCP server or API), read only. Never put a credential or a token into the document.",
    '3. Build the document: { schema: "till-settlement/v1", source: { system, processor }, events: [...] }, one event per movement on the processor balance:',
    "   - id: the source's own stable id, unique in the file. Never invent one: a re-run must give the same ids, or TILL books twice.",
    "   - day: the booking day, YYYY-MM-DD, in the company's time zone.",
    '   - amount: the signed effect on the balance, gross including VAT; positive means into the balance (a sale), negative out of it (a refund, a fee, a payout). net and vat.amount are signed the same way, and amount must be net plus vat.amount to the Rappen.',
    "   - Money is an exact decimal with at most two places (\"108.10\"). Never compute it with floats: take the source's own amounts, and convert minor units by moving the decimal point.",
    '   - currency is the workspace currency. vat is null when the source states none: do not work VAT out yourself.',
    `   - source.system "${system}" and source.processor "${processor}", the same every time.`,
    '4. Call validate_settlement { workspaceId, settlement }. It writes nothing. A refused event names its code and reason: fix it at the source or leave it out and say so. Never edit an amount to make it pass.',
    `5. Call get_settlement_template { workspaceId, system: "${system}", processor: "${processor}" }. When there is no template, stop and tell the person: they choose the accounts (set_settlement_template). You do not guess accounts or tax codes.`,
    `6. Call settlement_review { workspaceId, system: "${system}", processor: "${processor}", settlement }. Show the person what it would book and keep its reviewSha256.`,
    '7. Call import_settlement { workspaceId, settlement, expectReviewSha256: <that reviewSha256>, idempotencyKey }. As an agent this becomes a Vorschlag: the person approves it in the Studio (Agent, Vorschläge), and nothing is booked before. A refusal review_stale means the document or the books changed: review again.',
    '',
    'Importing the same events again books nothing twice. If the source changes the money of an event it already gave, TILL refuses it as event_amended: correct that with a reversal, never by sending the file again.',
  ].join('\n');
  return { description: `Turnover of ${system} / ${processor} into TILL, through till-settlement/v1.`, text };
}
