/**
 * The A18 read-model types, mirrored from `list_payable` / `get_payment_batch` / `list_bank_accounts`.
 *
 * Not invented shapes: every field here is one `pain001-actions.ts`/`bank-actions.ts` (via A19)
 * actually answers with, read straight off `core/banking/pain001.ts`. `asArray` is the same defensive
 * cast `Payments/model.ts` uses: a transport hiccup or an unexpected shape never crashes the render.
 */

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** One row of `list_payable`: an A17 open item, plus what A18 needs before it can be batched. */
export interface PayableItem {
  billId: string;
  vendorId: string;
  vendorName: string | null;
  currency: string;
  amountMinor: number;
  dueDate: string | null;
  vendorReference: string | null;
  hasCreditorProfile: boolean;
  creditorIban: string | null;
  creditorIbanMasked: string | null;
  isQrIban: boolean | null;
  referenceKind: 'qrr' | 'scor' | 'free_text' | 'none';
  referenceValid: boolean;
  batchable: boolean;
  alreadyBatchedInto: string | null;
}

/** One line of a batch, `get_payment_batch`'s / `create_payment_batch`'s own echo. */
export interface BatchItemView {
  id: string;
  vendorBillId: string;
  vendorId: string;
  vendorName: string | null;
  amountMinor: number;
  currency: string;
  creditorIban: string;
  creditorIbanMasked: string;
  isQrIban: boolean;
  referenceKind: 'qrr' | 'scor' | 'none';
  postedPaymentId: string | null;
}

export type BatchStatus = 'draft' | 'generated' | 'paid' | 'discarded';

export interface BatchView {
  id: string;
  bankAccountId: string;
  executionDate: string;
  status: BatchStatus;
  ctrlSumMinor: number | null;
  nbOfTxs: number | null;
  msgId: string | null;
  /** C3: the member seat that created the batch, from `payment_batch.created_by`. Null when unnamed. */
  createdBy: string | null;
  createdAt: string;
  items: BatchItemView[];
}

/** The slice of A19's `BankAccountView` this surface's debtor-account picker needs. */
export interface DebtorAccountOption {
  id: string;
  name: string;
  iban: string;
  receiveOnly: boolean;
  archived: boolean;
  /** The account's currency (A19 `BankAccountView.currency`): a batch debits an account in the bills' currency. */
  currency?: string;
}

/** A batch's own selectable debtor accounts: not archived, not receive-only (a QR-IBAN). */
export function debtorEligible(a: DebtorAccountOption): boolean {
  return !a.archived && !a.receiveOnly;
}

/** A payable row a batch can take right now: batchable currency, an IBAN on file, not in a batch already. */
export function payableNow(item: PayableItem): boolean {
  return item.batchable && item.hasCreditorProfile && item.alreadyBatchedInto === null;
}

/**
 * F-03 (J3.4): the bills due by `dueBy` (ISO date), pre-selected for the batch. A batch is one
 * currency: the selection takes the BASE currency when any due bill is in it (the books' own
 * currency is the batch a Swiss KMU runs first), else the currency of the earliest-due payable
 * bill, and every payable bill in that currency due by the date; the rest stay unticked and the
 * person adds them by hand.
 */
export function dueBillIds(items: readonly PayableItem[], dueBy: string, baseCurrency = 'CHF'): string[] {
  const due = items
    .filter((i) => payableNow(i) && i.dueDate !== null && i.dueDate <= dueBy)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const first = due[0];
  if (first === undefined) return [];
  const currency = due.some((i) => i.currency === baseCurrency) ? baseCurrency : first.currency;
  return due.filter((i) => i.currency === currency).map((i) => i.billId);
}

/**
 * F-03 (J3.4): the debit account for bills in `currency`: the first eligible account IN that
 * currency, else NOTHING. Measured on the golden ledger: the EUR account was offered first and
 * became the default for CHF bills.
 *
 * Critic F4 (2026-09-05): there is no any-currency fallback, and the engine does NOT refuse a
 * mismatch. `create_payment_batch` checks the account for `archived` and `receiveOnly` only, and a
 * CHF account settling a EUR bill through the bank's own conversion is legitimate (the orchestrator
 * ruled no engine change). So the Studio only stops CHOOSING such an account silently: with no
 * account in the batch's currency the select shows the `needsBankAccount` note and Generate stays
 * disabled until a person picks one on purpose ("hidden or disabled, never shown and then rejected").
 */
export function defaultDebitAccountId(accounts: readonly DebtorAccountOption[], currency: string): string {
  return accounts.filter(debtorEligible).find((a) => a.currency === currency)?.id ?? '';
}

/** The sum of the currently ticked payable items, in Rappen. Zero-length selection sums to zero. */
export function selectedTotalMinor(items: readonly PayableItem[], selected: ReadonlySet<string>): number {
  return items.filter((i) => selected.has(i.billId)).reduce((n, i) => n + i.amountMinor, 0);
}

/** A data: URI for the generated file, so the browser's own "Save As" downloads it with no server. */
export function xmlDownloadHref(base64: string): string {
  return `data:application/xml;base64,${base64}`;
}
