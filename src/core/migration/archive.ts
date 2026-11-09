/**
 * G13, the historical GL archive: the prior system's journal, queryable inside TILL, read-only,
 * and STRUCTURALLY incapable of entering a live statement.
 *
 * THE TWO WALLS (spec §4, asserted statically in test/migration/archive-walls.test.mjs):
 *   1. No live read model imports this module: nothing under `core/reports/` may import it.
 *   2. This module never reads the live ledger: no query here touches a live journal table (the
 *      wall test greps for the table names, which is why this comment does not spell them).
 *      The archive's whole world is the four `gl_archive_*` tables, the
 *      migration family's plan/step/source-file rows, the G10 account map, and the A01 `account`
 *      master rows its targets resolve to (master data, not the ledger).
 *
 * The one place the two worlds meet is the API layer (`src/api/report-actions.ts`, spec §0
 * correction 2): the live statement computed wholly by `core/reports/`, the archive side wholly by
 * `archiveComparative` below, joined into a labelled column computed from exactly one side at a
 * time, never summed across the wall.
 *
 * MONEY CORRECTNESS (P2 by omission): every amount is the integer Rappen the source produced,
 * stored verbatim. Nothing is recomputed, no VAT is derived, and an internally unbalanced source
 * entry imports FLAGGED (`balanced = 0`), never corrected: correcting evidence is fabricating it
 * (OR Art. 957a Abs. 2 Ziff. 2's spirit; GeBüV Art. 9).
 *
 * §H-TENANT on every query; §H-IDEMPOTENT on both writes; §H-AUDIT deliberately NOT extended to
 * archive rows, and the surfaces say so (US-G13.3): the archive is outside the TILL Belegkette.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { getFileContent, deleteFile } from '../files/files.js';
import { parseSource, isParseFailure, type ParsedRow } from './adapters/parse.js';
import { getMap, type MapEntry } from './maps.js';
import { loadPlan, loadStep, loadSourceFiles, type PlanRow, type StepRow } from './plan.js';
import { applySavedView } from '../customization/views.js';

// --- §H-ENUM: the closed sets, single-sourced here (no CHECK in archiveSchema.ts, the §D0 rule) ---

/** A purge record's outcome: the completed purge, or the refusal on retention grounds. */
export const PURGE_OUTCOMES = ['purged', 'refused'] as const;
export type PurgeOutcome = (typeof PURGE_OUTCOMES)[number];

/** The statutory reference every purge record carries (OR Art. 958f: the ten-year retention). */
export const RETENTION_STATUTE = 'OR 958f';

const PAGE_SIZE = 50;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;

// --- Small guards -------------------------------------------------------------------------------

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

function optStr(value: unknown, field: string): Result | undefined {
  if (value === undefined || (typeof value === 'string' && value.length > 0)) return undefined;
  return err('invalid_input', { field });
}

// --- The source-row reader (gl_history only; mirrors steps.ts's gatherRows without importing it) --

interface ArchiveSourceRow {
  readonly row: ParsedRow;
  readonly fileId: string;
}

function gatherHistoryRows(ctx: WorkspaceContext, plan: PlanRow): { rows: ArchiveSourceRow[]; errors: string[] } {
  const rows: ArchiveSourceRow[] = [];
  const errors: string[] = [];
  for (const file of loadSourceFiles(ctx, plan.id)) {
    const classes = file.data_classes === null ? [] : (JSON.parse(file.data_classes as string) as string[]);
    if (classes.length > 0 && !classes.includes('gl_history')) continue;
    const content = getFileContent(ctx, { fileId: file.file_id as string });
    if (!content.ok) {
      errors.push(`source_integrity_mismatch:${file.file_id}`);
      continue;
    }
    const bytes = Buffer.from(content.contentBase64 as string, 'base64');
    const parsed = parseSource((file.adapter as string) ?? 'csv', bytes, 'gl_history');
    if (isParseFailure(parsed)) {
      errors.push(`source_unparseable:${file.file_id}`);
      continue;
    }
    for (const row of parsed.rows) rows.push({ row, fileId: file.file_id as string });
  }
  return { rows, errors };
}

// --- Header aliases (the plain-CSV safety net; the G10 column map would translate first) ----------

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: ['date', 'datum', 'belegdatum', 'buchungsdatum', 'valuta'],
  entryId: ['entryid', 'belegnr', 'belegnummer', 'beleg', 'voucher', 'journalnr', 'buchungsnr', 'entry'],
  account: ['account', 'konto', 'kontonr', 'kontonummer', 'accountnumber'],
  accountName: ['accountname', 'kontobezeichnung', 'bezeichnung', 'kontoname'],
  debit: ['debit', 'soll', 'debitminor'],
  credit: ['credit', 'haben', 'creditminor'],
  text: ['text', 'buchungstext', 'description', 'beschreibung'],
  // The transliterated header spelling is a MACHINE token a foreign CSV really ships, split so the
  // umlaut style guard reads it as machine rather than as German prose.
  currency: ['currency', 'wae' + 'hrung', 'währung'],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9äöü]/g, '');
}

function fieldOf(row: ParsedRow, field: keyof typeof ALIASES): string | undefined {
  const wanted = ALIASES[field] as readonly string[];
  for (const key of Object.keys(row)) {
    if (wanted.includes(normalizeHeader(key))) {
      const value = String(row[key] ?? '').trim();
      if (value !== '') return value;
    }
  }
  return undefined;
}

