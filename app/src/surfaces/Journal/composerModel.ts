/**
 * The A1 composer's UI state and the pure rules over it: what a Buchungssatz and a grid hold, which line
 * balances itself, and which composed lines they stand for. No React and no money arithmetic beyond the
 * sums a balance needs: every VAT figure, leg and trace is the engine's (`compose_entry`, D152 amendment).
 */
// Explicit `.ts` specifiers, like `composerPayload.ts`: the root node suites import this module directly
// (Node type stripping), so the reopen path they prove is the Studio's own code, not a copy of it.
import { parseAmountToMinor } from './money.ts';
import {
  composeLineOf,
  composeSatz,
  isIntent,
  isTaxBearing,
  isVatAccount,
  opensDerived,
  satzFromIntent,
  satzSubject,
  type ComposedLine,
  type ComposerAccount,
  type Decomposed,
} from './composerPayload.ts';
import type { ComposeLine } from '../../../../src/core/ledger/compose.ts';
import type { LineInput } from '../../../../src/core/ledger/postEntry.ts';

/** The Buchungssatz: Soll an Haben, one gross Betrag, one MWST code, one cost centre. */
export interface SatzState {
  soll: string;
  haben: string;
  /** The typed decimal, parsed to Rappen when it is used. */
  amount: string;
  taxCode: string;
  costCenter: string;
  /** "+ Kostenstelle" was pressed (or a loaded entry carries one): the picker shows. */
  costCenterOpen: boolean;
  /**
   * The Leistungsdatum a SAVED taxed line keeps (C10, owner 02.10.2026), also when it equals the entry date,
   * so a moved booking date never re-prices it; '' follows the entry date (a line typed here, unsaved). A
   * saved line that stated none keeps the stored entry date that priced it (`statesSupplyDate: false`).
   * Shown under the row only while it differs from the entry date.
   */
  supplyDate: string;
  /** False for a reopened satz whose taxed line stated no Leistungsdatum (`ComposedLine.statesSupplyDate`). */
  statesSupplyDate: boolean;
}

export const BLANK_SATZ: SatzState = { soll: '', haben: '', amount: '', taxCode: '', costCenter: '', costCenterOpen: false, supplyDate: '', statesSupplyDate: true };

/** One grid line: amounts stay raw decimal strings until they are used. */
export interface GridLine {
  key: string;
  account: string;
  debit: string;
  credit: string;
  costCenter: string;
  taxCode: string;
  /** The Leistungsdatum a saved taxed line keeps (see `SatzState.supplyDate`), or '' to follow the entry date. */
  supplyDate: string;
  /** False for a reopened taxed line that stated no Leistungsdatum (`ComposedLine.statesSupplyDate`). */
  statesSupplyDate: boolean;
  /**
   * A line reopened on the manual path (its entry does not round-trip): the stored line exactly as the
   * engine handed it back, sent as it is while the row is untouched. ANY edit to the row drops it
   * (`editGridLine`), so what is sent is either exactly what was stored or exactly what is on screen. The
   * Studio never reads it. Null for every other line.
   */
  verbatim: LineInput | null;
}

let lineSeq = 0;
export function blankGridLine(over: Partial<Omit<GridLine, 'key'>> = {}): GridLine {
  lineSeq += 1;
  return { key: `l${lineSeq}`, account: '', debit: '', credit: '', costCenter: '', taxCode: '', supplyDate: '', statesSupplyDate: true, verbatim: null, ...over };
}

/** A row after an edit: the patch applied, and the stored line it may have carried dropped. */
export function editGridLine(line: GridLine, patch: Partial<Omit<GridLine, 'key' | 'verbatim'>>): GridLine {
  return { ...line, ...patch, verbatim: null };
}

