/**
 * A35 THE TRACE: the recorder behind the conversation surface, and the reads that render it.
 *
 * THE RECORDING SEAM IS THE TRANSPORT DISPATCH (`src/api/agent-gate.ts` calls in here), which is the
 * whole reason the trace is complete: every call from every client, MCP or REST, funnels through the
 * two transport doors, so recording there covers all registry verbs without touching one of them,
 * including verbs whose modules never call `ctx.audit.record`. A new capability joins the trace by
 * existing rather than by remembering to.
 *
 * NO CALLER CAN ASK FOR A ROW. There is deliberately no "record this" verb: a client that could pick
 * its own session id could hide a call in a session nobody reads, so the session is derived (one MCP
 * connection is one session, keyed by its transport key; a connectionless caller joins the actor's
 * open session or a new one after `SESSION_IDLE_MINUTES`).
 *
 * The trace answers "what did the agent do, and why did it draft or execute". It is OPERATIONAL and
 * prunable (`TRACE_RETENTION_MONTHS`); the statutory record stays A03's hash-chained `audit_log`,
 * which this module never writes.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { SESSION_IDLE_MINUTES, TRACE_RETENTION_MONTHS, TURN_GAP_SECONDS } from './constants.js';

interface SessionRow {
  id: string;
  workspace_id: string;
  actor: string;
  client_label: string | null;
  transport_key: string | null;
  started_at: string;
  last_at: string;
  closed_at: string | null;
}

interface TurnRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  text: string | null;
  at: string;
}

interface CallRow {
  id: string;
  turn_id: string;
  seq: number;
  verb: string;
  kind: string;
  args_json: string;
  mode: string;
  decision_reason: string;
  dial_capability: string | null;
  ok: number;
  error_code: string | null;
  entity_ref: string | null;
  duration_ms: number;
  at: string;
  agent_action_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  /** Joined from `agent_action` (F-08, J5.6): where the draft went, and the human's reason if refused. */
  draft_status: string | null;
  reject_reason: string | null;
}

/** What the seam hands the recorder for one call. `argsJson` is stored verbatim (Details renders it). */
export interface RecordCallInput {
  verb: string;
  kind: 'read' | 'write';
  argsJson: string;
  mode: 'execute' | 'draft' | 'deny';
  decisionReason: string;
  dialCapability?: string | undefined;
  callOk: boolean;
  errorCode?: string | undefined;
  entityRef?: string | undefined;
  durationMs: number;
  agentActionId?: string | undefined;
  /** Stable per-connection key (MCP). Absent for connectionless callers (REST): the gap rule applies. */
  transportKey?: string | undefined;
  clientLabel?: string | undefined;
}

function isoMinusMinutes(nowIso: string, minutes: number): string {
  return new Date(new Date(nowIso).getTime() - minutes * 60_000).toISOString();
}

