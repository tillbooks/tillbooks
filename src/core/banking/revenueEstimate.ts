/**
 * D186 point 2, THE ESTIMATED TURNOVER OF THE OPEN BANK LINES: what booking the open lines would add to
 * the Nettoerlöse, read before anyone books them. A pure read: it posts nothing and stores nothing.
 *
 * ONE SOURCE FOR THE FIGURE: the booking preview. Each open line in the window gets the proposal the inbox
 * shows for it (`proposeForLine`, the same ladder: an existing entry, a QR or vendor-bill match, an own
 * account, the person's Buchungsregel, then history). Where that proposal books to ACCOUNTS (an `accounts`
 * or a `rule` target), `composeBankLine` previews exactly the lines `book_bank_line` would post (the rule
 * expanded on the line, its factor and its MWST split by A02's own composer, `test/banking/
 * bank-compose-parity.test.mjs`), and the estimate sums what those lines put on the Erfolgsrechnung's
 * `netto_erloese` accounts (A08's `erfolgSectionFor`, never a second classification), credit minus debit,
 * in base-currency Rappen. So the figure is net of MWST wherever the rule computes it, and a payout a
 * rule grosses up by a fee factor counts at its grossed-up net, as it will be booked.
 *
 * WHAT IS NOT COUNTED, and said so per reason (`excluded`): a line flagged as a possible duplicate and not
 * yet decided (the booking refuses it until then, critic D186-1), a line whose proposal SETTLES a document
 * (`open_item`, `payment_batch`, `existing_entry`, `contact`, `expense_claims`: the turnover of an invoice
 * was booked when the invoice was issued, so paying it adds none), a line the ladder would ignore, a line
 * with no proposal, a line whose proposal is below the chosen certainty, a line whose preview the booking
 * would refuse (an ask still missing, a rest of zero), and a line whose preview touches no revenue
 * account. Nothing is guessed.
 *
 * THE BASIS IS A SETTING (D172): `rules` (default) counts every proposal a Buchungsregel makes (the
 * person's own rule, whatever certainty the inbox gives it: a computed-factor rule is `check` there until
 * it earns `sure`, and it is still the person's instruction) plus the proposals the inbox calls sure or
 * learned (an exact match, a pattern the books repeat); `all` also counts the history guesses it asks the
 * person to check. The window is the lines' booking date (else value date) inside [from, to].
 *
 * §H-TENANT on every query: the one query of its own fences `bank_txn.workspace_id`; the proposal and the
 * preview are the inbox's own reads.
 */

import type { WorkspaceContext } from '../context.js';
import { erfolgSectionFor } from '../reports/sections.js';
import { LINE_STATE_EXPR, LINE_STATE_JOINS } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow } from './bankLines.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import type { BankLineProposal } from './bankProposals.js';
import { composeBankLine } from './bankBooking.js';
import { duplicatePendingIds } from './statementDedupe.js';

/** D186: which proposals the estimate trusts. The registry entry `overview.estimate_basis` names the same two. */
export const REVENUE_ESTIMATE_BASES = ['rules', 'all'] as const;
export type RevenueEstimateBasis = (typeof REVENUE_ESTIMATE_BASES)[number];

/** Why an open line in the window adds nothing to the estimate. */
export const REVENUE_ESTIMATE_EXCLUSIONS = ['duplicate_pending', 'settles_document', 'ignored_by_rule', 'no_proposal', 'below_basis', 'not_bookable', 'no_revenue'] as const;
export type RevenueEstimateExclusion = (typeof REVENUE_ESTIMATE_EXCLUSIONS)[number];

/** One line that counts: its share of the estimate and where it comes from. */
export interface RevenueEstimateLine {
  bankTxnId: string;
  bankAccountId: string;
  date: string | null;
  /** The line's signed amount in its own currency (+ in, - out). */
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  /** `rule`: a Buchungsregel proposes it; `proposal`: another rung of the ladder. */
  basis: 'rule' | 'proposal';
  certainty: BankLineProposal['certainty'];
  reasonCode: BankLineProposal['reasonCode'];
  /** The revenue accounts the booking would touch, by number. */
  accountNumbers: string[];
  /** What the booking would add to the Nettoerlöse: credit minus debit on those accounts, base Rappen. */
  revenueMinor: number;
}

export interface RevenueEstimate {
  from: string;
  to: string;
  basis: RevenueEstimateBasis;
  currency: string;
  /** Σ revenueMinor of `lines`. */
  revenueMinor: number;
  lines: RevenueEstimateLine[];
  /** The open lines of the window that add nothing, counted per reason (every reason present, 0 included). */
  excluded: Record<RevenueEstimateExclusion, number>;
  /** Every open line of the window: `lines.length` + Σ excluded. */
  openLines: number;
}

