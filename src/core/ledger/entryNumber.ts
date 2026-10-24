/**
 * A02 §4b, the Belegnummer (D178 point 2, owner 21.10.2026): one gap-free number per posted entry, assigned
 * inside the posting transaction at ONE chokepoint.
 *
 * THE CHOKEPOINT. `writePostedEntry` (`./postEntry.ts`) is the one statement in `src/` that flips a
 * `journal_entry` row to `posted`, and every posting path reaches it (`postEntry`, `postEntryInternal`,
 * `postEntryInternalChecked`, `reverseEntry`, a promoted draft, every composite). It calls
 * `assignEntryNumber` right after the flip, in the same transaction, so:
 *  - a refused post, or a composite that rolls back after an inner post, spends no number (the counter and
 *    the number row roll back with it);
 *  - an idempotent replay never reaches `writePostedEntry`, so it spends nothing either;
 *  - a NEW posting path is numbered without anyone listing it, and the positive guard
 *    (`test/ledger/entry-number-chokepoint.test.mjs`) fails if one ever bypasses the flip.
 *
 * THE RULES (A02 §4b.3), stated once:
 *  - a series is `all` (the continuous run: `continue_migrated`, `from_start`) or a fiscal-year label
 *    (`per_fiscal_year`); its counter is A10's `document_number_seq` row (`type = 'journal'`, `year` = series);
 *  - gap-free: TILL hands out `next_value` and moves it by one, inside the transaction;
 *  - a series that has no counter yet STARTS: the catch-up numbers every posted entry still without a number
 *    (the one just posted included), in (date, created_at, rowid) order. Under `continue_migrated` the continuous
 *    series adopts a migrated entry's plain-integer `ref` as its number when no other migrated entry in the
 *    batch shares it; every other entry is numbered from `max(highest claimed + 1, start)`, the highest
 *    claimed old number counting adopted and withheld ones alike (critic r3 confirmation L3C-1);
 *  - (a) under `continue_migrated` a migration posting (an import, or the reversal correcting one) never
 *    starts the continuous series: it waits on the pending marker, and the first NATIVE booking starts it
 *    with ONE adoption batch over everything waiting (a numbering setting change or the backfill never does);
 *  - (b) once the continuous series runs, a migrated entry still keeps its plain-integer ref when that number
 *    is free in the series and below the run's next number; otherwise it takes the next number;
 *  - `off` writes the pending marker too; the next numbered posting runs the catch-up first;
 *  - a number is never changed (DB triggers), and a setting change applies to numbers assigned afterwards.
 *
 * Every statement is scoped by `workspaceId` (§H-TENANT). The module performs no write outside the posting
 * transaction it is called in, and `planNumbering` performs none at all (the read verb's dry run).
 *
 * The functions take a NARROW scope rather than a `WorkspaceContext`, so the generation-17 data migration
 * (`store/migrations.ts`, which holds a bare database) runs the SAME code the posting path runs.
 */

import type { Database } from 'better-sqlite3';

import type { WorkspaceContext } from '../context.js';
import type { IdGen } from '../ids.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { fiscalYearOf } from './periods.js';

/** The four numbering modes (§H-ENUM single source; the registry row lists the same values). */
export const BELEGNUMMER_MODES = ['continue_migrated', 'from_start', 'per_fiscal_year', 'off'] as const;
export type BelegnummerMode = (typeof BELEGNUMMER_MODES)[number];

/** The three settings, by key (`src/core/settings/registry.ts`, area A02). */
export const BELEGNUMMER_MODE_SETTING = 'ledger.belegnummer_mode';
export const BELEGNUMMER_START_SETTING = 'ledger.belegnummer_start';
export const BELEGNUMMER_PREFIX_SETTING = 'ledger.belegnummer_prefix';

/** The counter's `document_number_seq.type`, and the continuous series' key. */
export const JOURNAL_NUMBER_TYPE = 'journal';
export const CONTINUOUS_SERIES = 'all';

/**
 * The idempotency-key namespaces of the engine's OWN `source = 'import'` postings: A04's opening balance
 * (`OPENING_KEY_PREFIX`, `./openingBalances.ts`) and A19's bank opening (`BANK_OPENING_KEY_PREFIX`,
 * `../banking/bankAccounts.ts`). Restated rather than imported, because importing the banking module here
 * would put it in `postEntry`'s runtime closure (and close an import cycle through `postEntry`); the
 * equality is asserted by `test/ledger/entry-number-backfill.test.mjs`, so the two cannot drift silently.
 */
export const ENGINE_IMPORT_KEY_PREFIXES: readonly string[] = ['opening-balances', 'bank-opening'];

/** A plain integer: digits only, no sign, no blank, no leading zero, at most nine digits. */
const PLAIN_INTEGER = /^[1-9][0-9]{0,8}$/;

