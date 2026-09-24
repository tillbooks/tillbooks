/**
 * A15's write path: propose, issue, send. The escalation state machine lives HERE and nowhere else
 * (§6b fixed: A16 reads it, G01 fires these verbs, nobody forks it).
 *
 * THE THREE MOMENTS, and what each one is allowed to touch:
 *
 *  - **propose** reads A16's OWN `listOpenItems` derivation (never a fork; overdue-ness is an as-of
 *    statement decided from ledger dates, D64) and persists a reviewable draft. It writes nothing to
 *    the ledger, renders nothing, sends nothing, and is therefore safe by construction: the reason
 *    it needs no P8 gate and stays automatable without one.
 *  - **issue** is the commitment. It re-checks every item against A16 AS OF THE ISSUE DAY first, so
 *    an invoice paid between propose and issue drops out and a shrunken one shrinks: "never chase a
 *    paid invoice" (US-A15.4) is enforced at the last write before a letter exists, not only at the
 *    draft. Then it freezes the items, computes the display-only Verzugszins note (Art. 104 OR,
 *    never posted), and, when the config books a Mahngebühr, posts ONE aggregate entry through A02
 *    `postEntry` (P3, `source='dunning'`): debit 1100 Debitoren, credit the configured fee-income
 *    account, VAT through A05's one code path. §H-PERIOD: a locked period skips the FEE, named on
 *    the run, and the run still issues, because a letter is not a posting.
 *  - **send** is the only outward-facing act. It is P8-gated (`confirmed` or the workspace dial,
 *    the `send_invoice` idiom), degrades honestly when no transport is wired (P9:
 *    `needs_email_config` / `needs_email_transport`), and records a per-debtor outcome so a retry
 *    sends only what has not gone out. The transport call runs OUTSIDE any transaction with a
 *    committed `dispatching` marker before it, A11's m-1 lesson: a crash between the transport and
 *    the bookkeeping must read as UNKNOWN, never as "nothing was sent". And it re-checks A16 one
 *    more time: issue was the last WRITE before a letter existed, but send is the last moment
 *    before one leaves, so a letter naming an invoice settled since issue is skipped by name
 *    (US-A15.4 again; D73 keeps the frozen record, the transport is what the settlement revokes).
 *
 * Level semantics: an item's CURRENT level is the highest level any ISSUED run carries for its
 * document (as of the proposal date). The next reminder is current + 1; a document whose level-3
 * reminder is issued is terminal (the next step is Betreibung, out of this suite's scope). A
 * proposed-but-never-issued run asserts nothing: only issue advances an item's level, because only
 * issue produces the letter the level claims was sent.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalDate, requireString } from '../ledger/inputGuards.js';
import { listOpenItems } from '../debtors/index.js';
import type { OpenItem } from '../debtors/index.js';
import { postEntry } from '../ledger/index.js';
import { buildVatLines } from '../vat/index.js';
import type { VatJournalLine } from '../vat/index.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
import { dunningLevelsOf } from './config.js';
import type { DunningLevelConfig } from './config.js';
import { renderDunningPdf } from './pdf.js';
import { readRun, runView, dunningRunChangesSinceIssue } from './reads.js';
import type { RunRow, ItemRow, DunningItemChange } from './reads.js';
// G05: freeze the default template (id + snapshot) at issue, the same moment the figures freeze.
import { freezeRenderedTemplate } from '../customization/documentTemplates.js';
import { recordDispatch } from '../customization/dispatch.js';

/**
 * The journal source only this module writes (`postEntry`'s §H-ENUM carries it). Deliberately
 * absent from `POST_ENTRY_SOURCES` in `src/api/registry.ts`, the A17 `purchase` precedent: an
 * agent cannot forge an entry claiming to be a Mahngebühr with no dunning run behind it.
 */
export const DUNNING_SOURCE = 'dunning';

/** Round half away from zero in exact integer arithmetic (P2), the shared engine idiom. */
function roundHalfAwayFromZero(numer: number, denom: number): number {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

/**
 * The Verzugszins NOTE for one item: principal x rate x actualDays/365, rounded once (P2).
 *
 * ACT/365, and the first build's comment claiming 30/360 while dividing an ACTUAL day count by 360
 * was critic nit N1: ACT/360 overstates by ~1.39% on a figure printed under "Art. 104 OR". Swiss
 * Verzugszins practice (the calculators a Betreibungsamt or a court actually accepts) charges the
 * per-annum rate on actual elapsed days over a 365-day year, so that is the convention, stated
 * truthfully. The BASE is the PRINCIPAL in Verzug, never a Mahngebühr (critic C5): Art. 104 OR
 * gives default interest on the debt, and a contractual reminder charge is not the debt. The figure
 * is informational (this suite never books it) and is frozen on the item at issue so the letter a
 * debtor holds is the letter the record shows.
 */
export function interestNoteMinor(principalMinor: number, interestBp: number, daysOverdue: number): number {
  return roundHalfAwayFromZero(principalMinor * interestBp * daysOverdue, 10000 * 365);
}

/** The P8 outbound approval dial, the same `workspace.posting_auto_issue` column A11 reads. */
function autoSendEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

/** The configured relay MODE, which is a setting and never by itself a transport (A11's rule). */
function configuredRelayMode(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare('SELECT email_relay AS mode FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { mode: string | null } | undefined;
  return row?.mode == null || row.mode.length === 0 ? null : row.mode;
}

/**
 * The highest ISSUED level per document: THE escalation state, and it is deliberately NOT as-of.
 *
 * Critic C2: the first build bounded this query by the proposal's `asOf`, so a backdated proposal
 * read the state as it stood weeks ago and re-proposed a level that had already been issued,
 * including a fourth letter on a terminal invoice. The state machine is MONOTONIC: what has been
 * issued has been issued, whatever date the caller is asking the OVERDUE question about. `asOf`
 * governs the money facts (D64); it never governs the escalation state.
 */
function issuedLevels(ctx: WorkspaceContext): Map<string, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT i.document_id AS documentId, MAX(i.level) AS level
         FROM dunning_item i
         JOIN dunning_run r ON r.id = i.run_id AND r.workspace_id = i.workspace_id
        WHERE i.workspace_id = ? AND r.status IN ('issued', 'sent')
        GROUP BY i.document_id`,
    )
    .all(ctx.workspaceId) as { documentId: string; level: number }[];
  return new Map(rows.map((r) => [r.documentId, r.level]));
}

/**
 * The ISSUE DATE of each document's HIGHEST issued level: the anchor the K-60 minimum-interval gate
 * measures from. `issued_at` is stamped once, at issue (`ctx.clock.now()`), on the run that carries
 * the level, so its date is the day the PREVIOUS letter actually went out. Same §H-TENANT scope and
 * same `('issued', 'sent')` status set as `issuedLevels`, so the two maps always agree on which
 * level is current; this one adds when it was reached. A run in that status set always has a
 * non-null `issued_at` (issue writes both together), but a null is carried through honestly rather
 * than defaulted, so the gate can fail SAFE on it.
 */
function highestIssuedLevelDate(ctx: WorkspaceContext): Map<string, string | null> {
  const rows = ctx.store.db
    .prepare(
      `SELECT i.document_id AS documentId, i.level AS level, r.issued_at AS issuedAt
         FROM dunning_item i
         JOIN dunning_run r ON r.id = i.run_id AND r.workspace_id = i.workspace_id
        WHERE i.workspace_id = ? AND r.status IN ('issued', 'sent')`,
    )
    .all(ctx.workspaceId) as { documentId: string; level: number; issuedAt: string | null }[];
  const best = new Map<string, { level: number; issuedAt: string | null }>();
  for (const row of rows) {
    const cur = best.get(row.documentId);
    if (cur === undefined || row.level > cur.level) {
      best.set(row.documentId, { level: row.level, issuedAt: row.issuedAt });
    }
  }
  const out = new Map<string, string | null>();
  for (const [documentId, v] of best) {
    out.set(documentId, v.issuedAt === null ? null : v.issuedAt.slice(0, 10));
  }
  return out;
}

/** Whole calendar days from an earlier ISO date to a later one (both `YYYY-MM-DD`, UTC midnight). */
function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate.slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${toDate.slice(0, 10)}T00:00:00.000Z`);
  return Math.floor((to - from) / 86400000);
}

