/**
 * The A16 read-model types and the pure helpers the Offene-Posten surface renders through.
 *
 * NOTHING HERE IS INVENTED. Every field below appears in the fixtures under this directory, and
 * `test/debtors/studio-open-items-fixture.test.mjs` pins those fixtures to the live engine VALUE for
 * value and asserts the key set exactly. That pairing is what stops the defect family this repo has
 * shipped six times, "the Studio assumed a shape the engine never sends": a picker once rendered
 * "1000 undefined" in a live browser with its unit test green, because the hand-written fixture was
 * more generous than the engine and therefore agreed with the bug.
 *
 * TWO FIELDS THE DESIGN HAD TO DERIVE AND NO LONGER DOES.
 *
 *  - `direction` is on the row (finding F13, landed). The design derived it from the sign of
 *    `openMinor`, which is exact and fragile; the engine now states it, so the chip reads the fact
 *    rather than inferring it. The sign is still what the AMOUNT shows, because that is the amount.
 *  - `baseBucketTotals` is on the response (finding F11, landed). Before it, the tiles could only be
 *    honest in a single-currency workspace, because `bucketTotals` sums FACE amounts and adds francs
 *    to euros in a mixed one. The tiles now render the base figure in every workspace and tie to the
 *    header total exactly, which is what D2 and D22 both asked for and could not both have.
 *
 * THE PARSERS ARE STRICT ON PURPOSE. A missing figure becomes `null`, and the surface renders its
 * error state rather than a plausible zero. `CHF 0.00` under a passing reconciliation mark is the
 * one thing this surface must never print.
 */

/** Which way the cash on a row moved. The engine's own field, never re-derived from a sign. */
export type OpenItemDirection = 'incoming' | 'outgoing';

/** One open item, exactly as `list_open_items` and `customer_balance` return it. */
export interface OpenItem {
  kind: 'document' | 'on_account';
  direction: OpenItemDirection;
  documentId: string | null;
  paymentId: string | null;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  baseOpenMinor: number;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
  /** A15's dunning state: the highest ISSUED level for this document as of the date (0 = never mahnt). */
  dunningLevel: number;
  /**
   * The BOOKED Mahngebühr still riding this document (A15), part of `openMinor`, reported separately
   * so the surface can show which part of the open amount is fee. Always 0 on an `on_account` row,
   * and always base-currency (A15 books fees in base only).
   */
  dunningFeeMinor: number;
}

/** What `list_open_items` answers with. */
export interface OpenItemsView {
  asOf: string;
  items: OpenItem[];
  boundariesDays: number[];
  /** FACE sums, mixed in a multi-currency workspace. Never rendered with a currency prefix. */
  bucketTotals: Record<string, number>;
  /** The tiles' figure: the one bucket breakdown that is an amount in a stated currency. */
  baseBucketTotals: Record<string, number>;
  totalOpenMinor: number;
  baseTotalOpenMinor: number;
  baseCurrency: string;
  currencies: string[];
  filtered: boolean;
  workspaceBaseTotalOpenMinor: number;
  receivablesBalanceMinor: number;
  reconciled: boolean;
  reconciliationDifferenceMinor: number;
}

/** One customer row from `aging_report.byCustomer`, largest debtor first. */
export interface CustomerAging {
  customerId: string | null;
  customerName: string | null;
  openItemCount: number;
  totalOpenMinor: number;
  baseTotalOpenMinor: number;
  bucketTotals: Record<string, number>;
  baseBucketTotals: Record<string, number>;
  oldestOverdueDays: number;
}

/** What `aging_report` answers with. Note it carries NO `currencies` and NO `filtered`. */
export interface AgingView {
  asOf: string;
  boundariesDays: number[];
  byBucket: Record<string, number>;
  baseByBucket: Record<string, number>;
  byCustomer: CustomerAging[];
  totalOpenMinor: number;
  baseTotalOpenMinor: number;
  baseCurrency: string;
  receivablesBalanceMinor: number;
  reconciled: boolean;
  reconciliationDifferenceMinor: number;
}

/** What `customer_balance` answers with. */
export interface CustomerBalanceView {
  customerId: string;
  customerName: string | null;
  asOf: string;
  items: OpenItem[];
  boundariesDays: number[];
  baseBucketTotals: Record<string, number>;
  totalOpenMinor: number;
  baseTotalOpenMinor: number;
  baseCurrency: string;
  currencies: string[];
  oldestOverdueDays: number;
  /**
   * The customer's net parked position, POSITIVE when they hold credit with you.
   *
   * The engine reduces `n - i.openMinor` across both parked directions, so it can come out negative
   * when you have paid a customer more than you have matched. It is rendered BY SIGN for that
   * reason, never labelled Guthaben on the assumption that a second figure beside a total is a
   * credit.
   */
  onAccountMinor: number;
}

