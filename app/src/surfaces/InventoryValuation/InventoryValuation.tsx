/**
 * J03, Inventory -> Bewertung (`/inventory-valuation`): the surface over the valuation basis and the
 * figure it produces. Three panes on one route (spec §6, reconciliation item 8):
 *
 *  1. METHODS. Every registered method with its description, an enable toggle, and the workspace
 *     default with the date it took effect. The list is READ FROM THE ENGINE
 *     (`inventory_valuation_methods`), not restated here: a surface that carried its own copy of a
 *     §H-ENUM would be a mirror to keep in step, and the verb already answers the question.
 *  2. COSTING, per item. On-hand, unit cost, total value, the FIFO layer table when the effective
 *     method is fifo, the "Bewertung per" date picker that re-runs the pure preview at any as-of
 *     date, and the OR 960c net-realisable-value field that applies the write-down live.
 *  3. HISTORY. The append-only assignment trail, which is the OR 958c Stetigkeit evidence.
 *
 * NOTHING HERE WRITES A FIGURE. The four reads are pure and the three writes touch policy only; the
 * valuation reaches the books through J06. After a policy write the surface re-reads rather than
 * patching state locally, so what it shows is always what the engine would answer.
 *
 * A method change is DATED: the form asks for the date it takes effect, because that is what the
 * engine's period lock answers to. When the engine refuses (a closed period, movements the change
 * would restate) the reason is shown as written, never swallowed.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and
 * the engine is the real gate. Write controls disable behind `manage_master_data`; a click that slips
 * through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import './InventoryValuation.css';

/** The J03 rejection codes with a surface-scoped message. Others fall through to the global mapping. */
const J03_ERROR_CODES = new Set([
  'method_disabled',
  'method_is_default',
  'method_change_blocked_open_period',
  'missing_standard_cost',
  'unknown_method',
  'period_locked',
]);

const today = (): string => new Date().toISOString().slice(0, 10);
const newKey = (): string => crypto.randomUUID();

interface Item {
  id: string;
  name: string;
}
interface MethodRow {
  method: string;
  enabled: boolean;
  requiresStandardCost: boolean;
  isDefault: boolean;
}
interface Layer {
  sourceMovementId: string;
  receiptDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostMinor: number;
}
interface ValuationRow {
  itemId: string;
  itemName: string;
  method: string;
  methodSource: string;
  methodEffectiveFrom: string | null;
  qtyOnHand: number;
  costedQty: number;
  uncostedQty: number;
  unitCostMinor: number | null;
  totalValueMinor: number;
  layers: Layer[];
  lcmApplied: boolean;
  writeDownMinor: number;
  varianceMinor: number | null;
  reason: string | null;
  warnings: string[];
  missingCostMovementIds: string[];
  valuationBasis: string;
}
interface Assignment {
  id: string;
  scope: string;
  itemId: string | null;
  method: string;
  effectiveFrom: string;
  reason: string | null;
  forceRevaluation: boolean;
  createdBy: string | null;
}

function parseItems(body: unknown): Item[] {
  const rows = (body as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];
  const out: Item[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    if (r.trackStock !== true) continue;
    out.push({ id: r.id, name: r.name });
  }
  return out;
}

function parseMethods(body: unknown): MethodRow[] {
  const rows = (body as { methods?: unknown })?.methods;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      method: String(r.method ?? ''),
      enabled: r.enabled === true,
      requiresStandardCost: r.requiresStandardCost === true,
      isDefault: r.isDefault === true,
    }))
    .filter((m) => m.method !== '');
}

function parseLayers(raw: unknown): Layer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Record<string, unknown> => l !== null && typeof l === 'object')
    .map((l) => ({
      sourceMovementId: String(l.sourceMovementId ?? ''),
      receiptDate: String(l.receiptDate ?? ''),
      originalQty: typeof l.originalQty === 'number' ? l.originalQty : 0,
      remainingQty: typeof l.remainingQty === 'number' ? l.remainingQty : 0,
      unitCostMinor: typeof l.unitCostMinor === 'number' ? l.unitCostMinor : 0,
    }));
}