/** Rappen back into the decimal a field holds ("107.70"). */
export function minorToDecimal(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/**
 * A decomposed line as a grid line: an intent line's amount on its side; a plain stored line's amounts as
 * stored. Its Leistungsdatum is KEPT (owner, 02.10.2026): a saved line's supply date, and so its rate, does
 * not move with the booking date. A taxed line that stated none was priced at its stored ENTRY date
 * (`storedDate`), which the engine and A07 read as its Leistungsdatum (`supply_date ?? date`), so that date
 * is the one it keeps (critic R5-S1); `statesSupplyDate: false` writes it down only once the booking date
 * moves away from it. `keepVerbatim` (the manual reopen) keeps the stored line to be sent as it is while the
 * row is untouched.
 */
export function gridLineFromCompose(line: ComposeLine, storedDate: string, keepVerbatim: boolean): GridLine {
  const supply = (d: string | undefined) => d ?? storedDate;
  if (isIntent(line)) {
    const amount = minorToDecimal(line.amount);
    return blankGridLine({
      account: line.account,
      debit: line.side === 'debit' ? amount : '',
      credit: line.side === 'credit' ? amount : '',
      costCenter: line.costCenter ?? '',
      taxCode: line.taxCode ?? '',
      supplyDate: line.taxCode !== undefined ? supply(line.supplyDate) : '',
      statesSupplyDate: line.taxCode === undefined || line.supplyDate !== undefined,
    });
  }
  const toStr = (v?: number) => (typeof v === 'number' && v > 0 ? minorToDecimal(v) : '');
  const taxCode = line.taxCode ?? '';
  // A line still waiting for its amount priced nothing yet, so its missing date states nothing either: it
  // takes the entry date like any line typed here once its amount is in (critic M2), and keeps none.
  const unpriced = (line.debit ?? 0) + (line.credit ?? 0) === 0;
  return blankGridLine({
    account: line.account,
    debit: toStr(line.debit),
    credit: toStr(line.credit),
    costCenter: line.costCenter ?? '',
    taxCode,
    supplyDate: taxCode === '' ? '' : line.supplyDate ?? (unpriced ? '' : storedDate),
    statesSupplyDate: taxCode === '' || line.supplyDate !== undefined || unpriced,
    verbatim: keepVerbatim ? { ...line } : null,
  });
}

/** The code an account brings with it: its default, when the workspace offers that code; else none. */
export function defaultCodeFor(account: ComposerAccount | undefined, offered: readonly { code: string }[]): string {
  if (account === undefined || !isTaxBearing(account)) return '';
  const code = account.vatCodeDefault ?? '';
  return code !== '' && offered.some((c) => c.code === code) ? code : '';
}

/**
 * A satz after one of its accounts changed. When the MWST-bearing side moves to another account, the code
 * is that account's default and the cost centre is cleared: a value chosen for one account never rides
 * silently onto another, and a hidden control never keeps one. The kept Leistungsdatum follows ONE rule
 * with the code control (`withTaxCode`, critic R6-S1): while the line still carries a code, the date stays
 * (critic R5 L-a: correcting the expense account does not move the supply); an account that leaves it with
 * no code makes it untaxed, and it lets go of the date exactly as "Ohne MWST" does. An unsaved line has none
 * to keep and still follows the date typed.
 */
export function withSatzAccount(
  satz: SatzState,
  side: 'soll' | 'haben',
  accountId: string,
  accountOf: (id: string) => ComposerAccount | undefined,
  offered: readonly { code: string }[],
): SatzState {
  const before = satzSubject(accountOf(satz.soll), accountOf(satz.haben));
  const next = { ...satz, [side]: accountId };
  const after = satzSubject(accountOf(next.soll), accountOf(next.haben));
  if ((before?.id ?? null) === (after?.id ?? null)) return next;
  return { ...next, costCenter: '', costCenterOpen: false, ...withTaxCode(defaultCodeFor(after ?? undefined, offered)) };
}

/**
 * The patch for a line's new code, chosen by the person or brought by an account change (the one rule,
 * critic R6-S1). No code ('', "Ohne MWST" or an account that carries none) makes the line untaxed, so it
 * lets go of its kept Leistungsdatum: a code chosen later is a new fact and follows the entry date (critic
 * R5 L-a). Any other code keeps the date, since the supply did not move.
 */
export function withTaxCode(code: string): { taxCode: string; supplyDate?: string; statesSupplyDate?: boolean } {
  return code === '' ? { taxCode: '', supplyDate: '', statesSupplyDate: true } : { taxCode: code };
}

/** The satz's composed lines, or none while an account or the amount is missing. */
export function satzComposed(satz: SatzState, accountOf: (id: string) => ComposerAccount | undefined): ComposedLine[] {
  const amountMinor = parseAmountToMinor(satz.amount) ?? 0;
  if (satz.soll === '' || satz.haben === '' || amountMinor <= 0) return [];
  return composeSatz(
    { soll: satz.soll, haben: satz.haben, amountMinor, taxCode: satz.taxCode, costCenter: satz.costCenter, supplyDate: satz.supplyDate, statesSupplyDate: satz.statesSupplyDate },
    accountOf,
  );
}

/**
 * What a DRAFT of a satz holds (critic C4, C9, M2): the two composed lines once it is complete; on a
 * half-typed satz the side that is there, with its amount; with no amount yet, every account that is there,
 * amount-less (the engine keeps incomplete drafts). The engine composes all of it: an amount on a taxed line
 * is expanded exactly as a post would be, never stored as a coded gross the engine would read as net.
 */
export function satzDraftComposed(satz: SatzState, accountOf: (id: string) => ComposerAccount | undefined): ComposedLine[] {
  const amountMinor = parseAmountToMinor(satz.amount) ?? 0;
  return composeSatz(
    { soll: satz.soll, haben: satz.haben, amountMinor: amountMinor > 0 ? amountMinor : 0, taxCode: satz.taxCode, costCenter: satz.costCenter, supplyDate: satz.supplyDate, statesSupplyDate: satz.statesSupplyDate },
    accountOf,
  ).filter((l) => l.accountId !== '');
}

/**
 * The figure the LAST line balances to while both of its amounts are blank: the difference of every other
 * line, on the side that closes it. Null when there is nothing to balance or the last line has no account.
 */
export function autoBalance(lines: readonly GridLine[]): { side: 'debit' | 'credit'; amountMinor: number } | null {
  const last = lines[lines.length - 1];
  if (last === undefined || last.account === '' || last.debit !== '' || last.credit !== '') return null;
  let diff = 0;
  for (const l of lines.slice(0, -1)) {
    diff += (parseAmountToMinor(l.debit) ?? 0) - (parseAmountToMinor(l.credit) ?? 0);
  }
  if (diff === 0) return null;
  return diff > 0 ? { side: 'credit', amountMinor: diff } : { side: 'debit', amountMinor: -diff };
}

/** A grid line's effective amount and side: what it was typed with, or the figure it balances to. */
export interface EffectiveLine {
  line: GridLine;
  debitMinor: number | null;
  creditMinor: number | null;
  auto: boolean;
}

export function effectiveLines(lines: readonly GridLine[]): EffectiveLine[] {
  const auto = autoBalance(lines);
  return lines.map((line, i) => {
    if (auto !== null && i === lines.length - 1) {
      return {
        line,
        debitMinor: auto.side === 'debit' ? auto.amountMinor : null,
        creditMinor: auto.side === 'credit' ? auto.amountMinor : null,
        auto: true,
      };
    }
    return { line, debitMinor: parseAmountToMinor(line.debit), creditMinor: parseAmountToMinor(line.credit), auto: false };
  });
}

/** True when any grid line sits on a VAT account: derivation is off for the whole entry (the manual path). */
export function gridIsManual(lines: readonly GridLine[], accountOf: (id: string) => ComposerAccount | undefined): boolean {
  return lines.some((l) => isVatAccount(accountOf(l.account)));
}

/**
 * Whether a grid line shows its MWST cell: on the manual path every line (the pre-A1 composer), otherwise
 * a tax-bearing account, or a line that already carries a code (nothing on screen hides a value).
 */
export function gridShowsTax(line: GridLine, manual: boolean, accountOf: (id: string) => ComposerAccount | undefined): boolean {
  if (manual) return true;
  return isTaxBearing(accountOf(line.account)) || line.taxCode !== '';
}

/**
 * The grid's composed lines: every line with an account, on its side, as effective. A line with an account
 * and no amount yet is kept with amount 0, so a draft keeps it (C9); the engine refuses to POST it.
 */
export function gridComposed(eff: readonly EffectiveLine[]): (ComposedLine & { key: string })[] {
  const out: (ComposedLine & { key: string })[] = [];
  for (const e of eff) {
    if (e.line.account === '') continue;
    const debit = e.debitMinor ?? 0;
    const credit = e.creditMinor ?? 0;
    out.push({
      key: e.line.key,
      accountId: e.line.account,
      side: credit > 0 && debit <= 0 ? 'credit' : 'debit',
      amountMinor: debit > 0 ? debit : credit > 0 ? credit : 0,
      taxCode: e.line.taxCode,
      costCenter: e.line.costCenter,
      ...(e.line.supplyDate !== '' && e.line.taxCode !== '' ? { supplyDate: e.line.supplyDate } : {}),
      ...(!e.line.statesSupplyDate && e.line.taxCode !== '' ? { statesSupplyDate: false } : {}),
      ...(e.line.verbatim !== null ? { verbatim: e.line.verbatim } : {}),
    });
  }
  return out;
}

/**
 * "Aufteilen": the satz as two grid lines, everything typed carried over. The Soll line keeps the amount;
 * the Haben line is left blank and balances itself, so retyping one figure never needs two edits.
 */
export function satzToGrid(satz: SatzState, accountOf: (id: string) => ComposerAccount | undefined): GridLine[] {
  const subject = satzSubject(accountOf(satz.soll), accountOf(satz.haben));
  const onSoll = subject !== null && subject.id === satz.soll;
  const onHaben = subject !== null && !onSoll && subject.id === satz.haben;
  return [
    blankGridLine({
      account: satz.soll,
      debit: satz.amount,
      taxCode: onSoll ? satz.taxCode : '',
      costCenter: onSoll ? satz.costCenter : '',
      supplyDate: onSoll ? satz.supplyDate : '',
      statesSupplyDate: onSoll ? satz.statesSupplyDate : true,
    }),
    blankGridLine({
      account: satz.haben,
      taxCode: onHaben ? satz.taxCode : '',
      costCenter: onHaben ? satz.costCenter : '',
      supplyDate: onHaben ? satz.supplyDate : '',
      statesSupplyDate: onHaben ? satz.statesSupplyDate : true,
    }),
  ];
}

/** What the composer holds, the part a request is built from. */
export interface ComposerFaceState {
  face: 'satz' | 'grid';
  satz: SatzState;
  lines: readonly GridLine[];
  /** A verbatim reopen: the whole entry stays on the manual path. */
  manualLock: boolean;
}

/** One `compose_entry` request: the lines in order, the UI key of each, and whether it is the derived path. */
export interface ComposerRequest {
  derive: boolean;
  keys: string[];
  lines: ComposeLine[];
}

/**
 * The `compose_entry` `expand` request for what is on screen: one line per composed row, in order. The
 * derived path while no row sits on a VAT account and the entry is not a verbatim reopen; the manual path
 * otherwise. It is also the DRAFT's content (a half-typed satz, an amount-less row, C4/C9/M2): the engine
 * answers the lines a draft keeps, and the verdict says whether they would post.
 */
export function composerRequest(
  state: ComposerFaceState,
  accountOf: (id: string) => ComposerAccount | undefined,
  date: string,
): ComposerRequest {
  const manual = state.face === 'grid' && (state.manualLock || gridIsManual(state.lines, accountOf));
  const derive = !manual;
  const composed: (ComposedLine & { key: string })[] =
    state.face === 'satz'
      ? satzDraftComposed(state.satz, accountOf).map((l) => ({ ...l, key: l.side === 'debit' ? 'satz-soll' : 'satz-haben' }))
      : gridComposed(effectiveLines(state.lines));
  return { derive, keys: composed.map((l) => l.key), lines: composed.map((l) => composeLineOf(l, derive, date)) };
}

/** How a stored entry reopens in the composer (the decision `EntryDrawer` makes, and the suites prove). */
export type ReopenState =
  | { face: 'satz'; satz: SatzState; lines: GridLine[]; manualLock: false }
  | { face: 'grid'; lines: GridLine[]; manualLock: boolean };

/** The derived grid a decomposed intent stands for: each taxed line at the amount the engine recovered. */
function derivedGridOf(d: Pick<Decomposed, 'date' | 'intent'>): GridLine[] {
  return padded(d.intent.map((l) => gridLineFromCompose(l, d.date, false)));
}

/** At least the two rows the grid always shows. */
function padded(lines: GridLine[]): GridLine[] {
  return lines.length >= 2 ? lines : [...lines, blankGridLine(), blankGridLine()].slice(0, 2);
}

/**
 * A stored entry (a draft, an agent's Vorschlag, `?entry=`) back in the composer, from the engine's
 * `decompose` answer, with no VAT figure read or made here (D152 amendment):
 *
 *  - it round-trips (and holds no line on a VAT account) with the two-line A1 shape: the Buchungssatz;
 *  - it round-trips otherwise: the derived grid, each taxed line at the amount the engine recovered;
 *  - else the MANUAL grid with the stored lines VERBATIM, stored traces included, locked to the manual path
 *    so nothing is re-derived; the engine's gate decides, and a refusal stands in place until the person
 *    edits the lines.
 */
export function reopenState(
  d: Pick<Decomposed, 'date' | 'lines' | 'intent' | 'roundTrips'>,
  accountOf: (id: string) => ComposerAccount | undefined,
): ReopenState {
  const derivedGrid = () => derivedGridOf(d);
  if (opensDerived(d, accountOf)) {
    const satz = satzFromIntent(d.intent, accountOf, d.date);
    if (satz !== null) {
      return {
        face: 'satz',
        satz: {
          soll: satz.soll,
          haben: satz.haben,
          amount: minorToDecimal(satz.amountMinor),
          taxCode: satz.taxCode,
          costCenter: satz.costCenter,
          costCenterOpen: satz.costCenter !== '',
          supplyDate: satz.supplyDate,
          statesSupplyDate: satz.statesSupplyDate,
        },
        lines: [blankGridLine(), blankGridLine()],
        manualLock: false,
      };
    }
    return { face: 'grid', lines: derivedGrid(), manualLock: false };
  }
  return {
    face: 'grid',
    lines: padded(d.lines.map((l) => gridLineFromCompose(l, d.date, true))),
    manualLock: true,
  };
}