/** What `get_aging_bucket_config` answers with. */
export interface BucketConfigView {
  boundariesDays: number[];
  /** "Never set" versus "deliberately chose these". The popover says which one it is showing. */
  configured: boolean;
  bucketKeys: string[];
}

// --- strict narrowing ------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** A `Record<string, number>` from the wire, or null if any member is not a number. */
function minorMap(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = num(raw);
    if (parsed === null) return null;
    out[key] = parsed;
  }
  return out;
}

function numberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const raw of value) {
    const parsed = num(raw);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const raw of value) {
    const parsed = str(raw);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseItem(value: unknown): OpenItem | null {
  if (!isRecord(value)) return null;
  const kind = str(value.kind);
  const direction = str(value.direction);
  const currency = str(value.currency);
  const bucket = str(value.bucket);
  const grossMinor = num(value.grossMinor);
  const paidMinor = num(value.paidMinor);
  const openMinor = num(value.openMinor);
  const baseOpenMinor = num(value.baseOpenMinor);
  const daysOverdue = num(value.daysOverdue);
  const dunningLevel = num(value.dunningLevel);
  const dunningFeeMinor = num(value.dunningFeeMinor);
  const documentId = nullableStr(value.documentId);
  const paymentId = nullableStr(value.paymentId);
  const number = nullableStr(value.number);
  const customerId = nullableStr(value.customerId);
  const customerName = nullableStr(value.customerName);
  const issueDate = nullableStr(value.issueDate);
  const dueDate = nullableStr(value.dueDate);

  if (kind !== 'document' && kind !== 'on_account') return null;
  if (direction !== 'incoming' && direction !== 'outgoing') return null;
  if (currency === null || bucket === null) return null;
  if (grossMinor === null || paidMinor === null || openMinor === null) return null;
  if (baseOpenMinor === null || daysOverdue === null || dunningLevel === null) return null;
  if (dunningFeeMinor === null) return null;
  if (typeof value.overdue !== 'boolean') return null;
  if (documentId === undefined || paymentId === undefined || number === undefined) return null;
  if (customerId === undefined || customerName === undefined) return null;
  if (issueDate === undefined || dueDate === undefined) return null;

  return {
    kind,
    direction,
    documentId,
    paymentId,
    number,
    customerId,
    customerName,
    issueDate,
    dueDate,
    currency,
    grossMinor,
    paidMinor,
    openMinor,
    baseOpenMinor,
    daysOverdue,
    overdue: value.overdue,
    bucket,
    dunningLevel,
    dunningFeeMinor,
  };
}

function parseItems(value: unknown): OpenItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: OpenItem[] = [];
  for (const raw of value) {
    const item = parseItem(raw);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

/** `list_open_items`, or null when the payload is not the shape the engine promises. */
export function parseOpenItems(body: Record<string, unknown>): OpenItemsView | null {
  const items = parseItems(body.items);
  const asOf = str(body.asOf);
  const boundariesDays = numberList(body.boundariesDays);
  const bucketTotals = minorMap(body.bucketTotals);
  const baseBucketTotals = minorMap(body.baseBucketTotals);
  const totalOpenMinor = num(body.totalOpenMinor);
  const baseTotalOpenMinor = num(body.baseTotalOpenMinor);
  const baseCurrency = str(body.baseCurrency);
  const currencies = stringList(body.currencies);
  const workspaceBaseTotalOpenMinor = num(body.workspaceBaseTotalOpenMinor);
  const receivablesBalanceMinor = num(body.receivablesBalanceMinor);
  const reconciliationDifferenceMinor = num(body.reconciliationDifferenceMinor);

  if (items === null || asOf === null || boundariesDays === null) return null;
  if (bucketTotals === null || baseBucketTotals === null) return null;
  if (totalOpenMinor === null || baseTotalOpenMinor === null) return null;
  if (baseCurrency === null || currencies === null) return null;
  if (workspaceBaseTotalOpenMinor === null || receivablesBalanceMinor === null) return null;
  if (reconciliationDifferenceMinor === null) return null;
  if (typeof body.filtered !== 'boolean' || typeof body.reconciled !== 'boolean') return null;

  return {
    asOf,
    items,
    boundariesDays,
    bucketTotals,
    baseBucketTotals,
    totalOpenMinor,
    baseTotalOpenMinor,
    baseCurrency,
    currencies,
    filtered: body.filtered,
    workspaceBaseTotalOpenMinor,
    receivablesBalanceMinor,
    reconciled: body.reconciled,
    reconciliationDifferenceMinor,
  };
}

function parseCustomerAging(value: unknown): CustomerAging | null {
  if (!isRecord(value)) return null;
  const customerId = nullableStr(value.customerId);
  const customerName = nullableStr(value.customerName);
  const openItemCount = num(value.openItemCount);
  const totalOpenMinor = num(value.totalOpenMinor);
  const baseTotalOpenMinor = num(value.baseTotalOpenMinor);
  const bucketTotals = minorMap(value.bucketTotals);
  const baseBucketTotals = minorMap(value.baseBucketTotals);
  const oldestOverdueDays = num(value.oldestOverdueDays);
  if (customerId === undefined || customerName === undefined) return null;
  if (openItemCount === null || totalOpenMinor === null || baseTotalOpenMinor === null) return null;
  if (bucketTotals === null || baseBucketTotals === null || oldestOverdueDays === null) return null;
  return {
    customerId,
    customerName,
    openItemCount,
    totalOpenMinor,
    baseTotalOpenMinor,
    bucketTotals,
    baseBucketTotals,
    oldestOverdueDays,
  };
}

/** `aging_report`, or null when the payload is not the shape the engine promises. */
export function parseAging(body: Record<string, unknown>): AgingView | null {
  if (!Array.isArray(body.byCustomer)) return null;
  const byCustomer: CustomerAging[] = [];
  for (const raw of body.byCustomer) {
    const row = parseCustomerAging(raw);
    if (row === null) return null;
    byCustomer.push(row);
  }

  const asOf = str(body.asOf);
  const boundariesDays = numberList(body.boundariesDays);
  const byBucket = minorMap(body.byBucket);
  const baseByBucket = minorMap(body.baseByBucket);
  const totalOpenMinor = num(body.totalOpenMinor);
  const baseTotalOpenMinor = num(body.baseTotalOpenMinor);
  const baseCurrency = str(body.baseCurrency);
  const receivablesBalanceMinor = num(body.receivablesBalanceMinor);
  const reconciliationDifferenceMinor = num(body.reconciliationDifferenceMinor);

  if (asOf === null || boundariesDays === null || byBucket === null || baseByBucket === null) return null;
  if (totalOpenMinor === null || baseTotalOpenMinor === null || baseCurrency === null) return null;
  if (receivablesBalanceMinor === null || reconciliationDifferenceMinor === null) return null;
  if (typeof body.reconciled !== 'boolean') return null;

  return {
    asOf,
    boundariesDays,
    byBucket,
    baseByBucket,
    byCustomer,
    totalOpenMinor,
    baseTotalOpenMinor,
    baseCurrency,
    receivablesBalanceMinor,
    reconciled: body.reconciled,
    reconciliationDifferenceMinor,
  };
}

/** `customer_balance`, or null when the payload is not the shape the engine promises. */
export function parseCustomerBalance(body: Record<string, unknown>): CustomerBalanceView | null {
  const items = parseItems(body.items);
  const customerId = str(body.customerId);
  const customerName = nullableStr(body.customerName);
  const asOf = str(body.asOf);
  const boundariesDays = numberList(body.boundariesDays);
  const baseBucketTotals = minorMap(body.baseBucketTotals);
  const totalOpenMinor = num(body.totalOpenMinor);
  const baseTotalOpenMinor = num(body.baseTotalOpenMinor);
  const baseCurrency = str(body.baseCurrency);
  const currencies = stringList(body.currencies);
  const oldestOverdueDays = num(body.oldestOverdueDays);
  const onAccountMinor = num(body.onAccountMinor);

  if (items === null || customerId === null || customerName === undefined || asOf === null) return null;
  if (boundariesDays === null || baseBucketTotals === null) return null;
  if (totalOpenMinor === null || baseTotalOpenMinor === null || baseCurrency === null) return null;
  if (currencies === null || oldestOverdueDays === null || onAccountMinor === null) return null;

  return {
    customerId,
    customerName,
    asOf,
    items,
    boundariesDays,
    baseBucketTotals,
    totalOpenMinor,
    baseTotalOpenMinor,
    baseCurrency,
    currencies,
    oldestOverdueDays,
    onAccountMinor,
  };
}

/** `get_aging_bucket_config`, or null when the payload is not the shape the engine promises. */
export function parseBucketConfig(body: Record<string, unknown>): BucketConfigView | null {
  const boundariesDays = numberList(body.boundariesDays);
  const bucketKeys = stringList(body.bucketKeys);
  if (boundariesDays === null || bucketKeys === null) return null;
  if (typeof body.configured !== 'boolean') return null;
  return { boundariesDays, bucketKeys, configured: body.configured };
}

// --- pure helpers the surfaces render through -------------------------------------------------------

/**
 * The bucket keys a boundary set produces, derived exactly the way the engine derives them.
 *
 * The COUNT is configurable, so a layout hardcoded at four would break the first time the boundaries
 * are changed. Mirrored here rather than read off the response so the popover can show a live preview
 * of the labels the fields it is holding would produce, before anything is written.
 */
export function bucketKeysFor(boundaries: readonly number[]): string[] {
  if (boundaries.length === 0) return [];
  const keys: string[] = [];
  boundaries.forEach((boundary, index) => {
    keys.push(index === 0 ? `0-${boundary}` : `${boundaries[index - 1] + 1}-${boundary}`);
  });
  keys.push(`${boundaries[boundaries.length - 1]}+`);
  return keys;
}

/** The i18n key and parameters for one bucket, so no machine key like `61-90` reaches the screen. */
export interface BucketLabel {
  key: string;
  params: Record<string, number>;
}

export function bucketLabel(boundaries: readonly number[], index: number): BucketLabel {
  if (index === 0) return { key: 'openItems.bucket.upTo', params: { days: boundaries[0] ?? 0 } };
  if (index >= boundaries.length) {
    return { key: 'openItems.bucket.beyond', params: { days: boundaries[boundaries.length - 1] ?? 0 } };
  }
  return {
    key: 'openItems.bucket.between',
    params: { from: (boundaries[index - 1] ?? 0) + 1, to: boundaries[index] ?? 0 },
  };
}

/**
 * The word for a parked row, from the ENGINE'S `direction` and not from the sign.
 *
 * Incoming money parked on account is a credit the customer holds; outgoing money parked against a
 * customer is a refund paid out and not yet matched to anything. Calling both of them "Guthaben"
 * states the opposite of the fact for half of them, and renders a positive figure under a chip
 * claiming the customer is owed money.
 */
export function parkedKindKey(item: OpenItem): string {
  return item.direction === 'incoming'
    ? 'openItems.kind.onAccount.credit'
    : 'openItems.kind.onAccount.refund';
}

/** Whether a parenthetical says the parked figure is already deducted from the total, or included. */
export function onAccountNoteKey(onAccountMinor: number): string {
  return onAccountMinor >= 0 ? 'openItems.onAccountNote.credit' : 'openItems.onAccountNote.refund';
}

/**
 * The i18n key for a customer cell that may belong to nobody.
 *
 * `customerId` and `customerName` are both nullable on the read model. No shipped write verb can
 * produce such a row today (issuing an invoice needs a contact, and parking money needs a
 * counterparty), but the read model types it, so a blank cell in a money table would read as a
 * loading failure the first time some future importer creates one.
 */
export function customerLabelKey(name: string | null): string | null {
  return name === null || name.trim() === '' ? 'openItems.noCustomer' : null;
}

/** The rows a bucket filter leaves, client-side, from rows already loaded. */
export function itemsInBucket(items: readonly OpenItem[], bucket: string | null): OpenItem[] {
  return bucket === null ? [...items] : items.filter((item) => item.bucket === bucket);
}

/** Today as an ISO date, for deciding whether the `asOf` cut-off is historical. Never for money. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The three `invalid_input.expected` strings `validateBoundaries` can answer with, mapped to copy. */
export function boundaryErrorKey(expected: unknown): string {
  if (expected === 'a non-empty list of day counts') return 'openItems.error.boundaries.empty';
  if (expected === 'positive whole day counts') return 'openItems.error.boundaries.positive';
  if (expected === 'strictly increasing day counts') return 'openItems.error.boundaries.increasing';
  return 'openItems.error.boundaries.positive';
}

/** The most boundaries the popover accepts, which holds the tile group at seven choices (C7). */
export const MAX_BOUNDARIES = 5;
