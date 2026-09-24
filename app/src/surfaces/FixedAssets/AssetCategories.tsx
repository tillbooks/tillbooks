/**
 * H00, Fixed Assets -> Categories (`/asset-categories`): the master surface where a workspace's
 * depreciation and GL-account defaults live, so creating an asset (H01) becomes "pick category,
 * enter name, date and cost".
 *
 * A dense list (code, name, method, life, residual, active badge, row menu) plus a right-hand drawer
 * for create/edit. The account pickers are restricted to the correct A01 account types (asset for
 * cost, asset-or-liability contra for accumulated depreciation, expense for the depreciation charge),
 * so a nonsense default cannot be chosen in the first place; the engine re-checks and is the real
 * gate. Status is glyph + label, never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami` is the one source,
 * it fails open, and the engine is the real gate. Write controls disable behind `manage_master_data`;
 * a click that slips through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { Select } from '../../components/Select';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import './FixedAssets.css';

const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'units_of_production', 'none'] as const;
type Method = (typeof DEPRECIATION_METHODS)[number];

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

/** The archive confirm is a consequential question: held as a value so the role travels to the shared
 * Modal as a prop, never as a literal attribute the modal-role guard would read on a component. */
const ALERT_DIALOG = 'alertdialog' as const;

export interface Category {
  id: string;
  code: string;
  name: string;
  description: string | null;
  depreciationMethod: string;
  usefulLifeMonths: number | null;
  residualValuePct: number;
  residualValueRappen: number | null;
  glAssetAccountId: string;
  glAccumDeprAccountId: string;
  glDeprExpenseAccountId: string;
  defaultCostCenterId: string | null;
  active: boolean;
}

interface Account {
  id: string;
  number: string;
  name: string;
  type: string;
}
interface CostCenter {
  id: string;
  code: string;
  name: string;
}

function parseCategories(body: unknown): Category[] | null {
  const rows = (body as { categories?: unknown })?.categories;
  if (!Array.isArray(rows)) return null;
  const out: Category[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.code !== 'string' || typeof c.name !== 'string') return null;
    out.push({
      id: c.id,
      code: c.code,
      name: c.name,
      description: typeof c.description === 'string' ? c.description : null,
      depreciationMethod: typeof c.depreciationMethod === 'string' ? c.depreciationMethod : 'straight_line',
      usefulLifeMonths: typeof c.usefulLifeMonths === 'number' ? c.usefulLifeMonths : null,
      residualValuePct: typeof c.residualValuePct === 'number' ? c.residualValuePct : 0,
      residualValueRappen: typeof c.residualValueRappen === 'number' ? c.residualValueRappen : null,
      glAssetAccountId: typeof c.glAssetAccountId === 'string' ? c.glAssetAccountId : '',
      glAccumDeprAccountId: typeof c.glAccumDeprAccountId === 'string' ? c.glAccumDeprAccountId : '',
      glDeprExpenseAccountId: typeof c.glDeprExpenseAccountId === 'string' ? c.glDeprExpenseAccountId : '',
      defaultCostCenterId: typeof c.defaultCostCenterId === 'string' ? c.defaultCostCenterId : null,
      active: c.active === true,
    });
  }
  return out;
}

function parseAccounts(body: unknown): Account[] {
  const rows = (body as { accounts?: unknown })?.accounts;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      number: String(r.number ?? ''),
      name: String(r.name ?? ''),
      type: String(r.type ?? ''),
    }))
    .filter((a) => a.id !== '');
}

function parseCostCenters(body: unknown): CostCenter[] {
  const rows = (body as { costCenters?: unknown })?.costCenters;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: String(r.id ?? ''), code: String(r.code ?? ''), name: String(r.name ?? '') }))
    .filter((c) => c.id !== '');
}

interface Draft {
  code: string;
  name: string;
  description: string;
  depreciationMethod: Method;
  usefulLifeMonths: string;
  residualValuePct: string;
  glAssetAccountId: string;
  glAccumDeprAccountId: string;
  glDeprExpenseAccountId: string;
  defaultCostCenterId: string;
}

const EMPTY_DRAFT: Draft = {
  code: '',
  name: '',
  description: '',
  depreciationMethod: 'straight_line',
  usefulLifeMonths: '',
  residualValuePct: '',
  glAssetAccountId: '',
  glAccumDeprAccountId: '',
  glDeprExpenseAccountId: '',
  defaultCostCenterId: '',
};

function draftFrom(c: Category): Draft {
  return {
    code: c.code,
    name: c.name,
    description: c.description ?? '',
    depreciationMethod: (DEPRECIATION_METHODS.includes(c.depreciationMethod as Method)
      ? c.depreciationMethod
      : 'straight_line') as Method,
    usefulLifeMonths: c.usefulLifeMonths === null ? '' : String(c.usefulLifeMonths),
    residualValuePct: c.residualValuePct === 0 ? '' : String(c.residualValuePct),
    glAssetAccountId: c.glAssetAccountId,
    glAccumDeprAccountId: c.glAccumDeprAccountId,
    glDeprExpenseAccountId: c.glDeprExpenseAccountId,
    defaultCostCenterId: c.defaultCostCenterId ?? '',
  };
}

