/**
 * The A1 composer's request to the engine: what is on screen, as the INTENT `compose_entry` composes.
 *
 * THE STUDIO DOES NO VAT MATH (D152 amendment, owner 02.10.2026). There is no tax figure, no trace, no
 * rounding hint and no leg arrangement in this file, and there must never be one again: the first build
 * derived the legs here from `vat_preview` figures, and three critic rounds each found one more reopen path
 * where that derivation drifted from the engine by a Rappen. Now the engine composes. This module turns UI
 * state into `compose_entry` lines and nothing else:
 *
 *  - on the DERIVED path (no line on a VAT account) every line with an amount is an intent line: its
 *    account, side, amount (inclusive of MWST, the paid base for Bezugsteuer, which the ENGINE knows), its
 *    code, cost centre and Leistungsdatum;
 *  - on the MANUAL path (one line on 2200/1170/1171 turns derivation off for the whole entry, the pre-A1
 *    composer) every line is a plain line as booked; a line reopened from a stored entry that does not
 *    round-trip is sent VERBATIM, stored trace included, until it is edited, and the engine's gate decides;
 *  - a line with an account and no amount yet is a plain amount-less line (a draft keeps it, C9).
 *
 * The engine answers the exact lines, which `post_entry` and `save_draft` then receive verbatim. The pure
 * predicates below (`isTaxBearing`, `satzSubject`) decide only which side shows an MWST control.
 *
 * Root tests import this file through Node's type stripping (`test/vat/*.test.mjs`), so it imports with
 * explicit `.ts` extensions and only TYPES from anywhere else.
 */
import type { ComposeLine, IntentLine } from '../../../../src/core/ledger/compose.ts';
import type { LineInput } from '../../../../src/core/ledger/postEntry.ts';

/** The KMU VAT accounts (A06 spec §3): 2200 Umsatzsteuer, 1170/1171 Vorsteuer. */
export const VAT_ACCOUNT_NUMBERS: ReadonlySet<string> = new Set(['2200', '1170', '1171']);

/** What the composer knows about an account, off `list_accounts`. */
export interface ComposerAccount {
  id: string;
  number: string;
  /** asset | liability | equity | income | expense. Absent on a hand-built row. */
  type?: string;
  vatCodeDefault?: string | null;
  costCenterAllowed?: boolean;
  /** A Bankkonto's own ledger account (`list_bank_accounts`, see `markBankLedgers`): never a VAT target. */
  bankLedger?: boolean;
}

/** One line as the person composed it. On the derived path `amountMinor` is inclusive of MWST. */
export interface ComposedLine {
  accountId: string;
  side: 'debit' | 'credit';
  /** Integer Rappen, positive; 0 for a line that has an account and no amount yet. */
  amountMinor: number;
  /** '' books the line without a code. */
  taxCode: string;
  /** '' books the line without a cost centre. */
  costCenter: string;
  /**
   * The Leistungsdatum a saved line keeps (C10, owner 02.10.2026): a reopened draft, Vorschlag or posted
   * entry carries its stored one, also when it equals the entry date, so moving the booking date never
   * re-prices it. Absent means the entry date: a line typed here and not yet saved follows the date typed.
   */
  supplyDate?: string;
  /**
   * False for a taxed line reopened from a stored entry that stated NO Leistungsdatum (an agent's Vorschlag).
   * Its stored entry date priced it, so `supplyDate` carries that date as the one it keeps (critic R5-S1),
   * and it is written down only once the booking date differs from it: on its own date the line keeps
   * stating none, so an untouched draft goes back exactly as it was stored. A line typed here states the
   * entry date, as every A1 posting always has.
   */
  statesSupplyDate?: boolean;
  /**
   * The stored line exactly as the engine handed it back, for a line reopened on the manual path because its
   * entry does not round-trip. Sent as it is, never read: the Studio does not look inside a trace. The row
   * drops it the moment it is edited (`composerModel.ts`), and the engine's gate decides either way.
   */
  verbatim?: LineInput;
}

/** A line in the `post_entry` / `save_draft` shape, exactly as the engine answered it. */
export type EngineLine = LineInput;

