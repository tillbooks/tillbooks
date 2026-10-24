/**
 * D178 N2 (A39 §18.4): the facts a bank line carries beyond its date, amount and counterparty, as the facts
 * card reads them.
 *
 * THE STATEMENT FACTS ARRIVE WITH D178 POINTS 3 AND 4 (A39 §17, A20 §11.1): `list_bank_inbox` lines gain
 * `facts`, the bank transaction code with its SIX label, the bank texts as separate facts, the references,
 * the instructed amount, the exchange (the bank's rate and the effective rate), the charges and the derived
 * fee (`BankLineFacts`, `src/core/banking/statementFacts.ts`), or null for a line imported before the facts
 * were recorded. This module maps them onto the card's flat view and reads them defensively, so a field the
 * bank did not deliver is simply absent from the card.
 *
 * Pure: no React, no i18n. Every figure is the engine's (integer minor units, the bank's rate verbatim).
 */
import type { BankInboxLine } from './model';
import type { DuplicateCandidateView, PossibleDuplicateReason } from '../../../../src/core/banking/statementDedupe';

export interface StudioMoneyFact {
  amountMinor: number;
  currency: string;
}

export interface StudioBankCode {
  domain: string | null;
  family: string | null;
  subFamily: string | null;
  proprietary: string | null;
  issuer: string | null;
  label: { en: string; 'de-CH': string } | null;
}

export interface StudioExchange {
  sourceCurrency: string | null;
  targetCurrency: string | null;
  unitCurrency: string | null;
  /** The bank's rate, verbatim (a decimal string). */
  rate: string | null;
  /** TILL's effective rate (six decimals, fee included), a decimal string. */
  effectiveRate: string | null;
}

export interface StudioRefs {
  endToEndId: string | null;
  accountServicerRef: string | null;
  instructionId: string | null;
  transactionId: string | null;
}

export interface StudioFee {
  amountMinor: number;
  currency: string;
  included: boolean | null;
}

/** What the facts card reads, every field optional: a line imported before the facts were recorded has none. */
export interface StudioLineFacts {
  bankCode: StudioBankCode | null;
  bankText: string | null;
  additionalInfo: string | null;
  entryInfo: string | null;
  refs: StudioRefs;
  instructed: StudioMoneyFact | null;
  exchange: StudioExchange | null;
  /** The charges' total, when the bank stated one. */
  chargesTotal: StudioMoneyFact | null;
  fee: StudioFee | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}
function money(v: unknown): StudioMoneyFact | null {
  const r = rec(v);
  if (r === null) return null;
  const amountMinor = int(r.amountMinor);
  const currency = str(r.currency);
  return amountMinor === null || currency === null ? null : { amountMinor, currency };
}

/**
 * The line's statement facts, or null when it carries none (the field absent, null, or unreadable). Read
 * off the line as the engine sent it: `parseInbox` passes every field through.
 */
export function lineFactsOf(line: BankInboxLine): StudioLineFacts | null {
  const raw = rec(line.facts);
  if (raw === null) return null;
  const code = rec(raw.bankCode);
  const label = rec(code?.label);
  const refs = rec(raw.refs);
  const exchange = rec(raw.exchange);
  const charges = rec(raw.charges);
  const fee = rec(raw.fee);
  const chargesTotal = charges === null ? null : int(charges.totalMinor) !== null && str(charges.currency) !== null ? { amountMinor: charges.totalMinor as number, currency: charges.currency as string } : null;
  const feeAmount = fee === null ? null : int(fee.amountMinor);
  const feeCurrency = fee === null ? null : str(fee.currency);
  return {
    bankCode:
      code === null
        ? null
        : {
            domain: str(code.domain),
            family: str(code.family),
            subFamily: str(code.subFamily),
            proprietary: str(code.proprietary),
            issuer: str(code.issuer),
            label: label !== null && str(label.en) !== null && str(label['de-CH']) !== null ? { en: label.en as string, 'de-CH': label['de-CH'] as string } : null,
          },
    bankText: str(raw.bankText),
    additionalInfo: str(raw.additionalInfo),
    entryInfo: str(raw.entryInfo),
    refs: {
      endToEndId: str(refs?.endToEndId),
      accountServicerRef: str(refs?.accountServicerRef),
      instructionId: str(refs?.instructionId),
      transactionId: str(refs?.transactionId),
    },
    instructed: money(raw.instructed),
    exchange:
      exchange === null
        ? null
        : {
            sourceCurrency: str(exchange.sourceCurrency),
            targetCurrency: str(exchange.targetCurrency),
            unitCurrency: str(exchange.unitCurrency),
            rate: str(exchange.rate),
            effectiveRate: str(exchange.effectiveRate),
          },
    chargesTotal,
    fee: feeAmount === null || feeCurrency === null ? null : { amountMinor: feeAmount, currency: feeCurrency, included: typeof fee?.included === 'boolean' ? fee.included : null },
  };
}

/** "PMNT / RCDT / ESCT", or the proprietary code with its issuer ("ZKB 123"); null when the bank gave none. */
export function bankCodeText(code: StudioBankCode): string | null {
  const iso = [code.domain, code.family, code.subFamily].filter((x): x is string => x !== null);
  if (iso.length > 0) return iso.join(' / ');
  if (code.proprietary !== null) return code.issuer !== null ? `${code.issuer} ${code.proprietary}` : code.proprietary;
  return null;
}

/** True when the line has an exchange fact worth a line (a foreign amount, a rate, or a fee). */
export function hasFxFacts(facts: StudioLineFacts | null): boolean {
  if (facts === null) return false;
  return facts.instructed !== null || (facts.exchange !== null && (facts.exchange.rate !== null || facts.exchange.effectiveRate !== null)) || facts.fee !== null || facts.chargesTotal !== null;
}

// --- D178 point 19 (A20 §11.4): a line flagged as a possible duplicate ------------------------------
//
// Every `list_bank_inbox` line carries `needsDuplicateDecision`, `possibleDuplicates` (every stored line of
// another delivery or format it may be: id, reason, format, date, signed amount, currency) and
// `possibleDuplicateOf` (the nearest; `bankTxnId` null for a new line on a covered day), the engine's types.

export type DuplicateReason = PossibleDuplicateReason;
export type DuplicateCandidate = DuplicateCandidateView;

export interface DuplicateFlagView {
  /** The candidates, nearest first; empty for a new line on a covered day that matches nothing. */
  candidates: DuplicateCandidate[];
  /** The line's own reason (the nearest candidate's, or `covered_period_new_line`). */
  reason: DuplicateReason;
}

/** The duplicate question an open line waits on, or null when it waits on none. */
export function duplicateFlagOf(line: BankInboxLine): DuplicateFlagView | null {
  if (line.needsDuplicateDecision !== true || line.state !== 'open') return null;
  const candidates = line.possibleDuplicates ?? [];
  return { candidates, reason: line.possibleDuplicateOf?.reason ?? candidates[0]?.reason ?? 'covered_period_new_line' };
}
