/**
 * The A17 read-model types and the pure helpers the Kreditoren surface renders through.
 *
 * NOTHING HERE IS INVENTED. Every field below appears in the fixtures beside this file, and
 * `test/purchase/studio-bills-fixture.test.mjs` pins those fixtures to the live engine VALUE for
 * value and asserts the key set exactly. That pairing is what stops the defect family this repo has
 * shipped six times, "the Studio assumed a shape the engine never sends": a picker once rendered
 * "1000 undefined" in a live browser with its unit test green, because the hand-written fixture was
 * more generous than the engine and therefore agreed with the bug.
 *
 * THE STATUS IS THE ENGINE'S WORD, NOT A DERIVATION. `displayStatus` arrives on every row, folded in
 * the engine from the stored lifecycle and the derived settlement. The Studio renders it and never
 * computes it, for the reason A16's `direction` field exists: a fact the engine holds must not be
 * re-inferred by a consumer, because the inference is exact and fragile and gets made backwards once.
 *
 * NO MONEY ARITHMETIC ANYWHERE IN THIS DIRECTORY. The net/tax/gross split in the editor is
 * `vat_preview`'s answer, and the open amount on the list is the engine's `openMinor`. A17 sits on the
 * money path, and A14 §4 rule 3's line ("the GUI holds raw typed input and nothing else") applies to
 * the purchase side unchanged.
 */

/** The lifecycle the engine stores. Mirrors `VENDOR_BILL_STATUSES`. */
export const VENDOR_BILL_STATUSES = ['draft', 'posted', 'void'] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

/** The settlement half, which the engine DERIVES per read. Mirrors `VENDOR_BILL_SETTLEMENT_STATUSES`. */
export const VENDOR_BILL_SETTLEMENT_STATUSES = ['unpaid', 'partly_paid', 'paid'] as const;
export type VendorBillSettlementStatus = (typeof VENDOR_BILL_SETTLEMENT_STATUSES)[number];

/** The five words a row can show. Mirrors `VENDOR_BILL_DISPLAY_STATUSES`. */
export const VENDOR_BILL_DISPLAY_STATUSES = ['draft', 'posted', 'partly_paid', 'paid', 'void'] as const;

/** One vendor bill, exactly as `list_vendor_bills` and `get_vendor_bill` return it. */
export interface VendorBill {
  id: string;
  vendorId: string;
  vendorName: string | null;
  billDate: string;
  dueDate: string | null;
  supplyDate: string | null;
  vendorReference: string | null;
  currency: string;
  amountIsGross: boolean;
  netMinor: number;
  taxCode: string | null;
  taxAmountMinor: number;
  grossMinor: number;
  payableMinor: number;
  paidMinor: number;
  openMinor: number;
  baseNetMinor: number | null;
  baseTaxMinor: number | null;
  baseGrossMinor: number | null;
  basePayableMinor: number | null;
  baseOpenMinor: number | null;
  fxRate: string | null;
  expenseAccountId: string;
  expenseAccountNumber: string | null;
  expenseAccountName: string | null;
  costCenterId: string | null;
  projectId: string | null;
  receiptRef: string | null;
  status: VendorBillStatus;
  settlementStatus: VendorBillSettlementStatus;
  displayStatus: string;
  entryId: string | null;
  reversalEntryId: string | null;
  voidReason: string | null;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
  createdAt: string;
  postedAt: string | null;
}

/** What `list_vendor_bills` answers with. */
export interface BillsView {
  asOf: string;
  bills: VendorBill[];
  truncated: boolean;
  total: number;
  baseCurrency: string;
  boundariesDays: number[];
  bucketKeys: string[];
  bucketTotals: Record<string, number>;
  baseTotalOpenMinor: number;
  workspaceBaseTotalOpenMinor: number;
  onAccountMinor: number;
  payablesBalanceMinor: number;
  reconciled: boolean;
  reconciliationDifferenceMinor: number;
  filtered: boolean;
}

/** One option in the vendor picker, from `list_contacts`. */
export interface VendorOption {
  id: string;
  name: string;
}

/** One option in the expense-account picker, from `list_accounts`. */
export interface AccountOption {
  id: string;
  number: string;
  name: string;
  type: string;
}

/** One option in the VAT-code picker, from `vat_codes`. */
export interface TaxCodeOption {
  code: string;
  kind: string;
  label: string;
}

/** One option in the cost-centre picker, from `list_cost_centers`. */
export interface CostCenterOption {
  id: string;
  code: string;
  name: string;
}