/** True for a KMU VAT account (2200/1170/1171). */
export function isVatAccount(account: ComposerAccount | undefined): boolean {
  return account !== undefined && VAT_ACCOUNT_NUMBERS.has(account.number);
}

/**
 * The ASSET accounts a purchase can carry Vorsteuer on, THE one predicate for it: the bill drawer, this
 * composer and the bank row all read it (owner D152 point 5, widened by the owner on 04.10.2026). An ASSET
 * account numbered 1200 to 1299 or 1400 to 1799 in the Swiss KMU chart: 12 Vorräte (goods bought into
 * stock carry Vorsteuer Material, VST-M to 1170), 14 Finanzanlagen, 15 and 16 Sachanlagen, 17 immaterielle
 * Werte (Vorsteuer Investitionen, VST-I to 1171, Ziffer 405). Not 10xx (liquid funds, where a bank's own
 * ledger account sits), 11xx (receivables, and the VAT accounts 1170/1171 with them) or 13xx (Aktive
 * Rechnungsabgrenzung: it carries accrual and adjusting entries, and a code there would invite a second
 * Vorsteuer claim on top of the original invoice; owner, 04.10.2026).
 */
export function isVatAssetAccount(account: { type?: string | null; number: string } | undefined): boolean {
  return account !== undefined && account.type === 'asset' && /^1[24-7]\d{2}$/.test(account.number);
}

/** Every Bankkonto's own ledger account, read off a `list_bank_accounts` answer (anything else: none). */
export function bankLedgerIdsOf(body: unknown): ReadonlySet<string> {
  const list = (body as { bankAccounts?: unknown } | null)?.bankAccounts;
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list
      .map((b) => (b as { ledgerAccountId?: unknown }).ledgerAccountId)
      .filter((id): id is string => typeof id === 'string' && id !== ''),
  );
}

/** The chart with each Bankkonto's ledger account marked, so `isTaxBearing` never offers MWST on it. */
export function markBankLedgers<T extends { id: string }>(accounts: readonly T[], ledgerIds: ReadonlySet<string>): (T & { bankLedger?: boolean })[] {
  return accounts.map((a) => (ledgerIds.has(a.id) ? { ...a, bankLedger: true } : a));
}

/**
 * Whether an account carries an MWST control, the ONE predicate for it (C8, owner 01.10.2026): an
 * Erfolgskonto (type income or expense), or an asset account 12xx or 14xx to 17xx (`isVatAssetAccount`:
 * Vorräte and Anlagevermögen, owner 04.10.2026), and never a VAT account (2200/1170/1171). Everything else
 * (liquid funds, receivables and Rechnungsabgrenzung 10xx, 11xx and 13xx, liabilities, equity, an account
 * of unknown type) carries none. A default code is a pre-fill for an account that qualifies, never a
 * reason to qualify.
 */
export function isTaxBearing(account: ComposerAccount | undefined): boolean {
  // A Bankkonto's own ledger account never carries a code, whatever its number (critic L2): a custom chart
  // may link a Bankkonto to an account inside the asset range. The Bank surface's `vatNeverApplies` rule.
  if (account === undefined || isVatAccount(account) || account.bankLedger === true) return false;
  if (account.type === 'income' || account.type === 'expense') return true;
  return isVatAssetAccount(account);
}

/**
 * Which side of a Buchungssatz carries the MWST control: the Soll account when it is tax-bearing, else the
 * Haben account when it is, else none. A satz that touches a VAT account carries none: that booking is the
 * manual path, and it belongs in the grid.
 */
export function satzSubject(
  soll: ComposerAccount | undefined,
  haben: ComposerAccount | undefined,
): ComposerAccount | null {
  if (isVatAccount(soll) || isVatAccount(haben)) return null;
  if (soll !== undefined && isTaxBearing(soll)) return soll;
  if (haben !== undefined && isTaxBearing(haben)) return haben;
  return null;
}

/**
 * The two composed lines a Buchungssatz stands for. The code and the cost centre ride the subject side
 * only, and only while there IS a subject: a hidden MWST control never carries a value.
 */
