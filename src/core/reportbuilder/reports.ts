/**
 * F01, the report builder: turn any registered read model into a saved report (source + filters +
 * columns + format) that runs to a local CSV/PDF artifact on demand (OP4) and stores a schedule
 * intent (P8, the cloud tier owns delivery). F01 OWNS `saved_reports` + `report_runs` and POSTS
 * NOTHING (P3): it composes read models (P5, recomputed every run), it never calls A02/A14, and it
 * imports no posting seam (asserted by `test/reportbuilder/no-posting.test.mjs`).
 *
 * §H-TENANT: every read and write scopes to `ctx.workspaceId`; a foreign report id resolves to
 * nothing, so a cross-tenant caller can neither read, run, nor mutate another book's report.
 *
 * §H-IDEMPOTENT: every write takes an idempotency key and keeps all state-dependent work inside the
 * `run` closure (the B04 shape), so a replayed key answers the stored result and re-running the same
 * key returns the original artifact.
 *
 * THE TX-ATOMICITY DISCIPLINE (the C02/D03 bug class): `ctx.store.tx` and `rememberIdempotent` roll
 * back ONLY on a throw. A `run` callback that writes and then RETURNS a P9 err commits the partial
 * write while reporting failure. So every REFUSABLE condition (unknown_source, invalid_filter_field,
 * columns_empty, invalid_schedule, retention_locked, cross-tenant, permission on the source) is
 * pre-checked as a pure READ before any write and returns its err directly.
 *
 * RBAC: F01's own gates (`reports.write`/`reports.run`) are checked at the registry boundary. In
 * ADDITION, any verb that COMPUTES a source (`reports_preview`, `reports_run`) asserts that source's
 * OWN read gates via `ctx.capabilities` here, so a report is never a privilege-escalation path around
 * A24 (spec §5), the dashboards (F00) posture.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isReportFormat, isOperatorForType } from './enums.js';
import type { ColumnType } from './enums.js';
import { parseSchedule } from './cron.js';
import { REPORT_SOURCES, REPORT_SOURCE_IDS, reportSourceDef } from './sources.js';
import type { ReportSourceDef } from './sources.js';
import { renderCsv, renderPdf } from './render.js';
import type { RenderColumn } from './render.js';
import { uploadFile, linkFile, listLinkedFiles } from '../files/index.js';
import { applySavedView } from '../customization/views.js';

const PREVIEW_LIMIT_DEFAULT = 50;
const PREVIEW_LIMIT_MAX = 500;

// ------------------------------------------------------------------------------------------------
// Row & column resolution (shared by preview and run)
// ------------------------------------------------------------------------------------------------

interface ResolvedColumn {
  key: string;
  labelI18n: { 'de-CH': string; en: string };
  type: ColumnType;
  isCustom: boolean;
  fieldDefId?: string;
}

interface CustomFieldDefRow {
  id: string;
  key: string;
  label_i18n: string;
  type: string;
}

/**
 * The published columns of a source: its own base fields PLUS any confirmed, non-archived `cf:`
 * custom fields defined on the source's entity kind (OP7). A custom field appears here the moment G00
 * defines it, with zero F01 code change. An aggregated source (no `entityKind`) has base columns only.
 */
export function publishedColumns(ctx: WorkspaceContext, source: ReportSourceDef): ResolvedColumn[] {
  const base: ResolvedColumn[] = source.fields.map((f) => ({
    key: f.key,
    labelI18n: f.labelI18n,
    type: f.type,
    isCustom: false,
  }));
  if (source.entityKind === undefined) return base;
  const defs = ctx.store.db
    .prepare(
      `SELECT id, key, label_i18n, type FROM custom_field_def
       WHERE workspace_id = ? AND entity_kind = ? AND archived = 0 AND draft = 0
       ORDER BY sort, key`,
    )
    .all(ctx.workspaceId, source.entityKind) as CustomFieldDefRow[];
  const cf: ResolvedColumn[] = defs.map((d) => ({
    key: `cf:${d.key}`,
    labelI18n: parseLabel(d.label_i18n),
    type: (d.type as ColumnType) ?? 'text',
    isCustom: true,
    fieldDefId: d.id,
  }));
  return [...base, ...cf];
}

