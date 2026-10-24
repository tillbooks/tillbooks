/**
 * Test fixtures for Pendenzen: a grouped `attention_list` answer built from item fixtures, so a suite
 * states the rows and gets the engine's shape (sections in the engine's order, each with its count). The
 * queue-to-area table mirrors the engine's registry (`src/core/attention/providers.ts`) for fixtures only;
 * the surface itself never groups, sorts or counts.
 */

const QUEUE: Readonly<Record<string, { area: string; kind: string }>> = {
  agent_action_bank: { area: 'bank', kind: 'approve' },
  agent_action: { area: 'system', kind: 'approve' },
  qr_match: { area: 'bank', kind: 'note' },
  review_flag: { area: 'accounting', kind: 'note' },
  dunning_run: { area: 'sales', kind: 'approve' },
  checklist_items_due: { area: 'accounting', kind: 'do' },
  bank_statement_gap: { area: 'bank', kind: 'do' },
  bank_lines_waiting: { area: 'bank', kind: 'do' },
  bank_fetch_failed: { area: 'bank', kind: 'do' },
  bank_keys_review: { area: 'bank', kind: 'do' },
  bank_activation: { area: 'bank', kind: 'do' },
};

const AREAS = ['bank', 'accounting', 'sales', 'system'];
const KINDS = ['approve', 'do', 'note'];

type Row = Record<string, unknown>;

export interface GroupedOptions {
  grouping?: 'by_area' | 'by_kind';
  failed?: string[];
  visibleQueues?: number;
  approvalBatchMode?: 'tick' | 'single' | 'all_with_confirm';
  computedAt?: string;
  /** Per section: the count the engine would report beyond these rows, and the cursor to the rest. */
  more?: Record<string, { count: number; nextCursor: string }>;
}

/** The grouped answer for these rows, in the given row order inside each section. */
export function groupedOf(rows: Row[], opts: GroupedOptions = {}): Row {
  const grouping = opts.grouping ?? 'by_area';
  const placed: (Row & { count: number; area: string; kind: string })[] = rows.map((r) => {
    const q = QUEUE[String(r.queueId)] ?? { area: 'system', kind: 'note' };
    return { count: 1, area: q.area, kind: q.kind, ...r } as Row & { count: number; area: string; kind: string };
  });
  const keys = grouping === 'by_area' ? AREAS : KINDS;
  const sections = keys
    .map((key) => {
      const items = placed.filter((r) => (grouping === 'by_area' ? r.area : r.kind) === key);
      const extra = opts.more?.[key];
      const count = items.reduce((n, r) => n + Number(r.count), 0) + (extra?.count ?? 0);
      return {
        key,
        count,
        queues: [...new Set(items.map((r) => String(r.queueId)))],
        items,
        ...(extra !== undefined ? { nextCursor: extra.nextCursor } : {}),
      };
    })
    .filter((s) => s.items.length > 0);
  const total = sections.reduce((n, s) => n + s.count, 0);
  return {
    computedAt: opts.computedAt ?? '2026-10-21T08:21:00.000Z',
    grouping,
    visibleQueues: opts.visibleQueues ?? 3,
    total: (opts.visibleQueues ?? 3) === 0 ? null : total,
    incomplete: (opts.failed ?? []).length > 0,
    failed: opts.failed ?? [],
    approvalBatchMode: opts.approvalBatchMode ?? 'tick',
    sections: (opts.visibleQueues ?? 3) === 0 ? [] : sections,
  };
}

/**
 * A bank Vorschlag row (`book_bank_line`), as the engine sends it: batchable (a decision on a bank line), the
 * line's signed amount and currency, and the meta facts (target, date).
 */
export function bankVorschlag(actionId: string, over: Row = {}): Row {
  return {
    queueId: 'agent_action_bank',
    entityKind: 'agent_action',
    entityId: actionId,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams: { tool: 'book_bank_line', date: '2026-10-20', target: '6500 Büromaterial', targetKind: 'accounts' },
    amountMinor: -4520,
    currency: 'CHF',
    batchable: true,
    // A booking to accounts mints an entry (the engine's `posts`, critic N4 R2-M2).
    posts: true,
    since: '2026-10-21T07:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/agent', params: { actionId } },
    proposedBy: 'agent',
    decisionOptions: [
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'agent.card.approve', role: 'primary', input: { actionId }, capability: 'manage_agent_dial' },
      { id: 'approve_allow', verb: 'approve_drafted_action', labelKey: 'agent.card.approveAllow', role: 'secondary', input: { actionId, allowFuture: true }, capability: 'manage_agent_dial', hintKey: 'agent.card.grantHint' },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'agent.card.reject', role: 'danger', input: { actionId }, capability: 'manage_agent_dial', reasonField: true },
    ],
    consequenceKey: 'agent.consequence.post',
    consequence: null,
    figures: null,
    changedSinceProposal: false,
    ...over,
  };
}

/** The drafted payload `list_drafted_actions` answers for a bank Vorschlag: one leg of `amountMinor`. */
export function draftedBankLine(actionId: string, text: string, amountMinor: number): Row {
  return {
    actionId,
    actor: 'agent',
    dialCapability: 'post',
    actionTool: 'book_bank_line',
    payload: { bankTxnId: `btx_${actionId}`, text, target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor }] }, idempotencyKey: `k_${actionId}` },
    status: 'pending',
    createdAt: '2026-10-21T07:00:00.000Z',
  };
}

/** The aggregate bank-lines row: one Bankkonto, N lines. */
export function linesRow(count: number): Row {
  const deepLink = { route: '/bank', params: { facet: 'needs', account: 'bank_1' } };
  return {
    queueId: 'bank_lines_waiting',
    entityKind: 'bank_account',
    entityId: 'bank_1',
    titleKey: `attention.item.bankLines.title.${count === 1 ? 'one' : 'other'}`,
    titleParams: { bank: 'Testbank Betriebskonto', count },
    subtitleKey: 'attention.item.bankLines.subtitle',
    subtitleParams: { bank: 'Testbank Betriebskonto' },
    count,
    since: '2026-10-16',
    urgency: 'open',
    deepLink,
    decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.openBankLines', role: 'link', input: {}, deepLink }],
    reasonCode: 'needs_person',
    reasonKey: null,
    consequenceKey: null,
    consequence: null,
  };
}