export function composeSatz(
  satz: { soll: string; haben: string; amountMinor: number; taxCode: string; costCenter: string; supplyDate?: string; statesSupplyDate?: boolean },
  accountOf: (id: string) => ComposerAccount | undefined,
): ComposedLine[] {
  const subject = satzSubject(accountOf(satz.soll), accountOf(satz.haben));
  const onSoll = subject !== null && subject.id === satz.soll;
  const onHaben = subject !== null && !onSoll && subject.id === satz.haben;
  // A stored Leistungsdatum rides the taxed side with its code (C10); it means nothing without one.
  const dated = (on: boolean) => ({
    ...(on && satz.taxCode !== '' && satz.supplyDate !== undefined && satz.supplyDate !== '' ? { supplyDate: satz.supplyDate } : {}),
    ...(on && satz.statesSupplyDate === false ? { statesSupplyDate: false } : {}),
  });
  return [
    { accountId: satz.soll, side: 'debit', amountMinor: satz.amountMinor, taxCode: onSoll ? satz.taxCode : '', costCenter: onSoll ? satz.costCenter : '', ...dated(onSoll) },
    { accountId: satz.haben, side: 'credit', amountMinor: satz.amountMinor, taxCode: onHaben ? satz.taxCode : '', costCenter: onHaben ? satz.costCenter : '', ...dated(onHaben) },
  ];
}

/**
 * One composed line as `compose_entry` takes it. Derived: an intent line (the engine expands it). Manual: a
 * plain line as booked, or the stored line verbatim. Without an amount: the account, code and cost centre,
 * and no amount key (an amount of 0 is not one). A taxed line names the date it is priced at: its kept
 * Leistungsdatum (a saved line's, which a moved booking date does not change), else the entry date (an
 * unsaved line, which follows the date typed). A saved line that stated none names its kept date only once
 * the booking date has moved off it (critic R5-S1), on the verbatim path too (critic R6-V): there the stored
 * line goes out as stored, plus that one date, so the gate prices it where it was priced and A07 files it in
 * its own era, while an unmoved draft still goes back byte-verbatim. The date is a fact on screen, not a
 * figure.
 */
export function composeLineOf(line: ComposedLine, derive: boolean, date: string): ComposeLine {
  if (line.verbatim !== undefined && !derive) {
    const stored = line.verbatim;
    const keptDate =
      stored.taxCode !== undefined && stored.supplyDate === undefined && line.statesSupplyDate === false && line.supplyDate !== undefined && line.supplyDate !== date
        ? { supplyDate: line.supplyDate }
        : {};
    return { ...stored, ...keptDate };
  }
  const stated =
    line.statesSupplyDate === false
      ? line.supplyDate !== undefined && line.supplyDate !== date
        ? line.supplyDate
        : undefined
      : (line.supplyDate ?? date);
  const priced = line.taxCode !== '' && stated !== undefined ? { supplyDate: stated } : {};
  if (line.amountMinor <= 0) {
    const out: LineInput = { account: line.accountId };
    if (line.costCenter !== '') out.costCenter = line.costCenter;
    if (line.taxCode !== '') out.taxCode = line.taxCode;
    return out;
  }
  if (derive) {
    const intent: IntentLine = { account: line.accountId, side: line.side, amount: line.amountMinor, gross: true };
    if (line.taxCode !== '') intent.taxCode = line.taxCode;
    if (line.costCenter !== '') intent.costCenter = line.costCenter;
    return { ...intent, ...priced };
  }
  const out: LineInput = { account: line.accountId };
  if (line.side === 'debit') out.debit = line.amountMinor;
  else out.credit = line.amountMinor;
  if (line.costCenter !== '') out.costCenter = line.costCenter;
  if (line.taxCode !== '') out.taxCode = line.taxCode;
  return { ...out, ...priced };
}

/** The `compose_entry` lines for a composed entry, in order (the engine answers a caption per index). */
export function composeLines(lines: readonly ComposedLine[], derive: boolean, date: string): ComposeLine[] {
  return lines.map((l) => composeLineOf(l, derive, date));
}

// --- Reopening a stored entry -------------------------------------------------------------------------

