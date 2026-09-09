/**
 * I00, Einkauf -> Anforderungen (`/requisitions`): the internal-demand document that opens the
 * procure-to-pay chain. A dense list (number, status glyph + label, requester, needed-by, urgency,
 * estimated total) plus a right-hand drawer for create and a detail drawer carrying the approval
 * timeline, the lifecycle actions (submit, approve, reject, return, cancel, close) and the
 * convert-to-PO wizard.
 *
 * NO money path: a requisition posts nothing and emits no outward artifact; the estimated costs are
 * operational estimates. THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): the
 * write controls disable behind `manage_master_data`, and the engine is the real gate. Status is glyph
 * + label, never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * The requisition list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place), row-click driving the detail drawer; the estimate column is a numeric,
 * right-aligned `.t-num` cell, and a terminal row (rejected, cancelled, closed) dims through the
 * `rowClassName` hook. The page header and the "show all" control are the shared `SurfaceHeader`, and
 * both overlays (create, detail) are the shared `DetailDrawer`, which adds the focus trap, Escape and
 * scrim the bespoke panel lacked. The C3 `Provenance` line stays, moved into the drawer's quiet
 * provenance slot. The per-surface CSS that duplicated the list table, the header, the drawer chrome
 * and the button set is gone; what remains is genuinely Requisitions-specific: the status badges, the
 * drawer form fields, the line grid, the approval timeline and the convert panel.
 *
 * No `ConsequenceLine` (C4): every requisition verb carries a null `dialCapability`, so there is no
 * engine consequence sentence to render.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Provenance } from '../../components/Provenance';
import './Requisitions.css';

const URGENCIES = ['normal', 'high', 'critical'] as const;
type Urgency = (typeof URGENCIES)[number];

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();
// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied. A requisition
// is an internal estimate kept in the workspace base currency and carries no per-row currency, so the
// base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');
/** Milli-units are the engine quantity scale (1000 = one whole unit); the UI works in whole units. */
const MILLI = 1000;

interface Line {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  qtyMilli: number;
  estimatedUnitCostRappen: number;
  estimatedTotalRappen: number;
  preferredSupplierId: string | null;
  convertedQtyMilli: number;
  openQtyMilli: number;
}
interface ApprovalEvent {
  id: string;
  decision: string;
  comment: string | null;
  createdAt: string;
  actorId: string | null;
}
interface Conversion {
  id: string;
  purchaseOrderId: string;
}
interface Requisition {
  id: string;
  number: string;
  status: string;
  requesterId: string;
  neededBy: string;
  urgency: string;
  description: string | null;
  currency: string;
  totalEstimatedRappen: number;
  lines: Line[];
  approvalEvents: ApprovalEvent[];
  conversions: Conversion[];
}
interface NamedRow {
  id: string;
  label: string;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function parseSummaries(body: unknown): Requisition[] | null {
  const rows = (body as { requisitions?: unknown })?.requisitions;
  if (!Array.isArray(rows)) return null;
  const out: Requisition[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.number !== 'string') return null;
    out.push({
      id: r.id,
      number: r.number,
      status: str(r.status, 'draft'),
      requesterId: str(r.requesterId),
      neededBy: str(r.neededBy),
      urgency: str(r.urgency, 'normal'),
      description: typeof r.description === 'string' ? r.description : null,
      currency: str(r.currency, 'CHF'),
      totalEstimatedRappen: num(r.totalEstimatedRappen),
      lines: [],
      approvalEvents: [],
      conversions: [],
    });
  }
  return out;
}