export function AssetCategories() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [drawer, setDrawer] = useState<'closed' | 'create' | string>('closed');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [archiving, setArchiving] = useState<Category | null>(null);

  const canWrite = can(CAP.manageMasterData);

  const assetAccounts = useMemo(() => accounts.filter((a) => a.type === 'asset'), [accounts]);
  const contraAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'asset' || a.type === 'liability'),
    [accounts],
  );
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'expense'), [accounts]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, accts, ccs] = await Promise.all([
      client.call('asset_category_list', { workspaceId, ...(showArchived ? {} : { active: true }) }),
      client.call('list_accounts', { workspaceId }),
      client.call('list_cost_centers', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseCategories(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setCategories(parsed);
    if (!isErr(accts.body)) setAccounts(parseAccounts(accts.body));
    if (!isErr(ccs.body)) setCostCenters(parseCostCenters(ccs.body));
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await load();
      return true;
    },
    [client, workspaceId, load],
  );

  const openCreate = () => {
    setWriteError(null);
    setDraft(EMPTY_DRAFT);
    setDrawer('create');
  };
  const openEdit = (c: Category) => {
    setWriteError(null);
    setDraft(draftFrom(c));
    setDrawer(c.id);
  };
  const closeDrawer = () => setDrawer('closed');

  const submit = useCallback(async () => {
    const life = draft.usefulLifeMonths.trim();
    const pct = draft.residualValuePct.trim();
    const shared = {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      depreciationMethod: draft.depreciationMethod,
      usefulLifeMonths: draft.depreciationMethod === 'none' || life === '' ? undefined : Number(life),
      residualValuePct: pct === '' ? undefined : Number(pct),
      glAssetAccountId: draft.glAssetAccountId,
      glAccumDeprAccountId: draft.glAccumDeprAccountId,
      glDeprExpenseAccountId: draft.glDeprExpenseAccountId,
      defaultCostCenterId: draft.defaultCostCenterId === '' ? undefined : draft.defaultCostCenterId,
    };
    let ok = false;
    if (drawer === 'create') {
      ok = await write('asset_category_create', { code: draft.code.trim(), ...shared, idempotencyKey: newKey() });
    } else {
      ok = await write('asset_category_update', { categoryId: drawer, patch: shared, idempotencyKey: newKey() });
    }
    if (ok) closeDrawer();
  }, [write, draft, drawer]);

  const confirmArchive = useCallback(async () => {
    if (archiving === null) return;
    const ok = await write('asset_category_archive', { categoryId: archiving.id, idempotencyKey: newKey() });
    if (ok) setArchiving(null);
  }, [write, archiving]);

  const residualLabel = (c: Category): string => {
    if (c.residualValueRappen !== null) return formatMoney(c.residualValueRappen, 'CHF');
    if (c.residualValuePct === 0) return '-';
    return `${(c.residualValuePct / 100).toFixed(c.residualValuePct % 100 === 0 ? 0 : 2)} %`;
  };

  const columns: DataTableColumn<Category>[] = [
    { key: 'code', header: t('assets.categories.col.code'), render: (c) => <span className="fa-code">{c.code}</span> },
    { key: 'name', header: t('assets.categories.col.name'), render: (c) => c.name },
    { key: 'method', header: t('assets.categories.col.method'), render: (c) => t(`assets.method.${c.depreciationMethod}`) },
    {
      key: 'life',
      header: t('assets.categories.col.life'),
      numeric: true,
      render: (c) => (c.usefulLifeMonths === null ? '-' : c.usefulLifeMonths),
    },
    { key: 'residual', header: t('assets.categories.col.residual'), numeric: true, render: (c) => residualLabel(c) },
    {
      key: 'status',
      header: t('assets.categories.col.status'),
      render: (c) => (
        <Status
          kind={c.active ? 'success' : 'inactive'}
          label={c.active ? t('assets.categories.active') : t('assets.categories.archived')}
        />
      ),
    },
  ];

  // K-21: the row opens the category's edit drawer; archiving sits behind the one quiet overflow.
  const categoryActions = (c: Category): OverflowMenuItem[] =>
    c.active && canWrite
      ? [
          {
            key: 'archive',
            label: t('assets.categories.archive'),
            onSelect: () => {
              setWriteError(null);
              setArchiving(c);
            },
            danger: true,
          },
        ]
      : [];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.categories.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('assets.categories.title')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.categories.title')}
        help={<SurfaceHelp surface="FixedAssets" />}
        actions={
          <>
            <label className="fa-toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              {t('assets.categories.showArchived')}
            </label>
            <button type="button" className="btn btn--primary" onClick={openCreate} disabled={!canWrite}>
              {t('assets.categories.new')}
            </button>
          </>
        }
      />

      {failed ? (
        <ErrorBanner message={t('assets.categories.error.transport')} onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={categories}
          rowKey={(c) => c.id}
          caption={t('assets.categories.title')}
          loading={loading}
          rowClassName={(c) => (c.active ? undefined : 'fa-row-archived')}
          {...(canWrite
            ? {
                onRowClick: openEdit,
                rowLabel: (c: Category) => t('assets.categories.rowOpen', { code: c.code, name: c.name }),
              }
            : {})}
          rowActions={categoryActions}
          rowActionsLabel={(c) => t('assets.categories.rowActionsFor', { code: c.code })}
          emptyState={
            <EmptyState
              title={t('assets.categories.empty.title')}
              hint={t('assets.categories.empty.hint')}
              action={canWrite ? { label: t('assets.categories.empty.cta'), onClick: openCreate } : undefined}
            />
          }
        />
      )}

      <DetailDrawer
        open={drawer !== 'closed'}
        onClose={closeDrawer}
        title={drawer === 'create' ? t('assets.categories.form.createTitle') : t('assets.categories.form.editTitle')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={closeDrawer}>
              {t('assets.categories.cancel')}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={!canWrite}>
              {t('assets.categories.save')}
            </button>
          </>
        }
      >
        {writeError && <ErrorBanner error={writeError} />}
        <div className="fa-field">
            <label htmlFor="fa-code">{t('assets.categories.field.code')}</label>
            <input className="field"
              id="fa-code"
              value={draft.code}
              maxLength={20}
              disabled={drawer !== 'create'}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-name">{t('assets.categories.field.name')}</label>
            <input className="field" id="fa-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-method">{t('assets.categories.field.method')}</label>
            <Select
              id="fa-method"
              value={draft.depreciationMethod}
              onChange={(value) => setDraft({ ...draft, depreciationMethod: value as Method })}
              options={DEPRECIATION_METHODS.map((m) => ({ value: m, label: t(`assets.method.${m}`) }))}
              ariaLabel={t('assets.categories.field.method')}
            />
          </div>
          {draft.depreciationMethod !== 'none' && (
            <div className="fa-field">
              <label htmlFor="fa-life">{t('assets.categories.field.life')}</label>
              <input className="field"
                id="fa-life"
                type="number"
                min={1}
                value={draft.usefulLifeMonths}
                onChange={(e) => setDraft({ ...draft, usefulLifeMonths: e.target.value })}
              />
            </div>
          )}
          <div className="fa-field">
            <label htmlFor="fa-residual">{t('assets.categories.field.residualPct')}</label>
            <input className="field"
              id="fa-residual"
              type="number"
              min={0}
              max={10000}
              value={draft.residualValuePct}
              onChange={(e) => setDraft({ ...draft, residualValuePct: e.target.value })}
            />
            <span className="fa-hint">{t('assets.categories.field.residualHint')}</span>
          </div>
          <div className="fa-field">
            <label htmlFor="fa-asset">{t('assets.categories.field.assetAccount')}</label>
            <Select
              id="fa-asset"
              value={draft.glAssetAccountId}
              onChange={(value) => setDraft({ ...draft, glAssetAccountId: value })}
              options={[
                { value: '', label: t('assets.categories.field.choose') },
                ...assetAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('assets.categories.field.assetAccount')}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-accum">{t('assets.categories.field.accumAccount')}</label>
            <Select
              id="fa-accum"
              value={draft.glAccumDeprAccountId}
              onChange={(value) => setDraft({ ...draft, glAccumDeprAccountId: value })}
              options={[
                { value: '', label: t('assets.categories.field.choose') },
                ...contraAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('assets.categories.field.accumAccount')}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-expense">{t('assets.categories.field.expenseAccount')}</label>
            <Select
              id="fa-expense"
              value={draft.glDeprExpenseAccountId}
              onChange={(value) => setDraft({ ...draft, glDeprExpenseAccountId: value })}
              options={[
                { value: '', label: t('assets.categories.field.choose') },
                ...expenseAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('assets.categories.field.expenseAccount')}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-cc">{t('assets.categories.field.costCenter')}</label>
            <Select
              id="fa-cc"
              value={draft.defaultCostCenterId}
              onChange={(value) => setDraft({ ...draft, defaultCostCenterId: value })}
              options={[
                { value: '', label: t('assets.categories.field.none') },
                ...costCenters.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
              ]}
              ariaLabel={t('assets.categories.field.costCenter')}
            />
          </div>
      </DetailDrawer>

      <Modal
        open={archiving !== null}
        role={ALERT_DIALOG}
        onClose={() => setArchiving(null)}
        title={t('assets.categories.archive')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setArchiving(null)}>
              {t('assets.categories.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void confirmArchive()}>
              {t('assets.categories.archive')}
            </button>
          </>
        }
      >
        {archiving !== null && <p>{t('assets.categories.confirmArchive', { code: archiving.code })}</p>}
        {writeError && <ErrorBanner error={writeError} />}
      </Modal>
    </div>
  );
}
