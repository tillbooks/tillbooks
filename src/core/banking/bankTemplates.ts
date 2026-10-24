/**
 * D176 (A39 §15.2), the Buchungssatz composer's VORLAGE input: `compose_entry` and `post_entry` accept
 * `template { standardId, asks }` beside the free lines. The engine expands it (`expandTemplate`) into the
 * composer's intent lines and from there on behaves EXACTLY as for typed lines: the same VAT expansion, the
 * same gate, the same refusals (`expandEntry`, then `postEntry`).
 *
 * A Vorlage is a Buchungsregel of scope `manual` (`bankStandards.ts`): every leg states its side, one leg is
 * the REST, an asked leg takes the amount the person types (a gross on a taxed leg, A1's composer reads every
 * amount as gross), and a `same` leg takes the amount of the asked leg it names. The rest leg carries what
 * balances the entry: the other legs' expansions are summed (`intentLineEffect`, VAT legs included) and the
 * rest takes the difference on its stated side. A rest that would be 0 refuses `rest_is_zero`; one that would
 * land on the other side refuses `rest_changes_side` (a Vorlage never flips a leg the person set).
 *
 * Refusals: `rule_not_found` (another workspace's id, a superseded or cleared one: §H-TENANT), `rule_invalid`
 * (an account or code it names is no longer valid, critic D176-C1), `wrong_scope`
 * (a bank rule used as a template), `ask_missing` (an asked leg without a positive amount), `rest_is_zero`,
 * `rest_changes_side`, and `invalid_input` for a malformed template or an ask keyed to a leg that is not
 * asked. `compose_entry` answers them as its VERDICT (the read succeeds); `post_entry` answers them as its
 * refusal and writes nothing.
 *
 * A Vorlage never names a bank ledger account (the recipe check refuses one), so a template never books a
 * bank line's money: that stays the bank inbox's job (D139).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireDate, requireString } from '../ledger/inputGuards.js';
import { expandEntry, intentLineEffect } from '../ledger/compose.js';
import type { ComposeExpandOk, IntentLine } from '../ledger/compose.js';
import { postEntry } from '../ledger/postEntry.js';
import type { PostEntryInput, PostEntryOk } from '../ledger/postEntry.js';
import { readLiveRule, recipeOfRow, restLegIndex, ruleInvalidReason } from './bankStandards.js';
import type { RecipeLeg, RecipeSide } from './bankStandards.js';

/** A template as the composer and `post_entry` take it: the Vorlage and its asked amounts by leg index. */
export interface TemplateInput {
  standardId: string;
  /** Integer Rappen, positive, keyed by the index of the ASKED leg in the recipe. */
  asks: Record<string, number>;
}

/** One recipe leg as the template booked it: its side and the amount it carries (a gross on a taxed leg). */
export type TemplateLegAmount = { legIndex: number; side: RecipeSide; amount: number };

/** What a template expanded to: the Vorlage, its name, and every leg's amount (the rest included). */
export type ExpandedTemplate = { standardId: string; label: string; amounts: TemplateLegAmount[] };

/** The template's SHAPE (no database read), or the `invalid_input` naming the field. */
export function parseTemplate(raw: unknown): { template: TemplateInput } | { error: Err } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: err('invalid_input', { field: 'template', reason: 'an object { standardId, asks }' }) };
  const t = raw as Record<string, unknown>;
  const g = requireString(t['standardId'], 'template.standardId');
  if (g) return { error: g };
  const asksRaw = t['asks'] ?? {};
  if (typeof asksRaw !== 'object' || asksRaw === null || Array.isArray(asksRaw)) {
    return { error: err('invalid_input', { field: 'template.asks', reason: 'an object of amounts in Rappen keyed by the leg index' }) };
  }
  const asks: Record<string, number> = {};
  for (const [k, v] of Object.entries(asksRaw as Record<string, unknown>)) {
    if (!/^(0|[1-9]\d*)$/.test(k)) return { error: err('invalid_input', { field: `template.asks.${k}`, reason: 'a key is a leg index' }) };
    if (v === null || v === undefined) continue;
    if (!Number.isSafeInteger(v)) return { error: err('invalid_input', { field: `template.asks.${k}`, reason: 'an amount in Rappen' }) };
    asks[k] = v as number;
  }
  return { template: { standardId: t['standardId'] as string, asks } };
}

