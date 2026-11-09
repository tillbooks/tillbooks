/**
 * A14 §3, `suggestPaymentMatches`: the read model behind BOTH faces (US-A14.6, P5).
 *
 * The agent's candidate list and the human's candidate list are this one function's output. That is
 * not an efficiency: it is the property that makes "the agent and the human see the same thing" a
 * structural fact instead of a promise, and it is why turning the ranking off changes both faces
 * identically.
 *
 * THE VOCABULARY IS HONEST, which matters more than the words themselves:
 *
 *  - `exact_reference`      the structured reference matches. This tier settles a match on its own.
 *  - `exact_amount_customer` the open amount equals the payment AND the counterparty agrees.
 *  - `amount_tolerance`      the open amount is within the write-off threshold of the payment.
 *  - (no tier)               listed, allocatable, and described by NOTHING.
 *
 * The last row is the load-bearing one. The moment a candidate whose difference is most of the
 * payment is labelled "amount close", the word stops meaning anything, and every other row's word
 * loses its value with it. So a candidate that fits no tier carries no reason at all.
 *
 * TWO SAFETY RULES, both from the guidelines rather than from taste:
 *
 *  1. A mistyped reference never becomes a ranking hint. `classifyReference` reports a bad check
 *     digit as `reference_check_digit`, and this matcher then ranks on the amount ALONE and says so,
 *     rather than letting a typo produce a confident-looking match.
 *  2. A payer name is a hint, never a reason. The SIX guidelines are explicit that the debtor on a
 *     bank credit is whoever actually paid, not necessarily the invoice recipient, so a name
 *     agreement may order rows INSIDE a tier and may never raise one.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalId, optionalText } from '../ledger/inputGuards.js';
import { classifyReference, formatReference } from './reference.js';
import {
  documentReferences,
  settledMinor,
  writeOffThresholdOf,
  SETTLEABLE_STATUSES,
  PAYMENT_DIRECTIONS,
} from './payment.js';
import type { DocRow } from './payment.js';
import type { MatchKind } from './payment.js';
import { baseCurrencyOf } from '../fx/rates.js';
// A15's ONE "is this booked fee LIVE" predicate, and its shared display label (K-29). Imported from
// the file directly, never the `dunning` barrel: the barrel re-exports `run.ts`, which would close a
// cycle back through payments. `reads.ts` imports nothing from payments or debtors, so this edge is
// one-way, exactly as `openItems.ts`'s identical import is.
import { liveDunningFeeItemsAsOf, dunningFeeLabel } from '../dunning/reads.js';

export interface SuggestMatchesInput {
  amountMinor?: number;
  reference?: string | null;
  counterpartyId?: string;
  direction?: string;
  currency?: string;
}

interface Candidate {
  /**
   * `document` for a customer invoice, `vendor_bill` for an A17 Kreditor (Pattern OP3), `dunning_fee`
   * for a booked A15 Mahngebühr (K-29). The last one names a `dunning_item` row, never the invoice it
   * rides, because one invoice can carry more than one booked fee (level 1 AND level 2 are two rows).
   */
  targetKind: 'document' | 'vendor_bill' | 'dunning_fee';
  targetId: string;
  number: string | null;
  contactId: string | null;
  contactName: string | null;
  currency: string;
  dueDate: string | null;
  daysOverdue: number | null;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  status: string;
  reference: { kind: string; value: string } | null;
  kind: MatchKind | null;
  reason: string | null;
  deltaMinor: number | null;
  prefillMinor: number;
  settled: boolean;
  disabledReason: string | null;
}

/** The tier order. Lower sorts first. A candidate with no tier sorts last, by due date. */
const TIER_RANK: Record<MatchKind, number> = {
  exact_reference: 0,
  exact_amount_customer: 1,
  amount_tolerance: 2,
};

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The document types a payment in this direction can settle.
 *
 * Incoming money settles an invoice; outgoing money refunds a credit note OR pays a vendor bill, and
 * the second of those is not a document at all, so it is ranked by `vendorBillCandidates` below and
 * concatenated in. This is what makes the ONE `PaymentAllocator` overlay work from A17's Kreditoren
 * list with no candidate list of its own (A17 §6): the human's list and the agent's list are still
 * this one function's output.
 */
function settleableTypes(direction: string): string[] {
  return direction === 'outgoing' ? ['credit_note'] : ['invoice'];
}

interface BillRow {
  id: string;
  contact_id: string;
  contact_name: string | null;
  vendor_reference: string | null;
  currency: string;
  due_date: string | null;
  payable_minor: number;
  status: string;
}

