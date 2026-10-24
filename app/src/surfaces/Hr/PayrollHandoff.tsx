/**
 * A34, the `Lohn` tab on the Personal route: the payroll hand-off seam.
 *
 * Two cards and a history table. UEbergabe exports the employee master for an external payroll
 * provider (a LOCAL artifact, OP4: nothing transmits, which the copy states), with the AHV-inclusion
 * state shown as glyph + text (never colour alone). Lohnbuchung uploads the provider's wage file,
 * previews the ONE balanced entry, and posts it through A02 on confirm (P8). The engine is the real
 * gate (this surface only pre-hides the affordances an actor is about to be refused, the standing
 * Studio rule); `wage_journal_post` posts nothing without `confirm` and nothing without `post`.
 *
 * D171: a posting row whose journal stands offers Stornieren behind its one row overflow, destructive
 * and behind an alertdialog with the consequence line and a required reason (the D168 claim-reverse
 * shape). The engine decides; a refusal (already reversed, a bank line holding the entry, a locked
 * period) is said in words and the history reloads to show the real state.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCan } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { formatCalendar } from '../../lib/format';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, refusalText } from '../../components/states';
import { FileDrop } from '../../components/FileDrop';
import { Status } from '../../components/Status';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';

const newKey = () => crypto.randomUUID();
// The confirm's role, passed as a value the way LandedCosts does (the modal-role guard reads literals).
const ALERT_DIALOG = 'alertdialog' as const;

/** D173 (owner Q12): the run kinds of a wage journal, the engine's `WAGE_RUN_KINDS`. */
const RUN_KINDS = ['regular', 'bonus', 'thirteenth', 'correction'] as const;
type RunKind = (typeof RUN_KINDS)[number];

interface HandoffRow {
  type: 'export' | 'posting';
  id: string;
  createdAt: string;
  asOf?: string;
  mutationCount?: number;
  employeeCount?: number;
  ahvIncluded?: boolean;
  artifactDocumentId?: string;
  entryDate?: string;
  postedEntryId?: string;
  /** D171: the mirror that reversed this posting (derived by the engine from the ledger), or null. */
  reversalEntryId?: string | null;
  /** D173: the posting's run kind (legacy postings read 'regular'). */
  runKind?: string;
}

interface PreviewLine {
  accountNumber: string;
  debitMinor: number;
  creditMinor: number;
}
interface Preview {
  fileRef: string;
  entryDate: string;
  lines: PreviewLine[];
  totalDebitMinor: number;
  balanced: boolean;
  /** D173: the month whose wage journal already stands (from the engine's `warnings[]`), or null. */
  standingMonth: string | null;
}

/** D173: the month named by the engine's `month_already_posted` warning, if any. */
function warnedMonth(body: Record<string, unknown>): string | null {
  const list = body.warnings;
  if (!Array.isArray(list)) return null;
  const w = list.find((x) => typeof x === 'object' && x !== null && (x as Record<string, unknown>).code === 'month_already_posted') as
    | Record<string, unknown>
    | undefined;
  return w !== undefined && typeof w.month === 'string' ? w.month : null;
}

