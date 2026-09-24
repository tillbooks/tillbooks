/**
 * §H-FX, the `exchange_rate` store and rate resolution (data model §D0).
 *
 * This is the rate SOURCE the ledger reads. It answers exactly one question, and refuses to guess:
 * "what rate converts an amount in <currency> into this workspace's base currency on <date>?"
 *
 * ## The three ways a posting can get a rate, and the one that does not exist
 *
 *  1. The posting is already in the base currency. Rate 1, no lookup, no stored `fx_rate`.
 *  2. The caller supplies the rate EXPLICITLY (`fxRate` on `postEntry`). Legitimate: a bank advice,
 *     a group rate, a rate the user reads off the ESTV page. It is stamped on every line, so the
 *     audit trail records the rate the books were actually made with.
 *  3. The rate is LOOKED UP here, by pair and date, from rates somebody recorded.
 *
 * There is no fourth way. A rate is never defaulted to 1, never carried forward indefinitely, and
 * never inferred. When no admissible rate exists the posting is REFUSED with `needs_fx_rate`, which
 * names the pair, the date, the newest rate on file, and the verb that fixes it. Wrong books that
 * look right are the worst outcome on this path; a refusal a user can act on is the second best, and
 * it is the one this module chooses.
 *
 * ## Which rate is admissible (Swiss law, not a preference)
 *
 * See `docs/specs/foundations` §H-FX for the fetched sources. In short: for MWST the ESTV lets a
 * taxable person convert at either the daily rate (Tageskurs) or the monthly average rate
 * (Monatsmittelkurs) and requires the chosen method to be kept for at least one tax period; the
 * OR additionally requires that where the books are kept in a currency other than CHF, the CHF
 * values and the rate used are disclosed. TILL therefore stores the rate WITH the posting rather
 * than recomputing it later, and records the rate's own validity date and provenance so the method
 * a workspace used is legible after the fact.
 *
 * The engine does not pick a method for the user. It stores whatever admissible rate is recorded,
 * with its `as_of` date and its provenance, and applies the one whose validity date governs.
 *
 * ## The lookback window
 *
 * Reference rates are published on banking days, so an invoice dated on a Saturday has no rate of
 * its own and must legitimately use Friday's. Resolution therefore takes the newest rate whose
 * `as_of` is on or before the posting date, but ONLY within `MAX_RATE_AGE_DAYS`. Without a bound, a
 * rate recorded once would silently price postings for years. With it, a stale book is a refusal
 * rather than a wrong number, and the resolved rate always reports the date it is actually from.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalDate, optionalId } from '../ledger/inputGuards.js';
import { parseRate, formatRate, isCurrencyCode, RATE_ONE, RATE_DECIMALS, RATE_MAX_SCALED } from './rateMath.js';
import { assertFxMethodAdmissible } from './method.js';

/**
 * The §H-ENUM source of truth for `exchange_rate.source` (§D0: `manual|rate_api`). `manual` is a
 * human or agent typing a rate they read off a published table; `rate_api` is a machine feed. Both
 * store identically, which is the point of §H-FX: provenance is data, not a different code path.
 */
export const EXCHANGE_RATE_SOURCES: readonly string[] = ['manual', 'rate_api'];

/**
 * The §H-ENUM list of ADMISSIBLE conversion methods under MWSTV Art. 45 (SR 641.201, Stand 1.1.2025),
 * fetched from fedlex.admin.ch and the ESTV MWST-Info 07 Ziff. 1.3.2.1 on 2026-07-25:
 *
 *  - `monthly_avg`, the ESTV Monatsmittelkurs (Art. 45 Abs. 3, "wahlweise der Monatsmittelkurs oder
 *    der Tageskurs für den Verkauf von Devisen"). Per the ESTV Fremdwährungskurse FAQ, fetched
 *    2026-07-25: it is the arithmetic mean of the Tageskurse from the 25th of a month to the 24th of
 *    the next, published on the 25th of that next month (or the first working day after), and
 *    applicable from the start of the month after publication. The ESTV's own example: 25 March to
 *    24 April, published 25 April, applied 1 to 31 May.
 *  - `daily`, the ESTV Tageskurs für den VERKAUF von Devisen. Not a buying rate, not a mid-rate.
 *  - `bank`, a domestic bank's published daily selling rate. Admissible ONLY for currencies for
 *    which the ESTV publishes no rate (Art. 45 Abs. 3bis).
 *  - `group`, a group's own conversion rate, admissible only for members of a group and only when
 *    applied both inside the group and towards third parties (Art. 45 Abs. 4).
 *
 * Art. 45 Abs. 5 binds the chosen method for at least one Steuerperiode, and MWSTG Art. 34 Abs. 2
 * makes that the calendar year (Abs. 3, the business-year option, is marked not yet in force). The
 * method is recorded per rate so the books can SHOW which basis priced them, and it is ENFORCED
 * against the workspace's per-Steuerperiode election: see `./method.ts` for the lock and for what it
 * can and cannot honestly see.
 */