/**
 * Open vendor bills as payment candidates: the creditor mirror of the document loop below.
 *
 * NO REFERENCE TIER, and that is a fact about Swiss purchasing rather than a gap. A QRR/SCOR
 * reference on a bill we RECEIVED was minted by the supplier for their own books, so it identifies
 * nothing in ours; `documentReferences` derives a reference from OUR document number, which a vendor
 * bill does not have. So a bill ranks on amount and counterparty only, and a bill that fits no tier
 * carries no reason at all, exactly as the document path does.
 */
function vendorBillCandidates(
  ctx: WorkspaceContext,
  input: SuggestMatchesInput,
  payCurrency: string,
  thresholdMinor: number,
  asOf: string,
): { candidates: Candidate[]; openCount: number } {
  const rows = ctx.store.db
    .prepare(
      `SELECT b.id, b.contact_id, c.name AS contact_name, b.vendor_reference, b.currency, b.due_date,
              b.payable_minor, b.status
         FROM vendor_bill b
         LEFT JOIN contact c ON c.id = b.contact_id AND c.workspace_id = ?
        WHERE b.workspace_id = ? AND b.status = 'posted'
        ORDER BY b.due_date IS NULL, b.due_date, b.rowid`,
    )
    .all(ctx.workspaceId, ctx.workspaceId) as BillRow[];

  const candidates: Candidate[] = [];
  let openCount = 0;
  for (const row of rows) {
    const paidMinor = settledMinor(ctx, 'vendor_bill', row.id);
    const openMinor = row.payable_minor - paidMinor;
    const isOpen = openMinor > 0;
    if (isOpen) openCount += 1;
    // A settled bill is simply not offered. The document path SHOWS a settled row when the payer's
    // reference names it, because "you already booked this" answers the question the reference asked;
    // there is no reference here to ask it.
    if (!isOpen) continue;

    const currencyMismatch = row.currency !== payCurrency;
    const delta = input.amountMinor === undefined ? null : openMinor - input.amountMinor;
    const vendorMatched =
      input.counterpartyId !== undefined && row.contact_id === input.counterpartyId;

    let kind: MatchKind | null = null;
    if (delta === 0 && vendorMatched) kind = 'exact_amount_customer';
    else if (delta !== null && Math.abs(delta) <= thresholdMinor) kind = 'amount_tolerance';

    const disabledReason = currencyMismatch ? 'currency_mismatch' : null;
    if (disabledReason !== null) kind = null;

    candidates.push({
      targetKind: 'vendor_bill',
      targetId: row.id,
      number: row.vendor_reference,
      contactId: row.contact_id,
      contactName: row.contact_name,
      currency: row.currency,
      dueDate: row.due_date,
      daysOverdue: row.due_date === null ? null : Math.max(0, daysBetween(row.due_date, asOf)),
      grossMinor: row.payable_minor,
      paidMinor,
      openMinor,
      status: row.status,
      reference: null,
      kind,
      reason: kind,
      deltaMinor: delta,
      prefillMinor: 0,
      settled: false,
      disabledReason,
    });
  }
  return { candidates, openCount };
}

/**
 * Booked, LIVE Mahngebühren as incoming-payment candidates (K-29): the fee mirror of the document
 * loop, sourced from the ONE `liveDunningFeeItemsAsOf` predicate `openItems.ts` and A14's `readTarget`
 * already share, so the read model, the settlement planner and this matcher can never disagree on
 * which fee is live. Without this, `recordPayment` admitted `target_kind = 'dunning_fee'` but the
 * human allocator, driven solely by these candidates, had no row to type an amount against: a fee
 * could be settled by an agent passing `dunningItemId` directly (MCP) and never through the Studio.
 *
 * NO REFERENCE TIER, exactly as a vendor bill has none: a QRR/SCOR reference names the INVOICE, never
 * one of the fees riding it, so a fee ranks on amount and counterparty only. `openMinor` is the fee
 * net of what a prior payment already settled against THIS `dunning_item` (never the document), so a
 * fully-settled fee has no open amount and drops out here just as a settled invoice does.
 *
 * INCOMING ONLY: a Mahngebühr is money the customer owes (a 1100 receivable), so it is settled by an
 * incoming receipt, never refunded like an outgoing credit note. The caller gates on direction below.
 */
