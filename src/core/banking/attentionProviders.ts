/**
 * D150 (A36 §4.7), THE BANK'S THREE ATTENTION QUEUES: what the Übersicht said nothing about on
 * 01.10.2026 while two bank lines waited and statements were missing.
 *
 *  - `bank_statement_gap`: one item per open statement gap (`readStatementGaps`), until the missing
 *    statements are in the books or, only when the balances chain, a person confirms nothing is missing.
 *  - `bank_lines_waiting`: one item per Bankkonto whose bank lines need a person (A39's own `needs`
 *    facet, `bankInboxAttention`), MINUS the lines a pending Vorschlag already names: those are counted
 *    by `agent_action`, so no line is counted twice.
 *  - `bank_fetch_failed`: one item per active EBICS connection whose latest automatic fetch failed and
 *    will not be retried (a refusal a person must clear, or the day's attempts are used up), until a
 *    later fetch succeeds. Worded per kind, with the bank's own code.
 *
 * Every provider is a pure read over its module's own read model, fenced by `workspace_id`
 * (§H-TENANT); none posts or clears anything. Defined beside the banking engine and spread into
 * `ATTENTION_PROVIDERS` as one line each (the G22 / D143 precedent). Entity kinds are hoisted consts
 * (the audit-vocabulary scraper must not read a provider as an audit emitter).
 */

import type { WorkspaceContext } from '../context.js';
import type { AttentionDecisionOption, AttentionItem, QueueProvider } from '../attention/types.js';
import { CONSEQUENCE_FOR_ACTION, DIAL_CAPABILITY_FOR_ACTION } from '../agent/dialMap.js';
import { attentionOf, bankInboxAttention } from './bankInbox.js';
import { readBankTxnDetail, type BankTxnRow } from './bankLines.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import { staleLineDrafts } from '../attention/vorschlaege.js';
import type { BankInboxAttentionCounts } from './bankInbox.js';
import { readStatementGaps } from './ebics/channel.js';
import { AUTO_SYNC_MAX_ATTEMPTS, autoSyncConnections, latestAutoAttempt, zurichParts } from './ebics/autoSync.js';
import { bankShortName } from './ebics/banks.js';
import type { StatementGap } from './statementGaps.js';

const BANK_STATEMENT_GAP_ENTITY_KIND = 'bank_statement_gap';
const BANK_ACCOUNT_ENTITY_KIND = 'bank_account';
const EBICS_CONNECTION_ENTITY_KIND = 'ebics_connection';

// --- one read per summary call ------------------------------------------------------------------------

/**
 * The hub calls a provider's `count` and then its `list` back to back. The gap model and the inbox
 * counts are not cheap (the inbox runs a proposal per open line), so each is computed ONCE per state of
 * the book: the memo is keyed on the context AND on SQLite's own change counters (`total_changes()` for
 * this connection's writes, `data_version` for another connection's), so a write in between is never
 * served a stale answer.
 */
function bookVersion(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT total_changes() AS c, (SELECT data_version FROM pragma_data_version) AS v').get() as { c: number; v: number };
  return `${row.c}:${row.v}`;
}

function memoised<T>(memo: WeakMap<WorkspaceContext, { version: string; value: T }>, ctx: WorkspaceContext, compute: () => T): T {
  const version = bookVersion(ctx);
  const hit = memo.get(ctx);
  if (hit !== undefined && hit.version === version) return hit.value;
  const value = compute();
  memo.set(ctx, { version, value });
  return value;
}

const GAP_MEMO = new WeakMap<WorkspaceContext, { version: string; value: StatementGap[] }>();
const INBOX_MEMO = new WeakMap<WorkspaceContext, { version: string; value: ReturnType<typeof bankInboxAttention> }>();

function openGaps(ctx: WorkspaceContext): StatementGap[] {
  return memoised(GAP_MEMO, ctx, () => readStatementGaps(ctx));
}

function inboxCounts(ctx: WorkspaceContext): ReturnType<typeof bankInboxAttention> {
  return memoised(INBOX_MEMO, ctx, () => bankInboxAttention(ctx));
}

