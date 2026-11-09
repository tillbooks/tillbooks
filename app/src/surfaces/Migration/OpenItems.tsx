/**
 * G21, the Offene-Posten step on the Datenübernahme surface (spec §6): the step AFTER the
 * opening-balance step, two panels (Debitoren / Kreditoren), each showing the loaded rows, the
 * running ar_control / ap_control delta against A04's opening line, and one Importieren action gated
 * on a green-or-acknowledged tie-out.
 *
 * THE DESIGN LAW (brand/DESIGN.md, G11's three-status honesty carried verbatim): a passing control
 * renders NEUTRAL with a check glyph, an unasserted one `--t-warn` ("Noch nicht geprüft", never
 * green), a nonzero difference `--t-danger` with the Rappen figure. Once imported, the items appear
 * in the ordinary Debitoren (A16) / Kreditoren (A17) lists with NO origin badge shouting: a migrated
 * item is a normal open item. The optional Herkunft ("Übernommen") is a saved-view column only.
 *
 * The rows arrive already G10-mapped (this surface receives them, it does not map them). Nothing here
 * mints a verb: it wires `preview_open_items` (the control delta without a write) and
 * `import_open_items` (the money-path write, which posts NOTHING of its own).
 */
import { useState, useCallback, useEffect } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatMoney } from '../../i18n';
import { PermissionDenied } from '../../components/states';

/** One control side as `preview_open_items` / `import_open_items` reports it. */
interface Control {
  kind: 'ar_control' | 'ap_control';
  controlAccountMinor: number;
  migratedOpenMinor: number;
  differenceMinor: number;
  status: 'passed' | 'failed' | 'not_asserted';
}

interface Refusal {
  rowIndex: number;
  number: string | null;
  reason: string;
}

type Side = 'ar' | 'ap';

/** The refusal-reason -> i18n-key map, so a refused row names its reason inline (never a stack). */
const REFUSAL_KEY: Record<string, string> = {
  open_item_total_mismatch: 'totalMismatch',
  contact_unmapped: 'contactUnmapped',
  vendor_unmapped: 'vendorUnmapped',
  tax_unresolved: 'taxUnresolved',
  needs_fx_rate: 'needsFxRate',
  invalid_row: 'invalidRow',
  prior_year_detail_archived: 'priorYearArchived',
};

interface PanelState {
  loading: boolean;
  control: Control | null;
  refusals: Refusal[];
  validCount: number;
  importedCount: number | null;
  denied: boolean;
  acknowledged: boolean;
}

const EMPTY_PANEL: PanelState = {
  loading: false,
  control: null,
  refusals: [],
  validCount: 0,
  importedCount: null,
  denied: false,
  acknowledged: false,
};

/** A STABLE empty default: an inline `= []` mints a fresh array every render, which would churn the
 *  preview effect forever (its deps would never settle). One shared reference keeps it settled. */
const NO_ROWS: unknown[] = [];

export interface OpenItemsProps {
  workspaceId: string;
  planId: string;
  /** The already-mapped AR rows (from the upstream mapping step); empty renders the empty state. */
  arRows?: unknown[];
  /** The already-mapped AP rows. */
  apRows?: unknown[];
  baseCurrency?: string;
  priorYearDetail?: 'live' | 'archive';
}

export function OpenItems(props: OpenItemsProps): React.ReactElement {
  const { workspaceId, planId, arRows = NO_ROWS, apRows = NO_ROWS, baseCurrency = 'CHF', priorYearDetail } = props;
  const client = useClient();
  const t = useT();

  const [ar, setAr] = useState<PanelState>(EMPTY_PANEL);
  const [ap, setAp] = useState<PanelState>(EMPTY_PANEL);

  const rowsFor = useCallback((side: Side) => (side === 'ar' ? arRows : apRows), [arRows, apRows]);
  const setPanel = useCallback(
    (side: Side, next: (prev: PanelState) => PanelState) => (side === 'ar' ? setAr(next) : setAp(next)),
    [],
  );

  const preview = useCallback(
    async (side: Side): Promise<void> => {
      const rows = rowsFor(side);
      if (rows.length === 0) return;
      setPanel(side, (p) => ({ ...p, loading: true, denied: false }));
      const res = (
        await client.call('preview_open_items', {
          workspaceId,
          planId,
          side,
          rows,
          ...(priorYearDetail !== undefined ? { priorYearDetail } : {}),
        })
      ).body;
      if (isErr(res)) {
        setPanel(side, (p) => ({ ...p, loading: false, denied: res.error === 'forbidden' }));
        return;
      }
      const data = res as Record<string, unknown>;
      setPanel(side, (p) => ({
        ...p,
        loading: false,
        control: (data.control as Control) ?? null,
        refusals: (data.refusals as Refusal[]) ?? [],
        validCount: (data.validCount as number) ?? 0,
      }));
    },
    [client, workspaceId, planId, priorYearDetail, rowsFor, setPanel],
  );

  useEffect(() => {
    void preview('ar');
    void preview('ap');
  }, [preview]);

  const runImport = useCallback(
    async (side: Side): Promise<void> => {
      const rows = rowsFor(side);
      if (rows.length === 0) return;
      setPanel(side, (p) => ({ ...p, loading: true }));
      const res = (
        await client.call('import_open_items', {
          workspaceId,
          planId,
          side,
          rows,
          ...(priorYearDetail !== undefined ? { priorYearDetail } : {}),
          idempotencyKey: crypto.randomUUID(),
        })
      ).body;
      if (isErr(res)) {
        if (res.error === 'forbidden') {
          setPanel(side, (p) => ({ ...p, loading: false, denied: true }));
          return;
        }
        const errData = res as unknown as Record<string, unknown>;
        setPanel(side, (p) => ({
          ...p,
          loading: false,
          refusals: (errData.refusals as Refusal[]) ?? p.refusals,
        }));
        return;
      }
      const data = res as Record<string, unknown>;
      setPanel(side, (p) => ({
        ...p,
        loading: false,
        importedCount: (data.importedCount as number) ?? 0,
        control: (data.control as Control) ?? p.control,
      }));
    },
    [client, workspaceId, planId, priorYearDetail, rowsFor, setPanel],
  );

  return (
    <section className="open-items" aria-label={t('migration.openItems.title')}>
      <h2>{t('migration.openItems.title')}</h2>
      <div className="open-items-panels">
        <Panel
          side="ar"
          state={ar}
          rowCount={arRows.length}
          baseCurrency={baseCurrency}
          onImport={() => void runImport('ar')}
          onRecheck={() => void preview('ar')}
          onAck={(v) => setAr((p) => ({ ...p, acknowledged: v }))}
        />
        <Panel
          side="ap"
          state={ap}
          rowCount={apRows.length}
          baseCurrency={baseCurrency}
          onImport={() => void runImport('ap')}
          onRecheck={() => void preview('ap')}
          onAck={(v) => setAp((p) => ({ ...p, acknowledged: v }))}
        />
      </div>
    </section>
  );
}

