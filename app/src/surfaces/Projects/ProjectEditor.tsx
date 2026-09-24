/**
 * The create/edit dialog for one project (B00 §6): name, client contact, editable code (auto when
 * blank), currency + budget in that currency, budget hours, dates, and the parent picker for a
 * sub-project. Engine rejections land inline under the field they name (`code_taken`,
 * `invalid_dates`, `needs_fx_rate`), never a raw code.
 *
 * The money input takes a decimal string and converts to integer Rappen in `parseAmountToMinor`
 * (P2); no float ever reaches the wire. The currency options are the three the setup enum admits
 * for a workspace base currency; the engine itself accepts any ISO code, so this narrower offer can
 * only under-offer, never produce a rejection.
 *
 * ## BUILT ON THE SHARED Modal PRIMITIVE (D118 B2, 2026-08-23)
 *
 * The centred overlay, its scrim, the focus trap (Tab cannot walk out to the list behind the scrim),
 * Escape-to-close and focus-restore are all the shared `Modal`'s now. This component owns only the
 * form; the dialog title, its `aria-labelledby` wiring and the action foot come from the primitive.
 * The Save control lives in the Modal foot yet stays a real submit for the form in the body (wired by
 * the `form` attribute), so Enter in a field still submits.
 */
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatMoney } from '../../i18n';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import type { Err } from '../../lib/client';
import { idemKey, parseAmountToMinor } from './model';
import type { ContactOption, Project } from './model';

const CURRENCY_OPTIONS = ['CHF', 'EUR', 'USD'] as const;