/**
 * A source amount into integer Rappen. `1234` is already Rappen; `12.34` / `12,34` (with optional
 * apostrophe thousands separators) is francs and Rappen, converted EXACTLY, which is unit parsing
 * and not arithmetic. Anything else refuses, so a malformed figure never lands as zero.
 */
export function parseAmountMinor(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;
  const cleaned = raw.replace(/['’\s]/g, '');
  if (/^-?\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  const m = /^(-?)(\d+)[.,](\d{1,2})$/.exec(cleaned);
  if (m === null) return null;
  const [, sign, francs, rest] = m as unknown as [string, string, string, string];
  const rappen = rest.length === 1 ? Number(rest) * 10 : Number(rest);
  return (sign === '-' ? -1 : 1) * (Number(francs) * 100 + rappen);
}

/** An ISO date, or a Swiss `DD.MM.YYYY` converted to ISO. Anything else refuses. */
function parseDate(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (ISO_DATE.test(raw)) return raw;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (m === null) return null;
  const [, day, month, year] = m as unknown as [string, string, string, string];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// --- The parsed shape both preview and import walk once ------------------------------------------

interface ParsedArchiveLine {
  readonly sourceAccount: string;
  readonly sourceAccountName: string | null;
  readonly targetAccountId: string | null;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly currency: string | null;
  readonly description: string | null;
}

interface ParsedArchiveEntry {
  readonly sourceEntryId: string | null;
  readonly date: string;
  readonly description: string | null;
  readonly sourceRef: string;
  readonly balanced: boolean;
  readonly lines: readonly ParsedArchiveLine[];
}

interface ParsedArchive {
  readonly entries: readonly ParsedArchiveEntry[];
  readonly unmapped: readonly string[];
  readonly unbalancedCount: number;
  readonly rowErrors: readonly string[];
  readonly fileErrors: readonly string[];
}

/** The G10 account map as source-number -> live A01 account id, resolved through `account`. */
function targetResolver(ctx: WorkspaceContext, planId: string): (source: string) => string | null {
  const map = getMap(ctx, { planId, kind: 'account' });
  const entries: readonly MapEntry[] = map.ok ? ((map as { entries?: MapEntry[] }).entries ?? []) : [];
  const byNumber = new Map<string, string>();
  for (const row of ctx.store.db
    .prepare('SELECT id, number FROM account WHERE workspace_id = ?')
    .all(ctx.workspaceId) as Array<{ id: string; number: string }>) {
    byNumber.set(row.number, row.id);
  }
  const targets = new Map<string, string | null>();
  for (const e of entries) {
    if (e.target === undefined || e.target === null) continue;
    targets.set(e.source, byNumber.get(e.target) ?? null);
  }
  return (source: string) => targets.get(source) ?? null;
}

/** Parse and group the plan's `gl_history` rows into archive entries. Pure over the store's bytes. */
function parseArchive(ctx: WorkspaceContext, plan: PlanRow): ParsedArchive {
  const { rows, errors } = gatherHistoryRows(ctx, plan);
  const resolve = targetResolver(ctx, plan.id);

  const grouped = new Map<string, { sourceEntryId: string | null; date: string; description: string | null; sourceRef: string; lines: ParsedArchiveLine[] }>();
  const order: string[] = [];
  const rowErrors: string[] = [];
  const unmapped = new Set<string>();

  rows.forEach(({ row, fileId }, index) => {
    const date = parseDate(fieldOf(row, 'date'));
    if (date === null) {
      rowErrors.push(`row:${index}:invalid_date`);
      return;
    }
    const account = fieldOf(row, 'account');
    if (account === undefined) {
      rowErrors.push(`row:${index}:missing_account`);
      return;
    }
    const debitMinor = parseAmountMinor(fieldOf(row, 'debit'));
    const creditMinor = parseAmountMinor(fieldOf(row, 'credit'));
    if (debitMinor === null || creditMinor === null) {
      rowErrors.push(`row:${index}:invalid_amount`);
      return;
    }
    const sourceEntryId = fieldOf(row, 'entryId') ?? null;
    // Rows sharing a source entry id form ONE archive entry; a row without one stands alone.
    const key = sourceEntryId === null ? `solo:${index}` : `id:${sourceEntryId}:${date}`;
    const target = resolve(account);
    if (target === null) unmapped.add(account);
    const line: ParsedArchiveLine = {
      sourceAccount: account,
      sourceAccountName: fieldOf(row, 'accountName') ?? null,
      targetAccountId: target,
      debitMinor,
      creditMinor,
      currency: fieldOf(row, 'currency') ?? null,
      description: fieldOf(row, 'text') ?? null,
    };
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        sourceEntryId,
        date,
        description: fieldOf(row, 'text') ?? null,
        sourceRef: fileId,
        lines: [line],
      });
      order.push(key);
    } else {
      existing.lines.push(line);
    }
  });

  let unbalancedCount = 0;
  const entries: ParsedArchiveEntry[] = order.map((key) => {
    const e = grouped.get(key) as NonNullable<ReturnType<typeof grouped.get>>;
    const debit = e.lines.reduce((sum, l) => sum + l.debitMinor, 0);
    const credit = e.lines.reduce((sum, l) => sum + l.creditMinor, 0);
    const balanced = debit === credit;
    if (!balanced) unbalancedCount += 1;
    return { ...e, balanced, lines: e.lines };
  });

  return { entries, unmapped: [...unmapped].sort(), unbalancedCount, rowErrors, fileErrors: errors };
}

// --- Retention (OR Art. 958f) --------------------------------------------------------------------

/**
 * OR Art. 958f Abs. 1: Geschäftsbücher are kept for TEN YEARS, and the period begins with the end
 * of the Geschäftsjahr. So a period's retention runs to the end of the fiscal year it belongs to,
 * plus ten years. The fiscal year start is the workspace's own (`workspace.fiscal_year_start`,
 * MM-DD), never an assumed calendar year.
 */
export function retentionUntilFor(fiscalYearStart: string, period: string): string {
  const parts = fiscalYearStart.split('-').map((p) => Number.parseInt(p, 10));
  const startMonth = parts[0] ?? 1;
  const startDay = parts[1] ?? 1;
  const year = Number.parseInt(period.slice(0, 4), 10);
  const month = Number.parseInt(period.slice(5, 7), 10);
  // The fiscal year containing `period` STARTS in `fyStartYear`; it ends the day before the next start.
  const fyStartYear = month >= startMonth ? year : year - 1;
  const nextStart = new Date(Date.UTC(fyStartYear + 1, startMonth - 1, startDay));
  nextStart.setUTCDate(nextStart.getUTCDate() - 1);
  const end = nextStart.toISOString().slice(0, 10);
  return `${Number.parseInt(end.slice(0, 4), 10) + 10}${end.slice(4)}`;
}

function fiscalYearStartOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

// --- archivePreview (US-G13.5: zero writes anywhere) ---------------------------------------------

export function archivePreview(ctx: WorkspaceContext, input: { planId: unknown; stepId: unknown }): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId');
  if (guard) return guard;
  const located = locateStep(ctx, input.planId as string, input.stepId);
  if (!located.ok) return located.refusal;

  const parsed = parseArchive(ctx, located.plan);
  const periods = new Map<string, { entryCount: number; lineCount: number }>();
  const perAccount = new Map<string, { sourceAccount: string; sourceAccountName: string | null; targetAccountId: string | null; debitMinor: number; creditMinor: number }>();
  for (const entry of parsed.entries) {
    const period = entry.date.slice(0, 7);
    const bucket = periods.get(period) ?? { entryCount: 0, lineCount: 0 };
    bucket.entryCount += 1;
    bucket.lineCount += entry.lines.length;
    periods.set(period, bucket);
    for (const line of entry.lines) {
      const acc = perAccount.get(line.sourceAccount) ?? {
        sourceAccount: line.sourceAccount,
        sourceAccountName: line.sourceAccountName,
        targetAccountId: line.targetAccountId,
        debitMinor: 0,
        creditMinor: 0,
      };
      acc.debitMinor += line.debitMinor;
      acc.creditMinor += line.creditMinor;
      perAccount.set(line.sourceAccount, acc);
    }
  }
  return ok({
    periods: [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, c]) => ({ period, ...c })),
    perAccountTotals: [...perAccount.values()].sort((a, b) => a.sourceAccount.localeCompare(b.sourceAccount)),
    unmapped: parsed.unmapped,
    unbalancedCount: parsed.unbalancedCount,
    errors: [...parsed.fileErrors, ...parsed.rowErrors],
  });
}

