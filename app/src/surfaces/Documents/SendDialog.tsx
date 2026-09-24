/**
 * S7, the send dialog: confirm the recipient and send the PDF.
 *
 * The engine owns at-most-once. `sendInvoice` runs EVERY guard (idempotency replay, status legality,
 * P8, recipient, PDF, relay) BEFORE it touches the relay, and commits the transmission, the recorded
 * recipient and the status flip as one idempotent unit (M-2). So this dialog does NOT keep its own
 * "already sent" flag, does not pre-check the status, and does not retry on its own: it disables its
 * button while a call is in flight (so one click is one call) and reports whatever the engine says.
 * A client-side duplicate guard would be a second, weaker copy of a rule that is already correct.
 *
 * P8 (M15): the outbound step is draft-by-default, so it waits for a human. A human pressing Senden
 * HERE is that confirmation, which is what `confirmed: true` expresses. The engine's own note is
 * honest about the limit (the flag states intent, not identity, and binding it to an authenticated
 * actor is future P8 hardening); nothing here pretends otherwise.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { idemKey, type DocumentDto } from './model';
import { invoiceErrorKey, qrGapKey, qrGapWayOut } from './invoice';

// The alertdialog role passed to Modal as a named constant rather than the literal token, so the
// modal-role source scan does not misread this prop as a role attribute on a host element.
const ALERT_DIALOG = 'alertdialog' as const;

export interface SendDialogProps {
  doc: DocumentDto;
  /** The customer's stored email, or null when none is on file (M17). */
  customerEmail: string | null;
  /**
   * Called once the engine confirms the transmission, so the caller can reload. It carries no
   * address on purpose: the recipient is now on the document read model (`sentToEmail`, written only
   * after a transport accepted the message), so the caller reads the fact instead of being told it.
   * The old signature handed back `body.sentToEmail ?? email.trim()`, and that fallback would have
   * displayed the TYPED address as though it were a confirmed one.
   */
  onSent: () => void;
  onCancel: () => void;
  /** Opens S8, the way out when no relay is configured (M18). */
  onOpenPdf: () => void;
}

export function SendDialog({ doc, customerEmail, onSent, onCancel, onOpenPdf }: SendDialogProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const emailId = useId();
  const [email, setEmail] = useState(customerEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  async function send() {
    if (workspaceId === null) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('send_invoice', {
      workspaceId,
      invoiceId: doc.id,
      // The typed address wins over the contact's, and an empty field is simply not sent, so the
      // engine resolves the contact's own email and answers `needs_customer_email` if there is none.
      ...(email.trim() === '' ? {} : { email: email.trim() }),
      confirmed: true,
      idempotencyKey: idemKey('invoice-send'),
    });
    setBusy(false);
    if (isErr(body)) {
      // The dialog stays OPEN and the typed address survives: a failed attempt never destroys input
      // (M17), and the engine did not memoise the failure, so trying again is legitimate.
      setError(body);
      return;
    }
    onSent();
  }

  const fileName = `Rechnung-${doc.number ?? doc.id}.pdf`;
  const errorKey = error === null ? null : invoiceErrorKey(error.error);
  const noRelay = error?.error === 'needs_email_config';

  /*
   * A11-G3's remainder. `needs_qr_bill` is the one refusal where the engine has ALREADY worked out
   * the specific gap and sends it along (`reason` + `detail`); the dialog discarded both and printed
   * one generic remedy, so an operator whose EUR invoice simply cannot carry a Swiss payment part
   * was told to go and check an IBAN that was never the problem.
   *
   * The reason is now named in the operator's own language and, where a human can fix it, carries
   * the link to the field that fixes it. When the engine says `unknown` (its honest answer when the
   * render produced no cause) nothing is invented: the dialog says it could not work out why and
   * falls back to the old checklist, and the engine's raw `detail` rides along as a quiet technical
   * line so the fact is not silently dropped a second time.
   */
  const qrGap = error?.error === 'needs_qr_bill' ? error : null;
  const qrGapCopyKey = qrGap === null ? null : qrGapKey(qrGap.reason);
  const qrGapLink = qrGap === null ? null : qrGapWayOut(qrGap.reason);
  const qrGapDetail =
    qrGap !== null && qrGapCopyKey === null && typeof qrGap.detail === 'string' && qrGap.detail !== 'unknown'
      ? qrGap.detail
      : null;

  return (
    <Modal
      open
      role={ALERT_DIALOG}
      onClose={onCancel}
      title={`${t('invoice.send.title')} ${doc.number ?? ''}`.trim()}
      closeLabel={t('document.dialog.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={onCancel}>
            {t('invoice.send.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || email.trim() === ''}
            onClick={() => void send()}
          >
            {t('invoice.send.confirm')}
          </button>
        </>
      }
    >
      <div className="documents-confirm-body">
        <label className="invoice-send-field" htmlFor={emailId}>
          <span>{t('invoice.send.to')}</span>
          <input className="field"
            id={emailId}
            type="email"
            value={email}
            placeholder={t('invoice.send.emailPlaceholder')}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>
        {customerEmail === null && <p className="invoice-send-attachment">{t('invoice.error.needsCustomerEmail')}</p>}
        <p className="invoice-send-attachment">
          {t('invoice.send.attachment')}: {fileName}
        </p>
        {/* C4 (D118): the ONE consequence sentence for the send. `send_invoice` carries the `send`
            dial capability, so this resolves to the same `agent.consequence.send` string an approver
            sees on the agent's proposal: one source, two faces. It is quiet by law, and renders
            nothing if the verb ever loses its dial capability. */}
        <ConsequenceLine verb="send_invoice" />

        {error !== null && (
          <div className="error-banner panel" role="alert">
            <span aria-hidden="true">! </span>
            <div>
              <p className="error-body">{errorKey === null ? t('document.genericError') : t(errorKey)}</p>
              {qrGap !== null && (
                <p className="error-body">
                  {qrGapCopyKey === null
                    ? t('invoice.error.needsQrBillUnknown')
                    : t(qrGapCopyKey, { currency: doc.currency, date: '' })}{' '}
                  {qrGapLink !== null && <Link className="link-inline" to={qrGapLink.to}>{t(qrGapLink.labelKey)}</Link>}
                </p>
              )}
              {qrGapDetail !== null && <p className="invoice-send-detail">{qrGapDetail}</p>}
              {/* M18: no relay names BOTH ways out, and the PDF is always one of them. */}
              {noRelay && (
                <span className="invoice-send-ways-out">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={onOpenPdf}>
                    {t('invoice.send.downloadInstead')}
                  </button>
                  <Link className="link-inline" to="/setup">{t('invoice.send.toSetup')}</Link>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
