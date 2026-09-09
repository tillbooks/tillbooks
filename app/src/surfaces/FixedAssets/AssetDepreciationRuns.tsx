/**
 * H04, Fixed Assets -> Depreciation Runs (`/depreciation-runs`): the controlled period-end process
 * that POSTS depreciation. Unlike the H03 Depreciation screen (which only previews), this surface
 * creates a DRAFT run for a period, shows the proposed per-asset expense for review, POSTS it once as a
 * balanced GL journal, and REVERSES a posted run when a material error is found.
 *
 * The numbers come straight from the engine (asset_depreciation_run_create returns the calculated
 * lines), so the review table can never disagree with what the post will book. Amounts are Rappen
 * formatted to CHF exactly as the register does. Status is glyph + text + a weight/border badge, never
 * colour alone (WCAG 2.2 AA, DESIGN.md: one accent). No new colour token.
 *
 * Every write carries a fresh idempotency key, so a double click never double-posts (the engine is the
 * real guard: a re-post of a posted run returns the same result and books nothing further).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT, useTStrict } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import './FixedAssets.css';

const newKey = () => crypto.randomUUID();

/** Posting a run and reversing one are consequential money-path questions: the role travels to the
 * shared Modal as a prop, never as a literal attribute the modal-role guard would read on a component. */
const ALERT_DIALOG = 'alertdialog' as const;
/** The engine verb the H04 post books through. C4 ConsequenceLine resolves its dial sentence from this;
 * the verb currently carries NO dialCapability in command-source, so ConsequenceLine renders nothing
 * (a NEEDS-ENGINE-DATA gap): when the engine dials the verb, the sentence appears with no UI change. */
const POST_VERB = 'asset_depreciation_run_post';
// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied once, in one
// place. A depreciation run posts in the workspace base currency and carries no per-row currency, so
// the base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface RunSummary {
  id: string;
  period: string;
  status: string;
  totalAmountRappen: number;
  assetCount: number;
  postedAt: string | null;
  journalEntryId: string | null;
}

interface RunLine {
  id: string;
  assetId: string;
  assetNumber: string | null;
  amountRappen: number;
  accumulatedBeforeRappen: number;
  accumulatedAfterRappen: number;
  nbvAfterRappen: number;
  isFinal: boolean;
  /** The production figure behind a units_of_production amount; null for every other method. */
  unitsProduced: number | null;
}

/** An eligible asset that produced no line, and the engine's reason. Shown, never swallowed: an asset
 * that drops out of a period-end run is exactly the thing a bookkeeper must not discover in April. */
interface SkippedAsset {
  assetId: string;
  assetNumber: string;
  reason: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function parseRuns(body: unknown): RunSummary[] {
  const rows = (body as { runs?: unknown })?.runs;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: str(r.id),
      period: str(r.period),
      status: str(r.status) || 'draft',
      totalAmountRappen: num(r.totalAmountRappen),
      assetCount: num(r.assetCount),
      postedAt: typeof r.postedAt === 'string' ? r.postedAt : null,
      journalEntryId: typeof r.journalEntryId === 'string' ? r.journalEntryId : null,
    }))
    .filter((r) => r.id !== '');
}

function parseLines(body: unknown): RunLine[] {
  const rows = (body as { lines?: unknown })?.lines;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: str(r.id),
      assetId: str(r.assetId),
      assetNumber: typeof r.assetNumber === 'string' ? r.assetNumber : null,
      amountRappen: num(r.amountRappen),
      accumulatedBeforeRappen: num(r.accumulatedBeforeRappen),
      accumulatedAfterRappen: num(r.accumulatedAfterRappen),
      nbvAfterRappen: num(r.nbvAfterRappen),
      isFinal: r.isFinal === true,
      unitsProduced: typeof r.unitsProduced === 'number' ? r.unitsProduced : null,
    }));
}