/**
 * The booking-type labels bexio writes in front of a migrated entry's ref (owner, 21.10.2026, from a dry run
 * on a copy of the real book): `<label> <per-type counter> (<Belegnummer>)`, e.g. `Manuelle Buchung 4711 (8801)`
 * or `Bank Buchung 912 (8802)`. The number in parentheses is bexio's continuous voucher series. A label not
 * listed here is NOT adopted (no guessing); `journal_numbering_plan` lists such refs under `nonNumeric`, so a
 * new label shows up in the dry run before an upgrade and is a one-line addition here.
 */
export const BEXIO_REF_LABELS: readonly string[] = ['Manuelle Buchung', 'Bank Buchung'];
const BEXIO_REF = new RegExp(
  `^(?:${BEXIO_REF_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) [1-9][0-9]{0,8} \\(([1-9][0-9]{0,8})\\)$`,
);

/** How the entries of ONE old voucher, migrated as several TILL entries, are numbered (D178, owner 21.10.2026). */
export const SPLIT_VOUCHER_MODES = ['share', 'suffix', 'first_keeps'] as const;
export type SplitVoucherMode = (typeof SPLIT_VOUCHER_MODES)[number];
export const BELEGNUMMER_SPLIT_SETTING = 'ledger.belegnummer_split_voucher';

/** The settings in force for one workspace. */
export interface NumberingConfig {
  readonly mode: BelegnummerMode;
  readonly start: number;
  readonly prefix: string;
  /** Split vouchers: every entry shares the number (default), `8802.2` suffixes, or only the first keeps it. */
  readonly split: SplitVoucherMode;
}

/**
 * The old voucher a migrated ref names, or null when the ref carries none we may adopt.
 *  - a plain integer (`501`): that number; it names one entry only, so two entries with the same plain integer
 *    are a duplicate and neither adopts it (`splittable: false`);
 *  - a bexio ref (`Bank Buchung 912 (8802)`): the number in parentheses; entries whose WHOLE ref is identical
 *    are one voucher split into several entries (`splittable: true`), and `key` identifies that voucher.
 * Free text such as `Rechnung (12)` matches neither shape and is never adopted.
 */
export interface MigratedVoucher {
  readonly number: number;
  readonly key: string;
  readonly splittable: boolean;
}

export function migratedVoucherOf(ref: string | null): MigratedVoucher | null {
  if (ref === null) return null;
  if (PLAIN_INTEGER.test(ref)) return { number: Number(ref), key: ref, splittable: false };
  const m = BEXIO_REF.exec(ref);
  return m === null ? null : { number: Number(m[1]), key: ref, splittable: true };
}

/** What the numbering functions need: a database, a tenant, a clock reading and an id source. */
export interface NumberingScope {
  readonly db: Database;
  readonly workspaceId: string;
  /** The assignment time stamped on every row this call writes. */
  readonly at: string;
  readonly ids: IdGen;
}

/** The scope of a posting: the context's own database, tenant, clock and ids. */
export function scopeOf(ctx: WorkspaceContext): NumberingScope {
  return { db: ctx.store.db, workspaceId: ctx.workspaceId, at: ctx.clock.now(), ids: ctx.ids };
}

/**
 * The settings in force, read through D172's typed accessor. `getSetting` reads exactly `store.db` and
 * `workspaceId`, so a bare scope (the data migration) is handed the same shim `appendAuditLog` takes there.
 */
export function numberingConfigOf(scope: Pick<NumberingScope, 'db' | 'workspaceId'>): NumberingConfig {
  const shim = { store: { db: scope.db }, workspaceId: scope.workspaceId } as unknown as WorkspaceContext;
  const mode = getSetting<string>(shim, BELEGNUMMER_MODE_SETTING);
  const split = getSetting<string>(shim, BELEGNUMMER_SPLIT_SETTING);
  return {
    mode: (BELEGNUMMER_MODES as readonly string[]).includes(mode) ? (mode as BelegnummerMode) : 'continue_migrated',
    start: getSetting<number>(shim, BELEGNUMMER_START_SETTING),
    prefix: getSetting<string>(shim, BELEGNUMMER_PREFIX_SETTING),
    split: (SPLIT_VOUCHER_MODES as readonly string[]).includes(split) ? (split as SplitVoucherMode) : 'share',
  };
}

/** One posted entry as the numbering reads it. */
export interface NumberingEntry {
  readonly id: string;
  readonly date: string;
  readonly created_at: string;
  readonly source: string;
  readonly ref: string | null;
  readonly idempotency_key: string | null;
  /** The entry a `source = 'reversal'` entry reverses (rule a follows it, A02 §4b.3); null otherwise. */
  readonly reverses_entry_id: string | null;
}

/** One number the catch-up assigns (or, in the plan, would assign). */
export interface PlannedNumber {
  readonly entryId: string;
  readonly date: string;
  readonly series: string;
  readonly number: number;
  readonly display: string;
  readonly origin: 'assigned' | 'adopted';
  /**
   * The old voucher an ADOPTED number belongs to, when several entries may share it (a split bexio voucher:
   * its whole ref); null for an assigned number and for a plain-integer adoption, which never shares.
   */
  readonly voucherRef: string | null;
}