function accountNames(ctx: WorkspaceContext): Map<string, string> {
  const rows = ctx.store.db.prepare('SELECT id, name FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function consequenceOf(verb: string): { consequenceKey: string | null; consequence: string | null } {
  const capability = DIAL_CAPABILITY_FOR_ACTION[verb];
  return { consequenceKey: capability === undefined ? null : `agent.consequence.${capability}`, consequence: CONSEQUENCE_FOR_ACTION[verb] ?? null };
}

// --- bank_statement_gap -----------------------------------------------------------------------------

/** "183–186", "183", or across a year turn "1–2/2026" (en dash: a real range). */
export function missingRangeText(gap: Pick<StatementGap, 'missing' | 'oldYearTailUnknown'>): string {
  return gap.missing
    .map((r) => `${r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`}${gap.oldYearTailUnknown ? `/${r.year}` : ''}`)
    .join(', ');
}

function missingCount(gap: StatementGap): number {
  return gap.missing.reduce((n, r) => n + (r.to - r.from + 1), 0);
}

/** How many ack rows the gap already has: the decision generation of its confirm key. */
function ackGeneration(ctx: WorkspaceContext, gap: StatementGap): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM bank_statement_gap_ack
        WHERE workspace_id = ? AND bank_account_id = ? AND after_statement_id = ? AND before_statement_id = ?`,
    )
    .get(ctx.workspaceId, gap.bankAccountId, gap.after.statementRowId, gap.before.statementRowId) as { n: number };
  return row.n;
}

