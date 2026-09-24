/**
 * A32, the eBill delivery panel on the invoice detail (spec §6). It renders for an issued+ invoice and
 * carries the whole local eBill lifecycle: prepare the payload artifact, download it, transmit it (or
 * show the honest OP4 card when no connector is wired), and read each delivery's status with a
 * glyph+text pair (never colour alone, DESIGN.md).
 *
 * It BUILDS nothing on the money path: `ebill_prepare` files the A11 PDF and records the delivery, and
 * the QR reference the payload carries is A11's own. The panel only reads the engine's output and calls
 * the two write verbs behind their A24 gates. Prepare needs `issue` (an OP4 local artifact, the
 * `delivery_note_render` posture); transmit needs `send` (outbound, P8), so `Übermitteln` is
 * pre-disabled with an inline reason when the actor lacks it (D15/C3, never tooltip-only).
 *
 * The reconciled OI1 boundary (spec reconciliation): a delivery is prepared even while A11 emits no
 * PDF/A-3b profile, and the panel SURFACES the recorded gap ("PDF/A-3b ausstehend") rather than
 * claiming conformance; the refusal bites at transmit (`payload_not_conformant`).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import type { DocumentDto } from './model';

/** The delivery read model, camelCase mirror of the engine's `deliveryView` (spec §4). */
export interface EbillDeliveryDto {
  id: string;
  invoiceId: string;
  artifactDocumentId: string | null;
  status: 'prepared' | 'submitting' | 'transmitted' | 'failed';
  pdfaProfile: string | null;
  ebillAddressed: boolean;
  partnerStatus: string | null;
  partnerReason: string | null;
  businessCaseId: string | null;
  transmittedAt: string | null;
}

/** The four local states as glyph+text (spec §6: status is a glyph, never colour alone). */
const STATUS_GLYPH: Record<EbillDeliveryDto['status'], string> = {
  prepared: '○',
  submitting: '◐',
  transmitted: '●',
  failed: '✕',
};

/** Map a mirrored SWP partner status to its i18n label key (verbatim enum, spec §3). */
function partnerStatusKey(s: string): string {
  const known: Record<string, string> = {
    NWP_PENDING: 'ebill.partnerStatus.nwpPending',
    OPEN: 'ebill.partnerStatus.open',
    APPROVED: 'ebill.partnerStatus.approved',
    REJECTED: 'ebill.partnerStatus.rejected',
    COMPLETED: 'ebill.partnerStatus.completed',
  };
  return known[s] ?? '';
}

const PREPARABLE = new Set(['issued', 'sent', 'partially_paid']);

export interface EbillPanelProps {
  doc: DocumentDto;
}

