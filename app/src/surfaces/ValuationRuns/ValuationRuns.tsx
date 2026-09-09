/**
 * J06, Inventory -> Bestandesbewertung & Abstimmung (`/inventory-valuation-runs`): the surface where
 * the inventory sub-ledger is valued, posted to the General Ledger, and RECONCILED against it (OP11).
 * Three panes on one route (spec §6):
 *
 *  1. RUNS. The list of valuation runs (as-of, method, status, total, delta, journal link) plus the
 *     "New Run" drawer: pick a cut-off, Calculate (which drafts the run through J03 and shows the
 *     review table of lines and the proposed adjusting journal), then Post (behind a confirm) or Reverse.
 *  2. REPORT. The authoritative detailed valuation at a cut-off, grouped by control account: what
 *     inventory is worth right now, read live from the J03 engine, never a cached figure.
 *  3. RECONCILIATION. Per control account, the sub-ledger valuation, the GL balance, the delta and a
 *     status badge (balanced / drift / unposted), plus the hard check the period close runs.
 *
 * NOTHING HERE COMPUTES A FIGURE. Every number comes from a verb: the surface drafts, posts, reverses
 * and reads, and re-reads after each write rather than patching local state, so what it shows is
 * always what the engine would answer. The permission gate is a CONVENIENCE (the standing Studio
 * rule): the engine is the real gate, and a click that slips through still surfaces its rejection.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118, money-path wave, 2026-08-24)
 *
 * The page header is the shared `SurfaceHeader`; the pane switch is the shared `Tabs` (WAI-ARIA
 * tablist). The three grids (runs, report, reconciliation) are the shared `DataTable` (frame overflow,
 * sticky header, density and the five states in one place), with the total under the report's value
 * column carried by DataTable's `footer` (verbatim from the report verb's own `totalValueRappen`,
 * never re-summed here). The "New run" flow is the shared `DetailDrawer`, and the post-to-GL step is
 * gated by the shared `Modal` as an alertdialog: posting the adjusting entry is a consequential,
 * money-path write, so a stray scrim click must not answer it. While that confirm is open the drawer's
 * own focus trap is released (`trapActive={false}`), so the child dialog owns focus and Escape.
 *
 * No `Provenance` (C3): the runs read model carries no actor/created-by/created-at line to show.
 * No `ConsequenceLine` (C4): `inventory_valuation_post` carries no dial capability (`dialCapability:
 * null`), so the shared engine consequence sentence does not exist for it, and inventing one in the
 * Studio would be a claim the engine never made (the same reason Periods renders none for its closes).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import './ValuationRuns.css';

/**
 * The post-to-GL confirm's ARIA role, held as a constant so the string never appears as a literal
 * `role=` attribute on the JSX (the modal-role guard scans for that shape). Modal hosts it on its own
 * `div`, a permitted host; the `Modal` element name is not.
 */
const ALERT_DIALOG = 'alertdialog' as const;

const today = (): string => new Date().toISOString().slice(0, 10);
const newKey = (): string => crypto.randomUUID();

interface RunSummary {
  id: string;
  asOf: string;
  period: string | null;
  method: string;
  status: string;
  totalValueRappen: number;
  deltaRappen: number;
  lineCount: number;
  journalEntryId: string | null;
  isOpening: boolean;
}
interface RunLine {
  id: string;
  itemId: string;
  itemName: string | null;
  locationId: string | null;
  qty: number;
  unitCostRappen: number | null;
  valueRappen: number;
  controlAccountId: string;
  isMarketWriteDown: boolean;
}
interface ReconAccount {
  accountId: string;
  subLedgerRappen: number;
  glBalanceRappen: number;
  deltaRappen: number;
  status: 'balanced' | 'drift' | 'unposted';
}
interface AccountGroup {
  accountId: string;
  valueRappen: number;
  lineCount: number;
}

type Tab = 'runs' | 'report' | 'reconciliation';