export const bankStatementGapProvider: QueueProvider = {
  queueId: 'bank_statement_gap',
  labelKey: 'attention.queue.bankStatementGap',
  area: 'bank',
  // D178: fetch or import the missing statements, a person's act.
  kind: 'do',
  // The item's acts are the statement door (`import_camt_files`) and the confirmation, both `pay`.
  readCapability: 'pay',
  rank: 7,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/bank-accounts',
  count(ctx: WorkspaceContext): number {
    return openGaps(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const names = accountNames(ctx);
    return openGaps(ctx)
      .slice(0, opts.limit)
      .map((gap) => {
        const deepLink = { route: '/bank-accounts', params: { repair: gap.bankAccountId, gap: gap.gapId } };
        const one = missingCount(gap) === 1;
        const sameDay = gap.missingDates.from !== null && gap.missingDates.from === gap.missingDates.to;
        // Critic M1 / LOW 4: a year turn with no knowable number never renders an empty range.
        const count = gap.missing.length === 0 ? 'Unknown' : one ? 'One' : 'Many';
        const incompleteEnd = gap.after.incomplete === true ? gap.after : gap.before.incomplete === true ? gap.before : undefined;
        const conflictEnd = gap.after.conflicting === true ? gap.after : gap.before.conflicting === true ? gap.before : undefined;
        // Critic round 2, N1/N2: an incomplete or conflicting statement with nothing missing around it
        // is named as such.
        const titleKey =
          gap.missing.length === 0 && conflictEnd !== undefined && gap.oldYearTailUnknown === false
            ? 'attention.item.bankStatementGap.titleConflicting'
            : gap.missing.length === 0 && incompleteEnd !== undefined && gap.oldYearTailUnknown === false
            ? 'attention.item.bankStatementGap.titleIncomplete'
            : `attention.item.bankStatementGap.title${count}${sameDay ? 'Day' : 'Days'}`;
        // Critic H1: a refused statement waiting INSIDE a chained gap proves money the books do not
        // explain, so the item never says "no money is missing" then.
        const inside = gap.source === 'book' ? gap.refused[0] : undefined;
        // Critic M2: a split statement not wholly in the books leaves the money unknown, never "missing".
        const incomplete = gap.after.incomplete === true ? gap.after : gap.before.incomplete === true ? gap.before : undefined;
        const conflict = gap.after.conflicting === true ? gap.after : gap.before.conflicting === true ? gap.before : undefined;
        const subtitleKey =
          gap.source === 'pending'
            ? 'attention.item.bankStatementGap.subtitlePending'
            : conflict !== undefined
              ? 'attention.item.bankStatementGap.subtitleConflicting'
              : incomplete !== undefined
              ? 'attention.item.bankStatementGap.subtitleIncomplete'
              : inside !== undefined
              ? 'attention.item.bankStatementGap.subtitleWaitingInside'
              : gap.chains
                ? 'attention.item.bankStatementGap.subtitleChained'
                : 'attention.item.bankStatementGap.subtitleUnchained';
        // The action names what the click does (the fresh-eyes judge, N4 item 4): it opens the guided import
        // of camt.053 statements for this gap (`GapRepairDialog`), so a missing statement is imported, a
        // split one has its missing parts imported, and a duplicate with two balances is imported anew.
        const actLabel =
          titleKey === 'attention.item.bankStatementGap.titleConflicting'
            ? 'attention.act.reimportStatement'
            : titleKey === 'attention.item.bankStatementGap.titleIncomplete'
              ? 'attention.act.importStatementParts'
              : count === 'One'
                ? 'attention.act.importStatement'
                : 'attention.act.importStatements';
        const options: AttentionDecisionOption[] = [{ id: 'open', verb: null, labelKey: actLabel, role: 'link', input: {}, deepLink }];
        if (gap.confirmable && gap.after.statementRowId !== null && gap.before.statementRowId !== null) {
          options.push({
            id: 'confirm_gap',
            verb: 'confirm_statement_gap',
            labelKey: 'attention.act.confirmGap',
            role: 'secondary',
            input: {
              bankAccountId: gap.bankAccountId,
              afterStatementId: gap.after.statementRowId,
              beforeStatementId: gap.before.statementRowId,
              idempotencyKey: `attention:confirm-gap:${ctx.workspaceId}:${gap.gapId}:${ackGeneration(ctx, gap)}`,
            },
            humanConfirm: true,
            reasonField: true,
            confirmLabelKey: 'attention.act.confirmGapConfirm',
            reasonPlaceholderKey: 'attention.act.confirmGapReason',
            capability: 'pay',
          });
        }
        return {
          queueId: 'bank_statement_gap',
          entityKind: BANK_STATEMENT_GAP_ENTITY_KIND,
          entityId: gap.gapId,
          titleKey,
          titleParams: {
            bank: names.get(gap.bankAccountId) ?? '',
            range: missingRangeText(gap),
            after: `${gap.after.number}/${gap.after.year}`,
            ...(incompleteEnd !== undefined ? { incomplete: `${incompleteEnd.number}/${incompleteEnd.year}` } : {}),
            ...(conflictEnd !== undefined ? { conflicting: `${conflictEnd.number}/${conflictEnd.year}` } : {}),
            fromDate: gap.missingDates.from ?? '',
            toDate: gap.missingDates.to ?? '',
          },
          subtitleKey,
          subtitleParams: {
            after: gap.after.number,
            before: gap.before.number,
            ...(inside !== undefined ? { waiting: inside.number } : {}),
            ...(incomplete !== undefined ? { incomplete: incomplete.number } : {}),
            ...(conflict !== undefined ? { conflicting: conflict.number } : {}),
            differenceMinor: inside !== undefined ? inside.differenceMinor : gap.differenceMinor,
            currency: gap.currency ?? '',
          },
          since: gap.before.fromDate ?? gap.after.fromDate ?? '',
          urgency: 'due',
          deepLink,
          decisionOptions: options,
          reasonCode: gap.source === 'pending' ? 'gap_refused' : gap.unexplained ? 'gap_unexplained' : 'gap_chains',
          // Critic round 2 LOW 1: a reopened gap says the earlier confirmation no longer holds.
          reasonKey: gap.confirmationVoid === true ? 'attention.item.bankStatementGap.confirmationVoid' : null,
          ...(gap.confirmable ? consequenceOf('confirm_statement_gap') : { consequenceKey: null, consequence: null }),
        } satisfies AttentionItem;
      });
  },
};

// --- bank_lines_waiting -----------------------------------------------------------------------------

/**
 * The lines of one account that wait for a person and are not already a pending Vorschlag. Critic
 * LOW 5: the Vorschlag lines are subtracted only when the actor SEES the queue that counts them
 * (`agent_action` is gated on `read_books`); otherwise they would vanish from both.
 */
export function waitingOf(c: Pick<BankInboxAttentionCounts, 'needs' | 'vorschlag'>, seesVorschlaege: boolean): number {
  return seesVorschlaege ? Math.max(0, c.needs - c.vorschlag) : c.needs;
}

/** Does this actor see the `agent_action` queue, which counts the lines a pending Vorschlag names? */
export function seesVorschlaege(ctx: WorkspaceContext): boolean {
  return ctx.capabilities.assert('read_books').ok;
}

const STALE_MEMO = new WeakMap<WorkspaceContext, { version: string; value: Map<string, number> }>();

/**
 * D178 (the design judge): a STALE Vorschlag on a line that is still open stays in Pendenzen
 * (`attention/vorschlaege.ts`), counted there, so its line is not counted a second time among the waiting
 * lines. Per Bankkonto: how many such lines the inbox counts as "needs a person" (a pending Vorschlag's line
 * always does; a stale one's line is classed on its own proposal, exactly as `bankInboxAttention` classes
 * it). Memoised per state of the book, like the inbox counts.
 */
export function staleNamedWaitingByAccount(ctx: WorkspaceContext): Map<string, number> {
  return memoised(STALE_MEMO, ctx, () => {
    const out = new Map<string, number>();
    const drafts = staleLineDrafts(ctx);
    if (drafts.length === 0) return out;
    const pc = proposalContext(ctx);
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.bankTxnId)) continue;
      seen.add(d.bankTxnId);
      const row = ctx.store.db.prepare('SELECT * FROM bank_txn WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, d.bankTxnId) as BankTxnRow | undefined;
      if (row === undefined) continue;
      if (attentionOf(proposeForLine(ctx, pc, row, readBankTxnDetail(ctx, row.id)), Math.abs(row.amount_minor), false) !== 'needs') continue;
      out.set(row.bank_account_id, (out.get(row.bank_account_id) ?? 0) + 1);
    }
    return out;
  });
}