function isoMinusMonths(nowIso: string, months: number): string {
  const d = new Date(nowIso);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/**
 * Prune the trace past `TRACE_RETENTION_MONTHS`, opportunistically at session open. Pruning removes
 * trace rows ONLY: it never touches a ledger effect, an `agent_action` row or the audit chain, which
 * is what makes the pruned state a designed one (the entry then points at the audit row, design row
 * 6.2) rather than an accident.
 */
export function pruneAgentTrace(ctx: WorkspaceContext): void {
  const floor = isoMinusMonths(ctx.clock.now(), TRACE_RETENTION_MONTHS);
  const db = ctx.store.db;
  db.prepare(
    `DELETE FROM agent_call WHERE workspace_id = ? AND turn_id IN
       (SELECT id FROM agent_turn WHERE workspace_id = ? AND at < ?)`,
  ).run(ctx.workspaceId, ctx.workspaceId, floor);
  db.prepare('DELETE FROM agent_turn WHERE workspace_id = ? AND at < ?').run(ctx.workspaceId, floor);
  db.prepare('DELETE FROM agent_session WHERE workspace_id = ? AND last_at < ? AND closed_at IS NOT NULL').run(
    ctx.workspaceId,
    floor,
  );
}

/**
 * Resolve (or open) the session a call belongs to. A transport key wins: one MCP connection is one
 * session for its whole life. Without one, the actor's open session within the idle gap is joined,
 * closing any stale one so a session list never shows two "running" rows for one actor.
 */
export function resolveAgentSession(
  ctx: WorkspaceContext,
  opts: { transportKey?: string | undefined; clientLabel?: string | undefined } = {},
): string {
  const now = ctx.clock.now();
  const db = ctx.store.db;

  if (opts.transportKey !== undefined) {
    const byKey = db
      .prepare(
        'SELECT * FROM agent_session WHERE workspace_id = ? AND actor = ? AND transport_key = ? AND closed_at IS NULL',
      )
      .get(ctx.workspaceId, ctx.actor, opts.transportKey) as SessionRow | undefined;
    if (byKey !== undefined) {
      db.prepare('UPDATE agent_session SET last_at = ? WHERE workspace_id = ? AND id = ?').run(now, ctx.workspaceId, byKey.id);
      return byKey.id;
    }
  } else {
    const open = db
      .prepare(
        'SELECT * FROM agent_session WHERE workspace_id = ? AND actor = ? AND transport_key IS NULL AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1',
      )
      .get(ctx.workspaceId, ctx.actor) as SessionRow | undefined;
    if (open !== undefined) {
      if (open.last_at >= isoMinusMinutes(now, SESSION_IDLE_MINUTES)) {
        db.prepare('UPDATE agent_session SET last_at = ? WHERE workspace_id = ? AND id = ?').run(now, ctx.workspaceId, open.id);
        return open.id;
      }
      db.prepare('UPDATE agent_session SET closed_at = ? WHERE workspace_id = ? AND id = ?').run(now, ctx.workspaceId, open.id);
    }
  }

  pruneAgentTrace(ctx);
  const id = ctx.ids.next('agent_session');
  db.prepare(
    `INSERT INTO agent_session (id, workspace_id, actor, client_label, transport_key, started_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ctx.workspaceId, ctx.actor, opts.clientLabel ?? null, opts.transportKey ?? null, now, now);
  return id;
}

/** The open turn within the gap, or a new one. Role is fixed per turn; a role change opens a new turn. */
function resolveTurn(ctx: WorkspaceContext, sessionId: string, role: 'user' | 'agent', text: string | null): string {
  const now = ctx.clock.now();
  const db = ctx.store.db;
  const last = db
    .prepare('SELECT * FROM agent_turn WHERE workspace_id = ? AND session_id = ? ORDER BY seq DESC LIMIT 1')
    .get(ctx.workspaceId, sessionId) as TurnRow | undefined;
  const gapFloor = isoMinusMinutes(now, TURN_GAP_SECONDS / 60);
  if (text === null && last !== undefined && last.role === role && last.at >= gapFloor) return last.id;
  const id = ctx.ids.next('agent_turn');
  const seq = (last?.seq ?? 0) + 1;
  db.prepare(
    'INSERT INTO agent_turn (id, workspace_id, session_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ctx.workspaceId, sessionId, seq, role, text, now);
  return id;
}

/**
 * A composer turn (D90 D-1/D-5). A turn WITH text always opens its own turn (a sentence is an
 * exchange boundary); a null-text agent turn groups under the gap rule like any other.
 */
export function recordProseTurn(ctx: WorkspaceContext, sessionId: string, role: 'user' | 'agent', text: string | null): string {
  return resolveTurn(ctx, sessionId, role, text);
}

/**
 * Record exactly ONE `agent_call` row. Reads and refusals included: a question is not a lesser event
 * (design row 3.4) and a refusal is a turn, never a silent no-op (row 2.3).
 */
export function recordAgentCall(ctx: WorkspaceContext, input: RecordCallInput): { sessionId: string; turnId: string; callId: string } {
  const sessionId = resolveAgentSession(ctx, { transportKey: input.transportKey, clientLabel: input.clientLabel });
  const turnId = resolveTurn(ctx, sessionId, 'agent', null);
  return { sessionId, turnId, callId: insertCall(ctx, turnId, input) };
}

/** Insert the call row into a known turn (the composer records into its own agent turn). */
export function insertCall(ctx: WorkspaceContext, turnId: string, input: RecordCallInput): string {
  const db = ctx.store.db;
  const last = db
    .prepare('SELECT MAX(seq) AS s FROM agent_call WHERE workspace_id = ? AND turn_id = ?')
    .get(ctx.workspaceId, turnId) as { s: number | null };
  const id = ctx.ids.next('agent_call');
  db.prepare(
    `INSERT INTO agent_call
       (id, workspace_id, turn_id, seq, verb, kind, args_json, mode, decision_reason, dial_capability,
        ok, error_code, entity_ref, duration_ms, at, agent_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ctx.workspaceId,
    turnId,
    (last.s ?? 0) + 1,
    input.verb,
    input.kind,
    input.argsJson,
    input.mode,
    input.decisionReason,
    input.dialCapability ?? null,
    input.callOk ? 1 : 0,
    input.errorCode ?? null,
    input.entityRef ?? null,
    input.durationMs,
    ctx.clock.now(),
    input.agentActionId ?? null,
  );
  return id;
}

/**
 * THE BACKLINK'S SECOND HALF (design §5): on a successful approval the drafting call row gains the
 * created object and the approver, at the one moment both facts exist. Called by
 * `approveDraftedAction`; the auto path filled `entity_ref` at execute time.
 */
export function backfillDraftingCall(
  ctx: WorkspaceContext,
  agentActionId: string,
  entityRef: string | undefined,
): void {
  ctx.store.db
    .prepare(
      `UPDATE agent_call SET entity_ref = ?, resolved_by = ?, resolved_at = ?
        WHERE workspace_id = ? AND agent_action_id = ?`,
    )
    .run(entityRef ?? null, ctx.actor, ctx.clock.now(), ctx.workspaceId, agentActionId);
}

/**
 * The entity reference a Result carries, if any: the first `*Id`-named string field. A heuristic,
 * stated as one: verbs answer with their own noun (`entryId`, `paymentId`, `invoiceId`), and the
 * backlink needs one join key, not a taxonomy. `workspaceId` never counts.
 */
export function entityRefOf(result: Result): string | undefined {
  if (!result.ok) return undefined;
  for (const [key, value] of Object.entries(result)) {
    if (key === 'workspaceId' || key === 'ok') continue;
    if (/Id$/.test(key) && typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------------------ the read models */

export interface ListAgentSessionsInput {
  from?: unknown;
  to?: unknown;
  openOnly?: unknown;
  /**
   * F-08 / D118 C3: the sessions whose trace touched ONE object (`entity_ref`, the id a verb answered
   * with, or the one the approval back-filled onto the drafting call). This is how a detail view finds
   * "the conversation this row came from" in one read, so the provenance line can link into the trace.
   */
  entityRef?: unknown;
}

/**
 * The Gespräche list (US-A35.1): sessions newest first with their call counts. `schritte` counts
 * every call and is never a dash (a session with no calls does not exist); `buchungen` and
 * `vorschlaege` are counts of ATTEMPTS of that kind, and the Studio renders `-` only when the count
 * is zero because nothing of that kind was attempted (the §3e dash-versus-zero rule).
 */
export function listAgentSessions(ctx: WorkspaceContext, input: ListAgentSessionsInput): Result {
  const from = typeof input.from === 'string' ? input.from : '0001-01-01';
  // Critic F10: `last_at` is an ISO TIMESTAMP, so a date-only `to` compared lexically would drop the
  // whole boundary day ('2026-07-16' < '2026-07-16T09:00:00Z'). A date-only bound means the whole
  // day, inclusive. `from` needs no widening: a date-only string sorts before every timestamp of it.
  const toRaw = typeof input.to === 'string' ? input.to : '9999-12-31';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? `${toRaw}T23:59:59.999Z` : toRaw;
  const openOnly = input.openOnly === true;
  const entityRef = typeof input.entityRef === 'string' && input.entityRef.length > 0 ? input.entityRef : null;
  const rows = ctx.store.db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
                WHERE c.workspace_id = s.workspace_id AND t.session_id = s.id) AS calls,
              (SELECT COUNT(*) FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
                WHERE c.workspace_id = s.workspace_id AND t.session_id = s.id
                  AND c.kind = 'write' AND c.mode = 'execute' AND c.ok = 1) AS writes,
              (SELECT COUNT(*) FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
                WHERE c.workspace_id = s.workspace_id AND t.session_id = s.id AND c.mode = 'draft') AS drafts
         FROM agent_session s
        WHERE s.workspace_id = ? AND s.last_at >= ? AND s.last_at <= ?
          AND (? = 0 OR s.closed_at IS NULL)
          AND (? IS NULL OR EXISTS (
                SELECT 1 FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
                 WHERE c.workspace_id = s.workspace_id AND t.session_id = s.id AND c.entity_ref = ?))
        ORDER BY s.last_at DESC`,
    )
    .all(ctx.workspaceId, from, to, openOnly ? 1 : 0, entityRef, entityRef) as (SessionRow & { calls: number; writes: number; drafts: number })[];
  return ok({
    sessions: rows.map((s) => ({
      sessionId: s.id,
      actor: s.actor,
      clientLabel: s.client_label,
      startedAt: s.started_at,
      lastAt: s.last_at,
      open: s.closed_at === null,
      calls: s.calls,
      writes: s.writes,
      drafts: s.drafts,
    })),
  });
}

export interface GetAgentSessionInput {
  sessionId?: unknown;
}

/** One session in full: its turns and their calls, in order. §H-TENANT: the id resolves only in-tenant. */
export function getAgentSession(ctx: WorkspaceContext, input: GetAgentSessionInput): Result {
  const guard = requireString(input.sessionId, 'sessionId');
  if (guard) return guard;
  const sessionId = input.sessionId as string;
  const session = ctx.store.db
    .prepare('SELECT * FROM agent_session WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, sessionId) as SessionRow | undefined;
  if (session === undefined) return err('not_found', { sessionId });
  const turns = ctx.store.db
    .prepare('SELECT * FROM agent_turn WHERE workspace_id = ? AND session_id = ? ORDER BY seq')
    .all(ctx.workspaceId, sessionId) as TurnRow[];
  // F-08 (J5.6): a drafting call carries where its draft went and, if refused, the human's reason, so
  // the conversation shows the decision beside the proposal. §H-TENANT on the join as well: the
  // agent_action row must be THIS workspace's, never matched on id alone.
  const calls = ctx.store.db
    .prepare(
      `SELECT c.*, a.status AS draft_status, a.reject_reason
         FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
         LEFT JOIN agent_action a ON a.id = c.agent_action_id AND a.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND t.session_id = ? ORDER BY t.seq, c.seq`,
    )
    .all(ctx.workspaceId, sessionId) as CallRow[];
  const byTurn = new Map<string, CallRow[]>();
  for (const c of calls) {
    const list = byTurn.get(c.turn_id) ?? [];
    list.push(c);
    byTurn.set(c.turn_id, list);
  }
  return ok({
    sessionId: session.id,
    actor: session.actor,
    clientLabel: session.client_label,
    startedAt: session.started_at,
    lastAt: session.last_at,
    open: session.closed_at === null,
    turns: turns.map((t) => ({
      turnId: t.id,
      seq: t.seq,
      role: t.role,
      text: t.text,
      at: t.at,
      calls: (byTurn.get(t.id) ?? []).map((c) => ({
        callId: c.id,
        seq: c.seq,
        verb: c.verb,
        kind: c.kind,
        args: JSON.parse(c.args_json) as Record<string, unknown>,
        mode: c.mode,
        decisionReason: c.decision_reason,
        dialCapability: c.dial_capability,
        ok: c.ok === 1,
        errorCode: c.error_code,
        entityRef: c.entity_ref,
        durationMs: c.duration_ms,
        at: c.at,
        agentActionId: c.agent_action_id,
        resolvedBy: c.resolved_by,
        resolvedAt: c.resolved_at,
        draftStatus: c.draft_status,
        rejectReason: c.reject_reason,
      })),
    })),
  });
}

export interface AgentProseDeleteInput {
  sessionId?: unknown;
  idempotencyKey?: unknown;
}

/**
 * The verbs whose ARGUMENTS carry conversation prose: the composer verb itself, and the three read
 * models a question is routed onto (their `question` / free-text inputs are the caller's sentence,
 * from the composer AND from an external client alike). Closed set (§H-ENUM): a prose delete redacts
 * these rows' arguments and touches no other call's, because ledger arguments are not prose and ARE
 * the trace's value.
 */
const PROSE_BEARING_VERBS = ['agent_ask', 'ledger_qa', 'month_end_checklist', 'detect_anomalies'] as const;

/** What a redacted argument column holds afterwards: a marker, never the words (critic F2). */
export const REDACTED_ARGS_JSON = '{"redacted":true}';

/**
 * D90 D-5: delete ONE session's prose, EVERY copy of it (critic F2, 18.08.2026: the first cut
 * nulled `agent_turn.text` and left the same sentence verbatim in `agent_call.args_json`, twice).
 * The words go from the turn text AND from the argument record of every prose-bearing call in the
 * session; the rest of the trace (what ran, when, with what outcome, and every non-prose argument)
 * stays, because the trace is the trust view's substrate and erasing it would let a conversation
 * un-happen. The transport row for `agent_ask` never stored the sentence in the first place (the
 * recorder strips it at the seam). Idempotent per key; a replay re-asserts the same state.
 */
export function agentProseDelete(ctx: WorkspaceContext, input: AgentProseDeleteInput): Result {
  const guard = requireString(input.sessionId, 'sessionId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const sessionId = input.sessionId as string;
  const key = input.idempotencyKey as string;
  const session = ctx.store.db
    .prepare('SELECT id FROM agent_session WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, sessionId) as { id: string } | undefined;
  if (session === undefined) return err('not_found', { sessionId });
  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'agent_prose_delete', () => {
    const texts = ctx.store.db
      .prepare('UPDATE agent_turn SET text = NULL WHERE workspace_id = ? AND session_id = ? AND text IS NOT NULL')
      .run(ctx.workspaceId, sessionId);
    const args = ctx.store.db
      .prepare(
        `UPDATE agent_call SET args_json = ?
          WHERE workspace_id = ?
            AND verb IN (${PROSE_BEARING_VERBS.map(() => '?').join(', ')})
            AND args_json != ?
            AND turn_id IN (SELECT id FROM agent_turn WHERE workspace_id = ? AND session_id = ?)`,
      )
      .run(REDACTED_ARGS_JSON, ctx.workspaceId, ...PROSE_BEARING_VERBS, REDACTED_ARGS_JSON, ctx.workspaceId, sessionId);
    return ok({ sessionId, cleared: Number(texts.changes), redactedCalls: Number(args.changes) });
  });
}

/**
 * C00's erasure seam into the trace (critic F9, owner-answered 18.08.2026): `contacts_anonymise`
 * must reach EVERY copy of the erased strings, and the trace records call arguments verbatim, so
 * the anonymise verb hands the strings it erased over and this sweeps them out of `args_json`,
 * out of any prose turn that named them, and out of the inbox queue: the drafted payload
 * (`agent_action.payload_json`, the verbatim input a human will replay) and the human's own reject
 * sentence (`agent_action.reject_reason`, F-08 J5.6, the third prose column). The governance critic
 * of 2026-09-05 (F1) reproduced a rejection naming a vendor and its email that survived the
 * vendor's erasure verbatim and was rendered by `get_agent_session`. Every prose or argument column
 * the agent tables carry is listed HERE, in one sweep, so a new column is added beside the others
 * rather than forgotten. Called INSIDE the anonymise transaction, the `purgeMailForContact` /
 * `purgeVoiceForContact` shape: deliberately not an MCP tool of its own.
 */
export function purgeAgentTraceForStrings(ctx: WorkspaceContext, values: readonly string[]): { redacted: number } {
  const needles = values.filter((v): v is string => typeof v === 'string' && v.trim().length >= 3);
  /** Every (table, column) a needle can hide in. All four carry `workspace_id` directly (§H-TENANT). */
  const columns: readonly { table: string; column: string }[] = [
    { table: 'agent_call', column: 'args_json' },
    { table: 'agent_turn', column: 'text' },
    { table: 'agent_action', column: 'payload_json' },
    { table: 'agent_action', column: 'reject_reason' },
  ];
  let redacted = 0;
  for (const needle of needles) {
    for (const { table, column } of columns) {
      const rows = ctx.store.db
        .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE workspace_id = ? AND ${column} LIKE ?`)
        .all(ctx.workspaceId, `%${needle}%`) as { id: string; value: string }[];
      for (const row of rows) {
        ctx.store.db
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE workspace_id = ? AND id = ?`)
          .run(row.value.split(needle).join('[anonymisiert]'), ctx.workspaceId, row.id);
        redacted += 1;
      }
    }
  }
  return { redacted };
}