/** The plan of one catch-up: the numbers and each touched series' counter afterwards. */
export interface NumberingPlan {
  readonly assignments: readonly PlannedNumber[];
  readonly counters: ReadonlyMap<string, { readonly existed: boolean; readonly next: number }>;
  /**
   * Old voucher numbers a claimant could not adopt although no entry reads them (a conflict, a plain integer
   * claimed twice, every display it could read taken), per series: written to `journal_number_withheld`, so no
   * LATER claimant adopts them either (critic r3 L3-2, no guessing).
   */
  readonly withheld: readonly { readonly series: string; readonly number: number }[];
}

/** The fiscal year start `MM-DD` of the workspace (A00), `01-01` when unset. */
function fiscalYearStartOf(scope: Pick<NumberingScope, 'db' | 'workspaceId'>): string {
  const row = scope.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(scope.workspaceId) as { fiscal_year_start: string | null } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** The series an entry dated `date` belongs to under `cfg`. */
export function seriesFor(cfg: NumberingConfig, date: string, fiscalYearStart: string): string {
  return cfg.mode === 'per_fiscal_year' ? fiscalYearOf(date, fiscalYearStart) : CONTINUOUS_SERIES;
}

/**
 * The string a person reads. Continuous: `<prefix><n>`, unpadded, so an adopted bexio number reads exactly
 * as it did. Per fiscal year: `<prefix><year>-<n padded to 4>` (`2026-0001`; past 9999 it simply grows).
 */
export function displayFor(prefix: string, series: string, n: number): string {
  return series === CONTINUOUS_SERIES ? `${prefix}${n}` : `${prefix}${series}-${String(n).padStart(4, '0')}`;
}

/** The plain integer a ref carries, or null when it is not one (no guessing: `0042`, ` 17`, `B-17` are not). */
export function plainIntegerOf(ref: string | null): number | null {
  return ref !== null && PLAIN_INTEGER.test(ref) ? Number(ref) : null;
}

/**
 * The prefix's closed shape (A02 §4b.5, critic r1 L1): empty, or 1 to 12 characters from `A-Z a-z 0-9 . _ / -`
 * that start with a letter or a digit and do NOT end in a digit. No blank anywhere, so what a person reads
 * is what the Beleg-Nr. filter finds; never a trailing digit, so the boundary between prefix and number stays
 * visible (`B1` + 7 and `B` + 17 would both read `B17`).
 */
const PREFIX_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,11}$/;
export const BELEGNUMMER_PREFIX_CHARACTERS = 'A-Z a-z 0-9 . _ / -';

export function prefixIsValid(prefix: string): boolean {
  return prefix === '' || (PREFIX_SHAPE.test(prefix) && !/[0-9]$/.test(prefix));
}

/**
 * The first EXISTING Beleg-Nr. a number handed out under `cfg` could repeat, or null (critic r1 L1).
 *
 * A future display is `<prefix><n>` (continuous) or `<prefix><year>-<n padded to 4>` (per fiscal year) for an
 * n the series has not handed out yet: at or above its counter, or, for a series that has not started, any n
 * from the start (under continue_migrated any n at all, because the start may adopt an old number). So an
 * existing display clashes when it begins with the prefix and the rest is exactly such a number. A free number
 * BELOW a running counter can still be adopted by rule b; that adoption checks the display itself.
 */
export function futureDisplayClash(
  scope: Pick<NumberingScope, 'db' | 'workspaceId'>,
  cfg: NumberingConfig,
): { display: string; entryId: string } | null {
  if (cfg.mode === 'off') return null;
  const rows = scope.db
    .prepare(
      'SELECT entry_id, display FROM journal_entry_number WHERE workspace_id = ? AND substr(display, 1, ?) = ? ORDER BY display',
    )
    .all(scope.workspaceId, cfg.prefix.length, cfg.prefix) as { entry_id: string; display: string }[];
  const continuousCounter = cfg.mode === 'per_fiscal_year' ? null : counterOf(scope, CONTINUOUS_SERIES);
  for (const row of rows) {
    const rest = row.display.slice(cfg.prefix.length);
    if (cfg.mode === 'per_fiscal_year') {
      const m = /^(\d{4})-(\d+)$/.exec(rest);
      if (m === null) continue;
      const year = m[1] as string;
      const n = Number(m[2]);
      if (n < 1 || displayFor('', year, n) !== rest) continue;
      const counter = counterOf(scope, year);
      if (n >= (counter ?? cfg.start)) return { display: row.display, entryId: row.entry_id };
    } else {
      if (!/^[1-9][0-9]*$/.test(rest)) continue;
      const n = Number(rest);
      const reachable = continuousCounter !== null ? n >= continuousCounter : cfg.mode === 'continue_migrated' || n >= cfg.start;
      if (reachable) return { display: row.display, entryId: row.entry_id };
    }
  }
  return null;
}

/** The ids of the workspace's wage-journal postings (A34): `source = 'import'`, but TILL's own. */
function wageJournalEntryIds(scope: Pick<NumberingScope, 'db' | 'workspaceId'>): Set<string> {
  const rows = scope.db
    .prepare('SELECT posted_entry_id FROM wage_journal_posts WHERE workspace_id = ?')
    .all(scope.workspaceId) as { posted_entry_id: string }[];
  return new Set(rows.map((r) => r.posted_entry_id));
}