export function EbillPanel({ doc }: EbillPanelProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canIssue = useCan(CAP.issue);
  const canSend = useCan(CAP.send);

  // The read has three outcomes, kept distinct: `null` = in flight (skeleton), an array = the real
  // deliveries (`[]` genuinely empty, the `ebill.empty` get-started state), and `failed` = the read
  // itself rejected. Conflating the last two showed the "prepare this invoice" card over a status
  // read that never succeeded, with no way to retry (f15).
  const [deliveries, setDeliveries] = useState<EbillDeliveryDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'cloud_tier' | 'needs_biller_pid' | 'payload_not_conformant' | 'error'; detail?: string } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setDeliveries(null);
    setFailed(false);
    const { body } = await client.call('ebill_delivery_status', { workspaceId, invoiceId: doc.id });
    if (isErr(body)) {
      // A failed read is NOT an empty invoice: flag the error so the panel offers a retry instead of
      // the get-started state (f15).
      setFailed(true);
      return;
    }
    setDeliveries(((body as Record<string, unknown>).deliveries as EbillDeliveryDto[]) ?? []);
  }, [client, workspaceId, doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const prepare = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setNotice(null);
    const { body } = await client.call('ebill_prepare', {
      workspaceId,
      invoiceId: doc.id,
      idempotencyKey: `ebill-prepare-${doc.id}-${Date.now()}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setNotice({ kind: 'error', detail: body.error });
      return;
    }
    void load();
  }, [client, workspaceId, doc.id, load]);

  const transmit = useCallback(
    async (deliveryId: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      setNotice(null);
      const { body } = await client.call('ebill_transmit', {
        workspaceId,
        deliveryId,
        confirmed: true,
        idempotencyKey: `ebill-transmit-${deliveryId}-${Date.now()}`,
      });
      setBusy(false);
      if (isErr(body)) {
        if (body.error === 'needs_biller_pid') setNotice({ kind: 'needs_biller_pid' });
        else if (body.error === 'payload_not_conformant') {
          const missing = (body as unknown as { missing?: string[] }).missing ?? [];
          setNotice({ kind: 'payload_not_conformant', detail: missing.join(', ') });
        } else setNotice({ kind: 'error', detail: body.error });
        return;
      }
      // The honest OP4 shape is an ok result with transmitted:false.
      if ((body as unknown as { transmitted?: boolean }).transmitted === false) {
        setNotice({ kind: 'cloud_tier' });
      }
      void load();
    },
    [client, workspaceId, load],
  );

  const download = useCallback(
    async (fileId: string) => {
      if (workspaceId === null) return;
      const { body } = await client.call('files_get_content', { workspaceId, fileId });
      if (isErr(body)) {
        setNotice({ kind: 'error', detail: body.error });
        return;
      }
      const base64 = (body as unknown as { contentBase64: string }).contentBase64;
      const anchor = document.createElement('a');
      anchor.href = `data:application/pdf;base64,${base64}`;
      anchor.download = `eBill-${doc.number ?? doc.id}.pdf`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    [client, workspaceId, doc.number, doc.id],
  );

  if (failed) {
    return (
      <section className="invoice-ebill-panel panel" aria-label={t('ebill.title')}>
        <h2 className="documents-section-title">{t('ebill.title')}</h2>
        <ErrorBanner message={t('ebill.loadError')} onRetry={() => void load()} />
      </section>
    );
  }

  if (deliveries === null) {
    return (
      <section className="invoice-ebill-panel panel" aria-label={t('ebill.title')}>
        <h2 className="documents-section-title">{t('ebill.title')}</h2>
        <Skeleton rows={2} height={24} />
      </section>
    );
  }

  const preparable = PREPARABLE.has(doc.status);
  const active = deliveries.find((d) => d.status !== 'failed') ?? null;
  const latestFailed = deliveries.find((d) => d.status === 'failed') ?? null;

  return (
    <section className="invoice-ebill-panel panel" aria-label={t('ebill.title')}>
      <h2 className="documents-section-title">{t('ebill.title')}</h2>

      {deliveries.length === 0 && (
        <p className="invoice-ebill-empty">{t('ebill.empty')}</p>
      )}

      {active !== null && (
        <dl className="invoice-ebill-facts">
          <dt>{t('ebill.statusLabel')}</dt>
          <dd>
            <span aria-hidden="true">{STATUS_GLYPH[active.status]} </span>
            <span aria-label={t(`ebill.status.${active.status}`)}>{t(`ebill.status.${active.status}`)}</span>
          </dd>
          {active.status === 'submitting' && (
            <>
              <dt>{t('ebill.hintLabel')}</dt>
              <dd>{t('ebill.submittingHint')}</dd>
            </>
          )}
          {active.partnerStatus !== null && (
            <>
              <dt>{t('ebill.partnerStatusLabel')}</dt>
              <dd>
                {partnerStatusKey(active.partnerStatus) === ''
                  ? active.partnerStatus
                  : t(partnerStatusKey(active.partnerStatus))}
                {active.partnerStatus === 'REJECTED' && active.partnerReason !== null && (
                  <span className="invoice-ebill-reason"> {active.partnerReason}</span>
                )}
              </dd>
            </>
          )}
          {active.pdfaProfile !== 'PDF/A-3b' && (
            <>
              <dt>{t('ebill.conformanceLabel')}</dt>
              <dd className="invoice-ebill-pending">{t('ebill.pdfaPending')}</dd>
            </>
          )}
          {active.partnerStatus === 'REJECTED' && (
            <>
              <dt>{t('ebill.recoveryLabel')}</dt>
              <dd>{t('ebill.rejectedRecovery')}</dd>
            </>
          )}
        </dl>
      )}

      {notice !== null && (
        <div className="invoice-ebill-notice panel" role="alert">
          {notice.kind === 'cloud_tier' && <p>{t('ebill.cloudTierCard')}</p>}
          {notice.kind === 'needs_biller_pid' && (
            <p>
              {t('ebill.needsBillerPid')} <Link className="link-inline" to="/setup">{t('ebill.setupLink')}</Link>
            </p>
          )}
          {notice.kind === 'payload_not_conformant' && (
            <p>{t('ebill.notConformant', { detail: notice.detail ?? '' })}</p>
          )}
          {notice.kind === 'error' && (
            <p>{notice.detail === 'invalid_state' ? t('ebill.invalidState') : t('document.genericError')}</p>
          )}
        </div>
      )}

      <div className="invoice-ebill-actions">
        {active === null && (
          <>
            {canIssue ? (
              <button type="button" className="btn btn--secondary" disabled={busy || !preparable} onClick={() => void prepare()}>
                {t('ebill.prepare')}
              </button>
            ) : (
              <p className="invoice-ebill-locked">{t('ebill.prepareLocked')}</p>
            )}
            {canIssue && !preparable && <p className="invoice-ebill-locked">{t('ebill.invalidState')}</p>}
          </>
        )}

        {active !== null && active.artifactDocumentId !== null && (
          <button type="button" className="btn btn--secondary" onClick={() => void download(active.artifactDocumentId as string)}>
            {t('ebill.downloadArtifact')}
          </button>
        )}

        {active !== null && active.status === 'prepared' && (
          canSend ? (
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void transmit(active.id)}>
              {t('ebill.transmit')}
            </button>
          ) : (
            <p className="invoice-ebill-locked">{t('ebill.transmitLocked')}</p>
          )
        )}

        {active === null && latestFailed !== null && canIssue && preparable && (
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void prepare()}>
            {t('ebill.retryPrepare')}
          </button>
        )}
      </div>
    </section>
  );
}
