/**
 * A14, payments and matching: the settlement half of the money path.
 *
 * An issued invoice is revenue-in-waiting until the money arrives and is allocated to it. This
 * module records that movement, allocates it across open items with partial, over, Skonto and
 * write-off amounts, posts ONE balanced entry through A02 (P3: no second posting path), and stamps
 * the paid-portion VAT that A07's Ist branch counts in the payment period.
 *
 * FIVE RULES SHAPE EVERY LINE BELOW.
 *
 * 1. **The engine owns all money math.** `previewPayment` and `recordPayment` run the SAME planner,
 *    so the remainder a caller reads before the click is the figure the ledger books after it. This
 *    is the `vat_preview` precedent (A06) applied to settlement: one code path, never two, so a
 *    rounding disagreement between a client and the ledger has nowhere to come from.
 *
 * 2. **The cash invariant and the settlement invariant are DIFFERENT sums**, and conflating them is
 *    a spec defect this module fixes (filed as defect 3 in A14 §4). Only cash moves on the bank:
 *
 *        Σ allocation.amountMinor + onAccountMinor == payment.amountMinor
 *
 *    Skonto and a write-off are not cash. They close the rest of the DOCUMENT:
 *
 *        allocation.amountMinor + skontoMinor + skontoVatMinor + writeOffMinor <= document.openMinor
 *
 *    The spec's Σ formula added the non-cash parts into the cash total, which would have made the
 *    design's own worked example (CHF 1'080.00 against an open 1'081.00, the 1.00 written off)
 *    reject as an `allocation_mismatch`.
 *
 * 3. **Append-only, and derived where a mutation would otherwise be needed.** Allocating a parked
 *    credit later INSERTS rows and updates nothing; reversing a payment flips one status word and
 *    rewrites no allocation. A document's open amount and paid status are recomputed from the
 *    allocations of non-reversed payments, so they cannot drift from the ledger. There is no edit
 *    path on a posted payment anywhere in this file, and the DB triggers in `schema.ts` mean there
 *    is none anywhere else either.
 *
 * 4. **Idempotency keys are SCOPED, never derivable by a caller who should not own them.** A key is
 *    folded together with the payment's own identity before it reaches A02, so no caller can guess
 *    another operation's key and squat its slot with a CHF 0.01 entry. `recordPayment` then reads
 *    the entry it was handed back and refuses unless it is the one it asked for.
 *
 * 5. **Source-agnostic from day one.** D10 builds A14 BEFORE any bank feed, so `payment.source` is
 *    `manual` today and `camt`/`qr` when A20a/A21 land. The money side is an input either way and
 *    the allocation decision is identical, which is what keeps A20/A21 from growing a second
 *    settlement path.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalId, optionalDate } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { computeLineTax } from '../vat/applyVat.js';
import { resolveFxRate, baseCurrencyOf as fxBaseCurrencyOf } from '../fx/rates.js';
import { convertMinor, RATE_ONE } from '../fx/rateMath.js';
import { classifyReference, formatReference, buildQrrReference, buildScorReference } from './reference.js';
import type { ClassifiedReference, ReferenceKind } from './reference.js';
import { resolveRole, resolveBankAccount, isRejection, vatRoleFor, ROLE_ACCOUNT_NUMBER } from './accounts.js';
import type { ResolvedAccount, AccountRole } from './accounts.js';
// C00's ONE read-side contact resolver. A14 freezes `counterparty_id` on a posted payment with a DB
// immutability trigger, so a merge can never re-point it: every READ of it resolves the tombstone
// instead, and a NEW payment is refused a tombstone outright rather than minting a reference that
// could then never be corrected.
import { resolveContactRef } from '../sales/contact.js';
// G00's saved-view seam. A leaf import: the customization module knows nothing about payments.
import { applySavedView } from '../customization/views.js';
// A17's ONE settlement-status rule, imported rather than restated. `purchase/enums.ts` is a pure leaf
// (it imports nothing at all), so this creates no cycle, and importing it is what stops A14 growing a
// second copy of "when is a bill paid" beside A17's.
import { settlementStatusFor, displayStatus, type VendorBillStatus } from '../purchase/enums.js';
// A15's ONE "is this booked fee LIVE" predicate, and its shared display label (critic C1/C2/N6 on
// this file's own `dunning_fee` target). Imported from the file directly, never the `dunning`
// barrel: the barrel re-exports `run.ts`, which imports `../debtors/index.js`, and `openItems.ts`
// imports these same two, so going through the barrel would close a cycle. `reads.ts` itself
// imports nothing from payments or debtors, so this edge is one-way.
import { readLiveDunningFeeItem, dunningFeeLabel } from '../dunning/reads.js';
// E02's ONE reimbursement-reversal seam. A reimbursement is an on-account SUPPLIER settlement that
// clears 2260 through the `payableAccountId` override and carries NO allocation to its claim, so the
// allocation-unwind below never touches it: reversing the payment reopens 2260 but would leave the
// claim reading `reimbursed`. This reverts the claim to `approved` in the SAME tx. Imported as a LEAF
// (never the `hr` barrel): `hr/claims.ts` imports this module, so this edge would close a cycle
// through the barrel; the leaf file imports nothing from payments, so the direct edge is one-way. The
// dunning import two lines up follows the identical rule for the identical reason.
import { revertReimbursedClaimsForPayment } from '../hr/reimbursementReversal.js';

// --- Fixed §H-ENUM value lists this spec owns ---------------------------------------------------

/** `payment.direction`. A14 §6b fixes it: A16's derivation and A17/A18's flow both key off it. */
export const PAYMENT_DIRECTIONS = ['incoming', 'outgoing'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/**
 * `payment.status`. Exactly two words, matching the design's copy table (Gebucht, Storniert).
 *
 * A parked credit is NOT a third status: the payment that carries it is posted, and a status word
 * that said "Guthaben" would hide the settlement that same payment performed. The credit is a
 * derived amount (see `onAccountMinorOf`), surfaced beside the status, never instead of it.
 */
export const PAYMENT_STATUSES = ['posted', 'reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** `payment.source`. `manual` today; A20a fills `camt` and A21 fills `qr` without a new verb. */
export const PAYMENT_SOURCES = ['manual', 'camt', 'qr'] as const;

/**
 * The allocation target (Pattern OP3, polymorphic). Three members: `document` and `vendor_bill`
 * since A17, `dunning_fee` since this increment (A14 follow-up recorded against A15 §4 per D59).
 *
 * A `dunning_fee` target names the FEE, a `dunning_item` row, never the invoice it rides: the same
 * invoice can carry a level-1 AND a level-2 booked Mahngebühr, two distinct fees with two distinct
 * `dunning_item` ids, so naming the invoice would leave the engine to guess which one a partial
 * payment meant. It is receivable-side (books to 1100, exactly like a document), so the
 * settlement-side guard below groups it with `document` and never with `vendor_bill`.
 */
export const ALLOCATION_TARGET_KINDS = ['document', 'vendor_bill', 'dunning_fee'] as const;
export type AllocationTargetKind = (typeof ALLOCATION_TARGET_KINDS)[number];

/** The counterparty a payment belongs to. Spec defect 1's fix: a credit always has an owner. */
export const COUNTERPARTY_KINDS = ['customer', 'supplier'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/**
 * The default one-click write-off threshold (design decision P4, still with the owner).
 *
 * CHF 1.00, because real Swiss residuals (a bank charge deducted at source, a payer who dropped the
 * Rappen, a cash tender the customer could not make exact because 0.05 is the smallest coin)
 * cluster below it. It governs only whether a ONE-CLICK offer is safe to present: a larger write-off
 * is still permitted, it just has to be typed deliberately. It is NOT a statutory value, and
 * nothing here treats 5-Rappen rounding as a legal rule (design §8 PT10).
 */
export const DEFAULT_WRITE_OFF_THRESHOLD_MINOR = 100;

/**
 * The explicit intent every A14 write must carry (owner decision P9).
 *
 * The Studio shows a confirmation dialog before a payment posts, with a "nicht mehr anzeigen"
 * checkbox. That checkbox must NEVER be the thing that decides whether money moves, so the intent
 * lives HERE, on the wire, where both faces meet it:
 *
 *  - an agent has to name the exact token for the verb it is calling, so it cannot post as a side
 *    effect of a read, cannot reuse a token it copied from another call, and cannot arrive at a
 *    posting through a preview;
 *  - the human dialog is one PRESENTATION of that intent, and the Studio sends the token whether or
 *    not the dialog was shown;
 *  - suppressing the dialog changes what a person sees and nothing about the contract.
 *
 * The token is verb-specific on purpose: a single `confirm: true` would be satisfiable by any
 * boolean an agent happened to have lying around, and would make "I meant to allocate" and "I meant
 * to move money" the same statement.
 */
export const PAYMENT_INTENTS = {
  record: 'post_payment',
  allocate: 'allocate_payment',
  reverse: 'reverse_payment',
} as const;

/** Assert the caller stated the exact intent for this verb, or reject before anything is read. */
function requireIntent(value: unknown, expected: string): Result | null {
  if (value === expected) return null;
  return err('intent_required', {
    field: 'intent',
    expected,
    reason: 'a payment moves money, so the caller states that deliberately on every call',
  });
}

/** The candidate tiers (design §3.2). A candidate that fits no tier carries NO word at all. */
export type MatchKind = 'exact_reference' | 'exact_amount_customer' | 'amount_tolerance';

/** Document statuses A14 may settle. A draft has no receivable and a cancelled one is undone. */
const SETTLEABLE_STATUSES = new Set(['issued', 'sent', 'partially_paid']);

/** The two statuses A14 itself writes, so an unwind can find the status it must restore. */
const PAYMENT_DERIVED_STATUSES = new Set(['partially_paid', 'settled']);

// --- Row shapes ---------------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  workspace_id: string;
  direction: PaymentDirection;
  date: string;
  amount_minor: number;
  currency: string;
  base_amount_minor: number;
  fx_rate: string | null;
  bank_account_id: string;
  counterparty_kind: CounterpartyKind | null;
  counterparty_id: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  status: PaymentStatus;
  source: string;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
  reversed_at: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
}

interface AllocationRow {
  id: string;
  payment_id: string;
  target_kind: AllocationTargetKind;
  target_id: string;
  amount_minor: number;
  payment_amount_minor: number;
  base_amount_minor: number;
  skonto_minor: number;
  skonto_vat_minor: number;
  writeoff_minor: number;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  recognized_at: string | null;
  journal_entry_id: string | null;
}

interface DocRow {
  id: string;
  type: string;
  number: string | null;
  status: string;
  contact_id: string | null;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  issue_date: string | null;
  due_date: string | null;
  posted_entry_id: string | null;
  /** A13: the invoice a credit note offsets; null on every other row. D78 reads it to find which
   *  invoice a credit-note allocation (a refund payout) may have re-opened or re-settled. */
  credited_document_id: string | null;
}

// --- Inputs -------------------------------------------------------------------------------------

export interface AllocationInput {
  /** Convenience alias for `targetId` when the target is a customer document. */
  documentId?: string;
  /**
   * Convenience alias for `targetId` when the target is an A17 vendor bill, and passing it IMPLIES
   * `targetKind: 'vendor_bill'`.
   *
   * The implication is the point. A caller who names a `vendorBillId` and forgets the kind would
   * otherwise be looking up a bill id in the `document` table and getting `not_found` for a bill that
   * exists, which is the single most likely way to use this wrong.
   */
  vendorBillId?: string;
  /**
   * Convenience alias for `targetId` when the target is a BOOKED A15 dunning fee (a `dunning_item`
   * row), and passing it IMPLIES `targetKind: 'dunning_fee'`.
   *
   * Names the FEE, never the invoice: `documentId` still settles the invoice's own open amount in
   * the SAME call when a caller wants to close invoice-then-fee in one payment (two allocation
   * rows, one against each target). The engine never infers a fee from an invoice id.
   */
  dunningItemId?: string;
  targetKind?: string;
  targetId?: string;
  /** What this settles ON THE DOCUMENT, in the DOCUMENT's currency. */
  amountMinor: number;
  /**
   * The cash this consumes from the payment, in the PAYMENT's currency. Defaults to `amountMinor`
   * and MUST equal it when the two currencies agree; it is REQUIRED when they differ, because the
   * conversion the payer's bank actually applied happened outside these books and cannot be
   * re-derived from a rate we hold.
   */
  paymentAmountMinor?: number;
  /** The NET cash discount granted (MWSTG Art. 41); the engine derives its proportional VAT. */
  skontoMinor?: number;
  writeOffMinor?: number;
}

export interface RecordPaymentInput {
  direction: string;
  date: string;
  amountMinor: number;
  currency?: string;
  /** The rate to convert this payment into base currency. Absent, the §H-FX store resolves it. */
  fxRate?: string;
  bankAccountId: string;
  counterpartyKind?: string;
  counterpartyId?: string;
  reference?: string | null;
  allocations?: AllocationInput[];
  /** The remainder parked as a Guthaben. Optional: the engine derives it and rejects a disagreement. */
  onAccountMinor?: number;
  /**
   * Settle the payable side against THIS liability account instead of 2000 Kreditoren (D95, E02
   * employee-payable). Honoured ONLY for an on-account SUPPLIER settlement (no allocations, supplier
   * side): a vendor bill forces its own 2000 counter through its allocation, so the override is
   * refused alongside allocations and on the receivable side. Absent, every existing caller resolves
   * the role account 2000 exactly as before, so this changes no shipped payment shape.
   */
  payableAccountId?: string;
  source?: string;
  /** `PAYMENT_INTENTS.record`. Required (P9): money never moves as a side effect of anything. */
  intent?: string;
  idempotencyKey: string;
}

// --- Small helpers --------------------------------------------------------------------------------

/** Round half away from zero in exact integer arithmetic (Pattern P2). No floats on this path. */
function roundHalfAwayFromZero(numer: number, denom: number): number {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

function isPositiveMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The workspace's ledger base currency (§H-FX owns the definition; A14 does not restate it). */
const baseCurrencyOf = fxBaseCurrencyOf;

/**
 * A proportional share of a document's BOOKED base value, rounded once (Pattern P2).
 *
 * A settlement releases part of a receivable, and the base value it releases is the base that
 * receivable was BOOKED at (the invoice-date rate), never a re-conversion at today's rate. For a
 * base-currency document the booked base equals the face amount and this is the identity.
 */
function baseShare(bookedBaseMinor: number, partMinor: number, totalMinor: number): number {
  if (totalMinor === 0) return 0;
  if (bookedBaseMinor === totalMinor) return partMinor;
  return roundHalfAwayFromZero(bookedBaseMinor * partMinor, totalMinor);
}

/**
 * The base-currency value a document's receivable actually carries.
 *
 * Read off the document's OWN posted entry rather than recomputed, because that is the figure the
 * ledger holds and the one a settlement has to clear to zero. A base-currency document short-circuits
 * to its face amount, so nothing changes for the ordinary case.
 */
function documentBookedBase(ctx: WorkspaceContext, doc: DocRow): number {
  if (doc.currency === baseCurrencyOf(ctx)) return doc.total_minor;
  if (doc.posted_entry_id === null) return doc.total_minor;
  const receivable = ROLE_NUMBER_RECEIVABLE;
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ? AND a.number = ?`,
    )
    .get(doc.posted_entry_id, ctx.workspaceId, receivable) as { net: number };
  return row.net === 0 ? doc.total_minor : Math.abs(row.net);
}

const ROLE_NUMBER_RECEIVABLE = '1100';

/** `ist` or `soll` (MWSTG Art. 39). A14 only READS this: changing it is an ESTV-permissioned act. */
function vatTimingOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT vat_accounting FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { vat_accounting: string | null } | undefined;
  return row?.vat_accounting ?? 'soll';
}

/** The configured one-click write-off threshold, or the CHF 1.00 default. */
export function writeOffThresholdOf(ctx: WorkspaceContext): number {
  const row = ctx.store.db
    .prepare('SELECT write_off_threshold_minor FROM payment_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { write_off_threshold_minor: number } | undefined;
  return row?.write_off_threshold_minor ?? DEFAULT_WRITE_OFF_THRESHOLD_MINOR;
}

/**
 * The polymorphic settlement target (Pattern OP3), and why A17 needed one rather than a second loop.
 *
 * A payment settles a customer DOCUMENT, an A17 VENDOR BILL, or a booked A15 DUNNING FEE, and the
 * arithmetic is identical: an open amount, a booked base, a due date, a currency and a status that
 * says whether it may be settled at all. What differs is the four facts below, so the planner reads
 * them once through this shape and everything after it, the cash invariant, the FX shares, the legs,
 * the blockers and the derived status, runs unchanged for all three. A separate creditor planner
 * would have been a second settlement path, which is precisely what A17 §4 forbids; a separate fee
 * planner would have been a third.
 *
 * `taxTotalMinor` is 0 for a vendor bill AND for a dunning fee, and neither is an omission. It feeds
 * the Ist timing stamp (`payment_allocation.tax_base_minor` / `tax_amount_minor`). For a vendor bill,
 * A07 currently REFUSES Ist outright while naming that column pair as the seam it will read: stamping
 * a purchase settlement into those columns today would leave the future implementer with rows
 * indistinguishable from output-side ones, and the first thing they would produce is Vorsteuer
 * counted as Umsatzsteuer on a filed return. For a dunning fee the seam simply does not apply: its
 * VAT was already recognised in full when the run booked it (D69), never deferred to the payment
 * date, so there is no paid-portion split left to stamp. Both leave `doc: null`, which is what
 * actually suppresses the stamp in `planPayment` (the field here documents WHY, not what enforces it).
 */
interface SettlementTarget {
  kind: AllocationTargetKind;
  id: string;
  /** The document number, a vendor bill's own reference, or a fee's `dunningFeeLabel`. What a human recognises the row by. */
  number: string | null;
  currency: string;
  dueDate: string | null;
  /** The face amount a settlement clears: a document's total, a bill's payable. */
  totalMinor: number;
  /** The base-currency value the position was BOOKED at, never a re-conversion at today's rate. */
  bookedBaseMinor: number;
  status: string;
  settleable: boolean;
  contactId: string | null;
  /** The document's own booked VAT, for the Ist split. Zero for a vendor bill: see above. */
  taxTotalMinor: number;
  /** The document row, for the paths that genuinely need it (Skonto, status writing). Null for a bill. */
  doc: DocRow | null;
}

/** A17's own statuses a payment may settle: only a POSTED bill carries a payable. */
const SETTLEABLE_BILL_STATUSES = new Set(['posted']);

/** The id field name a rejection payload names its target by, so an error says which thing it means. */
function idFieldFor(kind: AllocationTargetKind): string {
  if (kind === 'vendor_bill') return 'vendorBillId';
  if (kind === 'dunning_fee') return 'dunningItemId';
  return 'documentId';
}

/**
 * The status word a preview reports for a target after this settlement.
 *
 * The two kinds answer from different vocabularies on purpose. A DOCUMENT's word is A10's, and A14
 * writes it to `document.status` after the post. A VENDOR BILL's word is A17's DERIVED settlement
 * status, computed here through A17's own pure rule and written nowhere at all: there is no column,
 * which is what makes "A14 never writes a bill's paid state" true by construction rather than by
 * convention.
 */
function resultingStatusFor(
  ctx: WorkspaceContext,
  target: SettlementTarget,
  paidMinor: number,
  settlementMinor: number,
  resultingOpenMinor: number,
): string {
  // KAIZEN K-1: a settlement larger than the target's open amount drives `resultingOpenMinor`
  // negative, and every rule below would then read that overshoot as fully paid (`settled` for a
  // document, `paid` for a bill): the same lie the N7 guard blocks for a zeroed dunning fee. The
  // write refuses this exact row with `allocation_exceeds_open`, so the preview answers what the
  // write will answer: nothing changes, the target keeps its current word. The negative open itself
  // stays on the row untouched, because it is the arithmetic the blocker names, not a claim.
  if (resultingOpenMinor < 0) {
    if (target.kind === 'vendor_bill') {
      // K-26 applies here too: the bill's REAL status, not the literal 'posted', or a DRAFT
      // bill's over-allocated row would wear 'posted' again the moment this branch fires first.
      return displayStatus(target.status as VendorBillStatus, settlementStatusFor(target.totalMinor, paidMinor));
    }
    return target.status;
  }
  if (target.kind === 'vendor_bill') {
    // K-26: the bill's REAL lifecycle status, never the literal 'posted'. `displayStatus` refines
    // only a posted bill with the settlement word and returns anything else verbatim, so a DRAFT
    // (or void) bill's row answers its own state word instead of wearing 'posted' / 'partly_paid'
    // / 'paid', states it cannot hold, while the blocker beside it says `vendor_bill_not_settleable
    // status:'draft'`. Same discipline as CRITIC N7 below: a preview must say what the write will
    // actually answer.
    return displayStatus(target.status as VendorBillStatus, settlementStatusFor(target.totalMinor, paidMinor + settlementMinor));
  }
  // CRITIC N7: a dunning fee that is NOT settleable (not yet booked, or its own booking entry
  // reversed) carries `totalMinor: 0`, because there is nothing real left to settle. That same zero
  // drives `resultingOpenMinor` negative the instant ANY amount is proposed against it, and the
  // generic `<= 0` rule two lines down would then report `settled`: exactly the lie a PREVIEW must
  // never tell when the write behind it refuses with `dunning_fee_not_settleable`. Say what the
  // write will actually answer, the target's own state word, instead of deriving one from an open
  // amount that was already zeroed out for this exact reason.
  if (target.kind === 'dunning_fee' && !target.settleable) return target.status;
  if (resultingOpenMinor <= 0) return 'settled';
  if (paidMinor + settlementMinor > 0) {
    // D78: a remainder fully offset by issued credit notes is settled, and the PREVIEW says so
    // too, because a preview that promises `partially_paid` where the write derives `settled`
    // teaches the operator to distrust exactly the read that exists to be trusted.
    if (resultingOpenMinor <= creditCoverMinor(ctx, target.id)) return 'settled';
    return 'partially_paid';
  }
  return target.status;
}

/**
 * Read one settlement target of either kind, §H-TENANT on both lookups.
 *
 * The vendor-bill branch reads `payable_minor` and NOT `gross_minor`, which is the whole reason A17
 * stores the two separately: Bezugsteuer credits the net to 2000 and Einfuhrsteuer credits the
 * assessed tax, so paying a Bezugsteuer bill "in full" against its gross would over-allocate by the
 * tax the ESTV is owed rather than the supplier.
 */
function readTarget(ctx: WorkspaceContext, kind: AllocationTargetKind, id: string): SettlementTarget | undefined {
  if (kind === 'document') {
    const doc = readDocRow(ctx, id);
    if (doc === undefined) return undefined;
    return {
      kind,
      id: doc.id,
      number: doc.number,
      currency: doc.currency,
      dueDate: doc.due_date,
      totalMinor: doc.total_minor,
      bookedBaseMinor: documentBookedBase(ctx, doc),
      status: doc.status,
      settleable: SETTLEABLE_STATUSES.has(doc.status),
      contactId: doc.contact_id,
      taxTotalMinor: doc.tax_minor,
      doc,
    };
  }
  if (kind === 'dunning_fee') {
    const item = ctx.store.db
      .prepare(
        `SELECT id, document_id, debtor_id, number, due_date, level, fee_minor, fee_booked
           FROM dunning_item WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, id) as
      | {
          id: string;
          document_id: string;
          debtor_id: string;
          number: string | null;
          due_date: string | null;
          level: number;
          fee_minor: number;
          fee_booked: number;
        }
      | undefined;
    if (item === undefined) return undefined;
    // THE SHARED LIVENESS PREDICATE (critic C1): `fee_booked = 1` alone is NOT "this fee is live".
    // It is A15's own attribution flag, set once at issue and never rewritten by a later
    // `reverse_entry` on the fee's own entry, so a REVERSED fee still reads `fee_booked = 1` here.
    // `readLiveDunningFeeItem` is the exact predicate `openItems.ts`'s `dunningFeesAsOf` nets a
    // settlement against, so the allocator can no longer call settleable what the read model has
    // already written off.
    //
    // `asOf` is TODAY (the clock), never `input.date`: a document or a vendor bill is judged on its
    // CURRENT status, not on the payment's own (possibly backdated) date, and a fee target follows
    // the same rule so this fix does not invent a second kind of date-scoping A14 has never had. A16
    // takes the REPORT's own `asOf` for the exact opposite reason (a Treuhänder reviewing a past
    // cut-off needs the picture that was true then): the shared predicate is generic on `asOf`
    // precisely so each caller can supply the semantics its own decision needs.
    const today = ctx.clock.now().slice(0, 10);
    const live = readLiveDunningFeeItem(ctx, id, today) !== undefined;
    // Three words, three states, because `dunning_fee_not_settleable` has to say WHICH one refused:
    // `not_booked` (a period lock deferred it, C8: a demand with no receivable behind it yet, same
    // as a draft document), `reversed` (it WAS live and no longer is), `booked` (settleable).
    const status = item.fee_booked === 0 ? 'not_booked' : live ? 'booked' : 'reversed';
    return {
      kind,
      id: item.id,
      number: dunningFeeLabel(item.number, item.level),
      // A15 books every Mahngebühr in the BASE currency only (see A16's own docblock); a payment in
      // another currency settles it exactly as it settles a foreign document, through the
      // cross-currency `paymentAmountMinor` branch below.
      currency: baseCurrencyOf(ctx),
      dueDate: item.due_date,
      // Zero on anything but a LIVE fee: neither an unbooked demand nor a reversed claim has a real
      // amount left to settle, and a non-zero figure here is exactly what let a reversed fee preview
      // `openMinor: <fee>, resultingStatus: 'settled'` before this fix.
      totalMinor: live ? item.fee_minor : 0,
      bookedBaseMinor: live ? item.fee_minor : 0,
      status,
      settleable: live,
      contactId: item.debtor_id,
      // No Ist re-split on a fee settlement: the fee's own VAT was already recognised in full when
      // the dunning run booked it (D69, unconditionally, never deferred to payment). `doc: null`
      // below is what actually suppresses the stamp (the same mechanism a vendor bill uses); this
      // is 0 for the same reason a vendor bill's is (see `SettlementTarget`'s own docblock).
      taxTotalMinor: 0,
      doc: null,
    };
  }
  const bill = ctx.store.db
    .prepare(
      `SELECT id, contact_id, vendor_reference, currency, due_date, payable_minor, base_payable_minor, status
         FROM vendor_bill WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as
    | {
        id: string;
        contact_id: string;
        vendor_reference: string | null;
        currency: string;
        due_date: string | null;
        payable_minor: number;
        base_payable_minor: number | null;
        status: string;
      }
    | undefined;
  if (bill === undefined) return undefined;
  return {
    kind,
    id: bill.id,
    number: bill.vendor_reference,
    currency: bill.currency,
    dueDate: bill.due_date,
    totalMinor: bill.payable_minor,
    // The base A17 read off the bill's OWN posted entry. A draft has none, and a draft is not
    // settleable, so the fallback is only ever reached on a row this planner has already blocked.
    bookedBaseMinor: bill.base_payable_minor ?? bill.payable_minor,
    status: bill.status,
    settleable: SETTLEABLE_BILL_STATUSES.has(bill.status),
    contactId: bill.contact_id,
    taxTotalMinor: 0,
    doc: null,
  };
}

function readDocRow(ctx: WorkspaceContext, id: string): DocRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, type, number, status, contact_id, currency, subtotal_minor, tax_minor, total_minor,
              issue_date, due_date, posted_entry_id, credited_document_id
         FROM document WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as DocRow | undefined;
}

/**
 * What has already been settled against a target, in Rappen.
 *
 * §H-TENANT on BOTH sides of the join: the allocation rows and the payments they belong to are each
 * filtered to this workspace, so a foreign payment can never reduce a local invoice's open amount.
 * Allocations of a REVERSED payment are excluded, which is exactly how a reversal re-opens the
 * documents it touched without rewriting a single allocation row.
 */
function settledMinor(ctx: WorkspaceContext, targetKind: string, targetId: string, excludePaymentId?: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(a.amount_minor + a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor), 0) AS total
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = ? AND a.target_id = ?
          AND p.status = 'posted'
          AND (? IS NULL OR a.payment_id <> ?)`,
    )
    .get(
      ctx.workspaceId,
      ctx.workspaceId,
      targetKind,
      targetId,
      excludePaymentId ?? null,
      excludePaymentId ?? null,
    ) as { total: number };
  return row.total;
}

/**
 * The base-currency value ALREADY released off the control account by prior posted payments, in
 * Rappen: the whole of it, not just the cash side.
 *
 * The BASE-side mirror of `settledMinor`, under the SAME §H-TENANT join and the SAME reversed-payment
 * exclusion, so a reversed prior payment restores the receivable here exactly as it restores the open
 * amount there. `planPayment` reads it to clear a foreign-currency position to EXACTLY its booked base
 * on the settling allocation (K-34): the per-payment cash base is an independently rounded share of
 * the whole booked base, and those shares need not sum back to it, so the closing allocation trues the
 * cash base up to the base STILL on the receivable rather than rounding a further independent share.
 *
 * Every prior allocation released `settlementBaseMinor = cash + Skonto + Skonto VAT + write-off` off
 * 1100 (`buildLegs`), so this counts ALL of it. A NON-closing partial may carry Skonto or a write-off
 * (nothing forces either onto the settling allocation: the only guard is `Skonto <= open`), and the
 * first K-34 fix summed only the stored cash base `base_amount_minor` and MISSED that non-cash base,
 * so the closing true-up over-credited the receivable and mis-stated realised FX by it. The stored
 * cash base IS exact. The non-cash base is not stored, so it is recomputed here from the stored
 * transaction-currency figures by the SAME `baseShare`/`skontoVatFor` the plan used, over the SAME
 * booked base and face total and the SAME document-derived tax code: those are pure and were already
 * validated when the allocation posted, so the reconstruction reproduces the Rappen that left 1100.
 * The settling allocation's OWN non-cash base is subtracted separately at the call site.
 */
function releasedBaseMinor(
  ctx: WorkspaceContext,
  targetKind: string,
  targetId: string,
  bookedBaseMinor: number,
  totalMinor: number,
  doc: DocRow | null,
  excludePaymentId?: string,
): number | Result {
  const rows = ctx.store.db
    .prepare(
      `SELECT a.base_amount_minor AS cashBase, a.skonto_minor AS skonto, a.writeoff_minor AS writeOff
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = ? AND a.target_id = ?
          AND p.status = 'posted'
          AND (? IS NULL OR a.payment_id <> ?)`,
    )
    .all(
      ctx.workspaceId,
      ctx.workspaceId,
      targetKind,
      targetId,
      excludePaymentId ?? null,
      excludePaymentId ?? null,
    ) as { cashBase: number; skonto: number; writeOff: number }[];

  let total = 0;
  for (const r of rows) {
    // The cash base is stored exactly as it was credited to 1100.
    total += r.cashBase;
    // The write-off base, recomputed exactly as the plan booked it (a pure share, no VAT side).
    if (r.writeOff !== 0) total += baseShare(bookedBaseMinor, r.writeOff, totalMinor);
    // The Skonto base plus its VAT base. Skonto only ever sits on an incoming-invoice document, so a
    // prior allocation carrying it always has a `doc`. `skontoVatFor(base Skonto)` reproduces the
    // plan-time Skonto VAT base to the Rappen in every branch (it is zero on a tax-free document).
    if (r.skonto !== 0 && doc !== null) {
      const skontoBase = baseShare(bookedBaseMinor, r.skonto, totalMinor);
      total += skontoBase;
      const vat = skontoVatFor(ctx, doc, skontoBase);
      if ('ok' in vat) return vat;
      total += vat.taxMinor;
    }
  }
  return total;
}

/**
 * Which side of the books a payment's entry actually settled: 'receivable' when the entry moved
 * 1100, 'payable' when it moved 2000, 'mixed' when it somehow moved both (no shipped payment shape
 * produces that, and an allocation against it must refuse rather than pick), and null when it moved
 * neither. The JOURNAL is the fact consulted (A17-C1): `counterparty_kind` is a caller-supplied
 * label this module already decided not to trust when the leg side moved to following the target.
 */
function entrySettlementSide(
  ctx: WorkspaceContext,
  entryId: string | null,
): 'receivable' | 'payable' | 'mixed' | null {
  if (entryId === null) return null;
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT a.number AS number
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ? AND a.number IN (?, ?)`,
    )
    .all(entryId, ctx.workspaceId, ROLE_ACCOUNT_NUMBER.receivable, ROLE_ACCOUNT_NUMBER.payable) as {
    number: string;
  }[];
  const numbers = new Set(rows.map((r) => r.number));
  const receivable = numbers.has(ROLE_ACCOUNT_NUMBER.receivable);
  const payable = numbers.has(ROLE_ACCOUNT_NUMBER.payable);
  if (receivable && payable) return 'mixed';
  if (receivable) return 'receivable';
  if (payable) return 'payable';
  return null;
}

/** The unallocated remainder of a payment: derived, never stored (see schema.ts). */
function onAccountMinorOf(ctx: WorkspaceContext, payment: PaymentRow): number {
  const row = ctx.store.db
    .prepare(
      'SELECT COALESCE(SUM(payment_amount_minor), 0) AS total FROM payment_allocation WHERE workspace_id = ? AND payment_id = ?',
    )
    .get(ctx.workspaceId, payment.id) as { total: number };
  return payment.amount_minor - row.total;
}

/**
 * The status a document must return to when A14 unwinds every settlement on it.
 *
 * Derived from the status trail rather than stored: the last entry that is NOT one of A14's own
 * derived words is where the document was before any money arrived. Storing a "previous status"
 * column would be a second source of truth for a fact the trail already records.
 */
function preSettlementStatus(ctx: WorkspaceContext, documentId: string): string {
  const rows = ctx.store.db
    .prepare(
      'SELECT to_status FROM document_status_history WHERE workspace_id = ? AND document_id = ? ORDER BY at DESC, rowid DESC',
    )
    .all(ctx.workspaceId, documentId) as { to_status: string }[];
  for (const r of rows) {
    if (!PAYMENT_DERIVED_STATUSES.has(r.to_status)) return r.to_status;
  }
  return 'issued';
}

/** Write a document's derived payment status plus its trail row. Never a `transitionDocument` edge. */
function writeDocumentStatus(ctx: WorkspaceContext, doc: { id: string; status: string }, to: string): void {
  if (doc.status === to) return;
  ctx.store.db
    .prepare('UPDATE document SET status = ? WHERE workspace_id = ? AND id = ?')
    .run(to, ctx.workspaceId, doc.id);
  ctx.store.db
    .prepare(
      `INSERT INTO document_status_history (id, document_id, workspace_id, from_status, to_status, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('dhist'), doc.id, ctx.workspaceId, doc.status, to, ctx.actor, ctx.clock.now());
}

/**
 * The GROSS still offset by issued, non-cancelled credit notes linked to an invoice: each credit's
 * face total minus the refund payouts already allocated against it (an A14 outgoing allocation on
 * the credit note pays the relief out in cash, so that slice no longer offsets the invoice). This
 * is the same netting A16's `creditedOpenMinor` and A21's `principalMinor` derive, restated over
 * A14's own `settledMinor`, so the three reads and this write cannot disagree on when an invoice
 * has nothing left to chase. §H-TENANT on the query.
 */
function creditCoverMinor(ctx: WorkspaceContext, invoiceId: string): number {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, total_minor FROM document
        WHERE workspace_id = ? AND type = 'credit_note' AND credited_document_id = ?
          AND status NOT IN ('draft', 'cancelled')`,
    )
    .all(ctx.workspaceId, invoiceId) as { id: string; total_minor: number }[];
  let cover = 0;
  for (const row of rows) {
    cover += Math.max(0, row.total_minor - settledMinor(ctx, 'document', row.id));
  }
  return cover;
}

/**
 * The derived payment status of a document: settled, partly paid, or back where it started.
 *
 * D78 (the A21 critic's O1): an invoice whose payments PLUS issued credit notes cover it exactly
 * is fully relieved, so it leaves `partially_paid` for the terminal `settled` instead of sitting
 * in lists, dunning and matching as active forever. The credit-aware branch fires only while some
 * payment is on the document (`settled > 0`): a credit note ALONE never moves the lifecycle
 * column, which keeps the A13 law that crediting an unpaid invoice leaves its status untouched.
 * The row model does not move; only this status word does, and cancelling a credit walks the same
 * derivation back out (`partially_paid` again while payments remain, the pre-settlement status
 * once they are unwound too).
 */
function derivedStatus(ctx: WorkspaceContext, documentId: string, settled: number, total: number): string {
  if (settled <= 0) return preSettlementStatus(ctx, documentId);
  if (settled >= total) return 'settled';
  if (settled + creditCoverMinor(ctx, documentId) >= total) return 'settled';
  return 'partially_paid';
}

/**
 * Re-derive one invoice's settlement status after a credit-note event (D78): issue, cancel, or a
 * refund payout against a linked credit. The ONE rule above is re-run at every choke point rather
 * than restated, so the write path cannot fork. A document that never carried a payment is left
 * alone entirely (the A13 law), unless A14's own derived word is already on it and must unwind.
 */
export function refreshSettledByCredit(ctx: WorkspaceContext, documentId: string): void {
  const doc = readDocRow(ctx, documentId);
  if (doc === undefined || doc.type !== 'invoice') return;
  const settled = settledMinor(ctx, 'document', documentId);
  if (settled <= 0 && !PAYMENT_DERIVED_STATUSES.has(doc.status)) return;
  writeDocumentStatus(ctx, doc, derivedStatus(ctx, documentId, settled, doc.total_minor));
}

/**
 * The references an issued document may carry, derived from its number the way A11 derives them on
 * the issuing side. A14 NEVER invents a reference: it only recognises the one the payer quoted.
 *
 * BOTH regimes are derived, because which one an invoice carries is decided by the creditor's IBAN
 * (a QR-IBAN yields QRR, a plain IBAN yields SCOR) and that IBAN can change between the issuing and
 * the paying. Recognising both costs one string comparison and means a workspace that switched
 * IBANs still settles its older bills on the reference the payer actually quoted.
 */
export function documentReferences(doc: DocRow): { kind: 'qrr' | 'scor'; value: string }[] {
  if (doc.number === null) return [];
  return [
    { kind: 'qrr', value: buildQrrReference(doc.number) },
    { kind: 'scor', value: buildScorReference(doc.number) },
  ];
}

// --- The planner: one code path behind preview and record ---------------------------------------

export interface PlannedRow {
  targetKind: AllocationTargetKind;
  targetId: string;
  number: string | null;
  currency: string;
  dueDate: string | null;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  allocatedMinor: number;
  /** The cash consumed, in the PAYMENT's currency (equal to `allocatedMinor` when they agree). */
  paymentAmountMinor: number;
  /** The base value the document's receivable carries, and each component's share of it. */
  bookedBaseMinor: number;
  cashBaseMinor: number;
  skontoBaseMinor: number;
  skontoVatBaseMinor: number;
  writeOffBaseMinor: number;
  settlementBaseMinor: number;
  skontoMinor: number;
  skontoVatMinor: number;
  writeOffMinor: number;
  settlementMinor: number;
  resultingOpenMinor: number;
  resultingStatus: string;
  /** The residual this row would leave, offered as a one-click write-off when within the threshold. */
  writeOffOfferedMinor: number;
  taxBaseMinor: number | null;
  taxAmountMinor: number | null;
  recognizedAt: string | null;
  skontoTaxCode: string | null;
  skontoSupplyDate: string | null;
  /** The VAT account the Skonto's own tax code designates. Null when the Skonto bears no tax. */
  skontoVatRole: AccountRole | null;
  doc: DocRow | null;
}

export interface PaymentLeg {
  accountId: string;
  accountNumber: string;
  accountLabel: string;
  debitMinor: number;
  creditMinor: number;
  taxCode?: string;
  supplyDate?: string;
}

export interface PaymentPlan {
  direction: PaymentDirection;
  date: string;
  amountMinor: number;
  currency: string;
  bank: ResolvedAccount;
  counterpartyKind: CounterpartyKind | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  reference: ClassifiedReference & { display: string | null };
  rows: PlannedRow[];
  onAccountMinor: number;
  onAccountBaseMinor: number;
  allocatedMinor: number;
  remainderMinor: number;
  baseAmountMinor: number;
  fx: {
    currency: string;
    baseCurrency: string;
    rate: string;
    rateAsOf: string | null;
    rateSource: string;
    rateMethod: string | null;
    baseAmountMinor: number;
    realisedDiffMinor: number;
  } | null;
  legs: PaymentLeg[];
  istVat: { baseMinor: number; taxMinor: number; recognizedAt: string } | null;
  writeOffThresholdMinor: number;
  /** A domain condition that blocks POSTING but not previewing. Null when the plan is postable. */
  blocker: Record<string, unknown> | null;
}

type PlanResult = { ok: true; plan: PaymentPlan } | { ok: false; error: Result };

/** Guard the scalar shape of a payment input. Everything here is a caller error, never a blocker. */
function guardScalars(input: RecordPaymentInput): Result | null {
  const guard =
    requireString(input.direction, 'direction') ??
    requireDate(input.date, 'date') ??
    requireString(input.bankAccountId, 'bankAccountId') ??
    optionalId(input.counterpartyId, 'counterpartyId');
  if (guard) return guard;
  if (!(PAYMENT_DIRECTIONS as readonly string[]).includes(input.direction)) {
    return err('invalid_input', { field: 'direction', allowed: [...PAYMENT_DIRECTIONS] });
  }
  if (!isPositiveMinor(input.amountMinor)) return err('invalid_input', { field: 'amountMinor' });
  if (input.currency !== undefined && typeof input.currency !== 'string') {
    return err('invalid_input', { field: 'currency' });
  }
  if (input.counterpartyKind !== undefined && !(COUNTERPARTY_KINDS as readonly string[]).includes(input.counterpartyKind)) {
    return err('invalid_input', { field: 'counterpartyKind', allowed: [...COUNTERPARTY_KINDS] });
  }
  if (input.source !== undefined && !(PAYMENT_SOURCES as readonly string[]).includes(input.source)) {
    return err('invalid_input', { field: 'source', allowed: [...PAYMENT_SOURCES] });
  }
  if (input.onAccountMinor !== undefined && !isNonNegativeMinor(input.onAccountMinor)) {
    return err('invalid_input', { field: 'onAccountMinor' });
  }
  if (input.allocations !== undefined && !Array.isArray(input.allocations)) {
    return err('invalid_input', { field: 'allocations' });
  }
  for (const [i, a] of (input.allocations ?? []).entries()) {
    if (a === null || typeof a !== 'object') return err('invalid_input', { field: `allocations[${i}]` });
    if (!isPositiveMinor(a.amountMinor)) return err('invalid_input', { field: `allocations[${i}].amountMinor` });
    if (a.skontoMinor !== undefined && !isNonNegativeMinor(a.skontoMinor)) {
      return err('invalid_input', { field: `allocations[${i}].skontoMinor` });
    }
    if (a.writeOffMinor !== undefined && !isNonNegativeMinor(a.writeOffMinor)) {
      return err('invalid_input', { field: `allocations[${i}].writeOffMinor` });
    }
  }
  return null;
}

/**
 * The proportional Skonto VAT (MWSTG Art. 41), computed through the SAME `computeLineTax` A06 uses.
 *
 * The rate is the one the ORIGINAL supply was taxed at, so the supply date governs it (a 2023
 * straddle reverses at 7.7%, not at today's 8.1%). The DATING is separate and is the payment date:
 * Art. 41 makes the correction "im Zeitpunkt, in dem die Korrektur verbucht oder das korrigierte
 * Entgelt vereinnahmt wird", which is what puts it in A07's payment period and never reopens the
 * invoice period.
 *
 * A document whose lines carry more than one tax code is REFUSED rather than split on an averaged
 * rate: an averaged VAT reversal is a figure no line of the invoice supports.
 */
function skontoVatFor(
  ctx: WorkspaceContext,
  doc: DocRow,
  skontoNetMinor: number,
):
  | { taxMinor: number; taxCode: string | null; supplyDate: string | null; vatRole: AccountRole | null }
  | Result {
  const lines = ctx.store.db
    .prepare('SELECT tax_code, supply_date FROM document_line WHERE workspace_id = ? AND document_id = ?')
    .all(ctx.workspaceId, doc.id) as { tax_code: string | null; supply_date: string | null }[];
  const codes = new Set(lines.map((l) => l.tax_code ?? 'none'));
  if (codes.size > 1) {
    return err('unsupported', {
      field: 'skontoMinor',
      reason: 'skonto_mixed_tax_codes',
      documentId: doc.id,
      hint: 'A cash discount on a document mixing tax codes needs a per-rate split A14 does not model yet.',
    });
  }
  const taxCode = lines[0]?.tax_code ?? null;
  const supplyDate = lines[0]?.supply_date ?? doc.issue_date ?? null;
  if (taxCode === null || taxCode === 'none') {
    return { taxMinor: 0, taxCode: null, supplyDate: null, vatRole: null };
  }
  const computed = computeLineTax(ctx, {
    amountMinor: skontoNetMinor,
    amountIsGross: false,
    taxCode,
    supplyDate,
  });
  if (!computed.ok) return computed;
  const taxMinor = computed.taxMinor as number;
  const vatRole = vatRoleFor(
    computed.kind as string,
    (computed.formLine as string | null) ?? null,
    computed.deductible as boolean,
  );
  if (taxMinor !== 0 && vatRole === null) {
    return err('unsupported', {
      field: 'skontoMinor',
      reason: 'skonto_on_this_tax_code_not_modelled',
      taxCode,
      kind: computed.kind as string,
      hint: 'Bezugsteuer, Einfuhrsteuer and non-deductible input codes correct across more than one leg.',
    });
  }
  return { taxMinor, taxCode, supplyDate, vatRole };
}

/**
 * The paid-portion VAT stamp (US-A14.5, MWSTG Art. 39 Ist timing).
 *
 * ONE round, on the tax, taken proportionally from the document's own booked VAT rather than
 * recomputed from a rate: A07 reads the STORED figure, so the split must reconcile to the document
 * it came from, and the base is then the remainder of the cash so that base + tax == the cash
 * received exactly. Half of a gross 1'081.00 is 540.50, and 540.50 splits into base 500.00 and tax
 * 40.50 with nothing lost.
 */
function istVatSplit(doc: DocRow, cashMinor: number): { baseMinor: number; taxMinor: number } {
  if (doc.total_minor <= 0 || doc.tax_minor === 0) return { baseMinor: cashMinor, taxMinor: 0 };
  const taxMinor = roundHalfAwayFromZero(doc.tax_minor * cashMinor, doc.total_minor);
  return { baseMinor: cashMinor - taxMinor, taxMinor };
}

/**
 * Build the plan. `excludePaymentId` lets `allocatePayment` re-plan a payment that already exists
 * without counting its own earlier allocations twice.
 */
export function planPayment(
  ctx: WorkspaceContext,
  input: RecordPaymentInput,
  options: { excludePaymentId?: string; existingAllocatedMinor?: number } = {},
): PlanResult {
  const scalarErr = guardScalars(input);
  if (scalarErr) return { ok: false, error: scalarErr };

  const direction = input.direction as PaymentDirection;
  const base = baseCurrencyOf(ctx);
  const currency = input.currency ?? base;

  // §H-FX: the rate comes from the ONE rate surface (`resolveFxRate`), never from a second
  // mechanism of A14's own. A base-currency payment resolves to 1 without a lookup, so nothing
  // about a CHF payment in a CHF workspace changes. A foreign payment with no admissible rate is
  // REFUSED with `needs_fx_rate` naming the pair and the date, never converted at a guess.
  const rateResult = resolveFxRate(ctx, {
    currency,
    date: input.date,
    ...(input.fxRate !== undefined ? { explicitRate: input.fxRate } : {}),
  });
  if (!rateResult.ok) return { ok: false, error: rateResult };
  const fx = rateResult.resolved;

  const bank = resolveBankAccount(ctx, input.bankAccountId);
  if (isRejection(bank)) return { ok: false, error: bank };

  // The counterparty (spec defect 1's fix). Validated in THIS workspace: a foreign contact and a
  // nonexistent one get the same rejection, so no id is probeable across tenants (§H-TENANT).
  let counterpartyKind: CounterpartyKind | null =
    (input.counterpartyKind as CounterpartyKind | undefined) ?? null;
  let counterpartyId: string | null = input.counterpartyId ?? null;
  let counterpartyName: string | null = null;
  if (counterpartyId !== null) {
    const contact = ctx.store.db
      .prepare('SELECT id, name, party_role, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, counterpartyId) as
      | { id: string; name: string; party_role: string; merged_into_id: string | null }
      | undefined;
    if (contact === undefined) {
      return { ok: false, error: err('invalid_reference', { field: 'counterpartyId' }) };
    }
    // A MERGE TOMBSTONE IS REFUSED, not silently redirected, and it is the one contact read in this
    // module that must not resolve. A14 freezes `counterparty_id` the moment the payment posts, so a
    // reference written here is unfixable for the life of the row: accepting a retired id would mint
    // the very split the read-side resolver then has to paper over forever. Naming the survivor lets
    // the caller retry against the id that is actually live, and `preview_payment` refuses identically
    // so the preview cannot promise a booking the record then declines.
    if (contact.merged_into_id !== null) {
      return {
        ok: false,
        error: err('counterparty_merged', {
          field: 'counterpartyId',
          counterpartyId,
          survivorId: resolveContactRef(ctx, counterpartyId)?.id ?? contact.merged_into_id,
        }),
      };
    }
    counterpartyName = contact.name;
    if (counterpartyKind === null) {
      counterpartyKind = contact.party_role === 'vendor' ? 'supplier' : 'customer';
    }
  }

  const reference = classifyReference(input.reference);
  const thresholdMinor = writeOffThresholdOf(ctx);
  const timing = vatTimingOf(ctx);

  const rows: PlannedRow[] = [];
  let allocatedMinor = 0;
  let blocker: Record<string, unknown> | null = null;
  const seen = new Set<string>();
  // The SIDE (receivable 1100 vs payable 2000) the first allocation put this payment on. X1 below
  // compares counterparties only WITHIN one side; a row that flips the side is a mixed-target call,
  // diagnosed by `mixed_allocation_targets` after the loop, and X1 must not preempt that.
  let establishedSide: 'receivable' | 'payable' | null = null;

  for (const [i, a] of (input.allocations ?? []).entries()) {
    // Naming a `vendorBillId` or a `dunningItemId` IMPLIES the kind, so the two cannot disagree; an
    // explicit `targetKind` that contradicts the field it was passed with is refused rather than
    // silently preferred.
    const impliedKind =
      a.vendorBillId !== undefined ? 'vendor_bill' : a.dunningItemId !== undefined ? 'dunning_fee' : 'document';
    const targetKind = (a.targetKind ?? impliedKind) as AllocationTargetKind;
    if (!(ALLOCATION_TARGET_KINDS as readonly string[]).includes(targetKind)) {
      return { ok: false, error: err('invalid_input', { field: `allocations[${i}].targetKind` }) };
    }
    if (a.vendorBillId !== undefined && targetKind !== 'vendor_bill') {
      return {
        ok: false,
        error: err('invalid_input', {
          field: `allocations[${i}].targetKind`,
          reason: 'vendor_bill_id_with_document_kind',
        }),
      };
    }
    if (a.dunningItemId !== undefined && targetKind !== 'dunning_fee') {
      return {
        ok: false,
        error: err('invalid_input', {
          field: `allocations[${i}].targetKind`,
          reason: 'dunning_item_id_with_document_kind',
        }),
      };
    }
    const targetId = a.targetId ?? a.documentId ?? a.vendorBillId ?? a.dunningItemId;
    if (typeof targetId !== 'string' || targetId.length === 0) {
      return { ok: false, error: err('invalid_input', { field: `allocations[${i}].documentId` }) };
    }
    if (seen.has(`${targetKind}:${targetId}`)) {
      return {
        ok: false,
        error: err('invalid_input', { field: `allocations[${i}].documentId`, reason: 'duplicate_target' }),
      };
    }
    seen.add(`${targetKind}:${targetId}`);

    const target = readTarget(ctx, targetKind, targetId);
    if (target === undefined) {
      return { ok: false, error: err('not_found', { [idFieldFor(targetKind)]: targetId }) };
    }
    const doc = target.doc;

    // The side this row books to. The first row anchors the payment's side; a later row on the OTHER
    // side is a mixed receivable/payable call, and that structural target-type mismatch is the more
    // specific diagnosis than "two counterparties" (a mixed call trivially has two, one per side). So
    // X1 declines to fire on a side-flipping row and lets `mixed_allocation_targets` (after the loop)
    // own the refusal. Within ONE side, X1 is unweakened: same side, different debtor still refuses
    // here. Nothing is written either way, so deferring the code is safe (P7).
    const rowSide: 'receivable' | 'payable' = targetKind === 'vendor_bill' ? 'payable' : 'receivable';
    const mixesSide = establishedSide !== null && rowSide !== establishedSide;
    if (establishedSide === null) {
      establishedSide = rowSide;
    }

    // X1 (D80, remediated per the guards critic's F2, docs/critique/a14-guards-critic.md on branch
    // claude/a14-guards-critic, commit c108986): ONE INCOMING PAYMENT MAY SETTLE ONLY ONE DEBTOR'S
    // POSITIONS, checked against the counterparty IN FORCE rather than only one the caller happened
    // to state. `counterpartyId` starts as whatever the caller passed (possibly null) and the
    // derivation at the foot of this loop sets it from the FIRST row that carries a contact when the
    // caller left it out; every row, including that first one, is checked against whatever is in
    // force AT THAT POINT. The first round of this guard compared only a CALLER-stated id, which the
    // critic's G1 probes proved was no guard at all: omitting `counterpartyId` reached the identical
    // cross-debtor settlement (a payment for A silently clearing B's invoice too, filed under A, with
    // a Guthaben remainder parked under A though B's cash funded part of it) with the refusal's own
    // remediation sentence spelling out the omission. Both ids are resolved through C00's merge chain
    // before comparing, so a target whose OWN contact was later merged does not read as a mismatch (a
    // stated tombstone is refused earlier, at the counterparty lookup itself, so `counterpartyId` here
    // is always either null or already live).
    //
    // SCOPED TO THE RECEIVABLE SIDE (the A14/A20 seam). The hazard the guards critic proved was a
    // RECEIVABLE one: an incoming customer payment silently clearing a SECOND debtor's invoice, its
    // remainder parked under the wrong customer. Every G1/G2/G3 probe that must still refuse names a
    // `documentId` or a credit note (1100 Debitoren): scoping X1 to the receivable side leaves all of
    // them refused. The PAYABLE side is the opposite case and NOT misallocation: one A18 pain.001
    // creditor batch executes as a SINGLE bank debit that legitimately settles many vendors' bills at
    // once, and A20's `confirmCamtMatch` splits that debit per bill (US-A20.5). Blocking it here broke
    // that batch with `allocation_counterparty_mismatch` (vendor B's bill against vendor A in force),
    // refusing a lawful multi-vendor settlement the whole creditor-payment flow is built to produce.
    // All vendor-bill rows book to the one 2000 Kreditoren counter account, so `buildLegs` resolves a
    // single coherent entry regardless of how many distinct vendors the batch spans. P7's mixed
    // vendor-bill + dunning-fee call is untouched: its second row flips the side, so `mixesSide` skips
    // X1 there exactly as before and `mixed_allocation_targets` owns that refusal after the loop.
    if (!mixesSide && rowSide === 'receivable' && target.contactId !== null) {
      const targetContact = resolveContactRef(ctx, target.contactId);
      const targetContactId = targetContact !== null ? targetContact.id : target.contactId;
      if (counterpartyId !== null) {
        const inForce = resolveContactRef(ctx, counterpartyId);
        const inForceId = inForce !== null ? inForce.id : counterpartyId;
        if (targetContactId !== inForceId) {
          return {
            ok: false,
            error: err('allocation_counterparty_mismatch', {
              field: `allocations[${i}].${idFieldFor(targetKind)}`,
              [idFieldFor(targetKind)]: target.id,
              effectiveCounterpartyId: inForceId,
              targetContactId,
              reason: "a payment may settle only ONE counterparty's positions: record separate payments, one per counterparty",
            }),
          };
        }
      }
    }

    const amountMinor = a.amountMinor;
    const skontoMinor = a.skontoMinor ?? 0;
    const writeOffMinor = a.writeOffMinor ?? 0;

    if (writeOffMinor > 0 && targetKind === 'vendor_bill') {
      // A PURCHASE-SIDE WRITE-OFF IS REFUSED, for exactly the reason the Skonto branch below refuses
      // a purchase-side Skonto: a supplier waiving part of the consideration is an
      // Einkaufspreisminderung, and MWSTG Art. 41 Abs. 2 obliges a Vorsteuer correction on it.
      // That correction leg does not exist yet, and guessing it moves a filed figure. Booking the
      // waiver anyway would also credit 3805 (Verluste aus FORDERUNGEN, the receivable-loss
      // account), netting supplier income against customer bad debt. Until a `purchaseWriteOff`
      // role and its input-tax correction exist, the answer is the same partial payment the Skonto
      // refusal points at: book the bill at the amount actually owed, or void and re-capture.
      // `writeOffOfferedMinor` is likewise ZERO on a vendor-bill row below, so no surface renders
      // a one-click chip for a path this refuses.
      return {
        ok: false,
        error: err('unsupported', {
          field: `allocations[${i}].writeOffMinor`,
          reason: 'write_off_only_on_incoming_invoice_payments',
        }),
      };
    }

    // Owner decision P10: a payment in one currency MAY settle a document in another. What it may
    // not do is have the engine invent the conversion the payer's bank already performed, so the
    // caller states the cash it consumed and the engine states the base-currency consequence.
    const crossCurrency = target.currency !== currency;
    const paymentAmountMinor = a.paymentAmountMinor ?? amountMinor;
    if (!isPositiveMinor(paymentAmountMinor)) {
      return { ok: false, error: err('invalid_input', { field: `allocations[${i}].paymentAmountMinor` }) };
    }
    if (crossCurrency && a.paymentAmountMinor === undefined) {
      return {
        ok: false,
        error: err('needs_payment_amount', {
          field: `allocations[${i}].paymentAmountMinor`,
          [idFieldFor(targetKind)]: target.id,
          number: target.number,
          payCurrency: currency,
          docCurrency: target.currency,
          reason: 'a cross-currency settlement states the cash consumed as well as the amount settled',
        }),
      };
    }
    if (!crossCurrency && paymentAmountMinor !== amountMinor) {
      return {
        ok: false,
        error: err('invalid_input', {
          field: `allocations[${i}].paymentAmountMinor`,
          reason: 'same_currency_amounts_must_agree',
        }),
      };
    }
    const alreadySettledBlocker = () => ({
      code:
        target.kind === 'vendor_bill'
          ? 'vendor_bill_not_settleable'
          : target.kind === 'dunning_fee'
            ? 'dunning_fee_not_settleable'
            : 'document_already_settled',
      [idFieldFor(target.kind)]: target.id,
      number: target.number,
      status: target.status,
    });
    if (!target.settleable) blocker ??= alreadySettledBlocker();

    const paidMinor = settledMinor(ctx, targetKind, targetId, options.excludePaymentId);
    const openMinor = target.totalMinor - paidMinor;
    if (openMinor <= 0) blocker ??= alreadySettledBlocker();

    const bookedBase = target.bookedBaseMinor;
    let skontoVatMinor = 0;
    let skontoTaxCode: string | null = null;
    let skontoSupplyDate: string | null = null;
    let skontoVatRole: AccountRole | null = null;
    if (skontoMinor > 0) {
      if (direction !== 'incoming' || doc === null || doc.type !== 'invoice') {
        // PURCHASE-SIDE SKONTO IS REFUSED, and the reason has been corrected rather than the refusal
        // relaxed. It used to read "A17 does not exist yet"; A17 exists now and this still refuses,
        // because an Einkaufspreisminderung reverses INPUT tax under MWSTG Art. 41 Abs. 2 (keyed on
        // the corrected Entgelt being bezahlt), which corrects a different ESTV Ziffer on a
        // different event from the sales case in Abs. 1 (the Umsatzsteuerschuld, keyed on it being
        // vereinnahmt); `accounts.ts` states the same split over the role map. The
        // legs are wired (`buildLegs` resolves 4900/4906 whenever the settlement clears a payable);
        // what is missing is the Vorsteuer correction, and guessing it moves a filed figure. A17 §3
        // OUT records this with the workaround: book the bill at the amount actually paid.
        return {
          ok: false,
          error: err('unsupported', {
            field: `allocations[${i}].skontoMinor`,
            reason: 'skonto_only_on_incoming_invoice_payments',
          }),
        };
      }
      const vat = skontoVatFor(ctx, doc, skontoMinor);
      if ('ok' in vat) return { ok: false, error: vat };
      skontoVatMinor = vat.taxMinor;
      skontoTaxCode = vat.taxCode;
      skontoSupplyDate = vat.supplyDate;
      skontoVatRole = vat.vatRole;
      if (skontoMinor + skontoVatMinor > openMinor) {
        // Its OWN code, never the generic mismatch: the two causes must never share a sentence.
        blocker ??= {
          code: 'skonto_exceeds_open',
          documentId: doc.id,
          number: doc.number,
          skontoMinor: skontoMinor + skontoVatMinor,
          openMinor,
        };
      }
    }

    const settlementMinor = amountMinor + skontoMinor + skontoVatMinor + writeOffMinor;
    if (settlementMinor > openMinor && blocker === null) {
      blocker = {
        code: 'allocation_exceeds_open',
        [idFieldFor(target.kind)]: target.id,
        number: target.number,
        amountMinor: settlementMinor,
        openMinor,
      };
    }

    const resultingOpen = openMinor - settlementMinor;
    const residual = openMinor - (amountMinor + skontoMinor + skontoVatMinor);
    // The Ist stamp is a DOCUMENT-side seam only, for the reason on `SettlementTarget`.
    const ist = timing === 'ist' && doc !== null ? istVatSplit(doc, amountMinor) : null;

    // The base-currency legs. Each component takes its proportional share of the document's BOOKED
    // base, so the receivable clears at exactly the value it was booked at, and the Skonto VAT is
    // recomputed from the BASE Skonto rather than converted from the transaction-currency figure:
    // A02's post-boundary gate recomputes the trace from the booked base amount, so deriving it any
    // other way would leave the two a Rappen apart and fail `vat_trace_unreconciled`.
    let cashBaseMinor = baseShare(bookedBase, amountMinor, target.totalMinor);
    const skontoBaseMinor = baseShare(bookedBase, skontoMinor, target.totalMinor);
    const writeOffBaseMinor = baseShare(bookedBase, writeOffMinor, target.totalMinor);
    let skontoVatBaseMinor = skontoVatMinor;
    if (skontoBaseMinor !== skontoMinor && skontoTaxCode !== null) {
      const baseVat = computeLineTax(ctx, {
        amountMinor: skontoBaseMinor,
        amountIsGross: false,
        taxCode: skontoTaxCode,
        supplyDate: skontoSupplyDate,
      });
      if (!baseVat.ok) return { ok: false, error: baseVat };
      skontoVatBaseMinor = baseVat.taxMinor as number;
    }

    // K-34, the FINAL-SETTLEMENT base true-up. Each partial payment's cash base is an INDEPENDENTLY
    // rounded proportional share of the WHOLE booked base (`baseShare` above), and `Σ round(share_i)`
    // is not `round(Σ share_i)`: a EUR 100.00 invoice booked at CHF 95.01 (base 9501) settled 33.33 /
    // 33.33 / 33.34 rounds to 3167 / 3167 / 3168 = 9502, a Rappen MORE than the 9501 the receivable
    // was booked at, so a FULLY paid invoice would leave a permanent 1-Rappen stub on 1100 and the
    // realised FX on 3806/4906 would be wrong by the same Rappen. When THIS allocation CLOSES the
    // position (`resultingOpen === 0`) and the booked base differs from the face total (a foreign
    // position, the only case where the rounding split exists at all), the cash base is set to the
    // base STILL on the receivable, `bookedBase` minus the base prior settlements already released and
    // minus the non-cash base this same allocation releases, so the position clears to EXACTLY its
    // booked base and the residual rounding drift flows into the FX difference plug (`buildLegs`),
    // the one account whose whole job is to hold a difference. A base-currency position has
    // `bookedBase === totalMinor` and never enters here, so a CHF settlement books precisely what it
    // always did. A single full payment released nothing prior and settles the whole face, so the
    // true-up returns the identical figure the independent share did (a no-op, measured), which is
    // why the correct single-full-payment path is untouched.
    if (resultingOpen === 0 && bookedBase !== target.totalMinor) {
      const priorReleasedBase = releasedBaseMinor(
        ctx,
        targetKind,
        targetId,
        bookedBase,
        target.totalMinor,
        doc,
        options.excludePaymentId,
      );
      if (typeof priorReleasedBase !== 'number') return { ok: false, error: priorReleasedBase };
      cashBaseMinor = bookedBase - priorReleasedBase - skontoBaseMinor - skontoVatBaseMinor - writeOffBaseMinor;
    }

    allocatedMinor += paymentAmountMinor;
    rows.push({
      targetKind,
      targetId,
      number: target.number,
      currency: target.currency,
      dueDate: target.dueDate,
      grossMinor: target.totalMinor,
      paidMinor,
      openMinor,
      allocatedMinor: amountMinor,
      paymentAmountMinor,
      bookedBaseMinor: bookedBase,
      cashBaseMinor,
      skontoBaseMinor,
      skontoVatBaseMinor,
      writeOffBaseMinor,
      settlementBaseMinor: cashBaseMinor + skontoBaseMinor + skontoVatBaseMinor + writeOffBaseMinor,
      skontoMinor,
      skontoVatMinor,
      writeOffMinor,
      settlementMinor,
      resultingOpenMinor: resultingOpen,
      // The word the PREVIEW shows. For a document it is A10's own status vocabulary, which A14 then
      // writes; for a vendor bill it is A17's derived settlement word, which nothing writes anywhere.
      resultingStatus: resultingStatusFor(ctx, target, paidMinor, settlementMinor, resultingOpen),
      // The one-click offer, inclusive at the boundary (P10). Beyond the threshold it is ZERO, so
      // the surface shows no chip and the honest default stays a partial payment (P11). ZERO on a
      // vendor-bill row too, always: the write-off is refused on a payable (Art. 41 Abs. 2, the
      // refusal above), and a chip that renders an offer the engine then rejects is an advertised
      // dead end.
      writeOffOfferedMinor:
        target.kind !== 'vendor_bill' && writeOffMinor === 0 && residual > 0 && residual <= thresholdMinor
          ? residual
          : 0,
      taxBaseMinor: ist === null ? null : ist.baseMinor,
      taxAmountMinor: ist === null ? null : ist.taxMinor,
      recognizedAt: ist === null ? null : input.date,
      skontoTaxCode,
      skontoSupplyDate,
      skontoVatRole,
      doc,
    });

    if (counterpartyId === null && target.contactId !== null) {
      const contact = ctx.store.db
        .prepare('SELECT id, name FROM contact WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, target.contactId) as { id: string; name: string } | undefined;
      if (contact !== undefined) {
        counterpartyId = contact.id;
        counterpartyName = contact.name;
        // The kind FOLLOWS THE TARGET, not the contact's own role. A contact tagged `both` settles
        // invoices as a customer and bills as a supplier, and the kind is what `buildLegs` used to
        // choose 1100 against 2000 from before this branch existed.
        counterpartyKind ??= target.kind === 'vendor_bill' ? 'supplier' : 'customer';
      }
    }
  }

  // ONE PAYMENT MAY NOT MIX A RECEIVABLE AND A PAYABLE, and this is the guard that makes the leg
  // choice below safe. A single balanced entry clearing both 1100 and 2000 from one cash movement is
  // not a settlement, it is two settlements sharing a bank leg, and `buildLegs` resolves exactly ONE
  // counter account per entry. Refused before anything is planned rather than blocked, because there
  // is no coherent preview to render for it.
  //
  // Grouped by SIDE, not by kind (this increment's extension): `document` and `dunning_fee` both
  // book to 1100 Debitoren, so a payment MAY mix the two, which is the whole point, one payment
  // settling an invoice AND its own booked Mahngebühr. `vendor_bill` is the only payable-side kind,
  // and mixing it with either receivable-side kind is refused exactly as before.
  const sideOf = (kind: AllocationTargetKind): 'receivable' | 'payable' => (kind === 'vendor_bill' ? 'payable' : 'receivable');
  const targetKinds = new Set(rows.map((r) => r.targetKind));
  const targetSides = new Set(rows.map((r) => sideOf(r.targetKind)));
  if (targetSides.size > 1) {
    return {
      ok: false,
      error: err('mixed_allocation_targets', {
        field: 'allocations',
        kinds: [...targetKinds],
        reason: 'one payment settles receivables or payables, never both: record two payments',
      }),
    };
  }

  // A TARGET'S SIDE MUST AGREE WITH THE COUNTER ACCOUNT THIS PLAN WILL RESOLVE (A17-R1). `buildLegs`
  // picks the payable side when any row is a vendor bill OR when the caller said `supplier`, so a
  // caller-stated `supplier` beside a RECEIVABLE-SIDE row (a document OR a dunning fee) would clear
  // those rows against 2000 Kreditoren while 1100 still carries them: an invoice reading `settled`
  // with the receivable untouched, and both reconciliations false at once. `counterpartyKind` is
  // exactly the label the C1 guard decided not to trust, so it may never outvote a target: refused
  // here, beside the mixed-target guard, before anything is planned further. The OTHER pairing (a
  // stated `customer` beside a vendor-bill row) is deliberately NOT a contradiction: the vendor-bill
  // target FORCES the payable side in `buildLegs` precisely because the derived label resolves a
  // `both`-tagged vendor to `customer`, so there the target wins and the entry is correct (measured,
  // F5).
  const receivableSideRow = rows.find((r) => sideOf(r.targetKind) === 'receivable');
  if (counterpartyKind === 'supplier' && receivableSideRow !== undefined) {
    return {
      ok: false,
      error: err('allocation_target_side_mismatch', {
        field: 'allocations',
        counterpartyKind: 'supplier',
        targetKind: receivableSideRow.targetKind,
        reason:
          'a supplier settlement books against 2000 Kreditoren and a customer document or dunning fee sits on 1100 Debitoren: name the vendor bill being settled, or drop counterpartyKind and let the target choose the side',
      }),
    };
  }

  // X2 (D80, baseline B4 in the A14 fee-target critic's report: branch claude/a14-fee-critic, commit
  // 259bb7e, docs/critique/a14-fee-critic.md, which does not exist on this branch): THE DIRECTION
  // MUST AGREE WITH THE TARGET'S OWN SIDE, checked here, after the two guards above, so a case those
  // already refuse (R1's mismatched `supplier` label) keeps ITS OWN sentence rather than this one's.
  // The payee question is X1's alone (above, inside the loop): a mixed call refunding TWO different
  // debtors' credit notes in one outgoing entry is caught there, because both rows are checked
  // against the counterparty in force before either reaches this direction check (the guards
  // critic's F3, docs/critique/a14-guards-critic.md on branch claude/a14-guards-critic, commit
  // c108986, which falls out of F2's fix rather than needing a check of its own).
  //
  // A document that is NOT a credit note sits on 1100 Debitoren, and only an INCOMING payment may
  // clear it: `buildLegs` flips every leg for `outgoing`, so the credit that would normally reduce
  // 1100 becomes a DEBIT, and the "settlement" GROWS the receivable it claims to close (measured:
  // 108100 to 216200 on an ordinary invoice, doubling it rather than clearing it). A credit note is
  // the one document that legitimately settles OUTGOING: A13's poster already credited 1100 for it
  // at issuance (`buildCreditNotePosting`), so a cash refund payout re-debits that same account to
  // reopen the invoice it had covered, which is the whole point of the flow (settled-by-credit S10).
  // A vendor bill sits on 2000 Kreditoren and is the mirror: A17 has no vendor-credit concept yet,
  // so only OUTGOING clears it and nothing today needs the opposite pairing.
  for (const row of rows) {
    const isCreditNoteRow = row.targetKind === 'document' && row.doc !== null && row.doc.type === 'credit_note';
    const expectedDirection: PaymentDirection =
      row.targetKind === 'vendor_bill' || isCreditNoteRow ? 'outgoing' : 'incoming';
    if (direction !== expectedDirection) {
      return {
        ok: false,
        error: err('allocation_direction_mismatch', {
          field: 'direction',
          [idFieldFor(row.targetKind)]: row.targetId,
          direction,
          expectedDirection,
          targetKind: row.targetKind,
          reason:
            expectedDirection === 'incoming'
              ? 'an outgoing payment cannot settle a receivable: it grows 1100 Debitoren instead of ' +
                'reducing it, the opposite of what a settlement means'
              : row.targetKind === 'vendor_bill'
                ? 'an incoming payment cannot settle a payable: it grows 2000 Kreditoren instead of reducing it'
                : 'a credit note settles as a refund payout, outgoing only: an incoming payment against it has no ledger meaning',
        }),
      };
    }
  }

  const existingAllocated = options.existingAllocatedMinor ?? 0;
  const onAccountMinor = input.amountMinor - existingAllocated - allocatedMinor;
  if (input.onAccountMinor !== undefined && input.onAccountMinor !== onAccountMinor && blocker === null) {
    blocker = {
      code: 'allocation_mismatch',
      statedOnAccountMinor: input.onAccountMinor,
      derivedOnAccountMinor: onAccountMinor,
      differenceMinor: onAccountMinor - input.onAccountMinor,
    };
  }
  if (onAccountMinor < 0 && blocker === null) {
    // Over-allocated: the allocations claim more cash than actually moved.
    blocker = { code: 'allocation_mismatch', differenceMinor: onAccountMinor, amountMinor: input.amountMinor };
  }
  if (onAccountMinor > 0 && counterpartyId === null && blocker === null) {
    // A credit belonging to nobody cannot exist (P12b): A16 could not net it into a customer
    // balance and a later allocation could not be scoped to that customer's open items.
    blocker = { code: 'needs_counterparty', onAccountMinor };
  }

  // §H-PERIOD. Reported as a blocker rather than a hard rejection so the preview still renders the
  // whole booking and the surface can name the exact period beside a disabled confirm.
  const periodOpen = ctx.periods.assertOpen(input.date);
  if (!periodOpen.ok && blocker === null) {
    blocker = { ...periodOpen, code: periodOpen.error };
  }

  const cashMinor = input.amountMinor - existingAllocated;
  const baseAmountMinor = convertMinor(cashMinor, fx.rateScaled);
  const onAccountBaseMinor = convertMinor(onAccountMinor, fx.rateScaled);

  // D95 payable-account override (E02 employee-payable). Resolved and hard-guarded here, once, so
  // `buildLegs` receives an already-validated account or nothing. The three guards are the whole
  // contract: it clears a LIABILITY account (never cash, never a receivable), it applies ONLY to a
  // supplier-side settlement, and it is refused the moment there is an allocation (a bill fixes 2000
  // through its own row, so an override there would silently disagree with the position it clears).
  let payableOverride: ResolvedAccount | null = null;
  if (input.payableAccountId !== undefined) {
    const row = ctx.store.db
      .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.payableAccountId) as
      | { id: string; number: string; name: string; type: string; archived: number }
      | undefined;
    if (row === undefined || row.archived === 1) {
      return { ok: false, error: err('needs_account', { field: 'payableAccountId', reason: row === undefined ? 'missing' : 'archived' }) };
    }
    if (row.type !== 'liability') {
      return { ok: false, error: err('invalid_input', { field: 'payableAccountId', reason: 'not_a_liability', type: row.type }) };
    }
    if ((input.allocations ?? []).length > 0) {
      return { ok: false, error: err('invalid_input', { field: 'payableAccountId', reason: 'override_with_allocation' }) };
    }
    if (counterpartyKind !== 'supplier') {
      return { ok: false, error: err('invalid_input', { field: 'payableAccountId', reason: 'not_a_payable_settlement' }) };
    }
    payableOverride = { id: row.id, number: row.number, label: row.name };
  }

  const legs = buildLegs(ctx, {
    direction,
    bank,
    rows,
    onAccountMinor,
    onAccountBaseMinor,
    baseAmountMinor,
    counterpartyKind,
    payableOverride,
  });
  if ('ok' in legs) return { ok: false, error: legs };

  const istTotals = rows.reduce(
    (acc, r) => ({
      baseMinor: acc.baseMinor + (r.taxBaseMinor ?? 0),
      taxMinor: acc.taxMinor + (r.taxAmountMinor ?? 0),
    }),
    { baseMinor: 0, taxMinor: 0 },
  );

  return {
    ok: true,
    plan: {
      direction,
      date: input.date,
      amountMinor: input.amountMinor,
      currency,
      bank,
      counterpartyKind,
      counterpartyId,
      counterpartyName,
      reference: {
        ...reference,
        display: reference.value === null ? null : formatReference(reference.kind, reference.value),
      },
      rows,
      onAccountMinor,
      onAccountBaseMinor,
      allocatedMinor,
      remainderMinor: onAccountMinor,
      baseAmountMinor: convertMinor(input.amountMinor, fx.rateScaled),
      fx:
        fx.rateScaled === RATE_ONE && currency === base
          ? null
          : {
              currency,
              baseCurrency: base,
              rate: fx.rate,
              rateAsOf: fx.rateAsOf,
              rateSource: fx.rateSource,
              rateMethod: fx.rateMethod,
              baseAmountMinor: convertMinor(input.amountMinor, fx.rateScaled),
              realisedDiffMinor:
                baseAmountMinor - (rows.reduce((n, r) => n + r.cashBaseMinor, 0) + onAccountBaseMinor),
            },
      legs,
      istVat: timing === 'ist' && rows.length > 0 ? { ...istTotals, recognizedAt: input.date } : null,
      writeOffThresholdMinor: thresholdMinor,
      blocker,
    },
  };
}

/**
 * Build the ONE balanced entry (§H-LEDGER, P3).
 *
 * The legs are built for an INCOMING payment and mirrored wholesale for an outgoing one, so the two
 * directions cannot disagree about the SIGN of a leg. They cannot disagree about the ACCOUNT
 * either, because every side-dependent account is resolved from `settlesAPayable` before the
 * mirror runs. Balance, for an incoming payment clearing a receivable:
 *
 *   debit  bank              = the cash that moved
 *   debit  3800 + 2200       = the Skonto net and its proportional VAT reversal (Art. 41)
 *   debit  3805              = the residual written off
 *   debit  or credit 3806    = the realised currency difference, whichever way the rate moved
 *   credit 1100              = Σ(cash + Skonto + Skonto VAT + write-off) + the parked credit
 *
 * which closes exactly, because the credit side is the debit side rearranged. Clearing a PAYABLE
 * runs the same shape against 2000, 4900, 1170 and 4906.
 */
function buildLegs(
  ctx: WorkspaceContext,
  input: {
    direction: PaymentDirection;
    bank: ResolvedAccount;
    rows: PlannedRow[];
    onAccountMinor: number;
    onAccountBaseMinor: number;
    baseAmountMinor: number;
    counterpartyKind: CounterpartyKind | null;
    /** D95: settle the payable side against this pre-validated liability account instead of 2000. */
    payableOverride?: ResolvedAccount | null;
  },
): PaymentLeg[] | Result {
  // ONE predicate decides every side-dependent account in the entry. The wholesale mirror below
  // flips debit and credit, which is what makes an outgoing payment an outgoing payment, but it
  // cannot flip an ACCOUNT: a leg resolved to the sales side stays on the sales side however the
  // money moved. So the side is chosen HERE, from the same fact the counter account is chosen from,
  // and a reduction can never land on the opposite side of the books from the position it reduces.
  //
  // A VENDOR-BILL TARGET FORCES THE PAYABLE SIDE, and `counterpartyKind` decides the rest. That order
  // is A17's arrival and it closes a real hole rather than changing an existing answer:
  // `counterpartyKind` is caller-supplied, and when it is omitted it is derived from the CONTACT's
  // `party_role`, which resolves a vendor tagged `both` to `customer`. A vendor-bill settlement would
  // then have credited 1100 Debitoren while clearing a bill sitting on 2000. The target cannot be
  // wrong about which position it is: a vendor bill IS a payable. Everything with no vendor-bill
  // target (a supplier refund on a credit note, a payment carrying only a parked remainder) keeps
  // exactly the answer it had before, which is what the A14 leg-side tests pin.
  const settlesAPayable =
    input.rows.some((r) => r.targetKind === 'vendor_bill') || input.counterpartyKind === 'supplier';
  const counterRole = settlesAPayable ? 'payable' : 'receivable';
  const legs: PaymentLeg[] = [];
  const push = (account: ResolvedAccount, debitMinor: number, creditMinor: number, extra: Partial<PaymentLeg> = {}) => {
    if (debitMinor === 0 && creditMinor === 0) return;
    legs.push({
      accountId: account.id,
      accountNumber: account.number,
      accountLabel: account.label,
      debitMinor,
      creditMinor,
      ...extra,
    });
  };

  const counterTotal = input.rows.reduce((n, r) => n + r.settlementBaseMinor, 0) + input.onAccountBaseMinor;
  if (input.baseAmountMinor > 0) push(input.bank, input.baseAmountMinor, 0);

  if (counterTotal > 0) {
    // The payable-account override (D95) substitutes ONLY the payable counter leg, and only when the
    // plan already resolved to the payable side. Skonto, write-off and FX legs keep their role
    // accounts (4900/3805/4906): the override moves WHICH liability is cleared, not how a discount or
    // a currency difference on clearing it is booked. On the receivable side it is inert by
    // construction, since `payableOverride` is only ever set for a supplier settlement.
    const counter =
      counterRole === 'payable' && input.payableOverride != null
        ? input.payableOverride
        : resolveRole(ctx, counterRole);
    if (isRejection(counter)) return counter;
    push(counter, 0, counterTotal);
  }

  const skontoTotal = input.rows.reduce((n, r) => n + r.skontoBaseMinor, 0);
  if (skontoTotal > 0) {
    // A discount the CUSTOMER took reduces revenue; a discount the BUSINESS took reduces cost.
    // Booking a purchase discount through 3800 would inflate turnover and expenses in the same
    // entry. That side is A14's to choose, and it follows the position being cleared.
    const skontoAccount = resolveRole(ctx, settlesAPayable ? 'purchaseSkonto' : 'salesSkonto');
    if (isRejection(skontoAccount)) return skontoAccount;
    for (const r of input.rows) {
      if (r.skontoBaseMinor === 0) continue;
      // The §H-VAT-TRACE rides the BASE line (the net Erlösminderung), the one convention A06
      // established: the tag belongs on the line whose booked amount IS the tax base.
      const extra: Partial<PaymentLeg> = {};
      if (r.skontoTaxCode !== null) extra.taxCode = r.skontoTaxCode;
      if (r.skontoSupplyDate !== null) extra.supplyDate = r.skontoSupplyDate;
      push(skontoAccount, r.skontoBaseMinor, 0, extra);
      // The VAT side is NOT A14's to choose. The tax code on the line above already records
      // whether this tax was charged or reclaimed, A02's post-boundary gate recomputes the expected
      // movement from that same code, and an entry that books the correction anywhere else is
      // rejected as `vat_trace_unreconciled` rather than silently posted.
      if (r.skontoVatBaseMinor !== 0 && r.skontoVatRole !== null) {
        const vatCorrection = resolveRole(ctx, r.skontoVatRole);
        if (isRejection(vatCorrection)) return vatCorrection;
        push(vatCorrection, r.skontoVatBaseMinor, 0);
      }
    }
  }

  const writeOffTotal = input.rows.reduce((n, r) => n + r.writeOffBaseMinor, 0);
  if (writeOffTotal > 0) {
    const writeOffAccount = resolveRole(ctx, 'writeOff');
    if (isRejection(writeOffAccount)) return writeOffAccount;
    push(writeOffAccount, writeOffTotal, 0);
  }

  // The REALISED currency difference (§H-FX, owner decision P10).
  //
  // The cash arrived converted at the PAYMENT date's rate; the receivable it releases was booked at
  // the INVOICE date's rate. The gap between the two is money that was genuinely won or lost on the
  // exchange, and it is realised the moment the position settles, so it is posted here rather than
  // left to A22's period-end revaluation. The figure is a PLUG by construction, which is also why
  // the per-component rounding above cannot lose a Rappen: any residue lands in the one account
  // whose whole job is to hold a difference.
  //
  // It lands in an OPERATING account (3806 or 4906 Kursdifferenzen, alongside the Skonti), not in
  // 6949 Währungsverluste. What settled was a trade receivable or a trade payable, and a customer
  // paying late is not a financial investment. A22 keeps 6949 for revaluing FINANCIAL positions at
  // period end, which is a different event. Both operating accounts are bidirectional, so the gain
  // and the loss net in one place instead of a gain sitting as a credit under the word "Verluste".
  //
  // For a single-currency settlement the two conversions are the identity and this is exactly zero,
  // so no leg is emitted and a CHF payment posts precisely the two lines it always did.
  const releasedBase = input.rows.reduce((n, r) => n + r.cashBaseMinor, 0) + input.onAccountBaseMinor;
  const fxDiff = input.baseAmountMinor - releasedBase;
  if (fxDiff !== 0) {
    const fxAccount = resolveRole(ctx, settlesAPayable ? 'purchaseFxRealised' : 'salesFxRealised');
    if (isRejection(fxAccount)) return fxAccount;
    // More base arrived than the receivable carried: a gain, credited. Less: a loss, debited.
    push(fxAccount, fxDiff < 0 ? -fxDiff : 0, fxDiff > 0 ? fxDiff : 0);
  }

  if (input.direction === 'outgoing') {
    return legs.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor }));
  }
  return legs;
}

