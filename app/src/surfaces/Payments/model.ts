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
  /**
   * A39 L3: the bank line whose live decision holds this payment. Such a payment is undone on that line
   * (`reopen_bank_line`), so the surface offers the line and never a Storno that could only refuse.
   */
  bankLineId: string | null;
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

/**
 * A registered Bankkonto (A19) as `list_bank_accounts` answers it, narrowed to what the Werkbank's
 * Konto default reads. Declared against `app/src/surfaces/BankAccounts/list-bank-accounts.fixture.json`,
 * which `test/banking/studio-bank-accounts-fixture.test.mjs` pins to the live engine.
 */
export interface BankAccountLink {
  id: string;
  name: string;
  currency: string;
  /** The ledger account the Bankkonto books on: the id `record_payment` takes as `bankAccountId`. */
  ledgerAccountId: string;
  /** A QR-IBAN only ever receives money, so it is never the default for an outgoing payment. */
  receiveOnly: boolean;
  archived: boolean;
}

/**
 * The Konto a new payment defaults to, or null when TILL has to ask (D152 rule 1, infer before asking).
 *
 * The default comes from the Bankkonten, never from the chart's first cash account: the Werkbank used
 * to preselect `1000 Kassenbestand` simply because it sorts first, so an unread default booked bank
 * money on the till.
 *
 * EVERY rule runs on the Bankkonten in the books' BASE currency only, because the drawer sends no
 * currency and the engine therefore books the payment in the base currency. An EUR Bankkonto is never
 * the default for a CHF payment, however alone it is (critic F2). An unknown base currency asks.
 *
 * The answer is a LEDGER account, so Bankkonten are grouped by the ledger account they book on. A
 * ledger account can carry the payment when at least one of its Bankkonten can: any live one for an
 * incoming payment, one that is not a receive-only QR-IBAN for an outgoing one. A QR-IBAN sharing its
 * ledger account with an ordinary Bankkonto therefore changes nothing; a ledger account reached only
 * through a QR-IBAN is not a default for money going out. Exactly one ledger account that can carry
 * it is the default; none or several, and the picker asks.
 *
 * Pure, so the rule is asserted without a render. The answer is shown in the picker before anything
 * posts, and a person's own choice always wins over it.
 */
export function inferBankLedgerAccount(
  offered: readonly BankAccountOption[],
  links: readonly BankAccountLink[],
  direction: string,
  baseCurrency: string | null,
): string | null {
  if (baseCurrency === null) return null;
  const offeredIds = new Set(offered.map((account) => account.id));
  const carrying = new Set<string>();
  for (const link of links) {
    if (link.archived || link.currency !== baseCurrency || !offeredIds.has(link.ledgerAccountId)) continue;
    if (direction === 'outgoing' && link.receiveOnly) continue;
    carrying.add(link.ledgerAccountId);
  }
  return carrying.size === 1 ? [...carrying][0] : null;
}

/** The two tiers the engine says settle a match on their own (`src/core/payments/matching.ts`). */
const SETTLES_ON_ITS_OWN = new Set(['exact_reference', 'exact_amount_customer']);

/**
 * The open item an untouched payment is pre-assigned to, read off the ENGINE's answer (critic F1).
 *
 * The Studio ranks nothing of its own. `suggest_payment_matches` already decides which single item a
 * payment settles: it prefills (`prefillMinor > 0`) the one candidate of the top tier, and only when
 * that tier settles a match on its own (a matching QR reference, or the exact amount AND the customer)
 * and holds exactly one candidate. A Studio rule of its own once pre-assigned an amount coincidence
 * while the payer's QR reference named a different invoice, and an untouched drawer posted it.
 *
 * So the pre-assignment is the engine's prefill, taken only when it is complete and unambiguous:
 *
 *  - exactly one candidate carries a prefill, it is live (not settled, not disabled), and its tier
 *    settles on its own;
 *  - the prefill is the whole Betrag AND the whole open amount of that item, so the item is settled by
 *    exactly this money and nothing is left to guess (a part payment, or money left over, is the
 *    person's call);
 *  - no exact_reference candidate names a different item;
 *  - when a Gegenpartei is chosen, the item is that Gegenpartei's, and the exact-amount-and-customer
 *    tier is only taken with one chosen.
 *
 * Anything else pre-assigns nothing. `tied` lists the candidates of a top tier that settles on its
 * own but holds two or more items: the engine's own tie, shown to the person as a tie.
 */
export function enginePreAssignment(
  candidates: readonly Candidate[],
  amountMinor: number,
  counterpartyId: string,
): { target: Candidate | null; tied: Candidate[] } {
  const top = candidates.find((c) => c.kind !== null);
  const tied =
    top !== undefined && top.kind !== null && SETTLES_ON_ITS_OWN.has(top.kind)
      ? candidates.filter((c) => c.kind === top.kind)
      : [];
  const none = { target: null, tied: tied.length > 1 ? tied : [] };
  if (amountMinor <= 0) return none;

  const prefilled = candidates.filter((c) => c.prefillMinor > 0);
  if (prefilled.length !== 1) return none;
  const target = prefilled[0];
  if (target.settled || target.disabledReason !== null) return none;
  if (target.kind === null || !SETTLES_ON_ITS_OWN.has(target.kind)) return none;
  if (target.prefillMinor !== amountMinor || target.openMinor !== amountMinor) return none;
  if (candidates.some((c) => c.kind === 'exact_reference' && c.targetId !== target.targetId)) return none;
  // "The customer agrees" needs a customer: without a chosen Gegenpartei the engine cannot give this
  // tier at all, so a list claiming it is not trusted to pre-assign.
  if (target.kind === 'exact_amount_customer' && counterpartyId === '') return none;
  if (counterpartyId !== '' && target.contactId !== counterpartyId) return none;
  return { target, tied: [] };
}

/**
 * Whether a confirm may post what it was shown (critic F3, R2-F5). Only the SAME question the person
 * clicked on, only while every read the post depends on has answered THAT question
 * (`everythingAnswered`, the one predicate the button uses too), and only on a postable plan.
 */
export function confirmMayPost(
  shown: { question: string } | null,
  currentQuestion: string,
  everythingAnswered: boolean,
  postable: boolean,
): boolean {
  return shown !== null && shown.question === currentQuestion && everythingAnswered && postable;
}