function parseLabel(json: string): { 'de-CH': string; en: string } {
  try {
    const o = JSON.parse(json) as Record<string, string>;
    return { 'de-CH': o['de-CH'] ?? o.en ?? '', en: o.en ?? o['de-CH'] ?? '' };
  } catch {
    return { 'de-CH': json, en: json };
  }
}

/** The `cf:` value for one row, JSON-decoded, or undefined when the record has none. */
function customValue(ctx: WorkspaceContext, fieldDefId: string, entityId: unknown): unknown {
  if (typeof entityId !== 'string' || entityId.length === 0) return undefined;
  const row = ctx.store.db
    .prepare('SELECT value FROM custom_field_value WHERE workspace_id = ? AND field_def_id = ? AND entity_id = ?')
    .get(ctx.workspaceId, fieldDefId, entityId) as { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/** Read one column's value off a raw source row, resolving `cf:` columns through the value table. */
function valueOf(ctx: WorkspaceContext, col: ResolvedColumn, row: Record<string, unknown>): unknown {
  if (!col.isCustom) return row[col.key];
  return customValue(ctx, col.fieldDefId as string, row.id);
}

// ------------------------------------------------------------------------------------------------
// Filters
// ------------------------------------------------------------------------------------------------

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

/**
 * Validate a filter list against a source's published columns. Every filter must name a published
 * field and carry an operator its type admits (`invalid_filter_field`, spec §2 Error). Returns the
 * normalised filters or the offending field so the GUI can surface it inline.
 */
function validateFilters(
  raw: unknown,
  byKey: ReadonlyMap<string, ResolvedColumn>,
): { ok: true; filters: Filter[] } | { ok: false; field: string } {
  if (raw === undefined || raw === null) return { ok: true, filters: [] };
  if (!Array.isArray(raw)) return { ok: false, field: '' };
  const filters: Filter[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, field: '' };
    const f = item as Record<string, unknown>;
    const fieldKey = f.field;
    if (typeof fieldKey !== 'string') return { ok: false, field: String(fieldKey) };
    const col = byKey.get(fieldKey);
    if (col === undefined) return { ok: false, field: fieldKey };
    if (!isOperatorForType(f.op, col.type)) return { ok: false, field: fieldKey };
    filters.push({ field: fieldKey, op: f.op as string, value: f.value });
  }
  return { ok: true, filters };
}

/** Apply the validated filters to the computed rows, in memory (F01 composes read models, no raw SQL). */
function applyFilters(
  ctx: WorkspaceContext,
  rows: Record<string, unknown>[],
  filters: Filter[],
  byKey: ReadonlyMap<string, ResolvedColumn>,
): Record<string, unknown>[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((f) => matches(valueOf(ctx, byKey.get(f.field) as ResolvedColumn, row), f)),
  );
}

