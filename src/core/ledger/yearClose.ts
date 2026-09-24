/**
 * A03 US-A03.3, the year-end hard close (Kontenrahmen KMU 2979 → 2970).
 *
 * Computes the year's result (Σ income − Σ expense, base Rappen), posts a closing journal entry that
 * zeroes every P&L account into 2979 Jahresgewinn/-verlust, carries 2979 into 2970 Gewinnvortrag so the
 * P&L opens at zero next year, and seals the fiscal year with a hard `period_lock` (reason=`year_close`).
 *
 * It is the P3 discipline in action: the close does NOT open a second writer, it posts through A02
 * `postEntry` with `source='close'`, which balances and seals the rows exactly like any other posting.
 * It is idempotent (§H-IDEMPOTENT): a retry with the same key replays; a re-close with a different key
 * returns `year_already_closed`, never a second carry.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { postEntry } from './postEntry.js';
import type { LineInput } from './postEntry.js';

/** A closing post rejected: carried out of the idempotency transaction so the key never burns. */
class YearCloseFailure {
  constructor(readonly result: Result) {}
}

/** The calendar day before an ISO `YYYY-MM-DD`. Pure date arithmetic, no wall-clock read. */
function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface PlRow {
  account_id: string;
  net: number;
}

export function hardCloseYear(
  ctx: WorkspaceContext,
  input: { year: number | string; idempotencyKey: string },
): Result {
  // Year-close is an owner/Treuhänder act, gated like every other period write (§3), not automatable.
  const capable = ctx.capabilities.assert('manage_periods');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const yearNum = Number(input.year);
  // Upper bound 9998 so `dayBefore(`${year + 1}-...`)` stays inside the ISO-8601 4-digit year range.
  if (!Number.isInteger(yearNum) || yearNum < 1000 || yearNum > 9998) {
    return err('invalid_year', { year: input.year });
  }
  const year = String(yearNum);

  // Replay a completed close before the state-dependent "already closed" guard, so a retry of the
  // exact same close returns the original result instead of `year_already_closed` (§H-IDEMPOTENT).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'close_year');
  if (replayed !== undefined) return replayed;

  const fyStart =
    (ctx.store.db.prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?').get(ctx.workspaceId) as
      | { fiscal_year_start: string }
      | undefined)?.fiscal_year_start ?? '01-01';
  const start = `${year}-${fyStart}`;
  const nextStart = `${yearNum + 1}-${fyStart}`;
  const end = dayBefore(nextStart);

  // Already CLOSED by a DIFFERENT key? Only a year-close seal counts (a matching key was replayed
  // above). A soft year-lock, or a manual/filing hard lock, is NOT "already closed": it is upgraded to
  // the year-close seal below, so a legitimate first close is never mislabelled `year_already_closed`.
  const sealed = ctx.store.db
    .prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND period = ? AND kind = 'hard' AND reason = 'year_close'")
    .get(ctx.workspaceId, year) as { period: string } | undefined;
  if (sealed !== undefined) return err('year_already_closed', { year });

  // Resolve the fixed carry accounts (A01 guarantees them; typed equity).
  const acc = (number: string): string | undefined =>
    (ctx.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
      .get(ctx.workspaceId, number) as { id: string } | undefined)?.id;
  const a2979 = acc('2979');
  const a2970 = acc('2970');
  if (a2979 === undefined || a2970 === undefined) {
    return err('missing_carry_account', { need: ['2979', '2970'] });
  }

  // Net (debit − credit) per P&L account, over posted, non-close entries in this fiscal year.
  //
  // The FROM clause is written in this order deliberately. The store collects NO table statistics
  // (ANALYZE is a write, and D12 puts a second writer on the file: see `SqliteStore.close()`), so the
  // planner has nothing to tell it that the selective fence lives on journal_entry (one workspace,
  // one year, posted, not a close) rather than on journal_line. Left to itself it drives the whole
  // join off journal_line_account: a full index scan of the largest table in the file plus a row
  // fetch for every line the ledger has ever held, most of which the date filter then throws away.
  //
  // CROSS JOIN is SQLite's join-ORDER constraint and means nothing else here (it is an inner join
  // with a fixed outer table, not a cartesian product: the ON clause still applies). It pins
  // journal_entry as the outer loop, and each entry's handful of lines is then looked up by
  // entry_id. `INDEXED BY journal_line_entry` makes that lookup a constraint rather than a hope:
  // without that index, driving off journal_entry would mean a table scan PER ENTRY, so failing to
  // prepare is the only safe way to be wrong. The index set is pinned by an exact-match assertion in
  // test/core/journal-line-indexes.test.mjs.
  //
  // Re-measured on this branch, 10'000 entries / 30'000 lines, file-backed, separate seeded
  // databases exercised in one process in a rotating round, 21 scored rounds, median round, on a
  // ledger carrying three years of history (the only kind of book anyone ever closes a year on):
  //
  //   as-is                              14.48 ms
  //   FROM journal_line l NOT INDEXED     9.99 ms  1.45x
  //   this form                           4.86 ms  2.98x
  //   as-is after a full ANALYZE          4.95 ms  what statistics would buy, reached without them
  //
  // `NOT INDEXED` was the obvious lever and it is the one this replaces: it restores the plain table
  // scan the sweep had before the indexes existed, which is better than the current plan but leaves
  // half the win on the table, because a scan still reads every line of every year. On a single-year
  // ledger the same four arms read 17.68 / 15.71 / 12.10 / 12.28 ms, so this form is the best arm in
  // both shapes and never the worst in either.
  //
  // RE-MEASURED INDEPENDENTLY on 2026-07-25, same method, same fixture shape, different machine load:
  // 13.73 / 8.63 / 3.29 / 3.34 ms on three years, and 16.54 / 13.70 / 9.99 / 10.09 ms on one. The
  // absolute numbers move by a third between runs, so treat them as the ORDER they establish and not
  // as constants. The ordering has now been reproduced twice, and in memory too (13.45 / 8.55 / 3.28
  // / 3.35 ms), so a `:memory:` suite observes the same thing a file does at this size.
  //
  // AND THE FACT THAT EXPLAINS WHY THE ABSOLUTE NUMBERS ARE SO SHAPE-DEPENDENT: the gain scales with
  // how much of the book lies OUTSIDE the year being closed, because that is exactly the population
  // this join order decides whether to touch at all. Holding the book constant at 10'000 entries and
  // varying only how many fiscal years they span:
  //
  //   share of the book outside the closed year    0%     50%    67%    80%    90%
  //   gain of this form over the as-was one       1.65x  2.70x  4.10x  4.81x  7.45x
  //
  // So a single-year fixture HIDES most of this, and a single-year fixture is also the one shape
  // nobody ever closes a year on. Anyone re-measuring must seed prior years or the number is not
  // about TILL. The four-arm table on `SqliteStore.close()` carries the full figures.
  const plRows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account_id, SUM(l.base_debit_minor - l.base_credit_minor) AS net
         FROM journal_entry e
         CROSS JOIN journal_line l INDEXED BY journal_line_entry ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source != 'close'
          AND e.date >= ? AND e.date <= ?
          AND a.type IN ('income', 'expense')
        GROUP BY l.account_id
       HAVING net != 0`,
    )
    .all(ctx.workspaceId, start, end) as PlRow[];

  // Zero each P&L account (post the opposite of its balance); the offset lands on 2979.
  const plLines: LineInput[] = [];
  let sumNet = 0n; // Σ (debit − credit) across P&L accounts; result = −sumNet.
  for (const r of plRows) {
    const net = BigInt(r.net);
    sumNet += net;
    plLines.push(net > 0n ? { account: r.account_id, credit: Number(net) } : { account: r.account_id, debit: Number(-net) });
  }
  const result = -sumNet; // profit > 0, loss < 0.

  if (sumNet !== 0n) {
    // Balance the close entry: 2979 absorbs the opposite of the P&L lines' net.
    plLines.push(sumNet > 0n ? { account: a2979, debit: Number(sumNet) } : { account: a2979, credit: Number(-sumNet) });
  }

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'close_year', () => {
      let closingEntryId: string | null = null;
      if (plLines.length > 0) {
        const posted = postEntry(ctx, {
          date: end,
          source: 'close',
          description: `Jahresabschluss ${year}: Erfolgsrechnung nach 2979`,
          idempotencyKey: `${input.idempotencyKey}:pl`,
          lines: plLines,
        });
        if (!posted.ok) throw new YearCloseFailure(posted);
        closingEntryId = posted.entryId;
      }

      // Carry 2979's ACTUAL balance (debit − credit) to 2970, read after the P&L sweep, so 2979 always
      // opens at zero even if it carried a residual before the close (e.g. a stray manual posting). This
      // makes the carry robust rather than trusting `sumNet` to equal 2979's balance.
      const bal2979 = (
        ctx.store.db
          .prepare(
            `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS bal
               FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
              WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ?`,
          )
          .get(ctx.workspaceId, a2979) as { bal: number }
      ).bal;
      const carry = BigInt(bal2979);

      let carryEntryId: string | null = null;
      if (carry !== 0n) {
        // 2979 holds `carry` (debit − credit); post the opposite to zero it, offset to 2970.
        const carryLines: LineInput[] =
          carry > 0n
            ? [{ account: a2979, credit: Number(carry) }, { account: a2970, debit: Number(carry) }]
            : [{ account: a2979, debit: Number(-carry) }, { account: a2970, credit: Number(-carry) }];
        const carried = postEntry(ctx, {
          date: end,
          source: 'close',
          description: `Jahresabschluss ${year}: 2979 nach 2970`,
          idempotencyKey: `${input.idempotencyKey}:carry`,
          lines: carryLines,
        });
        if (!carried.ok) throw new YearCloseFailure(carried);
        carryEntryId = carried.entryId;
      }

      // Seal the fiscal year. Posted AFTER the closing entries so their own source='close' postings are
      // not blocked by this seal; the narrow source='close' relaxation additionally lets them clear a
      // month soft-lock or a filing lock inside the year (see postEntry). UPSERT so an existing soft or
      // manual lock on the `YYYY` period is upgraded to the year-close seal rather than tripping the PK.
      ctx.store.db
        .prepare(
          `INSERT INTO period_lock (workspace_id, period, kind, locked_at, locked_by, reason)
           VALUES (?, ?, 'hard', ?, ?, 'year_close')
           ON CONFLICT(workspace_id, period)
           DO UPDATE SET kind = 'hard', reason = 'year_close', locked_at = excluded.locked_at, locked_by = excluded.locked_by`,
        )
        .run(ctx.workspaceId, year, ctx.clock.now(), ctx.actor);
      ctx.audit.record({ entityKind: 'period_lock', entityId: year, action: 'lock', actor: ctx.actor, at: ctx.clock.now() });

      // `result` is swept from `base_debit_minor - base_credit_minor`, so it is in the workspace BASE
      // currency BY CONSTRUCTION, never the transaction currency the movement arrived in. Sending it
      // unnamed made every caller either read `get_company_profile` for the label or guess, and
      // guessing is how `Total MWST CHF 81.00` reached a EUR document whose real franc VAT was 76.24.
      // A base currency is a SETTING (`workspace.base_currency`, and CURRENCIES admits CHF, EUR and
      // USD), so "the books are Swiss" is not a defence.
      //
      // UNCONDITIONAL, which is the one thing here that differs from `get_document`. That read model
      // states its conversion basis only when the document HAS one, because on a domestic row a base
      // total beside an identical currency is noise. `result` has no transaction twin beside it: it
      // is a single number, and there is no way to render it that does not need a unit. So it is sent
      // in a CHF book too, and on a year that closed at zero.
      //
      // It is read INSIDE the remembered value rather than beside it, so the idempotent replay of a
      // retried close hands back the currency with the figure instead of a labelless snapshot.
      return ok({ closingEntryId, carryEntryId, result: Number(result), baseCurrency: baseCurrencyOf(ctx) });
    });
  } catch (e) {
    if (e instanceof YearCloseFailure) return e.result;
    throw e;
  }
}
