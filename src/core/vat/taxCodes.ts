/**
 * A05 tax-code management: seed, upsert, archive (never delete), per-account default, and the reads.
 *
 * Codes archive, never delete (§H-VAT-TRACE history-safety): a posted line references its code by value
 * forever, so a rate change adds a new code and archives the old one, and A07 still resolves the
 * archived code for a historical return. There is deliberately NO delete verb.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { TAX_CODE_KINDS, DEFAULT_TAX_CODES } from './enums.js';

interface CodeRow {
  code: string;
  kind: string;
  rate_bp: number;
  esa_form_line: string | null;
  label: string | null;
  active: number;
  valid_from: string | null;
}

/**
 * The P9 registration gate (§5): editing the tax model before MWST is enabled returns
 * `needs_vat_registration`, which the GUI turns into the Enable-MWST CTA. `seedTaxCodes` and
 * `configureVat` are exempt, they are the enablement path itself.
 */
function requireRegistered(ctx: WorkspaceContext): Result | null {
  const row = ctx.store.db
    .prepare('SELECT vat_registered FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { vat_registered: number } | undefined;
  if (row === undefined) return err('not_found', { workspaceId: ctx.workspaceId });
  if (row.vat_registered !== 1) return err('needs_vat_registration');
  return null;
}

function mapCode(r: CodeRow) {
  return {
    code: r.code,
    kind: r.kind,
    rateBp: r.rate_bp,
    formLine: r.esa_form_line,
    label: r.label,
    active: r.active === 1,
    validFrom: r.valid_from,
  };
}

/** Seed the default Swiss set, idempotently (§H-IDEMPOTENT): a re-run adds nothing, no duplicates. */
export function seedTaxCodes(ctx: WorkspaceContext): Result {
  const insert = ctx.store.db.prepare(
    `INSERT OR IGNORE INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const seeded: string[] = [];
  ctx.store.tx(() => {
    for (const c of DEFAULT_TAX_CODES) {
      const before = ctx.store.db
        .prepare('SELECT code FROM tax_code WHERE workspace_id = ? AND code = ?')
        .get(ctx.workspaceId, c.code);
      if (before === undefined) {
        insert.run(ctx.ids.next('tax'), ctx.workspaceId, c.code, c.kind, c.rateBp, c.formLine, c.label);
        seeded.push(c.code);
      }
    }
  });
  return ok({ seeded });
}

export interface UpsertTaxCodeInput {
  code: string;
  kind: string;
  rateBp: number;
  formLine: string;
  label?: string;
  validFrom?: string;
  idempotencyKey?: string;
}

/** Add or edit a code at the §H-ENUM source. Rates are integer basis points. */
/** Whether a posted journal line references this code by value (§H-VAT-TRACE: its resolution is frozen). */
function isReferencedByPostedLine(ctx: WorkspaceContext, code: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.tax_code = ? LIMIT 1`,
    )
    .get(ctx.workspaceId, code);
  return row !== undefined;
}

export function upsertTaxCode(ctx: WorkspaceContext, input: UpsertTaxCodeInput): Result {
  const gate = requireRegistered(ctx);
  if (gate) return gate;
  if (typeof input.code !== 'string' || input.code.trim().length === 0) return err('invalid_input', { field: 'code' });
  // `none` is the reserved absent-VAT sentinel resolveTax short-circuits on, so a real code cannot claim it.
  if (input.code === 'none') return err('reserved_code', { code: 'none' });
  if (!TAX_CODE_KINDS.has(input.kind)) return err('invalid_kind', { kind: input.kind });
  // 0..100% in basis points; a Swiss VAT rate never exceeds this, and it blocks a fat-finger 99999.
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10000) {
    return err('invalid_rate', { rateBp: input.rateBp });
  }
  if (typeof input.formLine !== 'string' || input.formLine.length === 0) return err('invalid_input', { field: 'formLine' });

  const run = (): Result => {
    const existing = ctx.store.db
      .prepare('SELECT kind, rate_bp, esa_form_line FROM tax_code WHERE workspace_id = ? AND code = ?')
      .get(ctx.workspaceId, input.code) as { kind: string; rate_bp: number; esa_form_line: string | null } | undefined;
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active, valid_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(ctx.ids.next('tax'), ctx.workspaceId, input.code, input.kind, input.rateBp, input.formLine, input.label ?? null, input.validFrom ?? null);
    } else {
      // §H-VAT-TRACE: once a posted line references a code, its resolution-affecting fields (kind, rate,
      // form line) are FROZEN, because posted lines re-resolve those live, never stamp them. A rate change
      // is a NEW code + archive-the-old (US-A05.4), never an in-place edit. Only the label may still change.
      const resolutionChanged =
        existing.kind !== input.kind || existing.rate_bp !== input.rateBp || (existing.esa_form_line ?? '') !== input.formLine;
      if (resolutionChanged && isReferencedByPostedLine(ctx, input.code)) {
        return err('referenced_code_immutable', { code: input.code });
      }
      ctx.store.db
        .prepare(
          `UPDATE tax_code SET kind = ?, rate_bp = ?, esa_form_line = ?, label = ?, valid_from = ?
           WHERE workspace_id = ? AND code = ?`,
        )
        .run(input.kind, input.rateBp, input.formLine, input.label ?? null, input.validFrom ?? null, ctx.workspaceId, input.code);
    }
    return ok({ code: input.code });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'upsert_tax_code', run);
  }
  return run();
}