/** The legs, as A02 line inputs. `postEntry` recomputes and stamps the VAT trace itself (B2). */
function toLineInputs(legs: PaymentLeg[]): LineInput[] {
  return legs.map((l) => {
    const line: LineInput = { account: l.accountId };
    if (l.debitMinor > 0) line.debit = l.debitMinor;
    if (l.creditMinor > 0) line.credit = l.creditMinor;
    if (l.taxCode !== undefined) line.taxCode = l.taxCode;
    if (l.supplyDate !== undefined) line.supplyDate = l.supplyDate;
    return line;
  });
}

// --- previewPayment (INV-3 / decision P7): the read-only twin of recordPayment -------------------

/**
 * Say exactly what would be booked, in the engine's own figures, before anything is written.
 *
 * A caller error (a malformed amount, an unknown document, a currency the engine cannot express)
 * comes back as `{ok:false}`, because there is nothing to preview. A DOMAIN condition (a remainder
 * that does not add up, a locked period, a document settled elsewhere) comes back as `{ok:true}`
 * with `error` filled AND the rest of the preview intact, because a surface has to render the
 * booking and the reason side by side. That distinction is what lets a confirm control be disabled
 * with its reason on screen instead of disabled with nothing.
 */
export function previewPayment(ctx: WorkspaceContext, input: RecordPaymentInput): Result {
  const planned = planPayment(ctx, input);
  if (!planned.ok) return planned.error;
  return ok(renderPreview(planned.plan));
}