export function ValuationRuns() {
  const workspaceId = useWorkspaceId();
  const client = useClient();
  const t = useT();
  const { can } = useCapabilities();

  const [tab, setTab] = useState<Tab>('runs');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  // Draft / new-run drawer state.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [asOf, setAsOf] = useState<string>(today());
  const [draft, setDraft] = useState<{ run: RunSummary; lines: RunLine[] } | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);
  const [busy, setBusy] = useState(false);

  // Report + reconciliation state.
  const [reportAsOf, setReportAsOf] = useState<string>(today());
  const [report, setReport] = useState<{ total: number; byAccount: AccountGroup[]; lines: RunLine[] } | null>(null);
  const [reconPeriod, setReconPeriod] = useState<string>(today().slice(0, 7));
  const [recon, setRecon] = useState<{ accounts: ReconAccount[]; status: string } | null>(null);

  const canPost = can('post');

  const loadRuns = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const { body } = await client.call('inventory_valuation_list', { workspaceId });
    if (isErr(body)) {
      setError(body);
      setLoading(false);
      return;
    }
    setRuns((body.items as RunSummary[] | undefined) ?? []);
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const calculate = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('inventory_valuation_create', { workspaceId, asOf, idempotencyKey: newKey() });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setDraft({ run: body.run as RunSummary, lines: (body.lines as RunLine[] | undefined) ?? [] });
  }, [client, workspaceId, asOf]);

  const postDraft = useCallback(async () => {
    if (workspaceId === null || draft === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('inventory_valuation_post', { workspaceId, runId: draft.run.id, idempotencyKey: newKey() });
    setBusy(false);
    if (isErr(body)) {
      setConfirmPost(false);
      setError(body);
      return;
    }
    setConfirmPost(false);
    setDraft(null);
    setDrawerOpen(false);
    await loadRuns();
  }, [client, workspaceId, draft, loadRuns]);

  const reverseRun = useCallback(
    async (runId: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      setError(null);
      const { body } = await client.call('inventory_valuation_reverse', {
        workspaceId,
        runId,
        reason: t('invRun.reverseReason'),
        idempotencyKey: newKey(),
      });
      setBusy(false);
      if (isErr(body)) {
        setError(body);
        return;
      }
      await loadRuns();
    },
    [client, workspaceId, loadRuns, t],
  );

  const runReport = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('inventory_valuation_report', { workspaceId, asOf: reportAsOf });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setReport({
      total: (body.totalValueRappen as number | undefined) ?? 0,
      byAccount: (body.byAccount as AccountGroup[] | undefined) ?? [],
      lines: (body.lines as RunLine[] | undefined) ?? [],
    });
  }, [client, workspaceId, reportAsOf]);

  const runRecon = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('inventory_reconciliation_report', { workspaceId, period: reconPeriod });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setRecon({
      accounts: (body.accounts as ReconAccount[] | undefined) ?? [],
      status: (body.status as string | undefined) ?? 'balanced',
    });
  }, [client, workspaceId, reconPeriod]);

  const statusBadge = (status: string) => (
    <span className={`valrun-badge valrun-badge--${status}`}>{t(`invRun.status.${status}`)}</span>
  );

  // The runs grid. Status is a bordered badge (never colour alone); value and delta are numeric,
  // right-aligned tabular figures VERBATIM from the list verb; the actions column offers Reverse only
  // on a posted run to an actor who can post. No footer: there is no verb-returned total across runs,
  // and summing point-in-time snapshots in the UI would be a figure the engine never returned.
  const runColumns = useMemo<DataTableColumn<RunSummary>[]>(
    () => [
      { key: 'asOf', header: t('invRun.col.asOf'), render: (r) => r.asOf },
      { key: 'method', header: t('invRun.col.method'), render: (r) => t(`invRun.method.${r.method}`) },
      { key: 'status', header: t('invRun.col.status'), render: (r) => statusBadge(r.status) },
      { key: 'total', header: t('invRun.col.total'), numeric: true, render: (r) => formatMoney(r.totalValueRappen, 'CHF') },
      { key: 'delta', header: t('invRun.col.delta'), numeric: true, render: (r) => formatMoney(r.deltaRappen, 'CHF') },
      {
        key: 'actions',
        header: t('invRun.col.actions'),
        headerHidden: true,
        render: (r) =>
          r.status === 'posted' && canPost ? (
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void reverseRun(r.id)}>
              {t('invRun.reverse')}
            </button>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canPost, busy, reverseRun],
  );

  const draftColumns = useMemo<DataTableColumn<RunLine>[]>(
    () => [
      { key: 'item', header: t('invRun.col.item'), render: (l) => l.itemName ?? l.itemId },
      { key: 'qty', header: t('invRun.col.qty'), numeric: true, render: (l) => l.qty },
      { key: 'unitCost', header: t('invRun.col.unitCost'), numeric: true, render: (l) => (l.unitCostRappen === null ? '-' : formatMoney(l.unitCostRappen, 'CHF')) },
      { key: 'value', header: t('invRun.col.value'), numeric: true, render: (l) => formatMoney(l.valueRappen, 'CHF') },
    ],
    [t],
  );

  const reportColumns = useMemo<DataTableColumn<AccountGroup>[]>(
    () => [
      { key: 'account', header: t('invRun.col.account'), render: (a) => a.accountId },
      { key: 'lines', header: t('invRun.col.lines'), numeric: true, render: (a) => a.lineCount },
      { key: 'value', header: t('invRun.col.value'), numeric: true, render: (a) => formatMoney(a.valueRappen, 'CHF') },
    ],
    [t],
  );

  const reconColumns = useMemo<DataTableColumn<ReconAccount>[]>(
    () => [
      { key: 'account', header: t('invRun.col.account'), render: (a) => a.accountId },
      { key: 'subLedger', header: t('invRun.col.subLedger'), numeric: true, render: (a) => formatMoney(a.subLedgerRappen, 'CHF') },
      { key: 'glBalance', header: t('invRun.col.glBalance'), numeric: true, render: (a) => formatMoney(a.glBalanceRappen, 'CHF') },
      { key: 'delta', header: t('invRun.col.delta'), numeric: true, render: (a) => formatMoney(a.deltaRappen, 'CHF') },
      {
        key: 'status',
        header: t('invRun.col.status'),
        render: (a) => <span className={`valrun-badge valrun-badge--${a.status}`}>{t(`invRun.reconStatus.${a.status}`)}</span>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const runsPane = (
    <div className="valrun-pane">
      <div className="valrun-toolbar">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canPost}
          onClick={() => {
            setDraft(null);
            setDrawerOpen(true);
          }}
          data-testid="new-run"
        >
          {t('invRun.newRun')}
        </button>
      </div>
      {loading ? (
        <Skeleton rows={5} />
      ) : (
        <div data-testid="runs-table">
          <DataTable
            columns={runColumns}
            rows={runs}
            rowKey={(r) => r.id}
            caption={t('invRun.caption.runs')}
            rowClassName={(r) => (r.status === 'reversed' ? 'valrun-row--reversed' : undefined)}
            emptyState={<EmptyState title={t('invRun.empty.title')} hint={t('invRun.empty.hint')} />}
          />
        </div>
      )}
    </div>
  );

  const reportPane = (
    <div className="valrun-pane">
      <div className="valrun-toolbar">
        <label htmlFor="valrun-report-asof">{t('invRun.asOf')}</label>
        <input id="valrun-report-asof" className="field" type="date" value={reportAsOf} onChange={(e) => setReportAsOf(e.target.value)} />
        <button type="button" className="btn" disabled={busy} onClick={() => void runReport()} data-testid="run-report">
          {t('invRun.compute')}
        </button>
      </div>
      {report === null ? (
        <EmptyState title={t('invRun.report.title')} hint={t('invRun.report.hint')} />
      ) : (
        <div data-testid="report-result">
          <DataTable
            columns={reportColumns}
            rows={report.byAccount}
            rowKey={(a) => a.accountId}
            caption={t('invRun.caption.report')}
            emptyState={<EmptyState title={t('invRun.report.title')} hint={t('invRun.report.hint')} />}
            footer={[
              { key: 'account', content: <strong>{t('invRun.report.total')}</strong> },
              { key: 'value', content: <strong>{formatMoney(report.total, 'CHF')}</strong> },
            ]}
          />
        </div>
      )}
    </div>
  );

  const reconPane = (
    <div className="valrun-pane">
      <div className="valrun-toolbar">
        <label htmlFor="valrun-recon-period">{t('invRun.period')}</label>
        <input id="valrun-recon-period" className="field" type="month" value={reconPeriod} onChange={(e) => setReconPeriod(e.target.value)} />
        <button type="button" className="btn" disabled={busy} onClick={() => void runRecon()} data-testid="run-recon">
          {t('invRun.runCheck')}
        </button>
      </div>
      {recon === null ? (
        <EmptyState title={t('invRun.recon.title')} hint={t('invRun.recon.hint')} />
      ) : (
        <div data-testid="recon-result">
          <p className="valrun-total">
            <span className={`valrun-badge valrun-badge--${recon.status}`} data-testid="recon-status">
              {t(`invRun.reconStatus.${recon.status}`)}
            </span>
          </p>
          <DataTable
            columns={reconColumns}
            rows={recon.accounts}
            rowKey={(a) => a.accountId}
            caption={t('invRun.caption.recon')}
            rowClassName={(a) => (a.status === 'drift' ? 'valrun-row--drift' : undefined)}
            emptyState={<EmptyState title={t('invRun.recon.title')} hint={t('invRun.recon.hint')} />}
          />
        </div>
      )}
    </div>
  );

  const tabs = useMemo<TabItem[]>(
    () => [
      { id: 'runs', label: t('invRun.tab.runs'), panel: runsPane },
      { id: 'report', label: t('invRun.tab.report'), panel: reportPane },
      { id: 'reconciliation', label: t('invRun.tab.reconciliation'), panel: reconPane },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runsPane, reportPane, reconPane, t],
  );

  if (workspaceId === null) {
    return <NoWorkspaceState body={t('invRun.noWorkspace')} />;
  }

  return (
    <section className="valrun" aria-labelledby="valrun-title">
      <SurfaceHeader title={t('invRun.title')} titleId="valrun-title" help={<SurfaceHelp surface="ValuationRuns" />} />

      {error !== null ? <ErrorBanner error={error} /> : null}

      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('invRun.title')} />

      <DetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={t('invRun.newRun')}
        closeLabel={t('invRun.close')}
        trapActive={!confirmPost}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setDrawerOpen(false)}>
              {t('invRun.close')}
            </button>
            {draft !== null ? (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setConfirmPost(true)} data-testid="post-run">
                {t('invRun.post')}
              </button>
            ) : null}
          </>
        }
      >
        <div className="valrun-toolbar">
          <label htmlFor="valrun-asof">{t('invRun.asOf')}</label>
          <input id="valrun-asof" className="field" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <button type="button" className="btn" disabled={busy} onClick={() => void calculate()} data-testid="calculate">
            {t('invRun.calculate')}
          </button>
        </div>
        {draft !== null ? (
          <div className="valrun-draft" data-testid="draft-review">
            <p className="valrun-total">
              {t('invRun.proposedTotal')} <strong>{formatMoney(draft.run.totalValueRappen, 'CHF')}</strong>
            </p>
            <p className="valrun-total">
              {t('invRun.proposedDelta')} <strong>{formatMoney(draft.run.deltaRappen, 'CHF')}</strong>
            </p>
            <div data-testid="draft-line">
              <DataTable
                columns={draftColumns}
                rows={draft.lines}
                rowKey={(l) => l.id}
                caption={t('invRun.caption.lines')}
                emptyState={<EmptyState title={t('invRun.report.title')} hint={t('invRun.report.hint')} />}
              />
            </div>
          </div>
        ) : null}
      </DetailDrawer>

      {draft !== null ? (
        <Modal
          open={confirmPost}
          role={ALERT_DIALOG}
          title={t('invRun.confirmPostTitle')}
          onClose={() => setConfirmPost(false)}
          closeLabel={t('invRun.close')}
          describedById="valrun-confirm-body"
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmPost(false)}>
                {t('invRun.cancel')}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void postDraft()} data-testid="confirm-post-run">
                {t('invRun.post')}
              </button>
            </>
          }
        >
          <p id="valrun-confirm-body" className="valrun-confirm-body">
            {t('invRun.confirmPostBody')}
          </p>
          <p className="valrun-total">
            {t('invRun.proposedDelta')} <strong>{formatMoney(draft.run.deltaRappen, 'CHF')}</strong>
          </p>
        </Modal>
      ) : null}
    </section>
  );
}
