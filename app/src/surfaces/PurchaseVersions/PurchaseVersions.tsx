/**
 * I01, Einkauf -> Bestellversionen (`/po-versions`): the OP14 versioning + amendment surface over a
 * live D02 purchase order. A dense list of purchase orders (number, status glyph + label, total) opens
 * a detail drawer carrying the immutable version timeline (1..N, active | superseded, the amendment
 * reason that produced each) and an AMEND workspace: edit the open lines' quantity and price, PREVIEW
 * the committed-value impact and its violations, then APPLY (mints version N+1 and re-renders the
 * P8 outbound artifact, never transmitting) or SUBMIT for approval. Cancel abandons with no side effect.
 *
 * NO auto-transmit: apply returns { transmitted:false }; the amended PDF reaches the supplier only
 * through the approval dial. THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): the
 * write controls disable behind `manage_master_data`, and the engine is the real gate. Status is glyph
 * + label, never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The purchase-order list is the shared `DataTable` (frame overflow, sticky header, density and the
 * five states in one place), row-click driving the detail drawer; the total is a numeric,
 * right-aligned `.t-num` cell. The page header is the shared `SurfaceHeader`, and the detail overlay
 * is the shared `DetailDrawer`, which adds the focus trap, Escape and scrim the bespoke panel lacked;
 * the status chip rides its `headerExtra` slot and the lifecycle buttons ride the pinned `footer`. The
 * per-surface CSS that duplicated the list table, the header, the drawer chrome and the button set is
 * gone; what remains is genuinely PurchaseVersions-specific: the status badges, the version timeline,
 * the amend line grid and the impact box.
 *
 * No `Provenance` (C3): the version read model carries a reason per version but no actor or timestamp,
 * so there is nothing to attribute. No `ConsequenceLine` (C4): the amend verbs return their impact
 * inline (the committed-value delta and violations already shown in the impact box), so there is no
 * separate engine consequence sentence to render. No `FilterBar`: the list has no search or filter
 * dimension and inventing one is out of scope.
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
import './PurchaseVersions.css';

const newKey = () => crypto.randomUUID();
// K-71: money is formatted through the shared `formatMoney(minor, currency)` so the currency is the
// row's own (a EUR purchase order reads EUR, never a hardcoded CHF) and de-CH thousands grouping is
// applied once, in one place. `signedMoney` only adds the leading `+` a delta wants; the minus and
// the grouping both come from `formatMoney`.
const signedMoney = (minor: number, currency: string): string =>
  `${minor > 0 ? '+' : ''}${formatMoney(minor, currency)}`;

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

interface PoSummary {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalRappen: number;
}
interface PoLine {
  id: string;
  description: string;
  qty: number;
  unitPriceRappen: number;
  receivedQty: number;
  openQty: number;
}
interface Version {
  id: string;
  versionNumber: number;
  status: string;
  reason: string | null;
  totalRappen: number;
  currency: string;
}
interface ImpactLine {
  poLineId: string | null;
  op: string;
  beforeQty: number | null;
  afterQty: number | null;
  beforeUnitPriceRappen: number | null;
  afterUnitPriceRappen: number | null;
  violation: string | null;
}
interface Impact {
  lines: ImpactLine[];
  committedValueDeltaRappen: number;
  violations: { code: string; poLineId: string | null }[];
  applicable: boolean;
}

function parseSummaries(body: unknown): PoSummary[] | null {
  const rows = (body as { pos?: unknown })?.pos;
  if (!Array.isArray(rows)) return null;
  const out: PoSummary[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.number !== 'string') return null;
    out.push({ id: r.id, number: r.number, status: str(r.status, 'draft'), currency: str(r.currency, 'CHF'), totalRappen: num(r.totalRappen) });
  }
  return out;
}

function parseLines(body: unknown): PoLine[] {
  const rows = (body as { lines?: unknown })?.lines;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((l): l is Record<string, unknown> => l !== null && typeof l === 'object' && typeof l.id === 'string')
    .map((l) => ({
      id: l.id as string,
      description: str(l.description),
      qty: num(l.qty),
      unitPriceRappen: num(l.unitPriceRappen),
      receivedQty: num(l.receivedQty),
      openQty: num(l.openQty),
    }));
}

function parseVersions(body: unknown): Version[] {
  const rows = (body as { versions?: unknown })?.versions;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && typeof v.id === 'string')
    .map((v) => ({
      id: v.id as string,
      versionNumber: num(v.versionNumber),
      status: str(v.status, 'active'),
      reason: typeof v.reason === 'string' ? v.reason : null,
      totalRappen: num(v.totalRappen),
      currency: str(v.currency, 'CHF'),
    }));
}

function parseImpact(body: unknown): Impact | null {
  const raw = (body as { impact?: unknown })?.impact;
  if (raw === null || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  const lines = Array.isArray(i.lines)
    ? i.lines
        .filter((l): l is Record<string, unknown> => l !== null && typeof l === 'object')
        .map((l) => ({
          poLineId: typeof l.poLineId === 'string' ? l.poLineId : null,
          op: str(l.op),
          beforeQty: typeof l.beforeQty === 'number' ? l.beforeQty : null,
          afterQty: typeof l.afterQty === 'number' ? l.afterQty : null,
          beforeUnitPriceRappen: typeof l.beforeUnitPriceRappen === 'number' ? l.beforeUnitPriceRappen : null,
          afterUnitPriceRappen: typeof l.afterUnitPriceRappen === 'number' ? l.afterUnitPriceRappen : null,
          violation: typeof l.violation === 'string' ? l.violation : null,
        }))
    : [];
  const violations = Array.isArray(i.violations)
    ? i.violations
        .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
        .map((v) => ({ code: str(v.code), poLineId: typeof v.poLineId === 'string' ? v.poLineId : null }))
    : [];
  return { lines, committedValueDeltaRappen: num(i.committedValueDeltaRappen), violations, applicable: i.applicable === true };
}

/** The editable draft of one open line inside the amend workspace. */
interface EditLine {
  poLineId: string;
  description: string;
  qty: string;
  unitPrice: string;
}

