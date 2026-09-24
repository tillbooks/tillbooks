/**
 * B04, the money-touching half: `generateInvoice`, `runDue` and the `burnDown` read model. This is
 * the bridge where a retainer period becomes an A11 invoice DRAFT, and every money-path law is
 * enforced HERE, stated where it bites:
 *
 *  - B04 OPENS NO POSTING PATH (§H-LEDGER, P3). `generateInvoice` delegates to A10 `createDocument`
 *    (type `invoice`, a DRAFT that posts nothing); A11 -> A02 own the only journal entry, at issue.
 *    B04 mints no `postEntry`, stores no total, and computes no VAT amount. The fee line and each
 *    overage line carry the A05 tax code resolved once (§H-VAT-TRACE); A11 resolves the amount.
 *
 *  - NO DOUBLE-INVOICE ON A PERIOD. The `(retainer_id, period_key, kind='fee')` uniqueness guard is
 *    the structural floor; `generateInvoice` PRE-CHECKS it before any write, and a period that already
 *    has a fee draw returns the EXISTING invoice with `{ ok:true, existing:true }`, writing nothing.
 *    `runDue` leans on the same guard, so re-running the tick at any cadence bills each period once.
 *
 *  - NO DOUBLE-BILLING OF TIME. An eligible entry is `approved AND billable AND invoice_line_id IS
 *    NULL` (B02's predicate, read tenant-scoped). A consumed entry flips to `billed` in the SAME
 *    transaction; B02's own eligibility (`status='approved'`) then excludes it, so an entry billed by
 *    B02 or by a retainer can never land on a second invoice.
 *
 *  - THE SINGLE ROUNDING POINT IS THE ENTRY (P2). Every value is `entryValueMinor(minutes, rate)`,
 *    B01's round-once helper, the SAME one B02 uses, so a covered/overage split is round-once on each
 *    portion and the invoiced overage line has exactly one rounding point. Rollover is conserved in
 *    MINUTES, never money, so no rounding compounds across periods.
 *
 *  - §H-TENANT. Every read and write scopes to `ctx.workspaceId`.
 *
 * THE TX-ATOMICITY DISCIPLINE (the C02/D03 bug this must not reintroduce): `ctx.store.tx` and
 * `rememberIdempotent` roll back ONLY on a throw. So every refusal (retainer_not_found,
 * retainer_not_active, invalid_period_key, period_not_closed, currency_mismatch, an already-invoiced
 * period) is a pure READ pre-checked before any write and returned directly; the one in-transaction
 * failure (a `createDocument` rejection) THROWS `RetainerAbort` to force the rollback and is
 * translated to an err outside the transaction (the B02 `BillingAbort` pattern).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entryValueMinor } from '../time/index.js';
import { resolveTax } from '../vat/index.js';
import { createDocument } from '../sales/document.js';
import type { DocumentLineInput } from '../sales/document.js';
import { isRetainerPeriod } from './enums.js';
import type { RetainerPeriod } from './enums.js';
import {
  isPeriodKey,
  nextPeriodKey,
  periodHasEnded,
  periodKeyOf,
  periodStart as periodStartOf,
  periodEndExclusive as periodEndExclusiveOf,
} from './periods.js';
import { pendingPeriods, readRetainer } from './retainers.js';
import type { RetainerRow } from './retainers.js';

const DEFAULT_REVENUE_ACCOUNT = '3200';

/** Abort the transaction so a partial write rolls back and nothing is memoised (B02's pattern). */
class RetainerAbort {
  constructor(public readonly result: Result) {}
}

function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** The revenue account's default tax code (P6, one resolve). NULL when no default: an unregistered
 *  freelancer's line bears no VAT, honestly (the B02 `billingTaxCode` shape). */
