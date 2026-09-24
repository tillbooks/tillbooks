/**
 * G22's dialogs on the shared `Modal` (D118 B2): Start (the template radio and the period, the last
 * ended one pre-filled), Attest ("Eingereicht am", a date not before the export), Skip ("Nicht
 * zutreffend", a required reason), Abandon (a required reason), Sign-off (a confirm with an optional
 * reference), and leg 2's three: Acknowledge (a warn validation's reason, S9), GV (the attestation
 * date with the reason a date before the sign-off needs) and ConfirmAct (the consequence confirm in
 * front of every domain verb a posting row calls, D118 C4). Each carries its consequence sentence in
 * the body, keeps the typed value across a validation error, and renders its refusal inline.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Modal, type ModalRole } from '../../components/Modal';
import { Select } from '../../components/Select';
import { useT } from '../../i18n';
import { periodTitle, TEMPLATE_IDS, type PeriodOption, type TemplateId } from './model';

/**
 * The consequential confirms are alert dialogs: the role rides through a typed constant, never a
 * literal attribute, so the modal-role guard (`test/style/modal-role-on-allowed-element.test.mjs`)
 * reads it on Modal's own div (an allowed host) and not as a modal role planted on the `Modal` name.
 */
const ALERT_DIALOG: ModalRole = 'alertdialog';

export interface StartDialogProps {
  open: boolean;
  onClose: () => void;
  /** The period options per template; the VAT ones come from `vat_periods`, the others are derived locally. */
  periodsFor: (templateId: TemplateId) => PeriodOption[];
  defaultPeriodFor: (templateId: TemplateId) => string | null;
  /** The refusal code the last start returned, or null. */
  refusal: string | null;
  refusalPeriods: string[];
  /** The `year_close` run that blocks a December start (`year_close_in_progress`). */
  refusalRunId: string | null;
  working: boolean;
  onStart: (templateId: TemplateId, period: string) => void;
}

export function StartDialog({ open, onClose, periodsFor, defaultPeriodFor, refusal, refusalPeriods, refusalRunId, working, onStart }: StartDialogProps) {
  const t = useT();
  const id = useId();
  const [templateId, setTemplateId] = useState<TemplateId>('vat_period');
  const [period, setPeriod] = useState<string>(defaultPeriodFor('vat_period') ?? periodsFor('vat_period')[0]?.label ?? '');
  const pick = (next: TemplateId) => {
    setTemplateId(next);
    setPeriod(defaultPeriodFor(next) ?? periodsFor(next)[0]?.label ?? '');
  };
  const periods = periodsFor(templateId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (period !== '') onStart(templateId, period);
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
        <fieldset className="chk-choice">
          <legend>{t('checklists.start.template')}</legend>
          {TEMPLATE_IDS.map((tid) => (
            <label key={tid} className="chk-choice-option">
              <input type="radio" className="chk-choice-input" name={`${id}-template`} value={tid} checked={templateId === tid} onChange={() => pick(tid)} />
              <span className="chk-choice-label">{t(`checklists.template.${tid}`)}</span>
              <span className="chk-choice-consequence">{t(`checklists.templateHint.${tid}`)}</span>
            </label>
          ))}
        </fieldset>
        <label htmlFor={`${id}-period`}>{t(`checklists.start.period.${templateId}`)}</label>
        {periods.length === 0 ? (
          <p className="chk-dialog-template">{t('checklists.start.noPeriod')}</p>
        ) : (
          <Select
            id={`${id}-period`}
            value={period}
            onChange={(val) => setPeriod(val)}
            options={periods.map((p) => ({
              value: p.label,
              label: `${periodTitle(p.label)} (${p.periodStart} ${t('checklists.rangeTo')} ${p.periodEnd})${
                p.filed ? ` ${t('checklists.start.filedSuffix')}` : ''
              }`,
            }))}
            ariaLabel={t(`checklists.start.period.${templateId}`)}
          />
        )}
        <p id={`${id}-consequence`} className="chk-consequence">
          {t(`checklists.start.consequence.${templateId}`)}
        </p>
        {refusal === 'needs_vat_config' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.needsConfig')} <Link className="link-inline" to="/vat">{t('checklists.start.needsConfigCta')}</Link>
          </p>
        )}
        {refusal === 'period_not_filable' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.notFilable', { periods: refusalPeriods.map(periodTitle).join(', ') })}
          </p>
        )}
        {refusal === 'period_not_ended' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.notEnded')}
          </p>
        )}
        {refusal === 'year_already_closed' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.yearClosed')}
          </p>
        )}
        {refusal === 'year_close_in_progress' && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.start.yearInProgress')}{' '}
            {refusalRunId !== null && <Link className="link-inline" to={`/checklisten?run=${encodeURIComponent(refusalRunId)}`}>{t('checklists.start.yearInProgressCta')}</Link>}
          </p>
        )}
        {refusal !== null && !['needs_vat_config', 'period_not_filable', 'period_not_ended', 'year_already_closed', 'year_close_in_progress'].includes(refusal) && (
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
          <a className="link-inline" href={portalUrl} target="_blank" rel="noreferrer noopener">
            {t('checklists.attest.portal')}
          </a>
        </p>
        <label htmlFor={`${id}-date`}>{t('checklists.attest.date')}</label>
        <input className="field" id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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

export interface GvDialogProps {
  open: boolean;
  onClose: () => void;
  today: string;
  /** The ISO day the statements were signed off, or null. */
  signedAt: string | null;
  refusal: string | null;
  working: boolean;
  onAttest: (date: string, reason: string | null) => void;
}

/** The GV attestation (S7): a date, and the reason the engine asks for when the GV predates the sign-off. */
export function GvDialog({ open, onClose, today, signedAt, refusal, working, onAttest }: GvDialogProps) {
  const t = useT();
  const id = useId();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const predates = signedAt !== null && date < signedAt;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLocalError(t('checklists.gv.needsDate'));
      return;
    }
    if (predates && reason.trim().length === 0) {
      setLocalError(t('checklists.gv.needsReason'));
      return;
    }
    setLocalError(null);
    onAttest(date, reason.trim().length === 0 ? null : reason.trim());
  };
  const error = localError ?? (refusal === null ? null : refusal === 'acknowledge_needs_reason' ? t('checklists.gv.needsReason') : refusal === 'already_attested' ? t('checklists.gv.alreadyAttested') : t('checklists.error.refused', { code: refusal }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('checklists.gv.title')}
      closeLabel={t('checklists.dialog.close')}
      describedById={`${id}-consequence`}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('checklists.dialog.cancel')}
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--primary" disabled={working}>
            {working ? t('checklists.gv.working') : t('checklists.gv.action')}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="chk-dialog-form">
        <label htmlFor={`${id}-date`}>{t('checklists.gv.date')}</label>
        <input className="field" id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {(predates || refusal === 'acknowledge_needs_reason') && (
          <>
            <label htmlFor={`${id}-reason`}>{t('checklists.gv.reason')}</label>
            <textarea className="field" id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </>
        )}
        <p id={`${id}-consequence`} className="chk-consequence">
          {t('checklists.gv.consequence')}
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
  /** A pre-filled reason (the Treuhänder handover, the Berichtigung). */
  initialReason?: string;
  /** The warning restated above the reason (the acknowledge dialog, S9). */
  lead?: ReactNode;
  onConfirm: (reason: string) => void;
}

