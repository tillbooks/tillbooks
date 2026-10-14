/**
 * A36's ranked debit lane and its batch join, moved out of `camtReconcile.ts` unchanged (A39) so the
 * A39 proposal engine (`bankProposals.ts`) and A20's `suggest_matches` share ONE ranking without an
 * import cycle between them. The exact amount + currency gate stays MANDATORY and is never widened
 * (fuzzy amounts on the money path invite wrong bookings, A36 §6b Fixed).
 */

import type { WorkspaceContext } from '../context.js';
import type { QrMatchConfidence } from './qrMatch.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import type { BankTxnRow } from './bankLines.js';
import { readBankTxnDetail } from './bankLines.js';

/**
 * A36 adds the `payment_batch` kind (the batch-debit join) and a structured `signals` list beside the
 * single `reason` code. `signals` is the composed, translatable list of matched signals the GUI
 * renders verbatim (`camt.suggestion.reason.*`) and the agent reads structurally; `reason` stays the
 * single primary code for back-compat with the A21 credit path. `blocked` marks a proposal that is
 * shown for information but NOT one-click confirmable (a batch whose total does not equal the debit):
 * partial batch executions go to the manual split, honestly.
 */
export type CamtMatchSignal = 'amount' | 'value_date' | 'counterparty' | 'reference' | 'batch' | 'batch_total_mismatch';

export interface CamtMatchProposal {
  kind: 'invoice' | 'vendor_bill' | 'payment_batch';
  targetId: string;
  confidence: QrMatchConfidence;
  reason: string;
  signals?: readonly CamtMatchSignal[];
  blocked?: boolean;
}

/** A36: the workspace's debit-matching tuning, with the spec defaults when no row is set. */
export interface CamtMatchConfig {
  valueDateWindowDays: number;
  reviewThreshold: 'any' | 'medium' | 'high';
}

export function readCamtMatchConfig(ctx: WorkspaceContext): CamtMatchConfig {
  const row = ctx.store.db
    .prepare('SELECT value_date_window_days AS w, review_threshold AS t FROM camt_match_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { w: number; t: string } | undefined;
  const window = row !== undefined && Number.isInteger(row.w) && row.w >= 0 ? row.w : 5;
  const threshold: CamtMatchConfig['reviewThreshold'] =
    row?.t === 'medium' || row?.t === 'high' ? row.t : 'any';
  return { valueDateWindowDays: window, reviewThreshold: threshold };
}

/** A confidence rank so a threshold can be compared: none < medium < high. */
export const CONFIDENCE_RANK: Record<QrMatchConfidence, number> = { none: 0, medium: 1, high: 2 };
const THRESHOLD_RANK: Record<CamtMatchConfig['reviewThreshold'], number> = { any: 1, medium: 1, high: 2 };

/**
 * A booked, non-reversal txn NEEDS REVIEW when it has no proposal at or above the workspace threshold.
 * Default `any`: needs review iff there is no proposal at all (every real proposal is at least
 * `medium`). A reversal-flagged (unclassified) txn is a returned movement a human always inspects, so
 * it never suppresses review on the strength of an automated score.
 */
export function needsReviewFor(
  proposal: CamtMatchProposal | null,
  threshold: CamtMatchConfig['reviewThreshold'],
  reversal: boolean,
): boolean {
  // F3 remediation: honour the invariant this function's own doc states. A reversal-flagged
  // (unclassified) txn is a returned movement a human always inspects, so it needs review even when a
  // coincidental exact-amount candidate scores `high` (A20-C3 lets a reversal DBIT settle, but the
  // settlement stays a human's deliberate call, never an automated suppression).
  if (reversal) return true;
  if (proposal === null || proposal.blocked === true) return true;
  return CONFIDENCE_RANK[proposal.confidence] < THRESHOLD_RANK[threshold];
}

interface OpenBill {
  id: string;
  openMinor: number;
  dueDate: string | null;
  contactId: string;
  vendorReference: string | null;
}

/**
 * Every open vendor bill in this currency, with the amount still owed and the fields the ranker
 * scores on (counterparty contact, the supplier's own invoice number). §H-TENANT on the read.
 * Deliberately over `vendor_bill` directly rather than through `listVendorBills`'s ceiling-and-view
 * machinery: this is an internal scoring input, not a page a caller lists.
 */
function openVendorBills(ctx: WorkspaceContext, currency: string): OpenBill[] {
  // A39 §4.3: never a bill a live (draft or generated) A18 run pays; that line books through the run.
  const rows = ctx.store.db
    .prepare(
      `SELECT id, due_date, payable_minor, contact_id, vendor_reference FROM vendor_bill vb
        WHERE workspace_id = ? AND status = 'posted' AND currency = ?
          AND NOT EXISTS (SELECT 1 FROM payment_batch_item pbi JOIN payment_batch pb ON pb.workspace_id = pbi.workspace_id AND pb.id = pbi.batch_id
                           WHERE pbi.workspace_id = vb.workspace_id AND pbi.vendor_bill_id = vb.id AND pb.status IN ('draft', 'generated'))`,
    )
    .all(ctx.workspaceId, currency) as {
    id: string;
    due_date: string | null;
    payable_minor: number;
    contact_id: string;
    vendor_reference: string | null;
  }[];
  return rows
    .map((r) => ({
      id: r.id,
      dueDate: r.due_date,
      openMinor: r.payable_minor - settledOnVendorBill(ctx, r.id),
      contactId: r.contact_id,
      vendorReference: r.vendor_reference,
    }))
    .filter((r) => r.openMinor > 0);
}

/** The contact's display name, for counterparty token overlap. */
function contactName(ctx: WorkspaceContext, contactId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { name: string | null } | undefined;
  return row?.name ?? null;
}

const LEGAL_FORM_STOPWORDS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'inc', 'the']);

