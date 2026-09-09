/**
 * A22, FX revaluation: the period-end unrealised gain/loss on foreign-currency monetary positions.
 *
 * OR Art. 960a Abs. 2 requires monetary foreign-currency positions (bank balances, receivables,
 * payables) to be valued at the balance-sheet-date rate (Bilanzstichtagskurs). The books carry each
 * position at the rate that priced it when it was booked; at period end the CHF carrying value is
 * restated to the closing rate and the difference is an UNREALISED currency gain or loss. Confirmed
 * against the Swiss OR (KPMG "Das Schweizer Rechnungslegungsrecht, Fremdwährung", fetched 2026-08-03):
 * monetary Aktiven und Verbindlichkeiten in Fremdwährung are valued at the Stichtagskurs, and under
 * the Imparitätsprinzip an unrealised LOSS is recognised; this KMU core books both directions to the
 * one financial-result currency account (6949, seeded bidirectional, see `accounts/kmuSeed.ts`).
 *
 * ## Why UNREALISED, and why it auto-reverses
 *
 * The difference is unrealised: no money has actually changed hands, the EUR balance is unchanged, only
 * its CHF price moved. When the position later SETTLES (A14 customer payment, A18 creditor payment) the
 * REALISED difference books to the operating currency-difference accounts (3806/4906) at the settlement
 * rate. If A22's period-end adjustment stayed on the books, that realised figure would double-count the
 * slice A22 already recognised. So every revaluation entry is immediately mirrored by a reversing entry
 * dated the FIRST DAY OF THE NEXT PERIOD (a real §H-AUDIT reversal via `reverseEntry`, never a
 * mutation): on that day the revaluation backs out, the position returns to its original booking basis,
 * and settlement recognises the whole realised difference cleanly. A22 only ever touches the UNREALISED
 * account; realised is A14/A18's job (spec §4, US-A22.4).
 *
 * ## The unit of revaluation: (ledger account × foreign currency)
 *
 * OR 960a revalues a monetary POSITION, and the auditable, currency-scoped unit of a monetary position
 * in this ledger is a balance-sheet account's balance IN one foreign currency. A EUR bank account is
 * one position; account 1100 Debitoren holding both EUR and USD is TWO, revalued independently at each
 * currency's closing rate. This is computed straight from the journal: for account A and foreign
 * currency C,
 *
 *   fcAmountMinor = Σ(debit_minor - credit_minor)      over posted lines on A with currency = C
 *   bookChfMinor  = Σ(base_debit_minor - base_credit_minor)  over the same lines
 *   revaluedChfMinor = round(fcAmountMinor × closingRate)     (Pattern P2, round once, half away)
 *   diffChfMinor  = revaluedChfMinor - bookChfMinor
 *
 * `diffChfMinor` is the debit-positive adjustment the account needs so its CHF carrying value equals the
 * revalued figure, and the sign is uniform across assets and liabilities BY CONSTRUCTION: an asset
 * carries a positive `fcAmount`/`bookChf` (debit balance), a liability a negative one (credit balance),
 * so `revalued - book` is a gain when positive and a loss when negative for EITHER. `totalUnrealisedMinor
 * = Σ diffChfMinor` is therefore the net P&L: negative is a net loss (the narration's "CHF -80").
 *
 * The revaluation adjustment itself is a pure CHF (base-currency) line: it moves the account's CHF
 * carrying value without touching its foreign-currency balance, which is exactly what a Stichtagskurs
 * revaluation is. Because the adjustment and its reversal are CHF lines, they never enter the
 * FC-currency sums above, so `bookChf` always reflects the ORIGINAL booking basis and a later period end
 * revalues from that basis after the prior reversal has netted out. That is why the FC-line grain is the
 * correct one, not an approximation.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { baseCurrencyOf, resolveFxRate } from './rates.js';
import { convertMinor } from './rateMath.js';

/**
 * The KMU-core account for UNREALISED currency differences on financial positions (OR 960a, A22's
 * event). Seeded by A01 and bidirectional by convention: a loss debits it, a gain nets as a credit.
 * A22 references the ROLE by number rather than hard-coding a new account (spec §3).
 */
const UNREALISED_FX_ACCOUNT_NUMBER = '6949';

/** The journal source for an FX revaluation entry (§D0 enum). Only this module writes it. */
const FX_SOURCE = 'fx';

/**
 * Abort a write transaction with a structured cause. A better-sqlite3 `db.transaction(fn)()` commits
 * unless the callback THROWS: a plain `return err(...)` from inside the tx would commit whatever was
 * written before the failure (and memoise it under the idempotency key). Throwing this instead is the
 * ONLY way to roll the revaluation entry back atomically with its failed next-period reversal, so the
 * books never carry a revaluation without the reversal that backs it out.
 */