function matches(value: unknown, f: Filter): boolean {
  const target = f.value;
  switch (f.op) {
    case 'eq':
      return String(value ?? '') === String(target ?? '');
    case 'neq':
      return String(value ?? '') !== String(target ?? '');
    case 'contains': {
      if (Array.isArray(value)) return value.map(String).includes(String(target));
      return String(value ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
    }
    case 'in':
      return Array.isArray(target) && target.map(String).includes(String(value ?? ''));
    case 'gt':
      return Number(value) > Number(target);
    case 'lt':
      return Number(value) < Number(target);
    case 'gte':
      return Number(value) >= Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    case 'before':
      return String(value ?? '') < String(target ?? '');
    case 'after':
      return String(value ?? '') > String(target ?? '');
    case 'on_or_before':
      return String(value ?? '') <= String(target ?? '');
    case 'on_or_after':
      return String(value ?? '') >= String(target ?? '');
    default:
      return true;
  }
}

// ------------------------------------------------------------------------------------------------
// Shared compute pipeline
// ------------------------------------------------------------------------------------------------

/** Assert the source's OWN read gates so a report never reads past the caller's RBAC (spec §5). */
function assertSourceReadable(ctx: WorkspaceContext, source: ReportSourceDef): Result | undefined {
  for (const cap of source.readCapabilities) {
    if (!ctx.capabilities.assert(cap).ok) return err('permission_denied', { capability: cap });
  }
  return undefined;
}

interface ComputedReport {
  columns: ResolvedColumn[];
  rows: Record<string, unknown>[];
  total: number;
}

/**
 * The heart shared by preview and run: assert the source RBAC, resolve columns, validate filters,
 * compute the source (P5), filter, and project the requested columns. Returns a P9 err on any refusal
 * WITHOUT touching a table, so a refused run writes nothing.
 */
function computeReport(
  ctx: WorkspaceContext,
  source: ReportSourceDef,
  filtersRaw: unknown,
  columnsRaw: unknown,
  limit?: number,
): { ok: true; report: ComputedReport } | { ok: false; error: Result } {
  const denied = assertSourceReadable(ctx, source);
  if (denied !== undefined) return { ok: false, error: denied };

  if (!source.available(ctx)) {
    return { ok: false, error: err('needs_source_module', { module: source.module }) };
  }

  const published = publishedColumns(ctx, source);
  const byKey = new Map(published.map((c) => [c.key, c]));

  const filters = validateFilters(filtersRaw, byKey);
  if (!filters.ok) return { ok: false, error: err('invalid_filter_field', { field: filters.field }) };

  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
    return { ok: false, error: err('columns_empty', {}) };
  }
  const selected: ResolvedColumn[] = [];
  for (const key of columnsRaw) {
    const col = byKey.get(String(key));
    if (col === undefined) return { ok: false, error: err('invalid_filter_field', { field: String(key) }) };
    selected.push(col);
  }

  const { result, rowsKey } = source.compute(ctx);
  if (!result.ok) return { ok: false, error: result };
  const raw = ((result as unknown as Record<string, unknown>)[rowsKey] as Record<string, unknown>[]) ?? [];

  const filtered = applyFilters(ctx, raw, filters.filters, byKey);
  const projected = filtered.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of selected) out[col.key] = valueOf(ctx, col, row);
    return out;
  });

  const total = projected.length;
  const limited = typeof limit === 'number' ? projected.slice(0, Math.min(limit, PREVIEW_LIMIT_MAX)) : projected;
  return { ok: true, report: { columns: selected, rows: limited, total } };
}