function renderPreview(plan: PaymentPlan) {
  const debitTotal = plan.legs.reduce((n, l) => n + l.debitMinor, 0);
  const creditTotal = plan.legs.reduce((n, l) => n + l.creditMinor, 0);
  return {
    direction: plan.direction,
    date: plan.date,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    bankAccount: { id: plan.bank.id, number: plan.bank.number, label: plan.bank.label },
    counterparty:
      plan.counterpartyId === null
        ? null
        : { kind: plan.counterpartyKind, id: plan.counterpartyId, name: plan.counterpartyName },
    reference: {
      kind: plan.reference.kind,
      value: plan.reference.value,
      valid: plan.reference.valid,
      display: plan.reference.display,
      error: plan.reference.error,
    },
    allocatedMinor: plan.allocatedMinor,
    onAccountMinor: plan.onAccountMinor,
    remainderMinor: plan.remainderMinor,
    baseAmountMinor: plan.baseAmountMinor,
    rows: plan.rows.map((r) => ({
      targetKind: r.targetKind,
      targetId: r.targetId,
      number: r.number,
      currency: r.currency,
      dueDate: r.dueDate,
      grossMinor: r.grossMinor,
      paidMinor: r.paidMinor,
      openMinor: r.openMinor,
      allocatedMinor: r.allocatedMinor,
      paymentAmountMinor: r.paymentAmountMinor,
      skontoMinor: r.skontoMinor,
      skontoVatMinor: r.skontoVatMinor,
      writeOffMinor: r.writeOffMinor,
      settlementMinor: r.settlementMinor,
      settlementBaseMinor: r.settlementBaseMinor,
      resultingOpenMinor: r.resultingOpenMinor,
      resultingStatus: r.resultingStatus,
      writeOffOfferedMinor: r.writeOffOfferedMinor,
    })),
    legs: plan.legs.map((l) => ({
      accountId: l.accountId,
      accountNumber: l.accountNumber,
      accountLabel: l.accountLabel,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
    })),
    istVat: plan.istVat,
    // Null means "this payment has no FX leg at all", which is the truth for a base-currency
    // payment. It is never a placeholder for a figure that was omitted.
    fx: plan.fx,
    writeOffThresholdMinor: plan.writeOffThresholdMinor,
    balanced: debitTotal === creditTotal,
    error: plan.blocker,
  };
}

