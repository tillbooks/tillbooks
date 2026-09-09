/**
 * Shared shapes and pure helpers for the Items surface (A09, invoicing-lite item master data).
 *
 * These mirror the engine read models (camelCase per the Module 1 interface decision, G00). The
 * browser never imports engine code, so the shapes are re-declared here and kept deliberately
 * tolerant: an unknown extra field is ignored, a missing optional falls back to a safe default.
 *
 * The one money field, `defaultUnitPriceMinor`, is integer Rappen everywhere (Pattern P2). The GUI
 * parses a typed decimal to Rappen once, at the edge, and renders it back through `formatMoney`.
 */

/**
 * The item KINDS and UNITS the engine admits (D00 §H-ENUM). MIRRORED, not invented: these equal
 * `ITEM_KINDS` / `ITEM_UNITS` in `src/core/sales/itemEnums.ts`, and
 * `test/style/studio-mirrors-engine-enums.test.mjs` fails if they drift. A control here that the
 * engine does not admit is a dead end (`invalid_kind` / `invalid_unit`); a missing one is a capability
 * no screen can reach.
 */
export const ITEM_KINDS = ['product', 'service'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_UNITS = ['piece', 'hour', 'day', 'kg', 'g', 'l', 'm', 'm2', 'm3', 'flat'] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** An item (product/service) read model, extended with the D00 products/items master fields. */
export interface Item {
  id: string;
  name: string;
  /** Integer Rappen (minor units), never a float (Pattern P2). This is the SALES price. */
  defaultUnitPriceMinor: number;
  /** D00: a stable per-workspace article number, or null. */
  sku?: string | null;
  /** D00: `product` or `service`, or null when unset (A09 back-compat). */
  kind?: string | null;
  /** D00: the category tree id, or null for uncategorised. */
  categoryId?: string | null;
  /** D00: the Einstandspreis in integer Rappen, or null. */
  costPriceMinor?: number | null;
  /** D00: the parent item this is a variant of, or null. */
  variantOfId?: string | null;
  /** D00: whether D01 tracks stock (products only). */
  trackStock?: boolean;
  /** D00: the low-stock threshold in thousandths, or null. */
  reorderPointQty?: number | null;
  /**
   * What `defaultUnitPriceMinor` is priced in.
   *
   * The ENGINE always sends it: `item.currency` is TEXT NOT NULL and `mapItem` passes the column
   * through, so no `list_items` or `get_item` answer omits it. Optional here for the same reason
   * every field on these mirrored shapes is tolerant: the wire is JSON and a type is only a promise.
   * The fallback for that branch is the workspace base currency, never a literal CHF, because a base
   * currency is a SETTING (`workspace.base_currency`; `CURRENCIES` below admits three).
   */
  currency?: string | null;
  defaultTaxCode?: string | null;
  revenueAccountId?: string | null;
  unit?: string | null;
  archived?: boolean;
}

/** A minimal account read model, enough to drive the income-only revenue picker (A01). */
export interface Account {
  id: string;
  number: string;
  name: string;
  type?: string;
}

/** A VAT code from the A05 config, the source for the default-tax-code picker. */
export interface VatCode {
  code: string;
  label: string;
}

/** An item category (D00 US-D00.3), the two-level grouping tree. */
export interface Category {
  id: string;
  name: string;
  parentId?: string | null;
  sort?: number;
}

/** A price list (D00 US-D00.4), scoped to one contact OR one segment. */
export interface PriceList {
  id: string;
  name: string;
  contactId?: string | null;
  segment?: string | null;
}

/**
 * The little of a contact this surface needs: an id and a name for the two pickers.
 *
 * Declared HERE rather than imported from the Contacts surface. The full C00 read model is that
 * capability's own shape and carries fields a price list has no business knowing, and a price list
 * needs exactly two of them, so this is the tolerant projection every other shape in this file is.
 */
export interface ContactOption {
  id: string;
  name: string;
}

/** One append-only price row inside a price list. */
export interface PriceRow {
  id: string;
  itemId: string;
  priceMinor: number;
  currency: string;
  validFrom: string;
}

/**
 * Order categories into their two-level tree: each root followed by its children, roots and children
 * each sorted by (sort, name). The engine holds the two-level invariant; this only presents it.
 */
export function categoryTree(categories: Category[]): { root: Category; children: Category[] }[] {
  const bySort = (a: Category, b: Category): number =>
    (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name);
  const roots = categories.filter((c) => c.parentId === undefined || c.parentId === null).sort(bySort);
  return roots.map((root) => ({
    root,
    children: categories.filter((c) => c.parentId === root.id).sort(bySort),
  }));
}

/**
 * Currencies offered in the editor, mirroring the engine's `CURRENCIES` enum. Which one is
 * PRESELECTED is not decided here: it is the workspace base currency, read from
 * `get_company_profile`, so the GUI agrees with what `createItem` resolves for an unnamed currency.
 */
export const CURRENCIES: readonly string[] = ['CHF', 'EUR', 'USD'];

/**
 * True when an account is a revenue (income) account, so it may back an item (spec §3, §6b: the
 * revenue account is the ledger-facing side of the money path and is fixed to income accounts).
 * Prefers the typed enum; falls back to the Kontenrahmen KMU leading digit 3 when the type is absent.
 */
export function isIncomeAccount(account: Account): boolean {
  if (account.type === 'income') return true;
  if (account.type !== undefined) return false;
  return account.number.trim().startsWith('3');
}

/**
 * Case-insensitive match of a query against an item's name, its SKU, or its unit.
 *
 * `unitLabel` resolves the stored unit to the words the ROW PRINTS, and it is a parameter rather than
 * an import because this module is pure and the labels live in i18n. It matters: A09 stored `unit` as
 * free text and D00 narrowed it to the ITEM_UNITS enum, so the stored value is `hour` while the row
 * reads `Stunde`. Matching only the stored code meant searching for what was visibly on screen
 * returned nothing, which is the worst possible answer from a search box. Both are matched now, so a
 * pre-D00 free-text unit and an enum label are equally findable.
 *
 * The SKU is matched here as well, because `list_items` already matches it server-side (`name LIKE`
 * OR `item_sku LIKE`): without it, typing an article number filtered the engine's answer down to the
 * right row and then the client filtered that row back out again.
 */
export function matchesSearch(item: Item, query: string, unitLabel?: (unit: string) => string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const unit = item.unit ?? '';
  const label = unit !== '' && unitLabel !== undefined ? unitLabel(unit) : '';
  return (
    item.name.toLowerCase().includes(q) ||
    (item.sku ?? '').toLowerCase().includes(q) ||
    unit.toLowerCase().includes(q) ||
    label.toLowerCase().includes(q)
  );
}

/**
 * Normalise a Swiss comma decimal to a period, and ONLY where it cannot mean anything else.
 *
 * `150,50` is how a German-speaking Swiss operator types a hundred and fifty francs fifty, and every
 * money field on this surface used to go dead on it: the button stayed enabled and the click did
 * nothing. The comma is swapped for a period only when the string holds exactly ONE comma and NO
 * period, so an ambiguous `1,234` (a thousand two hundred and thirty-four in English, one point two
 * three four in German) is left alone and refused by the caller's own pattern instead of being guessed
 * at. Refusing ambiguity is the point: this is a money field, and a plausible wrong number is worse
 * than a rejected one.
 */
function commaDecimalToPeriod(cleaned: string): string {
  if (cleaned.includes('.')) return cleaned;
  return (cleaned.match(/,/g) ?? []).length === 1 ? cleaned.replace(',', '.') : cleaned;
}

/**
 * Parse a CHF decimal string ("50", "50.5", "50,5", "1'234.55") into integer Rappen. Returns `null`
 * for an empty field and for anything that is not a non-negative amount with at most two decimals.
 * Parsing is exact: the fractional part is read as digits, never through a binary float (P2/P11).
 */
export function parseAmountToMinor(raw: string): number | null {
  const cleaned = commaDecimalToPeriod(raw.trim().replace(/[\s']/g, ''));
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const whole = Number(match[1]);
  const rappen = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + rappen;
}

/** Render an integer-Rappen amount as a plain, editable decimal string ("15050" -> "150.50"). */
export function minorToInput(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const whole = Math.floor(absolute / 100);
  const rappen = absolute % 100;
  return `${negative ? '-' : ''}${whole}.${String(rappen).padStart(2, '0')}`;
}

/**
 * Parse a quantity string ("10", "2.5") into integer thousandths, matching D01's `stock_movement.qty`
 * convention. Returns `null` for empty or non-numeric input, so an untouched reorder-point field
 * stores nothing rather than a zero.
 */
export function parseQtyToMilli(raw: string): number | null {
  const cleaned = commaDecimalToPeriod(raw.trim().replace(/[\s']/g, ''));
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned);
  if (match === null) return null;
  const whole = Number(match[1]);
  const milli = Number((match[2] ?? '').padEnd(3, '0'));
  return whole * 1000 + milli;
}

/** Render integer thousandths back as an editable quantity ("10500" -> "10.5"), trailing zeros trimmed. */
export function milliToQtyInput(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = milli % 1000;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * Whether a string is a real ISO calendar day, the only `validFrom` the engine accepts.
 *
 * MIRRORS the engine boundary rather than approximating it: `setPriceListPrice` runs `validFrom`
 * through A05's `isValidRateDate`, which is anchored at both ends and calendar-aware, and refuses
 * anything else with `invalid_input` rather than coercing it. `'2026-13-99'` matches the shape and is
 * not a date, so the month and day are range-checked here too; the point of this function is to let the
 * surface disable the button for a reason rather than send a call it knows will be refused.
 */
export function isIsoDay(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year && asDate.getUTCMonth() === month - 1 && asDate.getUTCDate() === day
  );
}

/** A short, stable idempotency key for agent-safe creates (§H-IDEMPOTENT). */
export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
