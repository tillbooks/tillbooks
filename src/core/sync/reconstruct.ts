/**
 * M02: reconstruct-from-stream. The CONSUMER side of the contract, shipped with the MIT core so
 * "the managed tier obeys §I" is a test suite the public can run, not a promise.
 *
 * It takes a list of `journal.posted` envelopes and rebuilds ledger state (a base-currency trial
 * balance, keyed by account number) using ONLY what the stream carries: integer Rappen and the §H-FX
 * base amounts. It reaches into no database and needs no schema access, which is the whole point:
 * a consumer that can rebuild the books from the publish stream never has to open the tenant file.
 *
 * TWO PROPERTIES IT PROVES, both asserted by the golden fixture:
 *  1. LOSSLESS: the reconstructed trial balance equals the engine's own `computeTrialBalance` to the
 *     Rappen, so nothing the ledger holds is lost on the wire.
 *  2. ORDER-STABLE AND BALANCED: every posted fact carries Σdebit == Σcredit in base currency and
 *     every amount is an integer, so the stream inherits the ledger's balance rather than assuming it;
 *     and folding the events in any order yields the same trial balance (a sum is commutative), while
 *     `seq` order is what a cursor advances over.
 *
 * There is NO command handling here, and there cannot be: the function reads FACTS and produces a
 * projection. It never calls a verb, never posts, never writes. That is the one-writer invariant seen
 * from the consumer's side.
 */

import { STREAM_KINDS, isFactKind } from './contract.js';
import type { StreamEnvelope } from './contract.js';

export interface ReconstructedLine {
  account: string;
  accountNumber: string;
  baseDebitMinor: number;
  baseCreditMinor: number;
}

export interface ReconstructResult {
  /** Base-currency closing balance per account NUMBER: debit-positive minor units. */
  balancesByAccount: Record<string, number>;
  /** Base currency the stream reported (must be one value across the whole stream). */
  baseCurrency: string | null;
  /** Every posted fact balanced in base currency and carried only integer amounts. */
  everyFactBalanced: boolean;
  /** Σ of all base debits == Σ of all base credits across the reconstructed set. */
  balancedOverall: boolean;
  /** How many `journal.posted` events were folded. */
  journalEvents: number;
}

interface JournalPayloadLine {
  account: string;
  accountNumber: string;
  baseDebitMinor: number;
  baseCreditMinor: number;
}

/**
 * Fold a stream into a base-currency trial balance. Non-journal families (`artifact.*`, `readmodel.*`)
 * are ignored for the trial-balance projection: they carry no double-entry movement. A `kind` that is
 * not a FACT at all is refused outright (there is no such thing as a command event to apply), which is
 * the reconstruct-side guard behind "the stream cannot instruct the ledger".
 */
export function reconstructFromStream(events: readonly StreamEnvelope[]): ReconstructResult {
  const balances: Record<string, number> = {};
  let baseCurrency: string | null = null;
  let everyFactBalanced = true;
  let debitTotal = 0n;
  let creditTotal = 0n;
  let journalEvents = 0;

  for (const event of events) {
    if (!isFactKind(event.kind)) {
      // A non-fact kind is not applicable state: the contract defines no command, so an event whose
      // kind is not one of the closed fact families is a contract violation, not an instruction.
      throw new Error(`sync: refusing a non-fact kind on the stream: ${String(event.kind)}`);
    }
    if (event.kind !== STREAM_KINDS.JOURNAL_POSTED) continue;
    journalEvents += 1;

    const payload = event.payload as { baseCurrency?: string; lines?: JournalPayloadLine[] };
    if (typeof payload.baseCurrency === 'string') {
      if (baseCurrency === null) baseCurrency = payload.baseCurrency;
    }
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    let factDebit = 0n;
    let factCredit = 0n;
    for (const line of lines) {
      const debit = line.baseDebitMinor;
      const credit = line.baseCreditMinor;
      if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
        everyFactBalanced = false;
        continue;
      }
      factDebit += BigInt(debit);
      factCredit += BigInt(credit);
      // Debit-positive convention, keyed by account NUMBER (the identity a trial balance reports on).
      const prior = balances[line.accountNumber] ?? 0;
      balances[line.accountNumber] = prior + debit - credit;
    }
    if (factDebit !== factCredit) everyFactBalanced = false;
    debitTotal += factDebit;
    creditTotal += factCredit;
  }

  // Zeros are KEPT, not pruned: an account keyed here appeared on at least one posted line, so it HAD
  // movement, and `computeTrialBalance` keeps every account with movement even when its closing nets to
  // zero (an entry and its reversal). Pruning would drop exactly those accounts and diverge from the
  // ledger. An account that never moved never becomes a key here in the first place.

  return {
    balancesByAccount: balances,
    baseCurrency,
    everyFactBalanced,
    balancedOverall: debitTotal === creditTotal,
    journalEvents,
  };
}
