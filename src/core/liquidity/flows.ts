/**
 * A40, the scheduled flows (spec §4.2): every cash movement the books already know about, in ONE
 * currency, dated to the clearing day it will actually hit the bank.
 *
 * THIS MODULE WRITES NOTHING. It reads A19 (bank accounts and their ledger balances), A16 (open
 * receivables), A14 (the payment history the delay model reads), A17 (open payables), A18 (live
 * payment runs), A12 (active schedules), A07 through `vat.ts` (the MWST periods, their returns and the
 * opening position: one chokepoint) and A40's own
 * planned flows, and composes them. Every query filters `workspace_id` (§H-TENANT).
 *
 * THE CONSERVATIVE DIRECTION, everywhere a date must be chosen: an inflow lands on the first clearing
 * day ON OR AFTER its expected date, an outflow on the last clearing day ON OR BEFORE its date (never
 * before today), and an overdue payable is assumed paid today. A forecast that is wrong in that
 * direction keeps a floor safe; one that is wrong the other way breaches it.
 *
 * NOTHING IS SILENTLY DROPPED. A flow in another currency, a receivable later than every observed
 * delay, an MWST period that cannot be computed: each lands in `excluded` with its reason, so the
 * forecast states what it did not count.
 *
 * NO FX. The forecast is per currency and never converts: a CHF forecast holds CHF accounts and CHF
 * flows, an EUR forecast EUR ones. Converting at a guessed rate would put a number under the floor
 * that no bank statement will ever show.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { listOpenItems } from '../debtors/index.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import { resolveContactRef } from '../sales/contact.js';
import { liveBatchOfBill } from '../banking/pain001.js';
import { computeLineTax } from '../vat/applyVat.js';
import { MAX_OCCURRENCE_STEPS, occurrenceAt } from '../recurring/dates.js';
import {
  addDays,
  clearingDayOnOrAfter,
  clearingDayOnOrBefore,
  daysBetween,
  lastExecutionFor,
} from './calendar.js';
import { expectedDelay, readDelayHistory } from './delay.js';
import { skontoMinor } from './optimise.js';
import type { DelayHistory } from './delay.js';
import { resolveSkonto } from './terms.js';
import type { ResolvedSkonto } from './terms.js';
import { occurrencesWithin } from './plannedFlows.js';
import { vatObligations } from './vat.js';
import type { PlannedFlowRow } from './plannedFlows.js';

/** §H-ENUM: where a flow comes from. */
export const FLOW_KINDS = ['booked', 'receivable', 'recurring', 'vat', 'planned', 'payable', 'payment_run'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

/** The horizon bounds (spec §4.5). */
export const HORIZON_MIN_DAYS = 7;
export const HORIZON_MAX_DAYS = 366;
export const HORIZON_DEFAULT_DAYS = 90;
export const DELAY_QUANTILE_MIN = 50;
export const DELAY_QUANTILE_MAX = 95;
export const DELAY_QUANTILE_DEFAULT = 80;
export const LAG_MAX_DAYS = 5;
export const LAG_DEFAULT_DAYS = 1;
/** Assumed payment terms when a document carries no due date (the common Swiss "30 Tage netto"). */
export const DEFAULT_TERMS_DAYS = 30;
/** MWSTG Art. 86 Abs. 1 (the MWST chokepoint, `vat.ts`, owns it). */
export { VAT_DUE_DAYS } from './vat.js';

export interface FlowEvent {
  date: string;
  /** Signed: positive in, negative out. */
  amountMinor: number;
  kind: FlowKind;
  ref: string | null;
  label: string | null;
  /** How the date or amount was derived, in one code. */
  provenance: string;
}

/** §H-ENUM: why an amount was debited CONSERVATIVELY (owner decision 01.10.2026, critic R4-M1). */
export const CONSERVATIVE_REASONS = ['vat_return_refused', 'vat_unattributed', 'vat_input_not_settled'] as const;
export type ConservativeReason = (typeof CONSERVATIVE_REASONS)[number];

/**
 * An amount the forecast debits although the books cannot say exactly what it is, dated on the earliest
 * plausible day: shown as its own line beside the forecast AND every proposal, never only under a chart.
 */
export interface ConservativeLine {
  kind: 'vat';
  reason: ConservativeReason;
  /** The MWST period it is debited with, or null (booked before the window: debited today). */
  ref: string | null;
  amountMinor: number;
  /** The day the forecast debits it. */
  date: string;
  /** That period's due date (MWSTG Art. 86 Abs. 1), or null. */
  dueDate: string | null;
  /** A07's refusal code for `vat_return_refused` (e.g. `unsupported` under vereinnahmte Entgelte). */
  refusal: string | null;
}

export interface ExcludedFlow {
  kind: FlowKind;
  reason: string;
  ref: string | null;
  currency: string | null;
  amountMinor: number | null;
}

/** An open payable that is NOT yet in a live payment run: the optimiser's decision set. */
export interface PayableCandidate {
  billId: string;
  vendorId: string;
  vendorName: string | null;
  billDate: string;
  dueDate: string;
  dueAssumed: boolean;
  openMinor: number;
  skonto: ResolvedSkonto;
}

export interface FlowParams {
  currency: string;
  horizonDays: number;
  delayQuantile: number;
  settlementLagDays: number;
  bankAccountIds: string[] | null;
}

export interface FlowModel {
  asOf: string;
  horizonEnd: string;
  dates: string[];
  params: FlowParams;
  baseCurrency: string;
  openingBalanceMinor: number;
  accounts: { bankAccountId: string; name: string; balanceMinor: number }[];
  /** Every dated flow except the undecided payables. */
  fixedFlows: FlowEvent[];
  /** The undecided payables (their default date is `payableDefaultFlow`). */
  payables: PayableCandidate[];
  /**
   * Bills whose only open amount is a Skonto the supplier conceded (paid inside the window, less the
   * Skonto): A14 cannot yet book a purchase-side Skonto, so the remainder stays open in A17. It is owed
   * to nobody, so it is never a flow and never drafted (critic M3).
   */
  skontoRemainders: { billId: string; vendorId: string; openMinor: number; skontoUntil: string }[];
  excluded: ExcludedFlow[];
  /** What is debited conservatively, each with its reason (critic R4-M1). */
  conservative: ConservativeLine[];
}

export interface FlowParamsInput {
  currency?: string;
  horizonDays?: number;
  delayQuantile?: number;
  settlementLagDays?: number;
  bankAccountIds?: string[];
}

/** Validate and default the shared parameters. */
export function readFlowParams(ctx: WorkspaceContext, input: FlowParamsInput): FlowParams | Result {
  const base = baseCurrencyOf(ctx);
  const currency = input.currency ?? base;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return err('invalid_input', { field: 'currency' });
  const intIn = (v: unknown, field: string, min: number, max: number, dflt: number): number | Result => {
    if (v === undefined) return dflt;
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) return err('invalid_input', { field, min, max });
    return v as number;
  };
  const horizonDays = intIn(input.horizonDays, 'horizonDays', HORIZON_MIN_DAYS, HORIZON_MAX_DAYS, HORIZON_DEFAULT_DAYS);
  if (typeof horizonDays !== 'number') return horizonDays;
  const delayQuantile = intIn(input.delayQuantile, 'delayQuantile', DELAY_QUANTILE_MIN, DELAY_QUANTILE_MAX, DELAY_QUANTILE_DEFAULT);
  if (typeof delayQuantile !== 'number') return delayQuantile;
  const settlementLagDays = intIn(input.settlementLagDays, 'settlementLagDays', 0, LAG_MAX_DAYS, LAG_DEFAULT_DAYS);
  if (typeof settlementLagDays !== 'number') return settlementLagDays;
  let bankAccountIds: string[] | null = null;
  if (input.bankAccountIds !== undefined) {
    if (
      !Array.isArray(input.bankAccountIds) ||
      input.bankAccountIds.length === 0 ||
      !input.bankAccountIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      return err('invalid_input', { field: 'bankAccountIds' });
    }
    bankAccountIds = [...new Set(input.bankAccountIds)].sort();
  }
  return { currency, horizonDays, delayQuantile, settlementLagDays, bankAccountIds };
}

