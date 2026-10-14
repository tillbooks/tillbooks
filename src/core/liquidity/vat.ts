/**
 * A40, the MWST outflows: ONE chokepoint for what the forecast debits for the ESTV (rebuilt on 30.09.2026
 * after critic rounds R2-M1, R3-M1 and R3-L1; the blunt rule of 01.10.2026 after R5-M1 and R5-M2).
 *
 * THIS MODULE WRITES NOTHING and changes nothing in the VAT engine: it READS A07.
 *
 * ## Two kinds of claim
 *
 *  - A COMPUTED period (A07 answers its return, today every period under vereinbarte Entgelte): it owes
 *    A07's own figure (`computeVatReturn`, Ziffer 500 minus Ziffer 510) over the part posted so far,
 *    TAGGED lines only, plus the opening position A04 carried into it. Unchanged since the rebuild.
 *  - A REFUSED period (A07 refuses the return, today every period under vereinnahmte Entgelte), and
 *    liability no period explains (untagged raises on the output-tax accounts, a manual correction): the
 *    OWNER'S BLUNT RULE of 01.10.2026. Claim ONLY the OUTPUT tax booked in that period (2200/2201, tagged
 *    entries for a refused period, untagged raises for unexplained liability) and NEVER subtract
 *    Vorsteuer (1170/1171) of any kind: under Ist the Vorsteuer counts only once the supplier is paid
 *    (MWSTG Art. 40 Abs. 1 lit. b), which A40 does not model. Each such claim is a CONSERVATIVE line of
 *    its own (`vat_return_refused`, `vat_unattributed`).
 *    WHEN MWST IST LANDS IN A07 (the planned "MWST Ist" build), A40 reads the engine's Ist periods as
 *    computed periods and this rule goes.
 *
 * ## When
 *
 * MWSTG Art. 86 Abs. 1: within 60 days of the period end (`VAT_DUE_DAYS`). A07 exposes no due date, so
 * the statute is applied here (the same 60 days G22's checklist uses). A due date already past is debited
 * on the first clearing day (`flows.ts`).
 *
 * ## The opening position
 *
 * A04's opening entry (`set_opening_balances`, found by its idempotency-key prefix, the way A04 finds it)
 * carries the MWST the previous system still owed at adoption. It is attributed to the EARLIEST period
 * that had started before the opening date and was not yet due on it (1.1. carries Q4, 1.7. carries Q2,
 * a cutover inside a period carries the older, earlier-due one). A computed period adds its net position;
 * a refused one only its output part (the blunt rule).
 *
 * ## What is still open: ONE cap, newest claim first (OR 87 Abs. 1: a payment settles the oldest debt)
 *
 *  - Every claim (computed under the effektive Methode, refused, unexplained, for every method) is capped
 *    by what the ledger still owes on the OUTPUT-tax accounts (2200 + 2201), newest first, every amount
 *    allotted lowering the pool, so one franc on the books never pays two claims. A payment to the ESTV
 *    lowers 2200 or 2201 (after A38's settlement, 2201), so a paid period is never debited again.
 *    A computed claim is net of its own Vorsteuer but uses up its own GROSS output tax from the pool,
 *    so the Vorsteuer part of a newer period never becomes room for an older, paid one.
 *  - Vorsteuer NEVER lowers the cap (01.10.2026): a running quarter's unrefunded surplus is not netted
 *    against an earlier quarter's tax. A38's settlement moves a filed period's Vorsteuer onto 2201, so a
 *    settled period's Vorsteuer does count, exactly as the ESTV nets it. Stated residual (conservative): a
 *    book that pays the NET tax straight from 2200 without A38's settlement leaves the Vorsteuer part on
 *    2200, and that part is debited again; the MWST-Periode checklist (G22) settles before paying.
 *  - Under the Saldosteuersatz 2200 carries the invoiced rate, which only overstates what is open. Its
 *    computed claims stay uncapped (2200 cannot show their payment); a past-due one is named, never
 *    assumed paid (`flows.ts`).
 *
 * No Vorsteuer add-back, no credit-period logic (removed with the blunt rule; it also closed R5-L2).
 * Under the effektive Methode, liability the ledger still owes beyond every claim of the window (booked
 * before it) is debited on the first clearing day, a conservative line.
 */