export interface ProjectEditorProps {
  workspaceId: string;
  mode: 'create' | 'edit';
  project?: Project | undefined;
  contacts: readonly ContactOption[];
  /** Every project that may serve as a parent (the surface excludes the project itself). */
  parentOptions: readonly Project[];
  baseCurrency: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ProjectEditor({
  workspaceId,
  mode,
  project,
  contacts,
  parentOptions,
  baseCurrency,
  onClose,
  onSaved,
}: ProjectEditorProps) {
  const t = useT();
  const client = useClient();
  // A stable id so the Save button in the Modal foot can target this form across the body boundary.
  const formId = useId();

  const [name, setName] = useState(project?.name ?? '');
  const [contactId, setContactId] = useState(project?.contactId ?? contacts[0]?.id ?? '');
  const [code, setCode] = useState(project?.code ?? '');
  const [currency, setCurrency] = useState(project?.currency ?? baseCurrency);
  const [budget, setBudget] = useState(project !== undefined ? (project.budgetMinor / 100).toFixed(2) : '');
  const [budgetHours, setBudgetHours] = useState(project !== undefined ? String(project.budgetHours) : '');
  const [startsOn, setStartsOn] = useState(project?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(project?.endsOn ?? '');
  const [parentId, setParentId] = useState(project?.parentId ?? '');
  const [fxRate, setFxRate] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const nonBase = currency !== baseCurrency;

  const budgetPreview = useMemo(() => {
    const minor = parseAmountToMinor(budget);
    return minor === null ? null : formatMoney(minor, currency);
  }, [budget, currency]);

  async function save() {
    setFieldError(null);
    setError(null);

    const budgetMinor = budget.trim() === '' ? 0 : parseAmountToMinor(budget);
    if (budgetMinor === null) return setFieldError(t('project.editor.invalidBudget'));
    const hours = budgetHours.trim() === '' ? 0 : Number(budgetHours);
    if (!Number.isInteger(hours) || hours < 0) return setFieldError(t('project.editor.invalidHours'));

    setSaving(true);
    const shared = {
      ...(code.trim() !== '' ? { code: code.trim() } : {}),
      ...(startsOn !== '' ? { startsOn } : { startsOn: null }),
      ...(endsOn !== '' ? { endsOn } : { endsOn: null }),
      budgetMinor,
      budgetHours: hours,
      currency,
      ...(nonBase && fxRate.trim() !== '' ? { fxRate: fxRate.trim() } : {}),
    };
    const resp =
      mode === 'create'
        ? await client.call('project_create', {
            workspaceId,
            name: name.trim(),
            contactId,
            ...(parentId !== '' ? { parentId } : {}),
            // A create takes the dates as plain optionals, never null.
            ...Object.fromEntries(Object.entries(shared).filter(([, v]) => v !== null)),
            idempotencyKey: idemKey('proj'),
          })
        : await client.call('project_update', {
            workspaceId,
            projectId: (project as Project).id,
            patch: {
              name: name.trim(),
              contactId,
              parentId: parentId === '' ? null : parentId,
              ...shared,
            },
            idempotencyKey: idemKey('proj-edit'),
          });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    onSaved();
    onClose();
  }

  const footer = (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {t('project.editor.cancel')}
      </button>
      <button type="submit" form={formId} className="btn btn--primary" disabled={saving || contacts.length === 0}>
        {t('project.editor.save')}
      </button>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t(mode === 'create' ? 'project.editor.createTitle' : 'project.editor.editTitle')}
      closeLabel={t('project.editor.cancel')}
      footer={footer}
    >
      <form
        id={formId}
        className="projects-editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="projects-field">
          <span>{t('project.editor.name')}</span>
          <input className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>

        <div className="projects-field">
          <span>{t('project.editor.contact')}</span>
          {contacts.length === 0 ? (
            // No dead end (DESIGN.md Interaction, spec B00 §6): the empty picker deep-links to
            // C00 to create the first contact instead of stranding the operator on a disabled form.
            <span className="projects-hint">
              {t('project.editor.contactEmptyHint')}{' '}
              <Link className="projects-inline-link link-inline" to="/contacts">
                {t('project.editor.contactCreate')}
              </Link>
            </span>
          ) : (
            <Select
              value={contactId}
              onChange={(val) => setContactId(val)}
              options={contacts.map((c) => ({ value: c.id, label: c.name }))}
              ariaLabel={t('project.editor.contact')}
            />
          )}
        </div>

        <label className="projects-field">
          <span>{t('project.editor.code')}</span>
          <input
            className="field"
            type="text"
            value={code}
            placeholder={mode === 'create' ? t('project.editor.codePlaceholder') : undefined}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>

        <div className="projects-field-row">
          <div className="projects-field">
            <span>{t('project.editor.currency')}</span>
            <Select
              value={currency}
              onChange={(val) => setCurrency(val)}
              options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: c }))}
              ariaLabel={t('project.editor.currency')}
            />
          </div>
          <label className="projects-field">
            <span>{t('project.editor.budget', { currency })}</span>
            <input
              className="field"
              type="text"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              aria-describedby="project-budget-preview"
            />
            <span id="project-budget-preview" className="projects-hint t-money">
              {budgetPreview ?? ''}
            </span>
          </label>
          <label className="projects-field">
            <span>{t('project.editor.budgetHours')}</span>
            <input className="field" type="text" inputMode="numeric" value={budgetHours} onChange={(e) => setBudgetHours(e.target.value)} />
          </label>
        </div>

        {nonBase && (
          <label className="projects-field">
            <span>{t('project.editor.fxRate', { base: baseCurrency })}</span>
            <input className="field" type="text" inputMode="decimal" value={fxRate} onChange={(e) => setFxRate(e.target.value)} />
            <span className="projects-hint">{t('project.editor.fxRateHint')}</span>
          </label>
        )}

        <div className="projects-field-row">
          <label className="projects-field">
            <span>{t('project.editor.startsOn')}</span>
            <input className="field" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </label>
          <label className="projects-field">
            <span>{t('project.editor.endsOn')}</span>
            <input className="field" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </label>
        </div>

        <div className="projects-field">
          <span>{t('project.editor.parent')}</span>
          <Select
            value={parentId}
            onChange={(val) => setParentId(val)}
            options={[
              { value: '', label: t('project.editor.parentNone') },
              ...parentOptions.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
            ]}
            ariaLabel={t('project.editor.parent')}
          />
        </div>

        {fieldError !== null && (
          <p className="field-error" role="alert">
            {fieldError}
          </p>
        )}
        {error !== null && (
          <p className="field-error" role="alert">
            {t(`errors.${error.error}`)}
          </p>
        )}
      </form>
    </Modal>
  );
}
