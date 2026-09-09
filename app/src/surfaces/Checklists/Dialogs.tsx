/**
 * G22's four dialogs on the shared `Modal` (D118 B2): Start (pick a period, the last ended one
 * pre-filled), Attest ("Eingereicht am", a date not before the export), Skip ("Nicht zutreffend", a
 * required reason) and Abandon (a required reason). Each carries its consequence sentence in the
 * body (D118 C4; the verbs are not dial-governed by name, so the sentence is this surface's own copy;
 * the agent seat's ePortal attestation drafts under the vat-file dial and never reaches a dialog),
 * keeps the typed value across a validation error, and renders its refusal inline with the way out.
 */
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { Modal, type ModalRole } from '../../components/Modal';
import { useT } from '../../i18n';
import { periodTitle, type PeriodOption } from './model';

/**
 * The Skip and Abandon confirms are consequential: the role rides through a typed constant, never a
 * literal attribute, so the modal-role guard (`test/style/modal-role-on-allowed-element.test.mjs`)
 * reads it on Modal's own div (an allowed host) and not as a modal role planted on the `Modal` name.
 */
const ALERT_DIALOG: ModalRole = 'alertdialog';

export interface StartDialogProps {
  open: boolean;
  onClose: () => void;
  periods: PeriodOption[];
  defaultPeriod: string | null;
  /** The refusal code the last start returned, or null. */
  refusal: string | null;
  refusalPeriods: string[];
  working: boolean;
  onStart: (period: string) => void;
}

export function StartDialog({ open, onClose, periods, defaultPeriod, refusal, refusalPeriods, working, onStart }: StartDialogProps) {
  const t = useT();
  const id = useId();
  const [period, setPeriod] = useState<string>(defaultPeriod ?? periods[0]?.label ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (period !== '') onStart(period);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('checklists.start.title')}
      closeLabel={t('checklists.dialog.close')}
      describedById={`${id}-consequence`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('checklists.dialog.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={working || period === ''}>
            {working ? t('checklists.start.working') : t('checklists.start.action')}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="chk-dialog-form">
        <p className="chk-dialog-template">{t('checklists.start.template')}</p>
        <label htmlFor={`${id}-period`}>{t('checklists.start.period')}</label>
        <select id={`${id}-period`} value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p.label} value={p.label}>
              {periodTitle(p.label)} ({p.periodStart} {t('checklists.rangeTo')} {p.periodEnd})
              {p.filed ? ` ${t('checklists.start.filedSuffix')}` : ''}
            </option>
          ))}
        </select>
        <p id={`${id}-consequence`} className="chk-consequence">
          {t('checklists.start.consequence')}
        </p>
        {refusal === 'needs_vat_config' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.needsConfig')} <Link to="/vat">{t('checklists.start.needsConfigCta')}</Link>
          </p>
        )}
        {refusal === 'period_not_filable' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.notFilable', { periods: refusalPeriods.map(periodTitle).join(', ') })}
          </p>
        )}
        {refusal !== null && refusal !== 'needs_vat_config' && refusal !== 'period_not_filable' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.error.refused', { code: refusal })}
          </p>
        )}
      </form>
    </Modal>
  );
}

export interface AttestDialogProps {
  open: boolean;
  onClose: () => void;
  /** The ISO day the export was recorded, or null when unknown. */
  exportedAt: string | null;
  today: string;
  portalUrl: string;
  refusal: string | null;
  refusalDetail: string | null;
  working: boolean;
  onAttest: (date: string) => void;
}

