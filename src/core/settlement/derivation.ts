/**
 * A42, HOW A TURNOVER BOOKING IS DERIVED: the optional derivation refs a producer may state on an event
 * (`till-settlement/v1` refs, additive 13.11.2026), read for the Umsatz review and never for booking.
 *
 * The producer states, per sale, the net its payout formula used, the platform fee (taken, or waived with a
 * reason), the processor's fee, the coach payout it expected, the coach's self-bill and the transfer, and its own
 * verdict `derivationOk` on the identity
 *
 *     payoutNet - platformFee - processingFee = coachPayoutExpected
 *
 * and on the expected payout against the self-bill (or the transfer less the clawbacks netted into it).
 *
 * TILL CHECKS IT AGAIN, STATELESSLY (`till`): the same identity over the stated figures, so a producer verdict
 * the figures contradict shows. Neither verdict changes what is booked: the import books the event's own
 * amount, net and VAT (D185), and the review's `reviewSha256` digests the import's outcomes, not these refs.
 *
 * QUIET DEGRADATION. Every field is optional. A missing, null or malformed field is null here and is simply
 * not shown; refs without any derivation field (an older feed, a pack file written before the addition, refs
 * stored `{ truncated: true }`) answer null, and the row shows what exists. Nothing here refuses an event.
 *
 * PRIVACY. This answer carries record ids, codes and figures only; the payer's email and name stay in the
 * review's `counterparty`, masked for a governed seat.
 */

import { parseExactMinor } from './format.js';

export type PlatformFeeWaiverReason = 'new_coach_window' | 'override' | 'unknown';

export interface SettlementDerivation {
  /** What the producer derived the event from (e.g. `bondigoo_transaction+price_snapshot`). */
  derivedFrom: string | null;
  /** The seller's VAT role (e.g. `deemed_supplier`). */
  sellerRole: string | null;
  /** The producer's VAT rule (e.g. `ch_standard_8_1`). */
  vatRule: string | null;
  /** The VAT rate in percent as the event states it (e.g. `8.1`), else from `vatRule`. */
  vatRatePercent: string | null;
  platformFee: {
    bp: number | null;
    amountMinor: number | null;
    waived: boolean | null;
    waiverReason: PlatformFeeWaiverReason | null;
  };
  processingFeeMinor: number | null;
  processingFeeSource: string | null;
  payoutNetMinor: number | null;
  coachPayoutExpectedMinor: number | null;
  selfBill: { number: string | null; amountMinor: number | null; hasVat: boolean | null };
  coachTransferMinor: number | null;
  coachPayoutAdjustmentMinor: number | null;
  coachVatRegistered: boolean | null;
  ids: {
    bookingId: string | null;
    sessionId: string | null;
    liveSessionId: string | null;
    paymentIntentId: string | null;
    chargeId: string | null;
    transferId: string | null;
    payoutId: string | null;
  };
  /** The producer's own verdict and its difference (actual - expected), when stated. */
  stated: { ok: boolean | null; diffMinor: number | null };
  /**
   * TILL's stateless re-check of the stated figures: false when a stated identity does not hold, true when every
   * figure it needs is stated and it holds, null when a figure is missing.
   */
  till: boolean | null;
  /** The verdict to show: false when either verdict is false, true when one is true and neither is false,
   * else null. */
  ok: boolean | null;
  /** The producer clipped free-text refs to stay within its size budget. */
  refsTrimmed: boolean;
}

const ID_MAX = 200;

/** The keys whose presence makes refs a derivation (any one of them). */
const DERIVATION_KEYS = [
  'derivedFrom',
  'sellerRole',
  'vatRule',
  'platformFeeBp',
  'platformFeeAmount',
  'feeWaived',
  'platformFeeWaiverReason',
  'processingFeeAmount',
  'payoutNet',
  'coachPayoutExpected',
  'selfBillNumber',
  'selfBillAmount',
  'coachTransferAmount',
  'coachPayoutAdjustment',
  'derivationOk',
  'derivationDiff',
] as const;

const WAIVER_REASONS: ReadonlySet<string> = new Set(['new_coach_window', 'override', 'unknown']);

/**
 * An id or a code: letters, digits and `_ . : + / -` only (code critic r2 L5). No `@`, no space: free text, an
 * email or a name with a space in an id field is dropped. An id field cannot tell a one-word name from an id
 * (r4 L2): the producer's contract keeps persons out of these fields; this check removes emails and sentences.
 */