/** One option in the project picker, from `project_list` (B03: the bill's cost dimension). */
export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

/** What `vat_preview` answers with, for the editor's live posting preview. */
export interface VatPreview {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  rateBp: number;
  kind: string;
  deductible: boolean;
  formLine: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNum(value: unknown): number | null {
  return value === null ? null : num(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse ONE bill, strictly. A missing figure makes the whole row null and the surface says so.
 *
 * A plausible zero is the one thing a payables list must never print: `CHF 0.00` open on a bill that
 * is in fact outstanding reads as "nothing to pay".
 */
export function parseBill(value: unknown): VendorBill | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const billDate = str(value.billDate);
  const currency = str(value.currency);
  const status = str(value.status);
  const settlementStatus = str(value.settlementStatus);
  const displayStatus = str(value.displayStatus);
  const netMinor = num(value.netMinor);
  const taxAmountMinor = num(value.taxAmountMinor);
  const grossMinor = num(value.grossMinor);
  const payableMinor = num(value.payableMinor);
  const paidMinor = num(value.paidMinor);
  const openMinor = num(value.openMinor);
  const daysOverdue = num(value.daysOverdue);
  const expenseAccountId = str(value.expenseAccountId);
  const vendorId = str(value.vendorId);
  const createdAt = str(value.createdAt);
  const bucket = str(value.bucket);
  if (
    id === null ||
    billDate === null ||
    currency === null ||
    status === null ||
    settlementStatus === null ||
    displayStatus === null ||
    netMinor === null ||
    taxAmountMinor === null ||
    grossMinor === null ||
    payableMinor === null ||
    paidMinor === null ||
    openMinor === null ||
    daysOverdue === null ||
    expenseAccountId === null ||
    vendorId === null ||
    createdAt === null ||
    bucket === null
  ) {
    return null;
  }
  if (!(VENDOR_BILL_STATUSES as readonly string[]).includes(status)) return null;
  if (!(VENDOR_BILL_SETTLEMENT_STATUSES as readonly string[]).includes(settlementStatus)) return null;
  return {
    id,
    vendorId,
    vendorName: str(value.vendorName),
    billDate,
    dueDate: str(value.dueDate),
    supplyDate: str(value.supplyDate),
    vendorReference: str(value.vendorReference),
    currency,
    amountIsGross: value.amountIsGross === true,
    netMinor,
    taxCode: str(value.taxCode),
    taxAmountMinor,
    grossMinor,
    payableMinor,
    paidMinor,
    openMinor,
    baseNetMinor: nullableNum(value.baseNetMinor),
    baseTaxMinor: nullableNum(value.baseTaxMinor),
    baseGrossMinor: nullableNum(value.baseGrossMinor),
    basePayableMinor: nullableNum(value.basePayableMinor),
    baseOpenMinor: nullableNum(value.baseOpenMinor),
    fxRate: str(value.fxRate),
    expenseAccountId,
    expenseAccountNumber: str(value.expenseAccountNumber),
    expenseAccountName: str(value.expenseAccountName),
    costCenterId: str(value.costCenterId),
    projectId: str(value.projectId),
    receiptRef: str(value.receiptRef),
    status: status as VendorBillStatus,
    settlementStatus: settlementStatus as VendorBillSettlementStatus,
    displayStatus,
    entryId: str(value.entryId),
    reversalEntryId: str(value.reversalEntryId),
    voidReason: str(value.voidReason),
    daysOverdue,
    overdue: value.overdue === true,
    bucket,
    createdAt,
    postedAt: str(value.postedAt),
  };
}

/** Parse the whole list response. One unparseable row makes the response null: no partial truth. */
export function parseBills(value: unknown): BillsView | null {
  if (!isObject(value) || !Array.isArray(value.bills)) return null;
  const bills: VendorBill[] = [];
  for (const raw of value.bills) {
    const bill = parseBill(raw);
    if (bill === null) return null;
    bills.push(bill);
  }
  const asOf = str(value.asOf);
  const baseCurrency = str(value.baseCurrency);
  const baseTotalOpenMinor = num(value.baseTotalOpenMinor);
  const workspaceBaseTotalOpenMinor = num(value.workspaceBaseTotalOpenMinor);
  const onAccountMinor = num(value.onAccountMinor);
  const payablesBalanceMinor = num(value.payablesBalanceMinor);
  const reconciliationDifferenceMinor = num(value.reconciliationDifferenceMinor);
  if (
    asOf === null ||
    baseCurrency === null ||
    baseTotalOpenMinor === null ||
    workspaceBaseTotalOpenMinor === null ||
    onAccountMinor === null ||
    payablesBalanceMinor === null ||
    reconciliationDifferenceMinor === null ||
    typeof value.reconciled !== 'boolean'
  ) {
    return null;
  }
  return {
    asOf,
    bills,
    truncated: value.truncated === true,
    total: num(value.total) ?? bills.length,
    baseCurrency,
    boundariesDays: Array.isArray(value.boundariesDays) ? (value.boundariesDays as number[]) : [],
    bucketKeys: Array.isArray(value.bucketKeys) ? (value.bucketKeys as string[]) : [],
    bucketTotals: isObject(value.bucketTotals) ? (value.bucketTotals as Record<string, number>) : {},
    baseTotalOpenMinor,
    workspaceBaseTotalOpenMinor,
    onAccountMinor,
    payablesBalanceMinor,
    reconciled: value.reconciled,
    reconciliationDifferenceMinor,
    filtered: value.filtered === true,
  };
}

/** Parse `vat_preview`'s answer for the editor's live split. */
export function parseVatPreview(value: unknown): VatPreview | null {
  if (!isObject(value)) return null;
  const netMinor = num(value.netMinor);
  const taxMinor = num(value.taxMinor);
  const grossMinor = num(value.grossMinor);
  const rateBp = num(value.rateBp);
  const kind = str(value.kind);
  if (netMinor === null || taxMinor === null || grossMinor === null || rateBp === null || kind === null) {
    return null;
  }
  return {
    netMinor,
    taxMinor,
    grossMinor,
    rateBp,
    kind,
    deductible: value.deductible === true,
    formLine: str(value.formLine),
  };
}

/**
 * The tax codes a PURCHASE may carry, mirroring `VENDOR_BILL_TAX_KINDS`.
 *
 * The picker offers exactly what the engine admits, so `needs_input_tax_code` cannot be produced from
 * this surface at all: an output, zero-rated or exempt code is never on the list to choose. This is
 * the same "prevent at the control" rule A19's ledger-account picker follows.
 */
export const PURCHASE_TAX_KINDS = ['input', 'import', 'reverse_charge'] as const;

export function purchaseTaxCodes(codes: readonly TaxCodeOption[]): TaxCodeOption[] {
  return codes.filter((c) => (PURCHASE_TAX_KINDS as readonly string[]).includes(c.kind));
}

/**
 * The accounts a purchase may be booked to: an expense or an asset, and never one the engine books
 * itself or a money/claims account no bill legitimately debits.
 *
 * MIRRORS `RESERVED_EXPENSE_ACCOUNTS` in `src/core/purchase/vendorBill.ts` (A17-C3), where the
 * full reasoning lives: every A14 role-map number (settlement, Skonto, write-off, FX and VAT
 * accounts, several of which pass the expense/asset type filter) plus the liquidity and claims
 * block (Kasse, Bank, Wertberichtigung Forderungen, Verrechnungssteuer-Guthaben). Re-declared,
 * never imported (the Studio does not import engine source), and held identical to the engine's
 * set by `test/purchase/studio-bills-fixture.test.mjs`: an operator should not be offered a choice
 * that comes back as a rejection.
 */
export const RESERVED_ACCOUNT_NUMBERS = [
  '1100',
  '2000',
  '3800',
  '4900',
  '2200',
  '1170',
  '1171',
  '3805',
  '3806',
  '4906',
  '1000',
  '1020',
  '1109',
  '1176',
] as const;

export function expenseAccounts(accounts: readonly AccountOption[]): AccountOption[] {
  return accounts.filter(
    (a) =>
      (a.type === 'expense' || a.type === 'asset') &&
      !(RESERVED_ACCOUNT_NUMBERS as readonly string[]).includes(a.number),
  );
}

/** A minor amount as an editable decimal string, or '' for nothing. Mirrors A14's `minorToInput`. */
export function minorToInput(minor: number | null): string {
  if (minor === null) return '';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A typed decimal string as integer Rappen, or null when it is not a number.
 *
 * Accepts the Swiss thousands apostrophe and both separators, because that is what people type. It is
 * a PARSE and not money math: the engine still computes every figure, and a null here means the
 * surface asks the engine nothing rather than guessing a zero.
 */
export function parseAmountToMinor(text: string): number | null {
  const cleaned = text.replace(/['\s]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole, frac = ''] = (negative ? cleaned.slice(1) : cleaned).split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** Today, as the engine's date shape. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
