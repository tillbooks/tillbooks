/**
 * A02 §4b.6, `journal_numbering_plan`: the Belegnummer run of a book, inspected without writing anything.
 *
 * It answers what an owner or an agent needs before trusting the run: the settings in force, the counts,
 * every series with its next number, how the migrated entries classify (plain-integer refs, the highest,
 * the duplicates no number was adopted for, the non-numeric refs), and the numbers the next catch-up WOULD
 * assign to the posted entries still without one. The would-assign list is computed by `planNumbering`,
 * the very planner the posting chokepoint applies, so the dry run and the write cannot disagree.
 *
 * Kept out of `./entryNumber.ts` on purpose: that module sits in `postEntry`'s runtime closure, and an
 * inspection read has no business there. A pure read: every statement is a SELECT scoped by `workspaceId`
 * (§H-TENANT), and conformance rule 4 holds it to writing nothing on real data.
 */

import type { WorkspaceContext } from '../context.js';
import { ok } from '../result.js';
import type { Result } from '../result.js';
import {
  ENTRY_COLUMNS,
  identicalContentGroups,
  isMigratedEntry,
  numberingConfigOf,
  numberingPending,
  planNumbering,
  migratedVoucherOf,
  unnumberedPostedEntries,
  type BelegnummerMode,
  type SplitVoucherMode,
  type NumberingEntry,
  type PlannedNumber,
} from './entryNumber.js';

/** Each listed collection is capped at this many rows; the `...Total` beside it carries the full count. */
export const PLAN_LIST_CAP = 200;

/** One series of the run. */
export type NumberingSeriesView = {
  readonly series: string;
  /** The number the series hands out next, or null when it has no counter (not started). */
  readonly nextNumber: number | null;
  /** The highest number assigned in it, or null when none. */
  readonly highest: number | null;
  readonly numbered: number;
};

/** What `journal_numbering_plan` answers. */
export type JournalNumberingPlanOk = {
  readonly settings: { readonly mode: BelegnummerMode; readonly start: number; readonly prefix: string; readonly split: SplitVoucherMode };
  readonly counts: { readonly posted: number; readonly numbered: number; readonly unnumbered: number; readonly adopted: number };
  /**
   * True when a catch-up is owed: a posting was made while numbering was off, or (A02 §4b.3 rule a)
   * migration postings (imports, and the reversals correcting them) wait for the continuous run, which only
   * the first native booking starts under continue_migrated.
   */
  readonly pending: boolean;
  readonly series: readonly NumberingSeriesView[];
  readonly migrated: {
    /** Posted migrated entries (source import, minus the engine's own import postings). */
    readonly entries: number;
    /** How many of them carry a plain-integer ref. */
    readonly plainIntegerRefs: number;
    /** How many carry a bexio reference (`<label> <counter> (<Belegnummer>)`), whose number is the one in parentheses. */
    readonly bexioRefs: number;
    /** The highest old voucher number among them (plain or bexio), or null when none carries one. */
    readonly highestMigratedNumber: number | null;
    /**
     * The migrated claims a person should look at, one row per old number and reason:
     *  - `conflict`: DIFFERENT vouchers claim the number, or a plain integer is claimed twice (no guessing).
     *    `entryIds` are the claims that do NOT read the number, `keptBy` the claim that does, or null. Read
     *    from the actual outcome (the number rows and the would-assign plan), never re-derived (critic r2
     *    L2-3), and once withheld a number stays withheld for every later claimant (critic r3 L3-2).
     *  - `identical_content`: entries under one voucher with the same date, description and lines, a POSSIBLE
     *    double import (an import run twice) or one voucher with equal rows. TILL does not decide which
     *    (critic r3 L3-1, D178 points 18 and 19): the entries are numbered as pieces of the voucher, and
     *    `entryIds` names the whole group for the person to check; `keptBy` is null.
     */
    readonly duplicates: readonly {
      readonly ref: number;
      readonly reason: 'conflict' | 'identical_content';
      readonly entryIds: readonly string[];
      readonly keptBy: string | null;
    }[];
    readonly duplicatesTotal: number;
    /**
     * One old voucher migrated as several entries (identical bexio refs): numbered by
     * ledger.belegnummer_split_voucher. Pieces with identical content are pieces too, and are ALSO flagged
     * under `duplicates` as `identical_content`.
     */
    readonly splitVouchers: readonly { readonly number: number; readonly ref: string; readonly entryIds: readonly string[] }[];
    readonly splitVouchersTotal: number;
    /** The migrated entries whose ref names no voucher (empty, free text, an unknown label): never adopted. */
    readonly nonNumeric: readonly { readonly entryId: string; readonly ref: string | null }[];
    readonly nonNumericTotal: number;
  };
  /** What the next catch-up would assign to the posted entries without a number (empty under `off`). */
  readonly wouldAssign: readonly PlannedNumber[];
  readonly wouldAssignTotal: number;
};

