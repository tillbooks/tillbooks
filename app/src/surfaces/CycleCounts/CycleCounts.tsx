/**
 * J04, Inventory -> Cycle Counts / Inventur (`/cycle-counts`): the surface over the cycle-count /
 * stocktake sessions. The left pane lists sessions (type badge, status, freeze date, progress); the
 * right pane opens a session for count entry and variance review. A "New count" drawer opens a full
 * Inventur or a cycle count, freezing a J02 balance snapshot. Counting writes through
 * `inventory_stocktake_count`; approving and committing go through the matching verbs. On commit every
 * non-zero variance becomes an immutable OP13 / J02 movement (never a direct quantity write), so
 * on-hand stays the SUM over the ledger.
 *
 * Status and variance are shown as glyph + label, never colour alone (WCAG 2.2 AA); no new colour
 * token (design-canon). A blind session hides the book column until the session reaches review.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The variance line grid is the shared `DataTable` (frame overflow, sticky header, density and the
 * five states in one place); the book, counted and variance columns are numeric, right-aligned `.t-num`
 * cells, and the book/variance pair is dropped from the column set while a blind session is still open.
 * The page header and the primary "New count" action are the shared `SurfaceHeader`, and the create
 * overlay is the shared `DetailDrawer`, which adds the focus trap, Escape and scrim the bespoke
 * dialog-role panel lacked. The per-surface CSS that duplicated the header, the line table chrome and
 * the button set is gone; what stays is genuinely CycleCounts-specific: the master split and the session
 * picker list, the status badges, the per-session action bar, the review/committed banners, the
 * variance +/- colouring and the create form fields.
 *
 * No `Provenance` (C3): the report read model carries no created-by/created-at line to show. No
 * `ConsequenceLine` (C4): the stocktake verbs carry no engine consequence sentence to render.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and the
 * engine is the real gate. Write controls disable behind `manage_master_data`; a click that slips
 * through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './CycleCounts.css';

const SESSION_TYPES = ['full', 'cycle'] as const;
type SessionType = (typeof SESSION_TYPES)[number];

// The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
// component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
const ALERT_DIALOG = 'alertdialog' as const;

/** Which governed write a confirm dialog is fronting: the statutory commit, or the discard cancel. */
type PendingWrite = 'commit' | 'cancel';

/** The J04 rejection codes with a surface-scoped message. Others fall through to the global mapping. */
const J04_ERROR_CODES = new Set([
  'stocktake_not_open',
  'uncounted_or_unapproved_lines',
  'already_committed',
  'period_locked',
  'insufficient_stock',
]);

const newKey = (): string => crypto.randomUUID();

interface SessionSummary {
  id: string;
  type: string;
  status: string;
  freezeAt: string;
  blindCount: boolean;
  progressPct: number;
  totalLines: number;
  countedLines: number;
  reviewRequiredLines: number;
}

interface Line {
  id: string;
  itemId: string;
  itemName: string | null;
  locationId: string;
  locationName: string | null;
  bookQty: number | null;
  countedQty: number | null;
  varianceQty: number | null;
  status: string;
}

interface Detail {
  session: SessionSummary & { inventarDocumentId: string | null; notes: string | null };
  lines: Line[];
  totals?: { over: number; under: number; absVariance: number; exceedingThreshold: number };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function parseSession(raw: unknown): SessionSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    type: String(r.type ?? 'full'),
    status: String(r.status ?? 'open'),
    freezeAt: String(r.freezeAt ?? ''),
    blindCount: r.blindCount === true,
    progressPct: num(r.progressPct),
    totalLines: num(r.totalLines),
    countedLines: num(r.countedLines),
    reviewRequiredLines: num(r.reviewRequiredLines),
  };
}

function parseLine(raw: unknown): Line | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    itemId: String(r.itemId ?? ''),
    itemName: typeof r.itemName === 'string' ? r.itemName : null,
    locationId: String(r.locationId ?? ''),
    locationName: typeof r.locationName === 'string' ? r.locationName : null,
    bookQty: typeof r.bookQty === 'number' ? r.bookQty : null,
    countedQty: typeof r.countedQty === 'number' ? r.countedQty : null,
    varianceQty: typeof r.varianceQty === 'number' ? r.varianceQty : null,
    status: String(r.status ?? 'pending'),
  };
}

