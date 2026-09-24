/**
 * ContactEditor, the create/edit overlay for a single contact (spec A09 §6, US-A09.1).
 *
 * Create mode collects the party role (required, the customer/vendor axis), name, the SIX
 * structured-address block, MWST number, email, default currency, payment terms and a free note,
 * then calls `create_contact`. Edit mode reuses the same form and sends a `patch` to `update_contact`.
 * An `invalid_vat_number` rejection surfaces inline on the VAT field, naming the expected format,
 * never a stack trace (spec §5: scope-degradation, not a throw). An empty address is allowed (a
 * name-only contact is valid), but the QR-readiness sign stays off until the address is complete.
 *
 * ## BUILT ON THE SHARED DetailDrawer PRIMITIVE (D118 B2, 2026-08-23)
 *
 * The editor kept its A09 presentation as a right-side edge drawer, so it hosts on the shared
 * `DetailDrawer` (the edge panel, its scrim, the focus trap, Escape-to-close and focus-restore). This
 * component owns only the form fields; the title, its `aria-labelledby` wiring and the Cancel/Save
 * action foot come from the primitive. No provenance line: this is a write surface, not a detail view.
 *
 * ## VALIDATION STANDS AT THE FIELD (K-31, D137)
 *
 * "Speichern" on an empty form used to send the write, get the engine's refusal back and show it as
 * a banner over the form ("Eine Eingabe war ungültig"), with no field marked and focus lost to the
 * page. The name, the one required field, is now checked before the call: it gets `aria-invalid`, a
 * `.field-error` line that names what is missing, and the focus. The two engine refusals that belong
 * to a field (the VAT number, the employer) land on that field the same way; the banner is left for
 * a refusal that belongs to no field. The drawer opens on its first field, never on the close X.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { DetailDrawer } from '../../components/DetailDrawer';
import { ErrorBanner } from '../../components/states';
import { AlertGlyph } from '../../components/states/glyphs';
import { focusFirstInvalid } from '../../components/useFocusTrap';
import { Select } from '../../components/Select';
import type { Err } from '../../lib/client';
import {
  CONTACT_KINDS,
  CURRENCIES,
  PARTY_ROLES,
  addressOf,
  idemKey,
  kindOf,
  type Contact,
  type ContactKind,
  type PartyRole,
} from './model';

export interface ContactEditorProps {
  mode: 'create' | 'edit';
  workspaceId: string;
  /** The contact being edited. Ignored in create mode. */
  contact?: Contact;
  /**
   * Every contact currently loaded, so the employer picker can offer the COMPANIES (US-C00.1).
   *
   * The picker offers companies only, because the engine refuses a person as an employer
   * (`employer_must_be_company`). Offering one and letting the write fail would be a dead end the
   * form itself created, which is the failure mode the currency list was already fixed for.
   */
  contacts?: readonly Contact[];
  /**
   * The workspace base currency (`get_company_profile`), which preselects the picker for a NEW
   * contact.
   *
   * Not a display default: this form sends `defaultCurrency` on every write, so whatever is
   * preselected is what lands in the row. A literal 'CHF' here stamped francs on every contact a
   * EUR-based workspace created without touching the picker, and `default_currency` is a SEED: the
   * documents raised against that party inherit it, so the wrong unit is wrong once here and again
   * on every invoice afterwards. `createContact` resolves an unnamed currency to
   * `baseCurrencyOf(ctx)`; this makes the GUI agree with the engine instead of overriding it.
   *
   * An EDITED contact keeps the currency it was saved with: re-denominating an existing party to
   * the workspace default would change what its next invoice is billed in, silently.
   */
  baseCurrency: string;
  onClose: () => void;
  /** Called after a successful write so the list can reload. */
  onSaved: () => void;
}

