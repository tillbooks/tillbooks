/**
 * A26/A35, THE VORSCHLÄGE in Pendenzen: every drafted agent act still waiting for a person, as two queues
 * over one table (D178), and what the batch may touch.
 *
 * FILING (D178 point 11). A Vorschlag whose drafted act belongs to the rail's Bank group (the bank inbox,
 * Zahlungen, Kreditorenzahlungen, Bankkonten) is `agent_action_bank`, under Bank; every other one is
 * `agent_action`, under System. `isBankVorschlag` and its SQL twin decide it, so the two queues partition
 * the rows exactly.
 *
 * THE BATCH REACH (D178 point 5, critic N4 M1, orchestrator ruling 21.10.2026). Filing under Bank does NOT
 * make a Vorschlag batchable. Only the DECISIONS ON A BANK LINE are (`BATCHABLE_VERBS`): booking a line,
 * setting it aside, and matching it to an entry, bill or payment already on the books. An IBAN redirect, the
 * QR auto-apply switch, a payment transmission, a channel disconnect, a new Bankkonto stay in the Bank
 * section with their own single Genehmigen and never get a box. The engine says it on the item
 * (`batchable`), and the Studio keys on nothing else.
 *
 * THE LINE'S FACTS (critic N4 M2). A Vorschlag that names a bank line carries that line's SIGNED amount
 * (credit positive, debit negative), its currency and its booking date, read tenant-scoped from the line,
 * so a total is never guessed and a booking whose target names no amount still shows what it books. And its
 * target in words (the account, the Buchungsregel, or what kind of decision it is).
 *
 * A STALE BANK-LINE VORSCHLAG STAYS (D178, the design judge 21.10.2026). A Vorschlag whose pinned records
 * changed is never approvable (D162). Approving one voids it (`stale`), and it used to vanish from the list
 * the moment the batch refused it, so the badge fell by an approval that never happened. Now a stale
 * Vorschlag that names a line which is STILL OPEN stays listed, counted, with one way on (open the line in
 * the bank), until the line is decided or the agent proposes it again; the line itself is then not counted
 * a second time among the waiting lines (`staleLineDrafts`, used by `bank_lines_waiting`). A pending one
 * whose records changed reads the same. Both carry the kind `do`: they wait for a person to book the line,
 * not for an approval.
 */

import type { VorschlagFigures } from '../agent/vorschlagPin.js';
import type { WorkspaceContext } from '../context.js';
import { listDraftedActions, CONSEQUENCE_FOR_ACTION } from '../agent/index.js';
import { LINE_STATE_EXPR, LINE_STATE_JOINS } from '../banking/bankLines.js';
import type { AttentionDecisionOption, AttentionItem, QueueProvider } from './types.js';

/**
 * The drafted verbs that file a Vorschlag under Bank: the verbs whose owning surface sits in the rail's
 * Bank group. Every entry is a registered verb (held by `test/attention/attention-sections.test.mjs`); a
 * verb not listed stays a System Vorschlag. `expense_claim_reimburse` files under Bank only when it pays
 * from a Bankkonto (`bankAccountId`, D178 point 4's Spesen matching): see `isBankVorschlag`.
 */
export const BANK_VORSCHLAG_VERBS: readonly string[] = [
  // A39, the bank inbox: the line decisions and the Buchungsregeln.
  'book_bank_line',
  'ignore_bank_line',
  'reopen_bank_line',
  'set_bank_standard',
  'clear_bank_standard',
  // A20 statements and matching.
  'import_camt',
  'import_camt_files',
  'confirm_match',
  'create_entry_for_txn',
  // D178 points 4 and 19 (A20 §11.4): the statement door, the CSV mapping, the duplicate answer.
  'import_bank_statement',
  'set_bank_csv_mapping',
  'resolve_possible_duplicate',
  // A21, the QR Abgleich.
  'apply_qr_match',
  'override_qr_match',
  'record_incoming_credit',
  'set_qr_auto_apply',
  // A14, Zahlungen.
  'record_payment',
  'allocate_payment',
  'reverse_payment',
  'set_write_off_threshold',
  // A18 / A40, Kreditorenzahlungen.
  'create_payment_batch',
  'generate_pain001',
  'discard_payment_batch',
  'mark_batch_paid',
  'payment_batch_transmit',
  'liquidity_plan_draft_batches',
  'set_creditor_bank_profile',
  // A19 / A33 / A36, Bankkonten and the bank channel.
  'create_bank_account',
  'update_bank_account',
  'set_bank_opening_balance',
  'bank_channel_connect',
  'bank_channel_disconnect',
  'bank_sync',
  'set_bank_sync_schedule',
  'confirm_statement_gap',
  'revoke_statement_gap_confirmation',
];