/** The Skip, Abandon and Acknowledge dialogs share one shape: a required reason and a consequence sentence. */
export function ReasonDialog({ open, onClose, title, label, consequence, action, workingLabel, refusal, working, danger = false, initialReason = '', lead, onConfirm }: ReasonDialogProps) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState(initialReason);
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
        {lead !== undefined && <div className="chk-dialog-lead">{lead}</div>}
        <label htmlFor={`${id}-reason`}>{label}</label>
        <textarea className="field" id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-required="true" />
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
  /** When true the sign-off needs a reference (the payment item, the typed bank balance). */
  needsReference: boolean;
  referenceLabel?: string;
  referenceHint?: string;
  refusal: string | null;
  working: boolean;
  onConfirm: (reference: string | null) => void;
}

/** The bridge review, the payment sign-off, the typed bank balance and the statements release: a confirm with an optional reference field. */
export function SignoffDialog({ open, onClose, title, consequence, needsReference, referenceLabel, referenceHint, refusal, working, onConfirm }: SignoffDialogProps) {
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
            <label htmlFor={`${id}-ref`}>{referenceLabel ?? t('checklists.signoff.reference')}</label>
            <input className="field" id={`${id}-ref`} type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={referenceHint ?? t('checklists.signoff.referenceHint')} />
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

export interface ConfirmActDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What will happen, in the surface's words (the count and total of a batch, the period). */
  body: ReactNode;
  /** The consequence sentence: the dial family's through ConsequenceLine, or the seal's own sentence. */
  consequence: ReactNode;
  action: string;
  refusal: string | null;
  working: boolean;
  onConfirm: () => void;
}

/** The confirm in front of every domain verb a posting row calls (S13, D118 C4): an alert dialog, never dismissed by a stray click. */
export function ConfirmActDialog({ open, onClose, title, body, consequence, action, refusal, working, onConfirm }: ConfirmActDialogProps) {
  const t = useT();
  const id = useId();
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
          <button type="button" className="btn btn--primary" disabled={working} onClick={onConfirm}>
            {working ? t('checklists.act.working') : action}
          </button>
        </>
      }
    >
      <div className="chk-dialog-form">
        <div className="chk-dialog-lead">{body}</div>
        <div id={`${id}-consequence`}>{consequence}</div>
        {refusal !== null && (
          <p className="chk-dialog-error" role="alert">
            {t('checklists.error.refused', { code: refusal })}
          </p>
        )}
      </div>
    </Modal>
  );
}
