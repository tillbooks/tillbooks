/**
 * The A14 read-model types, mirrored from the engine's own responses.
 *
 * These are NOT invented shapes. Every field here appears in
 * `test/fixtures/payment-read-model.fixture.json`, which `test/payments/read-model-fixture.test.mjs`
 * pins to the live engine, keys and kinds. The design states the rule that closes this product's
 * most expensive defect class: **no affordance may be designed on a field that is not in the
 * read-model contract table** (§6). Accounts once offered only Delete because `inUse` was never in
 * the payload, and three VAT consumers rendered empty because they read a key `vat_codes` does not
 * answer with. Each time a green test suite proved nothing, because the fixture carried the same
 * wrong keys as the consumer.
 *
 * So the types below are declared against the fixture, and `payments-fixture.test.mjs` pins the
 * Studio's own fixtures back to the live engine. A field that is renamed on the engine side goes red
 * there rather than silently rendering `undefined` here.
 *
 * One spelling trap worth naming, because it will bite whoever types it from memory: an allocation
 * carries `writeoffMinor` (lower-case o) while a preview row carries `writeOffMinor` (capital O).
 * That is the engine's spelling on both, verified against the fixture, and NOT a typo to "fix" here.
 */

/** A resolved account, always number AND label: no raw id ever reaches the screen (D32). */
export interface BankAccountRef {
  id: string;
  number: string;
  label: string;
}

/** Whose money it is. A Guthaben always has an owner, so this is what makes a credit findable. */
export interface CounterpartyRef {
  kind: 'customer' | 'supplier';
  id: string;
  name: string;
}

/** A classified payment reference. `display` is the engine's grouped rendering, never re-derived. */
export interface ReferenceRef {
  kind: string;
  value: string | null;
  display: string | null;
  /** Present on the matching read model: a failed check digit is a typo, never a ranked match. */
  valid?: boolean;
  error?: string | null;
  status?: string | null;
}

/** One allocation on a posted payment (`get_payment`, `list_payments`). */
export interface PaymentAllocation {
  id: string;
  targetKind: string;
  targetId: string;
  targetNumber: string;
  amountMinor: number;
  paymentAmountMinor: number;
  baseAmountMinor: number;
  skontoMinor: number;
  skontoVatMinor: number;
  /** The engine's spelling: lower-case `o`. See the header note. */
  writeoffMinor: number;
  taxBaseMinor: number | null;
  taxAmountMinor: number | null;
  recognizedAt: string | null;
  journalEntryId: string;
}

/** A payment as `list_payments` and `get_payment` return it. */
export interface Payment {
  id: string;
  direction: 'incoming' | 'outgoing';
  date: string;
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  bankAccount: BankAccountRef;
  counterparty: CounterpartyRef | null;
  reference: ReferenceRef;
  /** The status set is exactly `posted` and `reversed`: a credit is a CHIP, never a status word. */
  status: 'posted' | 'reversed';
  source: string;
  journalEntryId: string;
  reversalEntryId: string | null;
  reversedAt: string | null;
  allocatedMinor: number;
  onAccountMinor: number;
  allocations: PaymentAllocation[];
  /** C3: the member seat that recorded the payment, from `payment.created_by`. Null on a legacy row. */
  createdBy: string | null;
  createdAt: string;
}

/** One ranked open item from `suggest_payment_matches`. */
export interface Candidate {
  targetKind: string;
  targetId: string;
  number: string;
  contactId: string | null;
  contactName: string | null;
  currency: string;
  dueDate: string | null;
  daysOverdue: number | null;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  status: string;
  reference: ReferenceRef;
  /**
   * The tier, or null. A candidate that fits no tier carries NO reason word at all: labelling a
   * CHF 540.00 open against a CHF 1'081.00 payment "Betrag ähnlich" would make the confidence
   * vocabulary lie, and the vocabulary being honest is its entire job (§3.2).
   */
  kind: 'exact_reference' | 'exact_amount_customer' | 'amount_tolerance' | null;
  reason: string | null;
  deltaMinor: number;
  prefillMinor: number;
  settled: boolean;
  disabledReason: string | null;
}

export interface SuggestMatches {
  reference: ReferenceRef;
  openItemCount: number;
  /** Counted separately from `openItemCount` so a ranked list never reads as a filtered one. */
  referenceMatchCount: number;
  writeOffThresholdMinor: number;
  candidates: Candidate[];
}

