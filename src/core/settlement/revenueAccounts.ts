/**
 * D203 (critic r1 L1, L3), WHICH ACCOUNT IS TURNOVER: one predicate, read from the Erfolgsrechnung's own section
 * map, for `turnover_summary` (what it sums) and the booking template (what a payout may never be booked to).
 *
 * A revenue account is a result account (type income or expense) in the Erfolgsrechnung's position 1,
 * Nettoerlöse (`erfolgSectionFor` = `netto_erloese`: 30xx to 38xx, Erlösminderungen included, 39xx
 * Bestandesänderungen not). A leaf module: it imports only `reports/sections.ts`, so the template, the review
 * and the summary can all read it without a cycle.
 */

import { erfolgSectionFor } from '../reports/sections.js';

/** The kinds that move the processor's balance to the bank: a payout, never turnover. */
export const PAYOUT_KINDS: ReadonlySet<string> = new Set(['bank_payout', 'bank_payout_summary']);

export function isRevenueAccount(account: { number: string; type: string }): boolean {
  return (account.type === 'income' || account.type === 'expense') && erfolgSectionFor(account) === 'netto_erloese';
}