/** The injected clock's day (never the wall clock). */
export function todayOf(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** `quantity_milli * unit_price_minor / 1000`, half away from zero: A10's own line arithmetic. */
function lineNet(quantityMilli: number, unitPriceMinor: number): number {
  const scaled = quantityMilli * unitPriceMinor;
  return scaled < 0 ? -Math.round(-scaled / 1000) : Math.round(scaled / 1000);
}

/** Gather every scheduled flow (spec §4.2). */
export function gatherFlows(ctx: WorkspaceContext, params: FlowParams): FlowModel | Result {
  const asOf = todayOf(ctx);
  const horizonEnd = addDays(asOf, params.horizonDays - 1);
  const dates: string[] = [];
  for (let i = 0; i < params.horizonDays; i += 1) dates.push(addDays(asOf, i));
  const firstClearing = clearingDayOnOrAfter(asOf);
  const inDate = (d: string): string => clearingDayOnOrAfter(d < asOf ? asOf : d);
  const outDate = (d: string): string => {
    const back = clearingDayOnOrBefore(d);
    return back < asOf ? firstClearing : back;
  };
  const baseCurrency = baseCurrencyOf(ctx);
  const excluded: ExcludedFlow[] = [];
  const conservative: ConservativeLine[] = [];
  const fixedFlows: FlowEvent[] = [];

  // --- Opening balance: the posted ledger balance of the bank accounts in the currency. ---------
  const accountRows = ctx.store.db
    .prepare(
      `SELECT id, name, currency, ledger_account_id FROM bank_account
        WHERE workspace_id = ? AND archived = 0 AND currency = ? ORDER BY name, id`,
    )
    .all(ctx.workspaceId, params.currency) as { id: string; name: string; currency: string; ledger_account_id: string }[];
  const chosen =
    params.bankAccountIds === null ? accountRows : accountRows.filter((a) => (params.bankAccountIds as string[]).includes(a.id));
  if (params.bankAccountIds !== null && chosen.length !== params.bankAccountIds.length) {
    return err('not_found', {
      field: 'bankAccountIds',
      reason: 'every id must name a non-archived bank account of this workspace in the forecast currency',
    });
  }
  if (chosen.length === 0) return err('needs_bank_account', { currency: params.currency });
  const balanceOf = ctx.store.db.prepare(
    `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS bal
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ? AND l.account_id = ? AND l.currency = ?`,
  );
  const seenLedger = new Set<string>();
  const accounts: FlowModel['accounts'] = [];
  let opening = 0;
  for (const a of chosen) {
    // Two bank accounts may book to one ledger account: its balance is counted once.
    const bal = seenLedger.has(a.ledger_account_id)
      ? 0
      : ((balanceOf.get(ctx.workspaceId, asOf, a.ledger_account_id, params.currency) as { bal: number }).bal);
    seenLedger.add(a.ledger_account_id);
    accounts.push({ bankAccountId: a.id, name: a.name, balanceMinor: bal });
    opening += bal;
  }

  // WHICH ACCOUNT A FLOW MOVES (critic R2-M2). Solved on chosen accounts (a strict subset of this
  // currency's accounts), a flow counts only where it lands: customer receipts on the account whose
  // IBAN the QR-bill carries (`workspace.creditor_iban`), a live A18 run on its own debit account, a
  // planned flow on the account it names. One that lands elsewhere is named (`other_account`). One whose
  // account the books cannot know (MWST, a planned flow with no account, receipts when no account
  // carries the creditor IBAN) is counted on the chosen accounts and tagged `account_unknown`, so the
  // forecast says so rather than claiming the floor holds for this account alone.
  const partial = params.bankAccountIds !== null && chosen.length < accountRows.length;
  const chosenLedgers = new Set(chosen.map((a) => a.ledger_account_id));
  const ledgerOfAccount = (bankAccountId: string | null): string | null => {
    if (bankAccountId === null) return null;
    const row = ctx.store.db
      .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, bankAccountId) as { ledger_account_id: string } | undefined;
    return row?.ledger_account_id ?? null;
  };
  const receivingLedger: string | null = (() => {
    const ws = ctx.store.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get(ctx.workspaceId) as
      | { creditor_iban: string | null }
      | undefined;
    const iban = ws?.creditor_iban ?? null;
    if (iban === null || iban.trim() === '') return null;
    const norm = (x: string): string => x.replace(/\s+/g, '').toUpperCase();
    const all = ctx.store.db
      .prepare('SELECT iban, ledger_account_id FROM bank_account WHERE workspace_id = ? ORDER BY id')
      .all(ctx.workspaceId) as { iban: string; ledger_account_id: string }[];
    return all.find((a) => norm(a.iban) === norm(iban))?.ledger_account_id ?? null;
  })();
  /** 'here' counts plainly, 'unknown' counts tagged, 'elsewhere' is named and not counted. */
  const place = (ledgerId: string | null): 'here' | 'unknown' | 'elsewhere' =>
    !partial ? 'here' : ledgerId === null ? 'unknown' : chosenLedgers.has(ledgerId) ? 'here' : 'elsewhere';
  const tag = (where: 'here' | 'unknown' | 'elsewhere'): string => (where === 'unknown' ? '+account_unknown' : '');
  const receipts = place(receivingLedger);

  // Postings on those same bank ledger accounts dated AFTER today (critic M2): salaries booked ahead,
  // a run marked paid with a future value date. The ledger already knows these move the bank on their
  // date, so each posted entry is a `booked` flow on it (and, being a flow, enters the inputs hash).
  const ledgerIds = [...seenLedger];
  if (ledgerIds.length > 0) {
    const later = ctx.store.db
      .prepare(
        `SELECT e.id AS entryId, e.date AS date, e.description AS description,
                SUM(l.debit_minor - l.credit_minor) AS amount
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date > ? AND e.date <= ? AND l.currency = ?
            AND l.account_id IN (${ledgerIds.map(() => '?').join(', ')})
          GROUP BY e.id, e.date, e.description
          ORDER BY e.date, e.id`,
      )
      .all(ctx.workspaceId, asOf, horizonEnd, params.currency, ...ledgerIds) as {
      entryId: string;
      date: string;
      description: string | null;
      amount: number;
    }[];
    for (const b of later) {
      if (b.amount === 0) continue;
      fixedFlows.push({ date: b.date, amountMinor: b.amount, kind: 'booked', ref: b.entryId, label: b.description, provenance: 'posted_future' });
    }
  }

  const history: DelayHistory = readDelayHistory(ctx, asOf);
  const arrivalFor = (customerId: string | null, due: string): { date: string; provenance: string } | { reason: string } => {
    const own = customerId === null ? [] : (history.byCustomer.get(customerId) ?? []);
    const answer = expectedDelay(own, history.pooled, params.delayQuantile, daysBetween(due, asOf));
    if (!answer.ok) return { reason: answer.reason };
    return { date: inDate(addDays(due, answer.delayDays)), provenance: `delay_${answer.source}_${answer.delayDays}` };
  };

  // --- Receivables (A16). ----------------------------------------------------------------------
  const open = listOpenItems(ctx, { asOf });
  // What stays open once every POSTED payment counts, future-dated ones included: a customer payment
  // booked ahead is already a `booked` inflow above, so the receivable must not be counted a second time.
  const later = listOpenItems(ctx, { asOf: '9999-12-31' });
  const openLater = new Map<string, number>();
  if (later.ok) {
    for (const it of later.items as ReadonlyArray<Record<string, unknown>>) {
      if (it.kind === 'document' && typeof it.documentId === 'string') openLater.set(it.documentId, it.openMinor as number);
    }
  }
  if (open.ok) {
    for (const item of open.items as ReadonlyArray<Record<string, unknown>>) {
      if (item.kind !== 'document') {
        // A parked customer payment (Guthaben) is money already on the bank or owed back: nothing
        // schedules it, so it is named rather than skipped (critic L4).
        if (item.kind === 'on_account' && (item.openMinor as number) !== 0) {
          excluded.push({
            kind: 'receivable',
            reason: 'customer_credit',
            ref: (item.paymentId as string | null) ?? null,
            currency: item.currency as string,
            amountMinor: item.openMinor as number,
          });
        }
        continue;
      }
      const ref = item.documentId as string;
      const openToday = item.openMinor as number;
      const openMinor = openToday > 0 && later.ok ? Math.min(openToday, openLater.get(ref) ?? 0) : openToday;
      if (openMinor === 0) continue;
      if (openMinor < 0) {
        // A credit balance (an open Gutschrift) may become a refund, but nothing schedules it: said, not guessed.
        excluded.push({ kind: 'receivable', reason: 'credit_balance', ref, currency: item.currency as string, amountMinor: openMinor });
        continue;
      }
      if (item.currency !== params.currency) {
        excluded.push({ kind: 'receivable', reason: 'other_currency', ref, currency: item.currency as string, amountMinor: openMinor });
        continue;
      }
      let due = item.dueDate as string | null;
      let provenance = '';
      if (due === null) {
        const issue = item.issueDate as string | null;
        if (issue === null) {
          excluded.push({ kind: 'receivable', reason: 'no_due_date', ref, currency: params.currency, amountMinor: openMinor });
          continue;
        }
        due = addDays(issue, DEFAULT_TERMS_DAYS);
        provenance = 'assumed_terms+';
      }
      const arrival = arrivalFor(item.customerId as string | null, due);
      if ('reason' in arrival) {
        excluded.push({ kind: 'receivable', reason: arrival.reason, ref, currency: params.currency, amountMinor: openMinor });
        continue;
      }
      if (arrival.date > horizonEnd) continue;
      if (receipts === 'elsewhere') {
        excluded.push({ kind: 'receivable', reason: 'other_account', ref, currency: params.currency, amountMinor: openMinor });
        continue;
      }
      fixedFlows.push({
        date: arrival.date,
        amountMinor: openMinor,
        kind: 'receivable',
        ref,
        label: [item.number, item.customerName].filter((x) => typeof x === 'string' && x.length > 0).join(' · ') || null,
        provenance: provenance + arrival.provenance + tag(receipts),
      });
    }
  }

  // --- Recurring invoices (A12), the occurrences not yet generated. ------------------------------
  // Their output tax, by supply date, feeds the MWST block below (critic M1).
  const recurringTax: { date: string; taxMinor: number }[] = [];
  const schedules = ctx.store.db
    .prepare(
      `SELECT s.id, s.name, s.contact_id, s.lines_json, s.currency, s.due_days, s.interval, s.custom_days,
              s.anchor_date, s.next_run_date, s.end_date, s.max_occurrences, s.occurrences_done, c.name AS contact_name
         FROM recurring_schedule s LEFT JOIN contact c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
        WHERE s.workspace_id = ? AND s.status = 'active' ORDER BY s.id`,
    )
    .all(ctx.workspaceId) as {
    id: string;
    name: string | null;
    contact_id: string;
    lines_json: string;
    currency: string | null;
    due_days: number | null;
    interval: 'monthly' | 'quarterly' | 'yearly' | 'custom';
    custom_days: number | null;
    anchor_date: string;
    next_run_date: string;
    end_date: string | null;
    max_occurrences: number | null;
    occurrences_done: number;
    contact_name: string | null;
  }[];
  for (const s of schedules) {
    const currency = s.currency ?? baseCurrency;
    let lines: { quantityMilli?: number; unitPriceMinor: number; taxCode?: string | null }[];
    try {
      const parsed = JSON.parse(s.lines_json) as unknown;
      lines = Array.isArray(parsed) ? (parsed as typeof lines) : [];
    } catch {
      lines = [];
    }
    if (currency !== params.currency) {
      excluded.push({ kind: 'recurring', reason: 'other_currency', ref: s.id, currency, amountMinor: null });
      continue;
    }
    let done = s.occurrences_done;
    // A12's own bound: a bounded walk from the anchor, never a closed-form solve.
    for (let n = 0; n <= MAX_OCCURRENCE_STEPS; n += 1) {
      const occ = occurrenceAt(s.anchor_date, s.interval, s.custom_days, n);
      if (occ < s.next_run_date) continue;
      if (occ > horizonEnd) break;
      if (s.end_date !== null && occ > s.end_date) break;
      if (s.max_occurrences !== null && done >= s.max_occurrences) break;
      done += 1;
      let gross = 0;
      let outputTax = 0;
      let taxKnown = true;
      for (const line of lines) {
        const net = lineNet(typeof line.quantityMilli === 'number' ? line.quantityMilli : 1000, line.unitPriceMinor);
        if (line.taxCode === undefined || line.taxCode === null || line.taxCode === 'none') {
          gross += net;
          continue;
        }
        const tax = computeLineTax(ctx, { amountMinor: net, amountIsGross: false, taxCode: line.taxCode, supplyDate: occ });
        if (tax.ok) {
          gross += tax.grossMinor as number;
          if (tax.kind === 'output') outputTax += tax.taxMinor as number;
        } else {
          gross += net;
          taxKnown = false;
        }
      }
      if (gross <= 0) continue;
      // The output tax of this occurrence is owed with its MWST period whether or not the customer pays
      // inside the horizon (critic M1), so it is recorded BEFORE the arrival is looked at.
      if (outputTax !== 0 && currency === baseCurrency) recurringTax.push({ date: occ, taxMinor: outputTax });
      const due = addDays(occ, s.due_days ?? DEFAULT_TERMS_DAYS);
      const arrival = arrivalFor(s.contact_id, due);
      if ('reason' in arrival) {
        excluded.push({ kind: 'recurring', reason: arrival.reason, ref: `${s.id}@${occ}`, currency, amountMinor: gross });
        continue;
      }
      if (arrival.date > horizonEnd) continue;
      if (receipts === 'elsewhere') {
        excluded.push({ kind: 'recurring', reason: 'other_account', ref: `${s.id}@${occ}`, currency, amountMinor: gross });
        continue;
      }
      fixedFlows.push({
        date: arrival.date,
        amountMinor: gross,
        kind: 'recurring',
        ref: `${s.id}@${occ}`,
        label: s.name ?? s.contact_name,
        provenance: `${taxKnown ? 'gross' : 'net_tax_unknown'}+${arrival.provenance}${tag(receipts)}`,
      });
    }
  }

  // --- MWST (A07), base currency only: ONE chokepoint, `vat.ts` (rebuild, critic R3-M1, R3-L1). ----
  // Per period: what A07's return says it owes plus the opening position A04 carried into it, under
  // the ledger's open liability (effektiv), plus the output tax of the recurring occurrences this
  // forecast counts inside it (critic M1: an inflow counted gross never leaves its tax behind). ESTV
  // counts receipt, so the debit sits on the last clearing day that still ARRIVES by the due date.
  //
  // CONSERVATIVE, AND SAID (owner decision of 01.10.2026, critic R4-M1): a period A07 refuses still
  // owes the tax its tagged entries booked, and liability no period explains is owed with the period it
  // was booked in (or today). Both are debited, never dropped from the floor proof, and each one is a
  // line of its own in `conservative`, which the forecast and every proposal carry.
  if (params.currency === baseCurrency) {
    const obligations = vatObligations(ctx, asOf, horizonEnd);
    if (!obligations.configured) {
      excluded.push({ kind: 'vat', reason: 'vat_not_configured', ref: null, currency: baseCurrency, amountMinor: null });
    }
    const taxIn = (start: string, end: string): number =>
      recurringTax.filter((r) => r.date >= start && r.date <= end).reduce((sum, r) => sum + r.taxMinor, 0);
    /** The conservative lines of one period's debit, on the day it is debited. */
    const said = (p: (typeof obligations.periods)[number], date: string): void => {
      if (p.refusal !== null && p.openMinor > 0) {
        conservative.push({ kind: 'vat', reason: 'vat_return_refused', ref: p.label, amountMinor: p.openMinor, date, dueDate: p.dueDate, refusal: p.refusal });
      }
      if (p.unattributedMinor > 0) {
        conservative.push({ kind: 'vat', reason: 'vat_unattributed', ref: p.label, amountMinor: p.unattributedMinor, date, dueDate: p.dueDate, refusal: null });
      }
    };
    // Critic R6-L1: a computed effektiv period past its due date that the output cap still debits while
    // Vorsteuer stands on 1170/1171 may have been paid NET from 2200 with the Vorsteuer not yet settled.
    // The amount stays (the safe direction); the line says why and how it goes away.
    let inputOpen = obligations.inputVatOpenMinor;
    const inputNotSettled = (p: (typeof obligations.periods)[number]): number => {
      if (p.refusal !== null || p.method !== 'effektiv' || !p.capped || p.openMinor <= 0) return 0;
      const amount = Math.min(p.openMinor, inputOpen);
      inputOpen -= amount;
      return amount;
    };
    const mark = (p: (typeof obligations.periods)[number]): string =>
      (p.openingMinor > 0 ? '+opening_balance' : '') + (p.refusal !== null && p.openMinor > 0 ? '+vat_return_refused' : '') + (p.unattributedMinor > 0 ? '+vat_unattributed' : '');
    for (const p of obligations.periods) {
      // A refused period with no output tax booked in it can still owe what A07 cannot compute: named.
      if (p.refusal !== null && p.claimMinor === 0 && p.started) {
        excluded.push({ kind: 'vat', reason: p.refusal, ref: p.label, currency: baseCurrency, amountMinor: null });
      }
      if (p.dueDate < asOf) {
        // Past its due date. Every capped claim (effektiv, refused, unexplained) still open is overdue,
        // debited today. A computed Saldo period is uncapped (the ledger cannot show its payment), so it is
        // named, never assumed paid and never debited again.
        const owed = (p.capped ? p.openMinor : 0) + p.unattributedMinor;
        if (owed > 0) {
          fixedFlows.push({
            date: firstClearing,
            amountMinor: -owed,
            kind: 'vat',
            ref: p.label,
            label: p.label,
            provenance: `vat_overdue${mark(p)}${tag(place(null))}`,
          });
          said(p, firstClearing);
          const unsettled = inputNotSettled(p);
          if (unsettled > 0) {
            conservative.push({ kind: 'vat', reason: 'vat_input_not_settled', ref: p.label, amountMinor: unsettled, date: firstClearing, dueDate: p.dueDate, refusal: null });
          }
        }
        if (p.capped) continue;
        if (!p.filed) {
          excluded.push({ kind: 'vat', reason: 'vat_period_overdue', ref: p.label, currency: baseCurrency, amountMinor: null });
        } else if (p.openMinor > 0) {
          excluded.push({ kind: 'vat', reason: 'vat_period_filed_payment_unknown', ref: p.label, currency: baseCurrency, amountMinor: p.openMinor });
        }
        continue;
      }
      const scheduled = taxIn(p.periodStart, p.periodEnd);
      const amount = p.openMinor + p.unattributedMinor + scheduled;
      if (p.dueDate > horizonEnd) {
        // Due after the horizon: named with what is known of it, never silently dropped.
        if (amount > 0) {
          excluded.push({ kind: 'vat', reason: 'vat_due_beyond_horizon', ref: p.label, currency: baseCurrency, amountMinor: amount });
        }
        continue;
      }
      if (!p.started) {
        excluded.push({ kind: 'vat', reason: 'vat_period_not_started', ref: p.label, currency: baseCurrency, amountMinor: amount });
      }
      if (amount <= 0) continue;
      const date = outDate(lastExecutionFor(p.dueDate, params.settlementLagDays));
      const base = !p.started ? 'scheduled_only' : p.periodEnd > asOf ? 'posted_to_date+scheduled' : 'period_complete';
      fixedFlows.push({
        date,
        amountMinor: -amount,
        kind: 'vat',
        ref: p.label,
        label: p.label,
        provenance: `${base}${mark(p)}${tag(place(null))}`,
      });
      said(p, date);
    }
    if (obligations.unattributedMinor > 0) {
      // Booked before the window: no period to date it by, so today (the earliest plausible day).
      fixedFlows.push({
        date: firstClearing,
        amountMinor: -obligations.unattributedMinor,
        kind: 'vat',
        ref: null,
        label: null,
        provenance: `vat_unattributed${tag(place(null))}`,
      });
      conservative.push({ kind: 'vat', reason: 'vat_unattributed', ref: null, amountMinor: obligations.unattributedMinor, date: firstClearing, dueDate: null, refusal: null });
    }
  }

  // --- Planned flows (A40). ------------------------------------------------------------------------
  const planned = ctx.store.db
    .prepare('SELECT * FROM planned_flow WHERE workspace_id = ? AND active = 1 ORDER BY id')
    .all(ctx.workspaceId) as PlannedFlowRow[];
  for (const f of planned) {
    if (f.currency !== params.currency) {
      excluded.push({ kind: 'planned', reason: 'other_currency', ref: f.id, currency: f.currency, amountMinor: f.amount_minor });
      continue;
    }
    const where = place(ledgerOfAccount(f.bank_account_id));
    let counted = false;
    for (const d of occurrencesWithin(f, asOf, horizonEnd)) {
      const date = f.direction === 'in' ? inDate(d) : outDate(d);
      if (date > horizonEnd) continue;
      counted = true;
      if (where === 'elsewhere') continue;
      fixedFlows.push({
        date,
        amountMinor: f.direction === 'in' ? f.amount_minor : -f.amount_minor,
        kind: 'planned',
        ref: `${f.id}@${d}`,
        label: f.label,
        provenance: `planned${tag(where)}`,
      });
    }
    if (where === 'elsewhere' && counted) {
      excluded.push({ kind: 'planned', reason: 'other_account', ref: f.id, currency: f.currency, amountMinor: f.amount_minor });
    }
  }

  // --- Payables (A17) and the live payment runs (A18). ---------------------------------------------
  // EVERY open bill, never a page of them (critic H2): A17's list verb stops at its newest 1'000 rows,
  // and the bills that fall off it are the OLDEST, which are exactly the overdue ones.
  const payables: PayableCandidate[] = [];
  const skontoRemainders: FlowModel['skontoRemainders'] = [];
  {
    const openBills = readOpenPayables(ctx);
    const skonto = resolveSkonto(
      ctx,
      openBills.map((b) => ({ id: b.id, vendorId: b.vendorId, billDate: b.billDate })),
    );
    const batchItem = ctx.store.db.prepare(
      `SELECT pbi.amount_minor AS amount, pb.execution_date AS exec, ba.ledger_account_id AS ledger
         FROM payment_batch_item pbi JOIN payment_batch pb ON pb.id = pbi.batch_id AND pb.workspace_id = pbi.workspace_id
         LEFT JOIN bank_account ba ON ba.id = pb.bank_account_id AND ba.workspace_id = pb.workspace_id
        WHERE pbi.workspace_id = ? AND pb.id = ? AND pbi.vendor_bill_id = ?`,
    );
    for (const b of openBills) {
      const id = b.id;
      const openMinor = b.openMinor;
      if (b.currency !== params.currency) {
        excluded.push({ kind: 'payable', reason: 'other_currency', ref: id, currency: b.currency, amountMinor: openMinor });
        continue;
      }
      const batchId = liveBatchOfBill(ctx, id);
      if (batchId !== null) {
        const item = batchItem.get(ctx.workspaceId, batchId, id) as { amount: number; exec: string; ledger: string | null } | undefined;
        if (item === undefined) {
          excluded.push({ kind: 'payment_run', reason: 'run_item_missing', ref: id, currency: b.currency, amountMinor: openMinor });
          continue;
        }
        const date = item.exec < asOf ? firstClearing : clearingDayOnOrAfter(item.exec);
        if (date > horizonEnd) continue;
        const debits = place(item.ledger);
        if (debits === 'elsewhere') {
          // A run debiting another account moves that account, not this one: named, and the bill is
          // not a candidate either (it already sits in a live run).
          excluded.push({ kind: 'payment_run', reason: 'other_account', ref: id, currency: b.currency, amountMinor: item.amount });
          continue;
        }
        fixedFlows.push({
          date,
          amountMinor: -item.amount,
          kind: 'payment_run',
          ref: id,
          label: b.vendorName,
          provenance: `batch_${batchId}${tag(debits)}`,
        });
        continue;
      }
      const terms = skonto.get(id) as ResolvedSkonto;
      if (isSkontoRemainder(ctx, b, terms)) {
        excluded.push({ kind: 'payable', reason: 'skonto_remainder', ref: id, currency: b.currency, amountMinor: openMinor });
        skontoRemainders.push({ billId: id, vendorId: b.vendorId, openMinor, skontoUntil: terms.untilDate as string });
        continue;
      }
      const dueRaw = b.dueDate;
      const billDate = b.billDate;
      payables.push({
        billId: id,
        vendorId: b.vendorId,
        vendorName: b.vendorName,
        billDate,
        dueDate: dueRaw ?? addDays(billDate, DEFAULT_TERMS_DAYS),
        dueAssumed: dueRaw === null,
        openMinor,
        skonto: skonto.get(id) as ResolvedSkonto,
      });
    }
  }
  payables.sort((x, y) => (x.billId < y.billId ? -1 : x.billId > y.billId ? 1 : 0));

  fixedFlows.sort(compareFlows);
  excluded.sort((x, y) => (x.kind + (x.ref ?? '') + x.reason < y.kind + (y.ref ?? '') + y.reason ? -1 : 1));
  return {
    asOf,
    horizonEnd,
    dates,
    params,
    baseCurrency,
    openingBalanceMinor: opening,
    accounts,
    fixedFlows,
    payables,
    skontoRemainders,
    excluded,
    conservative,
  };
}

