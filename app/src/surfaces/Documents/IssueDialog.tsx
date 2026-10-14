/**
 * S4, the issue confirmation dialog (INV-3): the one deliberate act before the irreversible posting
 * step. It states exactly what will happen (a number is assigned; for a financial document, a balanced
 * entry is posted; issued documents become immutable) and nothing irrelevant: a quote/order names only
 * the number line, since issuing one posts nothing. The engine's structured error (period_locked, ...)
 * renders inline and the dialog does NOT close on failure, so input and intent survive.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatMoney } from '../../i18n';
import type { Err } from '../../lib/client';
import { Modal } from '../../components/Modal';
import { refusalText } from '../../components/states';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { invoiceErrorKey, type QrGapLine } from './invoice';
import { QrGapText } from './InvoiceEditor';
import {
  QrCompletion,
  hasQrFixNeeds,
  planQrFix,
  type QrFixBlock,
  type QrFixCall,
  type QrFixNeeds,
  type QrFixValues,
} from './QrCompletion';

/** The gap lines the inline completion form answers itself; the rest stay listed as consequences. */
const FIXABLE_GAP_KEYS = new Set(['invoice.qr.needsIban', 'invoice.qr.needsCreditorAddress', 'invoice.qr.missingAddress']);

/** The save refusals the completion form names; anything else gets the honest generic line. */
const QR_FIX_ERROR_KEYS: Record<string, string> = {
  invalid_iban: 'invoice.qrFix.invalidIban',
  illegal_character: 'invoice.qrFix.illegalCharacter',
  needs_structured_address: 'invoice.qrFix.incomplete',
  // The QR-bill's own value rules, now refused where they are typed (critic phase0-installable r1,
  // P0.4e-6/7): a country that is not alpha-2, an element over its IG length, a non-CH/LI IBAN.
  invalid_country: 'invoice.qrFix.invalidCountry',
  field_too_long: 'invoice.qrFix.fieldTooLong',
  iban_not_ch_li: 'invoice.qrFix.ibanNotChLi',
};

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
          {t(key, {
            currency: String(error.currency ?? ''),
            date: String(error.date ?? ''),
            // F3 (critic round 4): needs_supply_date names the position and its code.
            number: String(error.position ?? ''),
            code: String(error.taxCode ?? ''),
          })}
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
  /**
   * Critic R2-2: false when the editor has no engine figure to state (a member without read_vat gets
   * no VAT preview). The confirm then says a posting is made and that TILL computes the amounts at
   * issue, and states no amount at all: never a total the engine will not post.
   */
  figuresKnown?: boolean;
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
  /** One-line facts the person should read before the irreversible act (a due date already past). */
  notices?: string[];
  /**
   * F-03 (J3.5): the customer's address on file, or null. When an invoice has one, the dialog
   * offers "Anschliessend senden" as a default-on line and the ONE confirm covers both acts
   * ("Ausstellen und senden"): D 2 -> 1, and no second dialog asks for an address it already has.
   */
  sendTo?: string | null;
  sendChecked?: boolean;
  onSendChange?: (checked: boolean) => void;
  /**
   * P0.4e: what the QR-bill still lacks that the person can type right here (creditor address,
   * IBAN, customer address), with the values already stored and the save that runs the owning verbs.
   * When given with a real need, the dialog ASKS before issuing (see `QrCompletion`); left blank, the
   * invoice issues exactly as before, stating it has no payment part. Never a blocker (A11-G9).
   */
  qrFix?: {
    needs: QrFixNeeds;
    initial: QrFixValues;
    /** Runs the calls in order; answers the first refusal, or null when every call succeeded. */
    onSave: (calls: QrFixCall[]) => Promise<Err | null>;
  };
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
  figuresKnown = true,
  taxMinor = 0,
  currency,
  qrGaps = [],
  notices = [],
  sendTo = null,
  sendChecked = false,
  onSendChange,
  qrFix,
  busy,
  error,
  onConfirm,
  onCancel,
}: IssueDialogProps) {
  const t = useT();
  const bodyId = 'issue-dialog-body';
  const offersSend = isInvoice && sendTo !== null && sendTo !== '';
  const willSend = offersSend && sendChecked;

  // P0.4e: the inline completion form, only for an invoice that has something the person can fix here.
  const fix = isInvoice && qrFix !== undefined && hasQrFixNeeds(qrFix.needs) ? qrFix : null;
  const asksQr = fix !== null;
  const [fixValues, setFixValues] = useState<QrFixValues | null>(qrFix?.initial ?? null);
  const [incomplete, setIncomplete] = useState<{ blocks: QrFixBlock[]; invalidIban: boolean } | null>(null);
  const [saveErr, setSaveErr] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);
  const plan = fix !== null && fixValues !== null ? planQrFix(fix.needs, fix.initial, fixValues) : { kind: 'none' as const };
  const answering = plan.kind !== 'none';
  const listedGaps = asksQr ? qrGaps.filter((g) => !FIXABLE_GAP_KEYS.has(g.key)) : qrGaps;

  async function confirm(): Promise<void> {
    if (fix === null || plan.kind === 'none') {
      onConfirm();
      return;
    }
    if (plan.kind === 'incomplete') {
      setIncomplete({ blocks: plan.blocks, invalidIban: plan.invalidIban });
      return;
    }
    setIncomplete(null);
    setSaveErr(null);
    setSaving(true);
    const refused = await fix.onSave(plan.calls);
    setSaving(false);
    if (refused !== null) {
      // Nothing is issued after a refused save: the person fixes the field and confirms again.
      setSaveErr(refused);
      return;
    }
    onConfirm();
  }

  const confirmLabel = answering
    ? t(willSend ? 'invoice.qrFix.saveIssueAndSend' : 'invoice.qrFix.saveAndIssue')
    : willSend
      ? t('invoice.issue.confirmAndSend')
      : t('document.issue.confirm');

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
            disabled={busy || saving}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div id={bodyId} className="documents-confirm-body">
        <p>{t('document.issue.numberLine')}</p>
        {posts ? (
          <>
            {figuresKnown ? (
              <p>
                {t(isCreditNote ? 'creditNote.issue.postingLine' : 'document.issue.postingLine', {
                  total: formatMoney(totalMinor, currency),
                })}
              </p>
            ) : (
              <p>{t(isCreditNote ? 'creditNote.issue.postingLineUnpriced' : 'document.issue.postingLineUnpriced')}</p>
            )}
            {figuresKnown && taxMinor > 0 && <p>{t('invoice.issue.vatLine', { tax: formatMoney(taxMinor, currency) })}</p>}
            <p>{t('document.issue.immutabilityLine')}</p>
          </>
        ) : (
          <p>{t('document.issue.quoteLine')}</p>
        )}
        {notices.map((notice) => (
          <p key={notice} className="documents-confirm-notice">
            {notice}
          </p>
        ))}
        {/* A11-G11: the last honest moment to learn this invoice cannot be paid by QR. It carries
            no alarm colour and no way-out link on purpose: nothing is blocked (A11-G9), and a link
            out of a modal over an unsaved draft would be a trap, not a cure. Cancel, fix, return. */}
        {isInvoice && listedGaps.length > 0 && (
          <div className="documents-confirm-consequence">
            <p>{t('invoice.issue.noQrLine')}</p>
            <ul>
              {listedGaps.map((gap) => (
                <li key={gap.key}>
                  <QrGapText gap={gap} currency={currency} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* P0.4e: ask for what the payment part still lacks, here, before the irreversible act. */}
        {fix !== null && fixValues !== null && (
          <QrCompletion
            needs={fix.needs}
            values={fixValues}
            onChange={(next) => {
              setFixValues(next);
              setIncomplete(null);
              setSaveErr(null);
            }}
            disabled={busy || saving}
            incomplete={incomplete}
          />
        )}
        {saveErr !== null && (
          <p className="documents-confirm-error" role="alert">
            {refusalText(t, saveErr, { keys: QR_FIX_ERROR_KEYS, fallback: 'invoice.qrFix.saveFailed' })}
          </p>
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
