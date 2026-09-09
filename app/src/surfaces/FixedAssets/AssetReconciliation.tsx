/**
 * H07, Fixed Assets -> Reconciliation (`/asset-reconciliation`): the OP11 proof that the fixed-asset
 * sub-ledger equals the General-Ledger control accounts, to the Rappen (US-H07.2 / US-H07.3).
 *
 * A period / as-of selector drives an `asset_reconciliation_report`; the result is summary cards
 * (balanced vs drift account counts) and a dense table of control accounts (number, name, role,
 * sub-ledger total, GL balance, delta, status). Any account expands to its contributing assets
 * (drill-down). A "Run check" button calls the hard `asset_reconciliation_check` for the selected
 * period, surfacing the same balanced / drift answer period-close will see.
 *
 * Drift is a destructive status (glyph + label + the danger token, never colour alone: WCAG 2.2 AA),
 * and no new colour token is minted (design-canon: reuses --t-accent / --t-danger). This is a pure
 * read surface: it posts nothing. `whoami` gates the view as a convenience and fails open; the engine
 * is the real gate (the standing Studio rule).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import './FixedAssets.css';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied once, in one
// place. Sub-ledger and GL balances here are the workspace base currency and carry no per-row
// currency, so the base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');

interface ReconAsset {
  assetId: string;
  assetNumber: string;
  name: string;
  amountRappen: number;
}

interface ReconAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  role: 'cost' | 'accumulated_depreciation';
  subLedgerRappen: number;
  glBalanceRappen: number;
  deltaRappen: number;
  status: 'balanced' | 'drift';
  assets: ReconAsset[];
}

interface Report {
  cutOff: string;
  period: string | null;
  accounts: ReconAccount[];
  summary: { accountCount: number; balancedCount: number; driftCount: number; status: 'balanced' | 'drift' };
}

function parseAssets(rows: unknown): ReconAsset[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      assetId: String(r.assetId ?? ''),
      assetNumber: String(r.assetNumber ?? ''),
      name: String(r.name ?? ''),
      amountRappen: num(r.amountRappen),
    }));
}

function parseReport(body: unknown): Report | null {
  const o = body as Record<string, unknown>;
  if (o === null || typeof o !== 'object') return null;
  const rawAccounts = Array.isArray(o.accounts) ? o.accounts : [];
  const accounts: ReconAccount[] = rawAccounts
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      accountId: String(r.accountId ?? ''),
      accountNumber: String(r.accountNumber ?? ''),
      accountName: String(r.accountName ?? ''),
      role: r.role === 'accumulated_depreciation' ? 'accumulated_depreciation' : 'cost',
      subLedgerRappen: num(r.subLedgerRappen),
      glBalanceRappen: num(r.glBalanceRappen),
      deltaRappen: num(r.deltaRappen),
      status: r.status === 'drift' ? 'drift' : 'balanced',
      assets: parseAssets(r.assets),
    }));
  const summary = (o.summary ?? {}) as Record<string, unknown>;
  return {
    cutOff: String(o.cutOff ?? ''),
    period: typeof o.period === 'string' ? o.period : null,
    accounts,
    summary: {
      accountCount: num(summary.accountCount),
      balancedCount: num(summary.balancedCount),
      driftCount: num(summary.driftCount),
      status: summary.status === 'drift' ? 'drift' : 'balanced',
    },
  };
}

/** Today's period `YYYY-MM`, the selector's default (the recon most often asked is "as at this month"). */
const thisPeriod = (): string => new Date().toISOString().slice(0, 7);

type CheckState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'balanced'; period: string }
  | { kind: 'drift'; period: string; accounts: number };

