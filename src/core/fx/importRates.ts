/**
 * §H-FX, the rate-feed import verb: published rates into `exchange_rate` with `source='rate_api'`.
 *
 * The parser (`./bazgFeed.ts`) establishes WHICH series is admissible and what its payload means.
 * This file is the ledger-facing half: it turns a parsed payload into stored rates, with the
 * provenance an ESTV control needs to walk from a posted entry back to a published figure.
 *
 * ## Three decisions worth reading before changing anything here
 *
 * **The engine never fetches.** `payload` arrives from the caller. TILL is local-first, every verb is
 * synchronous, and a posting must never depend on a network call. `describeRateFeed` tells a caller
 * exactly what to fetch, so an agent with a fetch tool, a CLI with curl and a Studio with a proxy all
 * drive the same verb without the engine holding a socket.
 *
 * **Every rate goes through `recordExchangeRate`.** Not a second INSERT path. That is what makes the
 * import inherit, for free and without restating them, the write-once rule per
 * (workspace, pair, as_of, source), the `rate_conflict` refusal decided OUTSIDE `rememberIdempotent`,
 * the currency-pair guard, and the Art. 45 Abs. 5 method gate. A feed that wrote rows its own way
 * would be a second money path, and P3 says there is one.
 *
 * **A per-currency refusal does not abort the import.** One conflicting EUR row must not cost the
 * operator the other 71 currencies. Refusals that apply to the WHOLE payload (an unreadable
 * document, the wrong series, a method the workspace is not on) refuse the whole call and write
 * nothing; refusals that are about one currency on one date are reported in `skipped`, with the
 * published figures, so the operator can see precisely what did not land and why.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { baseCurrencyOf, recordExchangeRate } from './rates.js';
import { isCurrencyCode, RATE_DECIMALS } from './rateMath.js';
import { assertFxMethodAdmissible, electedFxMethod } from './method.js';
import { parseBazgFeed, RATE_FEED_SERIES, BAZG_DAILY_URL, BAZG_MONTHLY_URL } from './bazgFeed.js';
import type { ParsedFeed, RateFeedSeries } from './bazgFeed.js';

export interface ImportExchangeRatesInput {
  /** The published XML, as fetched from the endpoint `describeRateFeed` names. */
  payload: string;
  /** The series the caller BELIEVES it fetched. Checked against what the payload says it is. */
  series?: string;
  /** Import only these currencies. Absent means every currency the payload publishes. */
  currencies?: string[];
  idempotencyKey: string;
}

/**
 * The citation stored on every imported row.
 *
 * An ESTV control has to be able to go from a posted entry to the published figure that priced it.
 * That means the SCALING has to be retraceable too, so the published unit and quote go in verbatim:
 * "100 EGP = 1.60858 CHF" next to a stored rate of 0.0160858 is a complete audit step, where the
 * stored rate alone is a number nobody can find on any BAZG page.
 */
function provenanceFor(
  feed: ParsedFeed,
  rate: { currency: string; unit: number; quotedRate: string },
  asOf: string,
  baseCurrency: string,
): string {
  const series = RATE_FEED_SERIES.find((s) => s.method === feed.series);
  const determination =
    feed.series === 'daily'
      ? `Kurs ermittelt ${feed.determinedOn ?? '?'}${feed.determinedTime !== undefined ? ` ${feed.determinedTime}` : ''}, gültig ${asOf}`
      : `Monatsmittelkurs ${feed.month ?? '?'}, gültig ab ${asOf}`;
  return [
    series?.name ?? feed.series,
    determination,
    `publiziert: ${rate.unit} ${rate.currency} = ${rate.quotedRate} ${baseCurrency}`,
    'MWSTV Art. 45 Abs. 3 (SR 641.201)',
    feed.endpoint,
  ].join('; ');
}

export interface ImportedRate {
  currency: string;
  asOf: string;
  rate: string;
  created: boolean;
}