/**
 * Whether a posted entry is MIGRATED: carried over from the old system, so its `ref` may be the old
 * Belegnummer. `source = 'import'`, minus the engine's own import postings (an opening balance, a bank
 * opening, a wage journal), which are TILL bookings whose refs were never an old system's numbers.
 */
export function isMigratedEntry(entry: Pick<NumberingEntry, 'id' | 'source' | 'idempotency_key'>, wageJournalIds: ReadonlySet<string>): boolean {
  if (entry.source !== 'import') return false;
  const key = entry.idempotency_key ?? '';
  if (ENGINE_IMPORT_KEY_PREFIXES.some((p) => key.startsWith(`${p}:`))) return false;
  return !wageJournalIds.has(entry.id);
}

export const ENTRY_COLUMNS = 'e.id, e.date, e.created_at, e.source, e.ref, e.idempotency_key, e.reverses_entry_id';

/** How far rule a follows a chain of reversals (a reversal of a reversal of ...) back to its first entry. */
const MAX_REVERSAL_HOPS = 16;

/**
 * Whether a posting is part of carrying the old journal over, for rule a (A02 §4b.3, critic r2 M2-1): an
 * IMPORT posting (a migrated voucher, or the engine's own opening balance, bank opening or wage journal), or a
 * REVERSAL whose chain of reversed entries leads back to one (correcting a wrongly imported voucher is part
 * of the import, not a booking of the new books). Every other posting is a native booking. Reads at most
 * `MAX_REVERSAL_HOPS` primary-key rows, and none for a posting that is not a reversal.
 */
export function isMigrationPosting(
  scope: Pick<NumberingScope, 'db' | 'workspaceId'>,
  entry: Pick<NumberingEntry, 'source' | 'reverses_entry_id'>,
): boolean {
  let row: Pick<NumberingEntry, 'source' | 'reverses_entry_id'> = entry;
  const parentOf = scope.db.prepare('SELECT source, reverses_entry_id FROM journal_entry WHERE workspace_id = ? AND id = ?');
  for (let hops = 0; row.source === 'reversal' && row.reverses_entry_id !== null && hops < MAX_REVERSAL_HOPS; hops += 1) {
    const parent = parentOf.get(scope.workspaceId, row.reverses_entry_id) as Pick<NumberingEntry, 'source' | 'reverses_entry_id'> | undefined;
    if (parent === undefined) return false;
    row = parent;
  }
  return row.source === 'import';
}

/**
 * Whether rule a holds now (A02 §4b.3): the mode is continue_migrated and the continuous run has not started,
 * so migration postings (`isMigrationPosting`) WAIT for it. Only a native booking starts the run; an import,
 * the reversal of one, a numbering setting change and the generation-17 backfill never do, so a bexio journal
 * imported into a fresh book is numbered in ONE adoption batch, whatever order it arrived in and however it
 * was corrected. One primary-key read.
 */
function waitsForTheRun(scope: Pick<NumberingScope, 'db' | 'workspaceId'>, cfg: NumberingConfig): boolean {
  return cfg.mode === 'continue_migrated' && counterOf(scope, CONTINUOUS_SERIES) === null;
}