function parseSkipped(body: unknown): SkippedAsset[] {
  const rows = (body as { skipped?: unknown })?.skipped;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ assetId: str(r.assetId), assetNumber: str(r.assetNumber), reason: str(r.reason) }))
    .filter((r) => r.assetId !== '');
}

export function AssetDepreciationRuns() {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canPost = can(CAP.post);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [period, setPeriod] = useState(currentPeriod());
  const [draft, setDraft] = useState<{
    /** Null when the period had nothing to charge: no run header is persisted in that case. */
    run: RunSummary | null;
    lines: RunLine[];
    empty: boolean;
    skipped: SkippedAsset[];
    /** Set when the period is empty because a posted run already charged it. */
    alreadyPostedRunId: string | null;
  } | null>(null);
  // Production figures the operator types for the units-tracked assets a calculation reported as
  // missing them. Kept as raw strings so a half-typed field is not silently read as a number.
  const [units, setUnits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<{ run: RunSummary; lines: RunLine[] } | null>(null);
  const [actionError, setActionError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  // A reversal is a money-path correction, so it asks WHY before it runs. The reason travels to the
  // engine and is recorded on the reversing entry and the compensating movement.
  const [reversing, setReversing] = useState<RunSummary | null>(null);
  const [reason, setReason] = useState('');
  // The run awaiting the synchronous post confirmation (H04 posts a balanced journal). A post is a
  // consequential money-path write, so the Post buttons open this alertdialog rather than firing.
  const [posting, setPosting] = useState<RunSummary | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const listed = await client.call('asset_depreciation_run_list', { workspaceId });
    if (isErr(listed.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setRuns(parseRuns(listed.body));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const calculate = useCallback(
    async (unitsByAsset?: Record<string, number>) => {
      if (workspaceId === null || !PERIOD_RE.test(period)) return;
      setActionError(null);
      setSelected(null);
      setBusy(true);
      const res = await client.call('asset_depreciation_run_create', {
        workspaceId,
        period,
        ...(unitsByAsset !== undefined && Object.keys(unitsByAsset).length > 0 ? { unitsByAsset } : {}),
        idempotencyKey: newKey(),
      });
      setBusy(false);
      if (isErr(res.body)) {
        setActionError(res.body);
        setDraft(null);
        return;
      }
      const body = res.body as { run?: unknown; lines?: unknown; empty?: unknown; alreadyPostedRunId?: unknown };
      // A run with nothing to charge persists NO header, so `run` is null and there is no id to show.
      // The panel still opens: the reason a period produced nothing is the answer the operator came
      // for, and dropping it here is how a period-end question goes unanswered.
      const parsed = parseRuns({ runs: [body.run] });
      setDraft({
        run: parsed[0] ?? null,
        lines: parseLines(body),
        empty: body.empty === true,
        skipped: parseSkipped(body),
        alreadyPostedRunId: typeof body.alreadyPostedRunId === 'string' ? body.alreadyPostedRunId : null,
      });
      await load();
    },
    [client, workspaceId, period, load],
  );

  /** Recalculate the period with the production figures just typed. Only whole, non-negative numbers
   * are sent: a blank or half-typed field is left out rather than guessed at. */
  const recalculateWithUnits = useCallback(() => {
    const map: Record<string, number> = {};
    for (const [assetId, raw] of Object.entries(units)) {
      const value = Number(raw.trim());
      if (raw.trim() !== '' && Number.isInteger(value) && value >= 0) map[assetId] = value;
    }
    void calculate(map);
  }, [units, calculate]);

  /** The assets a calculation reported as missing their production figure. */
  const needUnits = useMemo(
    () => draft?.skipped.filter((s) => s.reason === 'missing_production_data') ?? [],
    [draft],
  );

  const post = useCallback(
    async (runId: string) => {
      if (workspaceId === null) return;
      setActionError(null);
      setBusy(true);
      const res = await client.call('asset_depreciation_run_post', { workspaceId, runId, idempotencyKey: newKey() });
      setBusy(false);
      if (isErr(res.body)) {
        setActionError(res.body);
        return;
      }
      setDraft(null);
      setSelected(null);
      setPosting(null);
      await load();
    },
    [client, workspaceId, load],
  );

  const reverse = useCallback(
    async (runId: string, why: string) => {
      if (workspaceId === null) return;
      setActionError(null);
      setBusy(true);
      const trimmed = why.trim();
      const res = await client.call('asset_depreciation_run_reverse', {
        workspaceId,
        runId,
        ...(trimmed.length > 0 ? { reason: trimmed } : {}),
        idempotencyKey: newKey(),
      });
      setBusy(false);
      if (isErr(res.body)) {
        setActionError(res.body);
        return;
      }
      setReversing(null);
      setReason('');
      setSelected(null);
      await load();
    },
    [client, workspaceId, load],
  );

  const openDetail = useCallback(
    async (runId: string) => {
      if (workspaceId === null) return;
      setActionError(null);
      const res = await client.call('asset_depreciation_run_get', { workspaceId, runId });
      if (isErr(res.body)) {
        setActionError(res.body);
        return;
      }
      const body = res.body as { run?: unknown; lines?: unknown };
      const parsed = parseRuns({ runs: [body.run] });
      if (parsed[0]) setSelected({ run: parsed[0], lines: parseLines(body) });
    },
    [client, workspaceId],
  );

  const badge = (status: string) => (
    <span className={`fa-badge fa-badge-${status}`}>
      {t(`assets.depreciationRun.status.${status}`)}
    </span>
  );

  // Every figure renders VERBATIM from the engine's run/line read models (asset_depreciation_run_*);
  // nothing (amount, accumulated, NBV, total) is recomputed in the UI, that math is the engine's.
  // The footer total is the run header's totalAmountRappen, not a client-side reduce over the lines:
  // the engine sets that header field to the exact sum of the line amounts, so the value is identical
  // and no money is summed in the browser (money-path invariant: no client-side reduce/sum over money).
  const draftColumns: DataTableColumn<RunLine>[] = [
    { key: 'asset', header: t('assets.depreciationRun.col.asset'), render: (l) => <span className="fa-code">{l.assetNumber ?? l.assetId}</span> },
    { key: 'amount', header: t('assets.depreciationRun.col.amount'), numeric: true, render: (l) => money(l.amountRappen) },
    { key: 'accumBefore', header: t('assets.depreciationRun.col.accumBefore'), numeric: true, render: (l) => money(l.accumulatedBeforeRappen) },
    { key: 'accumAfter', header: t('assets.depreciationRun.col.accumAfter'), numeric: true, render: (l) => money(l.accumulatedAfterRappen) },
    { key: 'nbvAfter', header: t('assets.depreciationRun.col.nbvAfter'), numeric: true, render: (l) => money(l.nbvAfterRappen) },
    { key: 'units', header: t('assets.depreciationRun.col.units'), numeric: true, render: (l) => (l.unitsProduced === null ? '' : l.unitsProduced) },
    { key: 'final', header: t('assets.depreciationRun.col.final'), render: (l) => (l.isFinal ? t('assets.depreciationRun.yes') : '') },
  ];

  const skippedColumns: DataTableColumn<SkippedAsset>[] = [
    { key: 'asset', header: t('assets.depreciationRun.col.asset'), render: (s) => <span className="fa-code">{s.assetNumber || s.assetId}</span> },
    // The reason key is assembled from engine data, so tStrict: an untranslated reason must be loud
    // in dev, never a dot-path leaking into the table.
    { key: 'reason', header: t('assets.depreciationRun.col.reason'), render: (s) => tStrict(`assets.depreciationRun.skipped.reason.${s.reason}`) },
    {
      key: 'units',
      header: t('assets.depreciationRun.col.units'),
      numeric: true,
      render: (s) =>
        s.reason === 'missing_production_data' ? (
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label={`${t('assets.depreciationRun.unitsFor')} ${s.assetNumber || s.assetId}`}
            value={units[s.assetId] ?? ''}
            onChange={(e) => setUnits((prev) => ({ ...prev, [s.assetId]: e.target.value }))}
          />
        ) : (
          ''
        ),
    },
  ];

  const historyColumns: DataTableColumn<RunSummary>[] = [
    { key: 'period', header: t('assets.depreciationRun.col.period'), render: (r) => <span className="fa-code">{r.period}</span> },
    { key: 'status', header: t('assets.depreciationRun.col.status'), render: (r) => badge(r.status) },
    { key: 'assetCount', header: t('assets.depreciationRun.col.assetCount'), numeric: true, render: (r) => r.assetCount },
    { key: 'total', header: t('assets.depreciationRun.col.total'), numeric: true, render: (r) => money(r.totalAmountRappen) },
    {
      key: 'actions',
      header: t('assets.depreciationRun.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (r) => (
        <div className="fa-row-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openDetail(r.id)}>
            {t('assets.depreciationRun.view')}
          </button>
          {r.status === 'draft' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPosting(r)}
              disabled={!canPost || busy}
            >
              {t('assets.depreciationRun.post')}
            </button>
          )}
          {r.status === 'posted' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setActionError(null);
                setReason('');
                setReversing(r);
              }}
              disabled={!canPost || busy}
            >
              {t('assets.depreciationRun.reverse')}
            </button>
          )}
        </div>
      ),
    },
  ];

  const detailColumns: DataTableColumn<RunLine>[] = [
    { key: 'asset', header: t('assets.depreciationRun.col.asset'), render: (l) => <span className="fa-code">{l.assetNumber ?? l.assetId}</span> },
    { key: 'amount', header: t('assets.depreciationRun.col.amount'), numeric: true, render: (l) => money(l.amountRappen) },
    { key: 'accumAfter', header: t('assets.depreciationRun.col.accumAfter'), numeric: true, render: (l) => money(l.accumulatedAfterRappen) },
    { key: 'nbvAfter', header: t('assets.depreciationRun.col.nbvAfter'), numeric: true, render: (l) => money(l.nbvAfterRappen) },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.depreciationRun.noWorkspace')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.depreciationRun.title')}
        subtitle={t('assets.depreciationRun.subtitle')}
        help={<SurfaceHelp surface="FixedAssets" />}
      />

      {failed && <ErrorBanner message={t('assets.depreciationRun.error.transport')} onRetry={() => void load()} />}
      {actionError && <ErrorBanner error={actionError} />}

      <section className="fa-filters" aria-label={t('assets.depreciationRun.new')}>
        <label className="fa-field-inline">
          <span>{t('assets.depreciationRun.period')}</span>
          <input
            type="month"
            aria-label={t('assets.depreciationRun.period')}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void calculate()}
          disabled={!canPost || busy || !PERIOD_RE.test(period)}
        >
          {t('assets.depreciationRun.calculate')}
        </button>
      </section>

      {draft !== null && (
        <section className="fa-summary" aria-label={t('assets.depreciationRun.review')}>
          <h2 className="fa-drawer-subtitle">
            {t('assets.depreciationRun.review')} {draft.run?.period ?? period} {draft.run !== null && badge(draft.run.status)}
          </h2>
          {draft.empty || draft.run === null || draft.lines.length === 0 ? (
            <p className="fa-hint">
              {draft.alreadyPostedRunId === null
                ? t('assets.depreciationRun.emptyDraft')
                : t('assets.depreciationRun.alreadyPosted')}
            </p>
          ) : (
            <>
              <DataTable
                columns={draftColumns}
                rows={draft.lines}
                rowKey={(l) => l.id}
                footer={[
                  { key: 'asset', content: <strong>{t('assets.depreciationRun.total')}</strong> },
                  { key: 'amount', content: <strong>{money(draft.run.totalAmountRappen)}</strong> },
                ]}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => draft.run !== null && setPosting(draft.run)}
                disabled={!canPost || busy || draft.run === null}
              >
                {t('assets.depreciationRun.post')}
              </button>
            </>
          )}

          {draft.skipped.length > 0 && (
            <>
              <h3 className="fa-drawer-subtitle">{t('assets.depreciationRun.skipped.title')}</h3>
              <p className="fa-hint">{t('assets.depreciationRun.skipped.hint')}</p>
              <DataTable
                columns={skippedColumns}
                rows={draft.skipped}
                rowKey={(s) => s.assetId}
              />
              {needUnits.length > 0 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => recalculateWithUnits()}
                  disabled={!canPost || busy}
                >
                  {t('assets.depreciationRun.recalculateWithUnits')}
                </button>
              )}
            </>
          )}
        </section>
      )}

      <h2 className="fa-drawer-subtitle">{t('assets.depreciationRun.history')}</h2>
      <DataTable
        columns={historyColumns}
        rows={runs}
        rowKey={(r) => r.id}
        loading={loading}
        emptyState={<EmptyState title={t('assets.depreciationRun.empty.title')} hint={t('assets.depreciationRun.empty.hint')} />}
      />

      {selected !== null && (
        <section className="fa-summary" aria-label={t('assets.depreciationRun.detail')}>
          <h2 className="fa-drawer-subtitle">
            {t('assets.depreciationRun.detail')} {selected.run.period} {badge(selected.run.status)}
          </h2>
          <DataTable columns={detailColumns} rows={selected.lines} rowKey={(l) => l.id} caption={t('assets.depreciationRun.detail')} />
        </section>
      )}

      {/* H04 posts a balanced GL journal, a consequential money-path write, so the Post buttons open
          this alertdialog rather than firing. A stray scrim click cannot answer it (Modal). */}
      <Modal
        open={posting !== null}
        role={ALERT_DIALOG}
        onClose={() => setPosting(null)}
        title={t('assets.depreciationRun.postConfirmTitle')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setPosting(null)} disabled={busy}>
              {t('assets.depreciationRun.postCancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => posting !== null && void post(posting.id)}
              disabled={!canPost || busy}
            >
              {t('assets.depreciationRun.postConfirm')}
            </button>
          </>
        }
      >
        {posting !== null && (
          <p>
            {t('assets.depreciationRun.postConfirmBody', {
              count: String(posting.assetCount),
              total: (posting.totalAmountRappen / 100).toFixed(2),
            })}
          </p>
        )}
        {/* C4: the shared consequence sentence for the post verb. It renders nothing today, the verb
            carries no dial capability in command-source (NEEDS-ENGINE-DATA); dialing it lights this up. */}
        <ConsequenceLine verb={POST_VERB} />
      </Modal>

      {/* A reversal is a money-path correction, so it asks WHY first, in an alertdialog. */}
      <Modal
        open={reversing !== null}
        role={ALERT_DIALOG}
        onClose={() => {
          setReversing(null);
          setReason('');
        }}
        title={reversing === null ? '' : `${t('assets.depreciationRun.reverseTitle')} ${reversing.period}`}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setReversing(null);
                setReason('');
              }}
              disabled={busy}
            >
              {t('assets.depreciationRun.reverseCancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => reversing !== null && void reverse(reversing.id, reason)}
              disabled={!canPost || busy}
            >
              {t('assets.depreciationRun.reverseConfirm')}
            </button>
          </>
        }
      >
        <p className="fa-hint">{t('assets.depreciationRun.reverseHint')}</p>
        <div className="fa-field">
          <label htmlFor="fa-adrun-reverse-reason">{t('assets.depreciationRun.reverseReason')}</label>
          <input
            id="fa-adrun-reverse-reason"
            type="text"
            aria-label={t('assets.depreciationRun.reverseReason')}
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}

export default AssetDepreciationRuns;