export const FX_RATE_METHODS: readonly string[] = ['daily', 'monthly_avg', 'bank', 'group'];

/**
 * How many days a rate may reach forward to price a posting. Seven covers a weekend plus a
 * public-holiday cluster (Easter, the year-end bridge) without letting a rate price a whole quarter.
 * A posting further than this from the newest rate on file is refused, never approximated.
 */
export const MAX_RATE_AGE_DAYS = 7;

export interface ExchangeRateRow {
  id: string;
  workspace_id: string;
  base_currency: string;
  quote_currency: string;
  rate: string;
  rate_scaled: number;
  as_of: string;
  source: string;
  method: string | null;
  provenance: string | null;
  created_at: string;
  created_by: string | null;
}

/**
 * The workspace's ledger base currency: the ONE currency the books are kept and balanced in.
 *
 * This is the accessor the whole engine reads instead of writing a literal, so what it does when it
 * cannot answer decides what a dozen write paths do. It REFUSES rather than guessing, for the same
 * reason nothing in this module defaults a rate to 1.
 *
 * The column is `NOT NULL`, so the only way to reach the missing case is a `WorkspaceContext` naming
 * a workspace that has no row: not a currency the caller failed to supply, but a tenant that does not
 * exist. Answering 'CHF' there was not a default, it was an invented fact about books nobody has,
 * and it propagated: `mapDocument` would publish `baseCurrency: 'CHF'`, `statesConversionBasis` would
 * read every real row as foreign, and `createDocument` would stamp francs into whatever came next.
 *
 * No shipped surface can get here. MCP, the REST twins and the Studio all dispatch through
 * `ctxAction` in `src/api/registry.ts`, which returns `workspace_not_found` before the verb runs, and
 * `test/api/conformance.test.mjs` asserts that for EVERY ctx action. So this refusal costs a real
 * caller nothing and tells a library embedder who hand-built a context the truth instead of a
 * plausible franc. It throws rather than returning a `Result` because it is a broken precondition,
 * not a rejected input: `guarded()` in the registry exists to convert exactly this into a Result, and
 * its own comment names a missing tenant as one of the things it catches.
 */