// --- archiveImport (US-G13.1/US-G13.5) -----------------------------------------------------------

type Located =
  | { ok: true; plan: PlanRow; step: StepRow }
  | { ok: false; refusal: Result };

function locateStep(ctx: WorkspaceContext, planId: string, stepId: unknown): Located {
  const plan = loadPlan(ctx, planId);
  if (plan === undefined) return { ok: false, refusal: err('not_found', { planId }) };
  const step = loadStep(ctx, plan.id, stepId);
  if (step === undefined) return { ok: false, refusal: err('not_found', { stepId }) };
  if (step.data_class !== 'gl_history') {
    return { ok: false, refusal: err('wrong_data_class', { stepId: step.id, dataClass: step.data_class, need: 'gl_history' }) };
  }
  if (step.status === 'skipped') return { ok: false, refusal: err('step_excluded', { stepId: step.id }) };
  return { ok: true, plan, step };
}

/**
 * Import the step's history as archive rows. Streams the parsed entries in insert order; idempotent
 * on `(stepId, idempotencyKey)` when a key arrives (the MCP verb requires one, the G09 seam passes
 * none: spec §0 correction 4), and idempotent BY CONSTRUCTION regardless, because a re-run replaces
 * the step's rows WHOLESALE inside one transaction and lands the identical archive: never a
 * row-by-row edit (US-G13.5 boundary).
 *
 * An unmapped source account imports `target_account_id = NULL` rather than refusing: history is
 * evidence and evidence is not edited to fit the map. An internally unbalanced source entry imports
 * flagged (`balanced = 0`), never corrected.
 */