function dunningFeeCandidates(
  ctx: WorkspaceContext,
  input: SuggestMatchesInput,
  payCurrency: string,
  thresholdMinor: number,
  asOf: string,
): { candidates: Candidate[]; openCount: number } {
  const baseCurrency = baseCurrencyOf(ctx);
  const items = liveDunningFeeItemsAsOf(ctx, asOf);
  if (items.length === 0) return { candidates: [], openCount: 0 };

  // One name lookup for the distinct debtors, so the row carries a human name and not a bare id. Not
  // merge-resolved, matching the document loop above, which reads `contact.name` off the join as-is.
  const names = new Map<string, string | null>();
  for (const item of items) {
    if (names.has(item.debtorId)) continue;
    const row = ctx.store.db
      .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, item.debtorId) as { name: string | null } | undefined;
    names.set(item.debtorId, row?.name ?? null);
  }

  const candidates: Candidate[] = [];
  let openCount = 0;
  for (const item of items) {
    // The open fee is its face minus what a prior payment already settled against THIS item. The
    // planner keys on `(target_kind, target_id)`, so this settled figure is the fee's own, never the
    // invoice's, which is the entire premise of a per-item target (critic N5 on the A14 fee target).
    const openMinor = item.feeMinor - settledMinor(ctx, 'dunning_fee', item.id);
    if (openMinor <= 0) continue;
    openCount += 1;

    const currencyMismatch = baseCurrency !== payCurrency;
    const delta = input.amountMinor === undefined ? null : openMinor - input.amountMinor;
    const customerMatched = input.counterpartyId !== undefined && item.debtorId === input.counterpartyId;

    let kind: MatchKind | null = null;
    if (delta === 0 && customerMatched) kind = 'exact_amount_customer';
    else if (delta !== null && Math.abs(delta) <= thresholdMinor) kind = 'amount_tolerance';

    const disabledReason = currencyMismatch ? 'currency_mismatch' : null;
    if (disabledReason !== null) kind = null;

    candidates.push({
      targetKind: 'dunning_fee',
      targetId: item.id,
      number: dunningFeeLabel(item.number, item.level),
      contactId: item.debtorId,
      contactName: names.get(item.debtorId) ?? null,
      currency: baseCurrency,
      dueDate: item.dueDate,
      daysOverdue: item.dueDate === null ? null : Math.max(0, daysBetween(item.dueDate, asOf)),
      grossMinor: item.feeMinor,
      paidMinor: item.feeMinor - openMinor,
      openMinor,
      status: 'booked',
      reference: null,
      kind,
      reason: kind,
      deltaMinor: delta,
      prefillMinor: 0,
      settled: false,
      disabledReason,
    });
  }
  return { candidates, openCount };
}