/**
 * Is this bill's open amount only the Skonto the supplier conceded? True when a Skonto applies, a
 * POSTED payment reached the bill on or before the Skonto date, and what is still open is no more than
 * the Skonto on the full amount. A14 refuses a purchase-side Skonto today, so such a remainder cannot
 * be booked off yet; paying it would hand the supplier the deduction they granted (critic M3).
 */
function isSkontoRemainder(ctx: WorkspaceContext, b: OpenPayable, terms: ResolvedSkonto): boolean {
  if (terms.rateBp <= 0 || terms.untilDate === null) return false;
  if (b.openMinor > skontoMinor(b.payableMinor, terms.rateBp)) return false;
  const paidInWindow = ctx.store.db
    .prepare(
      `SELECT 1 AS x FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.target_kind = 'vendor_bill' AND a.target_id = ?
          AND p.status = 'posted' AND p.date <= ? LIMIT 1`,
    )
    .get(ctx.workspaceId, b.id, terms.untilDate);
  return paidInWindow !== undefined;
}

/** One open A17 bill, read without a ceiling. */
export interface OpenPayable {
  id: string;
  vendorId: string;
  vendorName: string | null;
  billDate: string;
  dueDate: string | null;
  currency: string;
  payableMinor: number;
  openMinor: number;
  vendorReference: string | null;
}