class FxRevalAbort {
  constructor(public readonly result: Result) {}
}

/** Run `body` and translate an `FxRevalAbort` thrown to escape the tx back into its failure Result. */
function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof FxRevalAbort) return e.result;
    throw e;
  }
}

/** One revalued monetary position: an (account × foreign currency) slice at the closing rate. */
export interface FxPosition {
  /** `bank` (an A19 register account), `debtor` (a monetary asset), or `creditor` (a monetary liability). */
  readonly kind: 'bank' | 'debtor' | 'creditor';
  readonly accountId: string;
  readonly accountNumber: string;
  readonly currency: string;
  /** The foreign-currency balance in minor units (signed: positive asset, negative liability). */
  readonly fcAmountMinor: number;
  /** The CHF the books currently carry for it (the original booking basis), minor units. */
  readonly bookChfMinor: number;
  /** The closing rate applied, canonical decimal string. */
  readonly rate: string;
  /** The validity date of the closing rate used. */
  readonly rateAsOf: string | null;
  /** The CHF value at the closing rate, minor units. */
  readonly revaluedChfMinor: number;
  /** `revaluedChfMinor - bookChfMinor`: positive is an unrealised gain, negative a loss. */
  readonly diffChfMinor: number;
}

/** A currency with an open FC position but no admissible closing rate on file (P9, `needs_rate`). */
export interface FxNeedsRate {
  readonly currency: string;
  readonly latestAsOf: string | null;
}

export interface ComputeFxRevaluationInput {
  /** The balance-sheet date to revalue at (`YYYY-MM-DD`), the last day of the period being closed. */
  periodEnd: string;
}

interface PositionRow {
  account_id: string;
  number: string;
  type: string;
  currency: string;
  fc_net: number;
  base_net: number;
}

/**
 * Gather every open monetary FC position at `periodEnd`, valued at the closing rate. Pure read model
 * (Pattern P5): nothing is posted. §H-TENANT: every row is workspace-scoped.
 *
 * Returns the positions it could value, the per-currency subtotals, the net unrealised total, and a
 * `needsRate` list naming any currency that has an open position but no admissible closing rate, so a
 * caller can offer the "add a rate" CTA rather than silently omitting the position.
 */
