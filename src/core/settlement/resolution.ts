/**
 * `resolve_settlement_event`: a PERSON answers for ONE settlement event (the D172 per-call override), audited by
 * who and when; a reason is optional (D203 point 5, D204 point 4: never asked) and kept when given, an empty text
 * when not (the columns stay NOT NULL, no table rebuild). Two tracks, each append-only, the latest row deciding:
 *
 *  - THE TEST TRACK (D198 stateless check S5, `settlement_test_resolution`, read by `flags.ts`): `not_test`
 *    clears the test status of the named event and of every event sharing one of its key values (the answer
 *    lists every observed event it now clears; a later document carrying them books them); `reopen_test`
 *    returns them to their flags.
 *  - THE OVERRIDE (the owner's answer of 12.11.2026, "Just apply an override functionality. Keep it simple",
 *    `settlement_event_override`): `handled_outside` marks the event handled outside the import (a person
 *    booked it by hand, or it needs no booking): the import books nothing for it (`skipped`, reason
 *    `handled_outside`) and the pre-filing check does not list it `missing`. `withdraw_handled` takes that
 *    back. It books nothing and links to no entry. The row keeps how many restatements the event had when it
 *    was written (`amendments_seen`): a restatement arriving later lists the event `override_check` until a
 *    person sets the override again (or withdraws it and the import books it).
 *
 * Human-only (`write:reversible:human-only`): a governed seat is refused `human_only` under every dial, before
 * a draft. Capability `post`. The verb refuses an event id the source never showed TILL. Its check and its
 * write run in ONE IMMEDIATE transaction (the store's outermost `tx`), and the import reads both tracks
 * inside its own per-event transaction, so a concurrent pull cannot book between them. A refused call writes
 * nothing and memoises nothing (the refusal is thrown out of the memo), so the same key works once it is
 * fixed.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/index.js';
import { readSource } from './template.js';
import { decidingTestResolution, flaggedTest, keyValuesOf, testResolutionsOf } from './flags.js';
import { restatementsOf } from './restated.js';
import { handledOutsideOf } from './overrides.js';

/** The two answers of the test track (D198 stateless check S5). */
export const TEST_RESOLUTIONS = ['not_test', 'reopen_test'] as const;
export type TestResolution = (typeof TEST_RESOLUTIONS)[number];
/** The two answers of the override (the owner's answer of 12.11.2026). */
export const OVERRIDE_RESOLUTIONS = ['handled_outside', 'withdraw_handled'] as const;
export type OverrideResolution = (typeof OVERRIDE_RESOLUTIONS)[number];
/** Every answer `resolve_settlement_event` takes. */
export const SETTLEMENT_RESOLUTIONS = [...TEST_RESOLUTIONS, ...OVERRIDE_RESOLUTIONS] as const;
export type SettlementResolution = (typeof SETTLEMENT_RESOLUTIONS)[number];

/** One sentence per refusal, for an agent or a person reading the answer. */
export const RESOLUTION_REFUSALS: Readonly<Record<string, string>> = {
  human_only: 'only a person may resolve a settlement event; an agent can neither resolve nor propose it',
  event_not_observed: 'this source never showed TILL an event with this id',
  override_not_active: 'this event carries no active handled_outside override to withdraw',
};

