/**
 * Pendenzen's read model in the Studio (D178 point 11): the grouped `attention_list` answer, parsed
 * defensively. The engine is the only source of every figure and every order: this module parses and
 * forwards, it never counts, sorts or regroups (the section counts, the row counts and the order inside a
 * section all arrive from the engine, so the badge and the page cannot disagree here).
 */
import { parseFigures, type DraftedAction, type VorschlagFigures } from '../Agent/model';
import { parseActorKind, parseDecisionOptions, type ActorKind, type DecisionOption } from './RowDecision';

export type Urgency = 'overdue' | 'due' | 'open';
export type Grouping = 'by_area' | 'by_kind';
export type BatchMode = 'tick' | 'single' | 'all_with_confirm';

export interface Item {
  queueId: string;
  entityKind: string;
  entityId: string;
  titleKey: string;
  titleParams: Record<string, string | number>;
  subtitleKey?: string;
  subtitleParams?: Record<string, string | number>;
  amountMinor?: number;
  currency?: string;
  since: string;
  dueAt?: string;
  urgency: Urgency;
  deepLink: { route: string; params: Record<string, string> };
  collapsedWithQueueId?: string;
  decisionOptions?: DecisionOption[];
  suggestedInvoiceId?: string | null;
  suggestedInvoiceNumber?: string | null;
  reasonCode?: string | null;
  reasonKey?: string | null;
  consequenceKey?: string | null;
  proposedBy?: string;
  proposedByKind?: ActorKind;
  /** Critic N1, Vorschlag rows: the figures frozen at the proposal, and whether the record changed. */
  figures?: VorschlagFigures | null;
  changedSinceProposal?: boolean;
  /** D178: the units this row stands for (1, or N for an aggregate row). */
  count: number;
  area: string;
  kind: string;
  /** D178 point 5 (critic N4 M1): the engine says this Vorschlag may be batched (a bank-line decision, unchanged). */
  batchable: boolean;
  /** Critic N4 R2-M2: approving this batchable row mints a journal entry (the engine's fact). */
  posts: boolean;
  /** D178: a Vorschlag the engine voided as stale, kept listed while its bank line is open. */
  stale: boolean;
  /** N03: a mined Buchungsregel's Vorschlag: who for, how often booked so, its backtest and evidence. */
  ruleProposal?: RuleProposal;
  /** N04: the offer "künftig automatisch" of a proven rule (its Vorschlag row). */
  autobookOffer?: AutobookOffer;
  /** N04: one day's automatic bookings (the digest card). */
  autobookDigest?: AutobookDigest;
  /** N04 (critic F5): a Dauerbuchung's Vorschlag: the schedule was set by an agent. */
  scheduledByAgent?: boolean;
}

/** N04 (D183): the engine's facts of an autobook offer (`AttentionAutobookOffer`). */
export interface AutobookOffer {
  standardId: string;
  counterparty: string;
  label: string | null;
  cleanUses: number;
  ceilingMinor: number;
  currency: string;
}

/** N04 (D183): one line of a digest day (`AttentionAutobookDigest`). */
export interface AutobookDigestLine {
  bankTxnId: string;
  standardId: string;
  counterparty: string;
  ruleLabel: string | null;
  amountMinor: number;
  currency: string;
  lineDate: string;
  entryId: string | null;
  stands: boolean;
  reason: string | null;
  grantLive: boolean;
}

export interface AutobookDigest {
  day: string;
  lines: AutobookDigestLine[];
}

function parseAutobookOffer(raw: unknown): AutobookOffer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.standardId !== 'string' || typeof r.counterparty !== 'string' || typeof r.currency !== 'string') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { standardId: r.standardId, counterparty: r.counterparty, label: typeof r.label === 'string' ? r.label : null, cleanUses: num(r.cleanUses), ceilingMinor: num(r.ceilingMinor), currency: r.currency };
}

function parseAutobookDigest(raw: unknown): AutobookDigest | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== 'string' || !Array.isArray(r.lines)) return undefined;
  const lines = r.lines.flatMap((l): AutobookDigestLine[] => {
    const x = (l ?? {}) as Record<string, unknown>;
    if (typeof x.bankTxnId !== 'string' || typeof x.standardId !== 'string' || typeof x.currency !== 'string') return [];
    return [
      {
        bankTxnId: x.bankTxnId,
        standardId: x.standardId,
        counterparty: typeof x.counterparty === 'string' ? x.counterparty : '',
        ruleLabel: typeof x.ruleLabel === 'string' ? x.ruleLabel : null,
        amountMinor: typeof x.amountMinor === 'number' ? x.amountMinor : 0,
        currency: x.currency,
        lineDate: typeof x.lineDate === 'string' ? x.lineDate : '',
        entryId: typeof x.entryId === 'string' ? x.entryId : null,
        stands: x.stands === true,
        reason: typeof x.reason === 'string' ? x.reason : null,
        grantLive: x.grantLive === true,
      },
    ];
  });
  return { day: r.day, lines };
}