export interface SkippedRate {
  currency: string;
  reason: string;
  [key: string]: unknown;
}

/**
 * Import a published BAZG payload into the rate store.
 *
 * §H-IDEMPOTENT: the caller's key is not consumed by an outer wrapper but SPREAD over the per-rate
 * writes, one derived key per (currency, validity date). A replay therefore replays each individual
 * rate through its own `rememberIdempotent` and writes nothing, which settles the import on ROWS
 * rather than on a memoised blob. Storing one giant result under one key would also mean a partially
 * completed import could never be resumed, and a feed import is exactly the operation an operator
 * retries.
 */
export function importExchangeRates(ctx: WorkspaceContext, input: ImportExchangeRatesInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard = requireString(input.idempotencyKey, 'idempotencyKey') ?? requireString(input.payload, 'payload');
  if (guard) return guard;
  if (input.series !== undefined && input.series !== 'daily' && input.series !== 'monthly_avg') {
    return err('invalid_input', { field: 'series', allowed: ['daily', 'monthly_avg'] });
  }
  let wanted: Set<string> | null = null;
  if (input.currencies !== undefined) {
    if (!Array.isArray(input.currencies) || !input.currencies.every((c) => isCurrencyCode(c))) {
      return err('invalid_input', { field: 'currencies', expected: 'an array of ISO 4217 codes' });
    }
    wanted = new Set(input.currencies);
  }

  const feed = parseBazgFeed(input.payload);
  if (!feed.ok) return err(feed.error, { reason: feed.reason, endpoints: [BAZG_DAILY_URL, BAZG_MONTHLY_URL] });

  // The mis-paired-payload guard. A monthly average dated like a daily rate would price a single day
  // with a month's mean and leave the rest of the month refusing, which is the class of silent
  // one-day shift the foundation refused to risk. The payload names its own series, so the two can
  // simply be compared.
  if (input.series !== undefined && input.series !== feed.series) {
    return err('rate_feed_series_mismatch', {
      expected: input.series,
      found: feed.series,
      reason: 'the payload is not the series it was imported as: fetch the endpoint for the series you meant',
    });
  }

  const method: RateFeedSeries = feed.series;
  const base = baseCurrencyOf(ctx);

  // The Art. 45 Abs. 5 gate, applied to the WHOLE payload before anything lands. Every row in a
  // payload carries the same method, so if the workspace is not on that basis the answer is the same
  // for all of them, and 200 identical per-currency skips would bury the one thing the operator
  // needs to read.
  const admissible = feed.validFor.filter(
    (asOf) =>
      assertFxMethodAdmissible(ctx, asOf, method, 'import the series this workspace has elected') === null,
  );
  if (admissible.length === 0) {
    const elected = electedFxMethod(ctx, feed.validFor[0] as string);
    return err('fx_method_not_elected', {
      method,
      electedMethod: elected?.method ?? null,
      electedFor: elected?.electedFor ?? null,
      validFor: feed.validFor,
      recommendedEndpoint: RATE_FEED_SERIES.find((s) => s.method === elected?.method)?.endpoint ?? null,
      reason:
        'this workspace converts on a different MWSTV Art. 45 basis for this Steuerperiode, and the chosen basis must be kept for at least one Steuerperiode (Abs. 5): import the series it has elected',
    });
  }

  const imported: ImportedRate[] = [];
  const skipped: SkippedRate[] = [];
  let created = 0;

  for (const rate of feed.rates) {
    if (wanted !== null && !wanted.has(rate.currency)) continue;
    if (rate.currency === base) {
      skipped.push({ currency: rate.currency, reason: 'base_currency', unit: rate.unit, quotedRate: rate.quotedRate });
      continue;
    }
    if (rate.rate === null) {
      // Never rounded into the books. The published figures travel with the refusal so the operator
      // can decide their own rounding, as their own assertion, with `record_exchange_rate`.
      skipped.push({
        currency: rate.currency,
        reason: rate.reason ?? 'unrepresentable',
        unit: rate.unit,
        quotedRate: rate.quotedRate,
        ...(rate.exact !== undefined ? { exact: rate.exact, rateDecimals: rate.rateDecimals } : {}),
      });
      continue;
    }

    for (const asOf of admissible) {
      const stored = recordExchangeRate(ctx, {
        baseCurrency: rate.currency,
        quoteCurrency: base,
        rate: rate.rate,
        asOf,
        source: 'rate_api',
        method,
        provenance: provenanceFor(feed, rate, asOf, base),
        idempotencyKey: `${input.idempotencyKey}:${feed.series}:${rate.currency}:${asOf}`,
      });
      if (!stored.ok) {
        skipped.push({
          currency: rate.currency,
          asOf,
          reason: stored.error,
          rate: rate.rate,
          unit: rate.unit,
          quotedRate: rate.quotedRate,
          ...(stored.storedRate !== undefined ? { storedRate: stored.storedRate } : {}),
        });
        continue;
      }
      imported.push({ currency: rate.currency, asOf, rate: rate.rate, created: stored.created === true });
      if (stored.created === true) created += 1;
    }
  }

  return ok({
    series: feed.series,
    method,
    source: 'rate_api',
    endpoint: feed.endpoint,
    baseCurrency: base,
    ...(feed.determinedOn !== undefined ? { determinedOn: feed.determinedOn } : {}),
    ...(feed.determinedTime !== undefined ? { determinedTime: feed.determinedTime } : {}),
    ...(feed.month !== undefined ? { month: feed.month } : {}),
    validFor: admissible,
    imported,
    skipped,
    counts: { imported: imported.length, created, unchanged: imported.length - created, skipped: skipped.length },
  });
}