import type { WorkspaceContext } from '../context.js';
import { addDays } from './calendar.js';
import { computeVatReturn, INPUT_VAT_ACCOUNTS, listVatPeriods, OUTPUT_VAT_ACCOUNT } from '../vat/abrechnung.js';

/** MWSTG Art. 86 Abs. 1: the tax of a settlement period is due within 60 days of its end. */
export const VAT_DUE_DAYS = 60;

/**
 * A04's opening-entry key prefix (`OPENING_KEY_PREFIX` in `ledger/openingBalances.ts`), stated here
 * rather than imported: that module posts, and A40 imports no posting module. A test pins the two equal.
 */
export const OPENING_ENTRY_KEY_PREFIX = 'opening-balances';

/** A07's output-tax account plus A38's MWST-Abrechnungskonto (stated, not imported: A38's module posts). */
const OUTPUT_TAX_ACCOUNTS: readonly string[] = [OUTPUT_VAT_ACCOUNT, '2201'];
const ALL_TAX_ACCOUNTS: readonly string[] = [...OUTPUT_TAX_ACCOUNTS, ...INPUT_VAT_ACCOUNTS];

export interface VatPeriodObligation {
  label: string;
  periodStart: string;
  periodEnd: string;
  /** periodEnd + 60 days (MWSTG Art. 86 Abs. 1). */
  dueDate: string;
  method: 'effektiv' | 'saldo';
  filed: boolean;
  started: boolean;
  /** A07's return over the posted part: Ziffer 500 minus Ziffer 510 (negative: a credit). Null when refused. */
  returnMinor: number | null;
  /** The opening position attributed to this period (net for a computed period, output for a refused one). */
  openingMinor: number;
  /** The period's own claim: A07's figure (computed) or the output tax booked (refused), plus the opening. */
  claimMinor: number;
  /** What is still open of that claim after the caps (an uncapped Saldo claim: the claim itself). */
  openMinor: number;
  /** True when `openMinor` is capped by the ledger (every claim except a computed Saldo one). */
  capped: boolean;
  /** A07 refused the return (its error code): the claim follows the blunt rule. */
  refusal: string | null;
  /** Untagged output-tax raises booked in this period that no return explains, still open (blunt rule). */
  unattributedMinor: number;
}

export interface VatObligations {
  /** False when no year of the window has an MWST method: nothing is owed, and the forecast says so. */
  configured: boolean;
  periods: VatPeriodObligation[];
  /** Effektiv: liability the ledger still owes beyond every claim of the window (debited today, conservative). */
  unattributedMinor: number;
  /**
   * Vorsteuer still standing on 1170/1171 at `asOf` (their debit balance). A past-due computed period the
   * output cap still debits while Vorsteuer stands there may have been paid NET straight from 2200: the
   * forecast says so (critic R6-L1, `vat_input_not_settled`), it does not guess.
   */
  inputVatOpenMinor: number;
}