function parseLine(raw: unknown): Line | null {
  if (raw === null || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.id !== 'string') return null;
  return {
    id: l.id,
    lineNo: num(l.lineNo),
    itemId: typeof l.itemId === 'string' ? l.itemId : null,
    description: str(l.description),
    qtyMilli: num(l.qtyMilli),
    estimatedUnitCostRappen: num(l.estimatedUnitCostRappen),
    estimatedTotalRappen: num(l.estimatedTotalRappen),
    preferredSupplierId: typeof l.preferredSupplierId === 'string' ? l.preferredSupplierId : null,
    convertedQtyMilli: num(l.convertedQtyMilli),
    openQtyMilli: num(l.openQtyMilli),
  };
}

function parseDetail(body: unknown): Requisition | null {
  const r = (body as { requisition?: unknown })?.requisition;
  if (r === null || typeof r !== 'object') return null;
  const summary = parseSummaries({ requisitions: [r] });
  if (summary === null || summary.length === 0) return null;
  const rec = r as Record<string, unknown>;
  const lines = Array.isArray(rec.lines) ? rec.lines.map(parseLine).filter((l): l is Line => l !== null) : [];
  const events = Array.isArray(rec.approvalEvents)
    ? rec.approvalEvents
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
        .map((e) => ({
          id: str(e.id),
          decision: str(e.decision),
          comment: typeof e.comment === 'string' ? e.comment : null,
          createdAt: str(e.createdAt),
          actorId: typeof e.actorId === 'string' ? e.actorId : null,
        }))
    : [];
  const conversions = Array.isArray(rec.conversions)
    ? rec.conversions
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
        .map((c) => ({ id: str(c.id), purchaseOrderId: str(c.purchaseOrderId) }))
    : [];
  return { ...summary[0], lines, approvalEvents: events, conversions };
}

function parseNamed(body: unknown, key: string, label: (r: Record<string, unknown>) => string): NamedRow[] {
  const rows = (body as Record<string, unknown>)?.[key];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: str(r.id), label: label(r) }))
    .filter((r) => r.id !== '');
}

interface DraftLine {
  itemId: string;
  description: string;
  qty: string;
  unitCost: string;
  supplierId: string;
}
const EMPTY_LINE: DraftLine = { itemId: '', description: '', qty: '', unitCost: '', supplierId: '' };
interface Draft {
  neededBy: string;
  urgency: Urgency;
  description: string;
  costCenterId: string;
  lines: DraftLine[];
}
const EMPTY_DRAFT: Draft = { neededBy: '', urgency: 'normal', description: '', costCenterId: '', lines: [{ ...EMPTY_LINE }] };