/** N03 (D183): the engine's facts of a mined rule's Vorschlag (`AttentionRuleProposal`). */
export interface RuleProposal {
  counterparty: string;
  repeats: number;
  since: string;
  hits: number;
  identical: number;
  bankTxnId: string;
  evidence: { bankTxnId: string; date: string; amountMinor: number; currency: string }[];
}

/** N03: the rule proposal an item carries, or undefined when it carries none (or a malformed one). */
function parseRuleProposal(raw: unknown): RuleProposal | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (typeof r.counterparty !== 'string' || typeof r.bankTxnId !== 'string' || typeof r.since !== 'string') return undefined;
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.flatMap((e) => {
        const x = (e ?? {}) as Record<string, unknown>;
        return typeof x.bankTxnId === 'string' && typeof x.date === 'string' && typeof x.currency === 'string'
          ? [{ bankTxnId: x.bankTxnId, date: x.date, amountMinor: num(x.amountMinor), currency: x.currency }]
          : [];
      })
    : [];
  return { counterparty: r.counterparty, repeats: num(r.repeats), since: r.since, hits: num(r.hits), identical: num(r.identical), bankTxnId: r.bankTxnId, evidence };
}

export interface Section {
  key: string;
  count: number;
  queues: string[];
  items: Item[];
  nextCursor?: string;
}

export interface Grouped {
  computedAt: string;
  grouping: Grouping;
  visibleQueues: number;
  total: number | null;
  incomplete: boolean;
  failed: string[];
  approvalBatchMode: BatchMode;
  sections: Section[];
}

/** The two Vorschläge queues (D178 split them by the drafted verb: bank and everything else). */
export const VORSCHLAG_QUEUES: ReadonlySet<string> = new Set(['agent_action', 'agent_action_bank']);
/** The batch acts on bank Vorschläge only (D178 point 5 names the bank). */
export const BATCH_QUEUE = 'agent_action_bank';
/** The engine's remainder row: the units a queue's list did not yield, opening the owning surface. */
export const REMAINDER_KIND = 'attention_remainder';

/** A Vorschlag row (drawn as a Vorschlag line). A queue's remainder row ("n weitere") is not one (critic N4 L2). */
export function isVorschlag(item: Pick<Item, 'queueId' | 'entityKind'>): boolean {
  return VORSCHLAG_QUEUES.has(item.queueId) && item.entityKind !== REMAINDER_KIND;
}

export function parseItem(raw: unknown): Item | null {
  if (raw === null || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const link = n.deepLink as { route?: unknown; params?: unknown } | undefined;
  if (typeof n.queueId !== 'string' || typeof n.entityId !== 'string' || typeof n.titleKey !== 'string') return null;
  if (link === undefined || link === null || typeof link.route !== 'string') return null;
  const urgency: Urgency = n.urgency === 'overdue' || n.urgency === 'due' ? n.urgency : 'open';
  return {
    queueId: n.queueId,
    entityKind: typeof n.entityKind === 'string' ? n.entityKind : '',
    entityId: n.entityId,
    titleKey: n.titleKey,
    titleParams: (n.titleParams ?? {}) as Record<string, string | number>,
    subtitleKey: typeof n.subtitleKey === 'string' ? n.subtitleKey : undefined,
    subtitleParams: (n.subtitleParams ?? {}) as Record<string, string | number>,
    amountMinor: typeof n.amountMinor === 'number' ? n.amountMinor : undefined,
    currency: typeof n.currency === 'string' ? n.currency : undefined,
    since: typeof n.since === 'string' ? n.since : '',
    dueAt: typeof n.dueAt === 'string' ? n.dueAt : undefined,
    urgency,
    deepLink: {
      route: link.route,
      params: link.params !== null && typeof link.params === 'object' ? (link.params as Record<string, string>) : {},
    },
    collapsedWithQueueId: typeof n.collapsedWithQueueId === 'string' ? n.collapsedWithQueueId : undefined,
    decisionOptions: parseDecisionOptions(n.decisionOptions),
    suggestedInvoiceId: typeof n.suggestedInvoiceId === 'string' ? n.suggestedInvoiceId : null,
    suggestedInvoiceNumber: typeof n.suggestedInvoiceNumber === 'string' ? n.suggestedInvoiceNumber : null,
    reasonCode: typeof n.reasonCode === 'string' ? n.reasonCode : null,
    reasonKey: typeof n.reasonKey === 'string' ? n.reasonKey : null,
    consequenceKey: typeof n.consequenceKey === 'string' ? n.consequenceKey : null,
    proposedBy: typeof n.proposedBy === 'string' ? n.proposedBy : undefined,
    proposedByKind: parseActorKind(n.proposedByKind),
    figures: parseFigures(n.figures),
    changedSinceProposal: n.changedSinceProposal === true,
    count: typeof n.count === 'number' && Number.isInteger(n.count) && n.count > 0 ? n.count : 1,
    area: typeof n.area === 'string' ? n.area : '',
    kind: typeof n.kind === 'string' ? n.kind : '',
    batchable: n.batchable === true,
    posts: n.posts === true,
    stale: n.stale === true,
    ...(parseRuleProposal(n.ruleProposal) !== undefined ? { ruleProposal: parseRuleProposal(n.ruleProposal) as RuleProposal } : {}),
    ...(parseAutobookOffer(n.autobookOffer) !== undefined ? { autobookOffer: parseAutobookOffer(n.autobookOffer) as AutobookOffer } : {}),
    ...(n.scheduledBy !== null && typeof n.scheduledBy === 'object' ? { scheduledByAgent: (n.scheduledBy as Record<string, unknown>).agent === true } : {}),
    ...(parseAutobookDigest(n.autobookDigest) !== undefined ? { autobookDigest: parseAutobookDigest(n.autobookDigest) as AutobookDigest } : {}),
  };
}

function parseSection(raw: unknown): Section | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.key !== 'string' || typeof s.count !== 'number') return null;
  return {
    key: s.key,
    count: s.count,
    queues: Array.isArray(s.queues) ? s.queues.filter((q): q is string => typeof q === 'string') : [],
    items: Array.isArray(s.items) ? s.items.map(parseItem).filter((i): i is Item => i !== null) : [],
    ...(typeof s.nextCursor === 'string' ? { nextCursor: s.nextCursor } : {}),
  };
}