/** A stable, non-cryptographic version tag for a definition (FNV-1a): which version produced a run. */
function definitionHash(source: string, filters: unknown, columns: unknown, format: string): string {
  const s = JSON.stringify({ source, filters: filters ?? [], columns: columns ?? [], format });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------------------------------------
// saved_reports mapping
// ------------------------------------------------------------------------------------------------

interface SavedReportRow {
  id: string;
  workspace_id: string;
  name: string;
  source: string;
  filters: string;
  columns: string;
  format: string;
  schedule: string | null;
  recipients: string;
  delivery_active: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapReport(row: SavedReportRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    source: row.source,
    filters: safeJson(row.filters, []),
    columns: safeJson(row.columns, []),
    format: row.format,
    schedule: row.schedule,
    recipients: safeJson(row.recipients, []),
    deliveryActive: row.delivery_active === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readReport(ctx: WorkspaceContext, reportId: unknown): SavedReportRow | undefined {
  if (typeof reportId !== 'string' || reportId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM saved_reports WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, reportId) as SavedReportRow | undefined;
}

// ------------------------------------------------------------------------------------------------
// Verbs: reads
// ------------------------------------------------------------------------------------------------

export interface SourcesInput {
  workspaceId?: string;
}

/** `reports_sources` (P5): the registry as a read model, each source's published columns unioned with
 * its `cf:` custom-field columns, its accounting-record flag, and its module availability. */
export function reportsSources(ctx: WorkspaceContext): Result {
  const sources = REPORT_SOURCES.map((s) => {
    const cols = publishedColumns(ctx, s);
    return {
      id: s.id,
      titleI18n: s.titleI18n,
      entityKind: s.entityKind ?? null,
      accountingRecord: s.accountingRecord,
      module: s.module,
      available: s.available(ctx),
      columns: cols.map((c) => ({ key: c.key, labelI18n: c.labelI18n, type: c.type, custom: c.isCustom })),
    };
  });
  return ok({ sources });
}

export interface PreviewInput {
  source?: unknown;
  filters?: unknown;
  columns?: unknown;
  limit?: unknown;
}

/** `reports_preview` (P5): read-only ad-hoc compute for the builder's live preview and agent
 * exploration. Persists nothing. Asserts the source's own read RBAC. */
export function reportsPreview(ctx: WorkspaceContext, input: PreviewInput): Result {
  const source = reportSourceDef(input.source);
  if (source === undefined) return err('unknown_source', { known: REPORT_SOURCE_IDS });
  const limit = Number.isInteger(input.limit) ? (input.limit as number) : PREVIEW_LIMIT_DEFAULT;
  const computed = computeReport(ctx, source, input.filters, input.columns, limit);
  if (!computed.ok) return computed.error;
  return ok({
    source: source.id,
    columns: computed.report.columns.map((c) => ({ key: c.key, labelI18n: c.labelI18n, type: c.type, custom: c.isCustom })),
    rows: computed.report.rows,
    rowCount: computed.report.total,
    truncated: computed.report.total > computed.report.rows.length,
  });
}

/** `reports_list` (P5): the saved-report list, tenant-scoped, newest first. */
export function reportsList(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM saved_reports WHERE workspace_id = ? ORDER BY created_at DESC, id DESC')
    .all(ctx.workspaceId) as SavedReportRow[];
  return ok({ reports: rows.map(mapReport) });
}

export interface RunsInput {
  reportId?: unknown;
  status?: string;
  savedViewId?: string;
}

/** `reports_runs` (P5): the append-only run history for one report, newest first. */
export function reportsRuns(ctx: WorkspaceContext, input: RunsInput): Result {
  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});
  // The G00 seam over the run history (`report_run` views), the `project_get` coverage-read precedent:
  // a stored `status` filter (ok|failed) merges UNDER an explicit one, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'report_run', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  } as { status?: string; savedViewId?: string });
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;
  let rows = ctx.store.db
    .prepare(
      `SELECT id, ran_at, status, row_count, format, artifact_ref, definition_hash, document_id, actor
       FROM report_runs WHERE workspace_id = ? AND report_id = ? ORDER BY ran_at DESC, id DESC`,
    )
    .all(ctx.workspaceId, input.reportId) as Record<string, unknown>[];
  if (filter.status !== undefined) {
    rows = rows.filter((r) => r.status === filter.status);
  }
  return ok({
    runs: rows.map((r) => ({
      id: r.id,
      ranAt: r.ran_at,
      status: r.status,
      rowCount: r.row_count,
      format: r.format,
      artifactRef: r.artifact_ref,
      definitionHash: r.definition_hash,
      documentId: r.document_id,
      actor: r.actor,
    })),
  });
}

// ------------------------------------------------------------------------------------------------
// Verbs: writes
// ------------------------------------------------------------------------------------------------

export interface SaveInput {
  name?: unknown;
  source?: unknown;
  filters?: unknown;
  columns?: unknown;
  format?: unknown;
  idempotencyKey?: string;
}

/** `reports_save` (US-F01.1): validate source/filters/columns/format, persist a `saved_reports` row. */
export function reportsSave(ctx: WorkspaceContext, input: SaveInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_save');
  if (replay !== undefined) return replay;

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }
  const source = reportSourceDef(input.source);
  if (source === undefined) return err('unknown_source', { known: REPORT_SOURCE_IDS });
  const format = input.format ?? 'csv';
  if (!isReportFormat(format)) return err('invalid_input', { field: 'format' });

  const validation = validateDefinition(ctx, source, input.filters, input.columns);
  if (validation !== undefined) return validation;

  const name = input.name.trim();
  const filtersJson = JSON.stringify(input.filters ?? []);
  const columnsJson = JSON.stringify(input.columns);

  const run = (): Result => {
    const id = ctx.ids.next('report');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO saved_reports (id, workspace_id, name, source, filters, columns, format, schedule,
                                    recipients, delivery_active, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', 0, NULL, ?, ?)`,
      )
      .run(id, ctx.workspaceId, name, source.id, filtersJson, columnsJson, format, now, now);
    return ok({ report: mapReport(readReport(ctx, id) as SavedReportRow) });
  };
  return remember(ctx, input.idempotencyKey, 'reports_save', run);
}

export interface UpdateInput {
  reportId?: unknown;
  patch?: unknown;
  idempotencyKey?: string;
}