const SETTLES: ReadonlySet<string> = new Set(['open_item', 'payment_batch', 'existing_entry', 'contact', 'expense_claims']);
const CONFIDENT: ReadonlySet<string> = new Set(['sure', 'learned']);

function baseCurrency(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(ctx.workspaceId) as { base_currency: string } | undefined;
  return row?.base_currency ?? 'CHF';
}

/** The estimate for the open lines dated inside [from, to] (ISO days, validated by the caller). */
export function revenueEstimate(ctx: WorkspaceContext, input: { from: string; to: string; basis?: RevenueEstimateBasis }): RevenueEstimate {
  const basis: RevenueEstimateBasis = input.basis ?? 'rules';
  const excluded = Object.fromEntries(REVENUE_ESTIMATE_EXCLUSIONS.map((r) => [r, 0])) as Record<RevenueEstimateExclusion, number>;
  const open = ctx.store.db
    .prepare(
      `SELECT t.*, d2.counterparty_name, d2.counterparty_iban, d2.remittance_text, d2.end_to_end_id
         FROM bank_txn t ${LINE_STATE_JOINS('t')}
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND ${LINE_STATE_EXPR('t')} = 'open'
          AND COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10)) >= ?
          AND COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10)) <= ?
        ORDER BY COALESCE(t.booking_date, t.value_date, t.created_at), t.id`,
    )
    .all(ctx.workspaceId, input.from, input.to) as (BankTxnRow & BankTxnDetailRow)[];
  const lines: RevenueEstimateLine[] = [];
  if (open.length > 0) {
    const pc = proposalContext(ctx);
    // Critic D186-1: a line flagged as a possible duplicate is refused by the booking until the person
    // decides (`duplicate_decision_pending`), and the preview does not run that chokepoint, so it is
    // excluded here by the same predicate (`duplicatePendingIds`, the ladder's own).
    const duplicates = duplicatePendingIds(ctx);
    for (const r of open) {
      if (duplicates.has(r.id)) {
        excluded.duplicate_pending += 1;
        continue;
      }
      const detail: BankTxnDetailRow = {
        counterparty_name: r.counterparty_name,
        counterparty_iban: r.counterparty_iban,
        remittance_text: r.remittance_text,
        end_to_end_id: r.end_to_end_id,
      };
      const proposal = proposeForLine(ctx, pc, r, detail);
      const target = proposal.target;
      if (target === null) {
        excluded.no_proposal += 1;
        continue;
      }
      if (target.kind === 'ignore') {
        excluded.ignored_by_rule += 1;
        continue;
      }
      if (SETTLES.has(target.kind)) {
        excluded.settles_document += 1;
        continue;
      }
      const byRule = target.kind === 'rule' || typeof proposal.reasonParams['standardId'] === 'string';
      if (basis === 'rules' && !byRule && !CONFIDENT.has(proposal.certainty)) {
        excluded.below_basis += 1;
        continue;
      }
      const preview = composeBankLine(ctx, { bankTxnId: r.id, target });
      const entries = preview.ok ? preview.booking?.entries ?? [] : [];
      if (!preview.ok || preview.booking === undefined || !preview.booking.bookable || entries.length === 0) {
        excluded.not_bookable += 1;
        continue;
      }
      let revenueMinor = 0;
      const numbers = new Set<string>();
      for (const entry of entries) {
        for (const line of entry.lines) {
          if (erfolgSectionFor({ number: line.accountNumber }) !== 'netto_erloese') continue;
          revenueMinor += line.baseCredit - line.baseDebit;
          numbers.add(line.accountNumber);
        }
      }
      if (numbers.size === 0) {
        excluded.no_revenue += 1;
        continue;
      }
      lines.push({
        bankTxnId: r.id,
        bankAccountId: r.bank_account_id,
        date: r.booking_date ?? r.value_date ?? null,
        amountMinor: r.credit_debit === 'CRDT' ? r.amount_minor : -r.amount_minor,
        currency: r.currency,
        counterparty: r.counterparty_name ?? r.payer_name ?? null,
        basis: byRule ? 'rule' : 'proposal',
        certainty: proposal.certainty,
        reasonCode: proposal.reasonCode,
        accountNumbers: [...numbers].sort(),
        revenueMinor,
      });
    }
  }
  return {
    from: input.from,
    to: input.to,
    basis,
    currency: baseCurrency(ctx),
    revenueMinor: lines.reduce((s, l) => s + l.revenueMinor, 0),
    lines,
    excluded,
    openLines: open.length,
  };
}
