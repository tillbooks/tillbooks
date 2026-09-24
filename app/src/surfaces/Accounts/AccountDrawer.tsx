/**
 * AccountDrawer, the create/edit overlay for a single account (spec A01 §6, US-A01.2/.3).
 *
 * Create mode collects number, name, type, an optional default VAT code, and the cost-centre flag,
 * then calls `create_account`. Edit mode reuses the same form but FREEZES number and type (a typed,
 * posted account is structurally fixed, spec §3): only name, default VAT, and the cost-centre flag
 * can change, via `update_account` plus the A05 `account_set_tax_default` control for the VAT default.
 * A `duplicate_number` rejection surfaces inline on the number field, never as a stack trace.
 */
import { useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { useCan, CAP } from '../../lib/capabilities';
import type { Err } from '../../lib/client';
import {
  ACCOUNT_TYPES,
  GROUP_EXPECTED_TYPE,
  groupOf,
  idemKey,
  type Account,
  type AccountType,
  type VatCode,
} from './model';

export interface AccountDrawerProps {
  mode: 'create' | 'edit';
  workspaceId: string;
  vatCodes: VatCode[];
  /** The account being edited. Ignored in create mode. */
  account?: Account;
  onClose: () => void;
  /** Called after a successful write so the list can reload. */
  onSaved: () => void;
}

export function AccountDrawer({
  mode,
  workspaceId,
  vatCodes,
  account,
  onClose,
  onSaved,
}: AccountDrawerProps) {
  const t = useT();
  const client = useClient();
  // Prefixes the field-level error id (the drawer's own title id is owned by DetailDrawer).
  const fieldPrefix = useId();
  /**
   * The VAT default is the ONE control in this drawer that is not `manage_chart`: in EDIT mode it
   * rides the dedicated A05 verb `account_set_tax_default`, which the engine gates on
   * `manage_vat_config`. So the field renders in edit mode only when that capability is held, and
   * the save path skips the A05 call without it, or a chart-only role's whole save would be refused
   * over a field it never touched. In CREATE mode the default rides `create_account` itself
   * (`manage_chart`), so the field always renders there.
   */
  const canSetVatDefault = useCan(CAP.manageVatConfig);

  const [number, setNumber] = useState(account?.number ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'expense');
  const [vatDefault, setVatDefault] = useState(account?.vatCodeDefault ?? '');
  const [costCenterAllowed, setCostCenterAllowed] = useState(account?.costCenterAllowed ?? false);

  const [numberError, setNumberError] = useState<string | null>(null);
  const [formError, setFormError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const frozen = mode === 'edit';
  const typeMismatch =
    number.trim() !== '' && GROUP_EXPECTED_TYPE[groupOf(number)] !== type;

  async function handleSave() {
    setSaving(true);
    setNumberError(null);
    setFormError(null);

    if (mode === 'create') {
      const resp = await client.call('create_account', {
        workspaceId,
        number: number.trim(),
        name: name.trim(),
        type,
        vatCodeDefault: vatDefault === '' ? undefined : vatDefault,
        costCenterAllowed,
        idempotencyKey: idemKey('acc'),
      });
      if (isErr(resp.body)) {
        finishError(resp.body);
        return;
      }
    } else {
      const accountId = account?.id;
      if (accountId === undefined) {
        setSaving(false);
        return;
      }
      const updateResp = await client.call('update_account', {
        workspaceId,
        accountId,
        name: name.trim(),
        costCenterAllowed,
      });
      if (isErr(updateResp.body)) {
        finishError(updateResp.body);
        return;
      }
      // The default VAT rides the dedicated A05 control (omit taxCode to clear it). Skipped without
      // `manage_vat_config`: the field is hidden then, so there is nothing to save, and making the
      // call anyway would fail the whole edit over a control the actor never saw.
      if (canSetVatDefault) {
        const taxResp = await client.call('account_set_tax_default', {
          workspaceId,
          accountId,
          taxCode: vatDefault === '' ? undefined : vatDefault,
        });
        if (isErr(taxResp.body)) {
          finishError(taxResp.body);
          return;
        }
      }
    }

    setSaving(false);
    onSaved();
    onClose();
  }

  function finishError(err: Err) {
    setSaving(false);
    if (err.error === 'duplicate_number') {
      setNumberError(t('account.err.duplicateNumber'));
    } else {
      setFormError(err);
    }
  }

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={mode === 'create' ? t('account.new') : t('account.editTitle')}
      closeLabel={t('account.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('account.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={saving} onClick={handleSave}>
            {t('account.save')}
          </button>
        </>
      }
    >
      <div className="acc-form">
        {formError !== null && <ErrorBanner error={formError} />}

        <div className="acc-field">
          <label className="acc-field-inner">
            <span className="acc-field-label">{t('account.number')}</span>
            <input
              className="field acc-input t-num"
              value={number}
              disabled={frozen}
              inputMode="numeric"
              aria-invalid={numberError !== null}
              aria-describedby={numberError !== null ? `${fieldPrefix}-num-err` : undefined}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
          {numberError !== null && (
            <span id={`${fieldPrefix}-num-err`} className="acc-field-error" role="alert">
              {numberError}
            </span>
          )}
        </div>

        <div className="acc-field">
          <label className="acc-field-inner">
            <span className="acc-field-label">{t('account.name')}</span>
            <input
              className="field acc-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <div className="acc-field">
          <div className="acc-field-inner">
            <span className="acc-field-label">{t('account.typeLabel')}</span>
            <Select
              value={type}
              disabled={frozen}
              onChange={(value) => setType(value as AccountType)}
              options={ACCOUNT_TYPES.map((value) => ({ value, label: t(`account.type.${value}`) }))}
              ariaLabel={t('account.typeLabel')}
            />
          </div>
          {typeMismatch && !frozen && (
            <span className="acc-field-warn">{t('account.warn.typeMismatch')}</span>
          )}
        </div>

        {(mode === 'create' || canSetVatDefault) && (
          <div className="acc-field">
            <div className="acc-field-inner">
              <span className="acc-field-label">{t('account.vatDefault')}</span>
              <Select
                value={vatDefault ?? ''}
                onChange={(value) => setVatDefault(value)}
                options={[
                  { value: '', label: t('account.vatNone') },
                  ...vatCodes.map((code) => ({ value: code.code, label: code.label })),
                ]}
                ariaLabel={t('account.vatDefault')}
              />
            </div>
          </div>
        )}

        <label className="acc-checkbox">
          <input
            type="checkbox"
            checked={costCenterAllowed}
            onChange={(event) => setCostCenterAllowed(event.target.checked)}
          />
          <span>{t('account.costCenterAllowed')}</span>
        </label>
      </div>
    </DetailDrawer>
  );
}