/** Read the grouped answer defensively: a shape this module cannot read is a failed read, never a guessed zero. */
export function parseGrouped(body: unknown): Grouped | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.visibleQueues !== 'number' || !Array.isArray(b.sections)) return null;
  const mode = b.approvalBatchMode;
  return {
    computedAt: typeof b.computedAt === 'string' ? b.computedAt : '',
    grouping: b.grouping === 'by_kind' ? 'by_kind' : 'by_area',
    visibleQueues: b.visibleQueues,
    total: typeof b.total === 'number' ? b.total : null,
    incomplete: b.incomplete === true,
    failed: Array.isArray(b.failed) ? b.failed.filter((f): f is string => typeof f === 'string') : [],
    approvalBatchMode: mode === 'single' || mode === 'all_with_confirm' ? mode : 'tick',
    sections: b.sections.map(parseSection).filter((s): s is Section => s !== null),
  };
}

/** One more page of one section, appended; the count stays the engine's. */
export function appendPage(sections: Section[], page: Section): Section[] {
  return sections.map((s) =>
    s.key !== page.key
      ? s
      : {
          ...s,
          count: page.count,
          items: [...s.items, ...page.items.filter((i) => !s.items.some((j) => j.queueId === i.queueId && j.entityId === i.entityId))],
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : { nextCursor: undefined }),
        },
  );
}

const CONSEQUENCE_PREFIX = 'agent.consequence.';

/**
 * The Vorschlag a hub row stands for, as the line reads it: the row's own pinned figures and changed
 * flag (critic N1), the drafted payload when `list_drafted_actions` returned it (for Details and the
 * batch total), and the stored tier from the payload read, else from the row's consequence key.
 */
export function vorschlagOf(item: Item, drafted: DraftedAction | undefined): DraftedAction {
  const tool = item.subtitleParams?.tool;
  const keyed = item.consequenceKey ?? '';
  return {
    actionId: item.entityId,
    actor: item.proposedBy ?? drafted?.actor ?? '',
    dialCapability: drafted?.dialCapability ?? (keyed.startsWith(CONSEQUENCE_PREFIX) ? keyed.slice(CONSEQUENCE_PREFIX.length) : null),
    actionTool: typeof tool === 'string' && tool.length > 0 ? tool : (drafted?.actionTool ?? ''),
    // N01 US-N01.8: the agent's sentence rides from the drafted read onto the Pendenzen line.
    agentReason: drafted?.agentReason ?? null,
    payload: drafted?.payload ?? {},
    payloadLabels: drafted?.payloadLabels ?? {},
    status: 'pending',
    createdAt: drafted?.createdAt ?? item.since,
    rejectReason: null,
    figures: item.figures ?? drafted?.figures ?? null,
    changedSinceProposal: item.changedSinceProposal === true,
    // N02 (critic round 2): the Belege the approval will link, from the drafted read.
    ...(drafted?.belege !== undefined && drafted.belege.length > 0 ? { belege: drafted.belege } : {}),
    // N02 R1: the records that already hold its receipt (the card's warning).
    ...(drafted?.receiptHolders !== undefined && drafted.receiptHolders.length > 0 ? { receiptHolders: drafted.receiptHolders } : {}),
  };
}

/** `2026-10-21T08:21:00.000Z` -> `10:21`: the "Stand" time in Swiss time (it printed UTC, D178 point 4). */
export function standTime(iso: string): string {
  const d = new Date(iso);
  if (iso === '' || Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