const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/;

function idOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= ID_MAX && ID_TEXT.test(s) ? s : null;
}

function boolOf(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function minorOf(v: unknown): number | null {
  return v === null || v === undefined ? null : parseExactMinor(v);
}

function bpOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null;
}

function rateOf(eventRate: string | null, vatRule: string | null): string | null {
  if (eventRate !== null && /^\d{1,2}(?:\.\d{1,2})?$/.test(eventRate)) return eventRate;
  if (vatRule === 'ch_standard_8_1') return '8.1';
  if (vatRule === 'zero') return '0';
  return null;
}

/**
 * TILL's stateless re-check: `payoutNet - platformFee - processingFee = coachPayoutExpected`, and the expected
 * payout against the self-bill, or the transfer less the clawbacks netted into it when no self-bill is stated.
 */
function tillCheck(d: Omit<SettlementDerivation, 'till' | 'ok'>): boolean | null {
  const net = d.payoutNetMinor;
  const fee = d.platformFee.amountMinor;
  const proc = d.processingFeeMinor;
  const expected = d.coachPayoutExpectedMinor;
  let identity: boolean | null = null;
  if (net !== null && fee !== null && proc !== null && expected !== null) identity = net - fee - proc === expected;
  // A waived fee is 0 by the contract: a stated non-zero fee on a waived sale contradicts it.
  if (d.platformFee.waived === true && fee !== null && fee !== 0) identity = false;
  let actual: number | null = null;
  if (d.selfBill.amountMinor !== null) actual = d.selfBill.amountMinor;
  else if (d.coachTransferMinor !== null) actual = d.coachTransferMinor - (d.coachPayoutAdjustmentMinor ?? 0);
  const payout = expected !== null && actual !== null ? actual === expected : null;
  if (identity === false || payout === false) return false;
  if (identity === true && payout === true) return true;
  return null;
}

/** The derivation an event's refs state, or null when they state none (module header). */
export function derivationOf(refs: Record<string, unknown>, eventVatRate: string | null): SettlementDerivation | null {
  if (!DERIVATION_KEYS.some((k) => refs[k] !== undefined && refs[k] !== null)) return null;
  const vatRule = idOf(refs['vatRule']);
  const waiver = typeof refs['platformFeeWaiverReason'] === 'string' && WAIVER_REASONS.has(refs['platformFeeWaiverReason']) ? (refs['platformFeeWaiverReason'] as PlatformFeeWaiverReason) : null;
  const base: Omit<SettlementDerivation, 'till' | 'ok'> = {
    derivedFrom: idOf(refs['derivedFrom']),
    sellerRole: idOf(refs['sellerRole']),
    vatRule,
    vatRatePercent: rateOf(eventVatRate, vatRule),
    platformFee: { bp: bpOf(refs['platformFeeBp']), amountMinor: minorOf(refs['platformFeeAmount']), waived: boolOf(refs['feeWaived']), waiverReason: waiver },
    processingFeeMinor: minorOf(refs['processingFeeAmount']),
    processingFeeSource: idOf(refs['processingFeeSource']),
    payoutNetMinor: minorOf(refs['payoutNet']),
    coachPayoutExpectedMinor: minorOf(refs['coachPayoutExpected']),
    selfBill: { number: idOf(refs['selfBillNumber']), amountMinor: minorOf(refs['selfBillAmount']), hasVat: boolOf(refs['selfBillHasVat']) },
    coachTransferMinor: minorOf(refs['coachTransferAmount']),
    coachPayoutAdjustmentMinor: minorOf(refs['coachPayoutAdjustment']),
    coachVatRegistered: boolOf(refs['coachVatRegistered']),
    ids: {
      bookingId: idOf(refs['bookingId']),
      sessionId: idOf(refs['sessionId']),
      liveSessionId: idOf(refs['liveSessionId']),
      paymentIntentId: idOf(refs['paymentIntentId']),
      chargeId: idOf(refs['chargeId']),
      transferId: idOf(refs['transferId']),
      payoutId: idOf(refs['payoutId']),
    },
    stated: { ok: boolOf(refs['derivationOk']), diffMinor: minorOf(refs['derivationDiff']) },
    refsTrimmed: refs['refsTrimmed'] === true,
  };
  const till = tillCheck(base);
  const ok = base.stated.ok === false || till === false ? false : base.stated.ok === true || till === true ? true : null;
  return { ...base, till, ok };
}
