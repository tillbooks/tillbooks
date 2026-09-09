/**
 * A02 drafts: `saveDraft` and `deleteDraft`.
 *
 * A draft is the one mutable, deletable state in the whole capability. It carries no money effect
 * (reports exclude it, §6) until `postEntry` promotes it. Both verbs are fenced to draft rows: a
 * draft mutation can never reach across into a posted entry, and `deleteDraft` is the only delete
 * path in A02, by construction fenced to rows that never became the ledger.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { LineInput } from './postEntry.js';
import { requireString, requireDate, optionalId, optionalText } from './inputGuards.js';
import { validateLineFields } from './lineValidation.js';
import { baseCurrencyOf } from '../fx/rates.js';

export interface SaveDraftInput {
  entryId?: string;
  date: string;
  ref?: string;
  description?: string;
  lines: LineInput[];
  idempotencyKey: string;
}

export interface DeleteDraftInput {
  entryId: string;
  idempotencyKey: string;
}

/**
 * What a successful save sends back: the id of the draft, minted or reused.
 *
 * The same field name `postEntry` answers with, deliberately: a draft becomes a posted entry under
 * the SAME id, so a caller that saves and then promotes reads one field on both sides.
 */
export type SaveDraftOk = {
  /** The draft's id. Minted on a first save, echoed back when the caller supplied one. */
  readonly entryId: string;
};

export function saveDraft(ctx: WorkspaceContext, input: SaveDraftInput): Result<SaveDraftOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.date, 'date') ??
    optionalId(input.entryId, 'entryId') ??
    optionalText(input.description, 'description') ??
    optionalText(input.ref, 'ref');
  if (guard) return guard;

  // Replay a completed save before the state-dependent draft check, so a stale retry that arrives
  // after the draft was promoted elsewhere returns the original result, not `not_a_draft`.
  // The type argument is the DECLARED payload, not the open `Result`. `recallIdempotent` parses JSON
  // and asserts whatever `T` it is given, so leaving it open here would have quietly reopened the
  // payload on the replay path alone: the field is checked on a first save and `unknown` on a retry,
  // which is the harder half of the same defect to ever see in a test.
  const replayed = ctx.store.recallIdempotent<Result<SaveDraftOk>>(
    ctx.workspaceId,
    input.idempotencyKey,
    'save_draft',
  );
  if (replayed !== undefined) return replayed;

  // A provided entryId must name an existing draft in this workspace. A foreign or unknown id returns
  // a structured error (not an unchecked PK-collision throw), and a posted row is fenced off.
  if (input.entryId !== undefined) {
    const row = ctx.store.db
      .prepare('SELECT status FROM journal_entry WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.entryId) as { status: string } | undefined;
    if (row === undefined) return err('not_found', { entryId: input.entryId });
    if (row.status === 'posted') return err('not_a_draft', { entryId: input.entryId });
  }

  // A draft may be unbalanced or one-sided, but its lines must still be well-shaped and reference real
  // in-workspace accounts / cost centres: a structured error, never a throw or a cross-tenant row.
  const fieldErr = validateLineFields(ctx, input.lines);
  if (fieldErr) return fieldErr;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'save_draft', () => {
    const { db } = ctx.store;
    const at = ctx.clock.now();
    const entryId = input.entryId ?? ctx.ids.next('entry');

    if (input.entryId !== undefined) {
      // The outer check proved this is a draft in this workspace: replace its lines and fields.
      db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(entryId);
      db.prepare(
        'UPDATE journal_entry SET date = ?, ref = ?, description = ?, idempotency_key = ?, created_at = ? WHERE id = ?',
      ).run(input.date, input.ref ?? null, input.description ?? null, input.idempotencyKey, at, entryId);
    } else {
      db.prepare(
        `INSERT INTO journal_entry
           (id, workspace_id, date, ref, description, status, reverses_entry_id, idempotency_key, source, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, 'manual', ?, ?)`,
      ).run(
        entryId,
        ctx.workspaceId,
        input.date,
        input.ref ?? null,
        input.description ?? null,
        input.idempotencyKey,
        ctx.actor,
        at,
      );
    }

    // §H-FX. A draft is denominated in the workspace BASE currency, read from the column rather than
    // written as a literal: `workspace.base_currency` is real data, and a hardcoded 'CHF' put a franc
    // label on every draft line of a EUR-based book.
    //
    // The base currency is not a default here, it is the ONLY thing a draft can honestly be.
    // `SaveDraftInput` has no `currency` (nor has `LineInput`, nor the `save_draft` tool schema): the
    // transaction currency is a per-ENTRY property that arrives with `postEntry`, so a caller cannot
    // state one while drafting and the engine must not invent one on their behalf.
    //
    // That makes the draft agree with its own promotion. `postEntry` with no `currency` resolves to
    // `baseCurrencyOf` too, so the row this writes carries the currency the promoted row will carry,
    // and posting relabels nothing. Were the draft to keep the old literal, promoting it in a EUR
    // workspace would silently flip CHF to EUR while the integers stood still.
    //
    // The NULL `fx_rate` below is honest for exactly the same reason, and only for it. A02's
    // `statesConversionBasis` asks about the CURRENCY: a base-currency row states no basis and so
    // stores no rate. A 'CHF' row in a EUR workspace reads as FOREIGN to that predicate, so the old
    // literal produced a row claiming a conversion had happened and then declining to say on what
    // basis, which is the shape `writePostedEntry` refuses to write (docs/specs/03-fx-foundation.md
    // section 9) reached from the other direction. The base amounts are likewise a plain copy of the
    // transaction amounts because nothing was converted; `list_journal` fences both figures to
    // `status = 'posted'` so no reader mistakes that copy for a conversion.
    const currency = baseCurrencyOf(ctx);

    const insertLine = db.prepare(
      `INSERT INTO journal_line
         (id, entry_id, account_id, cost_center_id, debit_minor, credit_minor, currency,
          base_debit_minor, base_credit_minor, fx_rate, tax_code, tax_base_minor, tax_amount_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    for (const line of input.lines) {
      const debit = line.debit ?? 0;
      const credit = line.credit ?? 0;
      insertLine.run(
        ctx.ids.next('line'),
        entryId,
        line.account,
        line.costCenter ?? null,
        debit,
        credit,
        currency,
        debit,
        credit,
        line.taxCode ?? null,
        line.taxBase ?? null,
        line.taxAmount ?? null,
      );
    }

    return ok({ entryId });
  });
}

export function deleteDraft(ctx: WorkspaceContext, input: DeleteDraftInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.entryId, 'entryId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const row = ctx.store.db
    .prepare('SELECT status FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.entryId) as { status: string } | undefined;
  if (row !== undefined && row.status === 'posted') {
    return err('not_a_draft', { entryId: input.entryId });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delete_draft', () => {
    const { db } = ctx.store;
    db.prepare(
      "DELETE FROM journal_line WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ? AND id = ? AND status = 'draft')",
    ).run(ctx.workspaceId, input.entryId);
    db.prepare("DELETE FROM journal_entry WHERE workspace_id = ? AND id = ? AND status = 'draft'").run(
      ctx.workspaceId,
      input.entryId,
    );
    return ok();
  });
}