/**
 * The K-60 minimum-interval gate: may an item ADVANCE to `next` yet?
 *
 * Level 1 has no previous issued level, so it is gated by its absolute `daysOverdue` threshold alone
 * and this returns true. For level 2 or 3, at least `minIntervalDays[next]` calendar days must have
 * passed since the PREVIOUS level's letter was issued.
 *
 * FAIL SAFE: a `next >= 2` with no recorded previous-level issue date cannot happen under the
 * monotonic invariant (a level-2 candidate means level 1 was issued, and issue always stamps
 * `issued_at`), but if it ever did, the gate REFUSES to advance rather than guess the spacing: never
 * escalate on a date the record cannot vouch for.
 */
function intervalSatisfied(
  next: 1 | 2 | 3,
  prevLevelIssueDate: string | null | undefined,
  asOf: string,
  levels: readonly DunningLevelConfig[],
): boolean {
  if (next <= 1) return true;
  if (prevLevelIssueDate === null || prevLevelIssueDate === undefined) return false;
  return daysBetween(prevLevelIssueDate, asOf) >= levels[next - 1]!.minIntervalDays;
}

/**
 * The invoice's OWN open amount on an A16 row: what the row carries minus the booked Mahngebühren
 * riding it, and minus its linked credit notes' open offsets (D68: a 90%-credited invoice is
 * dunned for its NET, never the gross the row model keeps for the ledger tie). The letter machine
 * escalates on THIS figure and only this one.
 */
function principalOf(item: OpenItem): number {
  return item.openMinor - item.dunningFeeMinor - item.creditedOpenMinor;
}

/**
 * The overdue DOCUMENT items a run can chase: A16's rows, narrowed to what a letter can name.
 *
 * THE PRINCIPAL FILTER IS CRITICS C3 AND C4 IN ONE PREDICATE. A16 folds booked Mahngebühren into
 * `openMinor` (that is what keeps the 1100 reconciliation true), so a FULLY PAID invoice whose fee
 * is still open, and a CANCELLED invoice whose fee survives as an orphan row, both look "open" to a
 * naive read. Neither is dunnable: a letter that names an invoice asserts THAT INVOICE is unpaid,
 * and mailing that assertion about a paid or cancelled invoice, under its own number and QRR
 * reference, is the worst sentence this product can produce. A residual fee balance is chased by no
 * letter: it stays visible on the OP-Liste as `dunningFeeMinor`, and its honest remedies are
 * `reverse_entry` on the fee entry (a mistaken or waived fee) or ordinary collection outside the
 * escalation machine. The spec §4 records this presentation decision.
 */
function chaseableItems(items: readonly OpenItem[]): OpenItem[] {
  // A parked Guthaben is not chased (it is the customer's money), and a document with no customer
  // has no one to address a letter to: both are absences from the run, not errors.
  return items.filter(
    (i) =>
      i.kind === 'document' &&
      i.overdue &&
      principalOf(i) > 0 &&
      i.documentId !== null &&
      i.customerId !== null,
  );
}

interface Candidate {
  documentId: string;
  debtorId: string;
  number: string | null;
  dueDate: string | null;
  currency: string;
  /** The full claim the letter states: the invoice's open amount incl. previously BOOKED fees. */
  overdueMinor: number;
  /** The invoice's own open amount: the escalation and Art. 104 interest base (C3/C5). */
  principalMinor: number;
  daysOverdue: number;
  level: 1 | 2 | 3;
  feeMinor: number;
  interestMinor: number | null;
}

/** Assign each chaseable item its next level, or drop it (not yet at threshold, or terminal). */
function assignLevels(
  items: readonly OpenItem[],
  current: ReadonlyMap<string, number>,
  levels: readonly DunningLevelConfig[],
  baseCurrency: string,
  prevLevelIssueDates: ReadonlyMap<string, string | null>,
  asOf: string,
): Candidate[] {
  const out: Candidate[] = [];
  for (const item of items) {
    const at = current.get(item.documentId as string) ?? 0;
    if (at >= 3) continue; // terminal: the next step is Betreibung, not a fourth letter
    const next = (at + 1) as 1 | 2 | 3;
    const cfg = levels[next - 1]!;
    if (item.daysOverdue < cfg.daysOverdue) continue;
    // K-60: the absolute threshold is met, but a step INTO level 2 or 3 also waits out the minimum
    // spacing since the previous letter issued. An invoice already past every threshold no longer
    // races up the ladder in consecutive daily runs; it advances one letter per interval.
    if (!intervalSatisfied(next, prevLevelIssueDates.get(item.documentId as string), asOf, levels)) continue;
    // The fee is configured in Rappen of the BASE currency, so it attaches to base-currency items
    // only: a EUR reminder never carries a silently unconverted franc figure. Config validation
    // guarantees a positive fee books (C6); the belt here keeps a pre-validation row harmless.
    const feeMinor =
      item.currency === baseCurrency && cfg.bookFee && cfg.feeIncomeAccountId !== null ? cfg.feeMinor : 0;
    const principalMinor = principalOf(item);
    out.push({
      documentId: item.documentId as string,
      debtorId: item.customerId as string,
      number: item.number,
      dueDate: item.dueDate,
      currency: item.currency,
      overdueMinor: item.openMinor,
      principalMinor,
      daysOverdue: item.daysOverdue,
      level: next,
      feeMinor,
      // Art. 104 OR: interest on the PRINCIPAL in Verzug, never on a Mahngebühr (C5).
      interestMinor: cfg.showInterest
        ? interestNoteMinor(principalMinor, cfg.interestBp, item.daysOverdue)
        : null,
    });
  }
  return out;
}