export function archiveImport(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId: unknown; idempotencyKey?: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? optStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  // Importing gates on `commit_migration` on BOTH faces (spec §3): asserted in the engine so the
  // G09 seam path and the direct verb agree.
  const cap = ctx.capabilities.assert('commit_migration');
  if (!cap.ok) return cap;
  const located = locateStep(ctx, input.planId as string, input.stepId);
  if (!located.ok) return located.refusal;
  const { plan, step } = located;

  const key = typeof input.idempotencyKey === 'string' ? `${step.id}:${input.idempotencyKey}` : undefined;
  if (key !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'gl_archive_import');
    if (replayed !== undefined) return replayed;
  }

  const parsed = parseArchive(ctx, plan);
  if (parsed.entries.length === 0 && parsed.fileErrors.length > 0) {
    return err('source_unavailable', { errors: parsed.fileErrors });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const fyStart = fiscalYearStartOf(ctx);
    ctx.store.tx(() => {
      // Wholesale supersede: the step's prior rows leave together, through the gate, never one by one.
      ctx.store.db.prepare('INSERT OR IGNORE INTO gl_archive_purge_gate (workspace_id) VALUES (?)').run(ctx.workspaceId);
      ctx.store.db
        .prepare(
          `DELETE FROM gl_archive_line WHERE workspace_id = ? AND entry_id IN
             (SELECT id FROM gl_archive_entry WHERE workspace_id = ? AND step_id = ?)`,
        )
        .run(ctx.workspaceId, ctx.workspaceId, step.id);
      ctx.store.db.prepare('DELETE FROM gl_archive_entry WHERE workspace_id = ? AND step_id = ?').run(ctx.workspaceId, step.id);
      ctx.store.db.prepare('DELETE FROM gl_archive_purge_gate WHERE workspace_id = ?').run(ctx.workspaceId);

      const insertEntry = ctx.store.db.prepare(
        `INSERT INTO gl_archive_entry (id, workspace_id, plan_id, step_id, source_entry_id, entry_date, description, source_ref, balanced, reposted_entry_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      );
      const insertLine = ctx.store.db.prepare(
        `INSERT INTO gl_archive_line (id, workspace_id, entry_id, source_account, source_account_name, target_account_id, debit_minor, credit_minor, currency, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const periodCounts = new Map<string, number>();
      for (const entry of parsed.entries) {
        const entryId = ctx.ids.next('glarch');
        insertEntry.run(
          entryId,
          ctx.workspaceId,
          plan.id,
          step.id,
          entry.sourceEntryId,
          entry.date,
          entry.description,
          entry.sourceRef,
          entry.balanced ? 1 : 0,
          now,
        );
        for (const line of entry.lines) {
          insertLine.run(
            ctx.ids.next('glline'),
            ctx.workspaceId,
            entryId,
            line.sourceAccount,
            line.sourceAccountName,
            line.targetAccountId,
            line.debitMinor,
            line.creditMinor,
            line.currency,
            line.description,
          );
        }
        const period = entry.date.slice(0, 7);
        periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
      }
      // The period ledger is rebuilt for this workspace from what the archive now holds, so a
      // supersede that dropped a month drops its row too. Purged markers survive on their own rows.
      const live = ctx.store.db
        .prepare("SELECT substr(entry_date, 1, 7) AS period, COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ? GROUP BY 1")
        .all(ctx.workspaceId) as Array<{ period: string; n: number }>;
      for (const row of live) {
        ctx.store.db
          .prepare(
            `INSERT INTO gl_archive_period (workspace_id, period, entry_count, retention_until)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (workspace_id, period) DO UPDATE SET entry_count = excluded.entry_count`,
          )
          .run(ctx.workspaceId, row.period, row.n, retentionUntilFor(fyStart, row.period));
      }
      ctx.store.db
        .prepare(
          `DELETE FROM gl_archive_period WHERE workspace_id = ? AND purged_at IS NULL AND period NOT IN
             (SELECT DISTINCT substr(entry_date, 1, 7) FROM gl_archive_entry WHERE workspace_id = ?)`,
        )
        .run(ctx.workspaceId, ctx.workspaceId);

      // Land the step. G09's `commitRoute` returns this function's result verbatim and cannot set
      // the status itself (its gl_history branch predates the archive), so the archive engine owns
      // the landing: the same shape `steps.ts` writes for its own classes.
      ctx.store.db
        .prepare('UPDATE migration_step SET status = ?, counts = ?, committed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run(
          'committed',
          JSON.stringify({
            created: parsed.entries.length,
            skipped: 0,
            failed: parsed.rowErrors.length,
            unmappedCount: parsed.unmapped.length,
            unbalancedCount: parsed.unbalancedCount,
          }),
          now,
          now,
          step.id,
          ctx.workspaceId,
        );
    });

    const lineCount = parsed.entries.reduce((sum, e) => sum + e.lines.length, 0);
    return ok({
      entryCount: parsed.entries.length,
      lineCount,
      unmappedCount: parsed.unmapped.length,
      unbalancedCount: parsed.unbalancedCount,
      errors: [...parsed.fileErrors, ...parsed.rowErrors],
    });
  };

  return key !== undefined ? ctx.store.rememberIdempotent(ctx.workspaceId, key, 'gl_archive_import', run) : run();
}

// --- archiveQuery (US-G13.1) ---------------------------------------------------------------------

export interface ArchiveQueryInput {
  account?: unknown;
  sourceAccount?: unknown;
  from?: unknown;
  to?: unknown;
  text?: unknown;
  amountMinMinor?: unknown;
  amountMaxMinor?: unknown;
  balancedOnly?: unknown;
  savedViewId?: unknown;
  page?: unknown;
}

/**
 * Query the archive by target account, source account, period, text and amount range. Paginates
 * (50 per page) rather than materialising the set (US-G13.1 boundary). Reads ONLY archive tables:
 * the hard partition means no filter combination can ever reach a live journal row.
 */
export function archiveQuery(ctx: WorkspaceContext, input: ArchiveQueryInput): Result {
  const guard =
    optStr(input.account, 'account') ??
    optStr(input.sourceAccount, 'sourceAccount') ??
    optStr(input.from, 'from') ??
    optStr(input.to, 'to') ??
    optStr(input.text, 'text') ??
    optStr(input.savedViewId, 'savedViewId');
  if (guard) return guard;

  const applied = applySavedView(ctx, 'gl_archive_entry', {
    savedViewId: input.savedViewId as string | undefined,
    account: input.account,
    sourceAccount: input.sourceAccount,
    from: input.from,
    to: input.to,
    text: input.text,
    amountMinMinor: input.amountMinMinor,
    amountMaxMinor: input.amountMaxMinor,
    balancedOnly: input.balancedOnly,
  });
  if (!applied.ok) return applied;
  const filter = (applied as { filter: Record<string, unknown> }).filter;

  const where: string[] = ['e.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof filter.from === 'string') {
    where.push('e.entry_date >= ?');
    params.push(filter.from);
  }
  if (typeof filter.to === 'string') {
    where.push('e.entry_date <= ?');
    params.push(filter.to);
  }
  if (filter.balancedOnly === true) where.push('e.balanced = 1');
  if (typeof filter.account === 'string') {
    where.push('EXISTS (SELECT 1 FROM gl_archive_line l WHERE l.entry_id = e.id AND l.workspace_id = e.workspace_id AND l.target_account_id = ?)');
    params.push(filter.account);
  }
  if (typeof filter.sourceAccount === 'string') {
    where.push('EXISTS (SELECT 1 FROM gl_archive_line l WHERE l.entry_id = e.id AND l.workspace_id = e.workspace_id AND l.source_account = ?)');
    params.push(filter.sourceAccount);
  }
  if (typeof filter.text === 'string') {
    where.push(
      "(e.description LIKE '%' || ? || '%' OR EXISTS (SELECT 1 FROM gl_archive_line l WHERE l.entry_id = e.id AND l.workspace_id = e.workspace_id AND (l.description LIKE '%' || ? || '%' OR l.source_account_name LIKE '%' || ? || '%')))",
    );
    params.push(filter.text, filter.text, filter.text);
  }
  if (typeof filter.amountMinMinor === 'number') {
    where.push('EXISTS (SELECT 1 FROM gl_archive_line l WHERE l.entry_id = e.id AND l.workspace_id = e.workspace_id AND (l.debit_minor >= ? OR l.credit_minor >= ?))');
    params.push(filter.amountMinMinor, filter.amountMinMinor);
  }
  if (typeof filter.amountMaxMinor === 'number') {
    where.push('NOT EXISTS (SELECT 1 FROM gl_archive_line l WHERE l.entry_id = e.id AND l.workspace_id = e.workspace_id AND (l.debit_minor > ? OR l.credit_minor > ?))');
    params.push(filter.amountMaxMinor, filter.amountMaxMinor);
  }

  const page = typeof input.page === 'number' && Number.isInteger(input.page) && input.page > 0 ? input.page : 1;
  const total = (
    ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM gl_archive_entry e WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
  ).n;
  const entries = ctx.store.db
    .prepare(
      `SELECT e.* FROM gl_archive_entry e WHERE ${where.join(' AND ')}
       ORDER BY e.entry_date DESC, e.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<Record<string, unknown>>;

  const lineStmt = ctx.store.db.prepare(
    `SELECT l.source_account, l.source_account_name, l.target_account_id, a.number AS target_number, a.name AS target_name,
            l.debit_minor, l.credit_minor, l.currency, l.description
       FROM gl_archive_line l
       LEFT JOIN account a ON a.id = l.target_account_id AND a.workspace_id = l.workspace_id
      WHERE l.workspace_id = ? AND l.entry_id = ?`,
  );

  return ok({
    entries: entries.map((e) => ({
      entryId: e.id,
      sourceEntryId: e.source_entry_id,
      date: e.entry_date,
      description: e.description,
      sourceRef: e.source_ref,
      balanced: e.balanced === 1,
      lines: (lineStmt.all(ctx.workspaceId, e.id) as Array<Record<string, unknown>>).map((l) => ({
        sourceAccount: l.source_account,
        sourceAccountName: l.source_account_name,
        targetAccountId: l.target_account_id,
        targetNumber: l.target_number,
        targetName: l.target_name,
        debitMinor: l.debit_minor,
        creditMinor: l.credit_minor,
        currency: l.currency,
        description: l.description,
      })),
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
    provenance: provenanceOf(ctx),
  });
}

/** The provenance band's facts: the source system and the archive's covered range (US-G13.3). */
function provenanceOf(ctx: WorkspaceContext): { system: string | null; from: string | null; to: string | null } {
  const range = ctx.store.db
    .prepare('SELECT MIN(entry_date) AS min_d, MAX(entry_date) AS max_d FROM gl_archive_entry WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { min_d: string | null; max_d: string | null };
  const system = ctx.store.db
    .prepare(
      `SELECT p.source_system FROM gl_archive_entry e JOIN migration_plan p ON p.id = e.plan_id AND p.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? ORDER BY e.created_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId) as { source_system: string | null } | undefined;
  return { system: system?.source_system ?? null, from: range.min_d, to: range.max_d };
}

// --- archiveAccountHistory (US-G13.1 boundary: aggregates, never rows) ---------------------------

export function archiveAccountHistory(
  ctx: WorkspaceContext,
  input: { accountId?: unknown; sourceAccount?: unknown; groupBy?: unknown },
): Result {
  const groupBy = input.groupBy ?? 'month';
  if (groupBy !== 'month' && groupBy !== 'quarter' && groupBy !== 'year') {
    return err('invalid_input', { field: 'groupBy', allowed: ['month', 'quarter', 'year'] });
  }
  const byTarget = typeof input.accountId === 'string' && input.accountId.length > 0;
  const bySource = typeof input.sourceAccount === 'string' && (input.sourceAccount as string).length > 0;
  if (!byTarget && !bySource) return err('invalid_input', { field: 'accountId', reason: 'accountId or sourceAccount required' });

  const bucket =
    groupBy === 'month'
      ? "substr(e.entry_date, 1, 7)"
      : groupBy === 'year'
        ? "substr(e.entry_date, 1, 4)"
        : "substr(e.entry_date, 1, 4) || '-Q' || ((CAST(substr(e.entry_date, 6, 2) AS INTEGER) + 2) / 3)";

  const rows = ctx.store.db
    .prepare(
      `SELECT ${bucket} AS period, SUM(l.debit_minor) AS debit_minor, SUM(l.credit_minor) AS credit_minor
         FROM gl_archive_line l
         JOIN gl_archive_entry e ON e.id = l.entry_id AND e.workspace_id = l.workspace_id
        WHERE l.workspace_id = ? AND ${byTarget ? 'l.target_account_id = ?' : 'l.source_account = ?'}
        GROUP BY 1 ORDER BY 1`,
    )
    .all(ctx.workspaceId, byTarget ? input.accountId : input.sourceAccount) as Array<{
    period: string;
    debit_minor: number;
    credit_minor: number;
  }>;

  let running = 0;
  return ok({
    groupBy,
    periods: rows.map((r) => {
      running += r.debit_minor - r.credit_minor;
      return { period: r.period, debitMinor: r.debit_minor, creditMinor: r.credit_minor, balanceMinor: running };
    }),
    provenance: provenanceOf(ctx),
  });
}

// --- archivePeriods (US-G13.4's surface) ---------------------------------------------------------

export function archivePeriods(ctx: WorkspaceContext, _input: Record<string, never> | object = {}): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM gl_archive_period WHERE workspace_id = ? ORDER BY period')
    .all(ctx.workspaceId) as Array<Record<string, unknown>>;
  const records = ctx.store.db
    .prepare('SELECT * FROM gl_archive_purge_record WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(ctx.workspaceId) as Array<Record<string, unknown>>;
  return ok({
    periods: rows.map((r) => ({
      period: r.period,
      entryCount: r.entry_count,
      retentionUntil: r.retention_until,
      purged: r.purged_at !== null,
      ...(r.purged_at !== null
        ? {
            purgeRecord: {
              purgedAt: r.purged_at,
              actor: r.purge_actor,
              reason: r.purge_reason,
              rowCount: r.purge_row_count,
            },
          }
        : {}),
    })),
    purgeRecords: records.map((r) => ({
      recordId: r.id,
      periodFrom: r.period_from,
      periodTo: r.period_to,
      outcome: r.outcome,
      reason: r.reason,
      statutoryRef: r.statutory_ref,
      actor: r.actor,
      rowCount: r.row_count,
      createdAt: r.created_at,
    })),
    provenance: provenanceOf(ctx),
  });
}

// --- archivePurge (US-G13.4) ---------------------------------------------------------------------

/**
 * Purge archive periods whose OR 958f retention has expired. Deletes ARCHIVE rows only: the gate
 * mechanism means this function is the single code path that can delete an archive row, and NOTHING
 * here names a live table, so the purge is structurally incapable of touching a journal row (the
 * D86 invariant, asserted in test/migration/archive.test.mjs).
 *
 * A purge inside the retention window refuses with the date AND the refusal is RECORDED: the
 * `gl_archive_purge_record` row citing OR 958f is the answer a data subject receives (US-G13.4).
 */
export function archivePurge(
  ctx: WorkspaceContext,
  input: { periodFrom: unknown; periodTo: unknown; reason: unknown; confirmed?: unknown; idempotencyKey: unknown },
): Result {
  const guard =
    reqStr(input.periodFrom, 'periodFrom') ??
    reqStr(input.periodTo, 'periodTo') ??
    reqStr(input.reason, 'reason') ??
    reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!PERIOD.test(input.periodFrom as string) || !PERIOD.test(input.periodTo as string)) {
    return err('invalid_input', { field: 'periodFrom', reason: 'YYYY-MM' });
  }
  const cap = ctx.capabilities.assert('purge_archive');
  if (!cap.ok) return cap;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'gl_archive_purge');
  if (replayed !== undefined) return replayed;

  if (input.confirmed !== true) return err('needs_confirmation', { periodFrom: input.periodFrom, periodTo: input.periodTo });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'gl_archive_purge', () => {
    const now = ctx.clock.now();
    const today = now.slice(0, 10);
    const periods = ctx.store.db
      .prepare('SELECT * FROM gl_archive_period WHERE workspace_id = ? AND period >= ? AND period <= ? AND purged_at IS NULL ORDER BY period')
      .all(ctx.workspaceId, input.periodFrom, input.periodTo) as Array<Record<string, unknown>>;
    if (periods.length === 0) return err('not_found', { periodFrom: input.periodFrom, periodTo: input.periodTo });

    const retained = periods.filter((p) => (p.retention_until as string) > today);
    if (retained.length > 0) {
      const until = retained.map((p) => p.retention_until as string).sort().at(-1) as string;
      // The refusal is recordable (US-G13.4): the record cites the statute; the conclusion on
      // erasure-vs-retention stays a lawyer's (OP6).
      ctx.store.db
        .prepare(
          `INSERT INTO gl_archive_purge_record (id, workspace_id, period_from, period_to, outcome, reason, statutory_ref, actor, row_count, created_at)
           VALUES (?, ?, ?, ?, 'refused', ?, ?, ?, 0, ?)`,
        )
        .run(ctx.ids.next('glpurge'), ctx.workspaceId, input.periodFrom, input.periodTo, input.reason, RETENTION_STATUTE, ctx.actor, now);
      return err('retention_active', { until, statutoryRef: RETENTION_STATUTE });
    }

    let purgedEntries = 0;
    let purgedFiles = 0;
    let recordId = '';
    ctx.store.tx(() => {
      const monthList = periods.map((p) => p.period as string);
      const placeholders = monthList.map(() => '?').join(', ');
      const entryIds = ctx.store.db
        .prepare(`SELECT id, source_ref FROM gl_archive_entry WHERE workspace_id = ? AND substr(entry_date, 1, 7) IN (${placeholders})`)
        .all(ctx.workspaceId, ...monthList) as Array<{ id: string; source_ref: string | null }>;
      purgedEntries = entryIds.length;
      const fileRefs = new Set(entryIds.map((e) => e.source_ref).filter((r): r is string => r !== null));

      ctx.store.db.prepare('INSERT OR IGNORE INTO gl_archive_purge_gate (workspace_id) VALUES (?)').run(ctx.workspaceId);
      const chunk = 400;
      for (let i = 0; i < entryIds.length; i += chunk) {
        const slice = entryIds.slice(i, i + chunk).map((e) => e.id);
        const ph = slice.map(() => '?').join(', ');
        ctx.store.db.prepare(`DELETE FROM gl_archive_line WHERE workspace_id = ? AND entry_id IN (${ph})`).run(ctx.workspaceId, ...slice);
        ctx.store.db.prepare(`DELETE FROM gl_archive_entry WHERE workspace_id = ? AND id IN (${ph})`).run(ctx.workspaceId, ...slice);
      }
      ctx.store.db.prepare('DELETE FROM gl_archive_purge_gate WHERE workspace_id = ?').run(ctx.workspaceId);

      for (const p of periods) {
        ctx.store.db
          .prepare('UPDATE gl_archive_period SET purged_at = ?, purge_actor = ?, purge_reason = ?, purge_row_count = ? WHERE workspace_id = ? AND period = ?')
          .run(now, ctx.actor, input.reason, entryIds.length, ctx.workspaceId, p.period);
      }

      recordId = ctx.ids.next('glpurge');
      ctx.store.db
        .prepare(
          `INSERT INTO gl_archive_purge_record (id, workspace_id, period_from, period_to, outcome, reason, statutory_ref, actor, row_count, created_at)
           VALUES (?, ?, ?, ?, 'purged', ?, ?, ?, ?, ?)`,
        )
        .run(recordId, ctx.workspaceId, input.periodFrom, input.periodTo, input.reason, RETENTION_STATUTE, ctx.actor, purgedEntries, now);

      // The linked source files (E00, US-G13.4): a file leaves only when NO remaining archive entry
      // references it, through E00's own verb, which keeps its own retention gate. A refusal there
      // (retention_locked) leaves the file and does not fail the purge: two statutes, two clocks.
      for (const fileId of fileRefs) {
        const still = ctx.store.db
          .prepare('SELECT 1 FROM gl_archive_entry WHERE workspace_id = ? AND source_ref = ? LIMIT 1')
          .get(ctx.workspaceId, fileId) as unknown;
        if (still !== undefined) continue;
        const gone = deleteFile(ctx, { fileId, confirmed: true, idempotencyKey: `glpurge:${recordId}:${fileId}` });
        if (gone.ok) purgedFiles += 1;
      }
    });

    return ok({
      purgedEntries,
      purgedFiles,
      record: {
        recordId,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        reason: input.reason,
        statutoryRef: RETENTION_STATUTE,
        actor: ctx.actor,
        rowCount: purgedEntries,
      },
    });
  });
}