/**
 * Every POSTED bill with an open amount, oldest first, with NO row ceiling (critic H2). The open amount
 * is A17's own derivation (`settledOnVendorBill`, the posted allocations of posted payments), never a
 * second one; the vendor is resolved through a merge the way A17's read model resolves it.
 */
export function readOpenPayables(ctx: WorkspaceContext): OpenPayable[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, contact_id, bill_date, due_date, currency, payable_minor, vendor_reference
         FROM vendor_bill WHERE workspace_id = ? AND status = 'posted' ORDER BY bill_date, id`,
    )
    .all(ctx.workspaceId) as {
    id: string;
    contact_id: string;
    bill_date: string;
    due_date: string | null;
    currency: string;
    payable_minor: number;
    vendor_reference: string | null;
  }[];
  const out: OpenPayable[] = [];
  for (const r of rows) {
    const openMinor = r.payable_minor - settledOnVendorBill(ctx, r.id);
    if (openMinor <= 0) continue;
    const party = resolveContactRef(ctx, r.contact_id);
    out.push({
      id: r.id,
      vendorId: party?.id ?? r.contact_id,
      vendorName: party?.name ?? null,
      billDate: r.bill_date,
      dueDate: r.due_date,
      currency: r.currency,
      payableMinor: r.payable_minor,
      openMinor,
      vendorReference: r.vendor_reference,
    });
  }
  return out;
}

function compareFlows(x: FlowEvent, y: FlowEvent): number {
  if (x.date !== y.date) return x.date < y.date ? -1 : 1;
  if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
  const rx = x.ref ?? '';
  const ry = y.ref ?? '';
  if (rx !== ry) return rx < ry ? -1 : 1;
  return x.amountMinor - y.amountMinor;
}

/** The date an undecided payable is paid when no plan says otherwise: the last on-time clearing day. */
export function payableDefaultFlow(model: FlowModel, p: PayableCandidate): FlowEvent | null {
  const firstClearing = clearingDayOnOrAfter(model.asOf);
  const last = lastExecutionFor(p.dueDate, model.params.settlementLagDays);
  const date = last < firstClearing ? firstClearing : last;
  if (date > model.horizonEnd) return null;
  return {
    date,
    amountMinor: -p.openMinor,
    kind: 'payable',
    ref: p.billId,
    label: p.vendorName,
    provenance: last < firstClearing ? 'overdue_pay_now' : p.dueAssumed ? 'assumed_terms+due' : 'due',
  };
}

/** End-of-day balances over `dates` from an opening balance and a set of flows. */
export function dailyBalances(dates: readonly string[], opening: number, flows: readonly FlowEvent[]): {
  inMinor: number[];
  outMinor: number[];
  balance: number[];
} {
  const index = new Map(dates.map((d, i) => [d, i] as const));
  const inMinor = new Array<number>(dates.length).fill(0);
  const outMinor = new Array<number>(dates.length).fill(0);
  for (const f of flows) {
    const i = index.get(f.date);
    if (i === undefined) continue;
    if (f.amountMinor >= 0) inMinor[i] = (inMinor[i] as number) + f.amountMinor;
    else outMinor[i] = (outMinor[i] as number) - f.amountMinor;
  }
  const balance: number[] = [];
  let run = opening;
  for (let i = 0; i < dates.length; i += 1) {
    run += (inMinor[i] as number) - (outMinor[i] as number);
    balance.push(run);
  }
  return { inMinor, outMinor, balance };
}

/** The canonical inputs a proposal is keyed on (idempotency on rows, spec §7). */
export function canonicalInputs(model: FlowModel, extra: Record<string, unknown>): { json: string; hash: string } {
  const payload = {
    asOf: model.asOf,
    horizonEnd: model.horizonEnd,
    params: model.params,
    extra,
    opening: model.openingBalanceMinor,
    accounts: model.accounts.map((a) => [a.bankAccountId, a.balanceMinor]),
    flows: model.fixedFlows.map((f) => [f.date, f.amountMinor, f.kind, f.ref, f.provenance]),
    payables: model.payables.map((p) => [p.billId, p.openMinor, p.dueDate, p.skonto.rateBp, p.skonto.untilDate]),
    remainders: model.skontoRemainders.map((r) => [r.billId, r.openMinor]),
    // Carried so a stored proposal shows what its floor proof leaned on (critic R4-M1).
    excluded: model.excluded,
    conservative: model.conservative,
  };
  const json = JSON.stringify(payload);
  return { json, hash: createHash('sha256').update(json).digest('hex') };
}
