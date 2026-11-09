/**
 * A11's editor pieces, EXTENDING A10's shared `DocumentEditor` rather than forking it.
 *
 * `Invoices` from the spec's §6 is S1 with `?type=invoice`, not a second list, and `InvoiceEditor` is
 * S2 with the invoice-only rows switched on, not a second editor. So this module ships the two things
 * that are genuinely invoice-shaped and lets the base own everything else (positions grid, live VAT
 * through A06's controls, totals, issue action):
 *
 *  - `InvoiceTerms`: the Konditionen row (the due date: the person's own, or the one the issue
 *    derives from the customer's terms, stated and never stored; the payment reference, pending
 *    behind the (i) until it exists).
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
import { EditorInfo } from './EditorInfo';
import {
  isQrReady,
  qrGapLines,
  qrReadiness,
  type CreditorView,
  type InvoiceContact,
  type QrGapLine,
  type DueDateDerivation,
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
  /** The due date the person set (ISO), or '' when the field is untouched. */
  dueDate: string;
  onDueDateChange: (iso: string) => void;
  /**
   * The customer whose terms the ENGINE will apply at issue when the field stays empty, and their
   * days (null when none are on file, so the workspace default applies). Null when nothing is
   * derived: no customer yet, or the person set the date.
   */
  derivedFrom: DueDateDerivation | null;
  /** The assigned payment reference, once the invoice has one. A draft has none, and says so. */
  reference?: string | null;
  disabled?: boolean;
}

/**
 * The Konditionen row (D152 rule 1, infer before asking). An untouched due date is not a blank to
 * fill: the engine derives it at issue from the issue date it stamps and the customer's payment
 * terms (or the workspace default), so the row states that as a one-line value and stores nothing
 * (critic F3: a guess persisted on a draft froze into a "decision" that no longer followed the
 * date). A date the person sets is theirs and is sent as typed. Where the derivation comes from,
 * and that the payment reference only exists from the issue on, live behind the (i) (rule 4).
 */
export function InvoiceTerms({ dueDate, onDueDateChange, derivedFrom, reference, disabled = false }: InvoiceTermsProps) {
  const t = useT();
  const hasReference = reference !== undefined && reference !== null && reference !== '';
  const hint =
    derivedFrom === null
      ? null
      : derivedFrom.days > 0
        ? t('invoice.terms.derivedDays', { days: derivedFrom.days })
        : t('invoice.terms.derivedImmediate');
  const info = [
    derivedFrom === null
      ? null
      : derivedFrom.source === 'contact'
        ? derivedFrom.days > 0
          ? t('invoice.terms.fromTerms', { name: derivedFrom.name, days: derivedFrom.days })
          : t('invoice.terms.fromTermsImmediate', { name: derivedFrom.name })
        : derivedFrom.source === 'workspace'
          ? t('invoice.terms.fromDefault', { name: derivedFrom.name, days: derivedFrom.days })
          : t('invoice.terms.fromNone', { name: derivedFrom.name }),
    hasReference ? null : t('invoice.terms.referencePending'),
  ].filter((line): line is string => line !== null);

  return (
    <section className="invoice-terms panel" aria-label={t('invoice.terms.title')}>
      <h2 className="documents-section-title">{t('invoice.terms.title')}</h2>
      <div className="invoice-terms-row">
        {/* A div, not a label: the (i) is a button, and a label would take the first labelable
            element inside it as its control. The input carries its own accessible name. */}
        <div className="documents-field">
          <span className="documents-field-head">
            <span aria-hidden="true">{t('invoice.terms.dueDate')}</span>
            {info.length > 0 && <EditorInfo label={t('invoice.terms.infoLabel')}>{info.join(' ')}</EditorInfo>}
          </span>
          <input className="field"
            type="date"
            value={dueDate}
            disabled={disabled}
            onChange={(e) => onDueDateChange(e.target.value)}
            aria-label={t('invoice.terms.dueDate')}
            aria-describedby={hint !== null ? 'invoice-terms-derived' : undefined}
          />
        </div>
        {hint !== null && (
          <p id="invoice-terms-derived" className="invoice-terms-hint">
            {hint}
          </p>
        )}
        {hasReference && (
          <p className="invoice-terms-hint">
            <span>{t('invoice.terms.reference')}: </span>
            <span className="t-num">{reference}</span>
          </p>
        )}
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
  /** P0.4e: the workspace's own creditor name and address; omitted, no creditor gap is claimed. */
  creditor?: CreditorView | null;
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
export function QrReadinessPanel({ contact, iban, currency, issueDate, creditor }: QrReadinessPanelProps) {
  const t = useT();
  const readiness = qrReadiness({ contact, iban, currency, issueDate, creditor });

  // D152 rule 4: why there is no QR on a draft is an explanation, so it sits behind the (i) beside
  // the heading. The state itself (ready, or each gap with its way out) stays on the surface.
  const head = (
    <h2 className="documents-section-title documents-section-title--info">
      {t('invoice.qr.readiness')}
      <EditorInfo label={t('invoice.qr.infoLabel')}>{t('invoice.qr.pendingIssue')}</EditorInfo>
    </h2>
  );

  if (isQrReady(readiness)) {
    return (
      <section className="invoice-qr panel" aria-label={t('invoice.qr.readiness')}>
        {head}
        <p className="invoice-qr-ok">{t('invoice.qr.ready')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-qr panel" aria-label={t('invoice.qr.readiness')}>
      {head}
      <ul className="invoice-qr-gaps">
        {qrGapLines(readiness).map((gap) => (
          <li key={gap.key}>
            <QrGapText gap={gap} currency={currency} withWayOut />
          </li>
        ))}
      </ul>
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