export interface ProposeDunningRunInput {
  asOf?: string;
  idempotencyKey?: string;
}

/**
 * Propose a Mahnlauf: the reviewable draft (US-A15.2, US-A15.5).
 *
 * §H-IDEMPOTENT twice over: the store's side table replays a completed call byte-identically, and
 * the run is STRUCTURALLY keyed on `run_date` (one run per workspace per day, held by a UNIQUE
 * index), so re-proposing the same day under a fresh key returns the existing run rather than
 * minting a rival. A future `asOf` is refused: a letter must never chase a day that has not
 * happened, the same clamp D50 put on the automation tick.
 */
export function proposeDunningRun(ctx: WorkspaceContext, input: ProposeDunningRunInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey') ?? optionalDate(input.asOf, 'asOf');
  if (guard) return guard;
  const key = input.idempotencyKey as string;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'propose_dunning_run');
  if (replayed !== undefined) return replayed;

  const today = ctx.clock.now().slice(0, 10);
  const asOf = input.asOf ?? today;
  if (asOf > today) return err('invalid_input', { field: 'asOf', reason: 'asOf_in_future' });

  const existing = ctx.store.db
    .prepare('SELECT * FROM dunning_run WHERE workspace_id = ? AND run_date = ?')
    .get(ctx.workspaceId, asOf) as RunRow | undefined;
  if (existing !== undefined) {
    return ok({ ...runView(ctx, existing), existing: true });
  }

  const open = listOpenItems(ctx, { asOf });
  if (!open.ok) return open;
  const candidates = assignLevels(
    chaseableItems(open.items as OpenItem[]),
    issuedLevels(ctx),
    dunningLevelsOf(ctx),
    baseCurrencyOf(ctx),
    highestIssuedLevelDate(ctx),
    asOf,
  );

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'propose_dunning_run', () => {
    if (candidates.length === 0) {
      // Scope degradation (P9): nothing overdue is an empty answer, not an error and not a row. A
      // run with no items would be a letterless letter batch blocking the day's UNIQUE slot.
      return ok({ runId: null, proposed: false, items: [], asOf, reason: 'nothing_overdue' });
    }
    const now = ctx.clock.now();
    const runId = ctx.ids.next('dun');
    ctx.store.db
      .prepare(
        `INSERT INTO dunning_run (id, workspace_id, run_date, status, created_by, created_at)
         VALUES (?, ?, ?, 'proposed', ?, ?)`,
      )
      .run(runId, ctx.workspaceId, asOf, ctx.actor, now);
    const insert = ctx.store.db.prepare(
      `INSERT INTO dunning_item
         (id, workspace_id, run_id, document_id, debtor_id, level, currency, overdue_minor,
          principal_minor, fee_minor, days_overdue, due_date, number, interest_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of candidates) {
      insert.run(
        ctx.ids.next('dit'),
        ctx.workspaceId,
        runId,
        c.documentId,
        c.debtorId,
        c.level,
        c.currency,
        c.overdueMinor,
        c.principalMinor,
        c.feeMinor,
        c.daysOverdue,
        c.dueDate,
        c.number,
        c.interestMinor,
      );
    }
    const row = ctx.store.db
      .prepare('SELECT * FROM dunning_run WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, runId) as RunRow;
    return ok({ ...runView(ctx, row), proposed: true });
  });
}

export interface IssueDunningRunInput {
  runId?: string;
  confirmed?: boolean;
  idempotencyKey?: string;
}

/** One item's fee with its posting target: the unit the D69 split runs over. */
interface FeeAttribution {
  documentId: string;
  feeMinor: number;
  accountId: string;
}

/**
 * The chased invoice's rate bases (D69): its line totals grouped by tax code, the weights the fee's
 * VAT splits across. An invoice with no positive line total (defensive; issue only chases open
 * invoices) weighs everything on one code-less base, which books the fee without VAT rather than
 * inventing a rate.
 */
function feeVatWeights(
  ctx: WorkspaceContext,
  documentId: string,
): { taxCode: string | null; weightMinor: number }[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT tax_code AS taxCode, SUM(line_total_minor) AS weightMinor
         FROM document_line
        WHERE workspace_id = ? AND document_id = ?
        GROUP BY tax_code
        ORDER BY tax_code`,
    )
    .all(ctx.workspaceId, documentId) as { taxCode: string | null; weightMinor: number }[];
  const positive = rows.filter((r) => r.weightMinor > 0);
  return positive.length === 0 ? [{ taxCode: null, weightMinor: 1 }] : positive;
}

/**
 * Split one integer amount across weights, largest remainder, so the shares sum EXACTLY to the
 * total (P2: round once, never leak a Rappen).
 */
function splitProRata<T extends { weightMinor: number }>(
  totalMinor: number,
  weights: readonly T[],
): (T & { shareMinor: number })[] {
  const weightSum = weights.reduce((n, w) => n + w.weightMinor, 0);
  const shares = weights.map((w) => {
    const exact = (totalMinor * w.weightMinor) / weightSum;
    const floor = Math.floor(exact);
    return { ...w, shareMinor: floor, remainder: exact - floor };
  });
  let leftover = totalMinor - shares.reduce((n, s) => n + s.shareMinor, 0);
  // Largest fractional remainder first; ties resolve by input order, which is stable (ORDER BY).
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);
  for (const share of byRemainder) {
    if (leftover <= 0) break;
    share.shareMinor += 1;
    leftover -= 1;
  }
  return shares;
}

/**
 * The fee entry's lines (D69, owner-decided 31.07.2026): each item's Mahngebühr splits pro rata
 * across ITS OWN invoice's rate bases and resolves through A05's one code path, so a mixed
 * 8.1%/3.8% invoice taxes its fee in the same proportion, and an exempt supply's fee books no VAT
 * at all. The first build booked one aggregate line at a configured code, which is the stated ESTV
 * rule's opposite (critic C9). Shares are grouped by (account, code) afterwards so the entry stays
 * compact; per-document attribution stays on the `dunning_item` rows.
 *
 * Built OUTSIDE the idempotency unit (the standing rule): a rejection returned inside
 * `rememberIdempotent` would be memoised as the key's permanent answer.
 */
