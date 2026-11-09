/**
 * B01, rate cards and `resolveRate` (OP1): the ONE rate resolver every later B-capability consumes.
 *
 * THE SNAPSHOT CONTRACT IS THE POINT OF THIS FILE. A card is never edited in place: `rateCardUpsert`
 * inserts a NEW version and closes the predecessor by writing `valid_to`, and `rateCardEnd` only
 * ever writes `valid_to`. `rate_minor` on an existing row is immutable by construction, so an entry
 * that snapshotted a card can never silently reprice (spec §6b, fixed).
 *
 * `resolveRate` answers the MOST SPECIFIC valid card, precedence client → project → employee →
 * default (`RATE_CARD_SCOPES`, §H-ENUM). With zero matching cards it answers the structured
 * `no_rate_defined`, NEVER a 0 or null rate: a silent zero would flow into a B02 invoice line as a
 * real price (US-B01.5).
 *
 * Every query stamps `workspace_id` (§H-TENANT); every write takes an idempotencyKey
 * (§H-IDEMPOTENT) and keeps all state-dependent work inside the `run` closure (the B00
 * `setProjectStatus` shape), so a replayed key answers the stored result.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { isCurrencyCode } from '../fx/rateMath.js';
import { isRateCardScope, RATE_CARD_SCOPES } from './enums.js';
import type { RateCardScope } from './enums.js';

export interface RateCardRow {
  id: string;
  workspace_id: string;
  scope: string;
  scope_ref: string | null;
  rate_minor: number;
  cost_rate_minor: number | null;
  currency: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export function mapRateCard(row: RateCardRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    scopeRef: row.scope_ref,
    rateMinor: row.rate_minor,
    costRateMinor: row.cost_rate_minor,
    currency: row.currency,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** An ISO calendar day, the only date shape validity is expressed in (the B00 convention). */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function readCard(ctx: WorkspaceContext, rateCardId: string): RateCardRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM rate_card WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, rateCardId) as RateCardRow | undefined;
}

export interface RateCardUpsertInput {
  scope?: string;
  scopeRef?: string;
  rateMinor?: number;
  /** The internal cost rate (B03 'cost' basis), same currency as the card. Absent = none defined. */
  costRateMinor?: number;
  currency?: string;
  validFrom?: string;
  idempotencyKey?: string;
}

