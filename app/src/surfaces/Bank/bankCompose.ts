/**
 * The bank inbox's request to the engine, and how its answer is read: an `accounts` booking previewed by
 * A02's `compose_entry` (`expand`), the composer's own read (D152 amendment, owner 02.10.2026).
 *
 * THE STUDIO DOES NO VAT MATH HERE EITHER. The bank queue used to derive its preview in the browser from
 * `vat_preview` figures (`composeAccountsPreview`, a hand copy of `buildAccountsLines`). The Journal
 * composer's rebuild showed what such a copy costs: three critic rounds, each one more path on which it
 * drifted from the engine by a Rappen. Now both surfaces ask the engine, and VAT is computed in one place.
 * This module only states the decision as `compose_entry` lines, and reads the answer's lines and
 * captions back into what the strip and the Soll/Haben table show. There is no tax figure, no rate, no
 * leg arrangement and no mirror in it.
 *
 * THE REQUEST IS THE DECISION `book_bank_line` POSTS (`bankBooking.ts buildAccountsLines`):
 *  - each leg is an INTENT line: its account, the leg's amount as a gross (Bezugsteuer reads it as the paid
 *    base, which the ENGINE knows from the code's kind), its code, and the side the money's direction puts
 *    it on (a leg runs with the line when its amount is positive, against it when negative; money arriving
 *    on the leg's account is a credit there). A taxed leg is priced at the line's booking date and states
 *    it as its Leistungsdatum, exactly as `book_bank_line` prices and stamps it;
 *  - the bank leg is ONE plain line on the Bankkonto's ledger account, the legs' signed sum (the line's own
 *    amount once the split adds up), first, as `book_bank_line` merges and places it;
 *  - the date is the line's booking date (else its value date), the one it is booked on.
 * `test/banking/bank-compose-parity.test.mjs` holds the whole path: for every decision of the bank suites
 * and a random sweep, the lines the engine answers for this request ARE the rows `book_bank_line` stores.
 *
 * `book_bank_line` takes no cost centre on a leg, so no request carries one.
 *
 * Root tests import this file through Node's type stripping, so it imports only TYPES, with explicit `.ts`
 * extensions, and nothing at runtime.
 */
import type { ComposeCaption, ComposeExpandOk, ComposeLine, IntentLine } from '../../../../src/core/ledger/compose.ts';
import type { LineInput } from '../../../../src/core/ledger/postEntry.ts';

/** One leg of an `accounts` decision, in the LINE's direction (a negative amount runs against it). */
export interface ComposeLeg {
  accountId: string;
  amountMinor: number;
  /** '' (or 'none') books the leg without VAT. */
  taxCode: string;
}

/** The facts of a bank line the request is made of. */
export interface ComposeBankLine {
  /** Signed: money in is positive. */
  amountMinor: number;
  bookingDate: string | null;
  valueDate: string | null;
}

/** A `compose_entry` `expand` request, minus the workspace and the mode. */
export interface BankComposeRequest {
  date: string;
  lines: ComposeLine[];
}

/** True when a leg books VAT: a code that is not the empty "Ohne MWST" (nor the engine's reserved `none`). */
export function isTaxedLeg(leg: Pick<ComposeLeg, 'taxCode'>): boolean {
  return leg.taxCode !== '' && leg.taxCode !== 'none';
}

/**
 * The `compose_entry` request for an `accounts` decision on a bank line, or null when there is nothing to
 * ask yet (no date, no Bankkonto ledger account, no leg with an account and an amount).
 */
export function bankComposeRequest(line: ComposeBankLine, legs: readonly ComposeLeg[], bankLedgerId: string | null): BankComposeRequest | null {
  const date = line.bookingDate ?? line.valueDate;
  if (date === null || bankLedgerId === null) return null;
  const used = legs.filter((l) => l.accountId !== '' && Number.isSafeInteger(l.amountMinor) && l.amountMinor !== 0);
  if (used.length === 0) return null;
  const moneyIn = line.amountMinor > 0;
  let bankSigned = 0;
  const legLines: ComposeLine[] = [];
  for (const leg of used) {
    const legIn = leg.amountMinor > 0 ? moneyIn : !moneyIn;
    const amount = Math.abs(leg.amountMinor);
    bankSigned += legIn ? amount : -amount;
    const intent: IntentLine = { account: leg.accountId, side: legIn ? 'credit' : 'debit', amount, gross: true };
    if (isTaxedLeg(leg)) {
      intent.taxCode = leg.taxCode;
      intent.supplyDate = date;
    }
    legLines.push(intent);
  }
  // Legs that cancel out (a half-typed split) move no money on the bank: no zero line is asked for.
  const bank: LineInput[] = bankSigned === 0 ? [] : [bankSigned > 0 ? { account: bankLedgerId, debit: bankSigned } : { account: bankLedgerId, credit: -bankSigned }];
  return { date, lines: [...bank, ...legLines] };
}