export function AttestDialog({ open, onClose, exportedAt, today, portalUrl, refusal, refusalDetail, working, onAttest }: AttestDialogProps) {
  const t = useT();
  const id = useId();
  const [date, setDate] = useState(today);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLocalError(t('checklists.attest.needsDate'));
      return;
    }
    if (exportedAt !== null && date < exportedAt) {
      setLocalError(t('checklists.attest.beforeExport', { exportedAt }));
      return;
    }
    setLocalError(null);
    onAttest(date);
  };
  const error = localError ?? (refusal === null ? null : refusal === 'attestation_before_export' && refusalDetail !== null ? t('checklists.attest.beforeExport', { exportedAt: refusalDetail }) : refusal === 'already_attested' ? t('checklists.attest.alreadyAttested', { date: refusalDetail ?? '' }) : t('checklists.error.refused', { code: refusal }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('checklists.attest.title')}
      closeLabel={t('checklists.dialog.close')}
      describedById={`${id}-consequence`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('checklists.dialog.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={working}>
            {working ? t('checklists.attest.working') : t('checklists.attest.action')}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="chk-dialog-form">
        <p>
          <a href={portalUrl} target="_blank" rel="noreferrer noopener">
            {t('checklists.attest.portal')}
          </a>
        </p>
        <label htmlFor={`${id}-date`}>{t('checklists.attest.date')}</label>
        <input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <p id={`${id}-consequence`} className="chk-consequence">
          {t('checklists.attest.consequence')}
        </p>
        {error !== null && (
          <p className="chk-dialog-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export interface ReasonDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  consequence: string;
  action: string;
  workingLabel: string;
  refusal: string | null;
  working: boolean;
  /** Danger styling for the abandon case. */
  danger?: boolean;
  onConfirm: (reason: string) => void;
}

/** The Skip and Abandon dialogs share one shape: a required reason and a consequence sentence. */
export function ReasonDialog({ open, onClose, title, label, consequence, action, workingLabel, refusal, working, danger = false, onConfirm }: ReasonDialogProps) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length === 0) {
      setLocalError(t('checklists.reason.needed'));
      return;
    }
    setLocalError(null);
    onConfirm(reason.trim());
  };
  const error = localError ?? (refusal === null ? null : t('checklists.error.refused', { code: refusal }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('checklists.dialog.close')}
      role={ALERT_DIALOG}
      describedById={`${id}-consequence`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('checklists.dialog.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className={danger ? 'btn btn--danger' : 'btn btn--primary'} disabled={working}>
            {working ? workingLabel : action}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="chk-dialog-form">
        <label htmlFor={`${id}-reason`}>{label}</label>
        <textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-required="true" />
        <p id={`${id}-consequence`} className="chk-consequence">
          {consequence}
        </p>
        {error !== null && (
          <p className="chk-dialog-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export interface SignoffDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  consequence: string;
  /** When true the sign-off needs a reference (the payment item). */
  needsReference: boolean;
  refusal: string | null;
  working: boolean;
  onConfirm: (reference: string | null) => void;
}

/** The bridge review and the payment sign-off: a confirm with an optional reference field. */
export function SignoffDialog({ open, onClose, title, consequence, needsReference, refusal, working, onConfirm }: SignoffDialogProps) {
  const t = useT();
  const id = useId();
  const [reference, setReference] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (needsReference && reference.trim().length === 0) {
      setLocalError(t('checklists.signoff.needsReference'));
      return;
    }
    setLocalError(null);
    onConfirm(needsReference ? reference.trim() : null);
  };
  const error = localError ?? (refusal === null ? null : t('checklists.error.refused', { code: refusal }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('checklists.dialog.close')}
      describedById={`${id}-consequence`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('checklists.dialog.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={working}>
            {working ? t('checklists.signoff.working') : t('checklists.signoff.action')}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="chk-dialog-form">
        {needsReference && (
          <>
            <label htmlFor={`${id}-ref`}>{t('checklists.signoff.reference')}</label>
            <input id={`${id}-ref`} type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('checklists.signoff.referenceHint')} />
          </>
        )}
        <p id={`${id}-consequence`} className="chk-consequence">
          {consequence}
        </p>
        {error !== null && (
          <p className="chk-dialog-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