export function computeFxRevaluation(ctx: WorkspaceContext, input: ComputeFxRevaluationInput): Result {
  const guard = requireDate(input.periodEnd, 'periodEnd');
  if (guard) return guard;

  const base = baseCurrencyOf(ctx);

  // §H-TENANT + the monetary-position fence: posted lines only, on BALANCE-SHEET accounts
  // (asset/liability, never income/expense/equity), in a currency other than the base, up to and
  // including the balance-sheet date. Grouped into one row per (account, currency).
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account_id,
              a.number     AS number,
              a.type       AS type,
              l.currency   AS currency,
              SUM(l.debit_minor - l.credit_minor)           AS fc_net,
              SUM(l.base_debit_minor - l.base_credit_minor) AS base_net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a       ON a.id = l.account_id
        WHERE e.workspace_id = ?
          AND e.status = 'posted'
          AND e.date <= ?
          AND a.type IN ('asset', 'liability')
          AND l.currency <> ?
        GROUP BY l.account_id, l.currency
        ORDER BY a.number ASC, l.currency ASC`,
    )
    .all(ctx.workspaceId, input.periodEnd, base) as PositionRow[];

  const bankAccountIds = new Set(
    (
      ctx.store.db
        .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ?')
        .all(ctx.workspaceId) as { ledger_account_id: string }[]
    ).map((r) => r.ledger_account_id),
  );

  const positions: FxPosition[] = [];
  const needsRate: FxNeedsRate[] = [];
  const needsRateSeen = new Set<string>();
  const byCurrency = new Map<string, { fcAmountMinor: number; bookChfMinor: number; revaluedChfMinor: number; diffChfMinor: number }>();

  for (const row of rows) {
    // A position whose foreign-currency balance has netted to zero is settled, not a live monetary
    // position: any CHF residual it left is a realised difference A14/A18 already recognised, never
    // an unrealised one. Revaluing it would invent an unrealised figure on a position that no longer
    // exists.
    if (row.fc_net === 0) continue;

    const resolved = resolveFxRate(ctx, { currency: row.currency, date: input.periodEnd });
    if (!resolved.ok) {
      // Any rate rejection (no rate, too stale, inadmissible method) surfaces as `needs_rate` for the
      // currency, deduplicated so a control account holding several positions in one currency reports
      // it once.
      if (!needsRateSeen.has(row.currency)) {
        needsRateSeen.add(row.currency);
        needsRate.push({
          currency: row.currency,
          latestAsOf: typeof resolved.latestAsOf === 'string' ? resolved.latestAsOf : null,
        });
      }
      continue;
    }

    const rateScaled = resolved.resolved.rateScaled;
    const revaluedChfMinor = convertMinor(row.fc_net, rateScaled);
    const diffChfMinor = revaluedChfMinor - row.base_net;
    const kind: FxPosition['kind'] = bankAccountIds.has(row.account_id)
      ? 'bank'
      : row.type === 'liability'
        ? 'creditor'
        : 'debtor';

    positions.push({
      kind,
      accountId: row.account_id,
      accountNumber: row.number,
      currency: row.currency,
      fcAmountMinor: row.fc_net,
      bookChfMinor: row.base_net,
      rate: resolved.resolved.rate,
      rateAsOf: resolved.resolved.rateAsOf,
      revaluedChfMinor,
      diffChfMinor,
    });

    const agg = byCurrency.get(row.currency) ?? { fcAmountMinor: 0, bookChfMinor: 0, revaluedChfMinor: 0, diffChfMinor: 0 };
    agg.fcAmountMinor += row.fc_net;
    agg.bookChfMinor += row.base_net;
    agg.revaluedChfMinor += revaluedChfMinor;
    agg.diffChfMinor += diffChfMinor;
    byCurrency.set(row.currency, agg);
  }

  const totalUnrealisedMinor = positions.reduce((sum, p) => sum + p.diffChfMinor, 0);

  return ok({
    periodEnd: input.periodEnd,
    baseCurrency: base,
    positions,
    byCurrency: [...byCurrency.entries()].map(([currency, agg]) => ({ currency, ...agg })),
    totalUnrealisedMinor,
    needsRate,
  });
}

export interface PostFxRevaluationInput {
  periodEnd: string;
  idempotencyKey: string;
}

interface FxRevaluationRunRow {
  id: string;
  entry_id: string | null;
  reversal_id: string | null;
  total_unrealised_minor: number;
  idempotency_key: string;
  posted_at: string;
}

/**
 * Post the period-end unrealised revaluation as a balanced entry (source `fx`) plus its next-period
 * reversal, atomically. The money path in miniature (spec §6b Fixed): §H-LEDGER (balanced in base
 * Rappen, by construction), §H-AUDIT (immutable entry, a real linked reversal, never a mutation),
 * §H-PERIOD (honoured by `postEntry`), §H-IDEMPOTENT (per period end), §H-TENANT (every query scoped).
 *
 * ## Idempotency and the `already_posted` guard
 *
 * A period end is revalued at most ONCE. The `fx_revaluation` run row keyed `(workspace, period_end)`
 * is the single source of truth: a retry with the SAME idempotency key replays the stored result and
 * writes nothing (the §H-IDEMPOTENT contract the conformance gate's double call proves); a re-post
 * with a DIFFERENT key returns `already_posted`, because the second run would double-count a period a
 * human already closed. A period whose net revaluation is exactly zero posts NOTHING and records no
 * run, so it stays re-runnable once a rate is recorded (the empty/unchanged-rate case, spec §2).
 */
export function postFxRevaluation(ctx: WorkspaceContext, input: PostFxRevaluationInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard = requireDate(input.periodEnd, 'periodEnd') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const existing = ctx.store.db
    .prepare(
      `SELECT id, entry_id, reversal_id, total_unrealised_minor, idempotency_key, posted_at
         FROM fx_revaluation WHERE workspace_id = ? AND period_end = ?`,
    )
    .get(ctx.workspaceId, input.periodEnd) as FxRevaluationRunRow | undefined;
  if (existing !== undefined) {
    if (existing.idempotency_key === input.idempotencyKey) {
      // §H-IDEMPOTENT replay: the SAME shape the fresh post returns, so the conformance gate's
      // double call sees byte-identical results. Positions are the read verb's job, not carried here.
      return ok({
        runId: existing.id,
        periodEnd: input.periodEnd,
        posted: existing.entry_id !== null,
        entryId: existing.entry_id,
        reversalId: existing.reversal_id,
        totalUnrealisedMinor: existing.total_unrealised_minor,
        reversalDate: existing.entry_id !== null ? firstDayAfter(input.periodEnd) : null,
      });
    }
    return err('already_posted', {
      periodEnd: input.periodEnd,
      runId: existing.id,
      entryId: existing.entry_id,
      postedAt: existing.posted_at,
    });
  }

  const computed = computeFxRevaluation(ctx, { periodEnd: input.periodEnd });
  if (!computed.ok) return computed;

  const needsRate = computed.needsRate as FxNeedsRate[];
  if (needsRate.length > 0) {
    // A period end cannot be honestly closed while any open FC position has no closing rate: posting a
    // partial revaluation and calling the period done would understate the balance sheet. Refuse with
    // the currencies that still need a rate (P9), nothing written.
    return err('needs_rate', { periodEnd: input.periodEnd, currencies: needsRate });
  }

  const positions = computed.positions as FxPosition[];
  const totalUnrealisedMinor = computed.totalUnrealisedMinor as number;

  const movements = positions.filter((p) => p.diffChfMinor !== 0);
  if (movements.length === 0) {
    // Nothing moved (no positions, or every closing rate equals the booking rate). Post nothing and
    // record no run, so a later revaluation of this period end is still possible once a rate changes.
    return ok({
      runId: null,
      periodEnd: input.periodEnd,
      posted: false,
      entryId: null,
      reversalId: null,
      totalUnrealisedMinor: 0,
      reversalDate: null,
    });
  }

  const lossAccount = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, UNREALISED_FX_ACCOUNT_NUMBER) as { id: string } | undefined;
  if (lossAccount === undefined) {
    return err('needs_account', {
      number: UNREALISED_FX_ACCOUNT_NUMBER,
      reason: 'the unrealised currency-difference account (6949) is not in the chart: seed it (A01) before revaluing',
    });
  }

  // Each position account is adjusted by its diff on the debit-positive convention; the unrealised
  // account (6949) takes the net on the opposite side, so the entry balances in base Rappen BY
  // CONSTRUCTION. A gain (net diff > 0) credits 6949; a loss debits it. When the position movements
  // net to zero against each other the 6949 line is omitted, and the entry is still balanced.
  const lines: LineInput[] = movements.map((p) =>
    p.diffChfMinor > 0
      ? { account: p.accountId, debit: p.diffChfMinor }
      : { account: p.accountId, credit: -p.diffChfMinor },
  );
  if (totalUnrealisedMinor > 0) {
    lines.push({ account: lossAccount.id, credit: totalUnrealisedMinor });
  } else if (totalUnrealisedMinor < 0) {
    lines.push({ account: lossAccount.id, debit: -totalUnrealisedMinor });
  }

  const nextPeriodStart = firstDayAfter(input.periodEnd);

  // The whole trio (revaluation entry, its next-period reversal, the run row) commits together or not
  // at all: a reversal blocked by a locked next period, or any post failure, rolls the entry back too,
  // so the books never carry a revaluation without the reversal that backs it out.
  return runGuarded(() =>
    ctx.store.tx(() => {
      const posted = postEntry(ctx, {
        date: input.periodEnd,
        source: FX_SOURCE,
        idempotencyKey: `fxreval:${input.periodEnd}`,
        description: `FX-Neubewertung per ${input.periodEnd}`,
        lines,
      });
      // The throw is the ONLY abort that rolls the tx back: a plain `return posted` would COMMIT the
      // partial writes (and memoise the failure under `fxreval:${periodEnd}`), leaving an orphan.
      if (!posted.ok) throw new FxRevalAbort(posted);

      const reversal = reverseEntry(ctx, {
        entryId: posted.entryId,
        date: nextPeriodStart,
        idempotencyKey: `fxreval-rev:${input.periodEnd}`,
        description: `Storno FX-Neubewertung per ${input.periodEnd}`,
      });
      // A reversal blocked by a locked next period must roll the posted revaluation entry back TOO,
      // so the trio commits together or not at all (never a revaluation without its backing Storno).
      if (!reversal.ok) throw new FxRevalAbort(reversal);

      const runId = ctx.ids.next('fxreval');
      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `INSERT INTO fx_revaluation
             (id, workspace_id, period_end, entry_id, reversal_id, total_unrealised_minor, idempotency_key, posted_at, posted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          ctx.workspaceId,
          input.periodEnd,
          posted.entryId,
          reversal.reversalId,
          totalUnrealisedMinor,
          input.idempotencyKey,
          at,
          ctx.actor,
        );
      ctx.audit.record({
        entityKind: 'fx_revaluation',
        entityId: runId,
        action: 'post',
        actor: ctx.actor,
        at,
      });

      return ok({
        runId,
        periodEnd: input.periodEnd,
        posted: true,
        entryId: posted.entryId,
        reversalId: reversal.reversalId,
        totalUnrealisedMinor,
        reversalDate: nextPeriodStart,
      });
    }),
  );
}

/** The calendar day after `date` (`YYYY-MM-DD`): the first day of the period that follows period end. */
function firstDayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
