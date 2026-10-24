/**
 * A35's read-model helpers: parsers over the four agent reads, the Geld/System grouping, and the per-capability suggestion dismissal (D90 D-3). Parsing is
 * defensive: a shape the surface cannot read renders as absent, never as a crash or a guessed figure.
 */

import { formatMoney } from '../../i18n';
import en from './messages.en.json';
import sharedEn from '../../i18n/en.json';

export type DialLevel = 'ask' | 'auto';

type VerbCatalogue = { agent: { verb: Record<string, string> } };

/**
 * The verbs this surface carries a human label for: its own catalogue slice AND the shared
 * `agent.verb.*` labels (every dial-governed verb, held by `test/attention/verb-labels.test.mjs`), since
 * the fragment deep-merges onto the shared catalogue and `t` resolves both. Reading only the slice left
 * every shared-only verb (the A39 bank-line verbs among them) rendered as its raw name here while the
 * Pendenzen surface labelled it. An unlabelled verb renders its name with the underscores replaced and
 * the raw key as the row's title: not a translation, and honestly not one.
 */
export const LABELLED_VERBS: ReadonlySet<string> = new Set([
  ...Object.keys((en as VerbCatalogue).agent.verb),
  ...Object.keys((sharedEn as VerbCatalogue).agent.verb),
]);

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

/**
 * Critic N1 (what you approved is what runs): the key figures of the record a Vorschlag acts on, as the
 * engine froze them when the agent proposed it. Every field may be absent; an absent figure is not
 * shown, never guessed.
 */
export interface VorschlagFigures {
  number: string | null;
  /** The record is numbered once issued and has no number yet: the card says it is a draft. */
  numberPending: boolean;
  counterparty: string | null;
  /** Critic round 2 (R2-B1): the email(s) a send goes to, as the person approved them. */
  recipient: string | null;
  amountMinor: number | null;
  /** `net` labels the amount Netto (VAT is added at issue); `amount` labels it Betrag. */
  amountBasis: 'net' | 'amount' | null;
  currency: string | null;
  /** The VAT the act computes at the pinned rate, and the gross beside the net (critic round 2). */
  taxMinor: number | null;
  grossMinor: number | null;
  lineCount: number | null;
}

export interface DraftedAction {
  actionId: string;
  actor: string;
  dialCapability: string | null;
  actionTool: string;
  payload: Record<string, unknown>;
  /**
   * The engine's human names for contact ids in the payload (`vendorId` -> the vendor's name), keyed
   * by payload key. Empty when there are none; the card then shows the raw id, never a guess.
   */
  payloadLabels?: Record<string, string>;
  status: string;
  createdAt: string;
  /** The human's sentence on a rejected proposal (F-08, J5.6), or null. */
  rejectReason: string | null;
  /** The figures frozen at the proposal (critic N1), or null when the verb names no pinned record. */
  figures?: VorschlagFigures | null;
  /** The pinned record changed after the proposal: approving would refuse `vorschlag_stale`. */
  changedSinceProposal?: boolean;
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
  /** Where a drafting call's proposal went (`pending` | `executed` | `rejected` | `stale`), null on a non-draft. */
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
// D161: `stock` joins the Geld group: stock is the balance sheet's inventory, valued and moved beside the
// money families, though no journal entry is minted by it.
export const GELD_CAPABILITIES = ['post', 'issue', 'send', 'dun', 'pay', 'vat-file', 'stock'] as const;
// D156: `erase` and `share` join the System group: neither moves money, and both are about what
// leaves or what goes for good, which the Vertrauen table must show beside the other governing acts.
export const SYSTEM_CAPABILITIES = ['customize', 'plugin-install', 'close-period', 'go-live', 'erase', 'share'] as const;

/** The Studio's trace-collapse threshold: one number for every rendered trace. */
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
      payloadLabels: Object.fromEntries(
        Object.entries(record(a.payloadLabels)).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
      ),
      status: String(a.status ?? 'pending'),
      createdAt: String(a.createdAt ?? ''),
      rejectReason: typeof a.rejectReason === 'string' ? a.rejectReason : null,
      figures: parseFigures(a.figures),
      changedSinceProposal: a.changedSinceProposal === true,
    };
  });
}

/** The frozen figures, defensively: a shape the card cannot read is absent, never a guessed figure. */
export function parseFigures(raw: unknown): VorschlagFigures | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    number: text(f.number),
    numberPending: f.numberPending === true,
    counterparty: text(f.counterparty),
    recipient: text(f.recipient),
    amountMinor: int(f.amountMinor),
    amountBasis: f.amountBasis === 'net' || f.amountBasis === 'amount' ? f.amountBasis : null,
    currency: text(f.currency),
    taxMinor: int(f.taxMinor),
    grossMinor: int(f.grossMinor),
    lineCount: int(f.lineCount),
  };
}

/** The frozen figures as one line: "Entwurf, noch ohne Nummer · Muster AG · Netto CHF 1'000.00 · 2 Positionen". */
export function figuresLine(t: (key: string, params?: Record<string, string | number>) => string, f: VorschlagFigures): string | null {
  const parts: string[] = [];
  if (f.number !== null) parts.push(f.number);
  else if (f.numberPending) parts.push(t('agent.card.figure.draft'));
  if (f.counterparty !== null) parts.push(f.counterparty);
  if (f.recipient !== null) parts.push(`${t('agent.card.figure.recipient')} ${f.recipient}`);
  if (f.amountMinor !== null) {
    const label = f.amountBasis === 'net' ? t('agent.card.figure.net') : t('agent.field.amount');
    parts.push(`${label} ${formatMoney(f.amountMinor, f.currency ?? 'CHF')}`);
  }
  if (f.taxMinor !== null && f.grossMinor !== null) {
    parts.push(`${t('agent.card.figure.vat')} ${formatMoney(f.taxMinor, f.currency ?? 'CHF')}`);
    parts.push(`${t('agent.card.figure.gross')} ${formatMoney(f.grossMinor, f.currency ?? 'CHF')}`);
  }
  if (f.lineCount !== null) parts.push(`${f.lineCount} ${t('agent.card.figure.lines')}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The approval refusal for a Vorschlag whose record changed after the proposal (critic N1). */
export const VORSCHLAG_STALE = 'vorschlag_stale';

/** The acknowledgement a decision lands on, per outcome: one map for every decision surface. */
export const DECIDED_MESSAGE = {
  approved: 'agent.card.executed',
  rejected: 'agent.card.rejected',
  stale: 'agent.card.stale',
} as const;

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

const dismissKey = (workspaceId: string, capability: string) => `till.agent.suggest.${workspaceId}.${capability}`;

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