/** Every POSTED entry of the workspace that has no number, in (date, created_at, rowid) order. */
export function unnumberedPostedEntries(scope: Pick<NumberingScope, 'db' | 'workspaceId'>): NumberingEntry[] {
  return scope.db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM journal_entry e
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND NOT EXISTS (SELECT 1 FROM journal_entry_number n WHERE n.entry_id = e.id)
        ORDER BY e.date, e.created_at, e.rowid`,
    )
    .all(scope.workspaceId) as NumberingEntry[];
}

/** A series' counter: the next number it hands out, or null when the series has not started. */
function counterOf(scope: Pick<NumberingScope, 'db' | 'workspaceId'>, series: string): number | null {
  const row = scope.db
    .prepare('SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = ? AND year = ?')
    .get(scope.workspaceId, JOURNAL_NUMBER_TYPE, series) as { next_value: number } | undefined;
  return row === undefined ? null : row.next_value;
}

/** The highest old number withheld in a series (0 when none). One primary-key range probe. */
function highestWithheldIn(scope: Pick<NumberingScope, 'db' | 'workspaceId'>, series: string): number {
  const row = scope.db
    .prepare('SELECT MAX(number) AS n FROM journal_number_withheld WHERE workspace_id = ? AND series = ?')
    .get(scope.workspaceId, series) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

/** The highest number already in a series (0 when it holds none). One index probe. */
function highestIn(scope: Pick<NumberingScope, 'db' | 'workspaceId'>, series: string): number {
  const row = scope.db
    .prepare('SELECT MAX(number) AS n FROM journal_entry_number WHERE workspace_id = ? AND series = ?')
    .get(scope.workspaceId, series) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

/**
 * PLAN the numbers for `batch` (posted entries without a number, in order) under `cfg`. Reads only. The
 * one function both the posting path and `journal_numbering_plan` call, so the dry run and the write agree.
 */
export function planNumbering(
  scope: Pick<NumberingScope, 'db' | 'workspaceId'>,
  cfg: NumberingConfig,
  batch: readonly NumberingEntry[],
): NumberingPlan {
  const assignments: PlannedNumber[] = [];
  const counters = new Map<string, { existed: boolean; next: number }>();
  const withheld: { series: string; number: number }[] = [];
  if (cfg.mode === 'off' || batch.length === 0) return { assignments, counters, withheld };

  const fyStart = cfg.mode === 'per_fiscal_year' ? fiscalYearStartOf(scope) : '01-01';
  const bySeries = new Map<string, NumberingEntry[]>();
  for (const entry of batch) {
    const series = seriesFor(cfg, entry.date, fyStart);
    const list = bySeries.get(series);
    if (list === undefined) bySeries.set(series, [entry]);
    else list.push(entry);
  }

  let wageIds: Set<string> | undefined;
  for (const [series, entries] of bySeries) {
    const counter = counterOf(scope, series);
    const highest = highestIn(scope, series);
    // A running series is never re-seeded. `highest + 1` only matters if the counter and the rows ever
    // disagreed, and then it is what keeps an assigned number from meeting an existing one.
    const running = counter === null ? null : Math.max(counter, highest + 1);
    const decided =
      cfg.mode === 'continue_migrated' && series === CONTINUOUS_SERIES
        ? adoptionsFor(scope, cfg, series, entries, running, (wageIds ??= wageJournalEntryIds(scope)))
        : { found: new Map<string, Adoption>(), withheld: [] };
    const adopted = decided.found;
    for (const number of decided.withheld) withheld.push({ series, number });

    let next: number;
    if (running !== null) {
      next = running;
    } else {
      // The series STARTS: TILL's own run begins after the highest old number a voucher CLAIMS, adopted or
      // withheld (an adopted 8159 gives 8160). A contested top number (two claims on the last old voucher)
      // is withheld, not adopted, and must still lie below the run, or TILL's first assigned entry would read
      // an old voucher number that names other bookings (critic r3 confirmation L3C-1). Numbers withheld
      // after the start lie below the run by rule b, so they can never meet it.
      let highestClaimed = highestWithheldIn(scope, series);
      for (const a of adopted.values()) highestClaimed = Math.max(highestClaimed, a.number);
      for (const n of decided.withheld) highestClaimed = Math.max(highestClaimed, n);
      next = Math.max(cfg.start, highestClaimed + 1, highest + 1);
    }

    for (const entry of entries) {
      const a = adopted.get(entry.id);
      if (a !== undefined) {
        assignments.push({ entryId: entry.id, date: entry.date, series, number: a.number, display: a.display, origin: 'adopted', voucherRef: a.voucherRef });
        continue;
      }
      const number = next++;
      assignments.push({
        entryId: entry.id,
        date: entry.date,
        series,
        number,
        display: displayFor(cfg.prefix, series, number),
        origin: 'assigned',
        voucherRef: null,
      });
    }
    counters.set(series, { existed: counter !== null, next });
  }
  return { assignments, counters, withheld };
}

/** What makes two migrated entries look like the SAME booking: every line field that carries money or its meaning. */
const LINE_SIGNATURE_SQL = `SELECT l.account_id, l.cost_center_id, l.debit_minor, l.credit_minor, l.currency, l.base_debit_minor,
        l.base_credit_minor, l.fx_rate, l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
   FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
  WHERE e.workspace_id = ? AND l.entry_id = ?`;

/**
 * IDENTICAL CONTENT among entries claiming one old voucher (A02 §4b.3; critic r2 L2-2, r3 L3-1): the groups
 * of entries with the same date, description and multiset of lines, in the order of `ids`, each group at
 * least two entries long. Such a group is a POSSIBLE double import (an import run twice under new keys), and
 * just as possibly one bexio voucher with two equal rows (equal wages, equal instalments): by content the
 * two cannot be told apart. So TILL never decides it (orchestrator ruling under D178 points 18 and 19): the
 * numbering treats every entry of the group as a piece of the voucher (`ledger.belegnummer_split_voucher`,
 * `share` by default), and `journal_numbering_plan` FLAGS the group as `identical_content` for a person to
 * look at. Reads the lines of these entries only (a voucher has a handful), never the ledger.
 */
export function identicalContentGroups(db: Database, workspaceId: string, ids: readonly string[]): string[][] {
  if (ids.length < 2) return [];
  const head = db.prepare('SELECT date, description FROM journal_entry WHERE workspace_id = ? AND id = ?');
  const lines = db.prepare(LINE_SIGNATURE_SQL);
  const bySignature = new Map<string, string[]>();
  for (const id of ids) {
    const entry = head.get(workspaceId, id) as { date: string; description: string | null } | undefined;
    if (entry === undefined) continue;
    const content = (lines.all(workspaceId, id) as Record<string, unknown>[]).map((l) => JSON.stringify(Object.values(l))).sort();
    const signature = JSON.stringify([entry.date, entry.description, content]);
    const group = bySignature.get(signature);
    if (group === undefined) bySignature.set(signature, [id]);
    else group.push(id);
  }
  return [...bySignature.values()].filter((g) => g.length > 1);
}

/** One adoption the planner decided: the old number, the display it reads, and the voucher it may share. */
interface Adoption {
  readonly number: number;
  readonly display: string;
  readonly voucherRef: string | null;
}

/**
 * ADOPTION, the continue_migrated rule for the continuous series (A02 §4b.3). Reads only.
 *
 * The migrated entries of the batch are grouped by the old voucher number their ref names
 * (`migratedVoucherOf`). A number is adopted only when:
 *  - the series STARTS (`running === null`), or the number lies BELOW the run's next number (rule b, critic r1
 *    M1: it can then never meet a number TILL hands out later, and TILL's own run stays gap-free);
 *  - it names ONE old voucher: every entry claiming it carries the same voucher, and a plain integer claimed
 *    by two entries is a duplicate (no guessing). Several entries with the identical bexio ref are ONE voucher
 *    migrated as a split, numbered by `cfg.split` (owner, 21.10.2026): `share` (default) gives every entry the
 *    voucher's number, `suffix` gives `8802`, `8802.2`, `8802.3` in entry order, `first_keeps` gives the number to
 *    the first entry only and lets the others take TILL's next numbers. Entries with byte-identical content
 *    are pieces like any other (critic r3 L3-1: a possible double import is flagged by the plan as
 *    `identical_content`, never decided here);
 *  - the number is free in the series, or already belongs to THAT voucher (a later piece of a split);
 *  - the number was never WITHHELD: a free number a claimant could not adopt (a conflict, a plain integer
 *    claimed twice, a display another voucher reads) is returned in `withheld`
 *    and stored, and stays withheld for every later claimant (critic r3 L3-2: a conflict is not settled by
 *    whoever arrives next, a late copy of a conflicting voucher included);
 *  - the display it would read is not already read by another voucher or an assigned number (critic r1 L1).
 * Everything else takes the next number and keeps its old number in `ref`.
 */
function adoptionsFor(
  scope: Pick<NumberingScope, 'db' | 'workspaceId'>,
  cfg: NumberingConfig,
  series: string,
  entries: readonly NumberingEntry[],
  running: number | null,
  wageIds: ReadonlySet<string>,
): { found: Map<string, Adoption>; withheld: number[] } {
  const found = new Map<string, Adoption>();
  const withheld: number[] = [];
  const claims = new Map<number, { entry: NumberingEntry; voucher: MigratedVoucher }[]>();
  for (const entry of entries) {
    if (!isMigratedEntry(entry, wageIds)) continue;
    const voucher = migratedVoucherOf(entry.ref);
    if (voucher === null) continue;
    const list = claims.get(voucher.number);
    if (list === undefined) claims.set(voucher.number, [{ entry, voucher }]);
    else list.push({ entry, voucher });
  }
  const rowsAt = scope.db.prepare(
    'SELECT entry_id, origin, voucher_ref FROM journal_entry_number WHERE workspace_id = ? AND series = ? AND number = ? ORDER BY rowid',
  );
  const readersOf = scope.db.prepare('SELECT origin, voucher_ref FROM journal_entry_number WHERE workspace_id = ? AND display = ?');
  const wasWithheld = scope.db.prepare('SELECT 1 AS x FROM journal_number_withheld WHERE workspace_id = ? AND series = ? AND number = ?');
  // Displays this batch has already given out, with the voucher that reads them (null: not shareable).
  const planned = new Map<string, string | null>();
  for (const [n, pieces] of claims) {
    const existing = rowsAt.all(scope.workspaceId, series, n) as { entry_id: string; origin: string; voucher_ref: string | null }[];
    // At or above the run's next number (rule b): never adopted. Nothing to withhold: TILL's own run is
    // contiguous, so once it passes n, n is an assigned number and no longer free.
    if (running !== null && n >= running) continue;
    // A FREE number withheld once is withheld for good (critic r3 L3-2).
    if (existing.length === 0 && wasWithheld.get(scope.workspaceId, series, n) !== undefined) continue;
    let key: string;
    let members: { entry: NumberingEntry; voucher: MigratedVoucher }[];
    if (existing.length > 0) {
      // Already in the series: only further pieces of the SAME split voucher may join it.
      const keys = new Set(existing.map((r) => (r.origin === 'adopted' ? r.voucher_ref : null)));
      const only = [...keys][0];
      if (keys.size !== 1 || only === null || only === undefined) continue;
      key = only;
      members = pieces.filter((p) => p.voucher.splittable && p.voucher.key === key);
    } else {
      const keys = new Set(pieces.map((p) => p.voucher.key));
      const first = pieces[0];
      // Two different vouchers claim n, or a plain integer twice: no guessing, and n stays withheld.
      if (keys.size !== 1 || first === undefined || (pieces.length > 1 && !first.voucher.splittable)) {
        withheld.push(n);
        continue;
      }
      key = first.voucher.key;
      members = pieces;
    }
    let took = false;
    let ordinal = existing.length;
    for (const piece of members) {
      ordinal += 1;
      if (ordinal > 1 && cfg.split === 'first_keeps') continue;
      const base = displayFor(cfg.prefix, series, n);
      const display = ordinal > 1 && cfg.split === 'suffix' ? `${base}.${ordinal}` : base;
      const voucherRef = piece.voucher.splittable ? key : null;
      const readers = readersOf.all(scope.workspaceId, display) as { origin: string; voucher_ref: string | null }[];
      if (readers.some((r) => !(r.origin === 'adopted' && voucherRef !== null && r.voucher_ref === voucherRef))) continue;
      if (planned.has(display) && (voucherRef === null || planned.get(display) !== voucherRef)) continue;
      planned.set(display, voucherRef);
      found.set(piece.entry.id, { number: n, display, voucherRef });
      took = true;
    }
    // A free number no piece could take (every display read by another voucher) is withheld like a conflict.
    if (existing.length === 0 && !took) withheld.push(n);
  }
  return { found, withheld };
}

/** WRITE a plan: the number rows and each series' counter. Runs inside the caller's transaction. */
function applyPlan(scope: NumberingScope, plan: NumberingPlan): void {
  const insert = scope.db.prepare(
    `INSERT INTO journal_entry_number (id, workspace_id, entry_id, series, number, display, origin, voucher_ref, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of plan.assignments) {
    insert.run(scope.ids.next('entrynum'), scope.workspaceId, a.entryId, a.series, a.number, a.display, a.origin, a.voucherRef, scope.at);
  }
  const withhold = scope.db.prepare(
    'INSERT OR IGNORE INTO journal_number_withheld (workspace_id, series, number, withheld_at) VALUES (?, ?, ?, ?)',
  );
  for (const w of plan.withheld) withhold.run(scope.workspaceId, w.series, w.number, scope.at);
  for (const [series, { existed, next }] of plan.counters) {
    if (existed) {
      scope.db
        .prepare('UPDATE document_number_seq SET next_value = ? WHERE workspace_id = ? AND type = ? AND year = ?')
        .run(next, scope.workspaceId, JOURNAL_NUMBER_TYPE, series);
    } else {
      scope.db
        .prepare('INSERT INTO document_number_seq (workspace_id, type, year, next_value) VALUES (?, ?, ?, ?)')
        .run(scope.workspaceId, JOURNAL_NUMBER_TYPE, series, next);
    }
  }
}