/** What `compose_entry` `decompose` answers (the fields the reopen reads). */
export interface Decomposed {
  date: string;
  lines: readonly LineInput[];
  intent: readonly ComposeLine[];
  roundTrips: boolean;
}

/** True for an intent line (`side`/`amount`/`gross`), false for a plain stored line. */
export function isIntent(line: ComposeLine): line is IntentLine {
  return 'side' in line && 'amount' in line;
}

/** A Buchungssatz, as the satz face holds it. */
export interface SatzFromIntent {
  soll: string;
  haben: string;
  amountMinor: number;
  taxCode: string;
  costCenter: string;
  /**
   * The Leistungsdatum the taxed line keeps (owner, 02.10.2026): its stored one, or, when it stated none,
   * the stored entry date that priced it (critic R5-S1); '' without a taxed line.
   */
  supplyDate: string;
  /** False when the taxed line stated no Leistungsdatum at all (see `ComposedLine.statesSupplyDate`). */
  statesSupplyDate: boolean;
}

/**
 * The Buchungssatz a decomposed intent IS, when it has the two-line A1 shape: two intent lines on opposite
 * sides with one amount, no VAT account, at most one code, and the code and cost centre on the side the satz
 * would put them. Null otherwise. Structural only: whether the intent reproduces the stored lines is the
 * engine's `roundTrips`, which the caller has already checked.
 */
export function satzFromIntent(
  intent: readonly ComposeLine[],
  accountOf: (id: string) => ComposerAccount | undefined,
  storedDate: string,
): SatzFromIntent | null {
  if (intent.length !== 2) return null;
  const [a, b] = intent as [ComposeLine, ComposeLine];
  if (!isIntent(a) || !isIntent(b)) return null;
  if (a.side === b.side || a.amount !== b.amount) return null;
  if (isVatAccount(accountOf(a.account)) || isVatAccount(accountOf(b.account))) return null;
  const soll = a.side === 'debit' ? a : b;
  const haben = soll === a ? b : a;
  const composed = composeSatz(
    {
      soll: soll.account,
      haben: haben.account,
      amountMinor: soll.amount,
      taxCode: soll.taxCode ?? haben.taxCode ?? '',
      costCenter: soll.costCenter ?? haben.costCenter ?? '',
    },
    accountOf,
  );
  // The code and the cost centre must sit exactly where the satz would put them, and nowhere else.
  const where = (l: IntentLine, c: ComposedLine) => (l.taxCode ?? '') === c.taxCode && (l.costCenter ?? '') === c.costCenter;
  if (!where(soll, composed[0] as ComposedLine) || !where(haben, composed[1] as ComposedLine)) return null;
  const taxed = (soll.taxCode !== undefined ? soll : haben.taxCode !== undefined ? haben : null) as IntentLine | null;
  const supplyDate = taxed === null ? '' : (taxed.supplyDate ?? storedDate);
  return {
    soll: soll.account,
    haben: haben.account,
    amountMinor: soll.amount,
    taxCode: taxed?.taxCode ?? '',
    costCenter: soll.costCenter ?? haben.costCenter ?? '',
    supplyDate,
    statesSupplyDate: taxed === null || taxed.supplyDate !== undefined,
  };
}

/**
 * Whether a decomposed intent can open DERIVED: the engine says it round-trips, and no line of it sits on a
 * VAT account (one such line turns derivation off for the whole entry, and the intent's taxed lines hold a
 * gross the manual path would read as booked).
 */
export function opensDerived(d: Pick<Decomposed, 'intent' | 'roundTrips'>, accountOf: (id: string) => ComposerAccount | undefined): boolean {
  return d.roundTrips && sayableInGross(d.intent, accountOf);
}

/**
 * Whether the composer's derived path can hold an intent as it is: no line on a VAT account, and every
 * taxed amount a gross (the A1 Betrag is inclusive of MWST; a NET intent the engine could not restate as
 * a gross would be misread here, so it stays on the manual path).
 */
function sayableInGross(intent: readonly ComposeLine[], accountOf: (id: string) => ComposerAccount | undefined): boolean {
  return intent.every((l) => !isVatAccount(accountOf(l.account)) && (!isIntent(l) || l.gross));
}