function buildFeeLines(
  ctx: WorkspaceContext,
  attributions: readonly FeeAttribution[],
  debtorAccountId: string,
  today: string,
): VatJournalLine[] | Result {
  const groups = new Map<string, { accountId: string; taxCode: string | null; totalMinor: number }>();
  for (const attribution of attributions) {
    const weights = feeVatWeights(ctx, attribution.documentId);
    for (const share of splitProRata(attribution.feeMinor, weights)) {
      if (share.shareMinor <= 0) continue;
      const groupKey = `${attribution.accountId} ${share.taxCode ?? ''}`;
      const group = groups.get(groupKey) ?? {
        accountId: attribution.accountId,
        taxCode: share.taxCode,
        totalMinor: 0,
      };
      group.totalMinor += share.shareMinor;
      groups.set(groupKey, group);
    }
  }
  let lines: VatJournalLine[] = [];
  try {
    for (const g of groups.values()) {
      lines = lines.concat(
        buildVatLines(ctx, {
          direction: 'output',
          counterAccount: debtorAccountId,
          revenueOrExpenseAccount: g.accountId,
          amountMinor: g.totalMinor,
          amountIsGross: true,
          taxCode: g.taxCode,
          supplyDate: today,
        }),
      );
    }
  } catch (e) {
    // A code that will not resolve on the fee is the chased invoice's own data defect, named as
    // such: never a crash, and never a silently untaxed posting.
    return err('fee_tax_unresolvable', { reason: e instanceof Error ? e.message : String(e) });
  }
  return lines;
}

/** The 1100 Debitoren account id, or the structured reason it is absent. */
function receivableAccount(ctx: WorkspaceContext): { id: string } | Result {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, ROLE_ACCOUNT_NUMBER.receivable) as { id: string } | undefined;
  return row === undefined ? err('missing_account', { number: ROLE_ACCOUNT_NUMBER.receivable }) : row;
}

/**
 * Issue a proposed run (US-A15.3): re-verify against A16 AND against the escalation state, freeze,
 * book the fee when configured.
 *
 * THE ESCALATION GUARD LIVES HERE, at the last write before a letter exists (critic C1). The run
 * state machine (`proposed -> issued`) protects the RUN; the invariant that matters protects the
 * INVOICE: **one issued reminder per level per document**. Two live drafts over the same invoice
 * are both legal (one run per day, by design); the SECOND one to reach issue finds the level
 * already issued and drops the item, and a run whose items all drop refuses with
 * `nothing_to_issue`. Prose never held this; this predicate does.
 *
 * ORDER, because the fee posting is the one irreversible-by-edit act (its correction is a reversing
 * entry): every guard runs first, the re-checks run second, and the fee entry and the status flip
 * commit in ONE transaction, so a run can never be `issued` without its fee nor carry a fee
 * without being issued. §H-PERIOD is the one exception, decided by the spec: a locked period skips
 * the FEE (named on the run as `fee_skipped_reason`) and the run still issues; calling
 * `issue_dunning_run` again once the period is open BOOKS the skipped fee (critic C8: skipped must
 * never mean destroyed), which is the recovery branch below.
 */
