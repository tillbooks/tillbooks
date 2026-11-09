/**
 * Money-input parsing for the EntryDrawer. Amounts live as integer minor units (Rappen) everywhere,
 * per the money model (P2): the user types a decimal CHF string, this turns it into Rappen exactly
 * (no float rounding), and `formatMoney` renders it back. A blank field parses to `null` (no amount).
 */

/**
 * Parse a CHF decimal string ("50", "50.5", "1'234.55") into integer Rappen. Returns `null` for an
 * empty field and for anything that is not a non-negative amount with at most two decimals. Parsing
 * is exact: the fractional part is read as digits, never through a binary float.
 */
export function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const whole = Number(match[1]);
  const rappen = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + rappen;
}

/**
 * Mint an idempotency key for one write attempt (§H-IDEMPOTENT): a retried post carrying the same key
 * never double-counts. `crypto.randomUUID` is available in every browser Studio runs in and in jsdom.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The base-currency figures a POSTED foreign entry carries on a `list_journal` row. */
export interface ListedBaseTotal {
  /** The base-currency total, in integer minor units, summed from the posted rows by the ENGINE. */
  baseTotal: number;
  /** The rate the posted rows carry, as the engine's own canonical string. Never re-parsed here. */
  fxRate: string;
  /** The currency the books hold, so the base figure is denominated and never a bare number. */
  baseCurrency: string;
}

/**
 * The base-currency figures the LEDGER posted for a journal-list row, or null when there are none.
 *
 * All three are checked at RUNTIME rather than trusting the cast that produced the row, because
 * every one of these objects entered the app as `body.entries as JournalEntry[]` over an HTTP
 * boundary. Narrowing off `status === 'posted'` instead would be the client deciding for itself
 * which entries have a base total, which is one inference away from computing one.
 *
 * Nothing here converts anything. `baseTotal` is the engine's own sum of the posted `base_debit`
 * columns, and `fxRate` is carried through as a string for display only. Multiplying `total` by it
 * would be a different number: the ledger converts in exact scaled integers and rounds half away
 * from zero, so EUR 1.00 at 1.005 is CHF 1.01 in the books while `100 * 1.005` in binary floating
 * point is 100.49999999999999 and rounds DOWN to CHF 1.00. One Rappen, on the one path where the
 * numbers have to agree with the books.
 */
export function listedBaseTotal(entry: {
  baseTotal?: number | null;
  fxRate?: string | null;
  baseCurrency?: string | null;
}): ListedBaseTotal | null {
  const { baseTotal, fxRate, baseCurrency } = entry;
  if (typeof baseTotal !== 'number') return null;
  if (typeof fxRate !== 'string' || fxRate === '') return null;
  if (typeof baseCurrency !== 'string' || baseCurrency === '') return null;
  return { baseTotal, fxRate, baseCurrency };
}

/**
 * What an entry's lines say about currency: the transaction currency, the rate, and the two totals.
 *
 * `null` means "nothing to disclose": a base-currency entry, where every `fxRate` is null. §H-FX
 * stamps ONE currency and ONE rate per entry (`postEntry` applies `fx.currency`/`fxRate` to every
 * row), so the first FX line speaks for the entry and a disagreement between rows is a bug worth
 * seeing rather than averaging away, which is why `mixed` is reported instead of hidden.
 *
 * Nothing here converts anything. Both totals are sums of integers the engine already computed, the
 * same arithmetic the balance panel does; the rate is carried through as the engine's own string and
 * is never used in a calculation, because the client does not do money.
 */
export interface FxDisclosure {
  currency: string;
  rate: string;
  transactionDebitMinor: number;
  baseDebitMinor: number;
  /**
   * What `baseDebitMinor` is denominated in, off the LINES: `get_entry` sends `baseCurrency` beside
   * `baseDebit` (`reads.ts`, `mapLine`), so the label arrives in the same response as the figure and
   * the two cannot come apart. `null` only when no converted line named it, which the engine no
   * longer produces; the caller falls back to the workspace profile there, never to a literal.
   */
  baseCurrency: string | null;
  /** True when the rows disagree about currency or rate, which the engine should never produce. */
  mixed: boolean;
}

export function fxDisclosureOf(
  lines: readonly {
    debit?: number | null;
    baseDebit?: number | null;
    currency?: string | null;
    baseCurrency?: string | null;
    fxRate?: string | null;
  }[],
): FxDisclosure | null {
  const converted = lines.filter(
    (l) => typeof l.fxRate === 'string' && l.fxRate !== '' && typeof l.currency === 'string' && l.currency !== '',
  );
  if (converted.length === 0) return null;

  const first = converted[0] as { currency: string; fxRate: string };
  const mixed = converted.some((l) => l.currency !== first.currency || l.fxRate !== first.fxRate);

  // The base label, checked at RUNTIME like every other field that crossed the HTTP boundary as a
  // cast. Taken off a CONVERTED line rather than any line, so it is read from the same rows the two
  // totals below are summed from. One base currency per entry is an engine fact (one workspace, one
  // `baseCurrencyOf` read per response), so the first is the entry's.
  const named = converted.find((l) => typeof l.baseCurrency === 'string' && l.baseCurrency !== '');
  const baseCurrency = named === undefined ? null : (named.baseCurrency as string);

  let transactionDebitMinor = 0;
  let baseDebitMinor = 0;
  for (const l of lines) {
    if (typeof l.debit === 'number') transactionDebitMinor += l.debit;
    if (typeof l.baseDebit === 'number') baseDebitMinor += l.baseDebit;
  }
  return {
    currency: first.currency,
    rate: first.fxRate,
    transactionDebitMinor,
    baseDebitMinor,
    baseCurrency,
    mixed,
  };
}