interface CreateDraft {
  type: SessionType;
  freezeAt: string;
  blindCount: boolean;
  varianceQtyThreshold: string;
  variancePctThreshold: string;
  notes: string;
}
const emptyCreate = (): CreateDraft => ({
  type: 'full',
  freezeAt: new Date().toISOString().slice(0, 10),
  blindCount: false,
  varianceQtyThreshold: '0',
  variancePctThreshold: '0',
  notes: '',
});

export function CycleCounts() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [createDrawer, setCreateDrawer] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(emptyCreate);
  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  // The synchronous human confirm the top two approval tiers require (DESIGN C4): the commit fronts a
  // statutory Inventar filing plus permanent inventory movements, and the cancel discards an open
  // session. Neither write fires until the operator confirms in this dialog.
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);

  const localError = useCallback(
    (e: Err | null): string | undefined =>
      e !== null && J04_ERROR_CODES.has(e.error) ? t(`cycleCounts.errors.${e.error}`) : undefined,
    [t],
  );

  const loadList = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const res = await client.call('inventory_stocktake_list', { workspaceId });
    if (isErr(res.body)) {
      if (res.body.error === 'permission_denied' || res.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const rows = (res.body as { sessions?: unknown }).sessions;
    const parsed = Array.isArray(rows) ? rows.map(parseSession).filter((s): s is SessionSummary => s !== null) : [];
    setSessions(parsed);
    setSelectedId((prev) => (prev !== null && parsed.some((s) => s.id === prev) ? prev : (parsed[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      setDetailLoading(true);
      const res = await client.call('inventory_stocktake_report', { workspaceId, sessionId: id });
      if (isErr(res.body)) {
        setDetail(null);
        setDetailLoading(false);
        return;
      }
      const body = res.body as Record<string, unknown>;
      const session = parseSession(body.session);
      const lines = Array.isArray(body.lines) ? body.lines.map(parseLine).filter((l): l is Line => l !== null) : [];
      const totals = body.totals as Detail['totals'];
      if (session !== null) {
        const sRaw = body.session as Record<string, unknown>;
        setDetail({
          session: { ...session, inventarDocumentId: (sRaw.inventarDocumentId as string) ?? null, notes: (sRaw.notes as string) ?? null },
          lines,
          totals,
        });
        setCountInputs({});
      }
      setDetailLoading(false);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId !== null) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  const submitCreate = useCallback(async () => {
    if (workspaceId === null) return;
    setWriteError(null);
    const res = await client.call('inventory_stocktake_create', {
      workspaceId,
      type: createDraft.type,
      freezeAt: createDraft.freezeAt,
      blindCount: createDraft.blindCount,
      varianceQtyThreshold: Number.parseInt(createDraft.varianceQtyThreshold || '0', 10),
      variancePctThreshold: Number.parseInt(createDraft.variancePctThreshold || '0', 10),
      notes: createDraft.notes.trim() === '' ? undefined : createDraft.notes.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    setCreateDrawer(false);
    setCreateDraft(emptyCreate());
    const id = (res.body as { session?: { id?: string } }).session?.id ?? null;
    await loadList();
    if (id !== null) setSelectedId(id);
  }, [client, workspaceId, createDraft, loadList]);

  const saveCount = useCallback(
    async (line: Line) => {
      if (workspaceId === null || detail === null) return;
      setWriteError(null);
      const raw = countInputs[line.id];
      const n = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(n) || n < 0) {
        setWriteError({ error: 'invalid_input' } as Err);
        return;
      }
      const res = await client.call('inventory_stocktake_count', {
        workspaceId,
        sessionId: detail.session.id,
        lines: [{ itemId: line.itemId, locationId: line.locationId, countedQty: n }],
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setWriteError(res.body);
        return;
      }
      await refresh();
    },
    [client, workspaceId, detail, countInputs, refresh],
  );

  const approveAll = useCallback(async () => {
    if (workspaceId === null || detail === null) return;
    setWriteError(null);
    const res = await client.call('inventory_stocktake_approve_lines', {
      workspaceId,
      sessionId: detail.session.id,
      lineIds: 'all_review_required',
      idempotencyKey: newKey(),
    });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    await refresh();
  }, [client, workspaceId, detail, refresh]);

  const requestRecount = useCallback(
    async (line: Line) => {
      if (workspaceId === null || detail === null) return;
      setWriteError(null);
      const res = await client.call('inventory_stocktake_request_recount', {
        workspaceId,
        sessionId: detail.session.id,
        lineIds: [line.id],
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setWriteError(res.body);
        return;
      }
      await refresh();
    },
    [client, workspaceId, detail, refresh],
  );

  const commit = useCallback(async () => {
    if (workspaceId === null || detail === null) return;
    setWriteError(null);
    const res = await client.call('inventory_stocktake_commit', { workspaceId, sessionId: detail.session.id, idempotencyKey: newKey() });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    await refresh();
  }, [client, workspaceId, detail, refresh]);

  const cancel = useCallback(async () => {
    if (workspaceId === null || detail === null) return;
    setWriteError(null);
    const res = await client.call('inventory_stocktake_cancel', { workspaceId, sessionId: detail.session.id, idempotencyKey: newKey() });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    await refresh();
  }, [client, workspaceId, detail, refresh]);

  // Run the write the confirm dialog was fronting, then close the dialog. The write leaves the
  // surface ONLY from here, never from the button's first click.
  const confirmPending = useCallback(async () => {
    const write = pendingWrite;
    setPendingWrite(null);
    if (write === 'commit') await commit();
    else if (write === 'cancel') await cancel();
  }, [pendingWrite, commit, cancel]);

  // The ONE consequence sentence for the commit confirm (C4). No stocktake verb carries an engine
  // `dialCapability`, so ConsequenceLine renders nothing; the honest consequence is the pending
  // variance summary this surface already computes. A full count also files the statutory Inventar.
  const commitConsequence = useMemo(() => {
    if (detail === null) return '';
    const n = detail.lines.filter((l) => l.varianceQty !== null && l.varianceQty !== 0).length;
    const key = detail.session.type === 'full' ? 'cycleCounts.confirm.commitConsequenceFull' : 'cycleCounts.confirm.commitConsequenceCycle';
    return t(key, { n });
  }, [detail, t]);

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);
  const isOpenLike = detail !== null && (detail.session.status === 'open' || detail.session.status === 'review');
  const hideBook = detail !== null && detail.session.blindCount && detail.session.status === 'open';

  // The variance line grid, built from the current session detail. Book, counted and variance are
  // numeric (right-aligned tabular figures); the book/variance pair drops out of the column set while
  // a blind session is still open, so a blind counter never sees the frozen figure.
  const lineColumns = useMemo<DataTableColumn<Line>[]>(() => {
    const showBook = !hideBook;
    const cols: DataTableColumn<Line>[] = [
      { key: 'item', header: t('cycleCounts.col.item'), render: (l) => l.itemName ?? l.itemId },
      { key: 'location', header: t('cycleCounts.col.location'), render: (l) => l.locationName ?? l.locationId },
    ];
    if (showBook) {
      cols.push({ key: 'book', header: t('cycleCounts.col.book'), numeric: true, render: (l) => l.bookQty ?? '-' });
    }
    cols.push({
      key: 'counted',
      header: t('cycleCounts.col.counted'),
      numeric: true,
      render: (l) =>
        isOpenLike ? (
          <input
            className="field cc-count-input"
            type="number"
            min="0"
            aria-label={t('cycleCounts.col.counted')}
            value={countInputs[l.id] ?? (l.countedQty !== null ? String(l.countedQty) : '')}
            onChange={(e) => setCountInputs((prev) => ({ ...prev, [l.id]: e.target.value }))}
          />
        ) : (
          (l.countedQty ?? '-')
        ),
    });
    if (showBook) {
      cols.push({
        key: 'variance',
        header: t('cycleCounts.col.variance'),
        numeric: true,
        render: (l) => (
          <span className={l.varianceQty !== null && l.varianceQty < 0 ? 'cc-neg' : l.varianceQty !== null && l.varianceQty > 0 ? 'cc-pos' : undefined}>
            {l.varianceQty === null ? '-' : l.varianceQty > 0 ? `+${l.varianceQty}` : l.varianceQty}
          </span>
        ),
      });
    }
    cols.push({
      key: 'status',
      header: t('cycleCounts.col.status'),
      render: (l) => <span className={`cc-badge cc-badge-line-${l.status}`}>{t(`cycleCounts.lineStatus.${l.status}`)}</span>,
    });
    if (isOpenLike) {
      cols.push({
        key: 'actions',
        header: t('cycleCounts.col.actions'),
        render: (l) => (
          <span className="cc-row-actions">
            <button type="button" className="btn btn--sm" disabled={!canWrite} onClick={() => void saveCount(l)}>
              {t('cycleCounts.saveCount')}
            </button>
            {l.countedQty !== null && (
              <button type="button" className="btn btn--sm btn--ghost" disabled={!canWrite} onClick={() => void requestRecount(l)}>
                {t('cycleCounts.recount')}
              </button>
            )}
          </span>
        ),
      });
    }
    return cols;
  }, [t, hideBook, isOpenLike, countInputs, canWrite, saveCount, requestRecount]);

  if (workspaceId === null) return <NoWorkspaceState body={t('cycleCounts.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('cycleCounts.title')} />;

  return (
    <div className="cc">
      <SurfaceHeader
        title={t('cycleCounts.title')}
        help={<SurfaceHelp surface="CycleCounts" />}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canWrite}
            onClick={() => {
              setWriteError(null);
              setCreateDraft(emptyCreate());
              setCreateDrawer(true);
            }}
          >
            {t('cycleCounts.new')}
          </button>
        }
      />

      {failed && <ErrorBanner message={t('cycleCounts.error.transport')} onRetry={() => void loadList()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : sessions.length === 0 ? (
        <EmptyState title={t('cycleCounts.empty.title')} hint={t('cycleCounts.empty.hint')} />
      ) : (
        <div className="cc-split">
          <section className="cc-pane" aria-label={t('cycleCounts.listLabel')}>
            <ul className="cc-list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`cc-list-item ${s.id === selectedId ? 'cc-list-item-selected' : ''}`}
                    onClick={() => setSelectedId(s.id)}
                    aria-pressed={s.id === selectedId}
                  >
                    <span className="cc-li-main">
                      <span className={`cc-badge cc-badge-${s.status}`}>{t(`cycleCounts.status.${s.status}`)}</span>
                      <span className="cc-li-type">{t(`cycleCounts.type.${s.type}`)}</span>
                    </span>
                    <span className="cc-li-sub">
                      {s.freezeAt} · {s.progressPct}% · {t('cycleCounts.lineCount', { n: s.totalLines })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="cc-pane cc-detail" aria-label={t('cycleCounts.detailLabel')}>
            {selected === null || detail === null ? (
              <p className="cc-muted">{t('cycleCounts.selectHint')}</p>
            ) : (
              <>
                <div className="cc-detail-head">
                  <div>
                    <h2 className="cc-detail-title">
                      {t(`cycleCounts.type.${detail.session.type}`)} · <span className={`cc-badge cc-badge-${detail.session.status}`}>{t(`cycleCounts.status.${detail.session.status}`)}</span>
                    </h2>
                    <p className="cc-muted">
                      {t('cycleCounts.freeze')}: {detail.session.freezeAt} · {t('cycleCounts.progress')}: {detail.session.progressPct}%
                    </p>
                  </div>
                  <div className="cc-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={!canWrite || !isOpenLike || detail.session.reviewRequiredLines === 0}
                      onClick={() => void approveAll()}
                    >
                      {t('cycleCounts.approveAll')}
                    </button>
                    <button type="button" className="btn btn--primary" disabled={!canWrite || !isOpenLike} onClick={() => setPendingWrite('commit')}>
                      {t('cycleCounts.commit')}
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={!canWrite || !isOpenLike} onClick={() => setPendingWrite('cancel')}>
                      {t('cycleCounts.cancel')}
                    </button>
                  </div>
                </div>

                {detail.session.reviewRequiredLines > 0 && (
                  <ActionFeedback
                    tone="info"
                    message={t('cycleCounts.reviewBanner', { n: detail.session.reviewRequiredLines })}
                  />
                )}
                {detail.session.status === 'committed' && (
                  <ActionFeedback
                    tone="success"
                    message={
                      t('cycleCounts.committedBanner') +
                      (detail.session.inventarDocumentId !== null ? ` · ${t('cycleCounts.inventarFiled')}` : '')
                    }
                  />
                )}

                {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}

                <DataTable
                  columns={lineColumns}
                  rows={detail.lines}
                  rowKey={(l) => l.id}
                  caption={t('cycleCounts.detailLabel')}
                  loading={detailLoading}
                  skeletonRows={3}
                  emptyState={<p className="cc-muted">{t('cycleCounts.noLines')}</p>}
                />
              </>
            )}
          </section>
        </div>
      )}

      <DetailDrawer
        open={createDrawer}
        onClose={() => setCreateDrawer(false)}
        title={t('cycleCounts.form.title')}
        closeLabel={t('cycleCounts.close')}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setCreateDrawer(false)}>
              {t('cycleCounts.close')}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submitCreate()} disabled={!canWrite}>
              {t('cycleCounts.create')}
            </button>
          </>
        }
      >
        {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
        <div className="cc-field">
          <label htmlFor="cc-type">{t('cycleCounts.form.type')}</label>
          <select id="cc-type" className="field" value={createDraft.type} onChange={(e) => setCreateDraft({ ...createDraft, type: e.target.value as SessionType })}>
            {SESSION_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`cycleCounts.type.${ty}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="cc-field">
          <label htmlFor="cc-freeze">{t('cycleCounts.form.freeze')}</label>
          <input id="cc-freeze" className="field" type="date" value={createDraft.freezeAt} onChange={(e) => setCreateDraft({ ...createDraft, freezeAt: e.target.value })} />
        </div>
        <label className="cc-check">
          <input type="checkbox" checked={createDraft.blindCount} onChange={(e) => setCreateDraft({ ...createDraft, blindCount: e.target.checked })} />
          <span>{t('cycleCounts.form.blind')}</span>
        </label>
        <div className="cc-field">
          <label htmlFor="cc-qt">{t('cycleCounts.form.qtyThreshold')}</label>
          <input id="cc-qt" className="field" type="number" min="0" value={createDraft.varianceQtyThreshold} onChange={(e) => setCreateDraft({ ...createDraft, varianceQtyThreshold: e.target.value })} />
        </div>
        <div className="cc-field">
          <label htmlFor="cc-pt">{t('cycleCounts.form.pctThreshold')}</label>
          <input id="cc-pt" className="field" type="number" min="0" value={createDraft.variancePctThreshold} onChange={(e) => setCreateDraft({ ...createDraft, variancePctThreshold: e.target.value })} />
        </div>
        <div className="cc-field">
          <label htmlFor="cc-notes">{t('cycleCounts.form.notes')}</label>
          <input id="cc-notes" className="field" value={createDraft.notes} onChange={(e) => setCreateDraft({ ...createDraft, notes: e.target.value })} />
        </div>
      </DetailDrawer>

      <Modal
        open={pendingWrite !== null}
        onClose={() => setPendingWrite(null)}
        role={ALERT_DIALOG}
        title={pendingWrite === 'cancel' ? t('cycleCounts.confirm.cancelTitle') : t('cycleCounts.confirm.commitTitle')}
        closeLabel={t('cycleCounts.close')}
        describedById="cc-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setPendingWrite(null)}>
              {t('cycleCounts.confirm.back')}
            </button>
            <button
              type="button"
              className={pendingWrite === 'cancel' ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={() => void confirmPending()}
            >
              {pendingWrite === 'cancel' ? t('cycleCounts.cancel') : t('cycleCounts.commit')}
            </button>
          </>
        }
      >
        <div id="cc-confirm-body">
          <p className="cc-consequence">
            {pendingWrite === 'cancel' ? t('cycleCounts.confirm.cancelConsequence') : commitConsequence}
          </p>
          {/* C4 seam: the shared consequence line. It renders nothing while the stocktake verbs carry a
              null dialCapability, and lights up automatically if the engine ever adds one. The computed
              variance summary above is the operative consequence today. */}
          {pendingWrite === 'commit' && <ConsequenceLine verb="inventory_stocktake_commit" />}
        </div>
      </Modal>
    </div>
  );
}