export function issueDunningRun(ctx: WorkspaceContext, input: IssueDunningRunInput): Result {
  const guard = requireString(input.runId, 'runId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const scopedKey = JSON.stringify([input.runId, key]);
  // THE ISSUE AND THE RECOVERY ARE TWO QUESTIONS ON ONE VERB, so they get two memo namespaces.
  //
  // This verb serves both: an issue while the run is `proposed`, and C8's fee recovery afterwards.
  // Under a single namespace a caller who reused the ISSUE's key for the recovery was answered from
  // the issue's memo, `{ok:true}` with the skipped fee still unbooked, and neither the caller nor
  // the ledger showed a trace. The Studio was fixed to mint a second key, which protects the Studio
  // and nothing else: an MCP agent, a G01 rule or a REST caller reusing the run's issue key hit the
  // same silent no-op, because the recall below was the verb's FIRST act and ran before the branch
  // that routes to the recovery. Naming the intent here is what makes every caller safe.
  //
  // This is the SIXTH instance of the two-questions-one-key class in this codebase (four of the
  // prior five are listed in `app/src/lib/idempotency.ts`, all client-side, and the fifth was this
  // verb's own first repair). The rule generalises: a key names a QUESTION, and a verb that answers
  // two questions needs two namespaces, whichever layer it sits in.
  //
  // AND WHERE TWO NAMESPACES ARE NOT ENOUGH, WHICH IS HERE. The first repair routed by the run's
  // state: consult the recovery memo always, the issue memo only when the call is not a recovery.
  // That fixed the silence and broke §H-IDEMPOTENT, because `recovering` stays true for the whole
  // life of a deferred-fee run, so the issue's OWN replay stopped reaching its memo and fell into
  // the recovery: one unchanged key answered `ok` and then `period_locked`, and once the period
  // reopened that same replay BOOKED the fee (critic probes V1 and V2).
  //
  // Consulting both memos unconditionally does not work either, and this is the load-bearing fact:
  // **a caller retrying its issue and a caller asking for a recovery send byte-identical input.**
  // Same workspace, same verb, same runId, same key. No ordering of two memos can tell them apart,
  // so any routing rule here is a GUESS about intent, and the guess moves money.
  //
  // So the ambiguity is REFUSED rather than resolved. The original defect was never "the engine
  // failed to recover", it was SILENCE: `{ok:true}` with nothing booked and no trace. A structured
  // refusal naming the remedy cures the silence for every caller, and keeps an unchanged key from
  // ever acquiring a new effect. It is the posture this engine takes everywhere else
  // (`needs_confirmation`, `needs_fee_income_account`).
  const recoverKey = JSON.stringify([input.runId, key, 'recover']);

  // The run is read BEFORE any recall, because which question this call is asking is a property of
  // the run's state, not of the key.
  const run = readRun(ctx, input.runId as string);
  if (run === undefined) return err('not_found', { runId: input.runId });
  const recovering = run.status !== 'proposed' && run.fee_skipped_reason === 'period_locked';

  // A recovery's own memo answers FIRST and unconditionally, because a successful recovery CLEARS
  // `fee_skipped_reason`: by the time it replays, the state that routed the original call is gone,
  // and `recovering` reads false for the very call that wrote the memo.
  const replayedRecovery = ctx.store.recallIdempotent<Result>(ctx.workspaceId, recoverKey, 'issue_dunning_run');
  if (replayedRecovery !== undefined) return replayedRecovery;
  const replayedIssue = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'issue_dunning_run');

  if (run.status !== 'proposed') {
    // C8: a run whose fee was skipped by a period lock is RECOVERABLE, not stranded. Re-issuing it
    // books the skipped fee once the period allows; everything else about the run stands.
    if (recovering) {
      if (replayedIssue !== undefined) {
        // The key already names this run's ISSUE, so this call is ambiguous by construction. It is
        // either that issue's retry or a recovery request, and nothing in the input distinguishes
        // them.
        //
        // While the period is STILL LOCKED there is nothing to disambiguate: the recovery could not
        // book anyway, so the issue's memo is the whole truth and is replayed. It is not a silent
        // no-op, because it carries `feeSkippedReason: 'period_locked'`, which is exactly why the
        // fee is not on the ledger.
        //
        // Once the period is open the two readings diverge on whether money moves, and the engine
        // refuses to pick. Naming the remedy is what makes the refusal actionable: a recovery asked
        // for under its own key is unambiguous and goes through.
        const periodOpen = ctx.periods.assertOpen(ctx.clock.now().slice(0, 10));
        if (!periodOpen.ok) return replayedIssue;
        return err('recovery_needs_its_own_key', {
          runId: run.id,
          reason: 'idempotency_key_already_names_the_issue',
          remedy: 'call_again_with_a_new_idempotency_key',
        });
      }
      return recoverSkippedFee(ctx, recoverKey, run, input);
    }
    if (replayedIssue !== undefined) return replayedIssue;
    return err('illegal_transition', { runId: run.id, from: run.status, to: 'issued' });
  }

  if (replayedIssue !== undefined) return replayedIssue;

  // P8 (M15's shape): issuing books money and mints the letter, so it waits for a human unless the
  // workspace dial says otherwise. The capability said the actor MAY; this asks whether a human
  // said so on THIS occasion.
  if (!autoSendEnabled(ctx) && input.confirmed !== true) {
    return err('needs_confirmation', { runId: run.id, reason: 'issue_requires_confirmation' });
  }

  // The letter's mandatory content starts with the creditor block (A00). Refusing here, before any
  // write, is the P9 CTA the surface renders; issuing letterless would strand the run.
  const ws = ctx.store.db
    .prepare('SELECT creditor_name, creditor_address FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { creditor_name: string | null; creditor_address: string | null } | undefined;
  if (ws === undefined || ws.creditor_name === null || ws.creditor_address === null) {
    return err('needs_creditor_address', { runId: run.id });
  }

  // NEVER CHASE A PAID INVOICE (US-A15.4) AND NEVER RE-ISSUE A LEVEL (C1), both enforced at the
  // last moment before a letter exists. The proposal is re-checked against A16 as of TODAY (a
  // settled or fee-only item drops, a shrunken one shrinks) and against the CURRENT escalation
  // state (an item whose level another run has issued in the meantime drops as stale). The
  // interest note is recomputed on the live principal.
  const today = ctx.clock.now().slice(0, 10);
  const open = listOpenItems(ctx, { asOf: today });
  if (!open.ok) return open;
  const openByDoc = new Map<string, OpenItem>();
  for (const item of chaseableItems(open.items as OpenItem[])) {
    openByDoc.set(item.documentId as string, item);
  }
  const alreadyIssued = issuedLevels(ctx);
  const prevLevelIssueDates = highestIssuedLevelDate(ctx);
  const levels = dunningLevelsOf(ctx);
  const proposed = ctx.store.db
    .prepare('SELECT * FROM dunning_item WHERE workspace_id = ? AND run_id = ?')
    .all(ctx.workspaceId, run.id) as ItemRow[];
  const kept: Candidate[] = [];
  const dropped: string[] = [];
  const droppedStale: string[] = [];
  const droppedTooSoon: string[] = [];
  for (const item of proposed) {
    // THE INVOICE-LEVEL INVARIANT: this level (or a higher one) has already been issued for this
    // document by another run, so issuing it again would be the duplicate letter and the duplicate
    // Mahngebühr the invariant exists to forbid.
    if ((alreadyIssued.get(item.document_id) ?? 0) >= item.level) {
      droppedStale.push(item.document_id);
      continue;
    }
    // K-60, defense in depth: propose already applied the minimum-interval gate, but re-evaluate it
    // at the last write in case the policy TIGHTENED between propose and issue (a wider spacing was
    // configured while the draft sat). At issue the document's highest issued level is this item's
    // previous level, so its issue date is the anchor. Level 1 is never interval-gated.
    if (!intervalSatisfied(item.level as 1 | 2 | 3, prevLevelIssueDates.get(item.document_id), today, levels)) {
      droppedTooSoon.push(item.document_id);
      continue;
    }
    const live = openByDoc.get(item.document_id);
    if (live === undefined) {
      dropped.push(item.document_id);
      continue;
    }
    const cfg = levels[item.level - 1]!;
    const overdueMinor = Math.min(item.overdue_minor, live.openMinor);
    const principalMinor = principalOf(live);
    kept.push({
      documentId: item.document_id,
      debtorId: item.debtor_id,
      number: item.number,
      dueDate: item.due_date,
      currency: item.currency,
      overdueMinor,
      principalMinor,
      daysOverdue: item.days_overdue,
      level: item.level as 1 | 2 | 3,
      feeMinor: item.fee_minor,
      // Art. 104 OR: on the live PRINCIPAL, never on a fee (C5).
      interestMinor: cfg.showInterest
        ? interestNoteMinor(principalMinor, cfg.interestBp, item.days_overdue)
        : null,
    });
  }
  if (kept.length === 0) {
    return err('nothing_to_issue', {
      runId: run.id,
      reason:
        droppedStale.length > 0 || droppedTooSoon.length > 0
          ? 'every_proposed_item_is_settled_already_issued_or_not_yet_due_to_escalate'
          : 'every_proposed_item_is_settled',
      droppedStale,
      droppedTooSoon,
    });
  }

  // The fee books through A02, and postEntry asserts `post` for every caller it does not know. The
  // boundary declared `dun` as the unconditional minimum (the unlock_period shape); the narrower
  // state-dependent gate lives here, BEFORE any write, so a refused actor leaves no half-issued run.
  const attributions: FeeAttribution[] = [];
  for (const c of kept) {
    if (c.feeMinor <= 0) continue;
    const cfg = levels[c.level - 1]!;
    if (!cfg.bookFee || cfg.feeIncomeAccountId === null) continue;
    attributions.push({ documentId: c.documentId, feeMinor: c.feeMinor, accountId: cfg.feeIncomeAccountId });
  }
  const feeTotal = attributions.reduce((n, a) => n + a.feeMinor, 0);
  let feeLines: VatJournalLine[] = [];
  if (feeTotal > 0) {
    const capable = ctx.capabilities.assert('post');
    if (!capable.ok) return capable;
    const debtorAccount = receivableAccount(ctx);
    if ('ok' in debtorAccount) return debtorAccount;
    const built = buildFeeLines(ctx, attributions, debtorAccount.id, today);
    if (!Array.isArray(built)) return { ...built, runId: run.id };
    feeLines = built;
  }

  try {
    return issueUnit(ctx, scopedKey, run, kept, dropped, droppedStale, droppedTooSoon, feeLines, feeTotal, today);
  } catch (e) {
    // A posting rejection ABORTS the idempotency unit (nothing memoised, nothing written) and
    // surfaces as the structured Result it was, so the retry after the repair can succeed.
    if (e instanceof IssueAbort) return e.result;
    throw e;
  }
}

/** A throwable Result: aborts the issue transaction so a rejection is never memoised. */
class IssueAbort {
  constructor(public readonly result: Result) {}
}

function issueUnit(
  ctx: WorkspaceContext,
  scopedKey: string,
  run: RunRow,
  kept: readonly Candidate[],
  dropped: readonly string[],
  droppedStale: readonly string[],
  droppedTooSoon: readonly string[],
  feeLines: VatJournalLine[],
  feeTotal: number,
  today: string,
): Result {
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'issue_dunning_run', () => {
    const now = ctx.clock.now();
    let feeEntryId: string | null = null;
    let feeSkippedReason: string | null = null;

    if (feeTotal > 0) {
      const posted = postEntry(ctx, {
        date: today,
        source: DUNNING_SOURCE,
        description: `Mahngebühren Mahnlauf ${run.run_date}`,
        idempotencyKey: `dunning-fee-${run.id}`,
        lines: feeLines,
      });
      if (!posted.ok) {
        if (posted.error === 'period_locked') {
          // §H-PERIOD, the spec's own answer: the fee is skipped and NAMED, the run still issues.
          // `postEntry` runs its period guard BEFORE its idempotency unit, so nothing is memoised
          // under `dunning-fee-<runId>` here and the recovery branch may re-drive the same key.
          feeSkippedReason = 'period_locked';
        } else {
          throw new IssueAbort(posted);
        }
      } else {
        feeEntryId = posted.entryId as string;
      }
    }

    // Freeze: drop the settled, the stale and the not-yet-due-to-escalate (K-60), shrink the
    // shrunken, restate the note figures. A too-soon drop is not lost: the document re-proposes at
    // its next level once the interval has passed, from A16's live open item.
    const del = ctx.store.db.prepare(
      'DELETE FROM dunning_item WHERE workspace_id = ? AND run_id = ? AND document_id = ?',
    );
    for (const documentId of [...dropped, ...droppedStale, ...droppedTooSoon]) {
      del.run(ctx.workspaceId, run.id, documentId);
    }
    const update = ctx.store.db.prepare(
      `UPDATE dunning_item
          SET overdue_minor = ?, principal_minor = ?, interest_minor = ?, fee_minor = ?,
              fee_booked = ?, demanded_fee_minor = ?
        WHERE workspace_id = ? AND run_id = ? AND document_id = ?`,
    );
    for (const c of kept) {
      // `fee_booked` marks the items whose fee the run's entry actually carries: it is A16's
      // attribution key. A period-locked fee KEEPS its `fee_minor` with `fee_booked = 0` (C8): the
      // claim is deferred, not destroyed, and the recovery branch books it once the period allows.
      //
      // `demanded_fee_minor` is D73's SNAPSHOT: the fee this letter actually asks for, frozen HERE
      // and never touched again. It equals the fee exactly when the fee booked at issue (C6: the
      // letter demands exactly what books), and stays 0 for a deferred fee even after the recovery
      // books it later, because the recovery must never rewrite a letter (least of all a mailed
      // one): the recovered fee's demand arrives one escalation later, through A16's open item.
      const booked = feeSkippedReason === null && feeEntryId !== null && c.feeMinor > 0;
      update.run(
        c.overdueMinor,
        c.principalMinor,
        c.interestMinor,
        c.feeMinor,
        booked ? 1 : 0,
        booked ? c.feeMinor : 0,
        ctx.workspaceId,
        run.id,
        c.documentId,
      );
    }
    ctx.store.db
      .prepare(
        `UPDATE dunning_run SET status = 'issued', issued_at = ?, fee_entry_id = ?, fee_skipped_reason = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, feeEntryId, feeSkippedReason, ctx.workspaceId, run.id);
    // G05: freeze the workspace's default dunning template (id + content snapshot) in the same
    // transaction the figures freeze in. Write-once, no-op without a default, never on a read.
    freezeRenderedTemplate(ctx, { documentKind: 'dunning_run', dunningRunId: run.id });

    const row = readRun(ctx, run.id) as RunRow;
    return ok({ ...runView(ctx, row), droppedSettled: dropped, droppedStale, droppedTooSoon });
  });
}

/**
 * C8's recovery: book a Mahngebühr that a period lock skipped at issue, once the period allows.
 *
 * Reached through `issue_dunning_run` itself (the operator's mental model is "issue it properly
 * now", and a ninth verb for one repair would be surface without a story). The run's items keep
 * their frozen `fee_minor` with `fee_booked = 0`, so the claim is on the record; this books it,
 * flips `fee_booked`, and clears `fee_skipped_reason`. WHAT IT NEVER TOUCHES IS THE LETTER (D73,
 * owner-decided 31.07.2026): `demanded_fee_minor` stays 0, so `get_dunning_pdf` keeps rendering
 * the bytes as issued and mailed, and the recovered fee's demand arrives one escalation later,
 * through A16's open item and the NEXT letter (or ordinary collection on the OP-Liste). Recovery
 * is therefore legal on a SENT run too: it changes the ledger, not the evidence.
 *
 * The entry is dated TODAY (the day it actually books), and the posting key is the run's own
 * deterministic `dunning-fee-<runId>`: the skipped attempt memoised nothing (the period guard runs
 * before postEntry's idempotency unit), so a crash between this booking and the bookkeeping
 * replays the entry rather than double-posting it. There is deliberately NO "already recovered"
 * re-check here (critic N4 deleted the two that existed): the store is synchronous, so this
 * function is only ever entered while `fee_skipped_reason = 'period_locked'`, and a replayed key
 * answers from the idempotency table before this runs.
 *
 * `scopedKey` is the caller's key in the RECOVERY namespace, and the namespace is why a replay
 * still finds this answer at all. A successful recovery clears `fee_skipped_reason` in the same
 * transaction, so the state that routed the original call is gone by the time the same key comes
 * back: `issueDunningRun` therefore consults the recovery memo unconditionally, before it decides
 * anything from the run's current status.
 */
function recoverSkippedFee(
  ctx: WorkspaceContext,
  scopedKey: string,
  run: RunRow,
  input: IssueDunningRunInput,
): Result {
  // P8: booking money waits for a human, exactly as the original issue did.
  if (!autoSendEnabled(ctx) && input.confirmed !== true) {
    return err('needs_confirmation', { runId: run.id, reason: 'issue_requires_confirmation' });
  }
  const items = ctx.store.db
    .prepare(
      `SELECT * FROM dunning_item WHERE workspace_id = ? AND run_id = ? AND fee_minor > 0 AND fee_booked = 0`,
    )
    .all(ctx.workspaceId, run.id) as ItemRow[];
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const levels = dunningLevelsOf(ctx);
  const attributions: FeeAttribution[] = [];
  for (const item of items) {
    const cfg = levels[item.level - 1]!;
    if (cfg.feeIncomeAccountId === null) {
      // The account was unconfigured between skip and recovery: fixable, named, never memoised.
      return err('needs_fee_income_account', { runId: run.id, level: item.level });
    }
    attributions.push({ documentId: item.document_id, feeMinor: item.fee_minor, accountId: cfg.feeIncomeAccountId });
  }
  const debtorAccount = receivableAccount(ctx);
  if ('ok' in debtorAccount) return debtorAccount;
  const today = ctx.clock.now().slice(0, 10);
  const built = buildFeeLines(ctx, attributions, debtorAccount.id, today);
  if (!Array.isArray(built)) return { ...built, runId: run.id };

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'issue_dunning_run', () => {
      const posted = postEntry(ctx, {
        date: today,
        source: DUNNING_SOURCE,
        description: `Mahngebühren Mahnlauf ${run.run_date} (nachgebucht)`,
        idempotencyKey: `dunning-fee-${run.id}`,
        lines: built,
      });
      // Still locked, or any other rejection: abort the unit so nothing is memoised and a later
      // retry can succeed. `period_locked` rides through as itself, the honest answer.
      if (!posted.ok) throw new IssueAbort(posted);
      ctx.store.db
        .prepare(
          `UPDATE dunning_item SET fee_booked = 1
            WHERE workspace_id = ? AND run_id = ? AND fee_minor > 0 AND fee_booked = 0`,
        )
        .run(ctx.workspaceId, run.id);
      ctx.store.db
        .prepare(
          `UPDATE dunning_run SET fee_entry_id = ?, fee_skipped_reason = NULL
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(posted.entryId as string, ctx.workspaceId, run.id);
      const row = readRun(ctx, run.id) as RunRow;
      return ok({ ...runView(ctx, row), feeRecovered: true });
    });
  } catch (e) {
    if (e instanceof IssueAbort) return e.result;
    throw e;
  }
}