/** Filed under Bank only with this payload field (a reimbursement paid from a Bankkonto). */
const BANK_WHEN_PAID_FROM_ACCOUNT = 'expense_claim_reimburse';

/**
 * THE BATCH REACH: the decisions on a bank line, and nothing else. Booking a line (`book_bank_line`), setting
 * it aside (`ignore_bank_line`) and matching it to a bill or an entry already on the books (`confirm_match`).
 * Each is still approved by the human-only, stale-pinned `approve_drafted_action`, one row at a time.
 */
export const BATCHABLE_VERBS: readonly string[] = ['book_bank_line', 'ignore_bank_line', 'confirm_match'];

/** The drafted verbs that name ONE open bank line by `bankTxnId` and decide it (the stale rule's scope). */
const LINE_DECISION_VERBS: readonly string[] = ['book_bank_line', 'ignore_bank_line', 'confirm_match', 'create_entry_for_txn'];

const BANK_SET: ReadonlySet<string> = new Set(BANK_VORSCHLAG_VERBS);
const BATCHABLE_SET: ReadonlySet<string> = new Set(BATCHABLE_VERBS);

/** Is a drafted verb a bank Vorschlag by its name alone (D178)? */
export function isBankVorschlagVerb(verb: string): boolean {
  return BANK_SET.has(verb);
}

/** Is this drafted act a bank Vorschlag (the verb, and for a reimbursement, whether it pays from a Bankkonto)? */
export function isBankVorschlag(verb: string, payload: Readonly<Record<string, unknown>>): boolean {
  if (BANK_SET.has(verb)) return true;
  return verb === BANK_WHEN_PAID_FROM_ACCOUNT && typeof payload.bankAccountId === 'string' && payload.bankAccountId !== '';
}

/** May the batch act on a Vorschlag of this verb (critic N4 M1)? */
export function isBatchable(verb: string): boolean {
  return BATCHABLE_SET.has(verb);
}

const AGENT_ACTION_ENTITY_KIND = 'agent_action';

const q = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** SQL, true for a bank Vorschlag under alias `a`; binds `BANK_VORSCHLAG_VERBS` then the reimbursement verb. */
const BANK_SQL = (a: string) =>
  `(${a}.action_tool IN (${q(BANK_VORSCHLAG_VERBS.length)}) OR (${a}.action_tool = ? AND COALESCE(json_extract(${a}.payload_json, '$.bankAccountId'), '') <> ''))`;
const BANK_BINDS: readonly string[] = [...BANK_VORSCHLAG_VERBS, BANK_WHEN_PAID_FROM_ACCOUNT];

/**
 * SQL, true for a Vorschlag Pendenzen lists, under alias `a`: every pending one, and a STALE one that names
 * a line which is still open and is the newest Vorschlag of that line (a later draft, pending or stale,
 * takes its place). Binds `LINE_DECISION_VERBS` twice.
 */
const LISTED_SQL = (a: string) => `(
  ${a}.status = 'pending'
  OR (
    ${a}.status = 'stale'
    AND ${a}.action_tool IN (${q(LINE_DECISION_VERBS.length)})
    AND EXISTS (
      SELECT 1 FROM bank_txn t ${LINE_STATE_JOINS('t')}
       WHERE t.workspace_id = ${a}.workspace_id
         AND t.id = json_extract(${a}.payload_json, '$.bankTxnId')
         AND ${LINE_STATE_EXPR('t')} = 'open')
    AND NOT EXISTS (
      SELECT 1 FROM agent_action b
       WHERE b.workspace_id = ${a}.workspace_id AND b.id <> ${a}.id
         AND b.action_tool IN (${q(LINE_DECISION_VERBS.length)})
         AND json_extract(b.payload_json, '$.bankTxnId') = json_extract(${a}.payload_json, '$.bankTxnId')
         AND (b.status = 'pending'
              OR (b.status = 'stale' AND (b.created_at > ${a}.created_at OR (b.created_at = ${a}.created_at AND b.rowid > ${a}.rowid)))))
  ))`;
