/**
 * A35's read-model helpers: parsers over the four agent reads, the Geld/System grouping, the
 * per-workspace dock memory, and the per-capability suggestion dismissal (D90 D-3). Parsing is
 * defensive: a shape the surface cannot read renders as absent, never as a crash or a guessed figure.
 */

import en from './messages.en.json';

export type DialLevel = 'ask' | 'auto';

/**
 * The verbs this surface carries a human label for (its own catalogue slice; both locales hold the
 * same keys, held by the locale-completeness test). An unlabelled verb renders its name with the
 * underscores replaced and the raw key as the row's title: not a translation, and honestly not one.
 */
export const LABELLED_VERBS: ReadonlySet<string> = new Set(Object.keys((en as { agent: { verb: Record<string, string> } }).agent.verb));

/**
 * The verbs whose consequence sentence is their OWN (`agent.consequenceVerb.*`) rather than their dial
 * family's (`agent.consequence.<capability>`). D123 put the membership verbs under `customize`, whose
 * family sentence describes a field definition; a card that said "changes the record structure" over
 * an invite would be wrong, so these verbs carry their own sentence and the family sentence stays the
 * fallback for every other mapped verb.
 */
export const CONSEQUENCE_VERBS: ReadonlySet<string> = new Set(
  Object.keys((en as unknown as { agent: { consequenceVerb: Record<string, string> } }).agent.consequenceVerb),
);

/** The payload keys the card carries a real de-CH label for (`agent.field.*`, critic F6). */
export const LABELLED_FIELDS: ReadonlySet<string> = new Set(
  Object.keys((en as unknown as { agent: { field: Record<string, string> } }).agent.field),
);

export interface TrustRow {
  capability: string;
  stored: DialLevel;
  effective: DialLevel;
  strongDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  proposed: number;
  approved: number;
  rejected: number;
  autoExecuted: number;
  lastAt: string | null;
  suggestGrant: boolean;
}

export interface TrustSummary {
  window: { from: string; to: string };
  rows: TrustRow[];
}

export interface DraftedAction {
  actionId: string;
  actor: string;
  dialCapability: string | null;
  actionTool: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
  /** The human's sentence on a rejected proposal (F-08, J5.6), or null. */
  rejectReason: string | null;
}

export interface AgentCall {
  callId: string;
  seq: number;
  verb: string;
  kind: 'read' | 'write';
  args: Record<string, unknown>;
  mode: 'execute' | 'draft' | 'deny';
  decisionReason: string;
  dialCapability: string | null;
  ok: boolean;
  errorCode: string | null;
  entityRef: string | null;
  durationMs: number;
  at: string;
  agentActionId: string | null;
  /** Where a drafting call's proposal went (`pending` | `executed` | `rejected`), null on a non-draft. */
  draftStatus: string | null;
  /** The human's reason when the proposal was rejected (F-08, J5.6). */
  rejectReason: string | null;
}

export interface AgentTurn {
  turnId: string;
  seq: number;
  role: 'user' | 'agent';
  text: string | null;
  at: string;
  calls: AgentCall[];
}

export interface AgentSessionDetail {
  sessionId: string;
  actor: string;
  clientLabel: string | null;
  startedAt: string;
  lastAt: string;
  open: boolean;
  turns: AgentTurn[];
}

export interface AgentSessionRow {
  sessionId: string;
  clientLabel: string | null;
  startedAt: string;
  lastAt: string;
  open: boolean;
  calls: number;
  writes: number;
  drafts: number;
}

/** The two Vertrauen groups (design §3g): governed by meaning, mirrored by the queue's grouping. */
export const GELD_CAPABILITIES = ['post', 'issue', 'send', 'dun', 'pay', 'vat-file'] as const;
export const SYSTEM_CAPABILITIES = ['customize', 'plugin-install', 'close-period', 'go-live'] as const;

/** The Studio's trace-collapse threshold: one number, used by the dock and the archive alike. */
export const TRACE_COLLAPSE_THRESHOLD = 4;
/** Above this many pending Vorschläge the queue groups Geld/System (design §3f). */
export const QUEUE_GROUP_THRESHOLD = 20;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseSessions(body: unknown): AgentSessionRow[] {
  const list = record(body).sessions;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const s = record(raw);
    return {
      sessionId: String(s.sessionId ?? ''),
      clientLabel: typeof s.clientLabel === 'string' ? s.clientLabel : null,
      startedAt: String(s.startedAt ?? ''),
      lastAt: String(s.lastAt ?? ''),
      open: s.open === true,
      calls: typeof s.calls === 'number' ? s.calls : 0,
      writes: typeof s.writes === 'number' ? s.writes : 0,
      drafts: typeof s.drafts === 'number' ? s.drafts : 0,
    };
  });
}

