/**
 * F01, Berichte (`/report-builder`): the human face over the report builder.
 *
 * The saved-report list plus a builder dialog over the REPORT_SOURCES read models. The five states
 * the spec's §6 names are each rendered: loading skeletons, empty ("Noch keine Berichte" + the create
 * CTA), inline field errors on the builder, the cloud-tier delivery label on the schedule editor, and
 * a run appending to history with a row count. Every status is the shared Status (glyph plus word), never colour alone.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE, NOT THE ENFORCEMENT (the standing Studio rule): the
 * engine gates every verb, and the surface hides the create/edit controls without `reports.write` and
 * disables run/download without `reports.run` rather than showing-then-rejecting. A denial on the list
 * read renders the shared padlock, never an empty list that looks like "no reports exist".
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2)
 *
 * The saved-report list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place); the page header and the create action are the shared `SurfaceHeader`; and both
 * dialogs (the builder and the schedule editor) are the shared `Modal`, which adds the focus trap,
 * Escape and scrim the hand-rolled panels lacked. The per-surface CSS that duplicated the list table,
 * the header row and the dialog chrome is gone; what remains is genuinely F01-specific: the source and
 * retention notes, the run-success line, the column checklist, the cloud-tier note and the live
 * preview table (a bespoke ten-row peek, not the surface's primary list). No `Provenance` (C3) or
 * `ConsequenceLine` (C4): a saved report carries no origin line and its verbs no consequence sentence.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useI18n, useT, type Locale } from '../../i18n';
import { CAP, useCan } from '../../lib/capabilities';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Modal } from '../../components/Modal';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import './ReportBuilder.css';

interface SourceColumn {
  key: string;
  labelI18n: { 'de-CH'?: string; en?: string };
  type: string;
  custom: boolean;
}
interface SourceDef {
  id: string;
  titleI18n: { 'de-CH'?: string; en?: string };
  entityKind: string | null;
  accountingRecord: boolean;
  module: string;
  available: boolean;
  columns: SourceColumn[];
}
interface SavedReport {
  id: string;
  name: string;
  source: string;
  filters: unknown[];
  columns: string[];
  format: string;
  schedule: string | null;
  recipients: string[];
  deliveryActive: boolean;
  lastRunAt: string | null;
}

// A server i18n object carries both locales; pick the one the active Studio locale asks for rather
// than always preferring de-CH, so an EN-locale user does not see German server-sourced labels.
const label = (i: { 'de-CH'?: string; en?: string }, fallback: string, locale: Locale): string =>
  locale === 'en' ? (i.en ?? i['de-CH'] ?? fallback) : (i['de-CH'] ?? i.en ?? fallback);

/** Format an integer Rappen value de-CH for the preview table (money is formatted once at the edge). */
function money(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const grouped = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${neg ? '-' : ''}${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

interface DraftState {
  editingId: string | null;
  name: string;
  source: string;
  columns: string[];
  format: string;
}

export function ReportBuilder() {
  const { t, locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canWrite = useCan(CAP.reportsWrite);
  const canRun = useCan(CAP.reportsRun);

  const [reports, setReports] = useState<SavedReport[]>([]);
  const [sources, setSources] = useState<SourceDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[] | null>(null);
  const [previewCols, setPreviewCols] = useState<SourceColumn[]>([]);
  const [previewCount, setPreviewCount] = useState(0);
  const [builderError, setBuilderError] = useState<Err | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ id: string; rowCount: number } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setDenied(false);
    setFailed(false);
    setError(null);
    const [listRes, sourcesRes] = await Promise.all([
      client.call('reports_list', { workspaceId }),
      client.call('reports_sources', { workspaceId }),
    ]);
    if ([listRes, sourcesRes].some((r) => isErr(r.body) && ((r.body as Err).error === 'permission_denied' || r.status === 403))) {
      setDenied(true);
      setLoading(false);
      return;
    }
    if (isErr(listRes.body) || isErr(sourcesRes.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setReports(((listRes.body as { reports?: SavedReport[] }).reports ?? []) as SavedReport[]);
    setSources(((sourcesRes.body as { sources?: SourceDef[] }).sources ?? []) as SourceDef[]);
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const reportById = useMemo(() => new Map(reports.map((r) => [r.id, r])), [reports]);

  const runPreview = useCallback(
    async (source: string, columns: string[]) => {
      if (workspaceId === null || columns.length === 0) {
        setPreviewRows(null);
        return;
      }
      const res = await client.call('reports_preview', { workspaceId, source, columns });
      if (isErr(res.body)) {
        setBuilderError(res.body as Err);
        setPreviewRows(null);
        return;
      }
      setBuilderError(null);
      const body = res.body as { rows?: Record<string, unknown>[]; columns?: SourceColumn[]; rowCount?: number };
      setPreviewRows(body.rows ?? []);
      setPreviewCols(body.columns ?? []);
      setPreviewCount(body.rowCount ?? 0);
    },
    [client, workspaceId],
  );

  const openBuilder = (report?: SavedReport) => {
    const def: DraftState = report
      ? { editingId: report.id, name: report.name, source: report.source, columns: [...report.columns], format: report.format }
      : { editingId: null, name: '', source: sources[0]?.id ?? '', columns: [], format: 'csv' };
    setDraft(def);
    setBuilderError(null);
    setPreviewRows(null);
    if (def.columns.length > 0) void runPreview(def.source, def.columns);
  };

  const toggleColumn = (key: string) => {
    if (draft === null) return;
    const has = draft.columns.includes(key);
    const columns = has ? draft.columns.filter((c) => c !== key) : [...draft.columns, key];
    setDraft({ ...draft, columns });
    void runPreview(draft.source, columns);
  };

  const changeSource = (source: string) => {
    if (draft === null) return;
    setDraft({ ...draft, source, columns: [] });
    setPreviewRows(null);
  };

  const save = async () => {
    if (draft === null || workspaceId === null) return;
    const key = `f01-${draft.editingId ?? 'new'}-${Date.now()}`;
    const res = draft.editingId
      ? await client.call('reports_update', {
          workspaceId,
          reportId: draft.editingId,
          patch: { name: draft.name, source: draft.source, columns: draft.columns, format: draft.format },
          idempotencyKey: key,
        })
      : await client.call('reports_save', {
          workspaceId,
          name: draft.name,
          source: draft.source,
          columns: draft.columns,
          format: draft.format,
          idempotencyKey: key,
        });
    if (isErr(res.body)) {
      setBuilderError(res.body as Err);
      return;
    }
    setDraft(null);
    await load();
  };

  const runReport = async (report: SavedReport) => {
    if (workspaceId === null) return;
    const res = await client.call('reports_run', { workspaceId, reportId: report.id, idempotencyKey: `f01-run-${report.id}-${Date.now()}` });
    if (isErr(res.body)) {
      setError(res.body as Err);
      return;
    }
    const body = res.body as { contentBase64?: string; mime?: string; rowCount?: number; artifactRef?: string };
    if (typeof body.contentBase64 === 'string') download(body.contentBase64, body.mime ?? 'text/csv', `${report.name}.${report.format}`);
    setLastRun({ id: report.id, rowCount: body.rowCount ?? 0 });
    await load();
  };

  const duplicate = async (report: SavedReport) => {
    if (workspaceId === null) return;
    const res = await client.call('reports_duplicate', { workspaceId, reportId: report.id, idempotencyKey: `f01-dup-${report.id}-${Date.now()}` });
    if (isErr(res.body)) {
      setError(res.body as Err);
      return;
    }
    await load();
  };

  const remove = async (reportId: string) => {
    if (workspaceId === null) return;
    const res = await client.call('reports_delete', { workspaceId, reportId, idempotencyKey: `f01-del-${reportId}-${Date.now()}` });
    setConfirmDelete(null);
    if (isErr(res.body)) {
      setError(res.body as Err);
      return;
    }
    await load();
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('reportBuilder.denied')} />;

  const scheduleReport = scheduleFor !== null ? reportById.get(scheduleFor) : undefined;

  // The list columns, text left. The source cell carries the retention note and, when the source is
  // missing here, a warn Status; the schedule cell reads in words and carries the run-success Status.
  // The row opens the editor; every other verb sits behind the row overflow (K-21).
  const columns: DataTableColumn<SavedReport>[] = [
    { key: 'name', header: t('reportBuilder.col.name'), render: (r) => r.name },
    {
      key: 'source',
      header: t('reportBuilder.col.source'),
      render: (r) => {
        const src = sourceById.get(r.source);
        const unavailable = src !== undefined && !src.available;
        return (
          <>
            {src ? label(src.titleI18n, r.source, locale) : r.source}
            {src?.accountingRecord && <span className="rb-note">{t('reportBuilder.retention.badge')}</span>}
            {unavailable && (
              <span className="rb-note">
                <Status kind="warn" label={t('reportBuilder.error.source_unavailable')} />
              </span>
            )}
          </>
        );
      },
    },
    { key: 'format', header: t('reportBuilder.col.format'), render: (r) => r.format.toUpperCase() },
    {
      key: 'schedule',
      header: t('reportBuilder.col.schedule'),
      render: (r) => (
        <>
          {/* The stored canonical string (`freq=weekly;at=08:00;weekday=3`) is the engine's form; the
              operator reads the cadence in words ("Wöchentlich, Mittwoch, 08:00"). */}
          {r.schedule ? (
            <>
              {scheduleLabel(r.schedule, t)}
              {r.recipients.length > 0 && <span className="rb-note">{t('reportBuilder.delivery.cloudShort')}</span>}
            </>
          ) : (
            '–'
          )}
          {lastRun?.id === r.id && (
            <span className="rb-note">
              <Status kind="success" label={t('reportBuilder.run.success', { count: String(lastRun.rowCount) })} />
            </span>
          )}
        </>
      ),
    },
  ];

  // K-21: run, schedule, edit, duplicate and delete sit behind ONE overflow per row, delete last and
  // danger. Running needs `reports.run` and an available source; the rest need `reports.write`.
  const rowActions = (r: SavedReport): OverflowMenuItem[] => {
    const src = sourceById.get(r.source);
    const unavailable = src !== undefined && !src.available;
    const items: OverflowMenuItem[] = [
      { key: 'run', label: t('reportBuilder.action.run'), disabled: !canRun || unavailable, onSelect: () => void runReport(r) },
    ];
    if (canWrite) {
      items.push(
        { key: 'schedule', label: t('reportBuilder.action.schedule'), onSelect: () => setScheduleFor(r.id) },
        { key: 'edit', label: t('reportBuilder.action.edit'), onSelect: () => openBuilder(r) },
        { key: 'duplicate', label: t('reportBuilder.action.duplicate'), onSelect: () => void duplicate(r) },
        { key: 'delete', label: t('reportBuilder.action.delete'), danger: true, onSelect: () => setConfirmDelete(r.id) },
      );
    }
    return items;
  };

  const deleteTarget = confirmDelete !== null ? reportById.get(confirmDelete) : undefined;

  return (
    <section className="reportbuilder" aria-labelledby="rb-title">
      <SurfaceHeader
        title={t('reportBuilder.route.title')}
        titleId="rb-title"
        help={<SurfaceHelp surface="ReportBuilder" />}
        actions={
          canWrite ? (
            <button type="button" className="btn btn--primary" onClick={() => openBuilder()}>
              {t('reportBuilder.action.create')}
            </button>
          ) : undefined
        }
      />

      {error !== null && <ErrorBanner error={error} onRetry={() => setError(null)} />}

      {failed ? (
        <ErrorBanner error={error ?? undefined} context="read" onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={reports}
          rowKey={(r) => r.id}
          caption={t('reportBuilder.route.title')}
          loading={loading}
          onRowClick={canWrite ? (r) => openBuilder(r) : undefined}
          rowLabel={(r) => `${t('reportBuilder.action.edit')}: ${r.name}`}
          rowActions={rowActions}
          rowActionsLabel={(r) => t('reportBuilder.rowActions', { name: r.name })}
          emptyState={
            <EmptyState
              title={t('reportBuilder.empty')}
              hint={t('reportBuilder.emptyHint')}
              action={canWrite ? { label: t('reportBuilder.action.create'), onClick: () => openBuilder() } : undefined}
            />
          }
        />
      )}

      {deleteTarget !== undefined && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title={t('reportBuilder.confirm.title', { name: deleteTarget.name })}
          closeLabel={t('reportBuilder.action.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setConfirmDelete(null)}>
                {t('reportBuilder.action.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void remove(deleteTarget.id)}>
                {t('reportBuilder.confirm.delete')}
              </button>
            </>
          }
        >
          <p className="rb-confirm-body">{t('reportBuilder.confirm.body')}</p>
        </Modal>
      )}

      {draft !== null && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.editingId !== null ? t('reportBuilder.builder.editTitle') : t('reportBuilder.builder.title')}
          closeLabel={t('reportBuilder.action.cancel')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setDraft(null)}>
                {t('reportBuilder.action.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={draft.columns.length === 0 || draft.name.trim().length === 0}
                onClick={() => void save()}
              >
                {t('reportBuilder.action.save')}
              </button>
            </>
          }
        >
          <div className="rb-form">
            <label className="rb-field">
              <span>{t('reportBuilder.field.name')}</span>
              <input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <div className="rb-field">
              <span>{t('reportBuilder.field.source')}</span>
              <Select
                value={draft.source}
                onChange={(val) => changeSource(val)}
                options={sources.map((s) => ({ value: s.id, label: label(s.titleI18n, s.id, locale) }))}
                ariaLabel={t('reportBuilder.field.source')}
              />
            </div>
            <div className="rb-field">
              <span>{t('reportBuilder.field.format')}</span>
              <Select
                value={draft.format}
                onChange={(val) => setDraft({ ...draft, format: val })}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'pdf', label: 'PDF' },
                ]}
                ariaLabel={t('reportBuilder.field.format')}
              />
            </div>

            <ColumnChecklist source={sourceById.get(draft.source)} selected={draft.columns} onToggle={toggleColumn} t={t} locale={locale} />

            {builderError !== null && (
              <p className="rb-error" role="alert">
                {builderError.error === 'invalid_filter_field'
                  ? t('reportBuilder.error.invalid_field')
                  : builderError.error === 'columns_empty'
                    ? t('reportBuilder.error.columns_empty')
                    : t('reportBuilder.error.generic')}
              </p>
            )}

            {previewRows !== null && (
              <div className="rb-preview" aria-live="polite">
                <p className="rb-preview-count">{t('reportBuilder.preview.count', { count: String(previewCount) })}</p>
                {previewRows.length === 0 ? (
                  <p>{t('reportBuilder.empty_result')}</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        {previewCols.map((c) => (
                          <th key={c.key}>{label(c.labelI18n, c.key, locale)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.slice(0, 10).map((row, i) => (
                        <tr key={i}>
                          {previewCols.map((c) => (
                            <td key={c.key} className={c.type === 'money' ? 't-money' : undefined}>
                              {c.type === 'money' && typeof row[c.key] === 'number' ? money(row[c.key] as number) : String(row[c.key] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {scheduleReport !== undefined && (
        <ScheduleEditor
          report={scheduleReport}
          onClose={() => setScheduleFor(null)}
          onSaved={() => {
            setScheduleFor(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** The column checklist: base columns first, cf: custom fields under a labelled "Zusätzliche Felder". */
function ColumnChecklist({
  source,
  selected,
  onToggle,
  t,
  locale,
}: {
  source: SourceDef | undefined;
  selected: string[];
  onToggle: (key: string) => void;
  t: (k: string, p?: Record<string, string>) => string;
  locale: Locale;
}) {
  if (source === undefined) return null;
  const base = source.columns.filter((c) => !c.custom);
  const custom = source.columns.filter((c) => c.custom);
  return (
    <fieldset className="rb-columns">
      <legend>{t('reportBuilder.field.columns')}</legend>
      {base.map((c) => (
        <label key={c.key}>
          <input type="checkbox" checked={selected.includes(c.key)} onChange={() => onToggle(c.key)} />
          {label(c.labelI18n, c.key, locale)}
        </label>
      ))}
      {custom.length > 0 && (
        <>
          <p className="rb-columns-group">{t('reportBuilder.field.additional')}</p>
          {custom.map((c) => (
            <label key={c.key}>
              <input type="checkbox" checked={selected.includes(c.key)} onChange={() => onToggle(c.key)} />
              {label(c.labelI18n, c.key, locale)}
            </label>
          ))}
        </>
      )}
    </fieldset>
  );
}

/** Monday first, the Swiss week; the values stay the engine's 0..6 (Sunday is 0). */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** A stored schedule in words: "Täglich, 08:00", "Wöchentlich, Mittwoch, 08:00", "Monatlich, am 1., 08:00". */
function scheduleLabel(schedule: string, t: (k: string, p?: Record<string, string>) => string): string {
  const parsed = parseStoredSchedule(schedule);
  return t(`reportBuilder.scheduleLabel.${parsed.freq}`, {
    at: parsed.at,
    weekday: t(`reportBuilder.weekday.${parsed.weekday}`),
    day: String(parsed.dayOfMonth),
  });
}

/** The defaults used for a report that has no schedule, or one whose stored string will not parse. */
const SCHEDULE_DEFAULTS: { freq: 'daily' | 'weekly' | 'monthly'; at: string; weekday: number; dayOfMonth: number } = {
  freq: 'monthly',
  at: '08:00',
  weekday: 1,
  dayOfMonth: 1,
};

/**
 * Parse the canonical `saved_reports.schedule` string (`freq=weekly;at=08:00;weekday=1`, the form
 * `src/core/reportbuilder/cron.ts` writes) back into editor state, so opening the schedule editor
 * reflects the cadence in force rather than resetting it to the monthly default. Anything that does
 * not parse falls back to the defaults, so a malformed or absent string cannot crash the editor.
 */
function parseStoredSchedule(schedule: string | null): { freq: 'daily' | 'weekly' | 'monthly'; at: string; weekday: number; dayOfMonth: number } {
  if (schedule === null || schedule === '') return { ...SCHEDULE_DEFAULTS };
  const parts = new Map<string, string>();
  for (const seg of schedule.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts.set(seg.slice(0, eq), seg.slice(eq + 1));
  }
  const freqRaw = parts.get('freq');
  const freq = freqRaw === 'daily' || freqRaw === 'weekly' || freqRaw === 'monthly' ? freqRaw : SCHEDULE_DEFAULTS.freq;
  const at = parts.get('at') ?? SCHEDULE_DEFAULTS.at;
  const weekdayNum = Number(parts.get('weekday'));
  const dayNum = Number(parts.get('dayOfMonth'));
  return {
    freq,
    at,
    weekday: parts.has('weekday') && Number.isFinite(weekdayNum) ? weekdayNum : SCHEDULE_DEFAULTS.weekday,
    dayOfMonth: parts.has('dayOfMonth') && Number.isFinite(dayNum) ? dayNum : SCHEDULE_DEFAULTS.dayOfMonth,
  };
}

/** The schedule editor: the cron subset the engine accepts, plus the honest cloud-tier delivery note. */
function ScheduleEditor({ report, onClose, onSaved }: { report: SavedReport; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const initial = parseStoredSchedule(report.schedule);
  const [freq, setFreq] = useState<'daily' | 'weekly' | 'monthly'>(initial.freq);
  const [at, setAt] = useState(initial.at);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [dayOfMonth, setDayOfMonth] = useState(initial.dayOfMonth);
  const [recipients, setRecipients] = useState(report.recipients.join(', '));
  const [err, setErr] = useState<Err | null>(null);

  const submit = async (clear: boolean) => {
    if (workspaceId === null) return;
    const schedule = clear
      ? null
      : { freq, at, ...(freq === 'weekly' ? { weekday } : {}), ...(freq === 'monthly' ? { dayOfMonth } : {}) };
    const recips = recipients
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await client.call('reports_schedule', {
      workspaceId,
      reportId: report.id,
      schedule,
      recipients: recips,
      idempotencyKey: `f01-sch-${report.id}-${Date.now()}`,
    });
    if (isErr(res.body)) {
      setErr(res.body as Err);
      return;
    }
    onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('reportBuilder.action.schedule')}
      closeLabel={t('reportBuilder.action.cancel')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('reportBuilder.action.cancel')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void submit(true)}>
            {t('reportBuilder.action.clear_schedule')}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit(false)}>
            {t('reportBuilder.action.save')}
          </button>
        </>
      }
    >
      <div className="rb-form">
        <Select
          value={freq}
          onChange={(val) => setFreq(val as 'daily' | 'weekly' | 'monthly')}
          options={[
            { value: 'daily', label: t('reportBuilder.freq.daily') },
            { value: 'weekly', label: t('reportBuilder.freq.weekly') },
            { value: 'monthly', label: t('reportBuilder.freq.monthly') },
          ]}
          ariaLabel={t('reportBuilder.field.frequency')}
        />
        <input className="field" type="time" value={at} onChange={(e) => setAt(e.target.value)} aria-label={t('reportBuilder.field.time')} />
        {/* The weekday by name (0 is Sunday, the engine's cron.ts), never a bare 0 to 6 number field. */}
        {freq === 'weekly' && (
          <Select
            value={String(weekday)}
            onChange={(val) => setWeekday(Number(val))}
            options={WEEKDAY_ORDER.map((d) => ({ value: String(d), label: t(`reportBuilder.weekday.${d}`) }))}
            ariaLabel={t('reportBuilder.field.weekday')}
          />
        )}
        {freq === 'monthly' && (
          <input className="field" type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} aria-label={t('reportBuilder.field.dayOfMonth')} />
        )}
        <input className="field" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder={t('reportBuilder.field.recipients')} aria-label={t('reportBuilder.field.recipients')} />
        <p className="rb-cloud">{t('reportBuilder.delivery.cloud_tier')}</p>
        {err !== null && (
          <p className="rb-error" role="alert">
            {err.error === 'invalid_schedule' ? t('reportBuilder.error.invalid_schedule') : t('reportBuilder.error.generic')}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Turn a base64 artifact into a browser download (the CreditorPayments/Dunning pattern). */
function download(base64: string, mime: string, filename: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default ReportBuilder;
