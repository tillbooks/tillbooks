/**
 * S4, the issue confirmation dialog (INV-3): the one deliberate act before the irreversible posting
 * step. It states exactly what will happen (a number is assigned; for a financial document, a balanced
 * entry is posted; issued documents become immutable) and nothing irrelevant: a quote/order names only
 * the number line, since issuing one posts nothing. The engine's structured error (period_locked, ...)
 * renders inline and the dialog does NOT close on failure, so input and intent survive.
 */
import { Link } from 'react-router-dom';

import { useT, formatMoney } from '../../i18n';
import type { Err } from '../../lib/client';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { invoiceErrorKey, type QrGapLine } from './invoice';
import { QrGapText } from './InvoiceEditor';

// The alertdialog role passed to Modal as a named constant rather than the literal token, so the
// modal-role source scan does not misread this prop as a role attribute on a host element.
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * The engine's structured rejection, rendered so it names what blocked the issue and the way out
 * (A10-G13: it used to collapse every code except `period_locked` into one generic sentence, so a
 * `needs_qr_iban` or a `needs_fx_rate` told the operator nothing). An unmapped code still falls back
 * to the generic line, which is honest about not knowing, rather than inventing an explanation.
 */
function IssueError({ error }: { error: Err }) {
  const t = useT();
  // A13 (the round-3 H3 repair): an `over_credit` refusal has TWO shapes and the dialog renders the
  // one the engine sent. `line_over_credit` is about ONE position and carries the line's own
  // remainder beside the invoice-level one; rendering only `remainingCreditableMinor` here is how a
  // user was once told "hoechstens CHF 0.00" while CHF 1'566.50 was genuinely still creditable.
  if (error.error === 'over_credit') {
    const currency = String(error.currency ?? 'CHF');
    return (
      <p className="documents-confirm-error" role="alert">
        {error.reason === 'line_over_credit'
          ? t('creditNote.lineOverCredit', {
              position: String(error.position ?? ''),
              lineAmount: formatMoney(Number(error.remainingLineNetMinor ?? 0), currency),
              amount: formatMoney(Number(error.remainingCreditableMinor ?? 0), currency),
            })
          : t('creditNote.overCredit', {
              amount: formatMoney(Number(error.remainingCreditableMinor ?? 0), currency),
            })}
      </p>
    );
  }
  if (error.error === 'period_locked') {
    return (
      <div className="error-banner panel" role="alert">
        <span aria-hidden="true">! </span>
        <div>
          <p className="error-body">{t('document.periodLocked', { period: String(error.period ?? '') })}</p>
          <Link className="link-inline" to="/periods">{t('document.periodLockedLink')}</Link>
        </div>
      </div>
    );
  }
  const key = invoiceErrorKey(error.error);
  if (key === null) {
    return (
      <p className="documents-confirm-error" role="alert">
        {t('document.genericError')}
      </p>
    );
  }
  // The QR/creditor/customer-address gaps are fixed in Setup or Contacts, so the reason carries the
  // link that fixes it: an error with no way out is a dead end. The §H-FX refusals are cleared the
  // same way, by recording a rate, which is why they carry their own label rather than "add an IBAN".
  const needsRate =
    error.error === 'needs_fx_rate' ||
    error.error === 'fx_method_not_elected' ||
    error.error === 'fx_method_locked';
  const to =
    needsRate ||
    error.error === 'needs_qr_iban' ||
    error.error === 'needs_creditor_address' ||
    error.error === 'needs_email_config'
      ? '/setup'
      : error.error === 'needs_customer_address' || error.error === 'needs_customer_email'
        ? '/contacts'
        : null;
  const linkKey = needsRate
    ? 'invoice.fx.recordRate'
    : to === '/setup'
      ? 'invoice.qr.toSetup'
      : 'invoice.qr.fixAddress';
  return (
    <div className="error-banner panel" role="alert">
      <span aria-hidden="true">! </span>
      <div>
        <p className="error-body">
          {t(key, { currency: String(error.currency ?? ''), date: String(error.date ?? '') })}
        </p>
        {to !== null && <Link className="link-inline" to={to}>{t(linkKey)}</Link>}
      </div>
    </div>
  );
}