/** True when a request carries a taxed leg (an intent line with a code): the one kind a foreign-currency line refuses. */
export function requestIsTaxed(request: BankComposeRequest): boolean {
  return request.lines.some((l) => 'side' in l && typeof l.taxCode === 'string');
}

/** The key one request is answered under: an answer counts only while its signature is the current one. */
export function composeSignature(workspaceId: string, request: BankComposeRequest | null): string {
  return request === null ? '' : JSON.stringify([workspaceId, request.date, request.lines]);
}

// --- Reading the answer ---------------------------------------------------------------------------------

/** A successful `compose_entry` `expand` answer as it arrives on the wire. */
export type ComposeAnswer = ComposeExpandOk & { readonly ok: true };

/** One journal line the Soll/Haben table shows. */
export interface PreviewLine {
  accountId: string;
  debit: number;
  credit: number;
}

/** The engine's lines, as the table shows them (account, Soll, Haben), in the engine's order. */
export function previewLinesOf(answer: Pick<ComposeAnswer, 'lines'>): PreviewLine[] {
  return answer.lines.map((l) => ({ accountId: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
}

/** True when a set of lines balances (Soll equals Haben). */
export function previewBalances(lines: readonly PreviewLine[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  return debit === credit;
}

function okCaptions(answer: Pick<ComposeAnswer, 'captions'>): Extract<ComposeCaption, { ok: true }>[] {
  return answer.captions.filter((c): c is Extract<ComposeCaption, { ok: true }> => c !== null && c.ok);
}

/** The kinds of the taxed legs, as the engine priced them (A06: input, output, reverse_charge, import, ...). */
export function captionKinds(answer: Pick<ComposeAnswer, 'captions'>): string[] {
  return okCaptions(answer).map((c) => c.kind);
}

/**
 * The VAT accounts the answer books tax on, as its captions name them: every VAT leg of a taxed line, and
 * the account an Einfuhrsteuer books its whole amount to (the payment IS the tax there).
 */
export function vatAccountIdsOf(answer: Pick<ComposeAnswer, 'captions'>): Set<string> {
  const ids = new Set<string>();
  for (const c of okCaptions(answer)) {
    for (const leg of c.vatLegs) ids.add(leg.account);
    if (c.vatAccount !== null) ids.add(c.vatAccount);
  }
  return ids;
}

/** The VAT part of a composed booking, for the strip's one line ("davon MWST 6.74 auf 1170 · netto 83.16"). */
export interface VatSplit {
  /** Each VAT line of the answer: its account and its amount (positive), in the engine's order. */
  parts: { accountId: string; amountMinor: number }[];
  /**
   * What lands on the booked account(s), net of VAT (positive), or null when the booked lines run both
   * ways (a revenue less a fee netted out): no single "netto" describes that, so none is said.
   */
  netMinor: number | null;
}

/**
 * The split READ OFF the engine's lines: the lines on the answer's VAT accounts are the tax, every other line
 * but the bank's is the net, summed WITH its side (critic F5: a sum of absolute values called 120 less 20
 * "netto 131.01"). Null when the booking carries no VAT line. A reading of the engine's lines, no figure of
 * its own.
 */
export function vatSplitOf(lines: readonly PreviewLine[], bankLedgerId: string, vatAccountIds: ReadonlySet<string>): VatSplit | null {
  const parts: VatSplit['parts'] = [];
  let signed = 0;
  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    if (l.accountId === bankLedgerId) continue;
    const amount = l.debit - l.credit;
    if (vatAccountIds.has(l.accountId)) {
      parts.push({ accountId: l.accountId, amountMinor: Math.abs(amount) });
      continue;
    }
    signed += amount;
    if (amount > 0) debits += 1;
    if (amount < 0) credits += 1;
  }
  if (parts.length === 0) return null;
  return { parts, netMinor: debits > 0 && credits > 0 ? null : Math.abs(signed) };
}