export interface ResolveSettlementEventInput {
  system?: unknown;
  processor?: unknown;
  eventId?: unknown;
  resolution?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

interface Prepared {
  system: string;
  processor: string;
  eventId: string;
  resolution: SettlementResolution;
  reason: string;
}

export type ResolveSettlementEventOk = {
  resolutionId: string;
  system: string;
  processor: string;
  eventId: string;
  resolution: SettlementResolution;
  /**
   * `not_test`: the observed events this answer now clears; `reopen_test`: those it returns to their flags;
   * the override answers decide for the named event only and list nothing.
   */
  events: { eventId: string; kind: string; day: string; amountMinor: number }[];
};

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function refuse(code: string, extra: Record<string, unknown> = {}): Err {
  return err(code, { ...extra, reason: RESOLUTION_REFUSALS[code] ?? code }) as Err;
}

/** Thrown inside the memo to roll it back and answer a state refusal outside it. */
class ResolutionAbort extends Error {
  constructor(readonly refusal: Err) {
    super(refusal.error);
  }
}

function prepare(ctx: WorkspaceContext, input: ResolveSettlementEventInput): Prepared | Err {
  if (isGovernedSeat(ctx.store, ctx.actor)) return refuse('human_only');
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable as Err;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' }) as Err;
  const source = readSource(input);
  if (isErr(source)) return source;
  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0 || input.eventId.trim().length > 200) {
    return err('invalid_input', { field: 'eventId', reason: 'the event id as the feed states it' }) as Err;
  }
  if (typeof input.resolution !== 'string' || !(SETTLEMENT_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
    return err('invalid_input', { field: 'resolution', reason: `one of ${SETTLEMENT_RESOLUTIONS.join(', ')}` }) as Err;
  }
  // D203 point 5: the reason is optional; absent, null or blank is stored as an empty text (who and when stay).
  if (input.reason !== undefined && input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 500)) {
    return err('invalid_input', { field: 'reason', reason: 'optional; a line of at most 500 characters, kept with the resolution' }) as Err;
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  return { system: source.system, processor: source.processor, eventId: input.eventId.trim(), resolution: input.resolution as SettlementResolution, reason };
}

function wasSeen(ctx: WorkspaceContext, system: string, processor: string, eventId: string): boolean {
  const observed = ctx.store.db
    .prepare('SELECT 1 AS s FROM settlement_feed_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? LIMIT 1')
    .get(ctx.workspaceId, system, processor, eventId);
  if (observed !== undefined) return true;
  if (
    ctx.store.db
      .prepare('SELECT 1 AS s FROM settlement_feed_flag WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? LIMIT 1')
      .get(ctx.workspaceId, system, processor, eventId) !== undefined
  ) {
    return true;
  }
  // A reader refusal (S3) is in the log only: a person may still mark it handled outside the import.
  return (
    ctx.store.db
      .prepare('SELECT 1 AS s FROM settlement_feed_outcome WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? LIMIT 1')
      .get(ctx.workspaceId, system, processor, eventId) !== undefined
  );
}

// The readers of the answers per event live in `overrides.ts` (A42 added the inclusion rows); re-exported here
// for the callers that imported them from this module.
export { activeOverridesOf, handledOutsideOf } from './overrides.js';
export type { ActiveOverride } from './overrides.js';

/** `resolve_settlement_event` (module header). */
export function resolveSettlementEvent(ctx: WorkspaceContext, input: ResolveSettlementEventInput): Result<ResolveSettlementEventOk> {
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  const { system, processor, eventId, resolution, reason } = prepared;
  const scopedKey = JSON.stringify(['resolve_settlement_event', system, processor, input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result<ResolveSettlementEventOk>>(ctx.workspaceId, scopedKey, 'resolve_settlement_event');
  if (replay !== undefined) return replay;
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'resolve_settlement_event', () => {
      if (!wasSeen(ctx, system, processor, eventId)) throw new ResolutionAbort(refuse('event_not_observed', { system, processor, eventId }));
      const now = ctx.clock.now();
      const resolutionId = ctx.ids.next('stlres');
      if (resolution === 'handled_outside' || resolution === 'withdraw_handled') {
        if (resolution === 'withdraw_handled' && !handledOutsideOf(ctx, system, processor, eventId).has(eventId)) {
          throw new ResolutionAbort(refuse('override_not_active', { system, processor, eventId }));
        }
        const seen = restatementsOf(ctx, system, processor, eventId).get(eventId)?.length ?? 0;
        ctx.store.db
          .prepare(
            `INSERT INTO settlement_event_override (id, workspace_id, source_system, source_processor, event_id, resolution, amendments_seen, reason, actor, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(resolutionId, ctx.workspaceId, system, processor, eventId, resolution, seen, reason, ctx.actor, now);
        ctx.audit.record({ entityKind: 'settlement_event_override', entityId: resolutionId, action: 'create', actor: ctx.actor, at: now });
        return ok<ResolveSettlementEventOk>({ resolutionId, system, processor, eventId, resolution, events: [] });
      }
      const keys = keyValuesOf(ctx, system, processor, eventId);
      ctx.store.db
        .prepare(
          `INSERT INTO settlement_test_resolution (id, workspace_id, source_system, source_processor, event_id, resolution, key_values_json, reason, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(resolutionId, ctx.workspaceId, system, processor, eventId, resolution, JSON.stringify(keys), reason, ctx.actor, now);
      ctx.audit.record({ entityKind: 'settlement_test_resolution', entityId: resolutionId, action: 'create', actor: ctx.actor, at: now });
      // Every observed event of the source this row now decides, among those its flags mark test.
      const rows = testResolutionsOf(ctx, system, processor);
      const observed = ctx.store.db
        .prepare('SELECT event_id, kind, day, amount_minor FROM settlement_feed_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? ORDER BY day, rowid')
        .all(ctx.workspaceId, system, processor) as { event_id: string; kind: string; day: string; amount_minor: number }[];
      const events = observed
        .filter((o) => flaggedTest(ctx, system, processor, o.event_id))
        .filter((o) => decidingTestResolution(rows, o.event_id, keyValuesOf(ctx, system, processor, o.event_id), (n) => keyValuesOf(ctx, system, processor, n))?.id === resolutionId)
        .map((o) => ({ eventId: o.event_id, kind: o.kind, day: o.day, amountMinor: o.amount_minor }));
      return ok<ResolveSettlementEventOk>({ resolutionId, system, processor, eventId, resolution, events });
    });
  } catch (x) {
    if (x instanceof ResolutionAbort) return x.refusal as Result<ResolveSettlementEventOk>;
    throw x;
  }
}

/** D158: the verb's own validation, nothing written (the human-only check included). */
export function prevalidateResolveSettlementEvent(ctx: WorkspaceContext, input: ResolveSettlementEventInput): Result | undefined {
  const prepared = prepare(ctx, input);
  return isErr(prepared) ? prepared : undefined;
}