// --- recordPayment --------------------------------------------------------------------------------

/**
 * The idempotency identity of a payment write.
 *
 * The key is folded together with the VERB and the payment's own money side before it ever reaches
 * A02, so it is not derivable from a document id the way `invoice-post-<documentId>` was. That hole
 * let any post-capable caller pre-empt an invoice posting with a CHF 0.01 entry under a key they
 * could guess, and the billed amount stopped equalling the posted amount. Folding the amount, the
 * date and the direction in means a squatter would have to know the exact money side as well, and
 * the caller then VERIFIES what came back rather than trusting it (see `recordPayment`).
 */
function scopedPaymentKey(verb: string, input: RecordPaymentInput, discriminator: string): string {
  return JSON.stringify([verb, discriminator, input.direction, input.date, input.amountMinor, input.idempotencyKey]);
}

export function recordPayment(ctx: WorkspaceContext, input: RecordPaymentInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  // P9: the intent is checked FIRST, before the key, before the plan, before anything is read. A
  // caller who did not mean to move money finds out at the door.
  const intentErr = requireIntent(input.intent, PAYMENT_INTENTS.record);
  if (intentErr) return intentErr;
  const keyErr = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyErr) return keyErr;

  const scopedKey = scopedPaymentKey('record_payment', input, 'new');

  // Replay a completed record BEFORE any state-dependent guard, so a retry returns the original
  // payment instead of tripping `document_already_settled` on the invoice it itself closed.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'record_payment');
  if (replayed !== undefined) return replayed;

  // The raw client key is unique per workspace at the DB layer, which is a STRONGER guarantee than
  // the scoped memo above and deliberately so: the memo replays an identical retry, and this
  // refuses a key reused for a DIFFERENT payment. Checked here so the refusal is a P9 Result naming
  // the payment that already holds the key, rather than a driver constraint escaping as a throw.
  // Silently minting a second payment under a reused key is exactly the shape of hole that let a
  // guessable key stand a CHF 0.01 entry in for a CHF 1'081.00 posting.
  const keyHolder = ctx.store.db
    .prepare('SELECT id FROM payment WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (keyHolder !== undefined) {
    return err('idempotency_key_conflict', {
      idempotencyKey: input.idempotencyKey,
      paymentId: keyHolder.id,
      reason: 'this key already recorded a different payment; a retry must repeat the same money side',
    });
  }

  const planned = planPayment(ctx, input);
  if (!planned.ok) return planned.error;
  const plan = planned.plan;
  if (plan.blocker !== null) return err(String(plan.blocker.code), plan.blocker);

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'record_payment', () => {
      const paymentId = ctx.ids.next('pay');
      const posted = postEntry(ctx, {
        date: plan.date,
        source: 'payment',
        description: `Zahlung ${plan.direction === 'incoming' ? 'Eingang' : 'Ausgang'}`,
        // The entry's key is scoped to THIS payment id, which is minted here and cannot be guessed
        // from anything a caller sent.
        idempotencyKey: JSON.stringify(['payment_entry', paymentId]),
        lines: toLineInputs(plan.legs),
      });
      if (!posted.ok) throw new PaymentAbort(posted);
      // No cast. `postEntry` declares `Result<PostEntryOk>` now, so `entryId` is a `string` here and
      // renaming it in the ledger is a compile error at THIS line. The `as string` that stood here
      // was the opaque `Ok` being worked around: it asserted the shape and checked nothing, which is
      // exactly how a payment could have been written against an `undefined` entry id.
      const entryId = posted.entryId;

      // Trust nothing, including our own posting path: read the entry back and assert it is the one
      // we asked for, balanced and on the amount we planned. This is the check whose absence let a
      // squatted key substitute a CHF 0.01 entry for a CHF 1'081.00 posting.
      const verified = verifyEntry(ctx, entryId, plan);
      if (verified !== null) throw new PaymentAbort(verified);

      writePaymentRow(ctx, paymentId, plan, input, entryId);
      for (const row of plan.rows) writeAllocationRow(ctx, paymentId, row, entryId);
      applyDocumentStatuses(ctx, plan.rows);

      ctx.audit.record({
        entityKind: 'payment',
        entityId: paymentId,
        action: 'post',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });

      return ok({
        paymentId,
        entryId,
        onAccountMinor: plan.onAccountMinor,
        ...echoes(ctx, plan.rows),
      });
    }),
  );
}

