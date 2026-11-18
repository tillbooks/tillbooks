/**
 * A43 section 5, the settlement contract's agent door: `validate_settlement`. Defined here and spread into
 * `ACTIONS` as ONE line (the `settlementActions` precedent). It runs the same reader `import_settlement`
 * runs (`readSettlementDocument`) and writes NOTHING: an agent that built a document from any source
 * checks it here before `settlement_review` and `import_settlement`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { ActionKind } from './actionKind.js';
import { readSettlementDocument, SETTLEMENT_SCHEMA } from '../core/settlement/format.js';
import { SETTLEMENT_MAX_BYTES } from '../core/settlement/importSettlement.js';
import { SETTLEMENT_READER_ONLY_CHECKS } from '../core/settlement/contract.js';
import { baseCurrencyOf } from '../core/fx/rates.js';

export interface SettlementFormatActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The most refused events an answer lists (the count is always complete). */
export const VALIDATE_REFUSED_LISTED = 200;

/** The document from the call: `settlement` (the object) or `content` (its JSON text), exactly one. */
function documentOf(input: ActionInput): { doc: unknown } | { error: Result } {
  const hasObject = input['settlement'] !== undefined && input['settlement'] !== null;
  const hasText = typeof input['content'] === 'string' && input['content'].length > 0;
  if (hasObject === hasText) return { error: err('invalid_input', { field: 'settlement', reason: 'exactly one of settlement (the JSON object) or content (its text)' }) };
  if (hasObject) return { doc: input['settlement'] };
  const text = (input['content'] as string).replace(/^﻿/, '');
  if (Buffer.byteLength(text, 'utf8') > SETTLEMENT_MAX_BYTES) return { error: err('invalid_input', { field: 'content', reason: `at most ${SETTLEMENT_MAX_BYTES} bytes` }) };
  try {
    return { doc: JSON.parse(text) as unknown };
  } catch {
    return { error: err('invalid_settlement', { field: 'content', reason: 'the content is not JSON' }) };
  }
}

/**
 * The reader's answer for one parsed document, in the shape `validate_settlement` returns. Shared by the verb
 * and by `till settlement validate <file>`, which has no book and takes the currency from its flag.
 */
export function checkSettlementDocument(doc: unknown, currency: string): Result {
  const read = readSettlementDocument(doc, currency);
  if (!read.ok) return err(read.error, { ...(read.field !== undefined ? { field: read.field } : {}), reason: read.reason });
  const d = read.document;
  const byKind: Record<string, { count: number; amountMinor: number }> = {};
  let first: string | null = null;
  let last: string | null = null;
  for (const e of d.events) {
    const k = (byKind[e.kind] ??= { count: 0, amountMinor: 0 });
    k.count += 1;
    k.amountMinor += e.amountMinor;
    if (first === null || e.day < first) first = e.day;
    if (last === null || e.day > last) last = e.day;
  }
  return ok({
    valid: d.refused.length === 0,
    schema: SETTLEMENT_SCHEMA,
    system: d.system,
    processor: d.processor,
    entity: d.entity,
    currency,
    warnings: d.warnings.slice(0, VALIDATE_REFUSED_LISTED),
    warningsTruncated: d.warnings.length > VALIDATE_REFUSED_LISTED,
    events: { total: d.events.length + d.refused.length, readable: d.events.length, refused: d.refused.length, firstDay: first, lastDay: last, byKind },
    refused: d.refused.slice(0, VALIDATE_REFUSED_LISTED),
    refusedTruncated: d.refused.length > VALIDATE_REFUSED_LISTED,
    note: d.refused.length === 0 ? 'every event reads; settlement_review shows what the import would book' : 'fix the refused events at the producer and validate again; the others would still import',
  });
}

export function validateSettlement(ctx: WorkspaceContext, input: ActionInput): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const given = documentOf(input);
  if ('error' in given) return given.error;
  return checkSettlementDocument(given.doc, baseCurrencyOf(ctx));
}

/** The CLI's door: a file's text, BOM stripped, size-capped, parsed; the same answer as the verb. */
export function checkSettlementText(text: string, currency: string): Result {
  const body = text.replace(/^\uFEFF/, '');
  if (Buffer.byteLength(body, 'utf8') > SETTLEMENT_MAX_BYTES) return err('invalid_input', { field: 'file', reason: `at most ${SETTLEMENT_MAX_BYTES} bytes` });
  let doc: unknown;
  try {
    doc = JSON.parse(body) as unknown;
  } catch {
    return err('invalid_settlement', { field: 'file', reason: 'the file is not JSON' });
  }
  return checkSettlementDocument(doc, currency);
}

export function settlementFormatActions(h: SettlementFormatActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'validate_settlement',
      'read',
      `Check a till-settlement/v1 document with the reader import_settlement uses, and WRITE NOTHING. Send it as settlement (the JSON object) or content (its text, at most 10 MB). The whole call refuses with the reader's code (invalid_settlement, unsupported_schema, naming the field) when the file as a whole is unusable; otherwise it answers { valid (no event refused), system, processor, entity, currency (the workspace's: every event must carry it), warnings, events { total, readable, refused, firstDay, lastDay, byKind { <kind>: { count, amountMinor } } }, refused [{ index, id, kind, code, reason, amountMinor, day }] (the first ${VALIDATE_REFUSED_LISTED}), refusedTruncated, warningsTruncated (warnings are listed up to ${VALIDATE_REFUSED_LISTED} too) }. Per-event refusal codes: missing_id, duplicate_id, invalid_day, currency_mismatch, unknown_kind, invalid_amount, amount_mismatch, invalid_event. The JSON Schema (till settlement schema, or the MCP resource till://formats/till-settlement-v1) states everything but ${Object.keys(SETTLEMENT_READER_ONLY_CHECKS).join(', ')}, which only this check sees. Next: settlement_review, then import_settlement.`,
      ctxSchema({ settlement: { type: 'object' }, content: STR }),
      (ctx, input) => validateSettlement(ctx, input),
    ),
  ];
}
