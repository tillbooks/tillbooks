/**
 * A34, the `Lohn` tab on the Personal route: the payroll hand-off seam.
 *
 * Two cards and a history table. UEbergabe exports the employee master for an external payroll
 * provider (a LOCAL artifact, OP4: nothing transmits, which the copy states), with the AHV-inclusion
 * state shown as glyph + text (never colour alone). Lohnbuchung uploads the provider's wage file,
 * previews the ONE balanced entry, and posts it through A02 on confirm (P8). The engine is the real
 * gate (this surface only pre-hides the affordances an actor is about to be refused, the standing
 * Studio rule); `wage_journal_post` posts nothing without `confirm` and nothing without `post`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCan } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner } from '../../components/states';

const newKey = () => crypto.randomUUID();

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
  const fileInput = useRef<HTMLInputElement>(null);

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
      })),
    );
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => { void load(); }, [load]);

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
    const pv = await client.call('wage_journal_post', { workspaceId, fileRef, entryDate: date, idempotencyKey: newKey() });
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
      lines: (Array.isArray(p.lines) ? p.lines : []).map((l) => {
        const line = l as Record<string, unknown>;
        return { accountNumber: String(line.accountNumber ?? ''), debitMinor: Number(line.debitMinor ?? 0), creditMinor: Number(line.creditMinor ?? 0) };
      }),
    });
  }, [client, workspaceId, entryDate]);

  const post = useCallback(async () => {
    if (workspaceId === null || preview === null) return;
    setError(null);
    setBusy(true);
    const res = await client.call('wage_journal_post', {
      workspaceId,
      fileRef: preview.fileRef,
      entryDate: preview.entryDate,
      confirm: true,
      idempotencyKey: newKey(),
    });
    setBusy(false);
    if (isErr(res.body)) { setError(res.body); return; }
    setPreview(null);
    if (fileInput.current !== null) fileInput.current.value = '';
    await load();
  }, [client, workspaceId, preview, load]);

  const lastExport = history.find((r) => r.type === 'export');

  const previewColumns: DataTableColumn<PreviewLine & { rowIndex: number }>[] = [
    { key: 'account', header: t('payroll.preview.account'), render: (l) => l.accountNumber },
    { key: 'debit', header: t('payroll.preview.debit'), numeric: true, render: (l) => (l.debitMinor / 100).toFixed(2) },
    { key: 'credit', header: t('payroll.preview.credit'), numeric: true, render: (l) => (l.creditMinor / 100).toFixed(2) },
  ];

  const historyColumns: DataTableColumn<HandoffRow>[] = [
    { key: 'type', header: t('payroll.history.type'), render: (r) => t(`payroll.history.kind.${r.type}`) },
    { key: 'date', header: t('payroll.history.date'), render: (r) => (r.createdAt === '' ? '' : formatDate(r.createdAt.slice(0, 10))) },
    {
      key: 'detail',
      header: t('payroll.history.detail'),
      render: (r) =>
        r.type === 'export' ? (
          <>
            {t('payroll.export.mutations', { count: String(r.mutationCount ?? 0) })}{' · '}
            <span className="hr-glyph" aria-hidden="true">{r.ahvIncluded ? '✓' : '⊘'}</span>{' '}
            {r.ahvIncluded ? t('payroll.export.withAhv') : t('payroll.export.noAhv')}
          </>
        ) : (
          t('payroll.history.posted', { entry: r.postedEntryId ?? '' })
        ),
    },
  ];

  return (
    <div role="tabpanel" className="hr-panel payroll">
      <p className="hr-hint payroll-oss">{t('payroll.oss.note')}</p>
      {error !== null && <ErrorBanner error={error} message={t(`payroll.err.${error.error}`)} />}

      <section className="payroll-card" aria-labelledby="payroll-export-h">
        <h2 id="payroll-export-h">{t('payroll.export.title')}</h2>
        {lastExport === undefined ? (
          <p>{t('payroll.export.first')}</p>
        ) : (
          <p>
            {t('payroll.export.mutations', { count: String(lastExport.mutationCount ?? 0) })}
            {' · '}
            <span className="hr-glyph" aria-hidden="true">{lastExport.ahvIncluded ? '✓' : '⊘'}</span>{' '}
            {lastExport.ahvIncluded ? t('payroll.export.withAhv') : t('payroll.export.noAhv')}
          </p>
        )}
        {exportNote !== null && !exportNote.ahvIncluded && (
          <p className="payroll-restricted"><span className="hr-glyph" aria-hidden="true">⊘</span> {t('payroll.export.noAhv')}</p>
        )}
        <button className="hr-cta" disabled={!canManage || busy} onClick={() => void doExport()} title={canManage ? undefined : t('payroll.requiresManage')}>
          {t('payroll.export.cta')}
        </button>
      </section>

      <section className="payroll-card" aria-labelledby="payroll-import-h">
        <h2 id="payroll-import-h">{t('payroll.import.title')}</h2>
        <label className="payroll-field">
          <span>{t('payroll.import.date')}</span>
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} aria-label={t('payroll.import.date')} />
        </label>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          aria-label={t('payroll.import.cta')}
          disabled={busy || !canPost}
          title={canPost ? undefined : t('payroll.requiresPost')}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {!canPost && <p className="hr-hint">{t('payroll.requiresPost')}</p>}
        {preview !== null && (
          <div className="payroll-preview">
            <DataTable
              columns={previewColumns}
              rows={preview.lines.map((l, i) => ({ ...l, rowIndex: i }))}
              rowKey={(l) => String(l.rowIndex)}
              caption={t('payroll.import.title')}
            />
            <button
              className="hr-cta"
              disabled={!canPost || busy || !preview.balanced}
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
          <ErrorBanner message={t('payroll.err.load')} onRetry={() => void load()} />
        ) : (
          <DataTable
            columns={historyColumns}
            rows={history}
            rowKey={(r) => r.id}
            loading={loading}
            caption={t('payroll.history.title')}
            skeletonRows={3}
            emptyState={<EmptyState title={t('payroll.history.empty')} />}
          />
        )}
      </section>
    </div>
  );
}

export default PayrollHandoff;