/**
 * A Vorlage as the composer's intent lines for an entry on `date`, in the recipe's order. Reads only. The
 * refusal is an `Err` with the stable code (see the module comment).
 */
export function expandTemplate(
  ctx: WorkspaceContext,
  date: string,
  template: TemplateInput,
): { ok: true; lines: IntentLine[]; expanded: ExpandedTemplate } | { ok: false; error: Err } {
  const refuse = (error: Err) => ({ ok: false as const, error });
  const rule = readLiveRule(ctx, template.standardId);
  if (rule === undefined) return refuse(err('rule_not_found', { standardId: template.standardId, reason: 'no live Vorlage of this workspace has this id' }));
  if (rule.scope !== 'manual') {
    return refuse(err('wrong_scope', { standardId: rule.id, scope: rule.scope, reason: 'a bank rule books a bank line (book_bank_line with target {kind: rule}), never the composer' }));
  }
  // Critic D176-C1: a Vorlage is checked when it BOOKS, not only when it was saved. An account it names may
  // since have been archived or become a Bankkonto's ledger (a Vorlage never books the bank, D139), or a
  // code may be gone: it is refused with the reason `list_bank_standards` already reports.
  const invalid = ruleInvalidReason(ctx, rule);
  if (invalid !== null) {
    return refuse(err('rule_invalid', { standardId: rule.id, invalidReason: invalid, reason: 'an account or a code this Vorlage names is no longer valid; edit the Vorlage' }));
  }
  const legs = recipeOfRow(rule);
  if (legs === null || legs.length === 0) return refuse(err('rule_not_found', { standardId: rule.id, reason: 'recipe_unreadable' }));
  // D177 (A39 §16.1): a Vorlage never holds a computed amount (there is no line to compute from; the recipe
  // check refuses one, and a stored one reads as unreadable above). Belt to those braces.
  if (legs.some((l) => l.amount.kind === 'factor')) return refuse(err('rule_not_found', { standardId: rule.id, reason: 'recipe_unreadable' }));
  for (const k of Object.keys(template.asks)) {
    if (legs[Number(k)]?.amount.kind !== 'ask') return refuse(err('invalid_input', { field: `template.asks.${k}`, reason: 'this leg of the Vorlage is not asked' }));
  }
  const restAt = restLegIndex(legs);
  const amounts: (number | null)[] = legs.map(() => null);
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] as RecipeLeg;
    if (leg.amount.kind === 'rest') continue;
    const askedAt = leg.amount.kind === 'same' ? leg.amount.legIndex : i;
    const asked = (legs[askedAt] as RecipeLeg).amount;
    const given = template.asks[String(askedAt)];
    if (given === undefined || given <= 0) {
      return refuse(err('ask_missing', { standardId: rule.id, legIndex: askedAt, label: asked.kind === 'ask' ? asked.label : '' }));
    }
    amounts[i] = given;
  }
  const intentOf = (leg: RecipeLeg, side: RecipeSide, amount: number): IntentLine => ({
    account: leg.accountId,
    side,
    amount,
    gross: true,
    ...(leg.taxCode !== null ? { taxCode: leg.taxCode } : {}),
  });
  // What every leg but the rest moves, VAT legs included: the rest balances it.
  let moved = 0;
  for (let i = 0; i < legs.length; i += 1) {
    if (i === restAt) continue;
    const leg = legs[i] as RecipeLeg;
    const effect = intentLineEffect(ctx, date, intentOf(leg, leg.side as RecipeSide, amounts[i] as number), i);
    if (!effect.ok) return refuse(effect.error);
    moved += effect.effect;
  }
  const rest = legs[restAt] as RecipeLeg;
  if (moved === 0) return refuse(err('rest_is_zero', { standardId: rule.id, legIndex: restAt, reason: 'the other legs balance by themselves, so nothing is left for the rest leg' }));
  const restSide: RecipeSide = moved < 0 ? 'debit' : 'credit';
  if (restSide !== rest.side) {
    return refuse(
      err('rest_changes_side', {
        standardId: rule.id,
        legIndex: restAt,
        side: rest.side as RecipeSide,
        wouldBe: restSide,
        amountMinor: Math.abs(moved),
        reason: 'the amounts would put the rest on the other side; check the amounts',
      }),
    );
  }
  amounts[restAt] = Math.abs(moved);
  const lines = legs.map((leg, i) => intentOf(leg, leg.side as RecipeSide, amounts[i] as number));
  return {
    ok: true,
    lines,
    expanded: {
      standardId: rule.id,
      label: rule.label ?? '',
      amounts: legs.map((leg, i) => ({ legIndex: i, side: leg.side as RecipeSide, amount: amounts[i] as number })),
    },
  };
}

