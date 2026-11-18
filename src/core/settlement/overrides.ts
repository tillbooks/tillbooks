/**
 * THE PERSON'S ANSWERS PER SETTLEMENT EVENT, read in one place (D198 override, A42 inclusion).
 *
 * Two append-only tables hold an answer per (workspace, system, processor, event id), the latest row per event
 * deciding (rowid order), never a state machine:
 *
 *  - `settlement_event_override` (D198, the owner's answer of 12.11.2026, `resolve_settlement_event`):
 *    `handled_outside` (the event is handled outside the import) or `withdraw_handled`.
 *  - `settlement_event_inclusion` (A42, the Umsatz review, `set_settlement_event_ignored`): `ignored` or
 *    `included`.
 *
 * WHAT THE IMPORT AND THE PRE-FILING CHECK READ (`activeOverridesOf`): the events a person keeps off the
 * import, the union of an active `handled_outside` and a latest inclusion row `ignored`. The import skips such
 * an event (reason `handled_outside` or `ignored`), the check does not list it `missing`, and a restatement
 * arriving after the answer lists it `override_check` (`amendmentsSeen`). An active `handled_outside` decides
 * first: the Umsatz review offers no toggle on it, and it is withdrawn where it was set.
 *
 * `included` only withdraws an ignore: the event is back on its defaults. It never lifts the test default
 * (paper critic M7: a test status belongs to a whole transaction, so a test event is cleared with the D198
 * test track, `resolve_settlement_event not_test`, which reaches every event sharing its keys), the from-date
 * floor, a template skip or a refusal.
 *
 * §H-TENANT: every query names the workspace, the system and the processor. Pure reads.
 */

import type { WorkspaceContext } from '../context.js';

/** An answer that keeps an event off the import. */
export interface ActiveOverride {
  id: string;
  /** Which answer it is: the D198 override or the A42 ignore. */
  source: 'handled_outside' | 'ignored';
  /** How many `restated` rows the event had when the answer was written. */
  amendmentsSeen: number;
  /** The person's reason ('' when an ignore was saved without one). */
  reason: string;
  actor: string;
  at: string;
}

/** The latest A42 inclusion row of an event. */
export interface InclusionRow {
  id: string;
  eventId: string;
  state: 'ignored' | 'included';
  reason: string | null;
  amendmentsSeen: number;
  actor: string;
  at: string;
}

const eventFilter = (eventId?: string): string => (eventId !== undefined ? 'AND event_id = ?' : '');
const eventParam = (eventId?: string): string[] => (eventId !== undefined ? [eventId] : []);

/** The ACTIVE D198 `handled_outside` overrides of one source (or of one event of it), by event id. */
export function handledOutsideOf(ctx: WorkspaceContext, system: string, processor: string, eventId?: string): Map<string, ActiveOverride> {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, event_id, resolution, amendments_seen, reason, actor, at FROM settlement_event_override
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? ${eventFilter(eventId)}
        ORDER BY rowid`,
    )
    .all(ctx.workspaceId, system, processor, ...eventParam(eventId)) as {
    id: string;
    event_id: string;
    resolution: 'handled_outside' | 'withdraw_handled';
    amendments_seen: number;
    reason: string;
    actor: string;
    at: string;
  }[];
  const out = new Map<string, ActiveOverride>();
  for (const r of rows) {
    if (r.resolution === 'handled_outside') out.set(r.event_id, { id: r.id, source: 'handled_outside', amendmentsSeen: r.amendments_seen, reason: r.reason, actor: r.actor, at: r.at });
    else out.delete(r.event_id);
  }
  return out;
}

/** The latest A42 inclusion row per event of one source (or of one event of it). */
export function latestInclusionsOf(ctx: WorkspaceContext, system: string, processor: string, eventId?: string): Map<string, InclusionRow> {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, event_id, state, reason, amendments_seen, actor, at FROM settlement_event_inclusion
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? ${eventFilter(eventId)}
        ORDER BY rowid`,
    )
    .all(ctx.workspaceId, system, processor, ...eventParam(eventId)) as {
    id: string;
    event_id: string;
    state: 'ignored' | 'included';
    reason: string | null;
    amendments_seen: number;
    actor: string;
    at: string;
  }[];
  const out = new Map<string, InclusionRow>();
  for (const r of rows) out.set(r.event_id, { id: r.id, eventId: r.event_id, state: r.state, reason: r.reason, amendmentsSeen: r.amendments_seen, actor: r.actor, at: r.at });
  return out;
}

/**
 * The events a person keeps off the import (module header): an active `handled_outside`, else a latest
 * inclusion row `ignored`.
 */
export function activeOverridesOf(ctx: WorkspaceContext, system: string, processor: string, eventId?: string): Map<string, ActiveOverride> {
  const out = handledOutsideOf(ctx, system, processor, eventId);
  for (const [id, row] of latestInclusionsOf(ctx, system, processor, eventId)) {
    if (row.state !== 'ignored' || out.has(id)) continue;
    out.set(id, { id: row.id, source: 'ignored', amendmentsSeen: row.amendmentsSeen, reason: row.reason ?? '', actor: row.actor, at: row.at });
  }
  return out;
}
