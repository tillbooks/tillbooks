/**
 * A42, `set_settlement_event_ignored`: the Umsatz review's ONE answer per settlement event (the owner,
 * 13.11.2026: "normally everything is included; ignoring exists for tests and edge cases").
 *
 * WHAT IT WRITES. One append-only `settlement_event_inclusion` row, `ignored` or `included`, with an optional
 * reason (never asked, D203 point 5: the row keeps who and when), the actor and the time, plus one A03 chain
 * row. The latest row per event decides; the other value withdraws it. No state machine, no matching: the row
 * is read by the import and the pre-filing check through `overrides.ts`, and it books nothing itself.
 *
 * WHAT IT REFUSES (each a sentence, nothing written, nothing memoised):
 *  - `event_booked`: the import booked the event (a `settlement_event` row stands). A booked event is
 *    corrected by reversing its entry, never by an ignore.
 *  - `handled_outside_active`: a person marked the event handled outside the import (D198); that answer
 *    decides and is withdrawn where it was set (`resolve_settlement_event withdraw_handled`).
 *  - `person_decides`: a governed seat EXECUTING the call. An agent proposes (its call at the dial `post`
 *    drafts a Vorschlag before this runs, and a person's approval runs as that person); it never decides an
 *    ignore itself, under any dial or grant (paper critic H1: an ignore moves turnover and VAT exactly like the
 *    human-only D198 override, and D196 4b keeps the grant to bank-line decisions).
 *
 * The event id need not be observed yet: the Umsatz review shows a file before it is imported, and an answer
 * keyed by an id acts only when an event with that id arrives. §H-TENANT on every query. Capability and dial
 * `post`. The check and the write run in ONE IMMEDIATE transaction (the memo's), and the import reads the row
 * inside its own per-event transaction, so a concurrent import cannot book between them.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/index.js';
import { readSource } from './template.js';
import { handledOutsideOf } from './overrides.js';
import { restatementsOf } from './restated.js';

/** The most characters of a reason. */
export const INCLUSION_REASON_MAX = 500;

/** One sentence per refusal, for an agent or a person reading the answer. */
export const INCLUSION_REFUSALS: Readonly<Record<string, string>> = {
  event_booked:
    'the import booked this event, so it cannot be ignored: a booked event is corrected with a reversing entry, and one that must then stay off the books is marked handled outside the import (resolve_settlement_event handled_outside)',
  handled_outside_active: 'a person marked this event handled outside the import; withdraw that first (resolve_settlement_event withdraw_handled)',
  person_decides: 'an agent proposes an ignore or an include; a person decides it',
};

export interface SetSettlementEventIgnoredInput {
  system?: unknown;
  processor?: unknown;
  eventId?: unknown;
  ignored?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

export type SetSettlementEventIgnoredOk = {
  inclusionId: string;
  system: string;
  processor: string;
  eventId: string;
  state: 'ignored' | 'included';
  reason: string | null;
};

interface Prepared {
  system: string;
  processor: string;
  eventId: string;
  state: 'ignored' | 'included';
  reason: string | null;
}

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function refuse(code: string, extra: Record<string, unknown> = {}): Err {
  return err(code, { ...extra, reason: INCLUSION_REFUSALS[code] ?? code }) as Err;
}

/** Thrown inside the memo to roll it back and answer a state refusal outside it. */
class InclusionAbort extends Error {
  constructor(readonly refusal: Err) {
    super(refusal.error);
  }
}

function prepare(ctx: WorkspaceContext, input: SetSettlementEventIgnoredInput): Prepared | Err {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable as Err;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' }) as Err;
  const source = readSource(input);
  if (isErr(source)) return source;
  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0 || input.eventId.trim().length > 200) {
    return err('invalid_input', { field: 'eventId', reason: 'the event id as the feed states it' }) as Err;
  }
  if (typeof input.ignored !== 'boolean') return err('invalid_input', { field: 'ignored', reason: 'true to ignore the event, false to include it' }) as Err;
  let reason: string | null = null;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== 'string' || input.reason.length > INCLUSION_REASON_MAX) {
      return err('invalid_input', { field: 'reason', reason: `why, in a line (at most ${INCLUSION_REASON_MAX} characters)` }) as Err;
    }
    reason = input.reason.trim().length > 0 ? input.reason.trim() : null;
  }
  const state = input.ignored ? 'ignored' : 'included';
  return { system: source.system, processor: source.processor, eventId: input.eventId.trim(), state, reason };
}

/** The state refusals: read at the pre-draft check and again inside the write's transaction. */
function stateRefusal(ctx: WorkspaceContext, p: Prepared): Err | null {
  const booked = ctx.store.db
    .prepare('SELECT entry_id FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ?')
    .get(ctx.workspaceId, p.system, p.processor, p.eventId) as { entry_id: string } | undefined;
  if (booked !== undefined) return refuse('event_booked', { system: p.system, processor: p.processor, eventId: p.eventId, entryId: booked.entry_id });
  if (handledOutsideOf(ctx, p.system, p.processor, p.eventId).has(p.eventId)) {
    return refuse('handled_outside_active', { system: p.system, processor: p.processor, eventId: p.eventId });
  }
  return null;
}

/** `set_settlement_event_ignored` (module header). */
export function setSettlementEventIgnored(ctx: WorkspaceContext, input: SetSettlementEventIgnoredInput): Result<SetSettlementEventIgnoredOk> {
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  // An agent proposes, a person decides (module header).
  if (isGovernedSeat(ctx.store, ctx.actor)) return refuse('person_decides');
  const { system, processor, eventId, state, reason } = prepared;
  const scopedKey = JSON.stringify(['set_settlement_event_ignored', system, processor, input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result<SetSettlementEventIgnoredOk>>(ctx.workspaceId, scopedKey, 'set_settlement_event_ignored');
  if (replay !== undefined) return replay;
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_settlement_event_ignored', () => {
      const refusal = stateRefusal(ctx, prepared);
      if (refusal !== null) throw new InclusionAbort(refusal);
      const now = ctx.clock.now();
      const inclusionId = ctx.ids.next('stlinc');
      const seen = restatementsOf(ctx, system, processor, eventId).get(eventId)?.length ?? 0;
      ctx.store.db
        .prepare(
          `INSERT INTO settlement_event_inclusion (id, workspace_id, source_system, source_processor, event_id, state, reason, amendments_seen, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(inclusionId, ctx.workspaceId, system, processor, eventId, state, reason, seen, ctx.actor, now);
      ctx.audit.record({ entityKind: 'settlement_event_inclusion', entityId: inclusionId, action: 'create', actor: ctx.actor, at: now });
      return ok<SetSettlementEventIgnoredOk>({ inclusionId, system, processor, eventId, state, reason });
    });
  } catch (x) {
    if (x instanceof InclusionAbort) return x.refusal as Result<SetSettlementEventIgnoredOk>;
    throw x;
  }
}

/**
 * D158: the verb's own validation, nothing written, for the transport seam to run before it drafts a governed
 * seat's call: the input and the state refusals. `person_decides` is NOT checked here: an
 * agent's call becomes a Vorschlag, and a person decides it.
 */
export function prevalidateSetSettlementEventIgnored(ctx: WorkspaceContext, input: SetSettlementEventIgnoredInput): Result | undefined {
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  return stateRefusal(ctx, prepared) ?? undefined;
}
