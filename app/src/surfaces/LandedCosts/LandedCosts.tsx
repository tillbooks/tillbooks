/**
 * I03, Einkauf -> Landed Costs (Landkosten): the Studio surface over the landed-cost voucher. It
 * collects freight/duty/handling against a posted goods receipt, previews the allocation, and confirms
 * it (which writes the value-only J02 movements and the one balanced A02 entry) or reverses it.
 *
 * The money path lives entirely in the engine (`core/procurement/landed_cost.ts`): this surface only
 * calls the six landed_cost_* verbs and RENDERS their results verbatim. Every figure (total cost, base
 * value, allocated amount, per-unit impact) comes straight from the read verb; nothing is recomputed,
 * re-rounded or re-allocated here. `chf()` only formats integer Rappen for display. Writes are
 * pre-disabled without `procurement.landed_cost` (spec §6: never shown-then-rejected); the engine is
 * the real gate.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118, money-path wave)
 *
 * The voucher list and the per-voucher allocation preview are both the shared `DataTable` (frame
 * overflow, sticky header, density and the five states in one place), with the money columns numeric
 * and right-aligned; a reversed voucher dims through the `rowClassName` hook while its status glyph
 * still carries the state (never colour alone). The page header and the create action are the shared
 * `SurfaceHeader`. The voucher detail rides the shared `DetailDrawer` (focus trap, Escape, scrim the
 * bespoke section lacked). The capitalise/reverse writes are confirmed through the shared `Modal` as
 * an alertdialog (no scrim-dismiss on a consequential question), and the drawer's own trap stands down
 * while that confirm is open (`trapActive`). What stays bespoke is genuinely surface-specific: the
 * create form (an allocation form, not a plain list table).
 *
 * No `Provenance` line (C3): the landed-cost read model names no actor or author, only the effective
 * business date, so there is no who/when to show. No `ConsequenceLine` copy renders (C4): every
 * landed_cost verb carries a null `dialCapability`, so the engine offers no consequence sentence; the
 * component is placed against the confirm verbs so it lights up automatically if the engine ever adds
 * one. See the report's NEEDS-ENGINE-DATA note.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './LandedCosts.css';

const STATUS_GLYPH: Record<string, string> = { draft: '✎', allocated: '◆', reversed: '↺' };
const COMPONENT_TYPES = ['freight', 'duty', 'insurance', 'handling', 'brokerage', 'other'] as const;
const METHODS = ['by_value', 'by_qty', 'by_weight', 'by_volume', 'equal', 'manual'] as const;

const newKey = (): string => crypto.randomUUID();

// The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
// component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * Integer Rappen to a plain CHF string. Money is never a float on the wire (P2). Display only:
 * the value is not re-rounded, only the whole-franc part is grouped with the Swiss apostrophe
 * thousands separator (de-CH house style, matching the shared `formatMoney`): `1'234.56`.
 */