function rows(body: unknown): Record<string, unknown>[] {
  if (body === null || typeof body !== 'object') return [];
  const list = (body as Record<string, unknown>).handoffs;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** Read a file to base64 via FileReader (data-URL), which both the browser and jsdom implement. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function PayrollHandoff() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canManage = useCan('hr.manage');
  const canPost = useCan('post');

  const [history, setHistory] = useState<HandoffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [exportNote, setExportNote] = useState<{ ahvIncluded: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [entryDate, setEntryDate] = useState('');
  // D173 (owner Q8): a supplementary posting skips the month guard for this one call, with a reason.
  const [supplementary, setSupplementary] = useState(false);
  // D173 (owner Q12): the run kind, default regular; only a regular run meets the month guard.
  const [runKind, setRunKind] = useState<RunKind>('regular');
  // D173 (owner Q14): when a non-regular run needs a reason (`payroll.nonregular_reason`, read from the
  // registry; the engine's default `correction` until it answers). The engine is the real gate.
  const [reasonMode, setReasonMode] = useState<'none' | 'correction' | 'all'>('correction');
  const [runKindReason, setRunKindReason] = useState('');
  const reasonRequired = runKind !== 'regular' && (reasonMode === 'all' || (reasonMode === 'correction' && runKind === 'correction'));
  const [supplementaryReason, setSupplementaryReason] = useState('');
  const [postedWarnMonth, setPostedWarnMonth] = useState<string | null>(null);
  // D171: the posting a person is about to reverse, the reason they give, and what came of it.
  const [reversing, setReversing] = useState<HandoffRow | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState<Err | null>(null);
  const [reversedNote, setReversedNote] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) { setLoading(false); return; }
    setLoading(true);
    setFailed(false);
    const res = await client.call('list_payroll_handoffs', { workspaceId });
    if (isErr(res.body)) { setFailed(true); setLoading(false); return; }
    setHistory(
      rows(res.body).map((r) => ({
        type: r.type === 'posting' ? 'posting' : 'export',
        id: String(r.id),
        createdAt: String(r.createdAt ?? ''),
        asOf: typeof r.asOf === 'string' ? r.asOf : undefined,
        mutationCount: typeof r.mutationCount === 'number' ? r.mutationCount : undefined,
        employeeCount: typeof r.employeeCount === 'number' ? r.employeeCount : undefined,
        ahvIncluded: typeof r.ahvIncluded === 'boolean' ? r.ahvIncluded : undefined,
        artifactDocumentId: typeof r.artifactDocumentId === 'string' ? r.artifactDocumentId : undefined,
        entryDate: typeof r.entryDate === 'string' ? r.entryDate : undefined,
        postedEntryId: typeof r.postedEntryId === 'string' ? r.postedEntryId : undefined,
        reversalEntryId: typeof r.reversalEntryId === 'string' ? r.reversalEntryId : null,
        runKind: typeof r.runKind === 'string' ? r.runKind : undefined,
      })),
    );
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (workspaceId === null) return;
    void client.call('settings_get', { workspaceId, key: 'payroll.nonregular_reason' }).then((res) => {
      if (isErr(res.body)) return;
      const v = ((res.body as Record<string, unknown>).setting as Record<string, unknown> | undefined)?.value;
      if (v === 'none' || v === 'correction' || v === 'all') setReasonMode(v);
    });
  }, [client, workspaceId]);

  const doExport = useCallback(async () => {
    if (workspaceId === null) return;
    setError(null);
    setBusy(true);
    const res = await client.call('payroll_handoff_export', { workspaceId, format: 'json', idempotencyKey: newKey() });
    setBusy(false);
    if (isErr(res.body)) { setError(res.body); return; }
    setExportNote({ ahvIncluded: (res.body as Record<string, unknown>).ahvIncluded === true });
    await load();
  }, [client, workspaceId, load]);

  const onFile = useCallback(async (file: File | undefined) => {
    if (workspaceId === null || file === undefined) return;
    setError(null);
    setPreview(null);
    setPostedWarnMonth(null);
    setBusy(true);
    const up = await client.call('files_upload', {
      workspaceId,
      contentBase64: await fileToBase64(file),
      mime: 'text/csv',
      filename: file.name,
      title: file.name,
    });
    if (isErr(up.body)) { setBusy(false); setError(up.body); return; }
    const fileRef = String(((up.body as Record<string, unknown>).file as Record<string, unknown>).id);
    const date = entryDate === '' ? new Date().toISOString().slice(0, 10) : entryDate;
    const pv = await client.call('wage_journal_post', {
      workspaceId, fileRef, entryDate: date, runKind,
      // The engine refuses a preview without a required reason too, so the reason travels with it.
      ...(runKind !== 'regular' && runKindReason.trim() !== '' ? { runKindReason } : {}),
      idempotencyKey: newKey(),
    });
    setBusy(false);
    if (isErr(pv.body)) { setError(pv.body); return; }
    const body = pv.body as Record<string, unknown>;
    const p = body.preview as Record<string, unknown> | undefined;
    if (p === undefined) return;
    setPreview({
      fileRef,
      entryDate: date,
      totalDebitMinor: Number(p.totalDebitMinor ?? 0),
      balanced: p.balanced === true,
      standingMonth: warnedMonth(body),
      lines: (Array.isArray(p.lines) ? p.lines : []).map((l) => {
        const line = l as Record<string, unknown>;
        return { accountNumber: String(line.accountNumber ?? ''), debitMinor: Number(line.debitMinor ?? 0), creditMinor: Number(line.creditMinor ?? 0) };
      }),
    });
  }, [client, workspaceId, entryDate, runKind, runKindReason]);

  const post = useCallback(async () => {
    if (workspaceId === null || preview === null) return;
    setError(null);
    setBusy(true);
    const res = await client.call('wage_journal_post', {
      workspaceId,
      fileRef: preview.fileRef,
      entryDate: preview.entryDate,
      confirm: true,
      runKind,
      ...(runKind !== 'regular' && runKindReason.trim() !== '' ? { runKindReason } : {}),
      ...(supplementary ? { supplementary: true, supplementaryReason } : {}),
      idempotencyKey: newKey(),
    });
    setBusy(false);
    if (isErr(res.body)) { setError(res.body); return; }
    setPostedWarnMonth(warnedMonth(res.body as Record<string, unknown>));
    setPreview(null);
    setSupplementary(false);
    setSupplementaryReason('');
    setRunKind('regular');
    setRunKindReason('');
    await load();
  }, [client, workspaceId, preview, supplementary, supplementaryReason, runKind, runKindReason, load]);

  const confirmReverse = useCallback(async () => {
    if (workspaceId === null || reversing === null || reverseReason.trim() === '') return;
    const wageJournalPostId = reversing.id;
    const reason = reverseReason.trim();
    setReversing(null);
    setReverseError(null);
    setReversedNote(false);
    setBusy(true);
    const res = await client.call('wage_journal_reverse', { workspaceId, wageJournalPostId, reason, idempotencyKey: newKey() });
    setBusy(false);
    setReverseReason('');
    if (isErr(res.body)) setReverseError(res.body);
    else setReversedNote(true);
    await load();
  }, [client, workspaceId, reversing, reverseReason, load]);

  // K-21: a posting's one verb sits behind its row's overflow, destructive. Only a posting whose journal
  // stands, and only for someone who may post (the engine asserts `post`).
  // TODO(Ruhig 3, E-step): migrate this action to the icon vocabulary once IconButton lands.
  const rowActions = (r: HandoffRow) =>
    r.type === 'posting' && (r.reversalEntryId ?? null) === null
      ? [{ key: 'reverse', label: t('payroll.reverse.action'), danger: true, onSelect: () => { setReverseReason(''); setReversing(r); } }]
      : [];

  const lastExport = history.find((r) => r.type === 'export');

  const previewColumns: DataTableColumn<PreviewLine & { rowIndex: number }>[] = [
    { key: 'account', header: t('payroll.preview.account'), render: (l) => l.accountNumber },
    { key: 'debit', header: t('payroll.preview.debit'), numeric: true, render: (l) => (l.debitMinor / 100).toFixed(2) },
    { key: 'credit', header: t('payroll.preview.credit'), numeric: true, render: (l) => (l.creditMinor / 100).toFixed(2) },
  ];

  const historyColumns: DataTableColumn<HandoffRow>[] = [
    { key: 'type', header: t('payroll.history.type'), render: (r) => t(`payroll.history.kind.${r.type}`) },
    { key: 'date', header: t('payroll.history.date'), render: (r) => (r.createdAt === '' ? '' : formatCalendar(r.createdAt)) },
    {
      key: 'detail',
      header: t('payroll.history.detail'),
      render: (r) =>
        r.type === 'export' ? (
          <>
            {t('payroll.export.mutations', { count: String(r.mutationCount ?? 0) })}{' · '}
            <Status
              kind={r.ahvIncluded ? 'success' : 'inactive'}
              label={r.ahvIncluded ? t('payroll.export.withAhv') : t('payroll.export.noAhv')}
            />
          </>
        ) : (
          <>
            {t('payroll.history.posted', { entry: r.postedEntryId ?? '' })}
            {r.runKind !== undefined && r.runKind !== 'regular' && <>{' · '}{t(`payroll.runKind.${r.runKind}`)}</>}
            {(r.reversalEntryId ?? null) !== null && (
              <>
                {' · '}
                <Status kind="inactive" label={t('payroll.history.reversed')} />
              </>
            )}
          </>
        ),
    },
  ];

  return (
    <div className="hr-panel payroll">
      <p className="hr-hint payroll-oss">{t('payroll.oss.note')}</p>
      {error !== null && <ErrorBanner error={error} message={refusalText(t, error, { own: 'payroll.err' })} />}
      {reverseError !== null && <ErrorBanner error={reverseError} message={refusalText(t, reverseError, { own: 'payroll.reverse.err' })} />}
      {reversedNote && <p className="hr-hint" role="status">{t('payroll.reverse.done')}</p>}
      {/* Three steps, three panels on the elevated ground, separated by the step and the gap (K-09). */}

      <section className="payroll-card" aria-labelledby="payroll-export-h">
        <h2 id="payroll-export-h">{t('payroll.export.title')}</h2>
        {lastExport === undefined ? (
          <p>{t('payroll.export.first')}</p>
        ) : (
          <p>
            {t('payroll.export.mutations', { count: String(lastExport.mutationCount ?? 0) })}
            {' · '}
            <Status
              kind={lastExport.ahvIncluded ? 'success' : 'inactive'}
              label={lastExport.ahvIncluded ? t('payroll.export.withAhv') : t('payroll.export.noAhv')}
            />
          </p>
        )}
        {exportNote !== null && !exportNote.ahvIncluded && (
          <p className="payroll-restricted">
            <Status kind="inactive" label={t('payroll.export.noAhv')} />
          </p>
        )}
        <button
          type="button"
          className="btn btn--secondary payroll-action"
          disabled={!canManage || busy}
          onClick={() => void doExport()}
          title={canManage ? undefined : t('payroll.requiresManage')}
        >
          {t('payroll.export.cta')}
        </button>
      </section>

      <section className="payroll-card" aria-labelledby="payroll-import-h">
        <h2 id="payroll-import-h">{t('payroll.import.title')}</h2>
        <label className="payroll-field">
          <span>{t('payroll.import.date')}</span>
          <input className="field" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} aria-label={t('payroll.import.date')} />
        </label>
        <label className="payroll-field">
          <span>{t('payroll.runKind.label')}</span>
          <select
            className="field"
            value={runKind}
            onChange={(e) => { setRunKind(e.target.value as RunKind); setPreview(null); }}
            aria-label={t('payroll.runKind.label')}
          >
            {RUN_KINDS.map((k) => <option key={k} value={k}>{t(`payroll.runKind.${k}`)}</option>)}
          </select>
        </label>
        {runKind !== 'regular' && (
          <label className="payroll-field">
            <span>{t(reasonRequired ? 'payroll.runKind.reason' : 'payroll.runKind.reasonOptional')}</span>
            <input
              className="field"
              value={runKindReason}
              onChange={(e) => setRunKindReason(e.target.value)}
              aria-label={t(reasonRequired ? 'payroll.runKind.reason' : 'payroll.runKind.reasonOptional')}
            />
          </label>
        )}
        {/* The shared FileDrop (K-13): the real file input behind a labelled button, a CSV dropped on
            the zone filtered by the same accept list. */}
        <FileDrop
          accept=".csv,text/csv"
          label={t('payroll.import.cta')}
          disabled={busy || !canPost || (reasonRequired && runKindReason.trim() === '')}
          onFiles={(files) => void onFile(files[0])}
        />
        {!canPost && <p className="hr-hint">{t('payroll.requiresPost')}</p>}
        {postedWarnMonth !== null && (
          <p className="hr-hint" role="status">
            <Status kind="warn" label={t('payroll.import.postedWithWarning', { month: postedWarnMonth })} />
          </p>
        )}
        {preview !== null && (
          <div className="payroll-preview">
            {preview.standingMonth !== null && (
              <p className="hr-hint" role="status">
                <Status kind="warn" label={t('payroll.import.warnStanding', { month: preview.standingMonth })} />
              </p>
            )}
            <label className="payroll-field">
              <input type="checkbox" checked={supplementary} onChange={(e) => setSupplementary(e.target.checked)} />
              <span>{t('payroll.import.supplementary')}</span>
            </label>
            {supplementary && (
              <label className="payroll-field">
                <span>{t('payroll.import.supplementaryReason')}</span>
                <input
                  className="field"
                  value={supplementaryReason}
                  onChange={(e) => setSupplementaryReason(e.target.value)}
                  aria-label={t('payroll.import.supplementaryReason')}
                />
              </label>
            )}
            <DataTable
              columns={previewColumns}
              rows={preview.lines.map((l, i) => ({ ...l, rowIndex: i }))}
              rowKey={(l) => String(l.rowIndex)}
              caption={t('payroll.import.title')}
            />
            {/* The commit of a money write (the wage buchung): the one role of the tinted accent (K-08). */}
            <button
              type="button"
              className="btn btn--accent payroll-action"
              data-money-commit="wage_journal_post"
              disabled={!canPost || busy || !preview.balanced || (supplementary && supplementaryReason.trim() === '') || (reasonRequired && runKindReason.trim() === '')}
              onClick={() => void post()}
              title={canPost ? undefined : t('payroll.requiresPost')}
            >
              {t('payroll.import.post')}
            </button>
          </div>
        )}
      </section>

      <section className="payroll-card" aria-labelledby="payroll-history-h">
        <h2 id="payroll-history-h">{t('payroll.history.title')}</h2>
        {failed ? (
          <ErrorBanner context="read" message={t('payroll.err.load')} onRetry={() => void load()} />
        ) : (
          <DataTable
            columns={historyColumns}
            rows={history}
            rowKey={(r) => r.id}
            loading={loading}
            caption={t('payroll.history.title')}
            rowActions={canPost ? rowActions : undefined}
            rowActionsLabel={(r) => t('payroll.history.rowActions', { date: r.entryDate === undefined ? '' : formatCalendar(r.entryDate) })}
            skeletonRows={3}
            emptyState={<EmptyState title={t('payroll.history.empty')} />}
          />
        )}
      </section>

      <Modal
        open={reversing !== null}
        onClose={() => setReversing(null)}
        role={ALERT_DIALOG}
        title={t('payroll.reverse.title', { date: reversing?.entryDate === undefined ? '' : formatCalendar(reversing.entryDate) })}
        closeLabel={t('payroll.reverse.cancel')}
        describedById="payroll-reverse-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setReversing(null)}>
              {t('payroll.reverse.cancel')}
            </button>
            <button type="button" className="btn btn--danger" disabled={reverseReason.trim() === ''} onClick={() => void confirmReverse()}>
              {t('payroll.reverse.confirm')}
            </button>
          </>
        }
      >
        <div id="payroll-reverse-body">
          <p>{t('payroll.reverse.body')}</p>
          <ConsequenceLine verb="wage_journal_reverse" />
          <label className="payroll-field">
            <span>{t('payroll.reverse.reason')}</span>
            <input className="field" value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
          </label>
        </div>
      </Modal>
    </div>
  );
}

export default PayrollHandoff;