export function ContactEditor({
  mode,
  workspaceId,
  contact,
  contacts = [],
  baseCurrency,
  onClose,
  onSaved,
}: ContactEditorProps) {
  const t = useT();
  const client = useClient();
  const titleId = useId();

  const initialAddress = contact
    ? addressOf(contact as unknown as Record<string, unknown>)
    : {};

  const [partyRole, setPartyRole] = useState<PartyRole>(contact?.partyRole ?? 'customer');
  // C00's kind axis and the employer link (US-C00.1). A row that predates C00 reads as a company,
  // which is the engine's own default rather than a guess made here.
  const [kind, setKind] = useState<ContactKind>(contact ? kindOf(contact) : 'company');
  const [companyContactId, setCompanyContactId] = useState(contact?.companyContactId ?? '');
  const [name, setName] = useState(contact?.name ?? '');
  const [street, setStreet] = useState(initialAddress.street ?? '');
  const [houseNo, setHouseNo] = useState(initialAddress.houseNo ?? '');
  const [zip, setZip] = useState(initialAddress.zip ?? '');
  const [city, setCity] = useState(initialAddress.city ?? '');
  const [country, setCountry] = useState(initialAddress.country ?? '');
  const [vatNumber, setVatNumber] = useState(contact?.vatNumber ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  // The contact's own currency wins; a contact that has none falls to the currency the BOOKS are
  // kept in, never to a literal. `defaultCurrency` is nullable on the read model, so this covers
  // create mode and an existing row that names no currency with one rule rather than two.
  const [defaultCurrency, setDefaultCurrency] = useState(contact?.defaultCurrency ?? baseCurrency);
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    contact?.paymentTermsDays === undefined || contact?.paymentTermsDays === null
      ? ''
      : String(contact.paymentTermsDays),
  );
  const [description, setDescription] = useState(contact?.description ?? '');

  const [nameError, setNameError] = useState<string | null>(null);
  const [vatError, setVatError] = useState<string | null>(null);
  const [employerError, setEmployerError] = useState<string | null>(null);
  const [formError, setFormError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  // A rejected save moves focus to the first field it marked invalid (K-31). The move waits for the
  // render that sets `aria-invalid`, so it runs after the commit rather than inside the handler.
  const formRef = useRef<HTMLDivElement>(null);
  const [invalidTick, setInvalidTick] = useState(0);
  useEffect(() => {
    if (invalidTick > 0 && formRef.current !== null) focusFirstInvalid(formRef.current);
  }, [invalidTick]);

  /** Assemble the structured-address block, omitting it entirely when every field is blank. */
  function buildAddress() {
    const parts = {
      street: street.trim(),
      houseNo: houseNo.trim(),
      zip: zip.trim(),
      city: city.trim(),
      country: country.trim(),
    };
    const anyFilled = Object.values(parts).some((v) => v !== '');
    return anyFilled ? parts : undefined;
  }

  function commonFields() {
    const terms = paymentTermsDays.trim();
    return {
      kind,
      // A company never carries an employer, so the link is cleared rather than left stale when the
      // kind flips. `null` is the explicit clear the patch path needs; `undefined` would mean "leave".
      companyContactId: kind === 'person' && companyContactId !== '' ? companyContactId : null,
      name: name.trim(),
      address: buildAddress(),
      vatNumber: vatNumber.trim() === '' ? undefined : vatNumber.trim(),
      email: email.trim() === '' ? undefined : email.trim(),
      defaultCurrency,
      paymentTermsDays: terms === '' ? undefined : Number(terms),
      description: description.trim() === '' ? undefined : description.trim(),
    };
  }

  async function handleSave() {
    setVatError(null);
    setEmployerError(null);
    setFormError(null);
    // The one required field is checked here, before the write, so the answer stands at the field.
    if (name.trim() === '') {
      setNameError(t('contact.error.nameRequired'));
      setInvalidTick((n) => n + 1);
      return;
    }
    setNameError(null);
    setSaving(true);

    if (mode === 'create') {
      const resp = await client.call('create_contact', {
        workspaceId,
        partyRole,
        ...commonFields(),
        idempotencyKey: idemKey('contact'),
      });
      if (isErr(resp.body)) {
        finishError(resp.body);
        return;
      }
    } else {
      const contactId = contact?.id;
      if (contactId === undefined) {
        setSaving(false);
        return;
      }
      const resp = await client.call('update_contact', {
        workspaceId,
        contactId,
        patch: { partyRole, ...commonFields() },
      });
      if (isErr(resp.body)) {
        finishError(resp.body);
        return;
      }
    }

    setSaving(false);
    onSaved();
    onClose();
  }

  function finishError(err: Err) {
    setSaving(false);
    if (err.error === 'invalid_vat_number') {
      setVatError(t('contact.invalidVatNumber'));
      setInvalidTick((n) => n + 1);
    } else if (err.error === 'employer_must_be_company') {
      // Inline on the field that caused it, naming the rule, never a bare toast (spec C00 §6).
      setEmployerError(t('contact.error.employerMustBeCompany'));
      setInvalidTick((n) => n + 1);
    } else {
      // A refusal that belongs to no field: the banner, the one place left for it (K-31).
      setFormError(err);
    }
  }

  const footer = (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {t('contact.cancel')}
      </button>
      <button type="button" className="btn btn--primary" disabled={saving} onClick={handleSave}>
        {t('contact.save')}
      </button>
    </>
  );

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={mode === 'create' ? t('contact.new') : t('contact.editTitle')}
      closeLabel={t('contact.close')}
      footer={footer}
    >
      <div className="ct-editor-form" ref={formRef}>
        {formError !== null && <ErrorBanner error={formError} />}

          <div className="ct-field">
            <div className="ct-field-inner">
              <span className="ct-field-label">{t('contact.partyRole')}</span>
              <Select
                value={partyRole}
                onChange={(value) => setPartyRole(value as PartyRole)}
                options={PARTY_ROLES.map((role) => ({ value: role, label: t(`contact.role.${role}`) }))}
                ariaLabel={t('contact.partyRole')}
              />
            </div>
          </div>

          {/* C00's company|person axis (US-C00.1). A separate control from the role above, because
              the two are orthogonal: a person can be a customer, a company can be both. */}
          <div className="ct-field">
            <div className="ct-field-inner">
              <span className="ct-field-label">{t('contact.kindLabel')}</span>
              <Select
                value={kind}
                onChange={(value) => setKind(value as ContactKind)}
                options={CONTACT_KINDS.map((k) => ({ value: k, label: t(`contact.kind.${k}`) }))}
                ariaLabel={t('contact.kindLabel')}
              />
            </div>
          </div>

          <div className="ct-field">
            <label className="ct-field-inner">
              <span className="ct-field-label">{t('contact.name')}</span>
              <input
                className="field"
                value={name}
                required
                aria-invalid={nameError !== null}
                aria-describedby={nameError !== null ? `${titleId}-name-err` : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError !== null && event.target.value.trim() !== '') setNameError(null);
                }}
              />
            </label>
            {nameError !== null && (
              <p id={`${titleId}-name-err`} className="field-error" role="alert">
                <AlertGlyph size={16} aria-hidden="true" />
                {nameError}
              </p>
            )}
          </div>

          {/* The employer link, offered only for a PERSON, and only ever listing companies: the
              engine refuses a person as an employer, so offering one would be a dead end the form
              created. A person with no employer is perfectly valid, hence the empty option. */}
          {kind === 'person' && (
            <div className="ct-field">
              <div className="ct-field-inner">
                <span className="ct-field-label">{t('contact.field.employer')}</span>
                <Select
                  value={companyContactId}
                  onChange={(value) => setCompanyContactId(value)}
                  options={[
                    { value: '', label: t('contact.field.employerNone') },
                    ...contacts
                      .filter((c) => kindOf(c) === 'company' && c.id !== contact?.id)
                      .map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  invalid={employerError !== null}
                  describedBy={employerError !== null ? `${titleId}-employer-err` : undefined}
                  ariaLabel={t('contact.field.employer')}
                />
              </div>
              {employerError !== null && (
                <p id={`${titleId}-employer-err`} className="field-error" role="alert">
                  <AlertGlyph size={16} aria-hidden="true" />
                  {employerError}
                </p>
              )}
            </div>
          )}

          <fieldset className="ct-fieldset">
            <legend className="ct-field-label">{t('contact.addressGroup')}</legend>
            <div className="ct-address-grid">
              <label className="ct-field-inner ct-street">
                <span className="ct-field-label">{t('contact.address')}</span>
                <input
                  className="field"
                  value={street}
                  onChange={(event) => setStreet(event.target.value)}
                />
              </label>
              <label className="ct-field-inner">
                <span className="ct-field-label">{t('contact.houseNo')}</span>
                <input
                  className="field"
                  value={houseNo}
                  onChange={(event) => setHouseNo(event.target.value)}
                />
              </label>
              <label className="ct-field-inner">
                <span className="ct-field-label">{t('contact.zip')}</span>
                <input
                  className="field"
                  inputMode="numeric"
                  value={zip}
                  onChange={(event) => setZip(event.target.value)}
                />
              </label>
              <label className="ct-field-inner ct-address-city">
                <span className="ct-field-label">{t('contact.city')}</span>
                <input
                  className="field"
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                />
              </label>
              <label className="ct-field-inner">
                <span className="ct-field-label">{t('contact.country')}</span>
                <input
                  className="field"
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                />
              </label>
            </div>
          </fieldset>

          <div className="ct-field">
            <label className="ct-field-inner">
              <span className="ct-field-label">{t('contact.vatNumber')}</span>
              <input
                className="field t-num"
                value={vatNumber}
                aria-invalid={vatError !== null}
                aria-describedby={
                  vatError !== null ? `${titleId}-vat-err` : `${titleId}-vat-hint`
                }
                onChange={(event) => setVatNumber(event.target.value)}
              />
            </label>
            {vatError !== null ? (
              <p id={`${titleId}-vat-err`} className="field-error" role="alert">
                <AlertGlyph size={16} aria-hidden="true" />
                {vatError}
              </p>
            ) : (
              <span id={`${titleId}-vat-hint`} className="ct-field-hint">
                {t('contact.vatNumberHint')}
              </span>
            )}
          </div>

          <div className="ct-field">
            <label className="ct-field-inner">
              <span className="ct-field-label">{t('contact.email')}</span>
              <input
                className="field"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          </div>

          <div className="ct-field-row">
            <div className="ct-field">
              <div className="ct-field-inner">
                <span className="ct-field-label">{t('contact.defaultCurrency')}</span>
                <Select
                  value={defaultCurrency}
                  onChange={(value) => setDefaultCurrency(value)}
                  options={CURRENCIES.map((code) => ({ value: code, label: code }))}
                  ariaLabel={t('contact.defaultCurrency')}
                />
              </div>
            </div>
            <div className="ct-field">
              <label className="ct-field-inner">
                <span className="ct-field-label">
                  {t('contact.paymentTerms')} ({t('contact.paymentTermsUnit')})
                </span>
                <input
                  className="field t-num"
                  inputMode="numeric"
                  min={0}
                  value={paymentTermsDays}
                  onChange={(event) => setPaymentTermsDays(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="ct-field">
            <label className="ct-field-inner">
              <span className="ct-field-label">{t('contact.description')}</span>
              <textarea
                className="field ct-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
      </div>
    </DetailDrawer>
  );
}