/** `reports_update` (US-F01.4): patch name/filters/columns/format on a saved report. */
export function reportsUpdate(ctx: WorkspaceContext, input: UpdateInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_update');
  if (replay !== undefined) return replay;

  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});
  const patch = (typeof input.patch === 'object' && input.patch !== null ? input.patch : {}) as Record<string, unknown>;

  let source = reportSourceDef(report.source) as ReportSourceDef;
  if (patch.source !== undefined) {
    const next = reportSourceDef(patch.source);
    if (next === undefined) return err('unknown_source', { known: REPORT_SOURCE_IDS });
    source = next;
  }
  let format = report.format;
  if (patch.format !== undefined) {
    if (!isReportFormat(patch.format)) return err('invalid_input', { field: 'format' });
    format = patch.format;
  }
  const nextFilters = patch.filters !== undefined ? patch.filters : safeJson(report.filters, []);
  const nextColumns = patch.columns !== undefined ? patch.columns : safeJson(report.columns, []);
  const validation = validateDefinition(ctx, source, nextFilters, nextColumns);
  if (validation !== undefined) return validation;

  let name = report.name;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim().length === 0) return err('invalid_input', { field: 'name' });
    name = patch.name.trim();
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `UPDATE saved_reports SET name = ?, source = ?, filters = ?, columns = ?, format = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(name, source.id, JSON.stringify(nextFilters), JSON.stringify(nextColumns), format, now, ctx.workspaceId, report.id);
    return ok({ report: mapReport(readReport(ctx, report.id) as SavedReportRow) });
  };
  return remember(ctx, input.idempotencyKey, 'reports_update', run);
}

export interface DuplicateInput {
  reportId?: unknown;
  idempotencyKey?: string;
}

/** `reports_duplicate` (US-F01.4): copy a definition with a "(Kopie)" suffix and WITHOUT its schedule
 * or recipients, so a copy never silently starts mailing anyone (P8 spirit). */
export function reportsDuplicate(ctx: WorkspaceContext, input: DuplicateInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_duplicate');
  if (replay !== undefined) return replay;

  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});

  const run = (): Result => {
    const id = ctx.ids.next('report');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO saved_reports (id, workspace_id, name, source, filters, columns, format, schedule,
                                    recipients, delivery_active, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', 0, NULL, ?, ?)`,
      )
      .run(id, ctx.workspaceId, `${report.name} (Kopie)`, report.source, report.filters, report.columns, report.format, now, now);
    return ok({ report: mapReport(readReport(ctx, id) as SavedReportRow) });
  };
  return remember(ctx, input.idempotencyKey, 'reports_duplicate', run);
}

export interface DeleteInput {
  reportId?: unknown;
  idempotencyKey?: string;
}

/** `reports_delete` (US-F01.4): remove a definition and its run history after the caller confirms.
 * Refused with `retention_locked` while any run is retention-linked into E00 (E00 owns the lock).
 * Retained E00 documents are untouched: E00 owns them. */
export function reportsDelete(ctx: WorkspaceContext, input: DeleteInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_delete');
  if (replay !== undefined) return replay;

  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});

  // Pre-check the retention lock BEFORE any delete (tx-atomicity): a run linked into E00 whose
  // artifact E00 still retains under OR 958f blocks the definition delete. E00 owns the lock; F01 only
  // reads it through E00's own linked-files read model.
  if (retentionLocked(ctx, report.id)) return err('retention_locked', {});

  const run = (): Result => {
    ctx.store.db.prepare('DELETE FROM report_run_artifact WHERE workspace_id = ? AND run_id IN (SELECT id FROM report_runs WHERE workspace_id = ? AND report_id = ?)').run(ctx.workspaceId, ctx.workspaceId, report.id);
    ctx.store.db.prepare('DELETE FROM report_runs WHERE workspace_id = ? AND report_id = ?').run(ctx.workspaceId, report.id);
    ctx.store.db.prepare('DELETE FROM saved_reports WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, report.id);
    return ok({ deleted: true, reportId: report.id });
  };
  return remember(ctx, input.idempotencyKey, 'reports_delete', run);
}