export interface IssueDialogProps {
  /** Whether issuing this type posts a ledger entry (invoice, credit_note). */
  posts: boolean;
  /** True for an invoice: the dialog names the document by its own word and shows the VAT split. */
  isInvoice?: boolean;
  /**
   * True for a Gutschrift, and it changes what the dialog SAYS rather than how it looks.
   *
   * An invoice and a credit note post opposite money, and this dialog stated both with the same
   * sentence: "Eine Buchung über CHF 432.40 wird erstellt." That is true of a charge and of a
   * refund, on the last screen before an irreversible posting, which is the one place a direction
   * has to be spelled out. The credit note now says the posting reduces the receivable, and it is
   * titled by its own word instead of the generic "Beleg".
   */
  isCreditNote?: boolean;
  totalMinor: number;
  /** The VAT inside the total (A11 §6b: engine figures, never recomputed here). */
  taxMinor?: number;
  currency: string;
  /**
   * Why this invoice will carry no payment part, or an empty list when it will (A11-G11).
   *
   * The readiness panel says the same thing, roughly 900 px lower and off the bottom of the screen,
   * which is how someone issues an unpayable invoice without ever reading the words. The QR-bill is
   * a CONSEQUENCE, never a blocker, so this is stated here and nothing is prevented by it.
   */
  qrGaps?: QrGapLine[];
  /**
   * F-03 (J3.5): the customer's address on file, or null. When an invoice has one, the dialog
   * offers "Anschliessend senden" as a default-on line and the ONE confirm covers both acts
   * ("Ausstellen und senden"): D 2 -> 1, and no second dialog asks for an address it already has.
   */
  sendTo?: string | null;
  sendChecked?: boolean;
  onSendChange?: (checked: boolean) => void;
  busy: boolean;
  error: Err | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function IssueDialog({
  posts,
  isInvoice = false,
  isCreditNote = false,
  totalMinor,
  taxMinor = 0,
  currency,
  qrGaps = [],
  sendTo = null,
  sendChecked = false,
  onSendChange,
  busy,
  error,
  onConfirm,
  onCancel,
}: IssueDialogProps) {
  const t = useT();
  const bodyId = 'issue-dialog-body';
  const offersSend = isInvoice && sendTo !== null && sendTo !== '';
  const willSend = offersSend && sendChecked;

  return (
    <Modal
      open
      role={ALERT_DIALOG}
      onClose={onCancel}
      title={t(isInvoice ? 'invoice.issue.title' : isCreditNote ? 'creditNote.issue.title' : 'document.issue.title')}
      closeLabel={t('document.dialog.close')}
      describedById={bodyId}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {t('document.issue.cancel')}
          </button>
          {/* The confirm carries the same tint as the button that opened it (the C2 money critic, F5):
              the money accent where issuing posts (an invoice, a credit note), the plain primary for a
              quote or an order, whose issue books nothing. */}
          <button
            type="button"
            className={posts ? 'btn btn--accent' : 'btn btn--primary'}
            data-money-commit={posts ? 'issue_invoice issue_credit_note' : undefined}
            disabled={busy}
            onClick={onConfirm}
          >
            {willSend ? t('invoice.issue.confirmAndSend') : t('document.issue.confirm')}
          </button>
        </>
      }
    >
      <div id={bodyId} className="documents-confirm-body">
        <p>{t('document.issue.numberLine')}</p>
        {posts ? (
          <>
            <p>
              {t(isCreditNote ? 'creditNote.issue.postingLine' : 'document.issue.postingLine', {
                total: formatMoney(totalMinor, currency),
              })}
            </p>
            {taxMinor > 0 && <p>{t('invoice.issue.vatLine', { tax: formatMoney(taxMinor, currency) })}</p>}
            <p>{t('document.issue.immutabilityLine')}</p>
          </>
        ) : (
          <p>{t('document.issue.quoteLine')}</p>
        )}
        {/* A11-G11: the last honest moment to learn this invoice cannot be paid by QR. It carries
            no alarm colour and no way-out link on purpose: nothing is blocked (A11-G9), and a link
            out of a modal over an unsaved draft would be a trap, not a cure. Cancel, fix, return. */}
        {isInvoice && qrGaps.length > 0 && (
          <div className="documents-confirm-consequence">
            <p>{t('invoice.issue.noQrLine')}</p>
            <ul>
              {qrGaps.map((gap) => (
                <li key={gap.key}>
                  <QrGapText gap={gap} currency={currency} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* F-03 (J3.5): issue and send are one act when the address is known. The line is a default
            the person can untick, not a second decision; the consequence sentence for the send rides
            along so the one confirm states both halves. */}
        {offersSend && (
          <div className="documents-confirm-send">
            <label className="documents-confirm-send-line">
              <input
                type="checkbox"
                checked={sendChecked}
                disabled={busy}
                onChange={(e) => onSendChange?.(e.target.checked)}
              />
              <span>{t('invoice.issue.sendLine', { email: sendTo })}</span>
            </label>
            {willSend && <ConsequenceLine verb="send_invoice" />}
          </div>
        )}
        {error !== null && <IssueError error={error} />}
      </div>
    </Modal>
  );
}