/** Lowercase, diacritic-fold, split on non-letters, drop legal-form stopwords and 1-char tokens. */
function nameTokens(s: string | null): Set<string> {
  if (s === null) return new Set();
  const folded = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = new Set<string>();
  for (const tok of folded.split(/[^a-z0-9]+/)) {
    if (tok.length >= 2 && !LEGAL_FORM_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/** Absolute day distance between two ISO dates, or null when either is missing/unparseable. */
function dayDistance(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(Math.round((ta - tb) / 86_400_000));
}

/**
 * A36 the batch-debit join (spec §4): a debit whose `batch_pmt_inf_id` equals the PmtInfId TILL wrote
 * for an A18 `generated` batch (the value frozen on `payment_batch.pmt_inf_id`, never derived from the
 * batch id, which a restore re-mints: A18 F9) proposes the BATCH. Amount equal to
 * the batch control sum: top confidence, one-click confirm routes through A18's settlement (never a
 * bespoke split). Amount NOT equal: shown for information, `blocked` so the one-click is disabled
 * (a partial execution goes to the manual split). Integer Rappen equality only, no rounding (P2).
 */
function batchJoin(ctx: WorkspaceContext, row: BankTxnRow): CamtMatchProposal | null {
  if (row.batch_pmt_inf_id === null || row.batch_pmt_inf_id.length === 0) return null;
  const batches = ctx.store.db
    .prepare("SELECT id, ctrl_sum_minor, pmt_inf_id FROM payment_batch WHERE workspace_id = ? AND status = 'generated'")
    .all(ctx.workspaceId) as { id: string; ctrl_sum_minor: number | null; pmt_inf_id: string | null }[];
  for (const b of batches) {
    if (b.pmt_inf_id !== row.batch_pmt_inf_id) continue;
    const totalMatches = b.ctrl_sum_minor === row.amount_minor;
    return {
      kind: 'payment_batch',
      targetId: b.id,
      confidence: totalMatches ? 'high' : 'medium',
      reason: 'batch',
      signals: totalMatches ? ['batch'] : ['batch', 'batch_total_mismatch'],
      ...(totalMatches ? {} : { blocked: true }),
    };
  }
  return null;
}

/**
 * The ranked debit lane (spec §4, implementing what A20 §4 already promised). The exact amount +
 * currency gate stays MANDATORY: a candidate never appears on an amount mismatch, and that gate is
 * never widened (fuzzy amounts on the money path invite wrong bookings, §6b Fixed). Over the gated
 * set, ranking adds value-date proximity (window default +/- 5 days, workspace-configurable),
 * normalized counterparty-name token overlap, and reference hits (vendor_reference in the remittance
 * text, or EndToEndId equality). The reason is a composed list of matched SIGNALS the GUI renders and
 * the agent reads. Pure read; suggestion only, never a booking.
 */
export function rankDebitCandidates(ctx: WorkspaceContext, row: BankTxnRow, config: CamtMatchConfig): CamtMatchProposal | null {
  // The batch join wins when it fires: it is the strongest possible signal (TILL wrote that PmtInfId).
  const batch = batchJoin(ctx, row);
  if (batch !== null) return batch;

  // THE MANDATORY GATE: exact amount + currency. openVendorBills already filtered to `row.currency`.
  const gated = openVendorBills(ctx, row.currency).filter((b) => b.openMinor === row.amount_minor);
  if (gated.length === 0) return null;

  // A39: the counterparty of a DEBIT is its creditor (`RltdPties/Cdtr`), and the supplier's invoice
  // number usually travels in the unstructured remittance (`Ustrd`) or the EndToEndId; both are read
  // from the line's parsed detail, so the reference signal A36 promised finds them.
  const detail = readBankTxnDetail(ctx, row.id);
  const payerTokens = nameTokens([row.payer_name, detail?.counterparty_name].filter((s): s is string => typeof s === 'string').join(' ') || null);
  const ref = [row.reference_value, detail?.remittance_text, detail?.end_to_end_id]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  const entryRef = (row.entry_ref ?? '').toLowerCase();

  const scored = gated.map((bill) => {
    const signals: CamtMatchSignal[] = ['amount'];
    let score = 0;
    // Value date within the window (closest wins the tie-break below).
    const dist = dayDistance(row.value_date, bill.dueDate);
    const withinWindow = dist !== null && dist <= config.valueDateWindowDays;
    if (withinWindow) {
      signals.push('value_date');
      score += 3;
    }
    // Counterparty token overlap.
    const billTokens = nameTokens(contactName(ctx, bill.contactId));
    let overlap = 0;
    for (const tok of payerTokens) if (billTokens.has(tok)) overlap += 1;
    if (overlap > 0) {
      signals.push('counterparty');
      score += 2 + overlap;
    }
    // Reference: the supplier's invoice number quoted in the remittance / EndToEndId.
    const vref = (bill.vendorReference ?? '').toLowerCase();
    if (vref.length >= 3 && (ref.includes(vref) || entryRef.includes(vref))) {
      signals.push('reference');
      score += 4;
    }
    return { bill, signals, score, dist: dist ?? Number.MAX_SAFE_INTEGER };
  });

  // Deterministic order: highest score, then closest value date, then bill id (equal scores tie
  // visibly and never auto-pick, spec US-A36.5).
  scored.sort((a, b) => b.score - a.score || a.dist - b.dist || a.bill.id.localeCompare(b.bill.id));
  const best = scored[0]!;

  // A uniquely top-scoring gated candidate is `high` (the single-exact-amount case, or one bill that
  // the value date / counterparty / reference singles out); an ambiguous set where the top score ties
  // is `medium`, so a human picks and the tie is visible (spec US-A36.5, never auto-picked).
  const uniquelyBest = scored.length === 1 || best.score > (scored[1]?.score ?? -1);
  const confidence: QrMatchConfidence = uniquelyBest ? 'high' : 'medium';
  const primary = best.signals.includes('reference')
    ? 'reference_match'
    : best.signals.includes('counterparty')
      ? 'counterparty_match'
      : 'exact_open';
  return { kind: 'vendor_bill', targetId: best.bill.id, confidence, reason: primary, signals: best.signals };
}