function parseValuation(body: unknown): ValuationRow[] {
  const rows = (body as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      itemId: String(r.itemId ?? ''),
      itemName: String(r.itemName ?? ''),
      method: String(r.method ?? ''),
      methodSource: String(r.methodSource ?? ''),
      methodEffectiveFrom: typeof r.methodEffectiveFrom === 'string' ? r.methodEffectiveFrom : null,
      qtyOnHand: typeof r.qtyOnHand === 'number' ? r.qtyOnHand : 0,
      costedQty: typeof r.costedQty === 'number' ? r.costedQty : 0,
      uncostedQty: typeof r.uncostedQty === 'number' ? r.uncostedQty : 0,
      unitCostMinor: typeof r.unitCostMinor === 'number' ? r.unitCostMinor : null,
      totalValueMinor: typeof r.totalValueMinor === 'number' ? r.totalValueMinor : 0,
      layers: parseLayers(r.layers),
      lcmApplied: r.lcmApplied === true,
      writeDownMinor: typeof r.writeDownMinor === 'number' ? r.writeDownMinor : 0,
      varianceMinor: typeof r.varianceMinor === 'number' ? r.varianceMinor : null,
      reason: typeof r.reason === 'string' ? r.reason : null,
      warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [],
      missingCostMovementIds: Array.isArray(r.missingCostMovementIds)
        ? r.missingCostMovementIds.filter((m): m is string => typeof m === 'string')
        : [],
      valuationBasis: typeof r.valuationBasis === 'string' ? r.valuationBasis : 'direct',
    }));
}

function parseAssignments(body: unknown): Assignment[] {
  const rows = (body as { assignments?: unknown })?.assignments;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      scope: String(r.scope ?? ''),
      itemId: typeof r.itemId === 'string' ? r.itemId : null,
      method: String(r.method ?? ''),
      effectiveFrom: String(r.effectiveFrom ?? ''),
      reason: typeof r.reason === 'string' ? r.reason : null,
      forceRevaluation: r.forceRevaluation === true,
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    }));
}