export function Requisitions() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [rows, setRows] = useState<Requisition[]>([]);
  const [items, setItems] = useState<NamedRow[]>([]);
  const [vendors, setVendors] = useState<NamedRow[]>([]);
  const [costCenters, setCostCenters] = useState<NamedRow[]>([]);
  const [showAll, setShowAll] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [drawer, setDrawer] = useState<'closed' | 'create'>('closed');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [detail, setDetail] = useState<Requisition | null>(null);
  const [decisionText, setDecisionText] = useState('');
  const [converting, setConverting] = useState(false);
  const [convertQty, setConvertQty] = useState<Record<string, string>>({});
  const [convertSupplier, setConvertSupplier] = useState('');
  const [convertAs, setConvertAs] = useState<'draft' | 'sent'>('draft');

  const canWrite = can(CAP.manageMasterData);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, its, vends, ccs] = await Promise.all([
      client.call('requisition_list', { workspaceId }),
      client.call('list_items', { workspaceId }),
      client.call('list_contacts', { workspaceId, partyRole: 'vendor' }),
      client.call('list_cost_centers', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseSummaries(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setRows(parsed);
    if (!isErr(its.body)) setItems(parseNamed(its.body, 'items', (r) => `${str(r.name)}`));
    if (!isErr(vends.body)) setVendors(parseNamed(vends.body, 'contacts', (r) => `${str(r.name)}`));
    if (!isErr(ccs.body)) setCostCenters(parseNamed(ccs.body, 'costCenters', (r) => `${str(r.code)} ${str(r.name)}`));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Requisition | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return null;
      }
      await load();
      return parseDetail(response.body);
    },
    [client, workspaceId, load],
  );

  const visible = useMemo(
    () => (showAll ? rows : rows.filter((r) => r.status === 'draft' || r.status === 'pending_approval' || r.status === 'approved')),
    [rows, showAll],
  );

  const openCreate = () => {
    setWriteError(null);
    setDraft(EMPTY_DRAFT);
    setDrawer('create');
  };
  const closeDrawer = () => setDrawer('closed');

  const submitCreate = useCallback(async () => {
    const lines = draft.lines
      .map((l) => {
        const units = Number(l.qty);
        if (!Number.isFinite(units) || units <= 0) return null;
        return {
          itemId: l.itemId === '' ? undefined : l.itemId,
          description: l.description.trim() || (items.find((i) => i.id === l.itemId)?.label ?? ''),
          qtyMilli: Math.round(units * MILLI),
          estimatedUnitCostRappen: l.unitCost.trim() === '' ? 0 : Math.round(Number(l.unitCost) * 100),
          preferredSupplierId: l.supplierId === '' ? undefined : l.supplierId,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    const created = await write('requisition_upsert', {
      neededBy: draft.neededBy,
      urgency: draft.urgency,
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      costCenterId: draft.costCenterId === '' ? undefined : draft.costCenterId,
      lines,
      idempotencyKey: newKey(),
    });
    if (created !== null) closeDrawer();
  }, [write, draft, items]);

  const openDetail = useCallback(
    async (id: string) => {
      if (workspaceId === null) return;
      setWriteError(null);
      setDecisionText('');
      setConverting(false);
      const response = await client.call('requisition_get', { workspaceId, requisitionId: id });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      setDetail(parseDetail(response.body));
    },
    [client, workspaceId],
  );

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      if (detail === null) return;
      const updated = await write(action, { requisitionId: detail.id, idempotencyKey: newKey(), ...extra });
      if (updated !== null) {
        setDetail(updated);
        setDecisionText('');
      }
    },
    [write, detail],
  );

  const startConvert = () => {
    if (detail === null) return;
    const seed: Record<string, string> = {};
    for (const l of detail.lines) if (l.openQtyMilli > 0) seed[l.id] = String(l.openQtyMilli / MILLI);
    setConvertQty(seed);
    setConvertSupplier(detail.lines.find((l) => l.preferredSupplierId)?.preferredSupplierId ?? '');
    setConvertAs('draft');
    setConverting(true);
  };

  const submitConvert = useCallback(async () => {
    if (detail === null) return;
    const lines = Object.entries(convertQty)
      .map(([lineId, q]) => ({ lineId, qtyMilli: Math.round(Number(q) * MILLI) }))
      .filter((l) => Number.isFinite(l.qtyMilli) && l.qtyMilli > 0);
    if (lines.length === 0) return;
    const updated = await write('requisition_convert_to_po', {
      requisitionId: detail.id,
      lines,
      supplierContactId: convertSupplier === '' ? undefined : convertSupplier,
      createAs: convertAs,
      idempotencyKey: newKey(),
    });
    if (updated !== null) {
      setDetail(updated);
      setConverting(false);
    }
  }, [write, detail, convertQty, convertSupplier, convertAs]);

  if (workspaceId === null) return <NoWorkspaceState body={t('requisitions.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('requisitions.title')} />;

  const addLine = () => setDraft((d) => ({ ...d, lines: [...d.lines, { ...EMPTY_LINE }] }));
  const removeLine = (i: number) => setDraft((d) => ({ ...d, lines: d.lines.filter((_, k) => k !== i) }));
  const patchLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  const s = detail?.status;

  // The list columns: text left, the estimate a numeric right-aligned `.t-num` cell. A terminal row
  // (rejected, cancelled, closed) dims via the rowClassName hook; the badge still carries the status.
  const columns: DataTableColumn<Requisition>[] = [
    { key: 'number', header: t('requisitions.col.number'), render: (r) => <span className="req-code">{r.number}</span> },
    {
      key: 'status',
      header: t('requisitions.col.status'),
      render: (r) => <span className={`req-badge req-badge-${r.status}`}>{t(`requisitions.status.${r.status}`)}</span>,
    },
    { key: 'requester', header: t('requisitions.col.requester'), render: (r) => r.requesterId },
    { key: 'neededBy', header: t('requisitions.col.neededBy'), render: (r) => r.neededBy },
    { key: 'urgency', header: t('requisitions.col.urgency'), render: (r) => t(`requisitions.urgency.${r.urgency}`) },
    { key: 'total', header: t('requisitions.col.total'), numeric: true, render: (r) => money(r.totalEstimatedRappen) },
  ];

  const isTerminal = (status: string) => status === 'rejected' || status === 'cancelled' || status === 'closed';

  // The show-all toggle filters the list; there is no search row and inventing one is out of scope
  // (D118 B2), so it rides the SurfaceHeader actions beside the primary create action rather than a
  // FilterBar.
  const headerActions = (
    <>
      <label className="req-toggle">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        {t('requisitions.showAll')}
      </label>
      <button type="button" className="btn btn--primary" onClick={openCreate} disabled={!canWrite}>
        {t('requisitions.new')}
      </button>
    </>
  );

  // The detail drawer's pinned action row, assembled per status. Empty (a terminal record) leaves the
  // foot off entirely; the header close control still closes the drawer.
  const detailActions: ReactNode[] = [];
  if (s === 'draft') {
    detailActions.push(
      <button key="submit" type="button" className="btn btn--primary" onClick={() => void act('requisition_submit')} disabled={!canWrite}>
        {t('requisitions.action.submit')}
      </button>,
    );
  }
  if (s === 'pending_approval') {
    detailActions.push(
      <button key="approve" type="button" className="btn btn--primary" onClick={() => void act('requisition_approve', { comment: decisionText || undefined })} disabled={!canWrite}>
        {t('requisitions.action.approve')}
      </button>,
      <button key="return" type="button" className="btn btn--ghost" onClick={() => void act('requisition_return', { reason: decisionText })} disabled={!canWrite}>
        {t('requisitions.action.return')}
      </button>,
      <button key="reject" type="button" className="btn btn--danger" onClick={() => void act('requisition_reject', { reason: decisionText })} disabled={!canWrite}>
        {t('requisitions.action.reject')}
      </button>,
    );
  }
  if ((s === 'approved' || s === 'partially_converted') && !converting) {
    detailActions.push(
      <button key="convert" type="button" className="btn btn--primary" onClick={startConvert} disabled={!canWrite}>
        {t('requisitions.action.convert')}
      </button>,
    );
  }
  if (s === 'converted' || s === 'partially_converted') {
    detailActions.push(
      <button key="close" type="button" className="btn btn--ghost" onClick={() => void act('requisition_close')} disabled={!canWrite}>
        {t('requisitions.action.close')}
      </button>,
    );
  }
  if ((s === 'draft' || s === 'pending_approval' || s === 'approved') && detail !== null && detail.conversions.length === 0) {
    detailActions.push(
      <button key="cancel" type="button" className="btn btn--danger" onClick={() => void act('requisition_cancel')} disabled={!canWrite}>
        {t('requisitions.action.cancel')}
      </button>,
    );
  }

  return (
    <div className="req">
      <SurfaceHeader title={t('requisitions.title')} help={<SurfaceHelp surface="Requisitions" />} actions={headerActions} />

      {failed && <ErrorBanner message={t('requisitions.error.transport')} onRetry={() => void load()} />}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(r) => r.id}
        caption={t('requisitions.list.caption')}
        loading={loading}
        skeletonRows={4}
        onRowClick={(r) => void openDetail(r.id)}
        rowLabel={(r) => r.number}
        rowClassName={(r) => (isTerminal(r.status) ? 'req-row--terminal' : undefined)}
        emptyState={
          <EmptyState
            title={t('requisitions.empty.title')}
            hint={t('requisitions.empty.hint')}
            action={canWrite ? { label: t('requisitions.empty.cta'), onClick: openCreate } : undefined}
          />
        }
      />

      {drawer === 'create' && (
        <DetailDrawer
          open
          onClose={closeDrawer}
          title={t('requisitions.new')}
          closeLabel={t('requisitions.action.back')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={closeDrawer}>
                {t('requisitions.action.back')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitCreate()} disabled={!canWrite}>
                {t('requisitions.action.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} />}
          <div className="req-field">
            <label htmlFor="req-needed">{t('requisitions.field.neededBy')}</label>
            <input
              id="req-needed"
              type="date"
              value={draft.neededBy}
              onChange={(e) => setDraft({ ...draft, neededBy: e.target.value })}
            />
          </div>
          <div className="req-field">
            <label htmlFor="req-urgency">{t('requisitions.field.urgency')}</label>
            <select
              id="req-urgency"
              value={draft.urgency}
              onChange={(e) => setDraft({ ...draft, urgency: e.target.value as Urgency })}
            >
              {URGENCIES.map((u) => (
                <option key={u} value={u}>
                  {t(`requisitions.urgency.${u}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="req-field">
            <label htmlFor="req-desc">{t('requisitions.field.description')}</label>
            <input id="req-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <div className="req-field">
            <label htmlFor="req-cc">{t('requisitions.field.costCenter')}</label>
            <select id="req-cc" value={draft.costCenterId} onChange={(e) => setDraft({ ...draft, costCenterId: e.target.value })}>
              <option value="">{t('requisitions.field.none')}</option>
              {costCenters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <h3 className="req-lines-title">{t('requisitions.detail.lines')}</h3>
          {draft.lines.map((l, i) => (
            <div className="req-line-draft" key={i}>
              <select
                aria-label={`${t('requisitions.field.item')} ${i + 1}`}
                value={l.itemId}
                onChange={(e) => patchLine(i, { itemId: e.target.value })}
              >
                <option value="">{t('requisitions.field.freeText')}</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`${t('requisitions.field.description')} ${i + 1}`}
                placeholder={t('requisitions.field.description')}
                value={l.description}
                onChange={(e) => patchLine(i, { description: e.target.value })}
              />
              <input
                aria-label={`${t('requisitions.field.qty')} ${i + 1}`}
                type="number"
                min={0}
                placeholder={t('requisitions.field.qty')}
                value={l.qty}
                onChange={(e) => patchLine(i, { qty: e.target.value })}
              />
              <input
                aria-label={`${t('requisitions.field.unitCost')} ${i + 1}`}
                type="number"
                min={0}
                step="0.01"
                placeholder={t('requisitions.field.unitCost')}
                value={l.unitCost}
                onChange={(e) => patchLine(i, { unitCost: e.target.value })}
              />
              <select
                aria-label={`${t('requisitions.field.supplier')} ${i + 1}`}
                value={l.supplierId}
                onChange={(e) => patchLine(i, { supplierId: e.target.value })}
              >
                <option value="">{t('requisitions.field.none')}</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              {draft.lines.length > 1 && (
                <button type="button" className="btn btn--ghost" onClick={() => removeLine(i)}>
                  {t('requisitions.action.removeLine')}
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn--ghost" onClick={addLine}>
            {t('requisitions.action.addLine')}
          </button>
        </DetailDrawer>
      )}

      {/* C3: the provenance line (who requested this and when, from the first approval event) now
          rides the DetailDrawer's quiet provenance slot, below the body and above the actions. */}
      {detail !== null && (
        <DetailDrawer
          open
          onClose={() => setDetail(null)}
          title={detail.number}
          closeLabel={t('requisitions.action.back')}
          headerExtra={
            <span className={`req-badge req-badge-${detail.status}`}>{t(`requisitions.status.${detail.status}`)}</span>
          }
          provenance={
            detail.approvalEvents.length > 0 ? (
              <Provenance origin="human" actor={detail.requesterId} timestamp={detail.approvalEvents[0].createdAt} />
            ) : undefined
          }
          footer={detailActions.length > 0 ? <>{detailActions}</> : undefined}
        >
          {writeError && <ErrorBanner error={writeError} />}

          <h3 className="req-lines-title">{t('requisitions.detail.lines')}</h3>
          <table className="req-detail-table">
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td className="req-num">{l.qtyMilli / MILLI}</td>
                  <td className="req-num">
                    {t('requisitions.detail.open')} {l.openQtyMilli / MILLI}
                  </td>
                  <td className="req-num">{money(l.estimatedTotalRappen)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="req-lines-title">{t('requisitions.detail.timeline')}</h3>
          {detail.approvalEvents.length === 0 ? (
            <p className="req-muted">{t('requisitions.detail.noEvents')}</p>
          ) : (
            <ul className="req-timeline">
              {detail.approvalEvents.map((e) => (
                <li key={e.id}>
                  <strong>{t(`requisitions.event.${e.decision}`)}</strong>
                  {e.comment ? ` - ${e.comment}` : ''} <span className="req-muted">{e.createdAt.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}

          {detail.conversions.length > 0 && (
            <>
              <h3 className="req-lines-title">{t('requisitions.detail.conversions')}</h3>
              <ul className="req-timeline">
                {detail.conversions.map((c) => (
                  <li key={c.id}>
                    {t('requisitions.detail.po')} {c.purchaseOrderId}
                  </li>
                ))}
              </ul>
            </>
          )}

          {(s === 'pending_approval' || s === 'rejected') && (
            <div className="req-field">
              <label htmlFor="req-decision">
                {s === 'pending_approval' ? t('requisitions.field.reason') : t('requisitions.field.comment')}
              </label>
              <input id="req-decision" value={decisionText} onChange={(e) => setDecisionText(e.target.value)} />
            </div>
          )}

          {converting && s !== undefined && (
            <div className="req-convert" role="group" aria-label={t('requisitions.convert.title')}>
              <p className="req-muted">{t('requisitions.convert.help')}</p>
              {detail.lines
                .filter((l) => l.openQtyMilli > 0)
                .map((l) => (
                  <div className="req-field" key={l.id}>
                    <label htmlFor={`req-cv-${l.id}`}>
                      {l.description} ({t('requisitions.detail.open')} {l.openQtyMilli / MILLI})
                    </label>
                    <input
                      id={`req-cv-${l.id}`}
                      type="number"
                      min={0}
                      value={convertQty[l.id] ?? ''}
                      onChange={(e) => setConvertQty({ ...convertQty, [l.id]: e.target.value })}
                    />
                  </div>
                ))}
              <div className="req-field">
                <label htmlFor="req-cv-supplier">{t('requisitions.field.supplier')}</label>
                <select id="req-cv-supplier" value={convertSupplier} onChange={(e) => setConvertSupplier(e.target.value)}>
                  <option value="">{t('requisitions.field.choose')}</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="req-field">
                <label htmlFor="req-cv-as">{t('requisitions.field.createAs')}</label>
                <select id="req-cv-as" value={convertAs} onChange={(e) => setConvertAs(e.target.value as 'draft' | 'sent')}>
                  <option value="draft">{t('requisitions.field.createDraft')}</option>
                  <option value="sent">{t('requisitions.field.createSent')}</option>
                </select>
              </div>
              <button type="button" className="btn btn--primary" onClick={() => void submitConvert()} disabled={!canWrite}>
                {t('requisitions.action.confirmConvert')}
              </button>
            </div>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