/** The ledger's balance on `accounts` at `asOf`, credit minus debit, in the base currency. */
function creditBalance(ctx: WorkspaceContext, asOf: string, accounts: readonly string[]): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS bal
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ?
          AND a.number IN (${accounts.map(() => '?').join(', ')})`,
    )
    .get(ctx.workspaceId, asOf, ...accounts) as { bal: number };
  return row.bal;
}

/** The net MWST liability on the ledger at `asOf`: credit balance of 2200 + 2201 plus that of 1170/1171. */
export function vatLiabilityMinor(ctx: WorkspaceContext, asOf: string): number {
  return creditBalance(ctx, asOf, ALL_TAX_ACCOUNTS);
}

/**
 * The OUTPUT tax booked between `start` and `end` on 2200/2201, per entry: by TAGGED entries (a signed
 * sum, so a reversal or a credit note nets out) or by UNTAGGED ones (only the raises: an entry that lowers
 * the liability settles something, it books no tax). A04's opening entries and A38's settlement transfers
 * (and their reversals) are left out: the opening has its own rule, a settlement only moves tax.
 */
function outputBookedIn(ctx: WorkspaceContext, start: string, end: string, tagged: boolean): number {
  const rows = ctx.store.db
    .prepare(
      `SELECT SUM(l.base_credit_minor - l.base_debit_minor) AS net
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND a.number IN (${OUTPUT_TAX_ACCOUNTS.map(() => '?').join(', ')})
          AND NOT (e.source = 'import' AND e.idempotency_key LIKE ?)
          AND e.source <> 'vat_settlement'
          AND NOT (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = 'vat_settlement'))
          AND ${tagged ? '' : 'NOT '}EXISTS (SELECT 1 FROM journal_line t WHERE t.entry_id = e.id AND t.tax_code IS NOT NULL)
        GROUP BY e.id`,
    )
    .all(ctx.workspaceId, start, end, ...OUTPUT_TAX_ACCOUNTS, `${OPENING_ENTRY_KEY_PREFIX}:%`, ctx.workspaceId) as { net: number }[];
  return tagged ? rows.reduce((s, r) => s + r.net, 0) : rows.reduce((s, r) => s + Math.max(0, r.net), 0);
}

/**
 * A04's LIVE opening entries dated on or before `asOf` (an opening reversed for a correction is not
 * live; its replacement is), each with its net MWST position and its output-tax part.
 */
function openingPositions(ctx: WorkspaceContext, asOf: string): { date: string; netMinor: number; outputMinor: number }[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id AS entryId, e.date AS date,
              COALESCE(SUM(CASE WHEN a.number IN (${ALL_TAX_ACCOUNTS.map(() => '?').join(', ')})
                                THEN l.base_credit_minor - l.base_debit_minor ELSE 0 END), 0) AS net,
              COALESCE(SUM(CASE WHEN a.number IN (${OUTPUT_TAX_ACCOUNTS.map(() => '?').join(', ')})
                                THEN l.base_credit_minor - l.base_debit_minor ELSE 0 END), 0) AS output
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source = 'import' AND e.date <= ?
          AND e.idempotency_key LIKE ?
        GROUP BY e.id, e.date
        ORDER BY e.date, e.id`,
    )
    .all(...ALL_TAX_ACCOUNTS, ...OUTPUT_TAX_ACCOUNTS, ctx.workspaceId, asOf, `${OPENING_ENTRY_KEY_PREFIX}:%`) as {
    entryId: string;
    date: string;
    net: number;
    output: number;
  }[];
  const reversalOf = ctx.store.db.prepare(
    "SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted'",
  );
  const live = (entryId: string): boolean => {
    let current = entryId;
    let depth = 0;
    for (;;) {
      const next = reversalOf.get(ctx.workspaceId, current) as { id: string } | undefined;
      if (next === undefined) return depth % 2 === 0;
      current = next.id;
      depth += 1;
    }
  };
  return rows
    .filter((r) => (r.net !== 0 || r.output !== 0) && live(r.entryId))
    .map((r) => ({ date: r.date, netMinor: r.net, outputMinor: r.output }));
}

