/**
 * Setup / CompanyProfile surface (spec A00 §6).
 *
 * Two faces in one surface, matching the A00 GUI coverage:
 *  - no workspace yet: a single centred "Set up workspace" call to action that reveals a minimal
 *    create form (`create_workspace`), then selects the new workspace. The full step-by-step wizard
 *    from the spec reaches the same end state as this create-then-edit path (US-A00.5 rationale), so
 *    this surface implements the create affordance plus the persistent settings panel rather than a
 *    separate four-step overlay.
 *  - a workspace exists: ONE first-hour profile panel (F-09, 2026-09-06), driven by
 *    `get_company_profile` for the read and, behind one save, `update_company_profile` (name, legal
 *    form, UID, MWST-Nr), `set_fiscal_config` (currency, fiscal year, only when changed),
 *    `vat_configure` + `vat_seed_defaults` (the MWST capture, only while no method is stored) and
 *    `set_creditor_profile` (IBAN, and the address once it is given). Before F-09 the same facts were
 *    three panels with three saves and the IBAN refused to save without the address; J1.1 measured
 *    26 clicks and 112 keystrokes on that face against an ideal of 9 and 60.
 *
 * All five states render: loading (Skeleton), empty (no workspace), error (a real engine `Err` with a
 * retry), success (the profile form), and permission-denied (the padlock panel, A24 RBAC is a
 * permissive stub today but the branch is built and tested).
 *
 * A stored VAT method shows as read-only badges; changing it is the VAT settings surface's
 * period-aligned change (nav `vat`), so this surface configures VAT only ONCE, while none is stored.
 * Every visible string comes from an i18n key; no money figure appears on this form.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type RestResponse } from '../../lib/client';
import { useWorkspace, useWorkspaceId } from '../../app/workspace';
import { useT, useI18n, type I18n } from '../../i18n';
import { Skeleton, EmptyState, ErrorBanner, PermissionDenied } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import { AlertGlyph, LockGlyph } from '../../components/states/glyphs';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { CheckCircleGlyph, HelpGlyph } from './glyphs';
import { WorkspacesPanel } from './Workspaces';
import CREDITOR_ERRORS from './creditor-error-contract.json';
import './Setup.css';

/** The structured creditor address (SIX QR-bill: all parts required before a QR-bill can render). */
interface Address {
  street?: string;
  buildingNo?: string;
  zip?: string;
  town?: string;
  country?: string;
}

/** A custom field attached to `entity_kind='workspace'` (spec §6b). Read-only here. */
interface CustomField {
  key: string;
  label: string;
  value: string;
}

/** The company profile as returned by `get_company_profile` (camelCase, per the Module 1 decision). */
interface Profile {
  name?: string;
  legalForm?: string;
  baseCurrency?: string;
  fiscalYearStart?: string;
  vatMethod?: string;
  vatAccounting?: string;
  uid?: string;
  mwstNo?: string;
  creditorName?: string;
  /** Named exactly as the engine names it. It was `address` here, which silently never bound. */
  creditorAddress?: Address;
  /** The creditor IBAN, of EITHER kind. Reads `workspace.creditor_iban`, renamed from `qr_iban`. */
  creditorIban?: string;
  /**
   * NOT engine-backed yet: `getCompanyProfile` does not return this, so it is always empty. The
   * capability that defines custom fields is the G-cluster (Wave 10). The panel's copy says the
   * feature does not exist rather than "none are defined", which would invite a hunt for a button
   * that is not there. Do not read an empty panel as "the workspace has none".
   * This is the same shape as the `ledgerLocked` defect fixed on 2026-07-20: a field the Studio
   * declared and the engine never sent. Kept deliberately, with the honesty in the copy.
   */
  customFields?: CustomField[];
  /** True once a posted entry exists: the engine then locks currency + fiscal-year (§H-FX). */
  ledgerLocked?: boolean;
}

/** The three legal forms the §H-ENUM fixes for A00. A relabel or extra value would misclassify duty. */
const LEGAL_FORMS = ['einzelfirma', 'gmbh', 'ag'] as const;

/**
 * Days selectable per month for a fiscal-year START (D15/C1).
 *
 * February is capped at **28, not 29**, on purpose. A fiscal year start is a date that recurs every
 * single year, and 29 February does not exist in three years out of four, so offering it would let
 * an operator pick a start date that mostly is not a real day. This is not the same question as
 * "how many days does February have", which is why it is not derived from a calendar.
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Split a stored `MM-DD` into its parts, falling back to 01-01 on anything malformed. */
function splitMonthDay(value: string): { month: number; day: number } {
  const m = /^(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return { month: 1, day: 1 };
  const month = Math.min(12, Math.max(1, Number(m[1])));
  const day = Math.min(DAYS_IN_MONTH[month - 1], Math.max(1, Number(m[2])));
  return { month, day };
}

/** Month names for the active locale, so twelve of them never become twelve i18n keys per locale. */
function monthNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
  // 2001 is an arbitrary non-leap year: only the month index matters here.
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2001, i, 1))));
}

/**
 * Map an engine rejection code to its field-level i18n key; unknown codes fall back generically.
 *
 * The `set_creditor_profile` half is NOT written out here: it comes from
 * `creditor-error-contract.json`, which the root suite pins to the live engine
 * (`test/setup/creditor-error-contract.test.mjs`). This file used to map `not_a_qr_iban`, a code the
 * engine stopped emitting when M-2 made a plain IBAN acceptable, so an operator typing a perfectly
 * ordinary IBAN got the generic fallback instead of the real reason. The app suite mocked the same
 * dead code, so the client's own assumption was all that was ever asserted. Add a code to the shared
 * contract file, never inline here, or that hole re-opens.
 */