export function journalNumberingPlan(ctx: WorkspaceContext): Result<JournalNumberingPlanOk> {
  const scope = { db: ctx.store.db, workspaceId: ctx.workspaceId };
  const db = ctx.store.db;
  const settings = numberingConfigOf(scope);

  const posted = (
    db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ctx.workspaceId) as { n: number }
  ).n;
  const numberRows = db
    .prepare(
      `SELECT series, COUNT(*) AS numbered, MAX(number) AS highest, SUM(origin = 'adopted') AS adopted
         FROM journal_entry_number WHERE workspace_id = ? GROUP BY series`,
    )
    .all(ctx.workspaceId) as { series: string; numbered: number; highest: number; adopted: number }[];
  const counters = db
    .prepare("SELECT year AS series, next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'journal'")
    .all(ctx.workspaceId) as { series: string; next_value: number }[];

  const bySeries = new Map<string, { nextNumber: number | null; highest: number | null; numbered: number }>();
  for (const c of counters) bySeries.set(c.series, { nextNumber: c.next_value, highest: null, numbered: 0 });
  for (const r of numberRows) {
    const s = bySeries.get(r.series) ?? { nextNumber: null, highest: null, numbered: 0 };
    bySeries.set(r.series, { ...s, highest: r.highest, numbered: r.numbered });
  }
  const series = [...bySeries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, s]) => ({ series: name, ...s }));

  const numbered = numberRows.reduce((sum, r) => sum + r.numbered, 0);
  const adopted = numberRows.reduce((sum, r) => sum + r.adopted, 0);

  // The migrated classification, over EVERY posted migrated entry (numbered or not).
  const wageIds = new Set(
    (db.prepare('SELECT posted_entry_id FROM wage_journal_posts WHERE workspace_id = ?').all(ctx.workspaceId) as {
      posted_entry_id: string;
    }[]).map((r) => r.posted_entry_id),
  );
  const imports = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM journal_entry e
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source = 'import'
        ORDER BY e.date, e.created_at, e.rowid`,
    )
    .all(ctx.workspaceId) as NumberingEntry[];
  const migrated = imports.filter((e) => isMigratedEntry(e, wageIds));
  // Every old voucher number a migrated ref names, with the claims on it: { entry, voucher key, splittable }.
  const byNumber = new Map<number, { entryId: string; key: string; splittable: boolean }[]>();
  const nonNumeric: { entryId: string; ref: string | null }[] = [];
  let plainIntegerRefs = 0;
  let bexioRefs = 0;
  for (const e of migrated) {
    const voucher = migratedVoucherOf(e.ref);
    if (voucher === null) {
      nonNumeric.push({ entryId: e.id, ref: e.ref });
      continue;
    }
    if (voucher.splittable) bexioRefs += 1;
    else plainIntegerRefs += 1;
    const claims = byNumber.get(voucher.number);
    const claim = { entryId: e.id, key: voucher.key, splittable: voucher.splittable };
    if (claims === undefined) byNumber.set(voucher.number, [claim]);
    else claims.push(claim);
  }
  let highestMigratedNumber: number | null = null;
  for (const n of byNumber.keys()) highestMigratedNumber = highestMigratedNumber === null ? n : Math.max(highestMigratedNumber, n);
  const sorted = [...byNumber.entries()].sort(([a], [b]) => a - b);

  const unnumbered = unnumberedPostedEntries(scope);
  const wouldAssign = planNumbering(scope, settings, unnumbered).assignments;

  // The OUTCOME per entry, the one truth both lists below read (critic r2 L2-3): the number an entry reads
  // now, or the one the next catch-up would give it. Whether a claim adopted its old number is read here,
  // never re-derived, so a claim that adopted in an earlier batch is never listed as "not adopted".
  const outcome = new Map<string, { readonly origin: string; readonly number: number }>();
  for (const r of db
    .prepare('SELECT entry_id, origin, number FROM journal_entry_number WHERE workspace_id = ?')
    .all(ctx.workspaceId) as { entry_id: string; origin: string; number: number }[]) {
    outcome.set(r.entry_id, { origin: r.origin, number: r.number });
  }
  for (const a of wouldAssign) outcome.set(a.entryId, { origin: a.origin, number: a.number });
  const reads = (entryId: string, n: number): boolean => {
    const o = outcome.get(entryId);
    return o !== undefined && o.origin === 'adopted' && o.number === n;
  };

  const splitVouchers: { number: number; ref: string; entryIds: string[] }[] = [];
  const duplicates: { ref: number; reason: 'conflict' | 'identical_content'; entryIds: string[]; keptBy: string | null }[] = [];
  for (const [n, claims] of sorted) {
    if (claims.length < 2) continue;
    const keys = [...new Set(claims.map((c) => c.key))];
    const oneVoucher = keys.length === 1 && claims.every((c) => c.splittable);
    if (oneVoucher) {
      // Identical bexio refs: ONE voucher in several entries, every one a piece (identical content included).
      splitVouchers.push({ number: n, ref: keys[0] as string, entryIds: claims.map((c) => c.entryId) });
    } else {
      // DIFFERENT vouchers claim n, or a plain integer twice: list every claim that does not read n.
      const without = claims.filter((c) => !reads(c.entryId, n)).map((c) => c.entryId);
      if (without.length > 0) {
        duplicates.push({ ref: n, reason: 'conflict', entryIds: without, keptBy: claims.find((c) => reads(c.entryId, n))?.entryId ?? null });
      }
    }
    // In BOTH cases, per voucher: entries with identical content are a possible double import, flagged for a
    // person and never decided (critic r3 L3-1 and L3-2: a late copy of a conflicting voucher is named too).
    for (const key of keys) {
      const ofVoucher = claims.filter((c) => c.key === key).map((c) => c.entryId);
      for (const group of identicalContentGroups(db, ctx.workspaceId, ofVoucher)) {
        duplicates.push({ ref: n, reason: 'identical_content', entryIds: group, keptBy: null });
      }
    }
  }

  return ok<JournalNumberingPlanOk>({
    settings,
    counts: { posted, numbered, unnumbered: unnumbered.length, adopted },
    pending: numberingPending(scope),
    series,
    migrated: {
      entries: migrated.length,
      plainIntegerRefs,
      bexioRefs,
      highestMigratedNumber,
      duplicates: duplicates.slice(0, PLAN_LIST_CAP),
      duplicatesTotal: duplicates.length,
      splitVouchers: splitVouchers.slice(0, PLAN_LIST_CAP),
      splitVouchersTotal: splitVouchers.length,
      nonNumeric: nonNumeric.slice(0, PLAN_LIST_CAP),
      nonNumericTotal: nonNumeric.length,
    },
    wouldAssign: wouldAssign.slice(0, PLAN_LIST_CAP),
    wouldAssignTotal: wouldAssign.length,
  });
}
