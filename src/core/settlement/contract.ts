/**
 * A43 section 5, THE CONTRACT PUBLISHED: the `till-settlement/v1` JSON Schema (draft 2020-12), built from
 * the constants of `format.ts` so the schema and the reader cannot drift apart silently.
 * `scripts/generate-schemas.mjs` writes it to `schemas/till-settlement-v1.schema.json`; a drift test holds
 * the committed file equal to this function's output; a parity test runs one fixture corpus through both
 * this schema and `readSettlementDocument`.
 *
 * A schema says whether a DOCUMENT is acceptable as a whole: valid means the reader would take the file
 * and refuse no event, up to the checks that JSON Schema cannot state and that stay the reader's alone
 * (`SETTLEMENT_READER_ONLY_CHECKS`). The schema compiles in ajv strict mode and uses no `format` and no
 * `multipleOf` (annotation-only and float-division, respectively), so every validator agrees on it.
 */

import {
  SETTLEMENT_ID_MAX,
  SETTLEMENT_KINDS,
  SETTLEMENT_MAX_EVENTS,
  SETTLEMENT_SCHEMA,
  SETTLEMENT_SOURCE_MAX,
  SETTLEMENT_EVENT_REFUSALS,
} from './format.js';

/**
 * The reader's checks a JSON Schema cannot state: id, the refusal code the reader gives, and why.
 * A document can validate against the schema and still be refused for one of these.
 */
export const SETTLEMENT_READER_ONLY_CHECKS: Readonly<Record<string, { code: string; why: string }>> = {
  currency_mismatch: { code: 'currency_mismatch', why: SETTLEMENT_EVENT_REFUSALS['currency_mismatch'] as string },
  duplicate_id: { code: 'duplicate_id', why: SETTLEMENT_EVENT_REFUSALS['duplicate_id'] as string },
  amount_mismatch: { code: 'amount_mismatch', why: SETTLEMENT_EVENT_REFUSALS['amount_mismatch'] as string },
  calendar_date: { code: 'invalid_day', why: 'day must be a real calendar date, so 2026-02-30 is refused though it has the right form' },
  number_decimals: { code: 'invalid_amount', why: 'an amount written as a JSON number must be an exact decimal with at most two places (10.815 and 1e-3 are refused); write amounts as decimal strings to have the schema check it' },
  text_length: { code: 'missing_id', why: 'the length limits count UTF-16 code units, the schema counts characters, so a name or id with characters outside the basic plane can pass the schema and be refused' },
};

/** The id of the published schema. */
export const SETTLEMENT_SCHEMA_ID = 'https://tillbooks.ch/schemas/till-settlement-v1.schema.json';

const MAX_AMOUNT = 9_999_999_999_999.99;
const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const amount = (description: string): Record<string, unknown> => ({
  description,
  anyOf: [
    { type: 'string', pattern: '^-?\\d{1,13}(\\.\\d{1,2})?$' },
    { type: 'number', minimum: -MAX_AMOUNT, maximum: MAX_AMOUNT },
  ],
});

/** The `till-settlement/v1` JSON Schema, as a plain object. */
export function buildSettlementJsonSchema(): Record<string, unknown> {
  const name = (description: string): Record<string, unknown> => ({ type: 'string', description, pattern: '\\S', maxLength: SETTLEMENT_SOURCE_MAX });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SETTLEMENT_SCHEMA_ID,
    title: SETTLEMENT_SCHEMA,
    description:
      'What a payment processor, a marketplace or any system that holds a balance for a company hands TILL about the money that moved through it. ' +
      'A document that validates here can still be refused by the reader for these checks, which JSON Schema cannot state: ' +
      Object.entries(SETTLEMENT_READER_ONLY_CHECKS)
        .map(([id, c]) => `${id} (${c.why})`)
        .join('; ') +
      '. Unknown extra fields are ignored at every level. Version policy: within v1 only optional fields and new kinds are added; a change to what amount, net, VAT or the sign mean, or to a required field, is v2.',
    type: 'object',
    required: ['schema', 'source', 'events'],
    properties: {
      schema: { const: SETTLEMENT_SCHEMA },
      source: {
        type: 'object',
        description: 'Who produced the document. The pair system and processor is the key TILL keeps the booking template and the idempotency by.',
        required: ['system', 'processor'],
        properties: {
          system: name('The platform or system that emits the document.'),
          processor: name('The processor or balance the events moved through.'),
          entity: { type: 'string', description: 'The company the document is about.' },
        },
      },
      generatedAt: { type: 'string', description: 'When the producer made the document (an ISO instant).' },
      period: {
        type: 'object',
        description: 'The days the document covers.',
        properties: { from: { type: 'string', pattern: DAY_PATTERN }, to: { type: 'string', pattern: DAY_PATTERN } },
      },
      currency: { type: 'string', description: 'The currency of the document.' },
      clearingAccount: { type: 'string', description: "The producer's label for the clearing account. TILL never books by it." },
      signConvention: { type: 'string', description: 'A sentence saying how the sign of amount reads.' },
      warnings: { type: 'array', items: { type: 'string' }, description: 'What the producer could not state exactly.' },
      events: { type: 'array', maxItems: SETTLEMENT_MAX_EVENTS, items: { $ref: '#/$defs/event' } },
    },
    $defs: {
      event: {
        type: 'object',
        description: 'One movement on the processor balance.',
        required: ['id', 'kind', 'day', 'currency', 'amount', 'net'],
        properties: {
          id: { type: 'string', description: 'Stable and unique per event within the source: a re-import books nothing twice.', pattern: '\\S', maxLength: SETTLEMENT_ID_MAX },
          kind: { enum: [...SETTLEMENT_KINDS], description: 'What the movement is. An older reader refuses an unknown kind per event.' },
          day: { type: 'string', pattern: DAY_PATTERN, description: 'The booking day, YYYY-MM-DD, in the company time zone, a real calendar date.' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Must be the currency of the TILL workspace.' },
          amount: amount('The signed effect on the processor balance, gross including VAT; positive means into the balance. At most two decimals.'),
          net: amount('The part of amount that is not VAT, signed like amount.'),
          vat: {
            description: 'The VAT in amount, or null when the event carries none.',
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['amount'],
                properties: {
                  amount: amount('The VAT part of amount, signed like amount.'),
                  code: { type: 'string', description: "The producer's label. TILL books by the owner's template, never by this." },
                  rate: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'The rate in percent, for the record.' },
                },
              },
            ],
          },
          document: {
            description: 'The document the event belongs to, by which a PDF is linked as a Beleg.',
            anyOf: [{ type: 'null' }, { type: 'object', properties: { type: { type: 'string' }, number: { type: 'string' } } }],
          },
          counterparty: { type: 'string' },
          description: { type: 'string' },
          refs: { type: 'object', description: 'External references (charge, payout, order ids), kept with the event.' },
          date: { type: 'string', description: 'The ISO instant of the event.' },
          month: { type: 'string' },
        },
      },
    },
  };
}

/** The schema as the committed file holds it (two-space JSON, a final newline). */
export function settlementJsonSchemaText(): string {
  return `${JSON.stringify(buildSettlementJsonSchema(), null, 2)}\n`;
}