const FIELD_ERR_KEY: Record<string, string> = {
  ...CREDITOR_ERRORS.codes,
  // `set_fiscal_config`'s §H-FX rejection. Not a creditor code, so not in the creditor contract.
  needs_empty_ledger: 'company.err.needsEmptyLedger',
};

function fieldErrMessage(t: I18n['t'], err: Err): string {
  const key = FIELD_ERR_KEY[err.error];
  return key !== undefined ? t(key) : t('errors.fallback');
}

/** A workspace id that arrives blank must never be threaded into a ctx verb; treat it as none. */
function isDenied(err: Err): boolean {
  return err.error === 'permission_denied' || err.error === 'forbidden';
}

// ---------------------------------------------------------------------------------------------
// Empty state: no workspace yet.
// ---------------------------------------------------------------------------------------------

/**
 * The ONE create-workspace form (`create_workspace`), shared by both faces of the surface: the
 * no-workspace call to action discloses it, and the "Arbeitsbereiche" panel's "Neuer
 * Arbeitsbereich" (D24, variant B) discloses the same form on the loaded face. There is exactly
 * one create affordance; everything else only points at it.
 */
function CreateWorkspaceForm({
  onCancel,
  framed = true,
  submitVariant = 'primary',
  seat = 'create_workspace',
}: {
  onCancel: () => void;
  framed?: boolean;
  /**
   * `primary` on the no-workspace face, where creating IS the surface's one action. The loaded
   * face passes `accent`: its solid primary is already spent on the company save, and `.btn--accent`
   * exists exactly for an action that is primary elsewhere, so the accent budget stays honest.
   */
  submitVariant?: 'primary' | 'accent';
  /**
   * F-09 (J1.5 ideal step 1), per A23 US-A23.2: a NEW MANDATE beside existing books is minted
   * through `onboard_client` (the Treuhänder-facing composite: the workspace, its chart, and the
   * caller seated as accepted owner in one idempotent unit), so the roster's permission matrix is
   * authoritative from birth. The very first books on a fresh install stay `create_workspace`
   * (A00's own door; the solo case where A24 grants everything until a second mandate exists).
   */
  seat?: 'create_workspace' | 'onboard_client';
}) {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();
  const { setWorkspaceId } = useWorkspace();
  const nameId = useId();
  const legalId = useId();
  const [name, setName] = useState('');
  // The legal form is the ONE decision the ideal path asks (J1.5 D 1). Defaulted from the name's
  // own suffix as it is typed, until the person picks one by hand.
  const [legalFormPick, setLegalFormPick] = useState<string | null>(null);
  const legalForm = legalFormPick ?? legalFormFromName(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [idem] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const resp = await client.call(seat, {
      name,
      legalForm,
      baseCurrency: 'CHF',
      fiscalYearStart: '01-01',
      idempotencyKey: idem,
    });
    setBusy(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    const id = String(resp.body.workspaceId);
    setWorkspaceId(id);
    // The new books open on their home (J1.5: "the switcher lists the new mandate immediately"), and
    // the `?new=1` query that opened this form does not survive into them.
    navigate('/overview', { replace: true });
  }

  const invalidName = error?.error === 'invalid_name';
  return (
    <form className={framed ? 'panel setup-panel form-stack' : 'form-stack'} onSubmit={submit} noValidate>
      <div className="form-row">
        <label htmlFor={nameId}>{t('setup.name')}</label>
        <input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={invalidName || undefined}
          aria-describedby={invalidName ? `${nameId}-err` : undefined}
          autoFocus
        />
        {invalidName && (
          <p id={`${nameId}-err`} className="field-error" role="alert">
            <AlertGlyph className="status-glyph status-glyph-error" size={16} />
            {t('company.err.invalidName')}
          </p>
        )}
      </div>
      <div className="form-row">
        <label htmlFor={legalId}>{t('company.legalForm.label')}</label>
        <select id={legalId} value={legalForm} onChange={(e) => setLegalFormPick(e.target.value)}>
          {LEGAL_FORMS.map((form) => (
            <option key={form} value={form}>
              {t(`company.legalForm.${form}`)}
            </option>
          ))}
        </select>
        <p className="field-hint">{t('setup.legalFormHint')}</p>
      </div>
      {error !== null && !invalidName && <ErrorBanner error={error} />}
      <div className="form-actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
          {t('setup.cancel')}
        </button>
        <button type="submit" className={`btn btn--${submitVariant}`} disabled={busy}>
          {t('setup.createWorkspace')}
        </button>
      </div>
    </form>
  );
}

function CreateWorkspace() {
  const t = useT();
  const titleId = useId();
  const [open, setOpen] = useState(false);

  return (
    <section className="setup-surface" aria-labelledby={titleId}>
      <SurfaceHeader title={t('setup.title')} titleId={titleId} help={<SurfaceHelp surface="Setup" />} />
      {open ? (
        <CreateWorkspaceForm onCancel={() => setOpen(false)} />
      ) : (
        <EmptyState
          title={t('setup.title')}
          hint={t('setup.emptyHint')}
          action={{ label: t('setup.createWorkspace'), onClick: () => setOpen(true) }}
        />
      )}
      {/* D24 variant B: with no workspace selected, the list is HOW an existing set of books gets
          re-opened, so it appears exactly when the engine knows any and stays out of a fresh
          install's way. Its footer discloses the same form as the call to action above. */}
      <WorkspacesPanel activeId={null} onlyWhenPopulated onNewWorkspace={() => setOpen(true)} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Loaded profile: the persistent settings panel.
// ---------------------------------------------------------------------------------------------

/** Inline saved / saving / error status for one save group. Glyph plus text, never colour alone. */
function SaveStatus({ saving, saved, error }: { saving: boolean; saved: boolean; error: Err | null }) {
  const t = useT();
  if (error !== null) {
    return (
      <p className="status-line status-error" role="alert">
        <AlertGlyph className="status-glyph status-glyph-error" size={16} />
        {fieldErrMessage(t, error)}
      </p>
    );
  }
  if (saving) {
    return (
      <p className="status-line" role="status">
        {t('company.saving')}
      </p>
    );
  }
  if (saved) {
    return (
      <p className="status-line status-ok" role="status">
        <CheckCircleGlyph className="status-glyph status-glyph-ok" size={16} />
        {t('company.saved')}
      </p>
    );
  }
  return null;
}

/** Drive one write verb, tracking saving / saved / error for its panel. */
function useSaver(action: string) {
  const client = useClient();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const save = useCallback(
    async (input: Record<string, unknown>): Promise<boolean> => {
      setSaving(true);
      setSaved(false);
      setError(null);
      const resp: RestResponse = await client.call(action, input);
      setSaving(false);
      if (isErr(resp.body)) {
        setError(resp.body);
        return false;
      }
      setSaved(true);
      return true;
    },
    [client, action],
  );

  return { save, saving, saved, error };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="panel setup-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-panel-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The first-hour panel (F-09, J1.1 ideal step 3): legal form, MWST method and IBAN asked ONCE.
// ---------------------------------------------------------------------------------------------

/**
 * The legal form a company name already states. "Mara Design GmbH" is a GmbH and "Bergblick AG" an
 * AG; anything else defaults to the Einzelfirma the engine also defaults to. A DEFAULT, never a
 * decision taken away: the select stays on the panel and the stored value always wins over the guess.
 */
export function legalFormFromName(name: string): (typeof LEGAL_FORMS)[number] {
  if (/\bGmbH\s*$/i.test(name.trim())) return 'gmbh';
  if (/\bAG\s*$/.test(name.trim())) return 'ag';
  return 'einzelfirma';
}

/** The MWST choice the first-hour panel offers while the workspace has no method yet (A05 US-A05.1). */
const VAT_CHOICES = ['effektiv', 'saldo', 'none'] as const;

type FirstHourError =
  | { field: 'name' | 'uid' | 'mwstNo' | 'legalForm' | 'fiscal' | 'vat' | 'iban' | 'address' | 'creditorName' | 'generic'; err: Err };

/**
 * Map one refusal onto the field that caused it. `set_creditor_profile`'s half is the shared
 * contract file (pinned to the engine by the root suite); the identity and fiscal verbs' codes are
 * listed here because those verbs have no such contract yet.
 */
function fieldFor(verb: string, err: Err): FirstHourError {
  if (verb === 'set_creditor_profile') {
    if (err.error === 'invalid_iban') return { field: 'iban', err };
    if (err.error === 'needs_structured_address' || err.error === 'illegal_character') return { field: 'address', err };
    if (err.error === 'invalid_name') return { field: 'creditorName', err };
    return { field: 'generic', err };
  }
  if (verb === 'update_company_profile') {
    if (err.error === 'invalid_name') return { field: 'name', err };
    if (err.error === 'invalid_uid') return { field: 'uid', err };
    if (err.error === 'invalid_mwst_no') return { field: 'mwstNo', err };
    if (err.error === 'invalid_legal_form') return { field: 'legalForm', err };
    return { field: 'generic', err };
  }
  if (verb === 'set_fiscal_config') return { field: 'fiscal', err };
  if (verb === 'vat_configure' || verb === 'vat_seed_defaults') return { field: 'vat', err };
  return { field: 'generic', err };
}

const IDENTITY_ERR_KEY: Record<string, string> = {
  invalid_uid: 'company.err.invalidUid',
  invalid_mwst_no: 'company.err.invalidMwstNo',
  invalid_legal_form: 'company.err.invalidLegalForm',
};

function firstHourErrMessage(t: I18n['t'], e: FirstHourError): string {
  if (e.field === 'vat') return t('company.err.vatFailed');
  const key = FIELD_ERR_KEY[e.err.error] ?? IDENTITY_ERR_KEY[e.err.error];
  return key !== undefined ? t(key) : t('errors.fallback');
}

/**
 * THE ONE PROFILE PANEL. Before F-09 the same facts lived in three panels with three saves (the
 * legal form in the fiscal panel, the MWST method on `/vat` only, the IBAN in a creditor panel that
 * refused to save without five address fields), and J1.1 measured 26 clicks and 112 keystrokes
 * against an ideal of 9 and 60. Now: name, legal form, MWST method and IBAN on one panel, one save,
 * with the Swiss defaults pre-set (the legal form from the name, MWST effektiv on agreed
 * consideration, registered) and everything read-once behind two disclosures.
 *
 * ONE SAVE, FOUR VERBS. The panel writes through the verbs that own each fact, never a composite:
 * `update_company_profile` (name, legal form, UID, MWST-Nr), `set_fiscal_config` (currency and
 * fiscal year, only when they changed: the §H-FX lock refuses a change after the first posting),
 * `vat_configure` + `vat_seed_defaults` (only while no method is stored: a later change is the
 * period-aligned change `/vat` owns) and `set_creditor_profile` (IBAN, name, and the address when
 * it was given). Each refusal lands on its field; the status line reports the whole save.
 *
 * THE ADDRESS IS A DEFERRAL, NOT A GATE. The engine stores the IBAN without it (F-09) and the
 * QR-bill asks for it when the first bill renders, so the panel says exactly that under the IBAN.
 */
function FirstHourPanel({ workspaceId, profile, onSaved }: { workspaceId: string; profile: Profile; onSaved: () => void }) {
  const t = useT();
  const client = useClient();
  const { locale } = useI18n();
  const ids = {
    name: useId(),
    legalForm: useId(),
    vat: useId(),
    vatTiming: useId(),
    iban: useId(),
    ibanHint: useId(),
    ibanNote: useId(),
    creditorName: useId(),
    street: useId(),
    buildingNo: useId(),
    zip: useId(),
    town: useId(),
    country: useId(),
    uid: useId(),
    mwstNo: useId(),
    currency: useId(),
    fyStart: useId(),
    lockNote: useId(),
    addressRegion: useId(),
    moreRegion: useId(),
  };

  const [name, setName] = useState(profile.name ?? '');
  const [legalForm, setLegalForm] = useState<string>(profile.legalForm ?? legalFormFromName(profile.name ?? ''));
  // The MWST choice is asked ONCE: while the workspace has no method. Afterwards the badges say what
  // is stored and `/vat` owns the change (it is period-aligned, not a field on a form).
  const vatUnset = profile.vatMethod == null;
  const [vatChoice, setVatChoice] = useState<(typeof VAT_CHOICES)[number]>('effektiv');
  const [vatTiming, setVatTiming] = useState<'soll' | 'ist'>('soll');
  const [iban, setIban] = useState(profile.creditorIban ?? '');
  const [hintOpen, setHintOpen] = useState(false);
  const address = profile.creditorAddress ?? {};
  const hasStoredAddress = Boolean(address.street && address.buildingNo && address.zip && address.town && address.country);
  const [addressOpen, setAddressOpen] = useState(hasStoredAddress);
  const [creditorName, setCreditorName] = useState(profile.creditorName ?? '');
  const [street, setStreet] = useState(address.street ?? '');
  const [buildingNo, setBuildingNo] = useState(address.buildingNo ?? '');
  const [zip, setZip] = useState(address.zip ?? '');
  const [town, setTown] = useState(address.town ?? '');
  const [country, setCountry] = useState(address.country ?? 'CH');
  const [moreOpen, setMoreOpen] = useState(false);
  const [uid, setUid] = useState(profile.uid ?? '');
  const [mwstNo, setMwstNo] = useState(profile.mwstNo ?? '');
  const [baseCurrency, setBaseCurrency] = useState(profile.baseCurrency ?? 'CHF');
  const [fiscalYearStart, setFiscalYearStart] = useState(profile.fiscalYearStart ?? '01-01');
  const { month: fyMonth, day: fyDay } = splitMonthDay(fiscalYearStart);
  /**
   * Recombine the two selects into the ISO `MM-DD` the engine stores. The day is clamped to the new
   * month, so switching 31 January to February yields 28 February rather than a 31 February that
   * would only be rejected on save.
   */
  const setMonthDay = (month: number, day: number) =>
    setFiscalYearStart(`${pad2(month)}-${pad2(Math.min(day, DAYS_IN_MONTH[month - 1]))}`);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<FirstHourError[]>([]);

  /**
   * §H-FX: once one entry is posted, `base_currency` and `fiscal_year_start` are frozen and
   * `set_fiscal_config` answers `needs_empty_ledger`. The engine reports that same predicate as
   * `ledgerLocked` (one shared helper, so the read and the write cannot disagree), and the form
   * prevents AT the control rather than letting the operator type a change and be rejected on save.
   * The legal form is deliberately NOT locked: it is neither currency- nor period-bearing.
   */
  const locked = profile.ledgerLocked === true;
  const lockNoteId = locked ? ids.lockNote : undefined;

  // THE PADLOCKS (A24, F5): the identity, fiscal and creditor writes are `manage_settings`; the MWST
  // capture is `manage_vat_config`. Without the first the save affordance is absent (and the submit
  // handler guards the Enter key); without the second the MWST choice is not offered at all, so a
  // control never shows and then refuses.
  const canManageSettings = useCan(CAP.manageSettings);
  const canManageVat = useCan(CAP.manageVatConfig);
  const offerVat = vatUnset && canManageVat;

  const errorFor = (field: FirstHourError['field']) => errors.find((e) => e.field === field);
  const addressTouched = [street, buildingNo, zip, town].some((v) => v.trim().length > 0);
  const addressMissing = !hasStoredAddress && !addressTouched;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canManageSettings || saving) return;
    setSaving(true);
    setSaved(false);
    const failures: FirstHourError[] = [];
    const run = async (verb: string, input: Record<string, unknown>): Promise<boolean> => {
      const resp: RestResponse = await client.call(verb, input);
      if (isErr(resp.body)) {
        failures.push(fieldFor(verb, resp.body));
        return false;
      }
      return true;
    };

    // A blank UID or MWST-Nr is "not given", never an empty identifier: the engine format-checks
    // whatever it is handed and refuses `invalid_uid` on '' (measured on the first flow run, where the
    // legal form silently never landed because the whole verb was refused).
    await run('update_company_profile', {
      workspaceId,
      name,
      legalForm,
      ...(uid.trim().length > 0 ? { uid: uid.trim() } : {}),
      ...(mwstNo.trim().length > 0 ? { mwstNo: mwstNo.trim() } : {}),
    });
    if (!locked && (baseCurrency !== (profile.baseCurrency ?? 'CHF') || fiscalYearStart !== (profile.fiscalYearStart ?? '01-01'))) {
      await run('set_fiscal_config', { workspaceId, baseCurrency, fiscalYearStart });
    }
    if (offerVat) {
      // The same two acts `/vat`'s "MWST aktivieren" performs (US-A05.1): configure, then seed the
      // default Swiss code set once. Not MWST-registered is `method:'none'`, decided, no codes.
      const registered = vatChoice !== 'none';
      const configured = await run('vat_configure', {
        workspaceId,
        method: vatChoice,
        timing: registered ? vatTiming : 'soll',
        registered,
        idempotencyKey: `profile-vat-${workspaceId}-${vatChoice}-${vatTiming}`,
      });
      if (configured && registered) await run('vat_seed_defaults', { workspaceId, idempotencyKey: `profile-vat-seed-${workspaceId}` });
    }
    const creditorTouched = iban.trim().length > 0 || addressTouched || creditorName.trim().length > 0 || profile.creditorIban != null;
    if (creditorTouched) {
      await run('set_creditor_profile', {
        workspaceId,
        ...(creditorName.trim().length > 0 ? { creditorName: creditorName.trim() } : {}),
        address: { street, buildingNo, zip, town, country: addressTouched ? country : '' },
        // A blank IBAN is "not given", never an empty identifier: the engine format-checks whatever
        // it is handed and refuses `invalid_iban` on '', which would block the engine-supported
        // address-first save (a full address, no IBAN yet). Omit the key when blank, exactly as the
        // creditorName above and the uid / mwstNo on `update_company_profile` do.
        ...(iban.trim().length > 0 ? { iban: iban.trim() } : {}),
      });
    }

    setSaving(false);
    setErrors(failures);
    // A refusal on a field inside a closed disclosure opens it: the message is never out of sight
    // (DESIGN.md: an error says what happened and where; a hidden field error is a dead end).
    if (failures.some((f) => f.field === 'address' || f.field === 'creditorName')) setAddressOpen(true);
    if (failures.some((f) => f.field === 'uid' || f.field === 'mwstNo' || f.field === 'fiscal')) setMoreOpen(true);
    if (failures.length === 0) {
      setSaved(true);
      onSaved();
    }
  }

  const generic = errorFor('generic') ?? errorFor('fiscal') ?? errorFor('vat') ?? errorFor('legalForm');
  const fieldError = (field: FirstHourError['field'], id: string): ReactNode => {
    const e = errorFor(field);
    if (e === undefined) return null;
    return (
      <p id={`${id}-err`} className="field-error" role="alert">
        <AlertGlyph className="status-glyph status-glyph-error" size={16} />
        {firstHourErrMessage(t, e)}
      </p>
    );
  };

  return (
    <Panel title={t('company.sections.profile')}>
      <p className="setup-explainer">{t('company.firstHour.lead')}</p>
      <form className="form-stack" onSubmit={onSubmit} noValidate>
        <div className="form-row">
          <label htmlFor={ids.name}>{t('setup.name')}</label>
          <input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={errorFor('name') !== undefined || undefined}
            aria-describedby={errorFor('name') !== undefined ? `${ids.name}-err` : undefined}
          />
          {fieldError('name', ids.name)}
        </div>
        <div className="form-row">
          <label htmlFor={ids.legalForm}>{t('company.legalForm.label')}</label>
          <select id={ids.legalForm} value={legalForm} onChange={(e) => setLegalForm(e.target.value)}>
            {LEGAL_FORMS.map((form) => (
              <option key={form} value={form}>
                {t(`company.legalForm.${form}`)}
              </option>
            ))}
          </select>
        </div>

        {offerVat ? (
          <div className="form-row">
            <label htmlFor={ids.vat}>{t('company.vatMethod.label')}</label>
            <select id={ids.vat} value={vatChoice} onChange={(e) => setVatChoice(e.target.value as (typeof VAT_CHOICES)[number])}>
              {VAT_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`company.vatChoice.${choice}`)}
                </option>
              ))}
            </select>
            {vatChoice !== 'none' && (
              <div className="setup-vat-timing">
                <label htmlFor={ids.vatTiming}>{t('company.vatTiming.label')}</label>
                <select id={ids.vatTiming} value={vatTiming} onChange={(e) => setVatTiming(e.target.value as 'soll' | 'ist')}>
                  <option value="soll">{t('company.vatTiming.soll')}</option>
                  <option value="ist">{t('company.vatTiming.ist')}</option>
                </select>
              </div>
            )}
            <p className="field-hint">{t('company.firstHour.vatHint')}</p>
          </div>
        ) : (
          <div className="form-row">
            <span className="field-label-row">
              <span>{t('company.vatMethod.label')}</span>
              {/* The stored method is a fact, and changing it is `/vat`'s period-aligned change. */}
              <Link to="/vat" className="setup-inline-link">
                {vatUnset ? t('company.firstHour.vatSetUp') : t('company.firstHour.vatChange')}
              </Link>
            </span>
            <VatSummary profile={profile} />
          </div>
        )}

        <div className="form-row">
          <span className="field-label-row">
            <label htmlFor={ids.iban}>{t('company.iban')}</label>
            <button
              type="button"
              className="help-trigger"
              aria-label={t('company.ibanHelp')}
              aria-expanded={hintOpen}
              aria-controls={ids.ibanHint}
              onClick={() => setHintOpen((v) => !v)}
            >
              <HelpGlyph size={16} />
            </button>
          </span>
          <input
            id={ids.iban}
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            /* Kind-neutral on purpose: the old `CH00 3000 ...` showed a QR-IID from the reserved
               30000-31999 range, which read as a demand for a QR-IBAN the field does not make. */
            placeholder="CH00 0000 0000 0000 0000 0"
            aria-invalid={errorFor('iban') !== undefined || undefined}
            aria-describedby={[hintOpen ? ids.ibanHint : null, addressMissing ? ids.ibanNote : null, errorFor('iban') !== undefined ? `${ids.iban}-err` : null].filter(Boolean).join(' ') || undefined}
          />
          {hintOpen && (
            <p id={ids.ibanHint} className="field-hint">
              {t('company.ibanHint')}
            </p>
          )}
          {fieldError('iban', ids.iban)}
          {addressMissing && (
            <p id={ids.ibanNote} className="field-hint">
              {t('company.firstHour.addressLater')}
            </p>
          )}
        </div>

        {/* The QR-bill address, disclosed: needed before the first invoice renders, never before the
            IBAN saves. Open by default only when an address is already stored. */}
        <section className="setup-disclosure" aria-labelledby={ids.addressRegion}>
          <h3 className="setup-disclosure-title">
            <button
              type="button"
              id={ids.addressRegion}
              className="setup-disclosure-toggle"
              aria-expanded={addressOpen}
              onClick={() => setAddressOpen((v) => !v)}
            >
              <span className="setup-disclosure-chevron" aria-hidden="true">{addressOpen ? '▾' : '▸'}</span>
              {t('company.sections.creditor')}
            </button>
          </h3>
          {addressOpen && (
            <div className="form-stack">
              <p className="field-hint">{t('company.firstHour.addressLead')}</p>
              <div className="form-row">
                <label htmlFor={ids.creditorName}>{t('company.creditorName')}</label>
                <input
                  id={ids.creditorName}
                  value={creditorName}
                  onChange={(e) => setCreditorName(e.target.value)}
                  placeholder={name}
                  aria-invalid={errorFor('creditorName') !== undefined || undefined}
                />
                {fieldError('creditorName', ids.creditorName)}
              </div>
              <fieldset className="setup-address-group" aria-invalid={errorFor('address') !== undefined || undefined}>
                <legend>{t('company.address.label')}</legend>
                <div className="form-row">
                  <label htmlFor={ids.street}>{t('company.address.street')}</label>
                  <input id={ids.street} value={street} onChange={(e) => setStreet(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor={ids.buildingNo}>{t('company.address.buildingNo')}</label>
                  <input id={ids.buildingNo} value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor={ids.zip}>{t('company.address.zip')}</label>
                  <input id={ids.zip} value={zip} onChange={(e) => setZip(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor={ids.town}>{t('company.address.town')}</label>
                  <input id={ids.town} value={town} onChange={(e) => setTown(e.target.value)} />
                </div>
                <div className="form-row">
                  <label htmlFor={ids.country}>{t('company.address.country')}</label>
                  <input id={ids.country} value={country} onChange={(e) => setCountry(e.target.value)} />
                </div>
                {fieldError('address', ids.street)}
              </fieldset>
            </div>
          )}
        </section>

        {/* Read-once facts: the UID and MWST number, and the currency and fiscal year that are pre-set
            (CHF, 01.01.) and frozen after the first posting. */}
        <section className="setup-disclosure" aria-labelledby={ids.moreRegion}>
          <h3 className="setup-disclosure-title">
            <button
              type="button"
              id={ids.moreRegion}
              className="setup-disclosure-toggle"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span className="setup-disclosure-chevron" aria-hidden="true">{moreOpen ? '▾' : '▸'}</span>
              {t('company.sections.more')}
            </button>
          </h3>
          {moreOpen && (
            <div className="form-stack">
              <div className="form-row">
                <label htmlFor={ids.uid}>{t('company.uid')}</label>
                <input
                  id={ids.uid}
                  value={uid}
                  onChange={(e) => setUid(e.target.value)}
                  placeholder="CHE-000.000.000"
                  aria-invalid={errorFor('uid') !== undefined || undefined}
                />
                {fieldError('uid', ids.uid)}
              </div>
              <div className="form-row">
                <label htmlFor={ids.mwstNo}>{t('company.mwstNo')}</label>
                <input
                  id={ids.mwstNo}
                  value={mwstNo}
                  onChange={(e) => setMwstNo(e.target.value)}
                  placeholder="CHE-000.000.000 MWST"
                  aria-invalid={errorFor('mwstNo') !== undefined || undefined}
                />
                {fieldError('mwstNo', ids.mwstNo)}
              </div>
              <div className="form-row">
                <label htmlFor={ids.currency}>{t('company.baseCurrency')}</label>
                <input
                  id={ids.currency}
                  value={baseCurrency}
                  onChange={(e) => setBaseCurrency(e.target.value)}
                  disabled={locked}
                  aria-describedby={lockNoteId}
                />
              </div>
              {/*
                D15/C1: a real picker, never a text box whose placeholder silently demands a format.
                There is no native control for a recurring month-and-day, so a closed pair of selects
                is the honest equivalent: it makes a malformed value unrepresentable. The wire format
                stays ISO `MM-DD`.
              */}
              <div className="form-row">
                <label htmlFor={ids.fyStart}>{t('company.fiscalYearStart')}</label>
                <div className="setup-fy-start">
                  <select
                    id={ids.fyStart}
                    value={pad2(fyMonth)}
                    onChange={(e) => setMonthDay(Number(e.target.value), fyDay)}
                    disabled={locked}
                    aria-describedby={lockNoteId}
                    aria-label={t('company.fiscalYearStartMonth')}
                  >
                    {monthNames(locale).map((label, i) => (
                      <option key={label} value={pad2(i + 1)}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={pad2(fyDay)}
                    onChange={(e) => setMonthDay(fyMonth, Number(e.target.value))}
                    disabled={locked}
                    aria-describedby={lockNoteId}
                    aria-label={t('company.fiscalYearStartDay')}
                  >
                    {Array.from({ length: DAYS_IN_MONTH[fyMonth - 1] }, (_, i) => (
                      <option key={i + 1} value={pad2(i + 1)}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {locked && (
                <p id={ids.lockNote} className="lock-note">
                  <LockGlyph className="lock-note-glyph" size={14} />
                  {t('company.locked.note')}
                </p>
              )}
              {fieldError('fiscal', ids.fyStart)}
            </div>
          )}
        </section>

        <div className="form-actions">
          <SaveStatus saving={saving} saved={saved} error={generic !== undefined && generic.field !== 'fiscal' ? generic.err : null} />
          {generic?.field === 'fiscal' && !moreOpen && (
            <p className="status-line status-error" role="alert">
              <AlertGlyph className="status-glyph status-glyph-error" size={16} />
              {firstHourErrMessage(t, generic)}
            </p>
          )}
          {errors.length > 0 && generic === undefined && (
            <p className="status-line status-error" role="status">
              {t('company.firstHour.fixFields')}
            </p>
          )}
          {canManageSettings && (
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {t('company.save')}
            </button>
          )}
        </div>
      </form>
    </Panel>
  );
}

/**
 * A32, the eBill section (spec §6). The Biller-ID field with inline validation, the honest enrollment
 * explainer (enrollment happens with a certified network partner, NOT in TILL: there is no "enroll"
 * button because there is nothing local it could truthfully do), and the connector state as a
 * read-only fact. The field write is `set_ebill_config` (`manage_settings`), so the save affordance
 * follows the same F5 padlock as every other setting on this surface.
 */
function EbillConfig({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const ids = { pid: useId(), hint: useId() };
  const [billerPid, setBillerPid] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { save, saving, saved, error } = useSaver('set_ebill_config');
  const canManageSettings = useCan(CAP.manageSettings);
  const invalidPid = error?.error === 'invalid_biller_pid';

  useEffect(() => {
    let live = true;
    async function run() {
      const { body } = await client.call('get_ebill_config', { workspaceId });
      if (!live) return;
      if (!isErr(body)) {
        const config = (body as Record<string, unknown>).config as { billerPid?: string } | null;
        if (config?.billerPid) setBillerPid(config.billerPid);
      }
      setLoaded(true);
    }
    void run();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canManageSettings) return;
    await save({ workspaceId, billerPid });
  }

  return (
    <Panel title={t('ebillConfig.title')}>
      <p className="setup-explainer">{t('ebillConfig.enrollmentExplainer')}</p>
      <p className="setup-explainer">
        <a href="https://www.ebill.ch/en/home/business/network-partners-at-a-glance.html" target="_blank" rel="noopener noreferrer">
          {t('ebillConfig.partnerListLink')}
        </a>
      </p>
      <form className="form-stack" onSubmit={onSubmit} noValidate>
        <div className="form-row">
          <label htmlFor={ids.pid}>{t('ebillConfig.billerPid')}</label>
          <input
            id={ids.pid}
            value={billerPid}
            onChange={(e) => setBillerPid(e.target.value)}
            placeholder="41XXXXXXXXXXXXXXX"
            aria-invalid={invalidPid || undefined}
            aria-describedby={invalidPid ? ids.hint : undefined}
            disabled={!loaded}
          />
          {invalidPid && (
            <p id={ids.hint} className="field-hint" role="alert">
              {t('ebillConfig.invalidBillerPid')}
            </p>
          )}
        </div>
        <p className="setup-explainer setup-connector-state">{t('ebillConfig.connectorAbsent')}</p>
        <div className="form-actions">
          <SaveStatus saving={saving} saved={saved} error={invalidPid ? null : error} />
          {canManageSettings && (
            <button type="submit" className="btn btn--secondary" disabled={saving || !loaded}>
              {t('company.save')}
            </button>
          )}
        </div>
      </form>
    </Panel>
  );
}

/** Read-only MWST method + timing badges, reflecting stored values (editing lives in the VAT surface). */
function VatSummary({ profile }: { profile: Profile }) {
  const t = useT();
  /*
   * `== null` catches BOTH null and undefined, deliberately. The engine stores these columns as
   * SQLite NULL on a workspace whose VAT is not configured yet, and `getCompanyProfile` passes that
   * through as `null`, not `undefined`. Guarding only `undefined` let a fresh workspace build the
   * key `company.vatMethod.null`, which does not exist, so the badge rendered a missing translation
   * on exactly the screen a new user sees first. Found by opening the app, not by a test: every
   * fixture had VAT configured.
   */
  if (profile.vatMethod == null) return null;
  const method = t(`company.vatMethod.${profile.vatMethod}`);
  const showTiming = profile.vatMethod !== 'none' && profile.vatAccounting != null;
  return (
    <div className="setup-vat-summary">
      <span className="setup-badge">{`${t('company.vatMethod.label')}: ${method}`}</span>
      {showTiming && (
        <span className="setup-badge">
          {`${t('company.vatTiming.label')}: ${t(`company.vatTiming.${profile.vatAccounting}`)}`}
        </span>
      )}
    </div>
  );
}

/** Custom fields defined on `entity_kind='workspace'` (spec §6b). Absent (not erroring) when none. */
function CustomFields({ profile }: { profile: Profile }) {
  const t = useT();
  const fields = profile.customFields ?? [];
  const headingId = useId();
  return (
    <section className="panel setup-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-panel-title">
        {t('company.customFields.title')}
      </h2>
      {fields.length === 0 ? (
        <p className="field-hint">{t('company.customFields.empty')}</p>
      ) : (
        <dl className="setup-custom-fields">
          {fields.map((f) => (
            <div key={f.key} className="setup-custom-field-row">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * The loaded face's workspace management block (D24, variant B): the "Arbeitsbereiche" panel plus
 * the disclosed create form. The panel's footer button does not build a second create form; it
 * discloses the surface's ONE CreateWorkspaceForm below the panel and scrolls it into view.
 */
function WorkspacesSection({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const formHostRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  // Scroll AFTER the form exists in the DOM. Optional call: jsdom has no scrollIntoView.
  useEffect(() => {
    if (createOpen) formHostRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [createOpen]);

  return (
    <>
      <WorkspacesPanel activeId={workspaceId} onNewWorkspace={() => setCreateOpen(true)} />
      {createOpen && (
        <div ref={formHostRef}>
          <section className="panel setup-panel" aria-labelledby={headingId}>
            <h2 id={headingId} className="setup-panel-title">
              {t('setup.title')}
            </h2>
            <CreateWorkspaceForm framed={false} submitVariant="accent" seat="onboard_client" onCancel={() => setCreateOpen(false)} />
          </section>
        </div>
      )}
    </>
  );
}

function ProfileBody({ workspaceId, profile, onSaved }: { workspaceId: string; profile: Profile; onSaved: () => void }) {
  return (
    <>
      <FirstHourPanel workspaceId={workspaceId} profile={profile} onSaved={onSaved} />
      <EbillConfig workspaceId={workspaceId} />
      <CustomFields profile={profile} />
      <WorkspacesSection workspaceId={workspaceId} />
    </>
  );
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'denied' }
  | { kind: 'ready'; profile: Profile };

function ProfileLoader({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  /**
   * `quiet` re-reads the profile WITHOUT passing through the loading state: after a save the panel
   * keeps its instance (its "Gespeichert" line and the operator's cursor stay put) while the facts
   * behind it (the stored MWST method, the address) refresh. The first read and a retry still show
   * the skeleton, because there is nothing on screen yet to keep.
   */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState({ kind: 'loading' });
    const resp = await client.call('get_company_profile', { workspaceId });
    if (isErr(resp.body)) {
      setState(isDenied(resp.body) ? { kind: 'denied' } : { kind: 'error', error: resp.body });
      return;
    }
    // `get_company_profile` answers `{ok: true, profile: {...}}`, so the payload is one level down.
    // Reading `resp.body` as the profile put the WRAPPER in this slot: every field then missed and
    // fell back to its default, and the form rendered blank against a workspace that had data. The
    // `as unknown as Profile` cast is what let that compile, so it is gone rather than re-pointed.
    const { profile } = resp.body as { profile?: Profile };
    setState({ kind: 'ready', profile: profile ?? {} });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'denied') {
    return (
      <section className="setup-surface">
        <PermissionDenied />
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="setup-surface">
        <ErrorBanner error={state.error} onRetry={() => void load()} />
      </section>
    );
  }
  // Loading and ready share one persistent section + heading, so the h1 node never detaches on the
  // load -> ready swap (only the body below it changes).
  return (
    <section className="setup-surface" aria-labelledby="company-title">
      <SurfaceHeader title={t('company.title')} titleId="company-title" help={<SurfaceHelp surface="Setup" />} />
      {state.kind === 'loading' ? (
        <div className="panel setup-panel">
          <Skeleton rows={6} height={24} />
        </div>
      ) : (
        <ProfileBody workspaceId={workspaceId} profile={state.profile} onSaved={() => void load(true)} />
      )}
    </section>
  );
}

/**
 * F-09 (J1.5 ideal step 1): the NEW-MANDATE face, reached from the switcher's "Neuer Arbeitsbereich"
 * (`/setup?new=1`) while books already exist. It is the create form and nothing else: the current
 * mandate's profile is not on the page, so nothing typed here can edit the existing company (the
 * J1.5 measurement typed the new client's name into Seeblick's focused name field). The roster stays
 * below it, as on the no-workspace face, because that is where the existing books are re-opened.
 */
function NewWorkspaceFace({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const titleId = useId();
  const formHostRef = useRef<HTMLDivElement | null>(null);
  // The roster's own "Neuer Arbeitsbereich" is THIS form: it brings the name field back into view
  // and focus rather than disclosing a second form.
  const focusForm = () => {
    const input = formHostRef.current?.querySelector('input');
    input?.focus();
    input?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };
  return (
    <section className="setup-surface" aria-labelledby={titleId}>
      <SurfaceHeader title={t('setup.newTitle')} titleId={titleId} help={<SurfaceHelp surface="Setup" />} />
      <p className="setup-explainer">{t('setup.newHint')}</p>
      <div ref={formHostRef}>
        <CreateWorkspaceForm seat="onboard_client" onCancel={() => navigate('/setup', { replace: true })} />
      </div>
      <WorkspacesPanel activeId={workspaceId} onlyWhenPopulated onNewWorkspace={focusForm} />
    </section>
  );
}

/** The surface entry point: routes between the empty (create) face, the new-mandate face and the loaded profile face. */
export function CompanyProfile() {
  const workspaceId = useWorkspaceId();
  const [params] = useSearchParams();
  if (workspaceId === null || workspaceId === '') return <CreateWorkspace />;
  if (params.get('new') === '1') return <NewWorkspaceFace workspaceId={workspaceId} />;
  return <ProfileLoader workspaceId={workspaceId} />;
}