/** Is any run of this report retention-linked into E00 and still locked there? */
function retentionLocked(ctx: WorkspaceContext, reportId: string): boolean {
  const linked = listLinkedFiles(ctx, { entityKind: 'report_run', entityId: reportId }) as unknown as Result;
  if (linked.ok) {
    const files = (linked as unknown as { files?: { retentionLocked?: boolean }[] }).files ?? [];
    if (files.some((f) => f.retentionLocked === true)) return true;
  }
  // A run may also carry its own document link; check each run's linked artifact.
  const runs = ctx.store.db
    .prepare('SELECT id FROM report_runs WHERE workspace_id = ? AND report_id = ? AND document_id IS NOT NULL')
    .all(ctx.workspaceId, reportId) as { id: string }[];
  for (const r of runs) {
    const rl = listLinkedFiles(ctx, { entityKind: 'report_run', entityId: r.id }) as unknown as Result;
    if (rl.ok) {
      const files = (rl as unknown as { files?: { retentionLocked?: boolean }[] }).files ?? [];
      if (files.some((f) => f.retentionLocked === true)) return true;
    }
  }
  return false;
}

export interface ScheduleInput {
  reportId?: unknown;
  schedule?: unknown;
  recipients?: unknown;
  idempotencyKey?: string;
}

/** `reports_schedule` (US-F01.3): store a validated cron-subset schedule and (draft-gated) recipients.
 * Clearing the schedule (`schedule:null`) deactivates delivery and keeps the report. In the OSS core
 * delivery stays inactive (`{active:false, reason:'cloud_tier'}`, OP4): the local run always works. */
export function reportsSchedule(ctx: WorkspaceContext, input: ScheduleInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_schedule');
  if (replay !== undefined) return replay;

  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});

  let canonical: string | null = null;
  if (input.schedule !== null && input.schedule !== undefined) {
    const parsed = parseSchedule(input.schedule);
    if (!parsed.ok) return err('invalid_schedule', { reason: parsed.reason });
    canonical = parsed.canonical;
  }

  const recipients = normaliseRecipients(input.recipients);
  if (recipients === undefined) return err('invalid_input', { field: 'recipients' });

  // The OSS core wires no delivery transport (OP4): recipients are stored draft-gated and delivery
  // never activates on its own. The cloud tier flips delivery under its own approval (P8).
  const deliveryActive = 0;

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        'UPDATE saved_reports SET schedule = ?, recipients = ?, delivery_active = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
      )
      .run(canonical, JSON.stringify(recipients), deliveryActive, now, ctx.workspaceId, report.id);
    const active = canonical !== null;
    return ok({
      report: mapReport(readReport(ctx, report.id) as SavedReportRow),
      schedule: canonical,
      delivery: {
        active: false,
        ...(recipients.length > 0 ? { reason: 'cloud_tier' } : {}),
      },
      scheduled: active,
    });
  };
  return remember(ctx, input.idempotencyKey, 'reports_schedule', run);
}

export interface RunInput {
  reportId?: unknown;
  format?: unknown;
  retain?: unknown;
  idempotencyKey?: string;
}

/** `reports_run` (US-F01.2): compute the source (P5), project the stored columns, render CSV/PDF as a
 * local artifact (OP4), append a `report_runs` row, and (with `retain`) link an accounting-record run
 * into E00. Re-running the same `idempotency_key` returns the original artifact (§H-IDEMPOTENT). */
