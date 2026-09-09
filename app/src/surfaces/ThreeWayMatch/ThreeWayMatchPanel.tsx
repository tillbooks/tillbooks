/**
 * I04's three-way-match panel: EMBEDDABLE (spec §6: not a new screen). Given a vendor bill id it runs
 * the pure `match_three_way_evaluate`, shows the per-PO-line comparison with traffic-light badges and
 * the aggregate variance, and offers Confirm (in tolerance) or Override (a variance). It POSTS
 * NOTHING: the bill's own posting already ran through A17 -> A02.
 *
 * The permission gate here is the standing Studio CONVENIENCE: Confirm disables without
 * `purchasing.match`, Override without `purchasing.match_override`; a click that slips through still
 * surfaces the engine's own `permission_denied`. The engine is the real gate, and it RE-COMPUTES the
 * evaluation under a row guard: the numbers here are shown VERBATIM from the read verb and never
 * recomputed in the UI.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 money-path wave)
 *
 * - The per-line comparison is the shared `DataTable` (frame overflow, sticky header, density, the
 *   `.t-num` numeric cells), with a `rowClassName` hook emphasising a variance line and dimming a
 *   blocked one. The three-way totals stay a bespoke summary below it, because expected value, billed
 *   base-net and the aggregate value variance are three engine figures, not one column sum.
 * - Confirm and Override both raise the shared `Modal` as an ALERTDIALOG: releasing a bill for
 *   payment is consequential, so it is answered with a control and never a stray scrim click (APG).
 *   Override carries its mandatory reason field inside the dialog. When embedded in the I04 surface's
 *   `DetailDrawer`, opening the dialog flips the host drawer's focus trap off via `onDialogOpenChange`
 *   so the nested alertdialog owns focus and Escape.
 * - No `ConsequenceLine` (C4): `match_three_way_create` and `match_three_way_override` both carry a
 *   null `dialCapability` in `command-source.generated.json`, so there is no engine consequence
 *   sentence to render. NEEDS-ENGINE-DATA: give those verbs a dial capability and the line appears.
 * - No `Provenance` (C3): the read model this panel uses (`match_three_way_evaluate`) is a LIVE
 *   evaluation, not a persisted authored record, and carries no actor / path / date to show.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Modal } from '../../components/Modal';

const newKey = () => crypto.randomUUID();

/** Releasing a bill for payment is consequential. Held as a value so the Modal role travels as a
 *  prop, not a literal attribute on the component (the modal-role source guard). */
const ALERT_DIALOG = 'alertdialog' as const;

/** Glyph AND label, never colour alone (design-canon, WCAG 2.2 AA). */
const STATUS_GLYPH: Record<string, string> = {
  matched: '✓',
  partial: '◐',
  overridden: '⚠',
  variance: '✕',
  nothing_received: '∅',
  no_candidate_po: '·',
};

interface EvalLine {
  poLineId: string;
  itemId: string | null;
  description: string | null;
  orderedQty: number;
  receivedQty: number;
  alreadyBilledQty: number;
  billedNowQty: number;
  unitPricePoRappen: number;
  extendedPoRappen: number;
  qtyVariance: number;
  lineStatus: string;
}

interface Evaluation {
  billId: string;
  poId: string | null;
  status: string;
  billConvertible: boolean;
  lines: EvalLine[];
  totalExpectedRappen: number;
  totalBilledRappen: number;
  valueVarianceRappen: number;
}

/** Which consequential write the confirm alertdialog is gating, or none while it is closed. */
type Intent = 'confirm' | 'override' | null;

export interface ThreeWayMatchPanelProps {
  billId: string;
  /** Called after a successful confirm / override so a host can refresh its own list. */
  onMatched?: () => void;
  /**
   * Notifies a host `DetailDrawer` when this panel opens or closes its confirm alertdialog, so the
   * drawer can drop its own focus trap (`trapActive={false}`) while the nested dialog owns focus and
   * Escape. Absent when the panel is embedded inline (A17 / I01), where there is no host trap.
   */
  onDialogOpenChange?: (open: boolean) => void;
}