/** The waiting lines of one account in Pendenzen: `waitingOf`, minus the lines a listed stale Vorschlag stands for. */
function hubWaitingOf(c: Pick<BankInboxAttentionCounts, 'needs' | 'vorschlag'>, sees: boolean, staleNamed: number): number {
  return sees ? Math.max(0, waitingOf(c, sees) - staleNamed) : waitingOf(c, sees);
}

export const bankLinesWaitingProvider: QueueProvider = {
  queueId: 'bank_lines_waiting',
  labelKey: 'attention.queue.bankLinesWaiting',
  area: 'bank',
  // D178 point 11: book the lines, a person's act; and Bank's own working queue, listed right after the
  // Vorschläge inside Bank ("Bank transactions must be all the way on top").
  kind: 'do',
  lead: true,
  // The bank inbox's own read right: whoever may look at the lines is told they wait.
  readCapability: 'read_sales',
  rank: 12,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/bank',
  count(ctx: WorkspaceContext): number {
    let n = 0;
    const sees = seesVorschlaege(ctx);
    const stale = sees ? staleNamedWaitingByAccount(ctx) : new Map<string, number>();
    for (const [id, c] of inboxCounts(ctx).byAccount.entries()) n += hubWaitingOf(c, sees, stale.get(id) ?? 0);
    return n;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const names = accountNames(ctx);
    const sees = seesVorschlaege(ctx);
    const stale = sees ? staleNamedWaitingByAccount(ctx) : new Map<string, number>();
    return [...inboxCounts(ctx).byAccount.entries()]
      .filter(([id, c]) => hubWaitingOf(c, sees, stale.get(id) ?? 0) > 0)
      .sort(([a], [b]) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b))
      .slice(0, opts.limit)
      .map(([bankAccountId, c]) => {
        const count = hubWaitingOf(c, sees, stale.get(bankAccountId) ?? 0);
        const deepLink = { route: '/bank', params: { facet: 'needs', account: bankAccountId } };
        return {
          queueId: 'bank_lines_waiting',
          entityKind: BANK_ACCOUNT_ENTITY_KIND,
          entityId: bankAccountId,
          // D178 point 11: ONE row per Bankkonto that stands for its N lines, and says so: the title is
          // the number of lines ("5 Bankzeilen zu buchen"), the meta line the account, and `count` makes
          // the row's units part of the page's arithmetic (the rows add up to the badge).
          titleKey: `attention.item.bankLines.title.${count === 1 ? 'one' : 'other'}`,
          titleParams: { bank: names.get(bankAccountId) ?? '', count },
          subtitleKey: 'attention.item.bankLines.subtitle',
          subtitleParams: { bank: names.get(bankAccountId) ?? '' },
          count,
          since: c.oldestWaiting ?? '',
          urgency: 'open',
          deepLink,
          decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.openBankLines', role: 'link', input: {}, deepLink }],
          reasonCode: 'needs_person',
          reasonKey: null,
          consequenceKey: null,
          consequence: null,
        } satisfies AttentionItem;
      });
  },
};