/** Whether a catch-up is owed (a posting was made while numbering was off). */
export function numberingPending(scope: Pick<NumberingScope, 'db' | 'workspaceId'>): boolean {
  return (
    scope.db.prepare('SELECT 1 AS x FROM journal_numbering_pending WHERE workspace_id = ?').get(scope.workspaceId) !==
    undefined
  );
}

function markPending(scope: NumberingScope): void {
  scope.db
    .prepare('INSERT OR IGNORE INTO journal_numbering_pending (workspace_id, since) VALUES (?, ?)')
    .run(scope.workspaceId, scope.at);
}

function clearPending(scope: NumberingScope): void {
  scope.db.prepare('DELETE FROM journal_numbering_pending WHERE workspace_id = ?').run(scope.workspaceId);
}

/**
 * THE CATCH-UP: number every posted entry of the workspace that has none, under the settings in force.
 * The generation-17 backfill, a numbering setting change and a series start all run it. Under `off` it
 * numbers nothing and leaves the pending marker when there is anything to catch up. Returns what it
 * assigned. Idempotent: a second run finds no unnumbered entry and writes nothing.
 */
export function numberUnnumberedEntries(scope: NumberingScope, cfg: NumberingConfig = numberingConfigOf(scope)): readonly PlannedNumber[] {
  const batch = unnumberedPostedEntries(scope);
  if (cfg.mode === 'off') {
    if (batch.length > 0) markPending(scope);
    return [];
  }
  // Rule a, in its one place for a batch (critic r2 M2-1): migration postings ALONE never start the
  // continuous run, whoever asks for the catch-up (the generation-17 backfill, a numbering setting change
  // made half-way through an import). They keep waiting for the first native booking.
  if (batch.length > 0 && waitsForTheRun(scope, cfg) && batch.every((e) => isMigrationPosting(scope, e))) {
    markPending(scope);
    return [];
  }
  const plan = planNumbering(scope, cfg, batch);
  applyPlan(scope, plan);
  if (numberingPending(scope)) clearPending(scope);
  return plan.assignments;
}

