/**
 * B04, retainers & mandates: the agreement half (create / update / close / list). The money-touching
 * generation half lives in `draws.ts`; this file mints and governs the `retainer` row and never posts
 * (P3). Disjoint from B01's `time/` and B02's `billing/`: B04 consumes B01's approved time and B02's
 * round-once pricing, it does not fork either.
 *
 * §H-TENANT: every read and write scopes to `ctx.workspaceId`; a foreign contact/project/retainer id
 * resolves to nothing, so a cross-tenant caller can neither read nor mutate another book's mandate.
 *
 * §H-IDEMPOTENT: every write takes an idempotency key and keeps all state-dependent work inside the
 * `run` closure (the B00/B01 shape), so a replayed key answers the stored result.
 *
 * THE TX-ATOMICITY DISCIPLINE (the C02/D03 bug class this must not reintroduce): `ctx.store.tx` and
 * `rememberIdempotent` roll back ONLY on a throw. A `run` callback that writes and then RETURNS a P9
 * err commits the partial write while reporting failure. So every refusable condition
 * (invalid_fee/invalid_hours, retainer_not_found, retainer_not_active, period_pending, cross-tenant)
 * is pre-checked as a pure READ before any write and returns its err directly.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { applySavedView } from '../customization/views.js';
import { resolveRate, entryValueMinor } from '../time/index.js';
import { isCurrencyCode } from '../fx/rateMath.js';
import {
  isRetainerPeriod,
  RETAINER_PERIODS,
} from './enums.js';
import type { RetainerPeriod } from './enums.js';
import { periodHasEnded, periodKeyOf } from './periods.js';

export interface RetainerRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  project_id: string | null;
  period: string;
  fee_rappen: number;
  included_hours: number;
  cap_rappen: number | null;
  rollover: number;
  currency: string;
  starts_on: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function mapRetainer(row: RetainerRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contactId: row.contact_id,
    projectId: row.project_id,
    period: row.period,
    feeRappen: row.fee_rappen,
    includedHours: row.included_hours,
    capRappen: row.cap_rappen,
    rollover: row.rollover === 1,
    currency: row.currency,
    startsOn: row.starts_on,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The bare day from the injected clock (never the wall clock). */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** Load a retainer, tenant-scoped. A foreign or missing id resolves to undefined (the §H-TENANT wall). */
export function readRetainer(ctx: WorkspaceContext, retainerId: string): RetainerRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM retainer WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, retainerId) as RetainerRow | undefined;
}

/**
 * The cap-below-included WARNING (US-B04.1 boundary), computed round-once from the resolved rate
 * (OP1). Never an error: the verb accepts the retainer and the UI shows a ⚠ hint, and the cap then
 * truncates coverage before the hours do (§4). Returns null when there is no cap, no included hours,
 * or no resolvable rate (a warning we cannot substantiate is not raised).
 */
function capWarning(
  ctx: WorkspaceContext,
  args: { contactId: string; projectId: string | null; capRappen: number | null; includedHours: number; at: string },
): boolean {
  if (args.capRappen === null || args.includedHours <= 0) return false;
  const rate = resolveRate(ctx, {
    contactId: args.contactId,
    ...(args.projectId !== null ? { projectId: args.projectId } : {}),
    at: args.at,
  });
  // No resolvable rate (US-B01.5's `no_rate_defined`): a warning we cannot substantiate is not raised.
  if (!rate.ok) return false;
  const resolved = (rate as unknown as { resolved: { rateMinor: number } }).resolved;
  const includedValue = entryValueMinor(args.includedHours * 60, resolved.rateMinor);
  return args.capRappen < includedValue;
}

export interface RetainerCreateInput {
  contactId?: string;
  projectId?: string;
  period?: string;
  feeRappen?: number;
  includedHours?: number;
  capRappen?: number;
  rollover?: boolean;
  currency?: string;
  startsOn?: string;
  idempotencyKey?: string;
}

/**
 * US-B04.1: define a retainer. Validates the money-path inputs BEFORE any write (fee > 0, hours >= 0),
 * mints an `active` row, and returns a `cap_below_included` warning when the cap undercuts the
 * included hours at the resolved rate. Idempotent on `idempotencyKey`.
 */
