/**
 * Accounts, the chart-of-accounts surface (spec A01 §6).
 *
 * A grouped, searchable list bucketed by leading-digit group (Aktiven, Passiven, Eigenkapital,
 * Ertrag, Aufwand), an AccountDrawer overlay for create/edit, and a collapsible Kostenstellen
 * section beneath. Renders the five canonical states (loading, empty, error, success,
 * permission-denied) off the shared F1 primitives.
 *
 * The Archive-XOR-Delete affordance is exclusive per row: an account that carries postings offers
 * Archive; one that never did offers a confirm-gated Delete. The two never appear together, so the
 * operator cannot choose wrong (spec §6, US-A01.4).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import {
  EmptyState,
  ErrorBanner,
  NoWorkspaceState,
  PermissionDenied,
  Skeleton,
} from '../../components/states';
import type { Err } from '../../lib/client';
import { useCan, CAP } from '../../lib/capabilities';
import { OverflowMenu } from '../../components/OverflowMenu';
import { AccountDrawer } from './AccountDrawer';
import { AccountConfirm } from './AccountConfirm';
import { CostCenterSection } from './CostCenterSection';
import { Status } from '../../components/Status';
import { ChevronDownGlyph } from '../../components/icons';
import {
  GROUP_ORDER,
  groupOf,
  idemKey,
  isInUse,
  matchesSearch,
  type Account,
  type AccountGroup,
  type CostCenter,
  type VatCode,
} from './model';

type DrawerState = { mode: 'create' } | { mode: 'edit'; account: Account } | null;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function Accounts() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  /**
   * THE PADLOCK (A24, F5 retrofit). Every write on this surface is `manage_chart`, so its
   * affordances are ABSENT for an actor the engine would refuse, never shown-then-rejected: the
   * pattern Contacts and Customization keep. `useCan` fails open while `whoami` is unresolved,
   * deliberately: the engine's `ctxAction` gate is the one that decides.
   */
  const canManageChart = useCan(CAP.manageChart);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [vatCodes, setVatCodes] = useState<VatCode[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<AccountGroup, boolean>>({
    aktiven: false,
    passiven: false,
    eigenkapital: false,
    ertrag: false,
    aufwand: false,
  });

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);
  const [rowError, setRowError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [accountsResp, costCentersResp, vatResp] = await Promise.all([
      client.call('list_accounts', { workspaceId, includeArchived: showArchived }),
      client.call('list_cost_centers', { workspaceId, includeArchived: showArchived }),
      client.call('vat_codes', { workspaceId }),
    ]);

    if (isErr(accountsResp.body)) {
      if (accountsResp.body.error === 'permission_denied' || accountsResp.status === 403) {
        setDenied(true);
      } else {
        setError(accountsResp.body);
      }
      setLoading(false);
      return;
    }

    setAccounts(asArray<Account>(accountsResp.body.accounts));
    setCostCenters(
      isErr(costCentersResp.body) ? [] : asArray<CostCenter>(costCentersResp.body.costCenters),
    );
    // `taxCodes` is the engine's real key (pinned by test/vat/tax-codes-fixture.test.mjs); reading
    // `vatCodes` rendered this dropdown empty against a live engine while jsdom stayed green.
    setVatCodes(isErr(vatResp.body) ? [] : asArray<VatCode>(vatResp.body.taxCodes));
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => accounts.filter((account) => matchesSearch(account, search)),
    [accounts, search],
  );

  const grouped = useMemo(() => {
    const buckets: Record<AccountGroup, Account[]> = {
      aktiven: [],
      passiven: [],
      eigenkapital: [],
      ertrag: [],
      aufwand: [],
    };
    for (const account of filtered) buckets[groupOf(account.number)].push(account);
    for (const key of GROUP_ORDER) {
      buckets[key].sort((a, b) => a.number.localeCompare(b.number));
    }
    return buckets;
  }, [filtered]);

  async function archiveAccount(account: Account) {
    setRowError(null);
    const resp = await client.call('archive_account', {
      workspaceId,
      accountId: account.id,
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else void load();
  }

  async function confirmDeleteAccount() {
    if (pendingDelete === null || workspaceId === null) return;
    setRowError(null);
    const resp = await client.call('delete_account', {
      workspaceId,
      accountId: pendingDelete.id,
      idempotencyKey: idemKey('acc-del'),
    });
    setPendingDelete(null);
    if (isErr(resp.body)) setRowError(resp.body);
    else void load();
  }

  // No workspace: a setup-first empty state, never a ctx call with a blank tenant.
  if (workspaceId === null) {
    return <NoWorkspaceState body={t('account.noWorkspaceHint')} />;
  }

  if (denied) {
    return <PermissionDenied />;
  }

  const hasVisibleAccounts = filtered.length > 0;
  const searching = search.trim() !== '';

  // The one page header (B2): title, help and the single primary action, sticky and rendered in
  // every state so the title stops being copy-pasted into each early return.
  const header = (
    <SurfaceHeader
      title={t('account.title')}
      help={<SurfaceHelp surface="Accounts" />}
      actions={
        canManageChart ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setDrawer({ mode: 'create' })}
          >
            {t('account.new')}
          </button>
        ) : undefined
      }
    />
  );

  if (loading) {
    return (
      <div className="accounts">
        {header}
        <Skeleton rows={6} height={40} />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="accounts">
        {header}
        <ErrorBanner error={error} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="accounts">
      {header}

      {/* The standard filter/search row (B2). The show-archived toggle rides the filter slot; there
          is no Clear affordance in the bar because the no-match empty state below owns clear-search,
          and two controls with the same name would collide. */}
      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchLabel={t('account.search')}
        searchPlaceholder={t('account.search')}
      >
        <label className="acc-checkbox">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          <span>{t('account.showArchived')}</span>
        </label>
      </FilterBar>

      {rowError !== null && <ErrorBanner error={rowError} />}

      {/* A search that matches nothing is NOT an empty chart of accounts: saying "no accounts yet"
          while the workspace holds the whole KMU chart misreports state, and offering "new account"
          as the way out is the wrong action. Split the two, and give the filtered case the action
          that actually helps. */}
      {!hasVisibleAccounts && searching ? (
        <EmptyState
          title={t('account.noMatch')}
          hint={t('account.noMatchHint')}
          filtered={{ onClear: () => setSearch(''), clearLabel: t('account.clearSearch') }}
        />
      ) : !hasVisibleAccounts ? (
        <EmptyState
          title={t('account.empty')}
          hint={t('account.emptyHint')}
          /* The CTA is the same write the head button makes: offering it to an actor who cannot
             create would be the shown-then-rejected shape on the one screen with nothing else on it. */
          {...(canManageChart
            ? { action: { label: t('account.new'), onClick: () => setDrawer({ mode: 'create' }) } }
            : {})}
        />
      ) : (
        <div className="acc-groups">
          {GROUP_ORDER.map((group) => {
            const rows = grouped[group];
            if (rows.length === 0) return null;
            const isCollapsed = collapsed[group];
            return (
              <section key={group} className="acc-group panel" aria-labelledby={`grp-${group}`}>
                <button
                  type="button"
                  className="acc-group-head panel-head"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))
                  }
                >
                  <ChevronDownGlyph
                    aria-hidden="true"
                    className={isCollapsed ? 'cc-caret cc-caret--collapsed' : 'cc-caret'}
                  />
                  <h2 id={`grp-${group}`} className="acc-group-title">
                    {t(`account.group.${group}`)}
                  </h2>
                </button>
                {!isCollapsed && (
                  <ul className="acc-list">
                    {rows.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        canManage={canManageChart}
                        onEdit={() => setDrawer({ mode: 'edit', account })}
                        onArchive={() => archiveAccount(account)}
                        onDelete={() => setPendingDelete(account)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <CostCenterSection
        workspaceId={workspaceId}
        costCenters={costCenters}
        canManage={canManageChart}
        onChanged={() => void load()}
      />

      {drawer !== null && (
        <AccountDrawer
          mode={drawer.mode}
          workspaceId={workspaceId}
          vatCodes={vatCodes}
          account={drawer.mode === 'edit' ? drawer.account : undefined}
          onClose={() => setDrawer(null)}
          onSaved={() => void load()}
        />
      )}

      {pendingDelete !== null && (
        <AccountConfirm
          title={t('account.confirm.title')}
          message={t('account.confirm.delete')}
          confirmLabel={t('account.delete')}
          onConfirm={confirmDeleteAccount}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

interface AccountRowProps {
  account: Account;
  /** A24 `manage_chart`: Edit and the Archive-XOR-Delete overflow depend on it. */
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function AccountRow({ account, canManage, onEdit, onArchive, onDelete }: AccountRowProps) {
  const t = useT();
  const archived = account.archived === true;
  const inUse = isInUse(account);

  return (
    <li className={`acc-row${archived ? ' acc-row-archived' : ''}`}>
      <span className="acc-num t-num">{account.number}</span>
      {/* K-21/K-12: the name IS the opener (ink 500, underlined on hover), where an "Bearbeiten"
          button sat beside an overflow of one. K-26: no type chip, because the group heading above
          ("Aktiven", "Passiven", ...) already names it on every row. */}
      {canManage ? (
        <button
          type="button"
          className="acc-name acc-name-open"
          aria-label={t('account.rowOpen', { number: account.number, name: account.name })}
          onClick={onEdit}
        >
          {account.name}
        </button>
      ) : (
        <span className="acc-name">{account.name}</span>
      )}
      {archived && <Status kind="inactive" label={t('account.archived')} />}
      {/* D15/C2: everything but opening, above all the destructive Delete, sits in the per-row
          overflow. The Archive-XOR-Delete exclusivity is unchanged, so the menu offers exactly one of
          the two and the operator still cannot choose wrong. */}
      {canManage && (
        <span className="acc-actions">
          <OverflowMenu
            label={t('account.rowActions', { number: account.number, name: account.name })}
            items={
              inUse
                ? [{ key: 'archive', label: t('account.archive'), onSelect: onArchive }]
                : [
                    { key: 'delete', label: t('account.delete'), onSelect: onDelete, danger: true },
                  ]
            }
          />
        </span>
      )}
    </li>
  );
}