const chf = (rappen: number) => (rappen / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ThreeWayMatchPanel({ billId, onMatched, onDialogOpenChange }: ThreeWayMatchPanelProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent>(null);
  const [reason, setReason] = useState('');

  // Keep a host DetailDrawer's focus trap in step with our alertdialog: while it is open the drawer
  // must yield the trap (D118 DetailDrawer.trapActive), and reclaim it when the dialog closes.
  useEffect(() => {
    onDialogOpenChange?.(intent !== null);
  }, [intent, onDialogOpenChange]);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    const res = await client.call('match_three_way_evaluate', { workspaceId, billId });
    setLoading(false);
    if (isErr(res.body)) {
      setEvaluation(null);
      setMessage(t(`procurement.match.error.${res.body.error}`) || res.body.error);
      return;
    }
    setEvaluation((res.body as unknown as { evaluation: Evaluation }).evaluation);
    setMessage('');
  }, [client, workspaceId, billId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = useCallback(async () => {
    if (workspaceId === null || evaluation === null) return;
    setMessage('');
    const res = await client.call('match_three_way_create', { workspaceId, billId, evaluation, idempotencyKey: newKey() });
    if (isErr(res.body)) {
      setMessage(t(`procurement.match.error.${res.body.error}`) || res.body.error);
      return;
    }
    setIntent(null);
    setDone('matched');
    onMatched?.();
  }, [client, workspaceId, billId, evaluation, t, onMatched]);

  const override = useCallback(async () => {
    if (workspaceId === null || evaluation === null) return;
    if (reason.trim().length < 5) {
      setMessage(t('procurement.match.reasonRequired'));
      return;
    }
    setMessage('');
    const res = await client.call('match_three_way_override', { workspaceId, billId, evaluation, reason: reason.trim(), idempotencyKey: newKey() });
    if (isErr(res.body)) {
      setMessage(t(`procurement.match.error.${res.body.error}`) || res.body.error);
      return;
    }
    setIntent(null);
    setDone('overridden');
    onMatched?.();
  }, [client, workspaceId, billId, evaluation, reason, t, onMatched]);

  const openConfirm = () => {
    setMessage('');
    setIntent('confirm');
  };
  const openOverride = () => {
    setMessage('');
    setReason('');
    setIntent('override');
  };
  const closeDialog = () => {
    setIntent(null);
    setMessage('');
  };

  if (loading) {
    return (
      <section className="twm-panel" aria-label={t('procurement.match.title')} aria-busy="true">
        <h3>{t('procurement.match.title')}</h3>
        <p role="status">{t('states.loading.label')}</p>
      </section>
    );
  }

  if (evaluation === null || evaluation.status === 'no_candidate_po') {
    return (
      <section className="twm-panel" aria-label={t('procurement.match.title')}>
        <h3>{t('procurement.match.title')}</h3>
        <p>{message !== '' ? message : t('procurement.match.empty')}</p>
      </section>
    );
  }

  const status = evaluation.status;
  const canConfirm = (status === 'matched' || status === 'partial') && can(CAP.purchasingMatch);
  const canOverride = status === 'variance' && can(CAP.purchasingMatchOverride);

  // Text left, quantities right (numeric, `.t-num`); status a glyph + label badge. Nothing is
  // recomputed here: every quantity, price and status renders verbatim from `match_three_way_evaluate`.
  const lineColumns: DataTableColumn<EvalLine>[] = [
    { key: 'item', header: t('procurement.match.col.item'), render: (l) => l.description ?? l.itemId ?? l.poLineId },
    { key: 'ordered', header: t('procurement.match.col.ordered'), numeric: true, render: (l) => l.orderedQty },
    { key: 'received', header: t('procurement.match.col.received'), numeric: true, render: (l) => l.receivedQty },
    { key: 'alreadyBilled', header: t('procurement.match.col.alreadyBilled'), numeric: true, render: (l) => l.alreadyBilledQty },
    { key: 'thisBill', header: t('procurement.match.col.thisBill'), numeric: true, render: (l) => l.billedNowQty },
    { key: 'qtyVar', header: t('procurement.match.col.qtyVar'), numeric: true, render: (l) => l.qtyVariance },
    {
      key: 'status',
      header: t('procurement.match.col.status'),
      render: (l) => (
        <span className={`twm-badge twm-badge--${l.lineStatus}`}>
          <span aria-hidden="true">{STATUS_GLYPH[l.lineStatus] ?? '·'}</span> {t(`procurement.match.status.${l.lineStatus}`)}
        </span>
      ),
    },
  ];

  const lineClass = (l: EvalLine): string | undefined => {
    if (l.lineStatus === 'variance') return 'twm-line--variance';
    if (l.lineStatus === 'nothing_received' || l.lineStatus === 'no_candidate_po') return 'twm-line--blocked';
    return undefined;
  };

  return (
    <section className="twm-panel" aria-label={t('procurement.match.title')}>
      <h3>{t('procurement.match.title')}</h3>

      <p className={`twm-badge twm-badge--${status}`} role="status">
        <span aria-hidden="true">{STATUS_GLYPH[status] ?? '·'}</span> {t(`procurement.match.status.${status}`)}
      </p>

      {done !== null ? (
        <p className="twm-success" role="status">
          <span aria-hidden="true">✓</span> {t(`procurement.match.done.${done}`)}
        </p>
      ) : (
        <>
          <DataTable
            columns={lineColumns}
            rows={evaluation.lines}
            rowKey={(l) => l.poLineId}
            caption={t('procurement.match.linesCaption')}
            rowClassName={lineClass}
          />

          <dl className="twm-totals">
            <div>
              <dt>{t('procurement.match.expected')}</dt>
              <dd className="t-num">{chf(evaluation.totalExpectedRappen)}</dd>
            </div>
            <div>
              <dt>{t('procurement.match.billed')}</dt>
              <dd className="t-num">{chf(evaluation.totalBilledRappen)}</dd>
            </div>
            <div>
              <dt>{t('procurement.match.valueVar')}</dt>
              <dd className="t-num">{chf(evaluation.valueVarianceRappen)}</dd>
            </div>
          </dl>

          <div className="twm-actions">
            {(status === 'matched' || status === 'partial') && (
              <button type="button" className="btn btn--primary btn--sm" disabled={!canConfirm} onClick={openConfirm}>
                {t('procurement.match.confirm')}
              </button>
            )}
            {status === 'variance' && (
              <button type="button" className="btn btn--secondary btn--sm" disabled={!can(CAP.purchasingMatchOverride)} onClick={openOverride}>
                {t('procurement.match.override')}
              </button>
            )}
          </div>
        </>
      )}

      <Modal
        open={intent !== null}
        onClose={closeDialog}
        // A consequential release/override confirm is an alertdialog (Modal hosts the role on its own
        // div; the role travels as a prop, per the modal-role guard). It does not dismiss on a stray
        // scrim click.
        role={ALERT_DIALOG}
        title={intent === 'override' ? t('procurement.match.overrideTitle') : t('procurement.match.confirmTitle')}
        closeLabel={t('procurement.match.cancel')}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={closeDialog}>
              {t('procurement.match.cancel')}
            </button>
            {intent === 'override' ? (
              <button type="button" className="btn btn--danger" disabled={!canOverride} onClick={() => void override()}>
                {t('procurement.match.overrideConfirm')}
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={!canConfirm} onClick={() => void confirm()}>
                {t('procurement.match.releaseConfirm')}
              </button>
            )}
          </>
        }
      >
        <p className="twm-note">
          {intent === 'override' ? t('procurement.match.overrideBody') : t('procurement.match.confirmBody')}
        </p>
        {intent === 'override' && (
          <label className="twm-field">
            <span>{t('procurement.match.reason')}</span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} />
          </label>
        )}
        {message !== '' && (
          <p className="twm-error" role="alert">
            {message}
          </p>
        )}
      </Modal>
    </section>
  );
}

export default ThreeWayMatchPanel;