export function PurchaseVersions() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [rows, setRows] = useState<PoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [detail, setDetail] = useState<PoSummary | null>(null);
  const [detailLines, setDetailLines] = useState<PoLine[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);

  const [amendmentId, setAmendmentId] = useState<string | null>(null);
  const [edits, setEdits] = useState<EditLine[]>([]);
  const [reason, setReason] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);

  const canWrite = can(CAP.manageMasterData);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('po_list', { workspaceId });
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
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshDetail = useCallback(
    async (po: PoSummary) => {
      if (workspaceId === null) return;
      const [got, vers] = await Promise.all([
        client.call('po_get', { workspaceId, poId: po.id }),
        client.call('po_version_list', { workspaceId, poId: po.id }),
      ]);
      if (!isErr(got.body)) {
        setDetailLines(parseLines(got.body));
        const poBody = (got.body as { po?: Record<string, unknown> }).po;
        if (poBody !== undefined) setDetail({ id: po.id, number: str(poBody.number, po.number), status: str(poBody.status, po.status), currency: str(poBody.currency, po.currency), totalRappen: num(poBody.totalRappen) });
      }
      if (!isErr(vers.body)) setVersions(parseVersions(vers.body));
    },
    [client, workspaceId],
  );

  const openDetail = useCallback(
    async (po: PoSummary) => {
      setWriteError(null);
      setAmendmentId(null);
      setImpact(null);
      setReason('');
      setDetail(po);
      await refreshDetail(po);
    },
    [refreshDetail],
  );

  const closeDetail = () => {
    setDetail(null);
    setAmendmentId(null);
    setImpact(null);
  };

  const startAmend = useCallback(async () => {
    if (workspaceId === null || detail === null) return;
    setWriteError(null);
    const res = await client.call('po_amendment_start', { workspaceId, poId: detail.id, reason: reason.trim() === '' ? undefined : reason.trim(), idempotencyKey: newKey() });
    if (isErr(res.body)) {
      setWriteError(res.body);
      return;
    }
    const amendment = (res.body as { amendment?: { id?: string } }).amendment;
    if (amendment?.id === undefined) return;
    setAmendmentId(amendment.id);
    setEdits(detailLines.map((l) => ({ poLineId: l.id, description: l.description, qty: String(l.qty), unitPrice: (l.unitPriceRappen / 100).toFixed(2) })));
    setImpact(null);
  }, [client, workspaceId, detail, detailLines, reason]);

  const preview = useCallback(async () => {
    if (workspaceId === null || amendmentId === null) return;
    setWriteError(null);
    const changes = edits
      .map((e) => {
        const qty = Number(e.qty);
        const price = Math.round(Number(e.unitPrice) * 100);
        return { op: 'change', poLineId: e.poLineId, qty: Number.isFinite(qty) ? qty : undefined, unitPriceRappen: Number.isFinite(price) ? price : undefined };
      });
    const upd = await client.call('po_amendment_update_lines', { workspaceId, amendmentId, changes, idempotencyKey: newKey() });
    if (isErr(upd.body)) {
      setWriteError(upd.body);
      return;
    }
    const prev = await client.call('po_amendment_preview', { workspaceId, amendmentId });
    if (isErr(prev.body)) {
      setWriteError(prev.body);
      return;
    }
    setImpact(parseImpact(prev.body));
  }, [client, workspaceId, amendmentId, edits]);

  const finish = useCallback(
    async (action: 'po_amendment_apply' | 'po_amendment_submit' | 'po_amendment_cancel') => {
      if (workspaceId === null || amendmentId === null || detail === null) return;
      setWriteError(null);
      const res = await client.call(action, { workspaceId, amendmentId, idempotencyKey: newKey() });
      if (isErr(res.body)) {
        setWriteError(res.body);
        return;
      }
      setAmendmentId(null);
      setImpact(null);
      setReason('');
      await refreshDetail(detail);
      await load();
    },
    [client, workspaceId, amendmentId, detail, refreshDetail, load],
  );

  const patchEdit = (poLineId: string, patch: Partial<EditLine>) =>
    setEdits((es) => es.map((e) => (e.poLineId === poLineId ? { ...e, ...patch } : e)));

  const canAmend = useMemo(() => detail !== null && (detail.status === 'sent' || detail.status === 'received'), [detail]);

  // The list columns: number and status left, the total a numeric right-aligned `.t-num` cell.
  const columns: DataTableColumn<PoSummary>[] = [
    { key: 'number', header: t('poVersions.col.number'), render: (r) => <span className="pov-code">{r.number}</span> },
    {
      key: 'status',
      header: t('poVersions.col.status'),
      render: (r) => <span className={`pov-badge pov-badge-${r.status}`}>{t(`poVersions.status.${r.status}`)}</span>,
    },
    { key: 'total', header: t('poVersions.col.total'), numeric: true, render: (r) => formatMoney(r.totalRappen, r.currency) },
  ];

  // The drawer's pinned action row, assembled per state: the amend affordance before a draft exists,
  // then the cancel/preview/submit/apply set once an amendment is open. The header close control
  // (Escape, the X, a scrim click) always closes the drawer.
  const detailActions: ReactNode[] =
    amendmentId === null
      ? canAmend
        ? [
            <button key="amend" type="button" className="btn btn--primary" onClick={() => void startAmend()} disabled={!canWrite}>
              {t('poVersions.action.amend')}
            </button>,
          ]
        : []
      : [
          <button key="cancel" type="button" className="btn btn--ghost" onClick={() => void finish('po_amendment_cancel')} disabled={!canWrite}>
            {t('poVersions.action.cancel')}
          </button>,
          <button key="preview" type="button" className="btn btn--secondary" onClick={() => void preview()} disabled={!canWrite}>
            {t('poVersions.action.preview')}
          </button>,
          <button key="submit" type="button" className="btn btn--ghost" onClick={() => void finish('po_amendment_submit')} disabled={!canWrite || impact === null || !impact.applicable}>
            {t('poVersions.action.submit')}
          </button>,
          <button key="apply" type="button" className="btn btn--primary" onClick={() => void finish('po_amendment_apply')} disabled={!canWrite || impact === null || !impact.applicable}>
            {t('poVersions.action.apply')}
          </button>,
        ];

  if (workspaceId === null) return <NoWorkspaceState body={t('poVersions.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('poVersions.title')} />;

  return (
    <div className="pov">
      <SurfaceHeader title={t('poVersions.title')} help={<SurfaceHelp surface="PurchaseVersions" />} />

      {failed && <ErrorBanner message={t('poVersions.error.transport')} onRetry={() => void load()} />}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        caption={t('poVersions.list.caption')}
        loading={loading}
        skeletonRows={4}
        onRowClick={(r) => void openDetail(r)}
        rowLabel={(r) => r.number}
        emptyState={<EmptyState title={t('poVersions.empty.title')} hint={t('poVersions.empty.hint')} />}
      />

      {detail !== null && (
        <DetailDrawer
          open
          onClose={closeDetail}
          title={detail.number}
          closeLabel={t('poVersions.action.back')}
          headerExtra={
            <span className={`pov-badge pov-badge-${detail.status}`}>{t(`poVersions.status.${detail.status}`)}</span>
          }
          footer={detailActions.length > 0 ? <>{detailActions}</> : undefined}
        >
          {writeError && <ErrorBanner error={writeError} />}

          <h3 className="pov-section-title">{t('poVersions.versions.title')}</h3>
          {versions.length === 0 ? (
            <p className="pov-muted">{t('poVersions.versions.empty')}</p>
          ) : (
            <ul className="pov-timeline">
              {versions.map((v) => (
                <li key={v.id}>
                  <strong>{t('poVersions.versions.version')} {v.versionNumber}</strong>{' '}
                  <span className={`pov-badge pov-badge-${v.status}`}>{t(`poVersions.vstatus.${v.status}`)}</span>{' '}
                  <span className="pov-num">{formatMoney(v.totalRappen, v.currency)}</span>
                  {v.reason ? <span className="pov-muted"> - {v.reason}</span> : ''}
                </li>
              ))}
            </ul>
          )}

          {amendmentId !== null && (
            <div className="pov-amend" role="group" aria-label={t('poVersions.amend.title')}>
              <h3 className="pov-section-title">{t('poVersions.amend.title')}</h3>
              <div className="pov-field">
                <label htmlFor="pov-reason">{t('poVersions.amend.reason')}</label>
                <input id="pov-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              {edits.map((e, i) => (
                <div className="pov-edit-line" key={e.poLineId}>
                  <span className="pov-edit-desc">{e.description}</span>
                  <input
                    aria-label={`${t('poVersions.amend.qty')} ${i + 1}`}
                    type="number"
                    min={0}
                    value={e.qty}
                    onChange={(ev) => patchEdit(e.poLineId, { qty: ev.target.value })}
                  />
                  <input
                    aria-label={`${t('poVersions.amend.unitPrice')} ${i + 1}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={e.unitPrice}
                    onChange={(ev) => patchEdit(e.poLineId, { unitPrice: ev.target.value })}
                  />
                </div>
              ))}

              {impact !== null && (
                <div className="pov-impact" role="group" aria-label={t('poVersions.amend.impactTitle')}>
                  <p className="pov-impact-delta">
                    {t('poVersions.amend.delta')}: <strong>{signedMoney(impact.committedValueDeltaRappen, detail.currency)}</strong>
                  </p>
                  {impact.violations.length > 0 && (
                    <ul className="pov-violations">
                      {impact.violations.map((v, k) => (
                        <li key={k} className="pov-violation">{t(`poVersions.violation.${v.code}`)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
