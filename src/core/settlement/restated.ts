/**
 * D198, the owner's answer of 12.11.2026 ("keep it simple"): ONE COMPARISON ON ARRIVAL. The producer's
 * LATEST STATED figures of an event are its first sighting (`settlement_feed_event`), with the `now` of every
 * later `restated` log row applied in arrival order. Each `restated` row is written by the import when an
 * arrival differs from the latest stated figures, and names only what differs from them, so folding the rows
 * in order gives back the newest arrival exactly. Read by the import (to compare an arrival) and by the
 * pre-filing check (`amended`: the import booking does not carry the latest stated figures; `override_check`:
 * a restatement arrived after the person's override).
 *
 * §H-TENANT: every query names the workspace.
 */

import type { WorkspaceContext } from '../context.js';

/** The figures the producer states for an event, as the import and the check compare them. */
export interface StatedFigures {
  kind: string;
  day: string;
  amountMinor: number;
  netMinor: number;
  vatMinor: number | null;
}

export interface FigureChange {
  field: string;
  was: unknown;
  now: unknown;
}

/** The compared fields, in the order a change list names them. */
const FIELDS = ['kind', 'day', 'amountMinor', 'netMinor', 'vatMinor'] as const;

/** What differs from `was` to `now`, field by field. */
export function figureChanges(was: StatedFigures, now: StatedFigures): FigureChange[] {
  const out: FigureChange[] = [];
  for (const f of FIELDS) if (was[f] !== now[f]) out.push({ field: f, was: was[f], now: now[f] });
  return out;
}

function parseChanges(json: string | null): FigureChange[] {
  if (json === null) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as FigureChange[]) : [];
  } catch {
    return [];
  }
}

/** The first sighting with each change list applied in order. */
export function foldStated(first: StatedFigures, changeLists: readonly (readonly FigureChange[])[]): StatedFigures {
  const out: StatedFigures = { ...first };
  for (const list of changeLists) {
    for (const c of list) {
      if (c.field === 'kind' && typeof c.now === 'string') out.kind = c.now;
      else if (c.field === 'day' && typeof c.now === 'string') out.day = c.now;
      else if (c.field === 'amountMinor' && typeof c.now === 'number') out.amountMinor = c.now;
      else if (c.field === 'netMinor' && typeof c.now === 'number') out.netMinor = c.now;
      else if (c.field === 'vatMinor' && (typeof c.now === 'number' || c.now === null)) out.vatMinor = c.now;
    }
  }
  return out;
}

/** The `restated` change lists of every event of one source, in arrival order (the count is their length). */
export function restatementsOf(ctx: WorkspaceContext, system: string, processor: string, eventId?: string): Map<string, FigureChange[][]> {
  const rows = ctx.store.db
    .prepare(
      `SELECT event_id, changed_json FROM settlement_feed_outcome
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND outcome = 'restated' AND event_id IS NOT NULL
          ${eventId !== undefined ? 'AND event_id = ?' : ''}
        ORDER BY rowid`,
    )
    .all(ctx.workspaceId, system, processor, ...(eventId !== undefined ? [eventId] : [])) as { event_id: string; changed_json: string | null }[];
  const out = new Map<string, FigureChange[][]>();
  for (const r of rows) out.set(r.event_id, [...(out.get(r.event_id) ?? []), parseChanges(r.changed_json)]);
  return out;
}

/** The latest stated figures of one event, or undefined when the source never showed it readable. */
export function latestStatedOf(ctx: WorkspaceContext, system: string, processor: string, eventId: string): { figures: StatedFigures; restatements: number } | undefined {
  const first = ctx.store.db
    .prepare(
      `SELECT kind, day, amount_minor, net_minor, vat_minor FROM settlement_feed_event
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ?`,
    )
    .get(ctx.workspaceId, system, processor, eventId) as { kind: string; day: string; amount_minor: number; net_minor: number; vat_minor: number | null } | undefined;
  if (first === undefined) return undefined;
  const lists = restatementsOf(ctx, system, processor, eventId).get(eventId) ?? [];
  return {
    figures: foldStated({ kind: first.kind, day: first.day, amountMinor: first.amount_minor, netMinor: first.net_minor, vatMinor: first.vat_minor }, lists),
    restatements: lists.length,
  };
}