export function InventoryValuation() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [items, setItems] = useState<Item[]>([]);
  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [defaultMethod, setDefaultMethod] = useState<string>('');
  const [defaultEffectiveFrom, setDefaultEffectiveFrom] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valuation, setValuation] = useState<ValuationRow | null>(null);
  const [totalValueMinor, setTotalValueMinor] = useState(0);

  const [asOf, setAsOf] = useState<string>(today());
  const [nrv, setNrv] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [defaultDrawer, setDefaultDrawer] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState({ method: '', effectiveFrom: today(), reason: '', forceRevaluation: false });

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  const localError = useCallback(
    (e: Err | null): string | undefined => (e !== null && J03_ERROR_CODES.has(e.error) ? t(`invValuation.errors.${e.error}`) : undefined),
    [t],
  );

  const loadBase = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [itemsRes, methodsRes, historyRes, rollupRes] = await Promise.all([
      client.call('list_items', { workspaceId }),
      client.call('inventory_valuation_methods', { workspaceId }),
      client.call('inventory_valuation_method_history', { workspaceId }),
      client.call('inventory_valuation_preview', { workspaceId }),
    ]);
    if (isErr(itemsRes.body)) {
      if (itemsRes.body.error === 'permission_denied' || itemsRes.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseItems(itemsRes.body);
    setItems(parsed);
    if (!isErr(methodsRes.body)) {
      const body = methodsRes.body as { defaultMethod?: string; defaultEffectiveFrom?: string | null };
      setMethods(parseMethods(methodsRes.body));
      setDefaultMethod(body.defaultMethod ?? '');
      setDefaultEffectiveFrom(body.defaultEffectiveFrom ?? null);
    }
    setAssignments(isErr(historyRes.body) ? [] : parseAssignments(historyRes.body));
    setTotalValueMinor(isErr(rollupRes.body) ? 0 : ((rollupRes.body as { totalValueMinor?: number }).totalValueMinor ?? 0));
    setSelectedId((prev) => (prev !== null && parsed.some((i) => i.id === prev) ? prev : (parsed[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (item: Item, at: string, netRealisable: string) => {
      if (workspaceId === null) return;
      setDetailLoading(true);
      const parsedNrv = Number.parseInt(netRealisable, 10);
      const response = await client.call('inventory_valuation_preview', {
        workspaceId,
        itemIds: [item.id],
        asOf: at,
        ...(Number.isInteger(parsedNrv) ? { netRealisableValues: { [item.id]: parsedNrv } } : {}),
      });
      setValuation(isErr(response.body) ? null : (parseValuation(response.body)[0] ?? null));
      setDetailLoading(false);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (selected !== null) void loadDetail(selected, asOf, nrv);
    else setValuation(null);
  }, [selected, asOf, nrv, loadDetail]);

  const refresh = useCallback(async () => {
    await loadBase();
    if (selected !== null) await loadDetail(selected, asOf, nrv);
  }, [loadBase, loadDetail, selected, asOf, nrv]);

  const toggleMethod = useCallback(
    async (method: string, enabled: boolean) => {
      if (workspaceId === null) return;
      setWriteError(null);
      const response = await client.call('inventory_valuation_method_set_enabled', {
        workspaceId,
        method,
        enabled,
        idempotencyKey: newKey(),
      });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      await refresh();
    },
    [client, workspaceId, refresh],
  );

  const submitDefault = useCallback(async () => {
    if (workspaceId === null) return;
    setWriteError(null);
    const response = await client.call('inventory_valuation_set_default', {
      workspaceId,
      method: defaultDraft.method,
      effectiveFrom: defaultDraft.effectiveFrom,
      // The engine refuses a change that would restate movements already on the ledger unless BOTH
      // are present, so the form offers both rather than letting an operator meet a refusal with no
      // way to answer it.
      forceRevaluation: defaultDraft.forceRevaluation,
      reason: defaultDraft.reason.trim() === '' ? undefined : defaultDraft.reason.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    setDefaultDrawer(false);
    await refresh();
  }, [client, workspaceId, defaultDraft, refresh]);

  if (workspaceId === null) return <NoWorkspaceState body={t('invValuation.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('invValuation.title')} />;

  // The method registry, read from the engine, as a shared DataTable. The enable toggle and the
  // default badge ride the cell render; nothing here is a figure, so no column is numeric.
  const methodColumns: DataTableColumn<MethodRow>[] = [
    { key: 'method', header: t('invValuation.col.method'), render: (m) => t(`invValuation.method.${m.method}`) },
    {
      key: 'description',
      header: t('invValuation.col.description'),
      render: (m) => <span className="iv-desc">{t(`invValuation.methodDesc.${m.method}`)}</span>,
    },
    {
      key: 'enabled',
      header: t('invValuation.col.enabled'),
      render: (m) => (
        <label className="iv-toggle">
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={!canWrite}
            aria-label={t('invValuation.enableAria', { method: t(`invValuation.method.${m.method}`) })}
            onChange={() => void toggleMethod(m.method, !m.enabled)}
          />
        </label>
      ),
    },
    {
      key: 'default',
      header: t('invValuation.col.default'),
      render: (m) => (m.isDefault ? <span className="iv-badge">{t('invValuation.isDefault')}</span> : null),
    },
  ];

  // The FIFO layer table. Every quantity and money cell renders verbatim from the engine's layer
  // read; the value cell is the layer's remaining quantity at its own recorded unit cost, the same
  // figure the engine's FIFO consumes, never a re-valuation.
  const layerColumns: DataTableColumn<Layer>[] = [
    { key: 'receiptDate', header: t('invValuation.layers.receiptDate'), render: (l) => l.receiptDate },
    { key: 'remaining', header: t('invValuation.layers.remaining'), numeric: true, render: (l) => l.remainingQty },
    { key: 'original', header: t('invValuation.layers.original'), numeric: true, render: (l) => l.originalQty },
    { key: 'unitCost', header: t('invValuation.layers.unitCost'), numeric: true, render: (l) => formatMoney(l.unitCostMinor, 'CHF') },
    {
      key: 'value',
      header: t('invValuation.layers.value'),
      numeric: true,
      render: (l) => formatMoney(l.remainingQty * l.unitCostMinor, 'CHF'),
    },
  ];

  // The append-only method-assignment trail (OR 958c Stetigkeit evidence). Actor and date come from
  // the history read verb, so this is where a real actor/date lives; the C3 provenance line is not
  // used, because the per-item valuation preview carries no actor or path.
  const historyColumns: DataTableColumn<Assignment>[] = [
    { key: 'effectiveFrom', header: t('invValuation.history.effectiveFrom'), render: (a) => a.effectiveFrom },
    { key: 'scope', header: t('invValuation.history.scope'), render: (a) => t(`invValuation.scope.${a.scope}`) },
    { key: 'method', header: t('invValuation.col.method'), render: (a) => t(`invValuation.method.${a.method}`) },
    {
      key: 'reason',
      header: t('invValuation.history.reason'),
      render: (a) => (
        <>
          {a.reason ?? '-'}
          {a.forceRevaluation && <span className="iv-badge">{t('invValuation.history.forced')}</span>}
        </>
      ),
    },
    { key: 'actor', header: t('invValuation.history.actor'), render: (a) => a.createdBy ?? '-' },
  ];

  return (
    <div className="iv">
      <SurfaceHeader
        title={t('invValuation.title')}
        help={<SurfaceHelp surface="InventoryValuation" />}
        actions={
          <p className="iv-total">
            {t('invValuation.workspaceTotal')}: <strong>{formatMoney(totalValueMinor, 'CHF')}</strong>
          </p>
        }
      />

      {failed && <ErrorBanner message={t('invValuation.error.transport')} onRetry={() => void loadBase()} />}
      {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}

      {loading ? (
        <Skeleton rows={5} />
      ) : (
        <>
          <section className="iv-panel" aria-label={t('invValuation.methodsLabel')}>
            <div className="iv-panel-head">
              <h2 className="iv-panel-title">{t('invValuation.methodsTitle')}</h2>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canWrite}
                onClick={() => {
                  setWriteError(null);
                  setDefaultDraft({ method: defaultMethod, effectiveFrom: today(), reason: '', forceRevaluation: false });
                  setDefaultDrawer(true);
                }}
              >
                {t('invValuation.changeDefault')}
              </button>
            </div>
            <p className="iv-muted">
              {t('invValuation.defaultInForce', { method: t(`invValuation.method.${defaultMethod}`) })}
              {defaultEffectiveFrom !== null && ` (${t('invValuation.since', { date: defaultEffectiveFrom })})`}
            </p>
            <DataTable columns={methodColumns} rows={methods} rowKey={(m) => m.method} caption={t('invValuation.methodsLabel')} />
          </section>

          {items.length === 0 ? (
            <EmptyState title={t('invValuation.empty.title')} hint={t('invValuation.empty.hint')} />
          ) : (
            <div className="iv-split">
              <section className="iv-pane" aria-label={t('invValuation.listLabel')}>
                <ul className="iv-list">
                  {items.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        className={`iv-list-item ${i.id === selectedId ? 'iv-list-item-selected' : ''}`}
                        onClick={() => setSelectedId(i.id)}
                        aria-pressed={i.id === selectedId}
                      >
                        {i.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="iv-pane iv-detail" aria-label={t('invValuation.detailLabel')}>
                {selected === null ? (
                  <p className="iv-muted">{t('invValuation.selectHint')}</p>
                ) : (
                  <>
                    <h2 className="iv-detail-title">{selected.name}</h2>
                    <div className="iv-controls">
                      <div className="form-row">
                        <label htmlFor="iv-asof">{t('invValuation.asOf')}</label>
                        <input id="iv-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                      </div>
                      <div className="form-row">
                        <label htmlFor="iv-nrv">{t('invValuation.netRealisableValue')}</label>
                        <input id="iv-nrv" type="number" min="0" value={nrv} onChange={(e) => setNrv(e.target.value)} />
                        <p className="field-hint">{t('invValuation.nrvHint')}</p>
                      </div>
                    </div>

                    {detailLoading ? (
                      <Skeleton rows={3} />
                    ) : valuation === null ? (
                      <p className="iv-muted">{t('invValuation.noValuation')}</p>
                    ) : (
                      <>
                        <dl className="iv-figures">
                          <div>
                            <dt>{t('invValuation.effectiveMethod')}</dt>
                            <dd>
                              {t(`invValuation.method.${valuation.method}`)}{' '}
                              <span className="iv-badge">{t(`invValuation.source.${valuation.methodSource}`)}</span>
                            </dd>
                          </div>
                          <div>
                            <dt>{t('invValuation.onHand')}</dt>
                            <dd>{valuation.qtyOnHand}</dd>
                          </div>
                          <div>
                            <dt>{t('invValuation.unitCost')}</dt>
                            <dd>{valuation.unitCostMinor === null ? '-' : formatMoney(valuation.unitCostMinor, 'CHF')}</dd>
                          </div>
                          <div>
                            <dt>{t('invValuation.totalValue')}</dt>
                            <dd>
                              <strong>{formatMoney(valuation.totalValueMinor, 'CHF')}</strong>
                              {/* An allocated figure is a SHARE of the item's pooled total, not a
                                  valuation of this location's own goods. Saying so on the figure
                                  itself is the point: a reader who does not know that would compare
                                  it against that location's own purchase invoices and find a gap. */}
                              {valuation.valuationBasis === 'allocated' && (
                                <>
                                  {' '}
                                  <span className="iv-badge">{t('invValuation.basis.allocated')}</span>
                                </>
                              )}
                            </dd>
                          </div>
                          {valuation.lcmApplied && (
                            <div>
                              <dt>{t('invValuation.writeDown')}</dt>
                              <dd>
                                <span className="iv-badge">{t('invValuation.lcmApplied')}</span>{' '}
                                {formatMoney(valuation.writeDownMinor, 'CHF')}
                              </dd>
                            </div>
                          )}
                          {valuation.varianceMinor !== null && (
                            <div>
                              <dt>{t('invValuation.variance')}</dt>
                              <dd>{formatMoney(valuation.varianceMinor, 'CHF')}</dd>
                            </div>
                          )}
                        </dl>

                        {valuation.reason !== null && (
                          <p className="iv-reason">{t(`invValuation.reason.${valuation.reason}`)}</p>
                        )}
                        {valuation.warnings.includes('missing_unit_cost') && (
                          <p className="iv-reason">
                            {t('invValuation.warning.missing_unit_cost', { qty: valuation.uncostedQty })}
                            {valuation.missingCostMovementIds.length > 0 && (
                              <>
                                {' '}
                                <span className="iv-muted">{valuation.missingCostMovementIds.join(', ')}</span>
                              </>
                            )}
                          </p>
                        )}
                        {valuation.warnings.includes('transfer_cost_ignored') && (
                          <p className="iv-reason">{t('invValuation.warning.transfer_cost_ignored')}</p>
                        )}
                        {valuation.warnings.includes('unpaired_transfer_leg') && (
                          <p className="iv-reason">{t('invValuation.warning.unpaired_transfer_leg')}</p>
                        )}

                        {valuation.layers.length > 0 && (
                          <>
                            <h3 className="iv-sub">{t('invValuation.layers.title')}</h3>
                            <DataTable columns={layerColumns} rows={valuation.layers} rowKey={(l) => l.sourceMovementId} />
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
          )}

          <section className="iv-panel" aria-label={t('invValuation.history.title')}>
            <h2 className="iv-panel-title">{t('invValuation.history.title')}</h2>
            <DataTable
              columns={historyColumns}
              rows={assignments}
              rowKey={(a) => a.id}
              emptyState={<p className="iv-muted">{t('invValuation.history.empty')}</p>}
            />
          </section>
        </>
      )}

      <DetailDrawer
        open={defaultDrawer}
        onClose={() => setDefaultDrawer(false)}
        title={t('invValuation.form.defaultTitle')}
        closeLabel={t('invValuation.cancel')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDefaultDrawer(false)}>
              {t('invValuation.cancel')}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submitDefault()} disabled={!canWrite}>
              {t('invValuation.save')}
            </button>
          </>
        }
      >
        {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
        <div className="form-stack">
          <div className="form-row">
            <label htmlFor="iv-method">{t('invValuation.col.method')}</label>
            <select id="iv-method" value={defaultDraft.method} onChange={(e) => setDefaultDraft({ ...defaultDraft, method: e.target.value })}>
              {methods
                .filter((m) => m.enabled)
                .map((m) => (
                  <option key={m.method} value={m.method}>
                    {t(`invValuation.method.${m.method}`)}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="iv-eff">{t('invValuation.effectiveFrom')}</label>
            <input
              id="iv-eff"
              type="date"
              value={defaultDraft.effectiveFrom}
              onChange={(e) => setDefaultDraft({ ...defaultDraft, effectiveFrom: e.target.value })}
            />
            <p className="field-hint">{t('invValuation.effectiveFromHint')}</p>
          </div>
          <div className="form-row">
            <label htmlFor="iv-reason">{t('invValuation.history.reason')}</label>
            <input id="iv-reason" value={defaultDraft.reason} onChange={(e) => setDefaultDraft({ ...defaultDraft, reason: e.target.value })} />
            <p className="field-hint">{t('invValuation.reasonHint')}</p>
          </div>
          <div className="form-row">
            <label className="iv-check">
              <input
                type="checkbox"
                checked={defaultDraft.forceRevaluation}
                onChange={(e) => setDefaultDraft({ ...defaultDraft, forceRevaluation: e.target.checked })}
              />
              <span>{t('invValuation.forceRevaluation')}</span>
            </label>
            <p className="field-hint">{t('invValuation.forceHint')}</p>
          </div>
        </div>
      </DetailDrawer>
    </div>
  );
}