export function AssetReconciliation() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [period, setPeriod] = useState(thisPeriod());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setCheck({ kind: 'idle' });
    const res = await client.call('asset_reconciliation_report', { workspaceId, period });
    if (isErr(res.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseReport(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setReport(parsed);
    setLoading(false);
  }, [client, workspaceId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const runCheck = useCallback(async () => {
    if (workspaceId === null) return;
    setCheck({ kind: 'running' });
    const res = await client.call('asset_reconciliation_check', { workspaceId, period });
    if (isErr(res.body)) {
      // The hard check returns the structured reconciliation_drift error on any non-zero delta.
      const raw = (res.body as unknown as { accounts?: unknown }).accounts;
      const accounts = Array.isArray(raw) ? raw.length : 0;
      setCheck({ kind: 'drift', period, accounts });
      return;
    }
    setCheck({ kind: 'balanced', period });
  }, [client, workspaceId, period]);

  const accounts = report?.accounts ?? [];

  const roleLabel = useMemo(
    () => (role: ReconAccount['role']) =>
      role === 'cost' ? t('assets.reconciliation.role.cost') : t('assets.reconciliation.role.accum'),
    [t],
  );

  const keyOf = (a: ReconAccount): string => `${a.accountId}:${a.role}`;
  const openAccount = accounts.find((a) => keyOf(a) === expanded) ?? null;

  // Every figure is the engine's: sub-ledger, GL balance and delta render VERBATIM from
  // asset_reconciliation_report. Drift is flagged by row highlight PLUS a word badge (never colour
  // alone). Opening a row drills into its contributing assets in the shared DetailDrawer.
  const columns: DataTableColumn<ReconAccount>[] = [
    {
      key: 'account',
      header: t('assets.reconciliation.col.account'),
      render: (a) => `${a.accountNumber} ${a.accountName}`,
    },
    { key: 'role', header: t('assets.reconciliation.col.role'), render: (a) => roleLabel(a.role) },
    { key: 'subLedger', header: t('assets.reconciliation.col.subLedger'), numeric: true, render: (a) => money(a.subLedgerRappen) },
    { key: 'gl', header: t('assets.reconciliation.col.gl'), numeric: true, render: (a) => money(a.glBalanceRappen) },
    {
      key: 'delta',
      header: t('assets.reconciliation.col.delta'),
      numeric: true,
      render: (a) => <span className={a.deltaRappen !== 0 ? 'fa-loss' : undefined}>{money(a.deltaRappen)}</span>,
    },
    {
      key: 'status',
      header: t('assets.reconciliation.col.status'),
      render: (a) => (
        <span className={`fa-badge fa-badge-${a.status === 'drift' ? 'drift' : 'balanced'}`}>
          {t(`assets.reconciliation.status.${a.status}`)}
        </span>
      ),
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.reconciliation.noWorkspace')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.reconciliation.title')}
        subtitle={t('assets.reconciliation.explainer')}
        help={<SurfaceHelp surface="FixedAssets" />}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void runCheck()}
            disabled={loading || check.kind === 'running'}
          >
            {t('assets.reconciliation.runCheck')}
          </button>
        }
      />

      <div className="fa-filters">
        <label htmlFor="fa-recon-period">{t('assets.reconciliation.period')}</label>
        <input
          id="fa-recon-period"
          type="month"
          value={period}
          aria-label={t('assets.reconciliation.period')}
          onChange={(e) => setPeriod(e.target.value)}
        />
      </div>

      {check.kind === 'balanced' && (
        <div className="fa-recon-check fa-recon-ok" role="status">
          {t('assets.reconciliation.checkBalanced', { period: check.period })}
        </div>
      )}
      {check.kind === 'drift' && (
        <div className="fa-recon-check fa-recon-drift" role="alert">
          {t('assets.reconciliation.checkDrift', { period: check.period, count: String(check.accounts) })}
        </div>
      )}

      {failed && <ErrorBanner message={t('assets.reconciliation.error.transport')} onRetry={() => void load()} />}

      {report !== null && (
        <div className="fa-recon-cards">
          <div className="fa-recon-card">
            <span className="fa-recon-card-num">{report.summary.balancedCount}</span>
            <span className="fa-recon-card-label">{t('assets.reconciliation.balancedCount')}</span>
          </div>
          <div className={`fa-recon-card ${report.summary.driftCount > 0 ? 'fa-recon-card-drift' : ''}`}>
            <span className="fa-recon-card-num">{report.summary.driftCount}</span>
            <span className="fa-recon-card-label">{t('assets.reconciliation.driftCount')}</span>
          </div>
          <div className="fa-recon-card">
            <span className="fa-recon-card-cutoff">{report.cutOff}</span>
            <span className="fa-recon-card-label">{t('assets.reconciliation.cutOff')}</span>
          </div>
        </div>
      )}

      {!failed && (report !== null || loading) && (
        <DataTable
          columns={columns}
          rows={accounts}
          rowKey={keyOf}
          caption={t('assets.reconciliation.title')}
          loading={loading}
          rowClassName={(a) => (a.status === 'drift' ? 'fa-row-drift' : undefined)}
          onRowClick={(a) => setExpanded(keyOf(a))}
          rowLabel={(a) => `${a.accountNumber} ${a.accountName}`}
          emptyState={<EmptyState title={t('assets.reconciliation.empty.title')} hint={t('assets.reconciliation.empty.hint')} />}
        />
      )}

      <DetailDrawer
        open={openAccount !== null}
        onClose={() => setExpanded(null)}
        title={openAccount === null ? '' : `${openAccount.accountNumber} ${openAccount.accountName}`}
        closeLabel={t('assets.common.close')}
      >
        {openAccount !== null && openAccount.assets.length === 0 ? (
          <p className="fa-hint">{t('assets.reconciliation.noAssets')}</p>
        ) : (
          openAccount !== null &&
          openAccount.assets.map((as) => (
            <div className="fa-recon-drill-row" key={as.assetId}>
              <span>
                {as.assetNumber} {as.name}
              </span>
              <span className="fa-num">{money(as.amountRappen)}</span>
            </div>
          ))
        )}
      </DetailDrawer>
    </div>
  );
}

export default AssetReconciliation;