/** One planned settlement row from `preview_payment`. */
export interface PreviewRow {
  targetKind: string;
  targetId: string;
  number: string;
  currency: string;
  dueDate: string | null;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  allocatedMinor: number;
  paymentAmountMinor: number;
  skontoMinor: number;
  skontoVatMinor: number;
  /** The engine's spelling on a PREVIEW row: capital `O`. See the header note. */
  writeOffMinor: number;
  settlementMinor: number;
  settlementBaseMinor: number;
  resultingOpenMinor: number;
  resultingStatus: string;
  /** The residual this row leaves, offered as a one-click Ausbuchung within the threshold (P4). */
  writeOffOfferedMinor: number;
}

/** One journal leg, with the account NUMBER and its LABEL, never an id (§6 contract row). */
export interface PreviewLeg {
  accountId: string;
  accountNumber: string;
  accountLabel: string;
  debitMinor: number;
  creditMinor: number;
  taxCode?: string;
  supplyDate?: string;
}

/**
 * A domain condition that blocks POSTING but not previewing.
 *
 * This is the engine's `blocker`, surfaced under `error` on the preview response. It is the reason
 * the confirm control is disabled, and D15/C3 requires that reason to be on screen: a disabled
 * control without a visible reason is a logged defect class here.
 */
export interface PreviewBlocker {
  code: string;
  [key: string]: unknown;
}

export interface PaymentPreview {
  direction: string;
  date: string;
  amountMinor: number;
  currency: string;
  bankAccount: BankAccountRef;
  counterparty: CounterpartyRef | null;
  reference: ReferenceRef;
  allocatedMinor: number;
  onAccountMinor: number;
  /** The remainder is the ENGINE's answer, never `amount - sum(inputs)` computed here (§4 rule 3). */
  remainderMinor: number;
  baseAmountMinor: number;
  rows: PreviewRow[];
  legs: PreviewLeg[];
  istVat: { baseMinor: number; taxMinor: number; recognizedAt: string } | null;
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
  writeOffThresholdMinor: number;
  balanced: boolean;
  error: PreviewBlocker | null;
}

/**
 * What `record_payment` answers with.
 *
 * `documents[]` is the whole of the stale-view prevention (P42, defect class 1): the source surface
 * renders THIS payload instead of re-fetching, which is exactly the re-probe that once stranded
 * A10's editor on screen after a successful issue.
 */
export interface RecordPaymentResult {
  paymentId: string;
  entryId: string;
  onAccountMinor: number;
  documents: {
    id: string;
    number: string;
    status: string;
    grossMinor: number;
    paidMinor: number;
    openMinor: number;
  }[];
}

/**
 * A bank or cash account offered by S9's picker, as `list_accounts` answers it.
 *
 * NOT a `BankAccountRef`. The payments read model resolves an account to `{id, number, label}`, but
 * `list_accounts` is A01's read and it answers `name`. The picker was typed against the wrong one of
 * the two and rendered "1000 undefined" for every option: the sixth time in this repo that the
 * Studio assumed a shape the engine never sends, and the first one a fixture could not catch,
 * because the hand-written fixture set BOTH keys and so agreed with the bug.
 *
 * So this is declared against `list-accounts.fixture.json`, which
 * `test/payments/studio-payments-fixture.test.mjs` pins to the live `listAccounts`, and
 * `Payments.test.tsx` asserts the fixture is assignable to this type. A rename on either side goes
 * red rather than rendering `undefined` on screen.
 */
export interface BankAccountOption {
  id: string;
  number: string;
  /** A01's spelling. The payments read model's `BankAccountRef` says `label`: they are not the same. */
  name: string;
  type: string;
  archived: boolean;
}

/** Narrow an unknown wire value to an array without trusting the cast that produced it. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The label for a payment's allocation column: one document number, or a count.
 *
 * A count rather than a truncated list, because "R-2026-0183, R-2026-0184, ..." in a fixed column
 * reads as data loss while "3 Belege" reads as a summary that the expanded row completes.
 */
export function allocationSummary(payment: Payment): { kind: 'none' | 'one' | 'many'; value: string } {
  const allocations = asArray<PaymentAllocation>(payment.allocations);
  if (allocations.length === 0) return { kind: 'none', value: '' };
  if (allocations.length === 1) return { kind: 'one', value: allocations[0].targetNumber };
  return { kind: 'many', value: String(allocations.length) };
}