/** Abort the write transaction with a structured cause, so nothing is memoised on a rejection. */
class PaymentAbort {
  constructor(public readonly result: Result) {}
}

/**
 * Run a write that may abort mid-transaction. Throwing is the ONLY way to roll a better-sqlite3
 * transaction back, so a structured rejection discovered after the transaction opened travels out
 * as a `PaymentAbort` and is unwrapped here: nothing is committed, nothing is memoised under the
 * idempotency key, and the caller still gets a P9 Result rather than an exception.
 */
function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof PaymentAbort) return e.result;
    throw e;
  }
}

/**
 * Read back what A02 actually wrote and refuse anything that is not the posting we planned.
 *
 * A returned id is a claim; the rows are the fact. Comparing them is what turns "posting is
 * idempotent" from a property of the happy path into one that survives a caller who reached the
 * verb through a key they should not have owned.
 */
function verifyEntry(ctx: WorkspaceContext, entryId: string, plan: PaymentPlan): Result | null {
  const entry = ctx.store.db
    .prepare('SELECT id, status, date, source FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { id: string; status: string; date: string; source: string } | undefined;
  if (entry === undefined || entry.status !== 'posted' || entry.source !== 'payment' || entry.date !== plan.date) {
    return err('posting_verification_failed', { entryId, reason: 'entry_is_not_the_planned_posting' });
  }
  const totals = ctx.store.db
    .prepare(
      'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c, COUNT(*) AS n FROM journal_line WHERE entry_id = ?',
    )
    .get(entryId) as { d: number; c: number; n: number };
  const plannedDebit = plan.legs.reduce((n, l) => n + l.debitMinor, 0);
  if (totals.d !== totals.c) {
    return err('posting_verification_failed', { entryId, reason: 'unbalanced', debitMinor: totals.d, creditMinor: totals.c });
  }
  if (totals.d !== plannedDebit || totals.n !== plan.legs.length) {
    return err('posting_verification_failed', {
      entryId,
      reason: 'amount_or_shape_differs_from_the_plan',
      plannedMinor: plannedDebit,
      postedMinor: totals.d,
    });
  }
  return null;
}

function writePaymentRow(
  ctx: WorkspaceContext,
  paymentId: string,
  plan: PaymentPlan,
  input: RecordPaymentInput,
  entryId: string,
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO payment
         (id, workspace_id, direction, date, amount_minor, currency, base_amount_minor, fx_rate,
          bank_account_id, counterparty_kind, counterparty_id, reference_kind, reference_value,
          status, source, journal_entry_id, reversal_entry_id, reversed_at, idempotency_key,
          created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      paymentId,
      ctx.workspaceId,
      plan.direction,
      plan.date,
      plan.amountMinor,
      plan.currency,
      plan.baseAmountMinor,
      plan.fx === null ? null : plan.fx.rate,
      plan.bank.id,
      plan.counterpartyKind,
      plan.counterpartyId,
      plan.reference.kind === 'none' ? null : plan.reference.kind,
      plan.reference.value,
      input.source ?? 'manual',
      entryId,
      input.idempotencyKey,
      ctx.actor,
      ctx.clock.now(),
    );
}

function writeAllocationRow(ctx: WorkspaceContext, paymentId: string, row: PlannedRow, entryId: string | null): void {
  ctx.store.db
    .prepare(
      `INSERT INTO payment_allocation
         (id, payment_id, workspace_id, target_kind, target_id, amount_minor,
          payment_amount_minor, base_amount_minor, skonto_minor,
          skonto_vat_minor, writeoff_minor, tax_base_minor, tax_amount_minor, recognized_at,
          journal_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('palloc'),
      paymentId,
      ctx.workspaceId,
      row.targetKind,
      row.targetId,
      row.allocatedMinor,
      row.paymentAmountMinor,
      row.cashBaseMinor,
      row.skontoMinor,
      row.skontoVatMinor,
      row.writeOffMinor,
      row.taxBaseMinor,
      row.taxAmountMinor,
      row.recognizedAt,
      entryId,
      ctx.clock.now(),
    );
}

/** Recompute every touched document's derived status from the allocations that now exist. */
function applyDocumentStatuses(ctx: WorkspaceContext, rows: PlannedRow[]): void {
  for (const row of rows) {
    if (row.targetKind !== 'document') continue;
    const doc = readDocRow(ctx, row.targetId);
    if (doc === undefined) continue;
    const settled = settledMinor(ctx, row.targetKind, row.targetId);
    writeDocumentStatus(ctx, doc, derivedStatus(ctx, row.targetId, settled, doc.total_minor));
    // D78: an allocation against a CREDIT NOTE (a refund payout) shrinks how much of its invoice
    // that credit still offsets, so the invoice's own derived status is re-run at the same choke
    // point: an invoice settled by payment-plus-credit re-opens the moment its relief is paid out
    // in cash instead.
    if (doc.type === 'credit_note' && doc.credited_document_id !== null) {
      refreshSettledByCredit(ctx, doc.credited_document_id);
    }
  }
}

/**
 * The document read models a write returns.
 *
 * This is the whole of the stale-view prevention the design leans on: the surface that posted
 * renders THIS payload instead of re-fetching, so there is no second read to miss and no re-probe
 * keyed on an id that did not change.
 */
function documentEcho(ctx: WorkspaceContext, row: PlannedRow) {
  const doc = readDocRow(ctx, row.targetId);
  const settled = doc === undefined ? 0 : settledMinor(ctx, row.targetKind, row.targetId);
  return {
    id: row.targetId,
    number: doc?.number ?? row.number,
    status: doc?.status ?? row.resultingStatus,
    grossMinor: doc?.total_minor ?? row.grossMinor,
    paidMinor: settled,
    openMinor: (doc?.total_minor ?? row.grossMinor) - settled,
  };
}

/**
 * The vendor-bill twin of `documentEcho`, and it is a SEPARATE field on every response rather than a
 * row inside `documents`.
 *
 * A caller that reads `documents[0].number` and gets a vendor bill's supplier reference has been
 * handed one kind of thing under another kind's name, and the Studio's document surface would link to
 * `/documents/<a bill id>`. The two lists are named for what is in them.
 *
 * `status` is A17's DERIVED word, read through A17's own rule. Nothing is written to the bill.
 */
function vendorBillEchoRow(ctx: WorkspaceContext, row: PlannedRow) {
  const settled = settledMinor(ctx, row.targetKind, row.targetId);
  return {
    id: row.targetId,
    vendorReference: row.number,
    status: displayStatus('posted', settlementStatusFor(row.grossMinor, settled)),
    payableMinor: row.grossMinor,
    paidMinor: settled,
    openMinor: row.grossMinor - settled,
  };
}

/**
 * The dunning-fee twin of `documentEcho`/`vendorBillEchoRow` (critic C3). This capability has no
 * Studio surface and no `suggestPaymentMatches` candidates (D46: per-surface UX belongs to the final
 * UX pass), so the MCP response IS the whole feedback channel: before this echo, a fee-only payment
 * answered `documents: [] vendorBills: []`, indistinguishable from a payment that settled nothing at
 * all. `mapAllocation` already builds `dunningFeeLabel` for `get_payment`; this is the same label on
 * the write path, so a preview, a write and a read-back never disagree about what the fee is called.
 */
function dunningFeeEchoRow(ctx: WorkspaceContext, row: PlannedRow) {
  const settled = settledMinor(ctx, row.targetKind, row.targetId);
  return {
    id: row.targetId,
    number: row.number,
    feeMinor: row.grossMinor,
    paidMinor: settled,
    openMinor: row.grossMinor - settled,
  };
}

/** Split the planned rows into the echoes a response carries, so no list lies about itself. */
function echoes(ctx: WorkspaceContext, rows: readonly PlannedRow[]) {
  return {
    documents: rows.filter((r) => r.targetKind === 'document').map((r) => documentEcho(ctx, r)),
    vendorBills: rows.filter((r) => r.targetKind === 'vendor_bill').map((r) => vendorBillEchoRow(ctx, r)),
    dunningFees: rows.filter((r) => r.targetKind === 'dunning_fee').map((r) => dunningFeeEchoRow(ctx, r)),
  };
}

// --- allocatePayment ------------------------------------------------------------------------------

export interface AllocatePaymentInput {
  paymentId: string;
  allocations: AllocationInput[];
  /** `PAYMENT_INTENTS.allocate`. Required (P9). */
  intent?: string;
  idempotencyKey: string;
}

/**
 * Allocate a previously parked credit (Guthaben) to open items.
 *
 * There is NO ledger effect: `recordPayment` already booked the whole movement against the
 * receivable, and the credit has been sitting on that same account unallocated. Allocating it moves
 * no money, it records WHICH open items the money that already landed settles. That is why this
 * verb only inserts allocation rows and recomputes derived statuses, and why A14 §4's
 * "reclassification entry only if the initial posting used a suspense split" reduces to no entry at
 * all in this model: nothing was ever parked in a suspense account.
 *
 * The correction path is deliberately the whole payment (`reversePayment`). A14 registers no
 * un-allocate verb, so the design warns before the click rather than after.
 */
export function allocatePayment(ctx: WorkspaceContext, input: AllocatePaymentInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const intentErr = requireIntent(input.intent, PAYMENT_INTENTS.allocate);
  if (intentErr) return intentErr;
  const guard = requireString(input.paymentId, 'paymentId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['allocate_payment', input.paymentId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'allocate_payment');
  if (replayed !== undefined) return replayed;

  const payment = readPaymentRow(ctx, input.paymentId);
  if (payment === undefined) return err('not_found', { paymentId: input.paymentId });
  if (payment.status !== 'posted') return err('already_reversed', { paymentId: input.paymentId });

  const available = onAccountMinorOf(ctx, payment);
  if (available <= 0) return err('nothing_to_allocate', { paymentId: input.paymentId });

  const allocations = Array.isArray(input.allocations) ? input.allocations : [];
  if (allocations.length === 0) return err('invalid_input', { field: 'allocations' });
  for (const a of allocations) {
    if (a !== null && typeof a === 'object' && ((a.skontoMinor ?? 0) > 0 || (a.writeOffMinor ?? 0) > 0)) {
      // Both carry a LEDGER effect (an Erlösminderung under Art. 41, a receivable loss), and this
      // verb posts nothing at all. Granting either here would close a document with money the
      // journal never saw. Rejected before the transaction opens, so nothing is memoised.
      return err('unsupported', {
        field: 'allocations',
        reason: 'skonto_and_write_off_belong_to_record_payment',
        hint: 'Allocating a parked credit moves no money; reverse and re-record to grant a discount.',
      });
    }
  }

  // THE TARGET SIDE MUST MATCH THE SIDE THE PAYMENT'S OWN ENTRY BOOKED (A17-C1). `buildLegs` and
  // the mixed-target guard both live on the POSTING path; this verb posts nothing, so without this
  // check the two rules are bypassed by splitting the work across two calls: a payment whose entry
  // parked the cash on 1100 Debitoren could "settle" a vendor bill, leaving the bill reporting
  // `paid` while 2000 Kreditoren still carries it. The fact consulted is the JOURNAL, not
  // `counterparty_kind`: the caller-supplied kind is exactly the label this module already decided
  // not to trust when it made the leg side follow the target. Existing allocations match the
  // entry's side because `planPayment` refuses a side contradiction at RECORD time too (A17-R1,
  // the label-versus-target guard beside the mixed-target one): the two guards together mean no
  // path, one-call or split, books a settlement against the wrong side of the books.
  const entrySide = entrySettlementSide(ctx, payment.journal_entry_id);
  // A payment whose entry settled NO recognised allocation control account (neither 1100 Debitoren
  // nor 2000 Kreditoren) has no open item on the books for any target to clear, so nothing may be
  // allocated against it. Before D95 an allocatable parked credit (`available > 0`) ALWAYS sat on
  // 2000 or 1100, so this was unreachable; the D95 employee-payable reimbursement is the first path
  // that parks a credit OFF a control account (on 2260). That liability is cleared solely by E02's
  // approve->reimburse cycle, never by an A16 allocation. Refused here so `entrySide === null` can
  // never mean "no restriction, allow": a 2260 credit can otherwise mark a 2000 bill (or a 1100
  // invoice) settled in the sub-ledger while the control account it never touched stays open, and
  // the sub-ledger and the GL diverge. On the two shipped sides entrySide is 'payable' /
  // 'receivable' / 'mixed' and this is inert, so ordinary allocation is byte-for-byte unchanged.
  if (entrySide === null) {
    return err('allocation_target_side_mismatch', {
      field: 'allocations',
      paymentId: payment.id,
      entrySide: null,
      reason:
        'this payment settled neither 1100 Debitoren nor 2000 Kreditoren: an employee-payable ' +
        'reimbursement is cleared by its own reimburse cycle and can never be allocated against a ' +
        'vendor bill or a customer document',
    });
  }
  for (const [i, a] of allocations.entries()) {
    if (a === null || typeof a !== 'object') continue;
    const kind =
      a.targetKind ??
      (a.vendorBillId !== undefined ? 'vendor_bill' : a.dunningItemId !== undefined ? 'dunning_fee' : 'document');
    const requiredSide = kind === 'vendor_bill' ? 'payable' : 'receivable';
    if (entrySide !== null && entrySide !== requiredSide) {
      // Three sides, three sentences (A17-R4): a `mixed` entry must not be described as either
      // clean side, or the prose contradicts the refusal it accompanies.
      const reason =
        entrySide === 'receivable'
          ? 'this payment posted against 1100 Debitoren: it can settle customer documents, never a vendor bill'
          : entrySide === 'payable'
            ? 'this payment posted against 2000 Kreditoren: it can settle vendor bills, never a customer document'
            : 'this payment entry moved BOTH 1100 Debitoren and 2000 Kreditoren, which no settlement plan produces: nothing may be allocated against it';
      return err('allocation_target_side_mismatch', {
        field: `allocations[${i}]`,
        paymentId: payment.id,
        targetKind: kind,
        entrySide,
        reason,
      });
    }
  }

  const replan: RecordPaymentInput = {
    direction: payment.direction,
    date: payment.date,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    bankAccountId: payment.bank_account_id,
    allocations,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: input.idempotencyKey,
  };
  if (payment.counterparty_kind !== null) replan.counterpartyKind = payment.counterparty_kind;
  // The replan RESOLVES where a fresh input is refused, and the asymmetry is deliberate. This id is
  // already on a posted, frozen row: refusing it would strand a parked Guthaben whose counterparty was
  // merged, leaving a credit that can never be allocated. Resolving redirects a read of an append-only
  // fact without rewriting it, which is what `resolveContactRef` exists for. Nothing about the payment
  // row is updated here (only allocation rows are written), so no frozen column moves.
  if (payment.counterparty_id !== null) {
    replan.counterpartyId = resolveContactRef(ctx, payment.counterparty_id)?.id ?? payment.counterparty_id;
  }

  const planned = planPayment(ctx, replan, {
    existingAllocatedMinor: payment.amount_minor - available,
  });
  if (!planned.ok) return planned.error;
  const plan = planned.plan;
  if (plan.blocker !== null) return err(String(plan.blocker.code), plan.blocker);

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'allocate_payment', () => {
      for (const row of plan.rows) writeAllocationRow(ctx, payment.id, row, payment.journal_entry_id);
      applyDocumentStatuses(ctx, plan.rows);
      ctx.audit.record({
        entityKind: 'payment',
        entityId: payment.id,
        action: 'allocate',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });
      const after = ctx.store.db
        .prepare('SELECT * FROM payment WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, payment.id) as PaymentRow;
      return ok({
        paymentId: payment.id,
        entryId: payment.journal_entry_id,
        onAccountMinor: onAccountMinorOf(ctx, after),
        ...echoes(ctx, plan.rows),
      });
    }),
  );
}

// --- reversePayment -------------------------------------------------------------------------------

export interface ReversePaymentInput {
  paymentId: string;
  date?: string;
  /** `PAYMENT_INTENTS.reverse`. Required (P9). */
  intent?: string;
  idempotencyKey: string;
}

/**
 * Correct a payment the only way an append-only ledger permits: post its reversal (§H-AUDIT).
 *
 * A payment is reversed WHOLE. Its allocations stay on disk exactly as they were written; they stop
 * counting because `settledMinor` only sums the allocations of posted payments, so every document
 * it touched returns to precisely the open amount it had before, derived rather than restored from
 * a remembered figure.
 */
export function reversePayment(ctx: WorkspaceContext, input: ReversePaymentInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const intentErr = requireIntent(input.intent, PAYMENT_INTENTS.reverse);
  if (intentErr) return intentErr;
  const guard =
    requireString(input.paymentId, 'paymentId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['reverse_payment', input.paymentId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'reverse_payment');
  if (replayed !== undefined) return replayed;

  const payment = readPaymentRow(ctx, input.paymentId);
  if (payment === undefined) return err('not_found', { paymentId: input.paymentId });
  if (payment.status === 'reversed') {
    return err('already_reversed', { paymentId: input.paymentId, reversalEntryId: payment.reversal_entry_id });
  }
  if (payment.journal_entry_id === null) return err('not_posted', { paymentId: input.paymentId });

  const date = input.date ?? ctx.clock.now().slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  const targets = ctx.store.db
    .prepare('SELECT DISTINCT target_kind, target_id FROM payment_allocation WHERE workspace_id = ? AND payment_id = ?')
    .all(ctx.workspaceId, input.paymentId) as { target_kind: AllocationTargetKind; target_id: string }[];

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'reverse_payment', () => {
      const reversed = reverseEntry(ctx, {
        entryId: payment.journal_entry_id as string,
        date,
        idempotencyKey: JSON.stringify(['payment_reversal', payment.id]),
      });
      if (!reversed.ok) throw new PaymentAbort(reversed);
      const reversalId = reversed.reversalId as string;

      // The ONLY update a posted payment ever takes, and the schema's trigger allows exactly this
      // one: the status word plus its reversal stamp. Every money and identity column is frozen.
      ctx.store.db
        .prepare(
          "UPDATE payment SET status = 'reversed', reversal_entry_id = ?, reversed_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(reversalId, date, ctx.workspaceId, payment.id);

      // E02 (D95): a reimbursement payment settled 2260 employee-payable through the payableAccountId
      // override with NO allocation to its claim, so nothing in the allocation-unwind below reopens
      // the claim. Reverting it here, INSIDE this tx, is what keeps the claim status in step with the
      // 2260 liability the reversing entry just reopened: `reimbursed -> approved`. A no-op for every
      // ordinary payment (no claim references it). A throw here rolls the whole reversal back.
      revertReimbursedClaimsForPayment(ctx, payment.id);

      const documents: { id: string; number: string | null; status: string; grossMinor: number; paidMinor: number; openMinor: number }[] = [];
      // A vendor bill needs NO unwinding step at all, and that is the payoff of deriving its
      // settlement status rather than storing one: `settledOnVendorBill` sums the allocations of
      // POSTED payments only, so the moment this payment's status flips to `reversed` every bill it
      // touched reads `unpaid` again. There is nothing to restore and nothing that can be forgotten.
      // The bills are still REPORTED, so a caller can see what re-opened.
      const vendorBills: { id: string; vendorReference: string | null; status: string; payableMinor: number; paidMinor: number; openMinor: number }[] = [];
      for (const t of targets) {
        if (t.target_kind === 'vendor_bill') {
          const bill = ctx.store.db
            .prepare('SELECT id, vendor_reference, payable_minor FROM vendor_bill WHERE workspace_id = ? AND id = ?')
            .get(ctx.workspaceId, t.target_id) as
            | { id: string; vendor_reference: string | null; payable_minor: number }
            | undefined;
          if (bill === undefined) continue;
          const settled = settledMinor(ctx, t.target_kind, t.target_id);
          vendorBills.push({
            id: bill.id,
            vendorReference: bill.vendor_reference,
            status: displayStatus('posted', settlementStatusFor(bill.payable_minor, settled)),
            payableMinor: bill.payable_minor,
            paidMinor: settled,
            openMinor: bill.payable_minor - settled,
          });
          continue;
        }
        if (t.target_kind !== 'document') continue;
        const doc = readDocRow(ctx, t.target_id);
        if (doc === undefined) continue;
        // Recomputed, not restored: the allocations of a reversed payment simply stop counting.
        const settled = settledMinor(ctx, t.target_kind, t.target_id);
        writeDocumentStatus(ctx, doc, derivedStatus(ctx, t.target_id, settled, doc.total_minor));
        // D78: reversing a refund payout restores the credit note's offset, so the credited
        // invoice's status is re-derived exactly as the allocation write derived it.
        if (doc.type === 'credit_note' && doc.credited_document_id !== null) {
          refreshSettledByCredit(ctx, doc.credited_document_id);
        }
        const after = readDocRow(ctx, t.target_id);
        documents.push({
          id: t.target_id,
          number: after?.number ?? null,
          status: after?.status ?? doc.status,
          grossMinor: doc.total_minor,
          paidMinor: settled,
          openMinor: doc.total_minor - settled,
        });
      }

      ctx.audit.record({
        entityKind: 'payment',
        entityId: payment.id,
        action: 'reverse',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });

      return ok({ paymentId: payment.id, reversalEntryId: reversalId, reversedAt: date, documents, vendorBills });
    }),
  );
}

// --- Reads ----------------------------------------------------------------------------------------

function readPaymentRow(ctx: WorkspaceContext, id: string): PaymentRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM payment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as PaymentRow | undefined;
}

function mapPayment(ctx: WorkspaceContext, row: PaymentRow) {
  const allocations = ctx.store.db
    .prepare('SELECT * FROM payment_allocation WHERE workspace_id = ? AND payment_id = ? ORDER BY rowid')
    .all(ctx.workspaceId, row.id) as AllocationRow[];
  const allocatedMinor = allocations.reduce((n, a) => n + a.payment_amount_minor, 0);
  const bank = ctx.store.db
    .prepare('SELECT number, name FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { number: string; name: string } | undefined;
  // `get_payment` and `list_payments` report WHO THE MONEY IS WITH TODAY, which after a merge is the
  // survivor and not the retired duplicate the frozen column still names. No `mergedFrom` is added to
  // this block on purpose: the caller passed a `paymentId`, so nothing they asked for was redirected,
  // and the counterparty is derived data rather than an echo of their input. `customer_balance`, where
  // a caller DOES pass a contact id and can get a different one back, reports the redirect explicitly.
  const party = resolveContactRef(ctx, row.counterparty_id);
  return {
    id: row.id,
    direction: row.direction,
    date: row.date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    baseAmountMinor: row.base_amount_minor,
    bankAccount: { id: row.bank_account_id, number: bank?.number ?? null, label: bank?.name ?? null },
    counterparty:
      party === null ? null : { kind: row.counterparty_kind, id: party.id, name: party.name },
    reference:
      row.reference_value === null
        ? null
        : {
            kind: row.reference_kind,
            value: row.reference_value,
            display: formatReference((row.reference_kind ?? 'free_text') as ReferenceKind, row.reference_value),
          },
    status: row.status,
    source: row.source,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    reversedAt: row.reversed_at,
    allocatedMinor,
    onAccountMinor: row.amount_minor - allocatedMinor,
    allocations: allocations.map((a) => mapAllocation(ctx, a)),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapAllocation(ctx: WorkspaceContext, a: AllocationRow) {
  const doc = a.target_kind === 'document' ? readDocRow(ctx, a.target_id) : undefined;
  // A bill's recognisable label is the SUPPLIER's own invoice number: A17 assigns no number of its
  // own, because the document a Kreditor is identified by was written by somebody else.
  const bill =
    a.target_kind === 'vendor_bill'
      ? (ctx.store.db
          .prepare('SELECT vendor_reference FROM vendor_bill WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, a.target_id) as { vendor_reference: string | null } | undefined)
      : undefined;
  // A booked fee's recognisable label, the SAME one `readTarget` showed before the payment posted:
  // shared through `dunningFeeLabel` so a preview and its later `get_payment` read never disagree.
  const feeItem =
    a.target_kind === 'dunning_fee'
      ? (ctx.store.db
          .prepare('SELECT number, level FROM dunning_item WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, a.target_id) as { number: string | null; level: number } | undefined)
      : undefined;
  return {
    id: a.id,
    targetKind: a.target_kind,
    targetId: a.target_id,
    targetNumber:
      doc?.number ?? bill?.vendor_reference ?? (feeItem === undefined ? null : dunningFeeLabel(feeItem.number, feeItem.level)),
    amountMinor: a.amount_minor,
    paymentAmountMinor: a.payment_amount_minor,
    baseAmountMinor: a.base_amount_minor,
    skontoMinor: a.skonto_minor,
    skontoVatMinor: a.skonto_vat_minor,
    writeoffMinor: a.writeoff_minor,
    taxBaseMinor: a.tax_base_minor,
    taxAmountMinor: a.tax_amount_minor,
    recognizedAt: a.recognized_at,
    journalEntryId: a.journal_entry_id,
  };
}

export function getPayment(ctx: WorkspaceContext, input: { paymentId: string }): Result {
  const guard = requireString(input.paymentId, 'paymentId');
  if (guard) return guard;
  const row = ctx.store.db
    .prepare('SELECT * FROM payment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.paymentId) as PaymentRow | undefined;
  if (row === undefined) return err('not_found', { paymentId: input.paymentId });
  return ok({ payment: mapPayment(ctx, row) });
}

/** The ceiling `list_payments` loads to, mirroring A10's D34 posture: load all, flag truncation. */
export const PAYMENT_LIST_CEILING = 1000;

export function listPayments(
  ctx: WorkspaceContext,
  filter: {
    direction?: string;
    status?: string;
    from?: string;
    to?: string;
    documentId?: string;
    savedViewId?: string;
  } = {},
): Result {
  // G00 has landed, so the parameter resolves instead of refusing. The same one-line seam
  // `list_documents` uses, and the reason it is one line is that G00 knows nothing about payments.
  const viewed = applySavedView(ctx, 'payment', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  const clauses = ['p.workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.direction !== undefined) {
    clauses.push('p.direction = ?');
    params.push(filter.direction);
  }
  if (filter.status !== undefined) {
    clauses.push('p.status = ?');
    params.push(filter.status);
  }
  if (filter.from !== undefined) {
    clauses.push('p.date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('p.date <= ?');
    params.push(filter.to);
  }
  if (filter.documentId !== undefined) {
    // §H-TENANT on BOTH sides of the subquery: the allocation rows are workspace-scoped too, so a
    // foreign document id can never widen the outer result.
    clauses.push(
      'p.id IN (SELECT a.payment_id FROM payment_allocation a WHERE a.workspace_id = ? AND a.target_id = ?)',
    );
    params.push(ctx.workspaceId, filter.documentId);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT p.* FROM payment p WHERE ${clauses.join(' AND ')} ORDER BY p.date DESC, p.rowid DESC LIMIT ?`,
    )
    .all(...params, PAYMENT_LIST_CEILING + 1) as PaymentRow[];
  const truncated = rows.length > PAYMENT_LIST_CEILING;
  const payments = (truncated ? rows.slice(0, PAYMENT_LIST_CEILING) : rows).map((r) => mapPayment(ctx, r));
  return ok({ payments, truncated, total: payments.length, ceiling: PAYMENT_LIST_CEILING });
}

/**
 * Set the write-off threshold (owner decision P4: configurable, default CHF 1.00).
 *
 * This governs ONE thing: whether the surface may offer a one-click "Differenz ausbuchen" for a
 * residual. It never limits what may be written off, because a real Debitorenverlust is larger than
 * a Rappen and has to stay recordable when it is stated deliberately.
 *
 * It is a product setting and not a statutory one. In particular it is NOT a 5-Rappen rounding
 * rule: no rounding provision exists in the MWSTG, the WZG or the MünzV, and the 0.05 floor is a
 * consequence of the 1-Rappen coin's withdrawal in 2007, so nothing in A14 rounds a booked figure.
 */
export function setWriteOffThreshold(
  ctx: WorkspaceContext,
  input: { thresholdMinor: number; idempotencyKey: string },
): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isNonNegativeMinor(input.thresholdMinor)) {
    return err('invalid_input', { field: 'thresholdMinor' });
  }
  return ctx.store.rememberIdempotent(
    ctx.workspaceId,
    input.idempotencyKey,
    'set_write_off_threshold',
    () => {
      ctx.store.db
        .prepare(
          `INSERT INTO payment_config (workspace_id, write_off_threshold_minor) VALUES (?, ?)
             ON CONFLICT (workspace_id) DO UPDATE SET write_off_threshold_minor = excluded.write_off_threshold_minor`,
        )
        .run(ctx.workspaceId, input.thresholdMinor);
      return ok({ writeOffThresholdMinor: input.thresholdMinor });
    },
  );
}

/** What a document's payment panel needs: the open amount, and every payment that touched it. */
export function documentSettlement(ctx: WorkspaceContext, documentId: string) {
  const doc = readDocRow(ctx, documentId);
  if (doc === undefined) return null;
  const paidMinor = settledMinor(ctx, 'document', documentId);
  return {
    id: doc.id,
    number: doc.number,
    status: doc.status,
    grossMinor: doc.total_minor,
    paidMinor,
    openMinor: doc.total_minor - paidMinor,
  };
}

export { readDocRow as readDocumentRow, settledMinor, SETTLEABLE_STATUSES };
export type { DocRow };