export interface SendDunningRunInput {
  runId?: string;
  confirmed?: boolean;
  idempotencyKey?: string;
}

/** The outbound subject per level: the vocabulary a Swiss debtor actually receives. */
export function dunningEmailSubject(level: number, locale: 'de-CH' | 'en' = 'de-CH'): string {
  const de = ['Zahlungserinnerung', '2. Mahnung', '3. und letzte Mahnung'];
  const en = ['Payment reminder', 'Second reminder', 'Third and final reminder'];
  const table = locale === 'de-CH' ? de : en;
  return table[Math.min(Math.max(level, 1), 3) - 1]!;
}

/**
 * Send an issued run's letters by email, one per debtor (US-A15.3's second half).
 *
 * The transport is the ONE irreversible act here, so it follows A11's m-1 discipline per debtor
 * group: a committed `dispatching` marker before the call, `sent_at` committed after it, and an
 * `{ok:false}` transport clears the marker (nothing left the building). A group whose marker
 * survives a crash reads as UNKNOWN: it is skipped by every retry and reported, and the honest
 * manual path is the downloadable PDF, never a gamble on a duplicate letter.
 *
 * The COMPLETED result is memoised under the idempotency key only when the run is fully sent:
 * memoising a partial failure would make the retry replay the failure instead of retrying it.
 */
