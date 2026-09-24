/**
 * A11's editor pieces, EXTENDING A10's shared `DocumentEditor` rather than forking it.
 *
 * `Invoices` from the spec's §6 is S1 with `?type=invoice`, not a second list, and `InvoiceEditor` is
 * S2 with the invoice-only rows switched on, not a second editor. So this module ships the two things
 * that are genuinely invoice-shaped and lets the base own everything else (positions grid, live VAT
 * through A06's controls, totals, issue action):
 *
 *  - `InvoiceTerms`: the Konditionen row (due date, the customer's own payment terms as a one-click
 *    default, and the payment reference, which is stated as pending because it does not exist yet).
 *  - `QrReadinessPanel`: what the draft can HONESTLY say about the QR-bill before issue.
 *
 * On that second point, deliberately: a draft has no QR-bill at all. The engine refuses one
 * (`not_available` / `draft_has_no_qr_bill`) because the reference is seeded from the real invoice
 * number, so a draft-time preview would show a reference that CHANGES at issue. The design cut it for
 * exactly that reason ("a fabricated reference: data dishonesty"). What the editor can say is whether
 * the inputs are ready: a structured customer address (M10), an IBAN (M9), a QR currency (M13). The
 * QR itself first appears on S3.
 */
import { Link } from 'react-router-dom';

import { useT, formatDate } from '../../i18n';
import { DocumentEditor } from './DocumentEditor';
import {
  dueDateFrom,
  isQrReady,
  qrGapLines,
  qrReadiness,
  type InvoiceContact,
  type QrGapLine,
} from './invoice';

/**
 * The named A11 surface (spec §6): S2 with the type pinned to invoice. It is the shared editor, not a
 * copy of it, so every A10 fix (the in-place issue swap, the dirty guard, the delete confirm) applies
 * here by construction instead of by duplication.
 */
export function InvoiceEditor() {
  return <DocumentEditor forcedType="invoice" />;
}

export interface InvoiceTermsProps {
  /** The document's own date, the base for a terms-derived due date. */
  issueDate: string;
  /** The due date on the wire (ISO) or '' for none. */
  dueDate: string;
  onDueDateChange: (iso: string) => void;
  /** The chosen customer, for their stored payment terms. Undefined until one is picked. */
  contact: InvoiceContact | undefined;
  /** The assigned payment reference, once the invoice has one. A draft has none, and says so. */
  reference?: string | null;
  disabled?: boolean;
}

/**
 * The Konditionen row. The customer's stored payment terms are offered as a one-click default rather
 * than applied silently: the due date is a real field on the document, and guessing it for the
 * operator would put a date on an invoice that nobody chose.
 */
export function InvoiceTerms({
  issueDate,
  dueDate,
  onDueDateChange,
  contact,
  reference,
  disabled = false,
}: InvoiceTermsProps) {
  const t = useT();
  const termsDays = contact?.paymentTermsDays ?? null;
  const suggested = dueDateFrom(issueDate, termsDays);
  const canApply = suggested !== null && suggested !== dueDate;

  return (
    <section className="invoice-terms panel" aria-label={t('invoice.terms.title')}>
      <h2 className="documents-section-title">{t('invoice.terms.title')}</h2>
      <div className="invoice-terms-row">
        <label className="documents-field">
          <span>{t('invoice.terms.dueDate')}</span>
          <input className="field"
            type="date"
            value={dueDate}
            disabled={disabled}
            onChange={(e) => onDueDateChange(e.target.value)}
            aria-label={t('invoice.terms.dueDate')}
          />
        </label>

        {termsDays !== null && (
          <p className="invoice-terms-hint">
            <span>
              {t('invoice.terms.paymentTerms')}: {t('invoice.terms.termsDays', { days: termsDays })}
            </span>
            {canApply && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={disabled}
                onClick={() => onDueDateChange(suggested)}
              >
                {t('invoice.terms.applyTerms')} ({formatDate(suggested)})
              </button>
            )}
          </p>
        )}

        <p className="invoice-terms-hint">
          <span>{t('invoice.terms.reference')}: </span>
          {reference !== undefined && reference !== null && reference !== '' ? (
            <span className="t-num">{reference}</span>
          ) : (
            <span className="invoice-terms-pending">{t('invoice.terms.referencePending')}</span>
          )}
        </p>
      </div>
    </section>
  );
}

export interface QrReadinessPanelProps {
  contact: InvoiceContact | undefined;
  /** The workspace's creditor IBAN, or null when none is configured. */
  iban: string | null;
  currency: string;
  /** The invoice date: a QR-bill is judged by its own issue date, never by today (v2.4 cutover). */
  issueDate: string;
}

/**
 * QR readiness on a draft: what is missing, and where to fix it. Never a QR, never a reference.
 *
 * M9's narrowing matters here: `needs_qr_iban` fires only when NO IBAN of any kind is configured. A
 * plain IBAN yields a perfectly valid SCOR bill, so this panel never nags for a QR-IBAN specifically.
 *
 * The currency gaps are one line each, on purpose. `CurrencyPicker` carries the full explanation
 * beside the control that causes them (M13: prevent at the control), and both read the same
 * `qrConsequence`, so the checklist and the warning cannot drift apart.
 */
export function QrReadinessPanel({ contact, iban, currency, issueDate }: QrReadinessPanelProps) {
  const t = useT();
  const readiness = qrReadiness({ contact, iban, currency, issueDate });

  if (isQrReady(readiness)) {
    return (
      <section className="invoice-qr panel" aria-label={t('invoice.qr.readiness')}>
        <h2 className="documents-section-title">{t('invoice.qr.readiness')}</h2>
        <p className="invoice-qr-ok">{t('invoice.qr.ready')}</p>
        <p className="invoice-qr-note">{t('invoice.qr.pendingIssue')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-qr panel" aria-label={t('invoice.qr.readiness')}>
      <h2 className="documents-section-title">{t('invoice.qr.readiness')}</h2>
      <ul className="invoice-qr-gaps">
        {qrGapLines(readiness).map((gap) => (
          <li key={gap.key}>
            <QrGapText gap={gap} currency={currency} withWayOut />
          </li>
        ))}
      </ul>
      <p className="invoice-qr-note">{t('invoice.qr.pendingIssue')}</p>
    </section>
  );
}

export interface QrGapTextProps {
  gap: QrGapLine;
  currency: string;
  /** Render the link that fixes it. The issue dialog does not: navigating away would lose the draft. */
  withWayOut?: boolean;
}

/**
 * One readiness gap, rendered. Shared by the editor's checklist and the S4 issue dialog (A11-G11) so
 * the gap a user reads before the irreversible act is literally the same sentence the panel showed.
 */
export function QrGapText({ gap, currency, withWayOut = false }: QrGapTextProps) {
  const t = useT();
  const params: Record<string, string> = { currency };
  if (gap.fields !== undefined) params.fields = gap.fields.map((f) => t(`invoice.qr.field.${f}`)).join(', ');
  if (gap.date !== undefined) params.date = formatDate(gap.date);

  return (
    <>
      {t(gap.key, params)}
      {withWayOut && gap.wayOut !== undefined && (
        <>
          {' '}
          <Link className="link-inline" to={gap.wayOut.to}>{t(gap.wayOut.labelKey)}</Link>
        </>
      )}
    </>
  );
}