export function createRetainer(ctx: WorkspaceContext, input: RetainerCreateInput): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'retainer_create');
    if (replay !== undefined) return replay;
  }

  if (!isRetainerPeriod(input.period)) {
    return err('invalid_input', { field: 'period', known: RETAINER_PERIODS });
  }
  const period: RetainerPeriod = input.period;
  // fee is stored, never derived, and a retainer bills availability, so a zero or negative fee is a
  // structured refusal (US-B04.1 error), never a 500 (P9).
  if (!Number.isInteger(input.feeRappen) || (input.feeRappen as number) <= 0) {
    return err('invalid_fee', { field: 'feeRappen' });
  }
  const feeRappen = input.feeRappen as number;
  const includedHours = input.includedHours ?? 0;
  if (!Number.isInteger(includedHours) || includedHours < 0) {
    return err('invalid_hours', { field: 'includedHours' });
  }
  let capRappen: number | null = null;
  if (input.capRappen !== undefined && input.capRappen !== null) {
    if (!Number.isInteger(input.capRappen) || input.capRappen <= 0) {
      return err('invalid_input', { field: 'capRappen' });
    }
    capRappen = input.capRappen;
  }
  if (!isIsoDay(input.startsOn)) return err('invalid_input', { field: 'startsOn' });
  const startsOn = input.startsOn;
  const currency = input.currency ?? 'CHF';
  if (!isCurrencyCode(currency)) return err('invalid_input', { field: 'currency' });
  const rollover = input.rollover === true ? 1 : 0;

  // §H-TENANT: the mandate's debtor must be THIS tenant's contact. A foreign or missing id gets the
  // same structured refusal so an id can never be probed across tenants.
  if (typeof input.contactId !== 'string' || input.contactId.length === 0) {
    return err('invalid_input', { field: 'contactId' });
  }
  const contact = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.contactId) as { id: string } | undefined;
  if (contact === undefined) return err('invalid_reference', { field: 'contactId', contactId: input.contactId });
  const contactId = input.contactId;

  let projectId: string | null = null;
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== '') {
    const project = ctx.store.db
      .prepare('SELECT id FROM project WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.projectId) as { id: string } | undefined;
    if (project === undefined) return err('invalid_reference', { field: 'projectId', projectId: input.projectId });
    projectId = input.projectId;
  }

  const warning = capWarning(ctx, { contactId, projectId, capRappen, includedHours, at: startsOn });

  const run = (): Result => {
    const id = ctx.ids.next('retainer');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO retainer (id, workspace_id, contact_id, project_id, period, fee_rappen, included_hours,
                               cap_rappen, rollover, currency, starts_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, ctx.workspaceId, contactId, projectId, period, feeRappen, includedHours, capRappen, rollover, currency, startsOn, now, now);
    const retainer = mapRetainer(readRetainer(ctx, id) as RetainerRow);
    return warning ? ok({ retainer, warning: 'cap_below_included' }) : ok({ retainer });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'retainer_create', run);
  }
  return ctx.store.tx(run);
}

/** Does this retainer have ANY draw yet? Once it does, its identity-defining fields freeze. */
function hasAnyDraw(ctx: WorkspaceContext, retainerId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? LIMIT 1')
    .get(ctx.workspaceId, retainerId) as { 1: number } | undefined;
  return row !== undefined;
}

export interface RetainerUpdateInput {
  retainerId?: string;
  patch?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * US-B04.1 edit: patch a retainer. Coverage terms (fee, included hours, cap, rollover) apply to
 * FUTURE periods only, which is structural rather than enforced: a generated period stored its fee and
 * its draws, and generation reads the row live, so a later edit never rewrites history (§H-AUDIT
 * spirit). The identity fields (period, contact, project) freeze once ANY draw exists, because a
 * period_key's meaning and a draw's debtor cannot change under it.
 */
export function updateRetainer(ctx: WorkspaceContext, input: RetainerUpdateInput): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'retainer_update');
    if (replay !== undefined) return replay;
  }
  if (typeof input.retainerId !== 'string' || input.retainerId.length === 0) {
    return err('invalid_input', { field: 'retainerId' });
  }
  const patch = input.patch ?? {};
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return err('invalid_input', { field: 'patch' });
  }

  const retainer = readRetainer(ctx, input.retainerId);
  if (retainer === undefined) return err('retainer_not_found', { retainerId: input.retainerId });
  if (retainer.status === 'ended') return err('retainer_ended', { retainerId: retainer.id });

  const frozen = hasAnyDraw(ctx, retainer.id);
  const next = {
    fee_rappen: retainer.fee_rappen,
    included_hours: retainer.included_hours,
    cap_rappen: retainer.cap_rappen,
    rollover: retainer.rollover,
    period: retainer.period,
    contact_id: retainer.contact_id,
    project_id: retainer.project_id,
  };

  if ('feeRappen' in patch) {
    if (!Number.isInteger(patch.feeRappen) || (patch.feeRappen as number) <= 0) return err('invalid_fee', { field: 'feeRappen' });
    next.fee_rappen = patch.feeRappen as number;
  }
  if ('includedHours' in patch) {
    if (!Number.isInteger(patch.includedHours) || (patch.includedHours as number) < 0) return err('invalid_hours', { field: 'includedHours' });
    next.included_hours = patch.includedHours as number;
  }
  if ('capRappen' in patch) {
    const c = patch.capRappen;
    if (c === null) next.cap_rappen = null;
    else if (!Number.isInteger(c) || (c as number) <= 0) return err('invalid_input', { field: 'capRappen' });
    else next.cap_rappen = c as number;
  }
  if ('rollover' in patch) {
    if (typeof patch.rollover !== 'boolean') return err('invalid_input', { field: 'rollover' });
    next.rollover = patch.rollover ? 1 : 0;
  }
  if ('period' in patch) {
    if (frozen) return err('retainer_has_draws', { field: 'period' });
    if (!isRetainerPeriod(patch.period)) return err('invalid_input', { field: 'period', known: RETAINER_PERIODS });
    next.period = patch.period;
  }
  if ('projectId' in patch) {
    if (frozen) return err('retainer_has_draws', { field: 'projectId' });
    const pid = patch.projectId;
    if (pid === null || pid === '') next.project_id = null;
    else {
      const project = ctx.store.db
        .prepare('SELECT id FROM project WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, pid) as { id: string } | undefined;
      if (project === undefined) return err('invalid_reference', { field: 'projectId', projectId: pid });
      next.project_id = pid as string;
    }
  }
  if ('contactId' in patch) {
    if (frozen) return err('retainer_has_draws', { field: 'contactId' });
    const cid = patch.contactId;
    const contact = ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, cid) as { id: string } | undefined;
    if (contact === undefined) return err('invalid_reference', { field: 'contactId', contactId: cid });
    next.contact_id = cid as string;
  }

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE retainer SET fee_rappen = ?, included_hours = ?, cap_rappen = ?, rollover = ?, period = ?,
                             contact_id = ?, project_id = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
      )
      .run(next.fee_rappen, next.included_hours, next.cap_rappen, next.rollover, next.period, next.contact_id, next.project_id, ctx.clock.now(), ctx.workspaceId, retainer.id);
    return ok({ retainer: mapRetainer(readRetainer(ctx, retainer.id) as RetainerRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'retainer_update', run);
  }
  return ctx.store.tx(run);
}

