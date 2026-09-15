/**
 * §H-FX, the verb surface: the rate store reachable from every shipped face.
 *
 * A rate that only the engine can reach is not a feature, it is a private field. These three verbs
 * put the `exchange_rate` store where a human (Studio, over REST) and an agent (MCP) can both use
 * it: record the rate, list what is on file, and ask what rate WOULD price a posting on a given date
 * before committing to one. Without the last of those, the only way to learn the answer is to
 * attempt a posting, which is not a question a money path should make anyone ask by trying.
 *
 * These are defined here rather than inline in `registry.ts` for ONE reason: the registry is the
 * single append-only tool list and several agents append to it at once, so the smaller the hunk the
 * cheaper the merge. `registry.ts` gains an import and a one-line spread; everything else lives here.
 *
 * The helpers arrive as a parameter rather than an import to keep the module graph acyclic:
 * `registry.ts` imports this file, and this file must not import `registry.ts` back at runtime (its
 * `const` helpers would be in the temporal dead zone while the cycle resolved). Only TYPES cross the
 * boundary in this direction, and those are erased.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  recordExchangeRate,
  listExchangeRates,
  getExchangeRate,
  setFxMethod,
  getFxMethod,
  importExchangeRates,
  describeRateFeed,
  computeFxRevaluation,
  postFxRevaluation,
  reverseFxRevaluation,
} from '../core/fx/index.js';

export interface ActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The §H-FX verbs, in append order. `ApiDeps` is referenced so the module's contract stays explicit. */
export function fxActions(h: ActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'record_exchange_rate',
      'write',
      "Record a foreign-currency rate (§H-FX). `rate` is a DECIMAL STRING and is the price of one unit of `baseCurrency` in the workspace base currency, so EUR/CHF 0.9412 means 1 EUR = 0.9412 CHF. `asOf` is the date the rate is valid FOR. `method` names the admissible MWSTV Art. 45 basis (daily | monthly_avg | bank | group). Recording the same rate twice is one row; a different rate under the same date and source is refused, because it may already have priced a posted entry.",
      ctxSchema(
        {
          baseCurrency: STR,
          quoteCurrency: STR,
          rate: STR,
          asOf: STR,
          source: STR,
          method: STR,
          provenance: STR,
          idempotencyKey: STR,
        },
        ['baseCurrency', 'rate', 'asOf', 'idempotencyKey'],
      ),
      (ctx, input) => recordExchangeRate(ctx, input as never),
    ),
    ctxAction(
      'list_exchange_rates',
      'read',
      'List recorded foreign-currency rates, newest validity date first, optionally filtered by currency pair and date range.',
      ctxSchema({ baseCurrency: STR, quoteCurrency: STR, from: STR, to: STR }),
      (ctx, input) => listExchangeRates(ctx, input as never),
    ),
    ctxAction(
      'get_exchange_rate',
      'read',
      'Resolve which rate WOULD convert a currency into the workspace base currency on a date, and report the validity date, source and method of the rate that governs. Answers `needs_fx_rate` when none is admissible, rather than inventing one.',
      ctxSchema({ currency: STR, date: STR }, ['currency']),
      (ctx, input) => getExchangeRate(ctx, input as never),
    ),
    ctxAction(
      'set_fx_method',
      'write',
      "Elect the MWSTV Art. 45 conversion basis for a Steuerperiode: `daily` (Tageskurs, Devisenkurs Verkauf), `monthly_avg` (Monatsmittelkurs) or `group` (Konzernumrechnungskurs, group members only). `taxPeriod` is a calendar year (MWSTG Art. 34 Abs. 2) and defaults to the current one. The election carries forward until it is changed. Art. 45 Abs. 5 binds it for at least one Steuerperiode, so it may only be written while that period, and every period after it, still holds no posted foreign-currency entry. `bank` (Abs. 3bis) is not electable: it is the mandated fallback for currencies the ESTV publishes no rate for and stays admissible under every election.",
      ctxSchema({ method: STR, taxPeriod: STR }, ['method']),
      (ctx, input) => setFxMethod(ctx, input as never),
    ),
    ctxAction(
      'get_fx_method',
      'read',
      'Report which MWSTV Art. 45 conversion basis governs a Steuerperiode, whether that period is already settled by a posted foreign-currency entry, the earliest period whose basis may still be chosen, and the full election history. Ask by `taxPeriod` (YYYY) or by any `date` inside it.',
      ctxSchema({ taxPeriod: STR, date: STR }),
      (ctx, input) => getFxMethod(ctx, input as never),
    ),
    ctxAction(
      'describe_rate_feed',
      'read',
      'Report which published rate series MWSTV Art. 45 admits, the endpoint each one lives at, how its validity dates and per-unit quotations work, and the pages that establish it. Call this first: the engine performs NO network I/O, so a caller fetches the endpoint itself and hands the response body to `import_exchange_rates`.',
      ctxSchema(),
      (ctx) => describeRateFeed(ctx),
    ),
    ctxAction(
      'import_exchange_rates',
      'write',
      "Import a published BAZG rate payload into the rate store as `source='rate_api'`. `payload` is the response body from the endpoint `describe_rate_feed` names, verbatim. The payload identifies its own series; pass `series` to have a mis-paired payload refused rather than mis-dated. Daily rates are stored on each date in the payload's validity window (not on the determination date), monthly averages once on the first of their month, and per-unit quotations (100, 1000, 10000) are scaled. A published rate TILL cannot hold exactly at twelve decimal places is reported rather than rounded; the whole BAZG daily series is within that (its deepest is nine places).",
      ctxSchema(
        { payload: STR, series: STR, currencies: { type: 'array' }, idempotencyKey: STR },
        ['payload', 'idempotencyKey'],
      ),
      (ctx, input) => importExchangeRates(ctx, input as never),
    ),
    ctxAction(
      'fx_revaluation',
      'read',
      "Revalue every open foreign-currency monetary position (A19 FC bank balances, A16/A17 open FC debtor/creditor items) at the closing rate for `periodEnd` (OR Art. 960a: Bilanzstichtagskurs). Returns each position with its foreign-currency amount, book CHF, closing rate, revalued CHF and the UNREALISED diff, the per-currency subtotals, the net total, and any currency that still needs a rate. A read model: nothing is posted. Negative total is a net unrealised loss.",
      ctxSchema({ periodEnd: STR }, ['periodEnd']),
      (ctx, input) => computeFxRevaluation(ctx, input as never),
    ),
    ctxAction(
      'post_fx_revaluation',
      'write',
      "Post the period-end UNREALISED currency gain/loss as a balanced entry (source `fx`) plus its next-period reversal, atomically. The unrealised difference books to account 6949 against each revalued position, and the entry auto-reverses on the first day of the next period so the REALISED figure at settlement (A14/A18) is never double-counted. Idempotent per `periodEnd`: a re-post with the same key replays, a different key returns `already_posted`, a zero-diff period posts nothing. Refuses `needs_rate` when any open FC position lacks a closing rate, and `period_locked` for a locked target period (A03).",
      ctxSchema({ periodEnd: STR, idempotencyKey: STR }, ['periodEnd', 'idempotencyKey']),
      (ctx, input) => postFxRevaluation(ctx, input as never),
    ),
    ctxAction(
      'fx_revaluation_reverse',
      'write',
      "Revert a posted FX revaluation run (D129 Q2): books the mirror of the revaluation entry dated the period end (`source` `fx`) plus its own next-day reversal, atomically, so every position and account 6949 net to zero on both dates and nothing is edited. `runId` is the run `post_fx_revaluation` returned. Refuses `not_posted` for a run that posted nothing, `already_reversed`, `later_run_exists` naming the later period end whose run still stands (revert newest first), and `period_locked` for a locked period. Idempotent on `idempotencyKey`.",
      ctxSchema({ runId: STR, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => reverseFxRevaluation(ctx, input as never),
    ),
  ];
}

/** Re-exported so a host that only imports this module still sees the deps shape it must supply. */
export type { ApiDeps };