/**
 * THE CHOKEPOINT, called by `writePostedEntry` right after the flip to `posted`, inside the posting
 * transaction. The hot path (numbering on, nothing pending, the series running) is two primary-key reads,
 * one index probe and two writes; only a series start or an owed catch-up scans the workspace's entries.
 */
export function assignEntryNumber(ctx: WorkspaceContext, entryId: string): void {
  const scope = scopeOf(ctx);
  const cfg = numberingConfigOf(scope);
  if (cfg.mode === 'off') {
    markPending(scope);
    return;
  }
  const entry = scope.db
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM journal_entry e WHERE e.workspace_id = ? AND e.id = ? AND e.status = 'posted'`)
    .get(scope.workspaceId, entryId) as NumberingEntry | undefined;
  // Not reachable from `writePostedEntry` (it flipped this very row); a defensive no-op rather than a throw
  // inside the posting transaction, and the positive guard would name the entry left without a number.
  if (entry === undefined) return;
  // Rule (a), A02 §4b.3 (critic r1 M1, r2 M2-1): under continue_migrated a MIGRATION posting (an import, or
  // the reversal that corrects one) never STARTS the continuous series. It waits, like a posting under
  // `off`, so a bexio journal imported into a fresh book is numbered in ONE adoption batch by the first
  // native booking, and every migrated voucher keeps its old number whatever order the import ran in.
  if (waitsForTheRun(scope, cfg) && isMigrationPosting(scope, entry)) {
    markPending(scope);
    return;
  }
  const fyStart = cfg.mode === 'per_fiscal_year' ? fiscalYearStartOf(scope) : '01-01';
  const series = seriesFor(cfg, entry.date, fyStart);
  if (numberingPending(scope) || counterOf(scope, series) === null) {
    numberUnnumberedEntries(scope, cfg);
    return;
  }
  applyPlan(scope, planNumbering(scope, cfg, [entry]));
}

/**
 * After an accepted change of a numbering setting, inside the change's own transaction (critic r1 L2): when
 * numbering is now on and a catch-up is owed (entries posted while it was off), run that catch-up NOW. So
 * switching numbering back on leaves no posted entry without a number, without waiting for the next booking.
 * Migration postings waiting for the continuous run (rule a) keep waiting (critic r2 M2-1): a setting changed
 * half-way through an import, after reading the plan, is not a native booking and must not start the run in
 * the middle of the old journal. A change that leaves numbering off, or owes nothing, writes nothing here.
 */
export function afterBelegnummerSettingChange(ctx: WorkspaceContext): void {
  const scope = scopeOf(ctx);
  const cfg = numberingConfigOf(scope);
  if (cfg.mode === 'off' || !numberingPending(scope)) return;
  numberUnnumberedEntries(scope, cfg);
}

/** Whether `key` is one of the three numbering settings. */
function isBelegnummerKey(key: string): boolean {
  return (
    key === BELEGNUMMER_MODE_SETTING ||
    key === BELEGNUMMER_START_SETTING ||
    key === BELEGNUMMER_PREFIX_SETTING ||
    key === BELEGNUMMER_SPLIT_SETTING
  );
}

/**
 * The rule a numbering setting's schema cannot state (A02 §4b.5, critic r1 L1), run by `settings_set` and
 * `settings_reset` before anything is written: the prefix keeps its closed shape
 * (`belegnummer_prefix_invalid`), and a change of the mode, the start or the prefix is refused when a number
 * handed out under the NEW settings could repeat a Beleg-Nr. that already exists
 * (`belegnummer_display_clash`, naming that number). `value` is the value the change would leave in force.
 */
export function refuseBelegnummerSetting(ctx: WorkspaceContext, key: string, value: unknown): Err | null {
  if (!isBelegnummerKey(key)) return null;
  if (key === BELEGNUMMER_PREFIX_SETTING && (typeof value !== 'string' || !prefixIsValid(value))) {
    return err('belegnummer_prefix_invalid', {
      key,
      value: typeof value === 'string' ? value : null,
      characters: BELEGNUMMER_PREFIX_CHARACTERS,
      reason: 'a prefix is empty, or 1 to 12 characters from A-Z a-z 0-9 . _ / - that start with a letter or digit and do not end in a digit',
    });
  }
  const scope = { db: ctx.store.db, workspaceId: ctx.workspaceId };
  const current = numberingConfigOf(scope);
  const candidate: NumberingConfig = {
    mode: key === BELEGNUMMER_MODE_SETTING && (BELEGNUMMER_MODES as readonly unknown[]).includes(value) ? (value as BelegnummerMode) : current.mode,
    start: key === BELEGNUMMER_START_SETTING && typeof value === 'number' ? value : current.start,
    prefix: key === BELEGNUMMER_PREFIX_SETTING && typeof value === 'string' ? value : current.prefix,
    split: key === BELEGNUMMER_SPLIT_SETTING && (SPLIT_VOUCHER_MODES as readonly unknown[]).includes(value) ? (value as SplitVoucherMode) : current.split,
  };
  const clash = futureDisplayClash(scope, candidate);
  if (clash === null) return null;
  return err('belegnummer_display_clash', {
    key,
    value: value === undefined ? null : value,
    display: clash.display,
    entryId: clash.entryId,
    reason: `with this change a later voucher number could repeat ${clash.display}, which is already taken`,
  });
}