/**
 * What to fetch, from where, and why it is the admissible series.
 *
 * This exists because the alternative is a user or an agent guessing an endpoint, and the §H-FX
 * foundation refused to wire a feed precisely because the wrong series shifts every conversion by a
 * day. A verb that ANSWERS the question is the difference between a documented endpoint and a
 * reachable one: the caller asks TILL what to fetch, fetches it with its own tool, and hands the
 * payload straight back to `import_exchange_rates`.
 */
export function describeRateFeed(ctx: WorkspaceContext): Result {
  const today = ctx.clock.now().slice(0, 10);
  const elected = electedFxMethod(ctx, today);
  const recommended = RATE_FEED_SERIES.find((s) => s.method === elected?.method) ?? null;
  return ok({
    baseCurrency: baseCurrencyOf(ctx),
    // Said out loud so nobody wires a background poller into the money path by accident.
    fetchedByEngine: false,
    howToUse:
      'fetch the endpoint for the series this workspace has elected, then pass the response body verbatim to import_exchange_rates as `payload`. The engine performs no network I/O: a posting must never depend on a network call.',
    electedMethod: elected?.method ?? null,
    recommended:
      recommended === null
        ? null
        : { method: recommended.method, name: recommended.name, endpoint: recommended.endpoint },
    series: RATE_FEED_SERIES.map((s) => ({
      method: s.method,
      name: s.name,
      endpoint: s.endpoint,
      validity: s.validity,
      citations: s.citations,
    })),
    limits: [
      'some currencies are quoted per 100, 1000 or 10000 units (<waehrung>); the importer scales them and never assumes 1.',
      `a published rate that needs more than ${RATE_DECIMALS} decimal places once divided by its unit is reported, never rounded: record your own figure with record_exchange_rate if you need it. The whole BAZG daily series is within that today (its deepest is nine places).`,
      'a group conversion rate (MWSTV Art. 45 Abs. 4) and a domestic bank rate (Abs. 3bis) are not published series: record those with record_exchange_rate.',
    ],
  });
}