export function sendDunningRun(ctx: WorkspaceContext, input: SendDunningRunInput): Result {
  const guard = requireString(input.runId, 'runId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const scopedKey = JSON.stringify([input.runId, key]);

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'send_dunning_run');
  if (replayed !== undefined) return replayed;

  const run = readRun(ctx, input.runId as string);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'proposed') {
    return err('illegal_transition', { runId: run.id, from: run.status, to: 'sent' });
  }
  if (run.status === 'sent') {
    // Re-asserting a fully sent run transmits nothing and reports the settled state (§H-IDEMPOTENT
    // in spirit even under a fresh key).
    return ok({ ...runView(ctx, run), transmitted: 0, alreadySent: true });
  }

  // P8: outbound is draft-by-default, for a human's click and for a rule's firing alike.
  if (!autoSendEnabled(ctx) && input.confirmed !== true) {
    return err('needs_confirmation', { runId: run.id, reason: 'outbound_send_requires_confirmation' });
  }

  // M-2: every guard before the first transport call.
  const relay = ctx.emailRelay;
  if (relay === undefined) {
    const configured = configuredRelayMode(ctx);
    // G05 §10: the run-level degradation is one log row (no per-recipient fan-out happened, so
    // there is no recipient to log), with the verb's own P9 reason. Log-only: refusal unchanged.
    recordDispatch(ctx, {
      documentKind: 'dunning_run',
      dunningRunId: run.id,
      channel: 'smtp',
      locale: 'de-CH',
      subjectResolved: '',
      bodyResolved: '',
      defaulted: true,
      outcome: 'degraded',
      degradeReason: configured === null ? 'needs_email_config' : 'needs_email_transport',
    });
    return configured === null
      ? err('needs_email_config', { runId: run.id, transmitted: 0 })
      : err('needs_email_transport', {
          runId: run.id,
          transmitted: 0,
          configured,
          reason: 'workspace.email_relay names a relay but no transport is wired into the context',
        });
  }

  // NEVER CHASE A PAID INVOICE (US-A15.4), enforced at the TRUE last moment. Issue re-checked
  // settlement at the last write before a letter EXISTED; the transport call below is the last
  // moment before a letter LEAVES, and a payment recorded between issue and send (backdated
  // included) must stop it here. The check reads the same A16 derivation propose and issue read,
  // never a fork. D73 stands untouched: the run row, the frozen `dunning_item` rows and the
  // reprint stay exactly as issued (the letter is evidence); what a settled invoice loses is the
  // TRANSPORT, not the record.
  // K-31/K-32: the ONE settlement re-validation, shared with the read model (the manual/download
  // path), broadened from "fully settled" to "changed since issue" and named by distinct cause. It
  // reads A16's own derivation. D73 is untouched: a changed letter loses its transport, not its row.
  const changes = dunningRunChangesSinceIssue(ctx, run, ctx.clock.now().slice(0, 10));

  const items = ctx.store.db
    .prepare('SELECT * FROM dunning_item WHERE workspace_id = ? AND run_id = ? ORDER BY debtor_id')
    .all(ctx.workspaceId, run.id) as ItemRow[];
  const byDebtor = new Map<string, ItemRow[]>();
  for (const item of items) {
    const group = byDebtor.get(item.debtor_id) ?? [];
    group.push(item);
    byDebtor.set(item.debtor_id, group);
  }

  const outcomes: {
    debtorId: string;
    outcome: string;
    detail?: string;
    settledDocumentIds?: string[];
    changedItems?: { documentId: string; reason: DunningItemChange }[];
  }[] = [];
  const skippedSettled: string[] = [];
  let transmitted = 0;

  for (const [debtorId, group] of byDebtor) {
    if (group.every((i) => i.sent_at !== null)) {
      outcomes.push({ debtorId, outcome: 'already_sent' });
      continue;
    }
    if (group.some((i) => i.sent_at === null && i.send_error === 'dispatching')) {
      // A prior attempt reached the transport and its outcome is unknown: never a second call.
      outcomes.push({ debtorId, outcome: 'send_outcome_unknown' });
      continue;
    }
    // A letter that names an invoice CHANGED since issue asserts, under that invoice's own number
    // and QRR reference, a demand that is no longer true: a paid, partially paid, cancelled or
    // credited invoice presented as unpaid. The PDF froze at issue (D73), so it cannot shed one
    // item: the WHOLE letter is skipped, counted and named by its distinct cause (K-31 f2), and the
    // frozen rows stay untouched. A still-open co-item's residual arrives through the next
    // escalation letter (its level was issued, so the machine already owes it one), or by a human
    // mailing the downloadable PDF with eyes open, now that the surface warns which invoice changed.
    const changedItems = group
      .filter((i) => changes.has(i.document_id))
      .map((i) => ({ documentId: i.document_id, reason: changes.get(i.document_id) as DunningItemChange }));
    if (changedItems.length > 0) {
      const settledDocumentIds = changedItems.map((c) => c.documentId);
      const primaryReason = changedItems[0]!.reason;
      skippedSettled.push(...settledDocumentIds);
      // G05 §10: the letter that could not leave is a degraded log row, same as no_email. The
      // degrade reason is the distinct cause (K-31 f2), never a blanket 'settled_since_issue'.
      recordDispatch(ctx, {
        documentKind: 'dunning_run',
        dunningRunId: run.id,
        contactId: debtorId,
        channel: 'smtp',
        locale: 'de-CH',
        subjectResolved: dunningEmailSubject(Math.max(...group.map((i) => i.level))),
        bodyResolved: '',
        defaulted: true,
        outcome: 'degraded',
        degradeReason: primaryReason,
      });
      outcomes.push({ debtorId, outcome: primaryReason, settledDocumentIds, changedItems });
      continue;
    }
    const contact = ctx.store.db
      .prepare('SELECT email FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, debtorId) as { email: string | null } | undefined;
    const email = contact?.email ?? null;
    if (email === null || email.length === 0) {
      markGroup(ctx, run.id, debtorId, { error: 'no_email' });
      // G05 §10: the debtor whose letter could not leave is a degraded log row (one row per
      // recipient, spec §10.2). The downloadable PDF stays the honest manual path, unchanged.
      recordDispatch(ctx, {
        documentKind: 'dunning_run',
        dunningRunId: run.id,
        contactId: debtorId,
        channel: 'smtp',
        locale: 'de-CH',
        subjectResolved: dunningEmailSubject(Math.max(...group.map((i) => i.level))),
        bodyResolved: '',
        defaulted: true,
        outcome: 'degraded',
        degradeReason: 'no_email',
      });
      outcomes.push({ debtorId, outcome: 'no_email' });
      continue;
    }
    const pdf = renderDunningPdf(ctx, { runId: run.id, debtorId });
    if (!pdf.ok) {
      markGroup(ctx, run.id, debtorId, { error: `render_failed:${String(pdf.error)}` });
      recordDispatch(ctx, {
        documentKind: 'dunning_run',
        dunningRunId: run.id,
        contactId: debtorId,
        recipientEmail: email,
        channel: 'smtp',
        locale: 'de-CH',
        subjectResolved: dunningEmailSubject(Math.max(...group.map((i) => i.level))),
        bodyResolved: '',
        defaulted: true,
        outcome: 'failed',
        degradeReason: `render_failed:${String(pdf.error)}`,
      });
      outcomes.push({ debtorId, outcome: 'render_failed', detail: String(pdf.error) });
      continue;
    }
    const level = Math.max(...group.map((i) => i.level));

    // The intent commits BEFORE the irreversible act (A11's m-1), in its own transaction.
    markGroup(ctx, run.id, debtorId, { error: 'dispatching' });
    const sent = relay.send({
      to: email,
      subject: dunningEmailSubject(level),
      pdfBase64: (pdf.pdf as { base64: string }).base64,
    });
    if (sent.ok) {
      markGroup(ctx, run.id, debtorId, { sentAt: ctx.clock.now() });
      // G05 §10: one `sent` log row per debtor, recording exactly what left (the de-CH letter
      // subject and the PDF; the letters are de-CH prose today, so the row says so honestly).
      recordDispatch(ctx, {
        documentKind: 'dunning_run',
        dunningRunId: run.id,
        contactId: debtorId,
        recipientEmail: email,
        channel: 'smtp',
        locale: 'de-CH',
        subjectResolved: dunningEmailSubject(level),
        bodyResolved: '',
        defaulted: true,
        outcome: 'sent',
      });
      outcomes.push({ debtorId, outcome: 'sent' });
      transmitted += 1;
    } else {
      // The port contract: {ok:false} means nothing left the building, so the marker clears and a
      // later retry may transmit once the fault does.
      markGroup(ctx, run.id, debtorId, { error: `send_failed:${sent.reason}` });
      recordDispatch(ctx, {
        documentKind: 'dunning_run',
        dunningRunId: run.id,
        contactId: debtorId,
        recipientEmail: email,
        channel: 'smtp',
        locale: 'de-CH',
        subjectResolved: dunningEmailSubject(level),
        bodyResolved: '',
        defaulted: true,
        outcome: 'failed',
        degradeReason: sent.reason,
      });
      outcomes.push({ debtorId, outcome: 'send_failed', detail: sent.reason });
    }
  }

  const remaining = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM dunning_item WHERE workspace_id = ? AND run_id = ? AND sent_at IS NULL')
    .get(ctx.workspaceId, run.id) as { n: number };
  const fullySent = remaining.n === 0;
  if (fullySent) {
    ctx.store.db
      .prepare(`UPDATE dunning_run SET status = 'sent', sent_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(ctx.clock.now(), ctx.workspaceId, run.id);
  }
  const row = readRun(ctx, run.id) as RunRow;
  const result = ok({ ...runView(ctx, row), transmitted, outcomes, skippedSettled });
  if (fullySent) {
    // Memoise the settled outcome so a retry replays it byte-identically without a render.
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'send_dunning_run', () => result);
  }
  return result;
}

/** Commit one debtor group's outbound state in its own transaction (never inside another unit). */
function markGroup(
  ctx: WorkspaceContext,
  runId: string,
  debtorId: string,
  state: { sentAt?: string; error?: string },
): void {
  ctx.store.tx(() => {
    if (state.sentAt !== undefined) {
      ctx.store.db
        .prepare(
          `UPDATE dunning_item SET sent_at = ?, send_error = NULL
            WHERE workspace_id = ? AND run_id = ? AND debtor_id = ?`,
        )
        .run(state.sentAt, ctx.workspaceId, runId, debtorId);
    } else {
      ctx.store.db
        .prepare(
          `UPDATE dunning_item SET send_error = ?
            WHERE workspace_id = ? AND run_id = ? AND debtor_id = ? AND sent_at IS NULL`,
        )
        .run(state.error ?? null, ctx.workspaceId, runId, debtorId);
    }
  });
}