export function parseSessionDetail(body: unknown): AgentSessionDetail | null {
  const b = record(body);
  if (typeof b.sessionId !== 'string') return null;
  const turns = Array.isArray(b.turns) ? b.turns : [];
  return {
    sessionId: b.sessionId,
    actor: String(b.actor ?? ''),
    clientLabel: typeof b.clientLabel === 'string' ? b.clientLabel : null,
    startedAt: String(b.startedAt ?? ''),
    lastAt: String(b.lastAt ?? ''),
    open: b.open === true,
    turns: turns.map((raw) => {
      const t = record(raw);
      const calls = Array.isArray(t.calls) ? t.calls : [];
      return {
        turnId: String(t.turnId ?? ''),
        seq: typeof t.seq === 'number' ? t.seq : 0,
        role: t.role === 'user' ? 'user' : 'agent',
        text: typeof t.text === 'string' ? t.text : null,
        at: String(t.at ?? ''),
        calls: calls.map((cRaw) => {
          const c = record(cRaw);
          return {
            callId: String(c.callId ?? ''),
            seq: typeof c.seq === 'number' ? c.seq : 0,
            verb: String(c.verb ?? ''),
            kind: c.kind === 'write' ? 'write' : 'read',
            args: record(c.args),
            mode: c.mode === 'draft' ? 'draft' : c.mode === 'deny' ? 'deny' : 'execute',
            decisionReason: String(c.decisionReason ?? ''),
            dialCapability: typeof c.dialCapability === 'string' ? c.dialCapability : null,
            ok: c.ok === true,
            errorCode: typeof c.errorCode === 'string' ? c.errorCode : null,
            entityRef: typeof c.entityRef === 'string' ? c.entityRef : null,
            durationMs: typeof c.durationMs === 'number' ? c.durationMs : 0,
            at: String(c.at ?? ''),
            agentActionId: typeof c.agentActionId === 'string' ? c.agentActionId : null,
            draftStatus: typeof c.draftStatus === 'string' ? c.draftStatus : null,
            rejectReason: typeof c.rejectReason === 'string' ? c.rejectReason : null,
          } satisfies AgentCall;
        }),
      } satisfies AgentTurn;
    }),
  };
}

export function parseDrafted(body: unknown): DraftedAction[] {
  const list = record(body).actions;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const a = record(raw);
    return {
      actionId: String(a.actionId ?? ''),
      actor: String(a.actor ?? ''),
      dialCapability: typeof a.dialCapability === 'string' ? a.dialCapability : null,
      actionTool: String(a.actionTool ?? ''),
      payload: record(a.payload),
      status: String(a.status ?? 'pending'),
      createdAt: String(a.createdAt ?? ''),
      rejectReason: typeof a.rejectReason === 'string' ? a.rejectReason : null,
    };
  });
}

export function parseTrust(body: unknown): TrustSummary | null {
  const b = record(body);
  const w = record(b.window);
  if (!Array.isArray(b.rows)) return null;
  return {
    window: { from: String(w.from ?? ''), to: String(w.to ?? '') },
    rows: b.rows.map((raw) => {
      const r = record(raw);
      return {
        capability: String(r.capability ?? ''),
        stored: r.stored === 'auto' ? 'auto' : 'ask',
        effective: r.effective === 'auto' ? 'auto' : 'ask',
        strongDefault: r.strongDefault === true,
        updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : null,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
        proposed: typeof r.proposed === 'number' ? r.proposed : 0,
        approved: typeof r.approved === 'number' ? r.approved : 0,
        rejected: typeof r.rejected === 'number' ? r.rejected : 0,
        autoExecuted: typeof r.autoExecuted === 'number' ? r.autoExecuted : 0,
        lastAt: typeof r.lastAt === 'string' ? r.lastAt : null,
        suggestGrant: r.suggestGrant === true,
      } satisfies TrustRow;
    }),
  };
}

/**
 * The dash-versus-zero rule (design §3g), in ONE place so no column can disagree: `-` when nothing
 * was ever counted (no attempt of this kind), the figure otherwise, `0` included, because a zero
 * with attempts behind it means something a dash would hide.
 */
export function countCell(count: number, attempted: boolean): string {
  return attempted ? String(count) : '-';
}

/* ------------------------------------------------- per-workspace browser state (G16 precedent) */

const dockKey = (workspaceId: string) => `till.agent.dock.${workspaceId}`;
const dismissKey = (workspaceId: string, capability: string) => `till.agent.suggest.${workspaceId}.${capability}`;

export function readDockOpen(workspaceId: string): boolean {
  try {
    return localStorage.getItem(dockKey(workspaceId)) === 'open';
  } catch {
    return false;
  }
}

export function writeDockOpen(workspaceId: string, open: boolean): void {
  try {
    localStorage.setItem(dockKey(workspaceId), open ? 'open' : 'closed');
  } catch {
    // Private mode: the dock simply forgets, which is the collapsed default anyway.
  }
}

/** D90 D-3: a declined suggestion never nags again, per capability, per workspace. */
export function isSuggestionDismissed(workspaceId: string, capability: string): boolean {
  try {
    return localStorage.getItem(dismissKey(workspaceId, capability)) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissSuggestion(workspaceId: string, capability: string): void {
  try {
    localStorage.setItem(dismissKey(workspaceId, capability), 'dismissed');
  } catch {
    // Nothing to do: the suggestion will re-render, which is the lesser harm.
  }
}