export function rateCardUpsert(ctx: WorkspaceContext, input: RateCardUpsertInput): Result {
  if (!isRateCardScope(input.scope)) {
    return err('invalid_rate_card', { field: 'scope', known: RATE_CARD_SCOPES });
  }
  const scope: RateCardScope = input.scope;
  if (scope === 'default') {
    if (input.scopeRef !== undefined) return err('invalid_rate_card', { field: 'scopeRef', reason: 'default_takes_no_ref' });
  } else if (typeof input.scopeRef !== 'string' || input.scopeRef.length === 0) {
    return err('invalid_rate_card', { field: 'scopeRef', reason: 'scoped_card_needs_ref' });
  }
  if (!Number.isInteger(input.rateMinor) || (input.rateMinor as number) <= 0) {
    return err('invalid_rate_card', { field: 'rateMinor' });
  }
  const rateMinor = input.rateMinor as number;
  if (input.costRateMinor !== undefined && (!Number.isInteger(input.costRateMinor) || input.costRateMinor <= 0)) {
    return err('invalid_rate_card', { field: 'costRateMinor' });
  }
  const costRateMinor = input.costRateMinor ?? null;
  if (!isIsoDay(input.validFrom)) return err('invalid_rate_card', { field: 'validFrom' });
  const validFrom = input.validFrom;
  const currency = input.currency ?? baseCurrencyOf(ctx);
  if (!isCurrencyCode(currency)) return err('invalid_rate_card', { field: 'currency' });

  const scopeRef = scope === 'default' ? null : (input.scopeRef as string);

  const run = (): Result => {
    // The version chain for this (scope, scopeRef): a CLOSED card overlapping the new validity is a
    // hard overlap; the OPEN predecessor is auto-closed at the new validFrom, which is the whole
    // upsert-as-versioning contract (US-B01.5). An open card starting ON or AFTER the new validFrom
    // cannot be closed to a non-empty interval, so it is an overlap too.
    const siblings = ctx.store.db
      .prepare(
        `SELECT * FROM rate_card WHERE workspace_id = ? AND scope = ? AND ${scopeRef === null ? 'scope_ref IS NULL' : 'scope_ref = ?'}`,
      )
      .all(...(scopeRef === null ? [ctx.workspaceId, scope] : [ctx.workspaceId, scope, scopeRef])) as RateCardRow[];

    const openCard = siblings.find((s) => s.valid_to === null);
    for (const s of siblings) {
      if (s.valid_to !== null && s.valid_to > validFrom) {
        return err('rate_card_overlap', { rateCardId: s.id, validFrom: s.valid_from, validTo: s.valid_to });
      }
    }
    if (openCard !== undefined && openCard.valid_from >= validFrom) {
      return err('rate_card_overlap', { rateCardId: openCard.id, validFrom: openCard.valid_from, validTo: null });
    }

    const id = ctx.ids.next('rate_card');
    const now = ctx.clock.now();
    return ctx.store.tx(() => {
      if (openCard !== undefined) {
        // Close the predecessor, never mutate its rate: entries that snapshotted it keep their price.
        ctx.store.db
          .prepare('UPDATE rate_card SET valid_to = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(validFrom, now, ctx.workspaceId, openCard.id);
      }
      ctx.store.db
        .prepare(
          `INSERT INTO rate_card (id, workspace_id, scope, scope_ref, rate_minor, cost_rate_minor, currency, valid_from, valid_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, ctx.workspaceId, scope, scopeRef, rateMinor, costRateMinor, currency, validFrom, now, now);
      return ok({
        rateCard: mapRateCard(readCard(ctx, id) as RateCardRow),
        closedPredecessorId: openCard?.id ?? null,
      });
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'rate_card_upsert', run);
  }
  return run();
}

export function rateCardEnd(
  ctx: WorkspaceContext,
  input: { rateCardId?: string; validTo?: string; idempotencyKey?: string },
): Result {
  if (typeof input.rateCardId !== 'string' || input.rateCardId.length === 0) {
    return err('invalid_input', { field: 'rateCardId' });
  }
  if (!isIsoDay(input.validTo)) return err('invalid_rate_card', { field: 'validTo' });
  const validTo = input.validTo;

  const run = (): Result => {
    const card = readCard(ctx, input.rateCardId as string);
    if (card === undefined) return err('rate_card_not_found', { rateCardId: input.rateCardId });
    if (card.valid_to !== null) return err('rate_card_already_ended', { rateCardId: card.id, validTo: card.valid_to });
    if (validTo <= card.valid_from) {
      return err('invalid_rate_card', { field: 'validTo', reason: 'before_valid_from', validFrom: card.valid_from });
    }
    ctx.store.db
      .prepare('UPDATE rate_card SET valid_to = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(validTo, ctx.clock.now(), ctx.workspaceId, card.id);
    return ok({ rateCard: mapRateCard(readCard(ctx, card.id) as RateCardRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'rate_card_end', run);
  }
  return run();
}

export function rateCardList(
  ctx: WorkspaceContext,
  filter: { scope?: string; activeAt?: string } = {},
): Result {
  if (filter.scope !== undefined && !isRateCardScope(filter.scope)) {
    return err('invalid_rate_card', { field: 'scope', known: RATE_CARD_SCOPES });
  }
  if (filter.activeAt !== undefined && !isIsoDay(filter.activeAt)) {
    return err('invalid_input', { field: 'activeAt' });
  }
  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.scope !== undefined) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.activeAt !== undefined) {
    clauses.push('valid_from <= ?');
    clauses.push('(valid_to IS NULL OR valid_to > ?)');
    params.push(filter.activeAt, filter.activeAt);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM rate_card WHERE ${clauses.join(' AND ')} ORDER BY scope, scope_ref, valid_from`)
    .all(...params) as RateCardRow[];
  return ok({ rateCards: rows.map(mapRateCard) });
}

/** What `resolveRate` answers: the winning card's facts, ready to snapshot onto an entry. */
export interface ResolvedRate {
  rateMinor: number;
  /** The winning card's internal cost rate (B03 'cost' basis), or null when it carries none. */
  costRateMinor: number | null;
  currency: string;
  sourceScope: RateCardScope;
  rateCardId: string;
}

export interface ResolveRateInput {
  userId?: string;
  projectId?: string;
  contactId?: string;
  /** ISO day; defaults to the injected clock's today. */
  at?: string;
}

/**
 * OP1, the single rate resolver (spec §4). Exported from the barrel for B02/B03/B04.
 *
 * Precedence is `RATE_CARD_SCOPES` order: a client card for `contactId` beats a project card for
 * `projectId` beats an employee card for `userId` beats the default card. A card is valid at `at`
 * when `valid_from <= at < valid_to` (open cards have no `valid_to`). Within one scope the latest
 * `valid_from` wins, which only matters for closed history since overlaps are refused at write.
 *
 * Returns the OPEN `Result` deliberately (the `applySavedView` helper's reasoning inverted): a
 * declared inline payload is counted by `test/style/result-payload-is-declared.test.mjs` as a verb
 * owing a rename probe, and the OP1 seam's typed shape is `ResolvedRate`, which callers narrow to.
 */
export function resolveRate(ctx: WorkspaceContext, input: ResolveRateInput): Result {
  if (input.at !== undefined && !isIsoDay(input.at)) return err('invalid_input', { field: 'at' });
  const found = findRate(ctx, input, input.at ?? ctx.clock.now().slice(0, 10));
  // NEVER a 0 or null rate: the structured refusal is the contract (US-B01.5, P9).
  if (found === null) return err('no_rate_defined', { at: input.at ?? ctx.clock.now().slice(0, 10) });
  return ok({ resolved: found });
}

/**
 * The typed inside of `resolveRate`, for the capture path (`timeStart`/`timeLog`) that needs the
 * winning card's facts without re-widening through the open `Result`. Not exported from the barrel:
 * consumers outside `src/core/time/` get the P9 `resolveRate` contract.
 */
export function findRate(ctx: WorkspaceContext, input: ResolveRateInput, at: string): ResolvedRate | null {
  const refFor: Record<RateCardScope, string | null | undefined> = {
    client: input.contactId,
    project: input.projectId,
    employee: input.userId,
    default: null,
  };

  for (const scope of RATE_CARD_SCOPES) {
    const ref = refFor[scope];
    if (scope !== 'default' && (typeof ref !== 'string' || ref.length === 0)) continue;
    const row = ctx.store.db
      .prepare(
        `SELECT * FROM rate_card
         WHERE workspace_id = ? AND scope = ? AND ${scope === 'default' ? 'scope_ref IS NULL' : 'scope_ref = ?'}
           AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(...(scope === 'default' ? [ctx.workspaceId, scope, at, at] : [ctx.workspaceId, scope, ref, at, at])) as
      | RateCardRow
      | undefined;
    if (row !== undefined) {
      return {
        rateMinor: row.rate_minor,
        costRateMinor: row.cost_rate_minor,
        currency: row.currency,
        sourceScope: scope,
        rateCardId: row.id,
      };
    }
  }
  return null;
}

/** The `time_resolve_rate` read verb: `resolveRate` with the resolution named for the wire. */
export function timeResolveRate(ctx: WorkspaceContext, input: ResolveRateInput): Result {
  if (input.at !== undefined && !isIsoDay(input.at)) return err('invalid_input', { field: 'at' });
  const at = input.at ?? ctx.clock.now().slice(0, 10);
  const found = findRate(ctx, input, at);
  if (found === null) return err('no_rate_defined', { at });
  return ok({ rate: found, at });
}