const LISTED_BINDS: readonly string[] = [...LINE_DECISION_VERBS, ...LINE_DECISION_VERBS];

/** The ids of the listed STALE line Vorschläge and the line each names (tenant-bound). */
export function staleLineDrafts(ctx: WorkspaceContext): { actionId: string; bankTxnId: string }[] {
  return ctx.store.db
    .prepare(
      `SELECT a.id AS actionId, json_extract(a.payload_json, '$.bankTxnId') AS bankTxnId
         FROM agent_action a
        WHERE a.workspace_id = ? AND a.status = 'stale' AND ${LISTED_SQL('a')}`,
    )
    .all(ctx.workspaceId, ...LISTED_BINDS) as { actionId: string; bankTxnId: string }[];
}

interface LineFacts {
  amountMinor: number;
  currency: string;
  date: string;
  /** Who the money came from or went to, as the bank reported it ('' when the line names nobody). */
  counterparty: string;
}

/** The named line's signed amount, currency, booking date and counterparty (tenant-bound), or null. */
function lineFacts(ctx: WorkspaceContext, bankTxnId: unknown): LineFacts | null {
  if (typeof bankTxnId !== 'string' || bankTxnId === '') return null;
  const row = ctx.store.db
    .prepare(
      `SELECT t.amount_minor, t.currency, t.credit_debit, t.booking_date, t.value_date, t.payer_name, d.counterparty_name
         FROM bank_txn t
         LEFT JOIN bank_txn_detail d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND t.id = ?`,
    )
    .get(ctx.workspaceId, bankTxnId) as
    | {
        amount_minor: number;
        currency: string;
        credit_debit: string;
        booking_date: string | null;
        value_date: string | null;
        payer_name: string | null;
        counterparty_name: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  const abs = Math.abs(row.amount_minor);
  return {
    amountMinor: row.credit_debit === 'CRDT' ? abs : -abs,
    currency: row.currency,
    date: row.booking_date ?? row.value_date ?? '',
    counterparty: (row.counterparty_name ?? row.payer_name ?? '').trim(),
  };
}

/** An account in words: "6500 Verwaltungs- und Bürokosten" (tenant-bound), or ''. */
function accountWords(ctx: WorkspaceContext, accountId: unknown): string {
  if (typeof accountId !== 'string' || accountId === '') return '';
  const row = ctx.store.db.prepare('SELECT number, name FROM account WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, accountId) as
    | { number: string; name: string }
    | undefined;
  return row === undefined ? '' : `${row.number} ${row.name}`;
}

/** The first leg's account in words, and "+n" for the legs after it: "6500 Büromaterial +1". */
function legsWords(ctx: WorkspaceContext, legs: readonly Record<string, unknown>[]): string {
  const first = accountWords(ctx, legs[0]?.accountId ?? legs[0]?.account);
  return legs.length > 1 && first !== '' ? `${first} +${legs.length - 1}` : first;
}

/**
 * What a line decision books onto, as the meta line names it: ALWAYS the booking account in words, number
 * and name (and how many more legs), the one meaning of that slot (the fresh-eyes judge, N4 M3), so a
 * Buchungsregel is named by the account its recipe books to, never by its label; or the kind of decision
 * the Studio words (`targetKind`) when nothing is booked to an account.
 */
function targetOf(ctx: WorkspaceContext, tool: string, payload: Readonly<Record<string, unknown>>): { target: string; targetKind: string } {
  if (tool === 'ignore_bank_line') return { target: '', targetKind: 'ignore' };
  if (tool === 'confirm_match') return { target: '', targetKind: typeof payload.entryId === 'string' ? 'existing_entry' : 'open_item' };
  if (tool === 'create_entry_for_txn') return { target: accountWords(ctx, payload.accountId), targetKind: 'accounts' };
  const target = payload.target !== null && typeof payload.target === 'object' ? (payload.target as Record<string, unknown>) : null;
  const kind = typeof target?.kind === 'string' ? target.kind : '';
  if (kind === 'accounts') {
    const legs = Array.isArray(target?.legs) ? (target.legs as Record<string, unknown>[]) : [];
    return { target: legsWords(ctx, legs), targetKind: 'accounts' };
  }
  if (kind === 'rule') {
    // The rule's recipe as it stands NOW (a changed rule makes the Vorschlag stale, so a pending one names
    // what it will book): its legs, or the one-leg D167 standard's account.
    const rule = typeof target?.standardId === 'string'
      ? (ctx.store.db
          .prepare('SELECT account_id, legs_json FROM bank_standard WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, target.standardId) as { account_id: string | null; legs_json: string | null } | undefined)
      : undefined;
    let legs: Record<string, unknown>[] = [];
    try {
      const parsed: unknown = rule?.legs_json ? JSON.parse(rule.legs_json) : null;
      if (Array.isArray(parsed)) legs = parsed as Record<string, unknown>[];
    } catch {
      legs = [];
    }
    const words = legs.length > 0 ? legsWords(ctx, legs) : accountWords(ctx, rule?.account_id);
    return { target: words, targetKind: 'rule' };
  }
  return { target: '', targetKind: kind };
}

/**
 * Does approving this batchable decision MINT a journal entry (critic N4 R2-M2)? Setting a line aside never
 * does; matching it to an entry already in the books never does; a booking to accounts or by a Buchungsregel
 * does, a settlement of an open item does, and a payment run does only while it is not yet paid. The Studio
 * lights the money accent, and claims the booking, only over a selection that holds such a row.
 */
function postsEntry(ctx: WorkspaceContext, tool: string, payload: Readonly<Record<string, unknown>>): boolean {
  if (tool === 'ignore_bank_line') return false;
  if (tool === 'confirm_match') return typeof payload.entryId !== 'string';
  if (tool !== 'book_bank_line') return false;
  const target = payload.target !== null && typeof payload.target === 'object' ? (payload.target as Record<string, unknown>) : null;
  const kind = typeof target?.kind === 'string' ? target.kind : '';
  if (kind === 'accounts' || kind === 'rule' || kind === 'open_item') return true;
  if (kind === 'payment_batch' && typeof target?.batchId === 'string') {
    const batch = ctx.store.db.prepare('SELECT status FROM payment_batch WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, target.batchId) as
      | { status: string }
      | undefined;
    return batch !== undefined && (batch.status === 'draft' || batch.status === 'generated');
  }
  return false;
}

/**
 * The consequence of a DRAFTED Vorschlag, keyed on the tier the transport seam STORED when it drafted (non-
 * author critic F1, D141.5 R4-1): "Genehmigen und künftig automatisch" grants exactly that stored tier.
 */
function draftedConsequenceOf(verb: string, storedCapability: unknown): { consequenceKey: string | null; consequence: string | null } {
  return {
    consequenceKey: typeof storedCapability === 'string' && storedCapability.length > 0 ? `agent.consequence.${storedCapability}` : null,
    consequence: CONSEQUENCE_FOR_ACTION[verb] ?? null,
  };
}

/** One Vorschlag as a hub row. */
function vorschlagItem(ctx: WorkspaceContext, queueId: string, a: Record<string, unknown>, stale: boolean): AttentionItem {
  const actionId = String(a.actionId);
  const tool = String(a.actionTool ?? '');
  const payload = a.payload !== null && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
  const deepLink = { route: '/agent', params: { actionId } };
  const changed = stale || a.changedSinceProposal === true;
  const facts = LINE_DECISION_VERBS.includes(tool) ? lineFacts(ctx, payload.bankTxnId) : null;
  // Critic N4 R2-M1: the line's amount, date and counterparty and the Buchungsregel's account are bank facts
  // (list_bank_inbox, list_bank_standards: read_sales). A seat that reads the books but not the bank sees the
  // Vorschlag without them, exactly as its own reads would show it.
  const shown = facts !== null && ctx.capabilities.assert('read_sales').ok ? facts : null;
  const options: AttentionDecisionOption[] = [];
  // The one way on for a Vorschlag that can no longer be approved: the line itself, in the bank.
  if (changed && facts !== null) {
    options.push({
      id: 'check_in_bank',
      verb: null,
      labelKey: 'attention.act.checkInBank',
      role: 'link',
      input: {},
      deepLink: { route: '/bank', params: { line: String(payload.bankTxnId) } },
    });
  }
  // A stale row is void in the engine: it can neither be approved nor rejected any more.
  if (!stale) {
    options.push(
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'agent.card.approve', role: 'primary', input: { actionId }, capability: 'manage_agent_dial' },
      {
        id: 'approve_allow',
        verb: 'approve_drafted_action',
        labelKey: 'agent.card.approveAllow',
        role: 'secondary',
        input: { actionId, allowFuture: true },
        capability: 'manage_agent_dial',
        hintKey: 'agent.card.grantHint',
      },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'agent.card.reject', role: 'danger', input: { actionId }, capability: 'manage_agent_dial', reasonField: true },
    );
  }
  const subtitleParams: Record<string, string | number> = { tool };
  if (shown !== null) {
    subtitleParams.date = shown.date;
    // The counterparty leads the row's title in the Studio (the fresh-eyes judge, N4 M3).
    if (shown.counterparty !== '') subtitleParams.counterparty = shown.counterparty;
    const { target, targetKind } = targetOf(ctx, tool, payload);
    subtitleParams.target = target;
    subtitleParams.targetKind = targetKind;
  }
  return {
    queueId,
    entityKind: AGENT_ACTION_ENTITY_KIND,
    entityId: actionId,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams,
    ...(shown !== null ? { amountMinor: shown.amountMinor, currency: shown.currency } : {}),
    since: String(a.createdAt ?? ''),
    urgency: 'open',
    deepLink,
    ...(typeof a.actor === 'string' ? { proposedBy: a.actor } : {}),
    decisionOptions: options,
    ...draftedConsequenceOf(tool, a.dialCapability),
    // Critic N1: what is being approved, as the agent proposed it, and whether it changed since.
    ...(a.figures !== undefined ? { figures: a.figures as VorschlagFigures | null } : {}),
    ...(changed ? { changedSinceProposal: true } : {}),
    ...(stale ? { stale: true } : {}),
    // D178 M1: the batch reaches the decisions on a bank line only, and never a changed one.
    batchable: !changed && isBatchable(tool),
    // R2-M2: whether approving this batchable row mints a journal entry (the accent's one fact).
    ...(!changed && isBatchable(tool) ? { posts: postsEntry(ctx, tool, payload) } : {}),
    // A Vorschlag that can no longer be approved waits for a person to decide the line: Erledigen.
    ...(changed ? { kind: 'do' as const } : {}),
  };
}

/**
 * One of the two Vorschläge queues. Each counts its own rows with a true COUNT over the same table, split by
 * `isBankVorschlag`, so a Vorschlag is in exactly one queue and the two add up to every listed row.
 */
export function vorschlagProvider(queueId: string, labelKey: string, area: string, bank: boolean): QueueProvider {
  const filter = `${bank ? '' : 'NOT '}${BANK_SQL('a')}`;
  return {
    queueId,
    labelKey,
    area,
    kind: 'approve',
    readCapability: 'read_books',
    rank: 5,
    freshness: 'stored',
    dismissal: 'module_dismiss',
    deepLinkRoute: '/agent',
    count(ctx: WorkspaceContext): number {
      const row = ctx.store.db
        .prepare(`SELECT COUNT(*) AS n FROM agent_action a WHERE a.workspace_id = ? AND ${filter} AND ${LISTED_SQL('a')}`)
        .get(ctx.workspaceId, ...BANK_BINDS, ...LISTED_BINDS) as { n: number };
      return row.n;
    },
    list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
      const keep = (a: Record<string, unknown>) =>
        isBankVorschlag(String(a.actionTool ?? ''), a.payload !== null && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {}) === bank;
      const pending = okActions(listDraftedActions(ctx, { status: 'pending' }) as never, queueId).filter(keep);
      const staleIds = new Set(staleLineDrafts(ctx).map((s) => s.actionId));
      const stale = staleIds.size === 0 ? [] : okActions(listDraftedActions(ctx, { status: 'stale' }) as never, queueId).filter((a) => staleIds.has(String(a.actionId)) && keep(a));
      const items = [...pending.map((a) => vorschlagItem(ctx, queueId, a, false)), ...stale.map((a) => vorschlagItem(ctx, queueId, a, true))];
      return items.slice(0, opts.limit);
    },
  };
}

/** The actions of an Ok `list_drafted_actions`; a refusal is a failed provider (it throws). */
function okActions(res: { ok: boolean } & Record<string, unknown>, queueId: string): Record<string, unknown>[] {
  if (res.ok !== true) throw new Error(`attention provider '${queueId}' read failed: ${String((res as { error?: unknown }).error)}`);
  return Array.isArray(res.actions) ? (res.actions as Record<string, unknown>[]) : [];
}