/** The MWST obligations of every period from the year before `asOf` to the horizon's last year. */
export function vatObligations(ctx: WorkspaceContext, asOf: string, horizonEnd: string): VatObligations {
  const periods: VatPeriodObligation[] = [];
  const firstYear = Number(asOf.slice(0, 4)) - 1;
  const lastYear = Number(horizonEnd.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y += 1) {
    const listed = listVatPeriods(ctx, { year: String(y) });
    // A year without an MWST method (not yet registered, or `none`) owes nothing and lists no period.
    if (!listed.ok) continue;
    const method = listed.method as 'effektiv' | 'saldo';
    for (const p of listed.periods as ReadonlyArray<{ label: string; periodStart: string; periodEnd: string; filed: boolean }>) {
      const started = p.periodStart <= asOf;
      let returnMinor: number | null = 0;
      let refusal: string | null = null;
      if (started) {
        const vat = computeVatReturn(ctx, { periodStart: p.periodStart, periodEnd: p.periodEnd < asOf ? p.periodEnd : asOf });
        if (vat.ok) returnMinor = (vat.payableMinor as number) - (vat.creditMinor as number);
        else {
          returnMinor = null;
          refusal = vat.error;
        }
      }
      periods.push({
        label: p.label,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        dueDate: addDays(p.periodEnd, VAT_DUE_DAYS),
        method,
        filed: p.filed,
        started,
        returnMinor,
        openingMinor: 0,
        claimMinor: 0,
        openMinor: 0,
        capped: false,
        refusal,
        unattributedMinor: 0,
      });
    }
  }
  if (periods.length === 0) return { configured: false, periods, unattributedMinor: 0, inputVatOpenMinor: 0 };
  periods.sort((x, y) => (x.periodStart < y.periodStart ? -1 : x.periodStart > y.periodStart ? 1 : 0));

  // The opening position: the earliest period started before the opening and not yet due on it.
  const openingOutput = new Map<VatPeriodObligation, number>();
  for (const o of openingPositions(ctx, asOf)) {
    const target = periods.find((p) => p.periodStart < o.date && p.dueDate >= o.date);
    if (target === undefined) continue; // an older adoption: what stays on the books is caught below
    target.openingMinor += target.refusal !== null ? o.outputMinor : o.netMinor;
    openingOutput.set(target, (openingOutput.get(target) ?? 0) + o.outputMinor);
  }

  // The claims: A07's figure for a computed period; the blunt rule for a refused one and for untagged
  // output-tax raises (R4-M1, R5-M1: output tax only, never a Vorsteuer subtracted).
  const raised: number[] = [];
  /** The output tax the period itself put on 2200/2201: what of the cap its claim stands on. */
  const outputOwn: number[] = [];
  for (const p of periods) {
    const end = p.periodEnd < asOf ? p.periodEnd : asOf;
    const tagged = p.started ? outputBookedIn(ctx, p.periodStart, end, true) : 0;
    const own = p.refusal !== null ? tagged : (p.returnMinor ?? 0);
    p.claimMinor = Math.max(0, own) + Math.max(0, p.openingMinor);
    raised.push(p.started ? outputBookedIn(ctx, p.periodStart, end, false) : 0);
    outputOwn.push(Math.max(0, tagged) + Math.max(0, openingOutput.get(p) ?? 0));
  }

  // The caps, newest claim first; every amount allotted lowers both pools.
  let remLiability = Math.max(0, vatLiabilityMinor(ctx, asOf));
  let remOutput = Math.max(0, creditBalance(ctx, asOf, OUTPUT_TAX_ACCOUNTS));
  /**
   * Allot up to `want` from the output-tax pool. A computed claim is NET of its own Vorsteuer, but its
   * gross output tax sits on 2200: it uses up `stands` of the pool (its own output), never less than
   * what it is allotted, so the Vorsteuer part of a newer period never becomes room for an older one
   * (critic R5-L2's shape: a paid Q2 would otherwise be debited again out of Q3's Vorsteuer).
   */
  const allot = (want: number, stands = 0): number => {
    const got = Math.max(0, Math.min(want, remOutput));
    const used = Math.max(got, Math.min(stands, remOutput));
    remLiability = Math.max(0, remLiability - got);
    remOutput = Math.max(0, remOutput - used);
    return got;
  };
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    const p = periods[i] as VatPeriodObligation;
    // Untagged raises (no return explains them) first within the period: the blunt rule, output cap.
    p.unattributedMinor = allot(raised[i] as number);
    if (p.refusal !== null) {
      p.capped = true;
      p.openMinor = allot(p.claimMinor);
    } else if (p.method === 'effektiv') {
      // The same OUTPUT-tax cap as every other claim (01.10.2026): Vorsteuer of a period not yet settled
      // must never shrink what an earlier period is debited, so the net liability is not the cap.
      p.capped = true;
      p.openMinor = allot(p.claimMinor, outputOwn[i] as number);
    } else {
      p.openMinor = p.claimMinor; // a computed Saldo period: uncapped, as before
    }
  }
  // Effektiv only (where the net liability IS what is owed): the rest of it, booked before the window.
  const leftover = periods.every((p) => p.method === 'effektiv') ? remLiability : 0;
  return { configured: true, periods, unattributedMinor: leftover, inputVatOpenMinor: Math.max(0, -creditBalance(ctx, asOf, INPUT_VAT_ACCOUNTS)) };
}