export function suggestPaymentMatches(ctx: WorkspaceContext, input: SuggestMatchesInput = {}): Result {
  const guard = optionalId(input.counterpartyId, 'counterpartyId') ?? optionalText(input.reference, 'reference');
  if (guard) return guard;
  if (input.amountMinor !== undefined && !Number.isSafeInteger(input.amountMinor)) {
    return err('invalid_input', { field: 'amountMinor' });
  }
  const direction = input.direction ?? 'incoming';
  if (!(PAYMENT_DIRECTIONS as readonly string[]).includes(direction)) {
    return err('invalid_input', { field: 'direction', allowed: [...PAYMENT_DIRECTIONS] });
  }

  const reference = classifyReference(input.reference);
  const thresholdMinor = writeOffThresholdOf(ctx);
  const asOf = ctx.clock.now().slice(0, 10);
  // §H-FX. The currency to compare each open document against: what the payer actually paid in, or
  // failing that the currency this book is kept in. `baseCurrencyOf` rather than an inline copy of
  // its query, so there is one accessor to be right and one place to correct.
  //
  // The `?? 'CHF'` that used to sit behind this was DEAD, not merely redundant: `base_currency` is
  // NOT NULL, so the inline read returned undefined only for a workspace with no row, and in that
  // state the workspace-scoped document query below returns nothing for `payCurrency` to be compared
  // with. It could therefore never change an answer, which is what made it worth deleting rather than
  // leaving: a franc sitting on a live line reads as a real default to the next person, and the next
  // edit that gives it a way to matter would not look like a currency change at all.
  const payCurrency = input.currency ?? baseCurrencyOf(ctx);

  const types = settleableTypes(direction);
  const placeholders = types.map(() => '?').join(', ');
  const rows = ctx.store.db
    .prepare(
      `SELECT d.id, d.type, d.number, d.status, d.contact_id, d.currency, d.subtotal_minor, d.tax_minor,
              d.total_minor, d.issue_date, d.due_date, c.name AS contact_name
         FROM document d
         LEFT JOIN contact c ON c.id = d.contact_id AND c.workspace_id = ?
        WHERE d.workspace_id = ? AND d.type IN (${placeholders})
          AND d.status NOT IN ('draft', 'cancelled', 'converted')
        ORDER BY d.due_date IS NULL, d.due_date, d.rowid`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, ...types) as (DocRow & { contact_name: string | null })[];

  const bills =
    direction === 'outgoing'
      ? vendorBillCandidates(ctx, input, payCurrency, thresholdMinor, asOf)
      : { candidates: [] as Candidate[], openCount: 0 };

  // Booked Mahngebühren are receivables (K-29), so they are candidates for an INCOMING payment only,
  // exactly where invoices are and vendor bills are not. A fee is a separately-allocatable open
  // position, so each open one is counted like any other open item.
  const fees =
    direction === 'incoming'
      ? dunningFeeCandidates(ctx, input, payCurrency, thresholdMinor, asOf)
      : { candidates: [] as Candidate[], openCount: 0 };

  const candidates: Candidate[] = [...bills.candidates, ...fees.candidates];
  let openItemCount = bills.openCount + fees.openCount;
  let referenceMatchCount = 0;

  for (const row of rows) {
    const paidMinor = settledMinor(ctx, 'document', row.id);
    const openMinor = row.total_minor - paidMinor;
    const isOpen = openMinor > 0 && SETTLEABLE_STATUSES.has(row.status);
    if (isOpen) openItemCount += 1;

    const refs = documentReferences(row);
    const referenceHit =
      reference.valid && (reference.kind === 'qrr' || reference.kind === 'scor')
        ? (refs.find((r) => r.value === reference.value) ?? null)
        : null;
    if (referenceHit !== null) referenceMatchCount += 1;

    // A settled document that the payer's reference names is SHOWN, disabled, with the reason: "you
    // already booked this" is the answer the user needs, and hiding it turns a resolved question
    // into a hunt.
    if (!isOpen && referenceHit === null) continue;

    const currencyMismatch = row.currency !== payCurrency;
    const delta = input.amountMinor === undefined ? null : openMinor - input.amountMinor;
    const customerMatched =
      input.counterpartyId !== undefined && row.contact_id !== null && row.contact_id === input.counterpartyId;

    let kind: MatchKind | null = null;
    if (referenceHit !== null && isOpen) {
      kind = 'exact_reference';
    } else if (isOpen && delta === 0 && customerMatched) {
      kind = 'exact_amount_customer';
    } else if (isOpen && delta !== null && Math.abs(delta) <= thresholdMinor) {
      kind = 'amount_tolerance';
    }

    const disabledReason = !isOpen ? 'settled' : currencyMismatch ? 'currency_mismatch' : null;
    if (disabledReason !== null) kind = null;

    candidates.push({
      targetKind: 'document',
      targetId: row.id,
      number: row.number,
      contactId: row.contact_id,
      contactName: row.contact_name,
      currency: row.currency,
      dueDate: row.due_date,
      daysOverdue: row.due_date === null ? null : Math.max(0, daysBetween(row.due_date, asOf)),
      grossMinor: row.total_minor,
      paidMinor,
      openMinor,
      status: row.status,
      reference: refs.length === 0 ? null : { kind: refs[0]!.kind, value: refs[0]!.value },
      kind,
      // The reason is a machine key the GUI renders from its own catalog. A candidate with no tier
      // gets `null`, which is the design's "nothing at all", not an empty string to render.
      reason: kind,
      deltaMinor: delta,
      prefillMinor: 0,
      settled: !isOpen,
      disabledReason,
    });
  }

  candidates.sort((a, b) => {
    const ra = a.kind === null ? 9 : TIER_RANK[a.kind];
    const rb = b.kind === null ? 9 : TIER_RANK[b.kind];
    if (ra !== rb) return ra - rb;
    // Within a tier, oldest due date first: that is the order a Treuhänder settles in, and it is
    // what makes the "distribute the rest to the oldest open items" proposal predictable.
    if (a.dueDate !== b.dueDate) return (a.dueDate ?? '9999-12-31') < (b.dueDate ?? '9999-12-31') ? -1 : 1;
    return 0;
  });

  // Prefill, and the rule that ambiguity is SHOWN as ambiguity: a tier with two candidates in it
  // prefills nothing at all, because guessing between them is the one thing the surface must not do.
  const top = candidates.find((c) => c.kind !== null);
  if (top !== undefined) {
    const tied = candidates.filter((c) => c.kind === top.kind);
    const settlesOnItsOwn = top.kind === 'exact_reference' || top.kind === 'exact_amount_customer';
    if (tied.length === 1 && settlesOnItsOwn) {
      top.prefillMinor = input.amountMinor === undefined ? top.openMinor : Math.min(top.openMinor, input.amountMinor);
    }
  }

  const referenceStatus =
    reference.kind === 'none' || reference.kind === 'free_text'
      ? null
      : !reference.valid
        ? 'reference_check_digit'
        : referenceMatchCount === 0
          ? 'reference_unknown'
          : 'matched';

  return ok({
    reference: {
      kind: reference.kind,
      value: reference.value,
      valid: reference.valid,
      display: reference.value === null ? null : formatReference(reference.kind, reference.value),
      error: reference.error,
      status: referenceStatus,
    },
    openItemCount,
    referenceMatchCount,
    writeOffThresholdMinor: thresholdMinor,
    candidates,
  });
}
