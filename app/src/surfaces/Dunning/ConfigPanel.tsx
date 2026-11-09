/**
 * A15's policy editor: the three Mahnstufen in one form, saved in one write.
 *
 * The three levels save TOGETHER because the engine validates them against each other (thresholds
 * strictly increasing), so a per-level save could strand a policy no propose can satisfy. The fee
 * inputs speak CHF with decimals and the write speaks Rappen; the conversion happens exactly once,
 * on submit, and display never feeds back into arithmetic.
 *
 * The statutory guidance is ON the form, not in a manual: the Mahngebühr is chargeable only when
 * contractually agreed (no statutory basis), the Verzugszins floor is Art. 104 OR's 5%, and a
 * booked fee's tax code should be the underlying supply's (ESTV practice). Each is one sentence of
 * help text beside the fields it governs.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCan, CAP } from '../../lib/capabilities';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useT } from '../../i18n';
import { Field } from '../../components/Field';
import { IconButton } from '../../components/IconButton';
import { Select } from '../../components/Select';
import type { DunningConfigView, DunningLevelConfig } from './model';

export interface FeeAccountOption {
  id: string;
  number: string;
  name: string;
}

interface LevelDraft {
  daysOverdue: string;
  minIntervalDays: string;
  fee: string;
  feeIncomeAccountId: string;
  showInterest: boolean;
  interestPercent: string;
}

function toDraft(level: DunningLevelConfig): LevelDraft {
  return {
    daysOverdue: String(level.daysOverdue),
    minIntervalDays: String(level.minIntervalDays),
    fee: (level.feeMinor / 100).toFixed(2),
    feeIncomeAccountId: level.feeIncomeAccountId ?? '',
    showInterest: level.showInterest,
    interestPercent: (level.interestBp / 100).toFixed(1),
  };
}

/** CHF decimal text to integer Rappen, or null when it is not a number. Never a float downstream. */
function toMinor(chf: string): number | null {
  const normalised = chf.trim().replace(/'/g, '').replace(',', '.');
  if (normalised.length === 0) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  const [whole, cents = ''] = normalised.split('.');
  return Number(whole) * 100 + Number(cents.padEnd(2, '0') || '0');
}

/** Percent text to basis points: `5.0` -> 500. */
function toBp(percent: string): number | null {
  const normalised = percent.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  return Math.round(Number(normalised) * 100);
}

export function ConfigPanel({
  workspaceId,
  config,
  feeAccounts,
  onSaved,
}: {
  workspaceId: string;
  config: DunningConfigView;
  feeAccounts: FeeAccountOption[];
  onSaved: () => void;
}) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.manageSettings);
  const [drafts, setDrafts] = useState<LevelDraft[]>(config.levels.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A config re-read after a save elsewhere replaces the drafts wholesale: current, not historical.
  useEffect(() => {
    setDrafts(config.levels.map(toDraft));
  }, [config]);

  /**
   * The write body the drafts currently describe. Invalid text carries -1 for the engine to name.
   * `bookFee` is DERIVED, not a control: a positive fee always books (C6, the letter demands
   * exactly what books), so the form offers no way to state the contradiction the engine refuses.
   */
  const levels = drafts.map((draft, i) => ({
    level: (i + 1) as 1 | 2 | 3,
    daysOverdue: Number(draft.daysOverdue),
    minIntervalDays: Number(draft.minIntervalDays),
    feeMinor: toMinor(draft.fee) ?? -1,
    bookFee: (toMinor(draft.fee) ?? 0) > 0,
    ...(draft.feeIncomeAccountId === '' ? {} : { feeIncomeAccountId: draft.feeIncomeAccountId }),
    showInterest: draft.showInterest,
    interestBp: toBp(draft.interestPercent) ?? -1,
  }));
  // One key per QUESTION (the shared idempotency law): the key moves when, and only when, the
  // policy the save would write is a different policy.
  const idempotencyKey = useIdempotencyKey([workspaceId, levels]);

  const setDraft = (index: number, patch: Partial<LevelDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const response = await client.call('set_dunning_config', { workspaceId, levels, idempotencyKey });
    setSaving(false);
    if (isErr(response.body)) {
      const code = response.body.error;
      setError(
        code === 'interest_below_statutory_floor'
          ? t('dunning.config.error.interestFloor')
          : code === 'needs_fee_income_account'
            ? t('dunning.config.error.needsAccount')
            : t('dunning.config.error.invalid'),
      );
      return;
    }
    setSaved(true);
    onSaved();
  };

  return (
    <div className="dunning-config" data-testid="dunning-config">
      <div className="dunning-config-grid" role="group" aria-label={t('dunning.config.title')}>
        {drafts.map((draft, i) => (
          <fieldset key={i} className="dunning-config-level form-stack">
            <legend>
              {t(`dunning.level${i + 1}`)}
              {i === 0 && <IconButton icon="info" small context={t('dunning.config.hint')} />}
            </legend>
            <Field label={t('dunning.daysOverdue')}>
              <input
                className="field"
                type="number"
                min={1}
                value={draft.daysOverdue}
                onChange={(e) => setDraft(i, { daysOverdue: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            {/* K-60: the minimum spacing since the PREVIOUS letter. Level 1 has no previous level,
                so it is gated by its days-overdue threshold alone and shows no spacing control. */}
            {i > 0 && (
              <Field label={t('dunning.minInterval')} info={t('dunning.config.intervalHint')}>
                <input
                  className="field"
                  type="number"
                  min={0}
                  value={draft.minIntervalDays}
                  onChange={(e) => setDraft(i, { minIntervalDays: e.target.value })}
                  disabled={!canManage}
                />
              </Field>
            )}
            <Field label={t('dunning.fee')} hint={t('dunning.config.feeHint')}>
              <input
                className="field"
                type="text"
                inputMode="decimal"
                value={draft.fee}
                onChange={(e) => setDraft(i, { fee: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            {/* A positive fee BOOKS, so it needs its income account; the VAT needs nothing here,
                it follows the chased invoice automatically (D69). */}
            {(toMinor(draft.fee) ?? 0) > 0 && (
              <Field label={t('dunning.feeAccount')}>
                <Select
                  value={draft.feeIncomeAccountId}
                  onChange={(value) => setDraft(i, { feeIncomeAccountId: value })}
                  options={[
                    { value: '', label: t('dunning.config.pickAccount') },
                    ...feeAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
                  ]}
                  disabled={!canManage}
                  ariaLabel={t('dunning.feeAccount')}
                />
              </Field>
            )}
            <label className="dunning-config-check">
              <input
                type="checkbox"
                checked={draft.showInterest}
                onChange={(e) => setDraft(i, { showInterest: e.target.checked })}
                disabled={!canManage}
              />
              <span>{t('dunning.interestNote')}</span>
            </label>
            {draft.showInterest && (
              <Field label={t('dunning.interestRate')} hint={t('dunning.config.interestHint')}>
                <input
                  className="field"
                  type="text"
                  inputMode="decimal"
                  value={draft.interestPercent}
                  onChange={(e) => setDraft(i, { interestPercent: e.target.value })}
                  disabled={!canManage}
                />
              </Field>
            )}
          </fieldset>
        ))}
      </div>
      {error !== null && (
        <p className="dunning-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">{t('dunning.config.saved')}</p>}
      <button
        type="button"
        className="btn btn--secondary"
        disabled={!canManage || saving}
        onClick={() => void save()}
      >
        {canManage ? t('dunning.config.save') : t('dunning.config.saveDenied')}
      </button>
    </div>
  );
}