function feeTaxCode(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare('SELECT vat_code_default FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, DEFAULT_REVENUE_ACCOUNT) as { vat_code_default: string | null } | undefined;
  return row?.vat_code_default ?? null;
}

interface EligibleTimeRow {
  id: string;
  minutes: number;
  rate_minor: number;
  rate_currency: string;
  started_at: string;
}

/**
 * The period's approved, billable, unbilled B01 entries for the retainer's project (when set) or its
 * contact's projects, cut to the period window on `started_at`. The one eligibility query, tenant
 * scoped, so a foreign entry resolves to nothing. Ordered deterministically so the coverage/cap split
 * lands on the same boundary entry every run.
 */
function eligibleEntries(ctx: WorkspaceContext, retainer: RetainerRow, period: RetainerPeriod, periodKey: string): EligibleTimeRow[] {
  const start = periodStartOf(period, periodKey);
  const endExclusive = periodEndExclusiveOf(period, periodKey);
  const clauses = [
    'te.workspace_id = ?',
    "te.status = 'approved'",
    'te.billable = 1',
    'te.invoice_line_id IS NULL',
    'te.minutes IS NOT NULL',
    'te.started_at >= ?',
    'te.started_at < ?',
  ];
  const params: (string | number)[] = [ctx.workspaceId, `${start}T00:00:00.000Z`, `${endExclusive}T00:00:00.000Z`];
  if (retainer.project_id !== null) {
    clauses.push('te.project_id = ?');
    params.push(retainer.project_id);
  } else {
    clauses.push('p.contact_id = ?');
    params.push(retainer.contact_id);
  }
  return ctx.store.db
    .prepare(
      `SELECT te.id, te.minutes, te.rate_minor, te.rate_currency, te.started_at
         FROM time_entry te
         JOIN project p ON p.id = te.project_id AND p.workspace_id = te.workspace_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY te.started_at, te.id`,
    )
    .all(...params) as EligibleTimeRow[];
}

/** Σ of carryover_in minutes credited to this period (minted when the PREVIOUS period was generated). */
function carryoverInMinutes(ctx: WorkspaceContext, retainerId: string, periodKey: string): number {
  const row = ctx.store.db
    .prepare(
      "SELECT COALESCE(SUM(minutes), 0) AS m FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'carryover_in'",
    )
    .get(ctx.workspaceId, retainerId, periodKey) as { m: number };
  return row.m;
}

/** The existing fee draw for a period, or undefined. The no-double-invoice pre-check reads this. */
function feeDraw(ctx: WorkspaceContext, retainerId: string, periodKey: string): { invoice_id: string | null } | undefined {
  return ctx.store.db
    .prepare(
      "SELECT invoice_id FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'fee'",
    )
    .get(ctx.workspaceId, retainerId, periodKey) as { invoice_id: string | null } | undefined;
}

/** The largest k in [0, kMax] whose round-once value at `rate` fits `capRemaining`. Monotonic, so a
 *  binary search is exact; `entryValueMinor` is nondecreasing in minutes for a non-negative rate. */
function maxMinutesWithinValue(kMax: number, rate: number, capRemaining: number): number {
  if (kMax <= 0) return 0;
  if (entryValueMinor(kMax, rate) <= capRemaining) return kMax;
  let lo = 0;
  let hi = kMax;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (entryValueMinor(mid, rate) <= capRemaining) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface EntrySplit {
  entryId: string;
  rateMinor: number;
  coveredMinutes: number;
  coveredValue: number;
  overageMinutes: number;
  overageValue: number;
}

interface Coverage {
  splits: EntrySplit[];
  coverageMinutes: number;
  carryoverInMinutes: number;
  coveredMinutes: number;
  coveredValueRappen: number;
  overCapMinutes: number;
  overageValueRappen: number;
  consumedMinutes: number;
  unusedMinutes: number;
}

/**
 * THE COVERAGE COMPUTATION (§4, the correctness property B04 exists to guarantee). Coverage is a
 * MINUTE budget (`included + carryover_in`) additionally capped by a VALUE ceiling (`cap_rappen`).
 * Each entry consumes minutes from the budget and value from the cap; the first entry to breach either
 * splits at the exact minute, coverage-side vs overage-side. Pure: no store, no clock, no writes.
 */
export function computeCoverage(includedMinutes: number, carryIn: number, capRappen: number | null, entries: readonly EligibleTimeRow[]): Coverage {
  const coverageMinutes = includedMinutes + carryIn;
  let consumedCoveredMinutes = 0;
  let consumedCoveredValue = 0;
  let overCapMinutes = 0;
  let overageValueRappen = 0;
  const splits: EntrySplit[] = [];
  for (const e of entries) {
    const m = e.minutes;
    const r = e.rate_minor;
    const rmMin = Math.max(0, coverageMinutes - consumedCoveredMinutes);
    const kByMin = Math.min(m, rmMin);
    const covered = capRappen === null ? kByMin : maxMinutesWithinValue(kByMin, r, Math.max(0, capRappen - consumedCoveredValue));
    const overage = m - covered;
    const coveredValue = entryValueMinor(covered, r);
    const overageValue = entryValueMinor(overage, r);
    consumedCoveredMinutes += covered;
    consumedCoveredValue += coveredValue;
    overCapMinutes += overage;
    overageValueRappen += overageValue;
    splits.push({ entryId: e.id, rateMinor: r, coveredMinutes: covered, coveredValue, overageMinutes: overage, overageValue });
  }
  return {
    splits,
    coverageMinutes,
    carryoverInMinutes: carryIn,
    coveredMinutes: consumedCoveredMinutes,
    coveredValueRappen: consumedCoveredValue,
    overCapMinutes,
    overageValueRappen,
    consumedMinutes: consumedCoveredMinutes + overCapMinutes,
    // UNUSED = truly un-consumed budget minutes only. A minute pushed to OVERAGE by the VALUE cap
    // (`cap_rappen` binding below the included-hours value) still consumed real time, so it is NOT
    // unused and must NOT roll forward: subtract CONSUMED (covered + over-cap), never covered alone.
    // Billing that time as overage AND rolling it forward next period double-benefits the client.
    unusedMinutes: Math.max(0, coverageMinutes - (consumedCoveredMinutes + overCapMinutes)),
  };
}

function hoursLabel(minutes: number): string {
  return (minutes / 60).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface GenerateInvoiceInput {
  retainerId?: string;
  periodKey?: string;
  actor?: string;
  idempotencyKey?: string;
}

/**
 * US-B04.2/4/5: turn one ended retainer period into an A11 invoice DRAFT (one fee line + one overage
 * line per excess entry), record the drawdown ledger, flip consumed entries to `billed`, and mint the
 * rollover carryover rows when the mandate says so, all in one transaction. Delegates to A10
 * `createDocument` (P3: no journal entry, no VAT amount, no total minted here). Every refusal is
 * pre-checked before any write; the only in-tx failure throws to roll back (TX-atomic).
 */
export function generateInvoice(ctx: WorkspaceContext, input: GenerateInvoiceInput): Result {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'retainer_generate_invoice');
    if (replay !== undefined) return replay;
  }
  if (typeof input.retainerId !== 'string' || input.retainerId.length === 0) {
    return err('invalid_input', { field: 'retainerId' });
  }
  const retainer = readRetainer(ctx, input.retainerId);
  if (retainer === undefined) return err('retainer_not_found', { retainerId: input.retainerId });
  if (retainer.status !== 'active') return err('retainer_not_active', { retainerId: retainer.id, status: retainer.status });
  const period = retainer.period as RetainerPeriod;
  if (!isRetainerPeriod(period)) return err('invalid_input', { field: 'period' });
  if (!isPeriodKey(period, input.periodKey)) return err('invalid_period_key', { field: 'periodKey', period });
  const periodKey = input.periodKey;

  const outcome = generateForPeriod(ctx, retainer, periodKey, today(ctx), input.idempotencyKey);
  return outcome;
}

/**
 * The shared per-period generation, called by `generateInvoice` (with a caller key) and by `runDue`
 * (keyless, guarded by the fee-draw uniqueness). `asOf` is the reference day the period-closed gate
 * measures against.
 */
function generateForPeriod(ctx: WorkspaceContext, retainer: RetainerRow, periodKey: string, asOf: string, idempotencyKey?: string): Result {
  const period = retainer.period as RetainerPeriod;
  // period_not_closed: a period still running cannot be billed (US-B04.2 error). Pre-checked.
  if (!periodHasEnded(period, periodKey, asOf)) return err('period_not_closed', { retainerId: retainer.id, periodKey });

  // NO DOUBLE-INVOICE: a period that already has a fee draw returns the existing invoice, no write.
  const existing = feeDraw(ctx, retainer.id, periodKey);
  if (existing !== undefined) {
    return ok({ invoiceId: existing.invoice_id, retainerId: retainer.id, periodKey, existing: true, overCapRef: null });
  }

  const entries = eligibleEntries(ctx, retainer, period, periodKey);
  // ONE currency: B04 never silently converts a rate. Any entry priced off the mandate's currency is
  // refused before any write (§H-FX: A11 stores the CHF conversion; a mixed set is an operator error).
  const foreign = entries.filter((e) => e.rate_currency !== retainer.currency).map((e) => e.id);
  if (foreign.length > 0) return err('currency_mismatch', { retainerId: retainer.id, entryIds: foreign, currency: retainer.currency });

  const includedMinutes = retainer.included_hours * 60;
  const carryIn = carryoverInMinutes(ctx, retainer.id, periodKey);
  const coverage = computeCoverage(includedMinutes, carryIn, retainer.cap_rappen, entries);

  // Resolve the fee/overage tax code ONCE (P6, §H-VAT-TRACE). A misconfigured default is a pre-write
  // refusal, never a surprise at issue; the code travels on the line and A11 resolves the amount.
  const taxCode = feeTaxCode(ctx);
  if (taxCode !== null) {
    const resolved = resolveTax(ctx, { taxCode, supplyDate: periodEndExclusiveOf(period, periodKey) });
    if (!resolved.ok) return resolved;
  }

  const overageSplits = coverage.splits.filter((s) => s.overageMinutes > 0);

  const run = (): Result => {
    const lines: DocumentLineInput[] = [
      { description: `Pauschale ${periodKey}`, quantityMilli: 1000, unitPriceMinor: retainer.fee_rappen, taxCode },
      ...overageSplits.map((s) => ({
        description: `Zusatzaufwand: ${hoursLabel(s.overageMinutes)} Std.`,
        quantityMilli: 1000,
        unitPriceMinor: s.overageValue,
        taxCode,
      })),
    ];
    const created = createDocument(ctx, { type: 'invoice', contactId: retainer.contact_id, currency: retainer.currency, lines, notes: `Retainer ${periodKey}` });
    if (!created.ok) throw new RetainerAbort(created);
    const invoice = created as unknown as { document: { id: string }; lines: { id: string }[] };
    const invoiceId = invoice.document.id;
    const feeLineId = invoice.lines[0]?.id;
    if (feeLineId === undefined) throw new RetainerAbort(err('invoice_line_missing', { position: 1 }));
    const now = ctx.clock.now();

    const insertDraw = ctx.store.db.prepare(
      `INSERT INTO retainer_draws (id, workspace_id, retainer_id, period_key, kind, time_entry_id, minutes,
                                   amount_rappen, currency, invoice_id, invoice_line_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const flip = ctx.store.db.prepare(
      "UPDATE time_entry SET status = 'billed', invoice_line_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    );

    // The fee draw is the period's §H-IDEMPOTENT anchor; the unique index refuses a second one.
    insertDraw.run(ctx.ids.next('retainer_draw'), ctx.workspaceId, retainer.id, periodKey, 'fee', null, 0, retainer.fee_rappen, retainer.currency, invoiceId, null, now);

    // Map each overage split to its invoice line, in the same order the lines were built (index 1..).
    let lineIndex = 1;
    for (const s of coverage.splits) {
      let overageLineId: string | null = null;
      if (s.overageMinutes > 0) {
        overageLineId = invoice.lines[lineIndex]?.id ?? null;
        if (overageLineId === null) throw new RetainerAbort(err('invoice_line_missing', { position: lineIndex + 1 }));
        lineIndex += 1;
        // The overage portion: its own draw carries the invoice line and the entry flips to billed
        // pointing at it (B02's billed-flip semantics on the excess).
        insertDraw.run(ctx.ids.next('retainer_draw'), ctx.workspaceId, retainer.id, periodKey, 'time', s.entryId, s.overageMinutes, s.overageValue, retainer.currency, invoiceId, overageLineId, now);
      }
      if (s.coveredMinutes > 0) {
        // The covered portion rides the fee: a draw with invoice_line_id NULL, traceable in the ledger.
        insertDraw.run(ctx.ids.next('retainer_draw'), ctx.workspaceId, retainer.id, periodKey, 'time', s.entryId, s.coveredMinutes, s.coveredValue, retainer.currency, invoiceId, null, now);
      }
      // The entry is consumed exactly once: billed, pointing at its overage line when it has one, else
      // NULL (fee-covered). B02's approved-eligibility then excludes it forever (no double-billing).
      flip.run(overageLineId, now, ctx.workspaceId, s.entryId);
    }

    // Rollover (US-B04.5): unused coverage minutes close this period and open the next, conserved in
    // MINUTES so no rounding compounds. Only when the mandate rolls over and something is unused.
    let carriedOver = 0;
    if (retainer.rollover === 1 && coverage.unusedMinutes > 0) {
      carriedOver = coverage.unusedMinutes;
      insertDraw.run(ctx.ids.next('retainer_draw'), ctx.workspaceId, retainer.id, periodKey, 'carryover_out', null, carriedOver, 0, retainer.currency, null, null, now);
      insertDraw.run(ctx.ids.next('retainer_draw'), ctx.workspaceId, retainer.id, nextPeriodKey(period, periodKey), 'carryover_in', null, carriedOver, 0, retainer.currency, null, null, now);
    }

    return ok({
      invoiceId,
      retainerId: retainer.id,
      periodKey,
      existing: false,
      feeRappen: retainer.fee_rappen,
      overageValueRappen: coverage.overageValueRappen,
      overCapMinutes: coverage.overCapMinutes,
      carriedOverMinutes: carriedOver,
      // The over_cap automation event's entity id: the retainer when there is overage, else null so
      // the dispatch's null-collapse emits no occurrence for a within-cap period.
      overCapRef: coverage.overCapMinutes > 0 ? retainer.id : null,
    });
  };

  try {
    if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, 'retainer_generate_invoice', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof RetainerAbort) return e.result;
    throw e;
  }
}

export interface RunDueInput {
  asOf?: string;
  actor?: string;
  idempotencyKey?: string;
}

/**
 * US-B04.2: bill every active retainer's ended-but-unbilled periods as of `asOf`. Iterates the
 * `retainer` table directly (never an A12 `recurring_schedule`, §3) and calls the shared per-period
 * generation, which is idempotent per period via the fee-draw guard, so re-running the tick at any
 * cadence bills each period exactly once. SELF-KEYED: the per-period guard is the discriminator, not a
 * caller key. Each period is its own transaction, so one retainer's failure never rolls back another's.
 */
export function runDue(ctx: WorkspaceContext, input: RunDueInput = {}): Result {
  const asOf = typeof input.asOf === 'string' && input.asOf.length >= 10 ? input.asOf.slice(0, 10) : today(ctx);
  const retainers = ctx.store.db
    .prepare("SELECT * FROM retainer WHERE workspace_id = ? AND status = 'active' ORDER BY created_at, id")
    .all(ctx.workspaceId) as RetainerRow[];

  const generated: { retainerId: string; periodKey: string; invoiceId: string | null }[] = [];
  const existing: { retainerId: string; periodKey: string; invoiceId: string | null }[] = [];
  const failed: { retainerId: string; periodKey: string; error: string }[] = [];

  for (const retainer of retainers) {
    // Every ended period from starts_on to asOf that has no fee draw yet.
    const pending = pendingPeriods(ctx, retainer, asOf);
    for (const periodKey of pending) {
      const res = generateForPeriod(ctx, retainer, periodKey, asOf);
      if (res.ok) {
        const r = res as unknown as { invoiceId: string | null };
        generated.push({ retainerId: retainer.id, periodKey, invoiceId: r.invoiceId });
      } else {
        failed.push({ retainerId: retainer.id, periodKey, error: (res as unknown as { error: string }).error });
      }
    }
  }
  return ok({ generated, existing, failed });
}

export interface BurnDownInput {
  retainerId?: string;
  periodKey?: string;
}

/**
 * US-B04.3: the drawdown/burn-down read model (P5), computed live, never a cached counter. For a
 * GENERATED period it reads the frozen draw ledger; for the CURRENT in-flight period it simulates the
 * coverage split over live approved time, so the bar is honest before and after generation. An empty
 * period reads consumed 0 and remaining = included + carryover, and the period still bills the full
 * fee (a retainer bills availability, OR 394 ff.).
 */
export function burnDown(ctx: WorkspaceContext, input: BurnDownInput): Result {
  if (typeof input.retainerId !== 'string' || input.retainerId.length === 0) {
    return err('invalid_input', { field: 'retainerId' });
  }
  const retainer = readRetainer(ctx, input.retainerId);
  if (retainer === undefined) return err('retainer_not_found', { retainerId: input.retainerId });
  const period = retainer.period as RetainerPeriod;
  const periodKey = isPeriodKey(period, input.periodKey) ? input.periodKey : periodKeyOf(period, today(ctx));

  const includedMinutes = retainer.included_hours * 60;
  const carryIn = carryoverInMinutes(ctx, retainer.id, periodKey);
  const coverageMinutes = includedMinutes + carryIn;
  const generated = feeDraw(ctx, retainer.id, periodKey) !== undefined;

  let coveredMinutes: number;
  let coveredValueRappen: number;
  let overCapMinutes: number;
  if (generated) {
    // Read the frozen ledger: covered = time draws with no invoice line, overage = time draws with one.
    const covered = ctx.store.db
      .prepare(
        "SELECT COALESCE(SUM(minutes),0) AS m, COALESCE(SUM(amount_rappen),0) AS v FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'time' AND invoice_line_id IS NULL",
      )
      .get(ctx.workspaceId, retainer.id, periodKey) as { m: number; v: number };
    const over = ctx.store.db
      .prepare(
        "SELECT COALESCE(SUM(minutes),0) AS m FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'time' AND invoice_line_id IS NOT NULL",
      )
      .get(ctx.workspaceId, retainer.id, periodKey) as { m: number };
    coveredMinutes = covered.m;
    coveredValueRappen = covered.v;
    overCapMinutes = over.m;
  } else {
    const coverage = computeCoverage(includedMinutes, carryIn, retainer.cap_rappen, eligibleEntries(ctx, retainer, period, periodKey));
    coveredMinutes = coverage.coveredMinutes;
    coveredValueRappen = coverage.coveredValueRappen;
    overCapMinutes = coverage.overCapMinutes;
  }

  return ok({
    retainerId: retainer.id,
    periodKey,
    generated,
    includedMinutes,
    carryoverInMinutes: carryIn,
    coverageMinutes,
    consumedMinutes: coveredMinutes + overCapMinutes,
    coveredMinutes,
    remainingMinutes: Math.max(0, coverageMinutes - coveredMinutes),
    coverageValueRappen: coveredValueRappen,
    capRappen: retainer.cap_rappen,
    overCapMinutes,
  });
}