function Panel(props: {
  side: Side;
  state: PanelState;
  rowCount: number;
  baseCurrency: string;
  onImport: () => void;
  onRecheck: () => void;
  onAck: (v: boolean) => void;
}): React.ReactElement {
  const { side, state, rowCount, baseCurrency, onImport, onRecheck, onAck } = props;
  const t = useT();
  const heading = side === 'ar' ? t('migration.openItems.ar') : t('migration.openItems.ap');
  const controlLabel = side === 'ar' ? t('migration.openItems.controlAr') : t('migration.openItems.controlAp');

  if (state.denied) {
    return (
      <div className="open-items-panel" aria-label={heading}>
        <h3>{heading}</h3>
        <PermissionDenied body={t('migration.openItems.denied')} />
      </div>
    );
  }

  if (rowCount === 0) {
    return (
      <div className="open-items-panel" aria-label={heading}>
        <h3>{heading}</h3>
        <p className="open-items-empty">{t('migration.openItems.empty')}</p>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="open-items-panel" aria-label={heading}>
        <h3>{heading}</h3>
        <p className="open-items-loading" role="status">{t('migration.openItems.loading')}</p>
      </div>
    );
  }

  const status = state.control?.status ?? 'not_asserted';
  const statusClass =
    status === 'passed' ? 'open-items-ok' : status === 'failed' ? 'open-items-danger' : 'open-items-warn';
  const canImport = status === 'passed' || state.acknowledged;

  return (
    <div className="open-items-panel" aria-label={heading}>
      <h3>{heading}</h3>
      <p className="open-items-hint">{t('migration.openItems.panelHint')}</p>

      {state.importedCount !== null ? (
        <p className="open-items-success" role="status">
          <span aria-hidden="true">✓</span>{' '}
          {t('migration.openItems.importedCount', { count: String(state.importedCount) })}
        </p>
      ) : (
        <>
          <p className={`open-items-control ${statusClass}`} role="status">
            <span className="open-items-control-label">{controlLabel}</span>{' '}
            {status === 'passed' && (
              <span>
                <span aria-hidden="true">✓</span> {t('migration.openItems.asserted')}
              </span>
            )}
            {status === 'not_asserted' && <span>{t('migration.openItems.notAsserted')}</span>}
            {status === 'failed' && state.control !== null && (
              <span>
                {t('migration.openItems.difference', {
                  amount: formatMoney(state.control.differenceMinor, baseCurrency),
                })}
              </span>
            )}
          </p>

          {state.refusals.length > 0 && (
            <ul className="open-items-refusals" aria-label={heading}>
              {state.refusals.map((r) => (
                <li key={r.rowIndex} className="open-items-refusal">
                  {t('migration.openItems.rowRefused', {
                    number: r.number ?? `#${r.rowIndex + 1}`,
                    reason: t(`migration.openItems.${REFUSAL_KEY[r.reason] ?? 'genericRefusal'}`),
                  })}
                </li>
              ))}
            </ul>
          )}

          {status === 'failed' && (
            <label className="open-items-ack">
              <input
                type="checkbox"
                checked={state.acknowledged}
                onChange={(e) => onAck(e.target.checked)}
              />
              {t('migration.openItems.acknowledge')}
            </label>
          )}

          {/* f9: the default 'not_asserted' state used to be a dead end (a disabled Import and nothing
              else). Name WHY import is blocked and offer a real next step: run the Eröffnungsprüfung,
              then re-check the tie-out here. The re-check re-runs the preview (a genuine in-surface act). */}
          {status === 'not_asserted' && state.refusals.length === 0 && (
            <div className="open-items-blocked" role="note">
              <p className="open-items-blocked-hint">{t('migration.openItems.notAssertedHint')}</p>
              <button type="button" className="btn btn--secondary open-items-recheck" onClick={onRecheck}>
                {t('migration.openItems.recheck')}
              </button>
            </div>
          )}

          <button
            type="button"
            className="btn btn--secondary"
            disabled={!canImport || state.refusals.length > 0}
            onClick={onImport}
          >
            {t('migration.openItems.import')}
          </button>
        </>
      )}
    </div>
  );
}

export default OpenItems;