// --- archiveComparative (US-G13.2: the archive-only side of an A08 comparative) ------------------

export interface ArchiveComparativeInput {
  /** The compared window's start (period statements). Absent for an as-of (Bilanz) comparative. */
  from?: string;
  /** The compared window's end, or the compared Stichtag. */
  to: string;
}

export interface ArchiveComparativeAccount {
  readonly accountId: string;
  readonly number: string;
  readonly type: string;
  /** Net debit-credit through `to` (an as-of balance in the prior system's own books). */
  readonly cumulativeNetMinor: number;
  /** Movement inside [from..to] (a period figure). Zero when no `from` was given. */
  readonly windowDebitMinor: number;
  readonly windowCreditMinor: number;
}

/**
 * The archive-side comparative read model. Returns figures ONLY when the compared window is wholly
 * covered by un-purged archive periods (US-G13.2: a partial sum shown as a whole-period figure
 * would be wrong in the way that is hardest to notice). `no_data` when the archive holds nothing
 * for the window at all; `partial` when it holds some of it. Figures are keyed by TARGET (A01)
 * account; unmapped lines aggregate into `unassignedNetMinor` so nothing silently disappears.
 */
export function archiveComparative(ctx: WorkspaceContext, input: ArchiveComparativeInput): Result {
  if (typeof input.to !== 'string' || !ISO_DATE.test(input.to)) return err('invalid_input', { field: 'to' });
  if (input.from !== undefined && (typeof input.from !== 'string' || !ISO_DATE.test(input.from))) {
    return err('invalid_input', { field: 'from' });
  }

  const allPeriods = ctx.store.db
    .prepare('SELECT period, purged_at FROM gl_archive_period WHERE workspace_id = ? ORDER BY period')
    .all(ctx.workspaceId) as Array<{ period: string; purged_at: string | null }>;
  const prov = provenanceOf(ctx);
  const unpurged = allPeriods.filter((r) => r.purged_at === null).map((r) => r.period);
  if (unpurged.length === 0) return ok({ status: 'no_data', system: prov.system });

  // The archive COVERS whole fiscal years: a prior-system export is drawn per Geschäftsjahr, so
  // the covered range runs from the START of the fiscal year holding the earliest entry to the END
  // of the fiscal year holding the latest, and a month inside that range with no period row simply
  // held no bookings, which is coverage, not a gap. The only holes are PURGED months, because a
  // cumulative figure computed over a purge gap would be a partial sum wearing a whole-balance
  // face, the exact dishonesty US-G13.2 forbids.
  const fyStartMonth = Number.parseInt(fiscalYearStartOf(ctx).slice(0, 2), 10);
  const firstPeriod = (allPeriods[0] as { period: string }).period;
  const lastPeriod = (allPeriods[allPeriods.length - 1] as { period: string }).period;
  const firstEver = fyFirstMonth(firstPeriod, fyStartMonth);
  const lastEver = fyLastMonth(lastPeriod, fyStartMonth);
  const purgedMonths = new Set(allPeriods.filter((r) => r.purged_at !== null).map((r) => r.period));
  const toMonth = input.to.slice(0, 7);
  const fromMonth = (input.from ?? input.to).slice(0, 7);

  // Wholly covered means: the window sits inside [firstEver..lastEver], and no PURGED month sits
  // anywhere in [firstEver..toMonth] (the cumulative figure needs the whole run-up un-purged).
  let purgedHole = false;
  for (let m = firstEver; m <= toMonth; m = nextMonth(m)) {
    if (purgedMonths.has(m)) {
      purgedHole = true;
      break;
    }
  }
  if (toMonth > lastEver || fromMonth < firstEver || fromMonth > toMonth || purgedHole) {
    const overlap = fromMonth <= lastEver && toMonth >= firstEver;
    return ok({
      status: overlap ? 'partial' : 'no_data',
      system: prov.system,
      coveredFrom: firstEver,
      coveredTo: lastEver,
    });
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT l.target_account_id AS account_id, a.number AS number, a.type AS type,
              SUM(CASE WHEN e.entry_date <= ? THEN l.debit_minor - l.credit_minor ELSE 0 END) AS cumulative_net,
              SUM(CASE WHEN e.entry_date >= ? AND e.entry_date <= ? THEN l.debit_minor ELSE 0 END) AS window_debit,
              SUM(CASE WHEN e.entry_date >= ? AND e.entry_date <= ? THEN l.credit_minor ELSE 0 END) AS window_credit
         FROM gl_archive_line l
         JOIN gl_archive_entry e ON e.id = l.entry_id AND e.workspace_id = l.workspace_id
         LEFT JOIN account a ON a.id = l.target_account_id AND a.workspace_id = l.workspace_id
        WHERE l.workspace_id = ?
        GROUP BY 1, 2, 3`,
    )
    .all(
      input.to,
      input.from ?? '9999-12-31',
      input.to,
      input.from ?? '9999-12-31',
      input.to,
      ctx.workspaceId,
    ) as Array<{
    account_id: string | null;
    number: string | null;
    type: string | null;
    cumulative_net: number;
    window_debit: number;
    window_credit: number;
  }>;

  const byAccount: ArchiveComparativeAccount[] = [];
  let unassignedNetMinor = 0;
  for (const r of rows) {
    if (r.account_id === null || r.number === null || r.type === null) {
      unassignedNetMinor += r.cumulative_net;
      continue;
    }
    byAccount.push({
      accountId: r.account_id,
      number: r.number,
      type: r.type,
      cumulativeNetMinor: r.cumulative_net,
      windowDebitMinor: r.window_debit,
      windowCreditMinor: r.window_credit,
    });
  }

  return ok({
    status: 'ok',
    system: prov.system,
    coveredFrom: firstEver,
    coveredTo: lastEver,
    byAccount,
    unassignedNetMinor,
  });
}

/** The month after `YYYY-MM`, in the same format. Calendar arithmetic, never money arithmetic. */
function nextMonth(period: string): string {
  const year = Number.parseInt(period.slice(0, 4), 10);
  const month = Number.parseInt(period.slice(5, 7), 10);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** The first month (YYYY-MM) of the fiscal year containing `period`, for a start month 1..12. */
function fyFirstMonth(period: string, startMonth: number): string {
  const year = Number.parseInt(period.slice(0, 4), 10);
  const month = Number.parseInt(period.slice(5, 7), 10);
  const fyYear = month >= startMonth ? year : year - 1;
  return `${fyYear}-${String(startMonth).padStart(2, '0')}`;
}

/** The last month (YYYY-MM) of the fiscal year containing `period`. */
function fyLastMonth(period: string, startMonth: number): string {
  const first = fyFirstMonth(period, startMonth);
  const fyYear = Number.parseInt(first.slice(0, 4), 10);
  return startMonth === 1
    ? `${fyYear}-12`
    : `${fyYear + 1}-${String(startMonth - 1).padStart(2, '0')}`;
}
