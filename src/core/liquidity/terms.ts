/**
 * A40, Skonto terms (spec §0 row 1, D-A40.5): the supplier conditions A17 never captured.
 *
 * `vendor_bill` has a due date and no Skonto column, and `contact` carries only `payment_terms_days`.
 * Rather than widen A17's table (A17 is not A40's to edit), the terms live in A40's own sidecar:
 *
 *   - a VENDOR default: "r % if paid within n days of the bill date";
 *   - a BILL override: "r % if paid by this date", which wins over the vendor default. `rateBp = 0`
 *     on a bill is an explicit "this bill has no Skonto", so one bill can opt out of a default.
 *
 * A Skonto is a CONTRACT term (never statutory), so nothing here invents one: a bill with neither a
 * default nor an override has no Skonto, and the optimiser never assumes otherwise.
 *
 * The rows carry `created_by`/`updated_by` rather than an audit-chain entry: the terms are master data
 * that posts nothing, and every proposal snapshots the terms it used into its own `inputs_json`, which
 * is where "why did this bill get this date" is answered.
 *
 * §H-TENANT on every statement; §H-IDEMPOTENT: a replayed key answers its first result.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalId, requireString } from '../ledger/inputGuards.js';
import { resolveContactRef } from '../sales/contact.js';
import { addDays } from './calendar.js';

/** §H-ENUM: what a Skonto term is attached to. */
export const SKONTO_SCOPES = ['vendor', 'bill'] as const;
export type SkontoScope = (typeof SKONTO_SCOPES)[number];

/** The highest Skonto accepted, in basis points (10 %). Anything above is a typo, not a condition. */
export const SKONTO_MAX_BP = 1000;
/** The longest vendor Skonto window accepted, in days. */
export const SKONTO_MAX_DAYS = 120;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface SetSkontoTermInput {
  vendorId?: string;
  vendorBillId?: string;
  rateBp: number;
  days?: number;
  untilDate?: string;
  idempotencyKey: string;
}