function chf(rappen: number): string {
  const abs = Math.abs(rappen);
  const sign = rappen < 0 ? '-' : '';
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

interface VoucherRow {
  id: string;
  number: string;
  status: string;
  totalCostMinor: number;
  allocationMethod: string;
  effectiveDate: string;
  journalEntryId: string | null;
}

interface Target {
  id: string;
  goodsReceiptLineId: string;
  itemId: string;
  baseQty: number;
  baseValueMinor: number;
  allocatedMinor: number;
  unitImpactMinor: number;
  movementId: string | null;
}

interface VoucherDetail {
  id: string;
  number: string;
  status: string;
  totalCostMinor: number;
  allocationMethod: string;
  effectiveDate: string;
  journalEntryId: string | null;
  reverseJournalEntryId: string | null;
  lines: Array<{ id: string; componentType: string; amountBaseMinor: number; description: string | null }>;
  targets: Target[];
}

interface PreviewLine {
  targetId: string;
  itemId: string;
  baseValueMinor: number;
  share: number;
  allocatedMinor: number;
  unitImpactMinor: number;
}

interface Account {
  id: string;
  number: string;
  name: string;
}

interface GrOption {
  id: string;
  number: string;
}

/** An item as the client needs it here: just enough to humanize the raw itemId in the allocation table. */
interface ItemLabel {
  id: string;
  name: string;
}

/** A row of the drawer's allocation table: preview while draft, or the persisted targets after. */
interface AllocRow {
  targetId: string;
  itemId: string;
  baseValueMinor: number;
  allocatedMinor: number;
  unitImpactMinor: number;
}

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function LandedCosts(): React.ReactElement {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const mayWrite = can(CAP.procurementLandedCost);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [grs, setGrs] = useState<GrOption[]>([]);
  const [items, setItems] = useState<ItemLabel[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VoucherDetail | null>(null);
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [creating, setCreating] = useState(false);
  // The pending money-path write awaiting its alertdialog confirmation, or null when none is open.
  const [pendingWrite, setPendingWrite] = useState<'confirm' | 'reverse' | null>(null);

  // Create-form state.
  const [formGr, setFormGr] = useState('');
  const [formComponent, setFormComponent] = useState<string>('freight');
  const [formAmount, setFormAmount] = useState('');
  const [formInvAcc, setFormInvAcc] = useState('');
  const [formClrAcc, setFormClrAcc] = useState('');
  const [formMethod, setFormMethod] = useState<string>('by_value');

  const loadList = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setLoadError(null);
    const [listRes, accRes, grRes, itemRes] = await Promise.all([
      client.call('landed_cost_list', { workspaceId }),
      client.call('list_accounts', { workspaceId }),
      client.call('goods_receipt_list', { workspaceId, status: 'posted' }),
      // The read model carries only itemId (no name): a client-side lookup humanizes it for display.
      // Purely cosmetic, never on the wire, so a denied or failed read just leaves the raw id showing.
      client.call('list_items', { workspaceId }),
    ]);
    if (isErr(listRes.body)) {
      setLoadError(listRes.body);
      setLoading(false);
      return;
    }
    setRows(asArray<VoucherRow>((listRes.body as { items?: unknown }).items));
    setAccounts(
      isErr(accRes.body)
        ? []
        : asArray<Record<string, unknown>>((accRes.body as { accounts?: unknown }).accounts).map((a) => ({
            id: str(a.id),
            number: str(a.number),
            name: str(a.name),
          })),
    );
    setGrs(
      isErr(grRes.body)
        ? []
        : asArray<Record<string, unknown>>((grRes.body as { items?: unknown }).items).map((g) => ({
            id: str(g.id),
            number: str(g.number),
          })),
    );
    setItems(
      isErr(itemRes.body)
        ? []
        : asArray<Record<string, unknown>>((itemRes.body as { items?: unknown }).items)
            .filter((i) => typeof i.id === 'string')
            .map((i) => ({ id: str(i.id), name: str(i.name, str(i.id)) })),
    );
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (voucherId: string) => {
      if (workspaceId === null) return;
      const getRes = await client.call('landed_cost_get', { workspaceId, voucherId });
      if (isErr(getRes.body)) {
        setDetail(null);
        setPreview(null);
        return;
      }
      const v = (getRes.body as unknown as { voucher: VoucherDetail }).voucher;
      setDetail(v);
      if (v.status === 'draft') {
        const prevRes = await client.call('landed_cost_allocate_preview', { workspaceId, voucherId });
        setPreview(isErr(prevRes.body) ? null : asArray<PreviewLine>((prevRes.body as { lines?: unknown }).lines));
      } else {
        setPreview(null);
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else {
      setDetail(null);
      setPreview(null);
    }
  }, [selectedId, loadDetail]);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId !== null) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  const run = useCallback(
    async (tool: string, input: Record<string, unknown>): Promise<string | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      const res = await client.call(tool, { workspaceId, ...input, idempotencyKey: newKey() });
      if (isErr(res.body)) {
        setWriteError(res.body);
        return null;
      }
      await refresh();
      const voucher = (res.body as { voucher?: { id?: unknown } }).voucher;
      return voucher !== undefined && typeof voucher.id === 'string' ? voucher.id : 'ok';
    },
    [client, workspaceId, refresh],
  );

  const submitCreate = useCallback(async () => {
    const amount = Math.round(Number.parseFloat(formAmount) * 100);
    if (!Number.isInteger(amount) || amount <= 0 || formGr === '' || formInvAcc === '' || formClrAcc === '') return;
    // Resolve the recognised lines of the chosen receipt into target ids.
    const getRes = await client.call('goods_receipt_get', { workspaceId: workspaceId ?? '', grId: formGr });
    if (isErr(getRes.body)) {
      setWriteError(getRes.body);
      return;
    }
    const lines = asArray<Record<string, unknown>>((getRes.body as { goodsReceipt?: { lines?: unknown } }).goodsReceipt?.lines);
    const targetGrLineIds = lines.filter((l) => typeof l.movementId === 'string').map((l) => str(l.id));
    if (targetGrLineIds.length === 0) {
      setWriteError({ ok: false, error: 'nothing_to_allocate' });
      return;
    }
    const created = await run('landed_cost_voucher_create', {
      costLines: [{ componentType: formComponent, amountMinor: amount }],
      targetGrLineIds,
      inventoryAccountId: formInvAcc,
      clearingAccountId: formClrAcc,
      allocationMethod: formMethod,
    });
    if (created !== null) {
      setCreating(false);
      setFormAmount('');
      if (created !== 'ok') setSelectedId(created);
    }
  }, [formAmount, formGr, formInvAcc, formClrAcc, formComponent, formMethod, client, workspaceId, run]);

  // The alertdialog "yes": run the pending money-path write, then close the confirm. The drawer
  // reopens with the refreshed voucher.
  const confirmPending = useCallback(async () => {
    if (detail === null || pendingWrite === null) return;
    if (pendingWrite === 'confirm') {
      await run('landed_cost_allocate_confirm', { voucherId: detail.id });
    } else {
      await run('landed_cost_reverse', { voucherId: detail.id, reason: t('landedCosts.reverseReason') });
    }
    setPendingWrite(null);
  }, [detail, pendingWrite, run, t]);

  const errorText = useMemo(
    () => (e: Err | null): string | undefined => (e === null ? undefined : t(`landedCosts.errors.${e.error}`)),
    [t],
  );

  // The voucher list columns: text left, the money total a numeric right-aligned `.t-num` cell. Every
  // figure is the engine's, formatted for display only. A reversed voucher dims via `rowClassName`.
  const columns: DataTableColumn<VoucherRow>[] = [
    { key: 'number', header: t('landedCosts.col.number'), render: (r) => r.number },
    {
      key: 'status',
      header: t('landedCosts.col.status'),
      render: (r) => (
        <>
          <span aria-hidden="true">{STATUS_GLYPH[r.status] ?? '·'}</span> {t(`landedCosts.status.${r.status}`)}
        </>
      ),
    },
    { key: 'method', header: t('landedCosts.col.method'), render: (r) => t(`landedCosts.method.${r.allocationMethod}`) },
    { key: 'total', header: t('landedCosts.col.total'), numeric: true, render: (r) => chf(r.totalCostMinor) },
    { key: 'date', header: t('landedCosts.col.date'), render: (r) => r.effectiveDate },
  ];

  // The drawer's allocation table: the live preview while draft, else the persisted targets. All
  // figures render verbatim from the read verb; the allocation math is the engine's.
  const allocRows: AllocRow[] =
    preview !== null
      ? preview.map((l) => ({
          targetId: l.targetId,
          itemId: l.itemId,
          baseValueMinor: l.baseValueMinor,
          allocatedMinor: l.allocatedMinor,
          unitImpactMinor: l.unitImpactMinor,
        }))
      : (detail?.targets ?? []).map((tg) => ({
          targetId: tg.id,
          itemId: tg.itemId,
          baseValueMinor: tg.baseValueMinor,
          allocatedMinor: tg.allocatedMinor,
          unitImpactMinor: tg.unitImpactMinor,
        }));

  // itemId -> human name, for the allocation table (the read model carries no name). Cosmetic only.
  const itemNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) m.set(it.id, it.name);
    return m;
  }, [items]);

  const allocColumns: DataTableColumn<AllocRow>[] = [
    {
      key: 'item',
      header: t('landedCosts.col.item'),
      // Humanize the raw itemId: show the item name, with the raw id surviving as a real tooltip
      // (aria-describedby, hover + focus, Escape-dismissible; never the title attribute). When the
      // id does not resolve (items unread or unknown), fall back to the raw id itself, plain.
      render: (l) => {
        const name = itemNameById.get(l.itemId);
        return name === undefined ? (
          l.itemId
        ) : (
          <Tooltip content={t('landedCosts.itemIdTooltip', { id: l.itemId })}>
            <span>{name}</span>
          </Tooltip>
        );
      },
    },
    { key: 'baseValue', header: t('landedCosts.col.baseValue'), numeric: true, render: (l) => chf(l.baseValueMinor) },
    { key: 'allocated', header: t('landedCosts.col.allocated'), numeric: true, render: (l) => chf(l.allocatedMinor) },
    { key: 'unitImpact', header: t('landedCosts.col.unitImpact'), numeric: true, render: (l) => chf(l.unitImpactMinor) },
  ];

  // The disabled-create reason is exposed as a VISIBLE lock-note associated by aria-describedby, never
  // a hover-only `title` (DESIGN.md: real tooltips, never the title attribute; a lock is a fact stated
  // beside the control, reachable by focus, hover and touch). The note renders below the header.
  const createReasonId = 'lc-create-reason';
  const headerActions = (
    <button
      type="button"
      className="btn btn--primary"
      disabled={!mayWrite}
      aria-describedby={mayWrite ? undefined : createReasonId}
      onClick={() => setCreating((c) => !c)}
    >
      {t('landedCosts.create')}
    </button>
  );

  if (workspaceId === null) return <NoWorkspaceState />;

  return (
    <div className="landed-costs">
      <SurfaceHeader title={t('landedCosts.title')} help={<SurfaceHelp surface="LandedCosts" />} actions={headerActions} />

      {!mayWrite ? (
        <p id={createReasonId} className="lock-note">
          {t('landedCosts.needsPermission')}
        </p>
      ) : null}

      {creating && mayWrite ? (
        <section className="lc-form" aria-label={t('landedCosts.create')}>
          <label>
            {t('landedCosts.form.receipt')}
            <select className="field" value={formGr} onChange={(e) => setFormGr(e.target.value)}>
              <option value="">·</option>
              {grs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('landedCosts.form.component')}
            <select className="field" value={formComponent} onChange={(e) => setFormComponent(e.target.value)}>
              {COMPONENT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {t(`landedCosts.component.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('landedCosts.form.amount')}
            <input className="field" inputMode="decimal" value={formAmount} onChange={(e) => setFormAmount(e.target.value)} placeholder="0.00" />
          </label>
          <label>
            {t('landedCosts.form.method')}
            <select className="field" value={formMethod} onChange={(e) => setFormMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`landedCosts.method.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('landedCosts.form.inventoryAccount')}
            <select className="field" value={formInvAcc} onChange={(e) => setFormInvAcc(e.target.value)}>
              <option value="">·</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('landedCosts.form.clearingAccount')}
            <select className="field" value={formClrAcc} onChange={(e) => setFormClrAcc(e.target.value)}>
              <option value="">·</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--primary" onClick={() => void submitCreate()}>
            {t('landedCosts.form.submit')}
          </button>
        </section>
      ) : null}

      {writeError !== null ? <ErrorBanner error={writeError} message={errorText(writeError)} /> : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        caption={t('landedCosts.list.caption')}
        loading={loading}
        error={loadError ?? undefined}
        onRetry={() => void loadList()}
        skeletonRows={5}
        onRowClick={(r) => setSelectedId(r.id)}
        rowLabel={(r) => r.number}
        rowClassName={(r) => (r.status === 'reversed' ? 'lc-row--reversed' : undefined)}
        emptyState={<EmptyState title={t('landedCosts.empty')} />}
      />

      <DetailDrawer
        open={detail !== null}
        onClose={() => setSelectedId(null)}
        title={detail !== null ? `${detail.number} · ${t(`landedCosts.status.${detail.status}`)}` : ''}
        closeLabel={t('landedCosts.close')}
        // While the alertdialog confirm is open, the drawer stands its trap and Escape down so the
        // child dialog owns focus and a stray Escape closes only the confirm.
        trapActive={pendingWrite === null}
        footer={
          detail !== null ? (
            <>
              {detail.status === 'draft' && mayWrite ? (
                <button type="button" className="btn btn--primary" onClick={() => setPendingWrite('confirm')}>
                  {t('landedCosts.confirm')}
                </button>
              ) : null}
              {detail.status === 'allocated' && mayWrite ? (
                <button type="button" className="btn btn--danger" onClick={() => setPendingWrite('reverse')}>
                  {t('landedCosts.reverse')}
                </button>
              ) : null}
              {detail.journalEntryId !== null ? (
                <span className="lc-journal">
                  {t('landedCosts.journal')}: {detail.journalEntryId}
                </span>
              ) : null}
            </>
          ) : undefined
        }
      >
        {detail !== null ? (
          <DataTable
            columns={allocColumns}
            rows={allocRows}
            rowKey={(l) => l.targetId}
            caption={t('landedCosts.detail.caption')}
            emptyState={<EmptyState title={t('landedCosts.detail.empty')} />}
          />
        ) : null}
      </DetailDrawer>

      <Modal
        open={pendingWrite !== null}
        onClose={() => setPendingWrite(null)}
        role={ALERT_DIALOG}
        title={pendingWrite === 'reverse' ? t('landedCosts.reverseDialog.title') : t('landedCosts.confirmDialog.title')}
        closeLabel={t('landedCosts.confirmDialog.cancel')}
        describedById="lc-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setPendingWrite(null)}>
              {t('landedCosts.confirmDialog.cancel')}
            </button>
            <button
              type="button"
              className={pendingWrite === 'reverse' ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={() => void confirmPending()}
            >
              {pendingWrite === 'reverse' ? t('landedCosts.reverse') : t('landedCosts.confirm')}
            </button>
          </>
        }
      >
        <div id="lc-confirm-body">
          <p>
            {pendingWrite === 'reverse'
              ? t('landedCosts.reverseDialog.body')
              : t('landedCosts.confirmDialog.body', { total: detail !== null ? chf(detail.totalCostMinor) : '' })}
          </p>
          {/* C4: the shared consequence line. It renders nothing while the landed_cost verbs carry a
              null dialCapability (NEEDS-ENGINE-DATA), and lights up automatically if one is added. */}
          <ConsequenceLine verb={pendingWrite === 'reverse' ? 'landed_cost_reverse' : 'landed_cost_allocate_confirm'} />
        </div>
      </Modal>
    </div>
  );
}
