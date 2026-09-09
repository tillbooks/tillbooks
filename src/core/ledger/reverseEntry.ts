/**
 * A02, `reverseEntry`: the one legal correction (OR 957a).
 *
 * A posted entry is never edited or deleted. It is corrected by posting its faithful mirror: debits
 * and credits swapped, cost centers and the VAT trace carried (the tax base/amount negated), so the
 * target and its reversal net to zero on every account AND cost center AND tax line. Reversal
 * delegates to `postEntry`, so it is the same single posting path, balanced and immutable by
 * construction. An entry is reversed once; a retry with the same key replays the original reversal.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry } from './postEntry.js';
import type { LineInput } from './postEntry.js';
import { requireString, optionalDate, optionalText } from './inputGuards.js';

export interface ReverseEntryInput {
  entryId: string;
  date?: string;
  description?: string;
  idempotencyKey: string;
}

interface OriginalRow {
  id: string;
  status: string;
  date: string;
  description: string | null;
}

interface ReversalRow {
  id: string;
  idempotency_key: string | null;
}

interface OriginalLineRow {
  account_id: string;
  cost_center_id: string | null;
  debit_minor: number;
  credit_minor: number;
  base_debit_minor: number;
  base_credit_minor: number;
  currency: string;
  fx_rate: string | null;
  tax_code: string | null;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  supply_date: string | null;
}

/**
 * What a successful reversal sends back: the id of the MIRROR entry, never the target's.
 *
 * The name matters more here than almost anywhere else in A02, which is why it is declared. Both
 * success paths answer with `reversalId` (a fresh reversal, and an idempotent replay of one), and so
 * does the `already_reversed` rejection. A consumer that read `entryId` here, the name the two
 * neighbouring verbs use, would have got `unknown` from the open `Result` and `undefined` on screen.
 */
export type ReverseEntryOk = {
  /** The id of the reversing entry now posted. Stable across an idempotent retry of the same key. */
  readonly reversalId: string;
};

export function reverseEntry(ctx: WorkspaceContext, input: ReverseEntryInput): Result<ReverseEntryOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.entryId, 'entryId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date') ??
    optionalText(input.description, 'description');
  if (guard) return guard;

  const original = ctx.store.db
    .prepare('SELECT id, status, date, description FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.entryId) as OriginalRow | undefined;
  if (original === undefined) {
    return err('not_found', { entryId: input.entryId });
  }
  if (original.status !== 'posted') {
    return err('not_posted', { entryId: input.entryId });
  }

  // The reversal's idempotency identity is (this target, this key). Folding the target into the key
  // keeps two reversals of DIFFERENT entries that happen to share a client key from colliding in the
  // shared reverse_entry namespace (which would make the second a silent no-op returning the wrong
  // reversal). JSON-encoding the pair is an injective, delimiter-safe encoding of (target, key).
  const scopedKey = JSON.stringify([input.entryId, input.idempotencyKey]);

  // An entry is reversed at most once. If a reversal already exists and it carries this same scoped
  // key, the caller is retrying, so replay it; otherwise the entry is genuinely already reversed.
  const existing = ctx.store.db
    .prepare('SELECT id, idempotency_key FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?')
    .get(ctx.workspaceId, input.entryId) as ReversalRow | undefined;
  if (existing !== undefined) {
    if (existing.idempotency_key === scopedKey) {
      return ok({ reversalId: existing.id });
    }
    return err('already_reversed', { reversalId: existing.id });
  }

  const originalLines = ctx.store.db
    .prepare(
      'SELECT account_id, cost_center_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor, currency, fx_rate, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?',
    )
    .all(input.entryId) as OriginalLineRow[];

  const mirror: LineInput[] = originalLines.map((line) => {
    const m: LineInput =
      line.debit_minor > 0
        ? { account: line.account_id, credit: line.debit_minor }
        : { account: line.account_id, debit: line.credit_minor };
    // §H-FX (A13 §4b.2, shape S7): a FOREIGN entry's mirror RESTATES the stored base amounts
    // verbatim, on the other side, through the stated-base seam. For every entry whose bases came
    // from the side-total allocation this is bit-identical to re-allocating (the mirror's side
    // totals and line order match, so `allocateBase` reproduces the same figures); for an entry
    // that STATED its bases (a partial credit note's released-base slices) it is the only correct
    // answer: a cancelled partial must give back exactly the base slice it took, and a fresh
    // allocation would give back a different one. A base-currency entry states nothing, exactly as
    // before, so the pre-A13 write path is untouched byte for byte.
    if (line.fx_rate !== null) {
      m.baseAmountMinor = line.debit_minor > 0 ? line.base_debit_minor : line.base_credit_minor;
    }
    if (line.cost_center_id !== null) m.costCenter = line.cost_center_id;
    if (line.tax_code !== null) {
      m.taxCode = line.tax_code;
      if (line.tax_base_minor !== null) m.taxBase = -line.tax_base_minor;
      if (line.tax_amount_minor !== null) m.taxAmount = -line.tax_amount_minor;
      // The Leistungsdatum is carried EXPLICITLY, for the same reason the original's FX rate is
      // (see below) and not merely for tidiness: it selects the ESTV Ziffer VINTAGE. A December
      // 2023 supply reversed in 2026 must credit back the Ziffer it was declared on (302), not
      // today's (303). Reversed without it, the target and its mirror land on DIFFERENT form lines
      // and neither cancels, while every account and the 2200 reconciliation still net to zero.
      if (line.supply_date !== null) m.supplyDate = line.supply_date;
    }
    return m;
  });

  // A reversal is dated today (OR 957a: correct in the open period), not the original date, unless the
  // caller chooses a date. Description carries the original's, locale-neutral (P11); the GUI renders
  // the localized "Storno" treatment from the reversal glyph and cross-link.
  const description = input.description ?? original.description ?? undefined;

  // §H-FX: the mirror carries the ORIGINAL's currency and rate, passed EXPLICITLY rather than looked
  // up. Two reasons, both load-bearing. A reversal must undo the CHF the books actually carry, and
  // today's rate would undo a different number. And a correction must never be blocked by a rate
  // that has gone stale or was never recorded for the correction's date: an entry you cannot reverse
  // is an entry you can only fix by editing, which §H-AUDIT forbids.
  const first = originalLines[0];
  const currency = first?.currency ?? undefined;
  const fxRate = first?.fx_rate ?? undefined;

  const posted = postEntry(ctx, {
    date: input.date ?? ctx.clock.now().slice(0, 10),
    source: 'reversal',
    reversesEntryId: input.entryId,
    idempotencyKey: scopedKey,
    lines: mirror,
    ...(description !== undefined ? { description } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(fxRate !== undefined && fxRate !== null ? { fxRate } : {}),
  });
  if (!posted.ok) return posted;
  return ok({ reversalId: posted.entryId });
}