interface SkontoRow {
  id: string;
  scope_kind: SkontoScope;
  scope_id: string;
  rate_bp: number;
  days: number | null;
  until_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

function view(row: SkontoRow, name: string | null) {
  return {
    id: row.id,
    scope: row.scope_kind,
    vendorId: row.scope_kind === 'vendor' ? row.scope_id : null,
    vendorBillId: row.scope_kind === 'bill' ? row.scope_id : null,
    name,
    rateBp: row.rate_bp,
    days: row.days,
    untilDate: row.until_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Record or replace a Skonto condition (US-A40.2). */
export function setSkontoTerm(ctx: WorkspaceContext, input: SetSkontoTermInput): Result {
  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalId(input.vendorId, 'vendorId') ??
    optionalId(input.vendorBillId, 'vendorBillId');
  if (guard) return guard;
  const hasVendor = input.vendorId !== undefined;
  const hasBill = input.vendorBillId !== undefined;
  if (hasVendor === hasBill) {
    return err('invalid_input', { field: 'vendorId', reason: 'name exactly one of vendorId or vendorBillId' });
  }
  if (!Number.isSafeInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > SKONTO_MAX_BP) {
    return err('invalid_input', { field: 'rateBp', min: 0, max: SKONTO_MAX_BP });
  }

  let scope: SkontoScope;
  let scopeId: string;
  let days: number | null = null;
  let untilDate: string | null = null;
  if (hasVendor) {
    scope = 'vendor';
    // A merged-away vendor id lands on its survivor (the id every bill now points at).
    scopeId = resolveContactRef(ctx, input.vendorId as string)?.id ?? (input.vendorId as string);
    if (input.untilDate !== undefined) {
      return err('invalid_input', { field: 'untilDate', reason: 'a vendor default takes days, a bill takes untilDate' });
    }
    if (input.rateBp > 0) {
      if (!Number.isSafeInteger(input.days) || (input.days as number) < 1 || (input.days as number) > SKONTO_MAX_DAYS) {
        return err('invalid_input', { field: 'days', min: 1, max: SKONTO_MAX_DAYS });
      }
      days = input.days as number;
    }
    const vendor = ctx.store.db
      .prepare("SELECT id FROM contact WHERE workspace_id = ? AND id = ? AND party_role IN ('vendor', 'both')")
      .get(ctx.workspaceId, scopeId) as { id: string } | undefined;
    if (vendor === undefined) return err('not_found', { vendorId: scopeId });
  } else {
    scope = 'bill';
    scopeId = input.vendorBillId as string;
    if (input.days !== undefined) {
      return err('invalid_input', { field: 'days', reason: 'a vendor default takes days, a bill takes untilDate' });
    }
    if (input.rateBp > 0) {
      if (!isIsoDay(input.untilDate)) return err('invalid_input', { field: 'untilDate' });
      untilDate = input.untilDate;
    }
    const bill = ctx.store.db
      .prepare('SELECT id FROM vendor_bill WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, scopeId) as { id: string } | undefined;
    if (bill === undefined) return err('not_found', { vendorBillId: scopeId });
  }

  const scopedKey = JSON.stringify(['liquidity_skonto_set', input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'liquidity_skonto_set', () => {
    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare('SELECT id FROM skonto_term WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ?')
      .get(ctx.workspaceId, scope, scopeId) as { id: string } | undefined;
    let id: string;
    if (existing === undefined) {
      id = ctx.ids.next('skonto');
      ctx.store.db
        .prepare(
          `INSERT INTO skonto_term
             (id, workspace_id, scope_kind, scope_id, rate_bp, days, until_date, idempotency_key,
              created_by, created_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, scope, scopeId, input.rateBp, days, untilDate, input.idempotencyKey, ctx.actor, now, ctx.actor, now);
    } else {
      id = existing.id;
      ctx.store.db
        .prepare(
          `UPDATE skonto_term SET rate_bp = ?, days = ?, until_date = ?, updated_by = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(input.rateBp, days, untilDate, ctx.actor, now, ctx.workspaceId, id);
    }
    const row = ctx.store.db
      .prepare('SELECT * FROM skonto_term WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as SkontoRow;
    return ok({ term: view(row, null), created: existing === undefined });
  });
}

/** Every recorded Skonto term, vendor defaults first (US-A40.2). */
export function listSkontoTerms(ctx: WorkspaceContext, input: { vendorId?: string } = {}): Result {
  const guard = optionalId(input.vendorId, 'vendorId');
  if (guard) return guard;
  const rows = ctx.store.db
    .prepare(
      `SELECT s.*, COALESCE(c.name, cb.name) AS name
         FROM skonto_term s
         LEFT JOIN contact c ON s.scope_kind = 'vendor' AND c.workspace_id = s.workspace_id AND c.id = s.scope_id
         LEFT JOIN vendor_bill b ON s.scope_kind = 'bill' AND b.workspace_id = s.workspace_id AND b.id = s.scope_id
         LEFT JOIN contact cb ON cb.workspace_id = s.workspace_id AND cb.id = b.contact_id
        WHERE s.workspace_id = ?
          AND (? IS NULL OR (s.scope_kind = 'vendor' AND s.scope_id = ?) OR (s.scope_kind = 'bill' AND b.contact_id = ?))
        ORDER BY s.scope_kind DESC, s.scope_id`,
    )
    .all(ctx.workspaceId, input.vendorId ?? null, input.vendorId ?? null, input.vendorId ?? null) as (SkontoRow & {
    name: string | null;
  })[];
  return ok({ terms: rows.map((r) => view(r, r.name)), total: rows.length });
}

/** The Skonto a bill carries: its override, else its vendor's default resolved from the bill date. */
export interface ResolvedSkonto {
  rateBp: number;
  untilDate: string | null;
  source: 'bill' | 'vendor' | 'none';
}

/** Resolve every bill's Skonto in one pass (one read of the table). */
export function resolveSkonto(
  ctx: WorkspaceContext,
  bills: ReadonlyArray<{ id: string; vendorId: string; billDate: string }>,
): Map<string, ResolvedSkonto> {
  const rows = ctx.store.db
    .prepare('SELECT scope_kind, scope_id, rate_bp, days, until_date FROM skonto_term WHERE workspace_id = ?')
    .all(ctx.workspaceId) as Pick<SkontoRow, 'scope_kind' | 'scope_id' | 'rate_bp' | 'days' | 'until_date'>[];
  const byBill = new Map<string, (typeof rows)[number]>();
  const byVendor = new Map<string, (typeof rows)[number]>();
  for (const r of rows) (r.scope_kind === 'bill' ? byBill : byVendor).set(r.scope_id, r);
  const out = new Map<string, ResolvedSkonto>();
  for (const b of bills) {
    const own = byBill.get(b.id);
    if (own !== undefined) {
      out.set(b.id, own.rate_bp > 0 ? { rateBp: own.rate_bp, untilDate: own.until_date, source: 'bill' } : { rateBp: 0, untilDate: null, source: 'bill' });
      continue;
    }
    const def = byVendor.get(b.vendorId);
    if (def !== undefined && def.rate_bp > 0 && def.days !== null) {
      out.set(b.id, { rateBp: def.rate_bp, untilDate: addDays(b.billDate, def.days), source: 'vendor' });
      continue;
    }
    out.set(b.id, { rateBp: 0, untilDate: null, source: 'none' });
  }
  return out;
}