// --- bank_fetch_failed ------------------------------------------------------------------------------

/** The subtitle segment per outcome: the reason in plain words and the next step. */
export function fetchFailureKind(code: string, kind: unknown): string {
  switch (code) {
    case 'download_refused':
      return kind === 'not_granted' ? 'notGranted' : kind === 'busy' ? 'busy' : kind === 'too_large' ? 'tooLarge' : 'refused';
    case 'channel_unreachable':
      return 'unreachable';
    case 'keystore_locked':
    case 'keystore_unavailable':
      return 'keystore';
    case 'auto_sync_no_actor':
      return 'noActor';
    case 'needs_bank_transport':
      return 'noWire';
    case 'bank_keys_changed':
      return 'keysChanged';
    case 'untrusted_response':
      return 'untrusted';
    case 'sync_worker_failed':
    case 'store_busy':
    case 'commit_failed':
      return 'local';
    default:
      return 'other';
  }
}

interface FailedFetch {
  connectionId: string;
  bank: string;
  finishedAt: string;
  code: string;
  kind: string;
  bankCode: string;
}

function failedFetches(ctx: WorkspaceContext): FailedFetch[] {
  const out: FailedFetch[] = [];
  const today = zurichParts(ctx.clock.now()).date;
  for (const conn of autoSyncConnections(ctx)) {
    const latest = latestAutoAttempt(ctx, conn.id);
    if (latest === null || latest.attempt.ok) continue;
    const a = latest.attempt;
    // Still to be retried TODAY: the scheduler will try again, nothing waits for a person yet. Critic
    // LOW 3: only while that attempt's Swiss day is today; a retryable failure from an earlier day (TILL
    // closed before the retries) is a failed day.
    if (a.retryable && latest.attemptsThatDay < AUTO_SYNC_MAX_ATTEMPTS && a.localDate === today) continue;
    // A later fetch succeeded (a press, or the next day's run): the failure is over.
    if (conn.last_sync_at !== null && conn.last_sync_at >= a.finishedAt) continue;
    const host = ctx.store.db
      .prepare('SELECT host_id, host_url FROM ebics_connection WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, conn.id) as { host_id: string; host_url: string } | undefined;
    const detail = a.detail ?? {};
    out.push({
      connectionId: conn.id,
      bank: host === undefined ? '' : bankShortName({ hostId: host.host_id, hostUrl: host.host_url }),
      finishedAt: a.finishedAt,
      code: a.code,
      kind: fetchFailureKind(a.code, detail.kind),
      bankCode: typeof detail.code === 'string' ? detail.code : typeof detail.bankReason === 'string' ? detail.bankReason : a.code,
    });
  }
  return out;
}

export const bankFetchFailedProvider: QueueProvider = {
  queueId: 'bank_fetch_failed',
  labelKey: 'attention.queue.bankFetchFailed',
  area: 'bank',
  // D178: fetch by hand or repair the channel, a person's act.
  kind: 'do',
  // The fix is a fetch by hand or the channel's own repair, both `pay` on /bank-accounts.
  readCapability: 'pay',
  rank: 6,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/bank-accounts',
  count(ctx: WorkspaceContext): number {
    return failedFetches(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    return failedFetches(ctx)
      .slice(0, opts.limit)
      .map((f) => {
        const deepLink = { route: '/bank-accounts', params: {} };
        return {
          queueId: 'bank_fetch_failed',
          entityKind: EBICS_CONNECTION_ENTITY_KIND,
          entityId: f.connectionId,
          titleKey: 'attention.item.bankFetchFailed.title',
          titleParams: { bank: f.bank },
          subtitleKey: `attention.item.bankFetchFailed.${f.kind}`,
          subtitleParams: { bank: f.bank, code: f.bankCode, failedAt: f.finishedAt },
          since: f.finishedAt,
          urgency: 'due',
          deepLink,
          decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.openBankAccounts', role: 'link', input: {}, deepLink }],
          reasonCode: f.code,
          reasonKey: null,
          consequenceKey: null,
          consequence: null,
        } satisfies AttentionItem;
      });
  },
};