/** Every ENDED (closed) period from `starts_on` to `asOf` that has no `fee` draw yet: the pending set. */
export function pendingPeriods(ctx: WorkspaceContext, retainer: RetainerRow, asOf: string): string[] {
  const period = retainer.period as RetainerPeriod;
  const invoiced = new Set(
    (ctx.store.db
      .prepare("SELECT period_key FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND kind = 'fee'")
      .all(ctx.workspaceId, retainer.id) as { period_key: string }[]).map((r) => r.period_key),
  );
  const pending: string[] = [];
  let key = periodKeyOf(period, retainer.starts_on);
  // Walk forward one period at a time while the period lies fully in the past. Bounded by the span
  // from starts_on to asOf, which is finite.
  let guard = 0;
  while (periodHasEnded(period, key, asOf) && guard < 600) {
    if (!invoiced.has(key)) pending.push(key);
    key = periodKeyOf(period, addOnePeriod(period, key));
    guard += 1;
  }
  return pending;
}

/** The ISO day one period after the start of `key` (used only to step `pendingPeriods`). */
function addOnePeriod(period: RetainerPeriod, key: string): string {
  // Re-use periodEndExclusive via periods.ts by importing lazily would create a cycle; compute here.
  if (period === 'monthly') {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  const y = Number(key.slice(0, 4));
  const q = Number(key.slice(6));
  return q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`;
}

export interface RetainerCloseInput {
  retainerId?: string;
  skipFinal?: boolean;
  idempotencyKey?: string;
}

/**
 * US-B04.5: end a mandate. `active -> ended`. OR 404 Abs. 1 makes a mandate terminable at any time, so
 * close must always be REACHABLE: it refuses only while a closed period is still unbilled, and
 * `skipFinal:true` overrides even that. Closing an already-ended retainer settles to the same answer
 * (idempotent), because a replay of a completed close must answer what the first call made true.
 */
export function closeRetainer(ctx: WorkspaceContext, input: RetainerCloseInput): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'retainer_close');
    if (replay !== undefined) return replay;
  }
  if (typeof input.retainerId !== 'string' || input.retainerId.length === 0) {
    return err('invalid_input', { field: 'retainerId' });
  }
  const retainer = readRetainer(ctx, input.retainerId);
  if (retainer === undefined) return err('retainer_not_found', { retainerId: input.retainerId });
  if (retainer.status === 'ended') {
    return ok({ retainer: mapRetainer(retainer), alreadyEnded: true });
  }

  if (input.skipFinal !== true) {
    const pending = pendingPeriods(ctx, retainer, today(ctx));
    if (pending.length > 0) return err('period_pending', { retainerId: retainer.id, periods: pending });
  }

  const run = (): Result => {
    ctx.store.db
      .prepare("UPDATE retainer SET status = 'ended', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, retainer.id);
    return ok({ retainer: mapRetainer(readRetainer(ctx, retainer.id) as RetainerRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'retainer_close', run);
  }
  return ctx.store.tx(run);
}

export interface RetainerListFilter {
  contactId?: string;
  status?: string;
  savedViewId?: string;
}

/** US-B04.1/3: the Mandate list (P5), tenant-scoped, with the G00 saved-view seam (OP10). */
export function listRetainers(ctx: WorkspaceContext, filter: RetainerListFilter = {}): Result {
  const viewed = applySavedView(ctx, 'retainer', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.contactId !== undefined) {
    clauses.push('contact_id = ?');
    params.push(filter.contactId);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM retainer WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`)
    .all(...params) as RetainerRow[];
  return ok({ retainers: rows.map(mapRetainer) });
}