/** Archive a code (active=0). Never deletes, so a posted line's referenced code always resolves. */
export function deactivateTaxCode(ctx: WorkspaceContext, input: { code: string }): Result {
  const gate = requireRegistered(ctx);
  if (gate) return gate;
  if (typeof input.code !== 'string' || input.code.length === 0) return err('invalid_input', { field: 'code' });
  const res = ctx.store.db
    .prepare('UPDATE tax_code SET active = 0 WHERE workspace_id = ? AND code = ?')
    .run(ctx.workspaceId, input.code);
  if (res.changes === 0) return err('not_found', { code: input.code });
  return ok({ code: input.code });
}

/**
 * Reactivate an archived code (active=1), the exact mirror of `deactivateTaxCode`. Absolute
 * state-setting write, so idempotent by construction (§H-IDEMPOTENT): reactivating an already-active
 * code re-asserts active=1 and returns ok, and only an absent code is `not_found`. Touches the
 * tax_code registry metadata alone, never a posted journal line (§H-VAT-TRACE: a posted line resolves
 * its code by value regardless of the active flag), so the append-only money path is untouched.
 * §H-TENANT: scoped to `ctx.workspaceId`.
 */
export function reactivateTaxCode(ctx: WorkspaceContext, input: { code: string }): Result {
  const gate = requireRegistered(ctx);
  if (gate) return gate;
  if (typeof input.code !== 'string' || input.code.length === 0) return err('invalid_input', { field: 'code' });
  const res = ctx.store.db
    .prepare('UPDATE tax_code SET active = 1 WHERE workspace_id = ? AND code = ?')
    .run(ctx.workspaceId, input.code);
  if (res.changes === 0) return err('not_found', { code: input.code });
  return ok({ code: input.code });
}

/** Set (or clear, with null) an account's default tax code (A01 `account.vat_code_default`). */
export function setAccountTaxDefault(
  ctx: WorkspaceContext,
  input: { accountId: string; taxCode: string | null },
): Result {
  const gate = requireRegistered(ctx);
  if (gate) return gate;
  if (typeof input.accountId !== 'string' || input.accountId.length === 0) return err('invalid_input', { field: 'accountId' });
  const account = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.accountId) as { id: string } | undefined;
  if (account === undefined) return err('not_found', { accountId: input.accountId });

  if (input.taxCode !== null) {
    const code = ctx.store.db
      .prepare('SELECT code FROM tax_code WHERE workspace_id = ? AND code = ?')
      .get(ctx.workspaceId, input.taxCode) as { code: string } | undefined;
    if (code === undefined) return err('unknown_tax_code', { taxCode: input.taxCode });
  }
  ctx.store.db
    .prepare('UPDATE account SET vat_code_default = ? WHERE workspace_id = ? AND id = ?')
    .run(input.taxCode, ctx.workspaceId, input.accountId);
  return ok({ accountId: input.accountId, taxCode: input.taxCode });
}

/** All tax codes for the workspace, active-only by default (read model, P5). */
export function listTaxCodes(ctx: WorkspaceContext, filter: { includeArchived?: boolean } = {}): Result {
  const clause = filter.includeArchived ? '' : ' AND active = 1';
  const rows = ctx.store.db
    .prepare(`SELECT code, kind, rate_bp, esa_form_line, label, active, valid_from FROM tax_code WHERE workspace_id = ?${clause} ORDER BY code`)
    .all(ctx.workspaceId) as CodeRow[];
  return ok({ taxCodes: rows.map(mapCode) });
}