export function reportsRun(ctx: WorkspaceContext, input: RunInput): Result {
  const replay = recall(ctx, input.idempotencyKey, 'reports_run');
  if (replay !== undefined) return replay;

  const report = readReport(ctx, input.reportId);
  if (report === undefined) return err('report_not_found', {});
  const source = reportSourceDef(report.source);
  if (source === undefined) return err('unknown_source', { known: REPORT_SOURCE_IDS });

  let format = report.format;
  if (input.format !== undefined) {
    if (!isReportFormat(input.format)) return err('invalid_input', { field: 'format' });
    format = input.format;
  }

  const storedColumns = safeJson<string[]>(report.columns, []);
  const storedFilters = safeJson<unknown[]>(report.filters, []);
  const computed = computeReport(ctx, source, storedFilters, storedColumns);
  if (!computed.ok) return computed.error;

  const cols: RenderColumn[] = computed.report.columns.map((c) => ({
    key: c.key,
    label: c.labelI18n['de-CH'],
    type: c.type,
  }));
  const workspaceName = workspaceNameOf(ctx);
  const ranAt = ctx.clock.now();
  const meta = {
    workspaceName,
    reportName: report.name,
    filterSummary: summariseFilters(storedFilters),
    ranAt,
  };
  const rendered =
    format === 'pdf'
      ? renderPdf({ columns: cols, rows: computed.report.rows, meta, emptyLabel: 'Keine Daten für diese Filter' })
      : renderCsv({ columns: cols, rows: computed.report.rows, meta, emptyLabel: 'Keine Daten für diese Filter' });
  const mime = format === 'pdf' ? 'application/pdf' : 'text/csv';
  const rowCount = computed.report.total;
  const defHash = definitionHash(report.source, storedFilters, storedColumns, format);
  const retain = input.retain === true && source.accountingRecord;

  const run = (): Result => {
    const runId = ctx.ids.next('reportrun');
    const now = ctx.clock.now();

    // Optional E00 retention link (OP3). F01 passes only the run context and never computes a
    // retention date: E00 owns the OR 958f period rule. If E00 does not yet classify report artifacts
    // as accounting records, the link still files the artifact; the statutory lock is E00's to apply.
    let documentId: string | null = null;
    if (retain) {
      const uploaded = uploadFile(ctx, {
        title: `${report.name} (${ranAt})`,
        filename: `${report.id}-${runId}.${format}`,
        mime,
        contentBase64: rendered.toString('base64'),
        idempotencyKey: `${runId}-file`,
      }) as unknown as Result;
      if (uploaded.ok) {
        const fileId = (uploaded as unknown as { file: { id: string } }).file.id;
        documentId = fileId;
        linkFile(ctx, {
          fileId,
          entityKind: 'report_run',
          entityId: runId,
          idempotencyKey: `${runId}-link`,
        });
      }
    }

    ctx.store.db
      .prepare(
        `INSERT INTO report_runs (id, workspace_id, report_id, ran_at, status, row_count, format,
                                  artifact_ref, definition_hash, document_id, actor, created_at)
         VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, ctx.workspaceId, report.id, now, rowCount, format, runId, defHash, documentId, ctx.actor, now);
    ctx.store.db
      .prepare('INSERT INTO report_run_artifact (workspace_id, run_id, mime, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.workspaceId, runId, mime, rendered, now);
    ctx.store.db
      .prepare('UPDATE saved_reports SET last_run_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, ctx.workspaceId, report.id);

    return ok({
      artifactRef: runId,
      rowCount,
      format,
      mime,
      transmitted: false,
      retained: retain,
      documentId,
      contentBase64: rendered.toString('base64'),
    });
  };
  return remember(ctx, input.idempotencyKey, 'reports_run', run);
}

// ------------------------------------------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------------------------------------------

/** Validate a definition's filters + columns against a source: the shared save/update pre-check. */
function validateDefinition(
  ctx: WorkspaceContext,
  source: ReportSourceDef,
  filtersRaw: unknown,
  columnsRaw: unknown,
): Result | undefined {
  const published = publishedColumns(ctx, source);
  const byKey = new Map(published.map((c) => [c.key, c]));
  const filters = validateFilters(filtersRaw, byKey);
  if (!filters.ok) return err('invalid_filter_field', { field: filters.field });
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) return err('columns_empty', {});
  for (const key of columnsRaw) {
    if (!byKey.has(String(key))) return err('invalid_filter_field', { field: String(key) });
  }
  return undefined;
}

function normaliseRecipients(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r)) return undefined;
    out.push(r);
  }
  return out;
}

function workspaceNameOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT name FROM workspace WHERE id = ?').get(ctx.workspaceId) as
    | { name: string }
    | undefined;
  return row?.name ?? ctx.workspaceId;
}

function summariseFilters(filters: unknown[]): string {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  return filters
    .map((f) => {
      const o = f as Record<string, unknown>;
      return `${String(o.field)} ${String(o.op)} ${String(o.value ?? '')}`.trim();
    })
    .join('; ');
}

function recall(ctx: WorkspaceContext, key: string | undefined, verb: string): Result | undefined {
  if (typeof key === 'string' && key.length > 0) {
    return ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, verb);
  }
  return undefined;
}

function remember(ctx: WorkspaceContext, key: string | undefined, verb: string, run: () => Result): Result {
  if (typeof key === 'string' && key.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, key, verb, run);
  }
  return ctx.store.tx(run);
}