export function baseCurrencyOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string } | undefined;
  if (row === undefined) {
    throw new Error(
      `no workspace ${ctx.workspaceId}: its base currency is unknown, and a guessed one would be stamped on rows`,
    );
  }
  return row.base_currency;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` precedes `from`. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export interface ResolvedRate {
  /** The transaction currency this rate converts FROM. */
  currency: string;
  /** The workspace base currency it converts TO. */
  baseCurrency: string;
  /** The rate as an exact scaled integer (`RATE_SCALE`, 1e12). The money math uses only this. */
  rateScaled: bigint;
  /** The same rate as its canonical decimal string; stamped on every `journal_line.fx_rate`. */
  rate: string;
  /** The validity date of the rate used, or null for the trivial base-currency rate of 1. */
  rateAsOf: string | null;
  /** Where the rate came from: `base` (same currency), `explicit` (caller-supplied), or the row's source. */
  rateSource: string;
  /** The admissible MWSTV Art. 45 method the rate was recorded under, when the row named one. */
  rateMethod: string | null;
}

/**
 * What a successful resolution sends back (P9).
 *
 * WHY THIS ONE WAS CONVERTED FIRST. `resolveFxRate` is the ONE rate surface: `postEntry`,
 * `recordPayment`, `issueInvoice` and `getExchangeRate` all price money through it and none of them
 * has a second mechanism. All four then wrote the same line to get at the answer:
 *
 *     const resolved = resolution.resolved as ResolvedRate;
 *
 * That cast is what an open `Result` costs. `resolution.resolved` was `unknown`, so every consumer
 * had to assert the shape back, and an assertion is a promise the compiler stops checking: rename
 * `resolved`, or change what it holds, and all four casts go on compiling while the money math reads
 * `undefined.rateScaled` at runtime. Declared here, the field is a closed object type and the four
 * casts are deleted rather than moved.
 *
 * `rateId` and `provenance` are OPTIONAL because they are genuinely absent on two of the three
 * success paths: a base-currency resolution and a caller-supplied explicit rate came from no stored
 * row, so there is no row id and no provenance to name. Optional states that; nullable would claim a
 * row exists whose provenance is unknown.
 */
export type ResolveFxRateOk = {
  /** The rate, and everything the money math and the disclosure need to state it. */
  readonly resolved: ResolvedRate;
  /** The `exchange_rate` row the rate came from. Absent for a base or caller-supplied rate. */
  readonly rateId?: string;
  /** That row's provenance note, when it carries one. Absent when no row was read. */
  readonly provenance?: string | null;
};

/**
 * Resolve the rate that converts `currency` into the workspace base currency on `date`.
 *
 * `explicitRate`, when given, wins over the store: a caller who names a rate is asserting the rate
 * their books were made with, and silently overriding it with a stored one would be a different lie
 * than guessing. It is still validated (parseable, positive, representable), and it is still stamped
 * on every line, so the assertion is auditable.
 */
export function resolveFxRate(
  ctx: WorkspaceContext,
  input: { currency: string; date: string; explicitRate?: string | undefined },
): Result<ResolveFxRateOk> {
  const base = baseCurrencyOf(ctx);

  if (!isCurrencyCode(input.currency)) {
    return err('invalid_input', { field: 'currency' });
  }

  if (input.currency === base) {
    // A base-currency posting has no FX. A caller who nonetheless names a rate other than 1 is
    // confused about something, and posting anyway would store a trace that means nothing.
    if (input.explicitRate !== undefined) {
      const scaled = parseRate(input.explicitRate);
      if (scaled === null) return err('invalid_input', { field: 'fxRate' });
      if (scaled !== RATE_ONE) {
        return err('invalid_fx_rate', {
          currency: input.currency,
          baseCurrency: base,
          rate: input.explicitRate,
          reason: 'a posting already in the base currency converts at 1',
        });
      }
    }
    const resolved: ResolvedRate = {
      currency: base,
      baseCurrency: base,
      rateScaled: RATE_ONE,
      rate: formatRate(RATE_ONE),
      rateAsOf: null,
      rateSource: 'base',
      rateMethod: null,
    };
    return ok({ resolved });
  }

  if (input.explicitRate !== undefined) {
    const scaled = parseRate(input.explicitRate);
    if (scaled === null) return err('invalid_input', { field: 'fxRate' });
    const resolved: ResolvedRate = {
      currency: input.currency,
      baseCurrency: base,
      rateScaled: scaled,
      rate: formatRate(scaled),
      rateAsOf: null,
      rateSource: 'explicit',
      rateMethod: null,
    };
    return ok({ resolved });
  }

  // §H-TENANT: the lookup is workspace-scoped, like every other query in the engine.
  const row = ctx.store.db
    .prepare(
      `SELECT * FROM exchange_rate
        WHERE workspace_id = ? AND base_currency = ? AND quote_currency = ? AND as_of <= ?
        ORDER BY as_of DESC, created_at DESC
        LIMIT 1`,
    )
    .get(ctx.workspaceId, input.currency, base, input.date) as ExchangeRateRow | undefined;

  if (row === undefined) {
    const newest = ctx.store.db
      .prepare(
        `SELECT as_of FROM exchange_rate
          WHERE workspace_id = ? AND base_currency = ? AND quote_currency = ?
          ORDER BY as_of DESC LIMIT 1`,
      )
      .get(ctx.workspaceId, input.currency, base) as { as_of: string } | undefined;
    return err('needs_fx_rate', {
      currency: input.currency,
      baseCurrency: base,
      date: input.date,
      latestAsOf: newest?.as_of ?? null,
      maxAgeDays: MAX_RATE_AGE_DAYS,
      reason:
        newest === undefined
          ? 'no rate has been recorded for this pair: record one with record_exchange_rate, or pass fxRate explicitly'
          : 'every recorded rate for this pair is dated after this posting: record the rate that governs this date',
    });
  }

  // The MONTHLY window. A Monatsmittelkurs is one rate for one calendar month by construction, so it
  // is stored once, on the first of its month, and governs every date in that month. Holding it to
  // the seven-day daily bound would refuse the 9th of the month onwards and make the entire Abs. 3
  // monthly basis unusable; stretching the daily bound to a month instead would let a single
  // Tageskurs price four weeks, which is the failure the bound exists to prevent. So the window
  // follows the METHOD the rate declares, and a monthly rate never reaches outside its own month.
  const monthly = row.method === 'monthly_avg' && row.as_of.slice(0, 7) === input.date.slice(0, 7);
  const age = daysBetween(row.as_of, input.date);
  if (!monthly && age > MAX_RATE_AGE_DAYS) {
    return err('needs_fx_rate', {
      currency: input.currency,
      baseCurrency: base,
      date: input.date,
      latestAsOf: row.as_of,
      ageDays: age,
      maxAgeDays: MAX_RATE_AGE_DAYS,
      ...(row.method === 'monthly_avg'
        ? { method: row.method, reason: 'the newest Monatsmittelkurs is for an earlier month: record the one for this month' }
        : { reason: 'the newest recorded rate is too old to price this posting: record a current rate' }),
    });
  }

  // The Abs. 5 lock, at the point the rate would actually price something. Ordinarily an
  // inadmissible rate never lands (`recordExchangeRate` refuses it), so this fires when the ELECTION
  // arrived after the rate did. It refuses rather than reaching further back for an admissible older
  // row: a silent second-choice rate is exactly the plausible-but-wrong number §H-FX exists to
  // prevent, and the operator can see and fix a refusal.
  const inadmissible = assertFxMethodAdmissible(
    ctx,
    input.date,
    row.method,
    'record the rate for this basis with record_exchange_rate or import_exchange_rates, or pass fxRate explicitly',
  );
  if (inadmissible !== null) return { ...inadmissible, rateId: row.id, asOf: row.as_of };

  const resolved: ResolvedRate = {
    currency: input.currency,
    baseCurrency: base,
    rateScaled: BigInt(row.rate_scaled),
    rate: row.rate,
    rateAsOf: row.as_of,
    rateSource: row.source,
    rateMethod: row.method,
  };
  return ok({ resolved, rateId: row.id, provenance: row.provenance });
}

export interface RecordExchangeRateInput {
  /** The FOREIGN currency: the pair's base side, the one being priced. */
  baseCurrency: string;
  /** The currency the price is expressed in. Must be the workspace's ledger base currency. */
  quoteCurrency?: string;
  /** The rate as a decimal string, e.g. `'0.9412'`. Never a float on the wire. */
  rate: string;
  /** The date the rate is valid FOR (`YYYY-MM-DD`), not the date it was entered. */
  asOf: string;
  source?: string;
  /** The admissible MWSTV Art. 45 method this rate is (see `FX_RATE_METHODS`). */
  method?: string;
  /** Free-text citation of where the rate came from, so an auditor can retrace it. */
  provenance?: string;
  idempotencyKey: string;
}

/**
 * Record a rate (§H-IDEMPOTENT).
 *
 * A rate is write-once per `(workspace, pair, as_of, source)`. Re-recording the SAME value is a
 * no-op that returns the existing row, which is what makes a retry safe. Re-recording a DIFFERENT
 * value for a key that already exists is REFUSED (`rate_conflict`), because that rate may already
 * have priced a posted entry, and a posted entry's rate cannot be changed under it (§H-AUDIT): the
 * ledger stamps the rate on its own lines precisely so history stays true, and letting the reference
 * row drift would make the two disagree about what happened. A genuinely different rate is a
 * different `as_of` or a different `source`.
 */
export function recordExchangeRate(ctx: WorkspaceContext, input: RecordExchangeRateInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireString(input.baseCurrency, 'baseCurrency') ??
    requireString(input.rate, 'rate') ??
    requireDate(input.asOf, 'asOf') ??
    optionalId(input.quoteCurrency, 'quoteCurrency') ??
    optionalId(input.source, 'source') ??
    optionalId(input.method, 'method');
  if (guard) return guard;
  if (input.provenance !== undefined && typeof input.provenance !== 'string') {
    return err('invalid_input', { field: 'provenance' });
  }

  const workspaceBase = baseCurrencyOf(ctx);
  const quote = input.quoteCurrency ?? workspaceBase;
  if (!isCurrencyCode(input.baseCurrency)) return err('invalid_input', { field: 'baseCurrency' });
  if (!isCurrencyCode(quote)) return err('invalid_input', { field: 'quoteCurrency' });

  // The convention trap, closed at the write (see rateMath.ts): the LEDGER base currency is the
  // pair's QUOTE side. A row quoting the other direction would parse fine and resolve never, so it
  // is refused rather than stored as a rate nothing can use.
  if (quote !== workspaceBase) {
    return err('invalid_currency_pair', {
      baseCurrency: input.baseCurrency,
      quoteCurrency: quote,
      workspaceBaseCurrency: workspaceBase,
      reason: 'a rate is stored as the price of one unit of the foreign currency IN the workspace base currency',
    });
  }
  if (input.baseCurrency === quote) {
    return err('invalid_currency_pair', {
      baseCurrency: input.baseCurrency,
      quoteCurrency: quote,
      reason: 'a currency does not need a rate against itself',
    });
  }

  const source = input.source ?? 'manual';
  if (!EXCHANGE_RATE_SOURCES.includes(source)) {
    return err('invalid_source', { source, allowed: EXCHANGE_RATE_SOURCES });
  }
  if (input.method !== undefined && !FX_RATE_METHODS.includes(input.method)) {
    return err('invalid_fx_method', { method: input.method, allowed: FX_RATE_METHODS });
  }

  // The Abs. 5 lock, at the EARLIEST honest point. A rate declaring a basis this workspace is not on
  // for the Steuerperiode its `asOf` falls in would store fine and then refuse every posting it was
  // recorded for, which teaches the operator the rule at the wrong moment and leaves an inadmissible
  // row in the audit trail for nothing. So the bad row never lands.
  const inadmissible = assertFxMethodAdmissible(
    ctx,
    input.asOf,
    input.method,
    'record the rate for the elected basis, or change the election for a Steuerperiode that is still open with set_fx_method',
  );
  if (inadmissible !== null) return inadmissible;

  const scaled = parseRate(input.rate);
  if (scaled === null) {
    return err('invalid_input', {
      field: 'rate',
      reason: `a rate is a positive decimal string with at most ${RATE_DECIMALS} places and no larger than ${formatRate(RATE_MAX_SCALED)}, never a float`,
    });
  }
  const canonical = formatRate(scaled);

  const readExisting = (): ExchangeRateRow | undefined =>
    ctx.store.db
      .prepare(
        `SELECT * FROM exchange_rate
          WHERE workspace_id = ? AND base_currency = ? AND quote_currency = ? AND as_of = ? AND source = ?`,
      )
      .get(ctx.workspaceId, input.baseCurrency, quote, input.asOf, source) as ExchangeRateRow | undefined;

  // The conflict is decided BEFORE the idempotency wrapper, deliberately: `rememberIdempotent`
  // stores whatever its compute returns, so a rejection computed inside it would be memoised under
  // the caller's key and replayed forever, even after the operator recorded the right rate.
  // Compared as BIGINTS, not through `Number(scaled)`. Two rates that differ only beyond the safe
  // integer range would compare EQUAL through a double, and "equal" here means the submitted rate
  // silently takes the place of a rate that may already have priced a posted entry. `RATE_MAX_SCALED`
  // keeps every stored value inside the safe range so the two agree today, but the comparison that
  // decides whether history is being rewritten does not get to depend on that.
  const clash = readExisting();
  if (clash !== undefined && BigInt(clash.rate_scaled) !== scaled) {
    return err('rate_conflict', {
      rateId: clash.id,
      baseCurrency: input.baseCurrency,
      quoteCurrency: quote,
      asOf: input.asOf,
      source,
      storedRate: clash.rate,
      submittedRate: canonical,
      reason:
        'this rate may already have priced a posted entry: record the correction under a different asOf or source',
    });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'record_exchange_rate', () => {
    const existing = readExisting();
    if (existing !== undefined) {
      return ok({ rateId: existing.id, rate: existing.rate, asOf: existing.as_of, source, method: existing.method, created: false });
    }

    const id = ctx.ids.next('fxrate');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO exchange_rate
           (id, workspace_id, base_currency, quote_currency, rate, rate_scaled, as_of, source, method, provenance, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.baseCurrency,
        quote,
        canonical,
        // Bound as a BIGINT: better-sqlite3 writes it straight into the 64-bit INTEGER column, so the
        // value never passes through a double on its way to disk.
        scaled,
        input.asOf,
        source,
        input.method ?? null,
        input.provenance ?? null,
        at,
        ctx.actor,
      );
    ctx.audit.record({
      entityKind: 'exchange_rate',
      entityId: id,
      action: 'record',
      actor: ctx.actor,
      at,
    });
    return ok({ rateId: id, rate: canonical, asOf: input.asOf, source, method: input.method ?? null, created: true });
  });
}

export interface ListExchangeRatesInput {
  baseCurrency?: string;
  quoteCurrency?: string;
  from?: string;
  to?: string;
}

/** List recorded rates, newest validity date first. §H-TENANT: workspace-scoped, always. */
export function listExchangeRates(ctx: WorkspaceContext, input: ListExchangeRatesInput = {}): Result {
  const guard =
    optionalId(input.baseCurrency, 'baseCurrency') ??
    optionalId(input.quoteCurrency, 'quoteCurrency') ??
    optionalDate(input.from, 'from') ??
    optionalDate(input.to, 'to');
  if (guard) return guard;

  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (input.baseCurrency !== undefined) {
    where.push('base_currency = ?');
    params.push(input.baseCurrency);
  }
  if (input.quoteCurrency !== undefined) {
    where.push('quote_currency = ?');
    params.push(input.quoteCurrency);
  }
  if (input.from !== undefined) {
    where.push('as_of >= ?');
    params.push(input.from);
  }
  if (input.to !== undefined) {
    where.push('as_of <= ?');
    params.push(input.to);
  }

  const rows = ctx.store.db
    .prepare(`SELECT * FROM exchange_rate WHERE ${where.join(' AND ')} ORDER BY as_of DESC, base_currency ASC`)
    .all(...params) as ExchangeRateRow[];

  return ok({
    rates: rows.map((r) => ({
      id: r.id,
      baseCurrency: r.base_currency,
      quoteCurrency: r.quote_currency,
      rate: r.rate,
      asOf: r.as_of,
      source: r.source,
      method: r.method,
      provenance: r.provenance,
      createdAt: r.created_at,
    })),
  });
}

/**
 * The read twin of resolution: "what rate WOULD price a posting in this currency on this date?"
 *
 * A human needs this before issuing, and an agent needs it before promising a customer a figure.
 * Without it the only way to learn the answer is to attempt a posting, which is not a question a
 * money path should make anyone ask by trying.
 */
export function getExchangeRate(
  ctx: WorkspaceContext,
  input: { currency: string; date?: string },
): Result {
  const guard = requireString(input.currency, 'currency') ?? optionalDate(input.date, 'date');
  if (guard) return guard;
  const date = input.date ?? ctx.clock.now().slice(0, 10);
  const resolved = resolveFxRate(ctx, { currency: input.currency, date });
  if (!resolved.ok) return resolved;
  const r = resolved.resolved;
  return ok({
    currency: r.currency,
    baseCurrency: r.baseCurrency,
    rate: r.rate,
    rateAsOf: r.rateAsOf,
    rateSource: r.rateSource,
    rateMethod: r.rateMethod,
    date,
  });
}