// --- compose_entry with a template ---------------------------------------------------------------------

export interface ComposeTemplateInput {
  date?: string;
  entryId?: string;
  template?: unknown;
}

/** `compose_entry`'s answer for a template: the composer's answer and what the Vorlage expanded to. */
export type ComposeTemplateOk = ComposeExpandOk & { readonly template: ExpandedTemplate | null };

/**
 * What `post_entry { template }` would post, WITHOUT posting: the Vorlage expanded (`expandTemplate`), then
 * A02's composer (`expandEntry`) composes and judges the lines exactly as for typed ones. A template refusal
 * is the read's VERDICT; a malformed template or date is the read's own `invalid_input`. Writes nothing.
 */
export function composeTemplate(ctx: WorkspaceContext, input: ComposeTemplateInput): Result<ComposeTemplateOk> {
  const guard = requireDate(input.date, 'date');
  if (guard) return guard;
  const parsed = parseTemplate(input.template);
  if ('error' in parsed) return parsed.error;
  const expanded = expandTemplate(ctx, input.date as string, parsed.template);
  if (!expanded.ok) {
    return ok<ComposeTemplateOk>({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: expanded.error, template: null });
  }
  const composed = expandEntry(ctx, { date: input.date as string, lines: expanded.lines, ...(input.entryId !== undefined ? { entryId: input.entryId } : {}) });
  if (!composed.ok) return composed;
  return ok<ComposeTemplateOk>({ ...composed, template: expanded.expanded });
}

// --- post_entry with a template ------------------------------------------------------------------------

/** `post_entry`'s input with a template instead of lines. */
export type PostTemplateInput = Omit<PostEntryInput, 'lines'> & { template?: unknown; lines?: unknown };

/**
 * `post_entry { template }`: replay first (a retry answers the stored result even after the Vorlage changed),
 * then expand, compose, and post the composed lines verbatim through `postEntry`, under the caller's key and
 * in the `post_entry` scope, so the posting is the ordinary one in every respect. The entry's text defaults
 * to the Vorlage's name.
 */
export function postEntryFromTemplate(ctx: WorkspaceContext, input: PostTemplateInput): Result<PostEntryOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  // The template is a rule row, read under the bank inbox's read right (as `compose_entry`'s template form).
  const reads = ctx.capabilities.assert('read_sales');
  if (!reads.ok) return reads;
  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey') ?? requireDate(input.date, 'date');
  if (keyGuard) return keyGuard;
  if (input.lines !== undefined && input.lines !== null) {
    return err('invalid_input', { field: 'lines', reason: 'post either lines or a template, not both' });
  }
  const parsed = parseTemplate(input.template);
  if ('error' in parsed) return parsed.error;
  const replayed = ctx.store.recallIdempotent<Result<PostEntryOk>>(ctx.workspaceId, input.idempotencyKey, 'post_entry');
  if (replayed !== undefined) return replayed;
  const expanded = expandTemplate(ctx, input.date, parsed.template);
  if (!expanded.ok) return expanded.error;
  const composed = expandEntry(ctx, { date: input.date, lines: expanded.lines, ...(input.entryId !== undefined ? { entryId: input.entryId } : {}) });
  if (!composed.ok) return composed;
  if (!composed.verdict.ok) return composed.verdict;
  const { template: _template, lines: _lines, ...rest } = input;
  return postEntry(ctx, {
    ...rest,
    description: typeof input.description === 'string' && input.description.trim() !== '' ? input.description : expanded.expanded.label,
    lines: composed.lines.map((l) => ({ ...l })),
  });
}
