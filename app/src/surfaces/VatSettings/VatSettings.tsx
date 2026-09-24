/**
 * VatSettings, the MWST config surface (spec A05 §6), inside Settings.
 *
 * Owns three things: the method (Effektiv/Saldo) + timing (Ist/Soll) + registration config, the
 * ordered Saldosteuersatz list (revealed only under Saldo), and the tax-code register (seed / archive
 * with the ESTV Ziffer per code). A05 is on the N-rate Saldo model: the saldo list is add/removable
 * with no fixed cap, each rate on the ESTV ladder, and the Ziffer is assigned by position (1st -> 323,
 * 2nd -> 333, 3rd+ -> assigned by the ESTV at filing, shown as a neutral note).
 *
 * Renders the five canonical states off the shared F1 primitives: loading (Skeleton), empty (not
 * registered, a greyed table plus an Enable-MWST CTA), error (a real engine Err, inline for
 * invalid_saldo_rate / invalid_vat_number, a banner for needs_vat_registration), success (the config
 * plus register), and permission-denied (the padlock panel: A24 is a permissive stub, the branch is
 * built and tested). Every visible string comes from an i18n key; rates render via the shared
 * formatter, never a hardcoded percentage.
 */
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useI18n, useT, formatDate, formatMoney } from '../../i18n';
import { ConceptTerm } from '../../components/ConceptTerm';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Modal } from '../../components/Modal';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { Select } from '../../components/Select';
import { saldoEligibilityOn } from '../../lib/guidance';
import {
  Skeleton,
  EmptyState,
  ErrorBanner,
  NoWorkspaceState,
  PermissionDenied,
} from '../../components/states';
import { AlertGlyph } from '../../components/states/glyphs';
import { useCan, CAP } from '../../lib/capabilities';
import { CheckCircleGlyph } from './glyphs';
import {
  ESTV_SALDO_LADDER,
  TAX_KINDS,
  formatRatePct,
  hasDuplicateRate,
  idemKey,
  kindKeySegment,
  previousDayIso,
  readCodes,
  readConfig,
  readGenerations,
  saldoZifferForPosition,
  vatElection,
  type SaldoActivity,
  type SaldoDeclarationBasis,
  type SaldoGeneration,
  type TaxCode,
  type TaxKind,
  type VatConfig,
  type VatMethod,
  type VatTiming,
} from './model';

/** The archive-confirm dialog's ARIA role, held as a constant so the string never appears as a
 *  literal `role=` attribute on the JSX (the modal-role guard scans for that shape). Modal hosts it
 *  on its own `div`, a permitted host; the `Modal` element name is not. */
const ALERT_DIALOG = 'alertdialog' as const;

/** An Ertragskonto offered in the Tätigkeit picker: the 3xxx revenue accounts of the chart. */
interface RevenueAccount {
  accountId: string;
  number: string;
  name: string;
}

/**
 * A Tätigkeit while it is being edited.
 *
 * Held by `activityId` rather than by list position, because THE CARRY FOLLOWS THE TÄTIGKEIT. The
 * previous design matched by ordinal, and a reorder then moved an Ertragskonto onto a different
 * Saldosteuersatz and filed a different payable. The id is minted once when the row is created and
 * never changes, so reordering the rows or changing a rate cannot re-point anyone's turnover.
 */
interface ActivityDraft {
  activityId: string;
  name: string;
  rateBp: number;
  accountNumbers: string[];
}

function isDenied(err: Err): boolean {
  return err.error === 'permission_denied' || err.error === 'forbidden';
}

/**
 * The Ertragskonten a Tätigkeit may claim: the `income` accounts of the chart, archived ones dropped.
 *
 * Filtered by the engine's own `type`, never by a `3` prefix on the number. A workspace may rename or
 * renumber its chart, and a picker that decided what revenue was by string matching would silently
 * stop offering an account the return still attributes turnover from.
 */
function readRevenueAccounts(body: Record<string, unknown>): RevenueAccount[] {
  const raw = body.accounts;
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((a) => a.type === 'income' && a.archived !== true)
    .map((a) => ({
      accountId: String(a.id ?? ''),
      number: String(a.number ?? ''),
      name: String(a.name ?? ''),
    }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

// ---------------------------------------------------------------------------------------------
// Entry + loader
// ---------------------------------------------------------------------------------------------

export function VatSettings() {
  const t = useT();
  const workspaceId = useWorkspaceId();

  // No workspace: the shared no-workspace state, never a ctx call with a blank tenant. This used to
  // be a bare EmptyState with a hint and no action, which is a wall: it told the operator what was
  // missing and gave them no way to fix it.
  if (workspaceId === null || workspaceId === '') {
    return (
      <section className="vat-surface" aria-labelledby="vat-title">
        <SurfaceHeader title={t('vat.settings.title')} titleId="vat-title" />
        <NoWorkspaceState body={t('vat.noWorkspaceHint')} />
      </section>
    );
  }

  return <VatLoader workspaceId={workspaceId} />;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'denied' }
  | {
      kind: 'ready';
      config: VatConfig;
      codes: TaxCode[];
      accounts: RevenueAccount[];
      generations: SaldoGeneration[];
    };

function VatLoader({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    // The chart and the approval history are fetched beside the config because the Saldo editor
    // cannot be rendered without either: a Tätigkeit owns Ertragskonten by number, and D44 R3's
    // Bewilligungsverlauf is what teaches that changing a rate today does not rewrite last quarter.
    // Only `vat_config` is load-bearing; the other three degrade to empty rather than blanking the
    // surface, since a missing history is a thinner panel and a missing config is no panel at all.
    const [configResp, codesResp, accountsResp, gensResp] = await Promise.all([
      client.call('vat_config', { workspaceId }),
      client.call('vat_codes', { workspaceId, includeArchived: true }),
      client.call('list_accounts', { workspaceId }),
      client.call('vat_saldo_generations', { workspaceId }),
    ]);
    if (isErr(configResp.body)) {
      setState(
        isDenied(configResp.body) || configResp.status === 403
          ? { kind: 'denied' }
          : { kind: 'error', error: configResp.body },
      );
      return;
    }
    const codes = isErr(codesResp.body) ? [] : readCodes(codesResp.body);
    const generations = isErr(gensResp.body) ? [] : readGenerations(gensResp.body);
    setState({
      kind: 'ready',
      config: readConfig(configResp.body),
      codes,
      accounts: readRevenueAccounts(accountsResp.body),
      generations,
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'denied') {
    return (
      <section className="vat-surface" aria-labelledby="vat-title">
        <SurfaceHeader title={t('vat.settings.title')} titleId="vat-title" />
        <PermissionDenied />
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="vat-surface" aria-labelledby="vat-title">
        <SurfaceHeader title={t('vat.settings.title')} titleId="vat-title" />
        <ErrorBanner error={state.error} onRetry={() => void load()} />
      </section>
    );
  }

  // Loading and ready share the persistent section + heading, so the h1 never detaches on the swap.
  // The three ready branches are the three states of the election (G17 §8b): the explainer block is
  // the empty state IFF the election is UNDECIDED; "nicht MWST-pflichtig" is a decided answer with
  // its own calm state and a reversible way back; registered renders the configuration.
  return (
    <section className="vat-surface" aria-labelledby="vat-title">
      <SurfaceHeader
        title={t('vat.settings.title')}
        titleId="vat-title"
        help={<SurfaceHelp surface="VatSettings" />}
      />
      {state.kind === 'loading' ? (
        <div className="panel vat-panel">
          <Skeleton rows={6} height={32} />
        </div>
      ) : vatElection(state.config) === 'registered' ? (
        <VatConfigured
          workspaceId={workspaceId}
          config={state.config}
          codes={state.codes}
          accounts={state.accounts}
          generations={state.generations}
          onChanged={() => void load()}
        />
      ) : vatElection(state.config) === 'not_liable' ? (
        <NotLiable workspaceId={workspaceId} onChanged={() => void load()} />
      ) : (
        <NotEnabled workspaceId={workspaceId} onEnabled={() => void load()} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty: the election is UNDECIDED. The explainer block IS the empty state (G17 §8b).
// ---------------------------------------------------------------------------------------------

/**
 * The explainer block of the binding MWST election. It renders IFF the election is undecided
 * (`vat_method` still null on the row), offers BOTH answers the election has (row 3.6: a block
 * that can only be answered one way is a permanent nag for a legitimately non-registered
 * business), and marks its three concepts (Saldosteuersatz, Soll, Ist) at the cap. No dismissal
 * control, deliberately: the predicate is the data, so answering removes the block and undoing
 * the answer brings it back (row 3.4), with no per-user flag anywhere.
 *
 * The GUIDANCE renders for every role; only the ACTION SLOT obeys A24 (byte-identical copy,
 * different rights).
 */
function NotEnabled({
  workspaceId,
  onEnabled,
}: {
  workspaceId: string;
  onEnabled: () => void;
}) {
  const t = useT();
  const { tRich } = useI18n();
  const client = useClient();
  // THE PADLOCK (A24, F5): both answers write `vat_configure`, gated on `manage_vat_config`. The
  // action slot is absent without it; the explanation of the state stays, byte-identical.
  const canManageVat = useCan(CAP.manageVatConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  async function enable() {
    setBusy(true);
    setError(null);
    // Enable with the effektiv/soll default (US-A05.1); the register can be refined afterwards.
    const resp = await client.call('vat_configure', {
      workspaceId,
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: idemKey('vat-enable'),
    });
    if (isErr(resp.body)) {
      setBusy(false);
      setError(resp.body);
      return;
    }
    // Idempotently seed the default Swiss tax-code set once enabled.
    await client.call('vat_seed_defaults', {
      workspaceId,
      idempotencyKey: idemKey('vat-seed'),
    });
    setBusy(false);
    onEnabled();
  }

  /**
   * The negative answer (row 3.6): "nicht MWST-pflichtig" posts `method:'none', timing:'soll',
   * registered:false`, so the workspace becomes DECIDED and the block disappears for the ordinary
   * reason. Better data too: whether a business is VAT-registered is a fact worth holding, not an
   * absence. Reversible from the same surface (NotLiable keeps MWST aktivieren visible).
   */
  async function notLiable() {
    setBusy(true);
    setError(null);
    const resp = await client.call('vat_configure', {
      workspaceId,
      method: 'none',
      timing: 'soll',
      registered: false,
      idempotencyKey: idemKey('vat-notliable'),
    });
    setBusy(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    onEnabled();
  }

  return (
    <div className="vat-not-enabled">
      {/* A greyed preview of the register, so Empty shows what Enable unlocks, never a bare "No data". */}
      <div className="vat-preview panel" aria-hidden="true">
        <div className="vat-preview-row" />
        <div className="vat-preview-row" />
        <div className="vat-preview-row" />
      </div>
      <div className="panel vat-explainer">
        <h2 className="vat-explainer-title">{t('vat.emptyTitle')}</h2>
        <p className="vat-explainer-body">
          {tRich('vat.explainer.what', {
            saldo: <ConceptTerm k="saldosteuersatz" />,
            soll: <ConceptTerm k="vereinbarte-entgelte" text={t('vat.term.soll')} />,
            ist: <ConceptTerm k="vereinnahmte-entgelte" text={t('vat.term.ist')} />,
          })}
        </p>
        <p className="vat-explainer-body">{t('vat.explainer.default')}</p>
        {canManageVat && (
          <div className="vat-explainer-actions">
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void notLiable()}>
              {t('vat.notLiable')}
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void enable()}>
              {t('vat.enable')}
            </button>
          </div>
        )}
      </div>
      {busy && <p className="vat-status">{t('vat.saving')}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}

/**
 * The DECIDED negative state: the workspace answered "nicht MWST-pflichtig". Not an empty state
 * and not a nag: the explainer block is gone because the decision exists (row 3.2), and the one
 * control is the reversal (row 3.6: a business that crosses the registration threshold next
 * quarter says so where it said the opposite).
 */
function NotLiable({ workspaceId, onChanged }: { workspaceId: string; onChanged: () => void }) {
  const t = useT();
  const client = useClient();
  const canManageVat = useCan(CAP.manageVatConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  async function enable() {
    setBusy(true);
    setError(null);
    const resp = await client.call('vat_configure', {
      workspaceId,
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: idemKey('vat-enable'),
    });
    if (isErr(resp.body)) {
      setBusy(false);
      setError(resp.body);
      return;
    }
    await client.call('vat_seed_defaults', { workspaceId, idempotencyKey: idemKey('vat-seed') });
    setBusy(false);
    onChanged();
  }

  return (
    <div className="vat-not-liable">
      <EmptyState
        title={t('vat.notLiableState.title')}
        hint={t('vat.notLiableState.hint')}
        {...(canManageVat ? { action: { label: t('vat.enable'), onClick: () => void enable() } } : {})}
      />
      {busy && <p className="vat-status">{t('vat.saving')}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Success: configured.
// ---------------------------------------------------------------------------------------------

function VatConfigured({
  workspaceId,
  config,
  codes,
  accounts,
  generations,
  onChanged,
}: {
  workspaceId: string;
  config: VatConfig;
  codes: TaxCode[];
  accounts: RevenueAccount[];
  generations: SaldoGeneration[];
  onChanged: () => void;
}) {
  // The live method drives BOTH the editor and which register shows, so switching the radio to Saldo
  // reveals the saldo editor and hides the effektiv-only tax-code register immediately.
  const [method, setMethod] = useState<VatMethod>(
    config.method === 'effektiv' || config.method === 'saldo' ? config.method : 'effektiv',
  );
  return (
    <>
      {/*
        ConfigPanel does NOT call the surface reload on save (no `onSaved`). Saving `vat_configure`
        used to run `onChanged` -> `VatLoader.load()`, which flipped the whole surface to the loading
        skeleton and REMOUNTED this panel, so the "Gespeichert" line was unmounted the instant it
        rendered and the confirmation was never observable. The config the panel holds in local state
        IS the persisted config once the save returns, so there is nothing to re-read: the panel keeps
        a stable per-panel saved line, exactly like the Setup surface. Only the tax-code register,
        whose rows genuinely change on seed/archive/add, still reloads through `onChanged`.
      */}
      <ConfigPanel
        workspaceId={workspaceId}
        config={config}
        method={method}
        setMethod={setMethod}
        accounts={accounts}
        onSavedApproval={onChanged}
      />
      {method === 'saldo' ? (
        <>
          <DeclarationBasisPanel workspaceId={workspaceId} config={config} onChanged={onChanged} />
          <ApprovalHistory generations={generations} />
        </>
      ) : (
        <TaxCodeRegister workspaceId={workspaceId} codes={codes} onChanged={onChanged} />
      )}
    </>
  );
}

/** The method / timing / registration / saldo editor, saved through `vat_configure`. */
function ConfigPanel({
  workspaceId,
  config,
  method,
  setMethod,
  accounts,
  onSavedApproval,
}: {
  workspaceId: string;
  config: VatConfig;
  method: VatMethod;
  setMethod: (method: VatMethod) => void;
  accounts: RevenueAccount[];
  onSavedApproval: () => void;
}) {
  const t = useT();
  const { tRich } = useI18n();
  const client = useClient();
  const ids = { number: useId() };
  // THE PADLOCK (A24, F5): the whole panel saves through `vat_configure` (`manage_vat_config`).
  const canManageVat = useCan(CAP.manageVatConfig);

  const [timing, setTiming] = useState<VatTiming>(config.timing);
  const [vatNumber, setVatNumber] = useState(config.vatNumber ?? '');
  // The saldo editor holds an ordered list of rate bp (0 = "not chosen yet"), seeded from the config.
  const [rates, setRates] = useState<number[]>(config.saldoRates.map((r) => r.rateBp));
  const [activities, setActivities] = useState<ActivityDraft[]>(() =>
    config.saldoActivities.map((a) => ({
      activityId: a.activityId,
      name: a.name,
      rateBp: a.rateBp,
      accountNumbers: a.accounts.map((x) => x.number),
    })),
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  /**
   * The unstated-branch state (D44 F1 and R3).
   *
   * When the engine answers `saldo_generation_change_unstated` the save is NOT lost and the panel is
   * NOT dead: the pending input is held here and the dialog asks the one question only the operator
   * can answer, then replays it with the branch attached. The shipped surface had no band for this
   * refusal at all, which made the whole panel permanently unsavable (including the MWST number) on
   * every workspace whose approval had moved.
   */
  const [branchAsk, setBranchAsk] = useState<Record<string, unknown> | null>(null);

  const chosenRates = useMemo(() => rates.filter((r) => r > 0), [rates]);
  const duplicate = hasDuplicateRate(chosenRates);
  /**
   * The DISTINCT approved rates, which is what a Tätigkeit may be assigned to.
   *
   * `chosenRates` keeps duplicates on purpose, because `hasDuplicateRate` above is what flags the
   * half-finished state inline and disables Save. But the Tätigkeit picker must not be handed them:
   * it renders one `<option key={bp}>` per rate, so two rates at the same value gave React two
   * children with the same key, and `approvedRates.indexOf(a.rateBp)` resolved BOTH of them to the
   * first position, printing Ziffer 323 next to a row the surface itself had flagged as position 2.
   * The Ziffer is what the turnover is declared under, so that is a wrong number on a tax form and
   * not only a console warning.
   *
   * De-duplicating HERE rather than keying the option by index is the difference between fixing it
   * and hiding it: an index key silences React and leaves `indexOf` pointing at the same wrong
   * position. An approval never carries one rate twice (the engine's schema refuses the second row),
   * so nothing real is lost by collapsing them.
   */
  const distinctRates = useMemo(() => [...new Set(chosenRates)], [chosenRates]);
  const saldoIncomplete = method === 'saldo' && (rates.length === 0 || rates.some((r) => r === 0));

  const invalidSaldoRate = error?.error === 'invalid_saldo_rate';
  const invalidVatNumber = error?.error === 'invalid_vat_number';
  const needsRegistration = error?.error === 'needs_vat_registration';
  const invalidActivity = error?.error === 'invalid_saldo_activity';
  const unknownAccount = error?.error === 'unknown_account';
  const generationFiled = error?.error === 'saldo_generation_filed';
  const grantOutOfOrder = error?.error === 'saldo_grant_out_of_order';

  /** Every Tätigkeit whose rate is no longer in the approved list has nothing lawful to point at. */
  const orphanActivities = useMemo(
    () => activities.filter((a) => a.rateBp > 0 && !chosenRates.includes(a.rateBp)),
    [activities, chosenRates],
  );
  /** One Ertragskonto belongs to one Tätigkeit: two claims on it would double-count its turnover. */
  const contestedAccounts = useMemo(() => {
    const owner = new Map<string, string>();
    const contested = new Set<string>();
    for (const a of activities) {
      for (const number of a.accountNumbers) {
        const already = owner.get(number);
        if (already !== undefined && already !== a.activityId) contested.add(number);
        else owner.set(number, a.activityId);
      }
    }
    return contested;
  }, [activities]);

  const activitiesInvalid =
    method === 'saldo' &&
    (orphanActivities.length > 0 ||
      contestedAccounts.size > 0 ||
      activities.some((a) => a.name.trim() === '' || a.rateBp === 0));

  function buildInput(): Record<string, unknown> {
    const input: Record<string, unknown> = {
      workspaceId,
      method,
      timing,
      registered: true,
      idempotencyKey: idemKey('vat-cfg'),
    };
    if (vatNumber.trim() !== '') input.vatNumber = vatNumber.trim();
    if (method === 'saldo') {
      input.saldoRates = chosenRates.map((rateBp) => ({ rateBp }));
      // Sent even when EMPTY, and that is deliberate. Omitting the key tells the engine "carry the
      // previous Tätigkeiten forward"; sending `[]` says "there are none". Those are different
      // instructions and the shipped save could only express the first, so a Tätigkeit removed on
      // screen came straight back on the next read.
      input.saldoActivities = activities.map((a) => ({
        activityId: a.activityId,
        name: a.name.trim(),
        rateBp: a.rateBp,
        accounts: a.accountNumbers,
      }));
    }
    return input;
  }

  /** Send an already-built input, optionally with the branch the operator chose. */
  async function send(input: Record<string, unknown>) {
    setSaving(true);
    setSaved(false);
    setError(null);
    const resp = await client.call('vat_configure', input);
    setSaving(false);
    if (isErr(resp.body)) {
      // The one refusal that is a QUESTION rather than a failure: hold the input and ask.
      if (resp.body.error === 'saldo_generation_change_unstated') {
        setBranchAsk(input);
        return;
      }
      setError(resp.body);
      return;
    }
    setBranchAsk(null);
    setSaved(true);
    // The approval history and the mapping genuinely changed, so unlike a plain method/number save
    // this one does re-read: the Bewilligungsverlauf below would otherwise still show yesterday.
    if (method === 'saldo') onSavedApproval();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // The F5 padlock's Enter-key half: the save button below is hidden without `manage_vat_config`.
    if (!canManageVat) return;
    if (duplicate || saldoIncomplete || activitiesInvalid) return;
    await send(buildInput());
  }

  return (
    <form className="panel vat-panel form-stack" onSubmit={onSubmit} noValidate>
      <VatSummary method={method} timing={timing} />

      {needsRegistration && (
        <ActionFeedback tone="error" message={t('vat.needsRegistration')} />
      )}

      {/*
        THE STANDING IST CONDITION (G17 row 4.2, the critic-added half): a workspace configured
        `timing:'ist'` carries a condition that will refuse at the FILING, months after the
        election. The same message key renders here (the configured state), under the Ist option
        (election time), and in A07's refusal (VatReturn), so the three can never say different
        things: `vat.return.istNotImplemented` is ONE key with three renders.
      */}
      {config.timing === 'ist' && (
        <ActionFeedback
          tone="warn"
          message={
            <>
              {t('vat.return.istNotImplemented')}{' '}
              <cite className="vat-binding-cite">{t('vat.return.istNotImplementedCite')}</cite>
            </>
          }
        />
      )}

      {/*
        THE ELECTION, with its guidance layers (G17 §8b): every option carries a PERMANENT
        consequence line (layer 1, never behind a gesture), the fieldset carries the binding facts
        with a STRUCTURED citation (what binds is the election, not the option), and the Saldo
        option carries the measured eligibility comparison. Marked terms live inside the sentences
        via tRich; the option's accessible name stays the short label (aria-label on the input,
        consequence joined via aria-describedby).
      */}
      <fieldset className="vat-choice">
        <legend>{t('vat.method.label')}</legend>
        <div className="vat-options">
          <ElectionOption
            name="vat-method"
            value="effektiv"
            current={method}
            label={t('vat.method.effektiv')}
            onSelect={() => setMethod('effektiv')}
            consequence={tRich('vat.consequence.effektiv', {
              vorsteuer: <ConceptTerm k="vorsteuer" text={t('vat.term.vorsteuer')} />,
            })}
          />
          <ElectionOption
            name="vat-method"
            value="saldo"
            current={method}
            label={t('vat.method.saldo')}
            onSelect={() => setMethod('saldo')}
            consequence={t('vat.consequence.saldo')}
            extra={<SaldoEligibility workspaceId={workspaceId} />}
          />
        </div>
        <p className="vat-binding">
          <span className="vat-binding-text">
            {tRich('vat.binding.method', {
              steuerperiode: <ConceptTerm k="steuerperiode" text={t('vat.term.steuerperiode')} />,
            })}
          </span>
          <cite className="vat-binding-cite">{t('vat.binding.methodCite')}</cite>
        </p>
      </fieldset>

      <fieldset className="vat-choice">
        <legend>{t('vat.timing.label')}</legend>
        <div className="vat-options">
          <ElectionOption
            name="vat-timing"
            value="soll"
            current={timing}
            label={t('vat.timing.soll')}
            onSelect={() => setTiming('soll')}
            consequence={t('vat.consequence.soll')}
          />
          <ElectionOption
            name="vat-timing"
            value="ist"
            current={timing}
            label={t('vat.timing.ist')}
            onSelect={() => setTiming('ist')}
            consequence={t('vat.consequence.ist')}
            // The product-limitation line (its own element, one key with the refusal): the option
            // stays selectable, because disabling it would force a business lawfully on
            // vereinnahmte Entgelte to record something untrue about its own tax basis. Rendered
            // at ELECTION time only: once `timing === 'ist'` is SAVED, the standing banner above
            // carries the same key, and two copies of one sentence on one screen is the duplicated
            // copy §4b bans (corpus-critic F8).
            extra={
              config.timing === 'ist' ? undefined : (
                <p className="vat-limitation">
                  {t('vat.return.istNotImplemented')}{' '}
                  <cite className="vat-binding-cite">{t('vat.return.istNotImplementedCite')}</cite>
                </p>
              )
            }
          />
        </div>
        <p className="vat-binding">
          <span className="vat-binding-text">{t('vat.binding.timing')}</span>
          <cite className="vat-binding-cite">{t('vat.binding.timingCite')}</cite>
        </p>
      </fieldset>

      <div className="form-row">
        <label htmlFor={ids.number}>{t('vat.vatNumber')}</label>
        <input
          className="field"
          id={ids.number}
          value={vatNumber}
          onChange={(e) => setVatNumber(e.target.value)}
          placeholder={t('vat.vatNumberPlaceholder')}
          aria-invalid={invalidVatNumber || undefined}
          aria-describedby={invalidVatNumber ? `${ids.number}-err` : undefined}
        />
        {invalidVatNumber && (
          <p id={`${ids.number}-err`} className="field-error" role="alert">
            <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
            {t('vat.error.invalidVatNumber')}
          </p>
        )}
      </div>

      {method === 'saldo' && (
        <>
          <SaldoEditor
            rates={rates}
            setRates={setRates}
            duplicate={duplicate}
            engineError={invalidSaldoRate}
          />
          <ActivityEditor
            activities={activities}
            setActivities={setActivities}
            approvedRates={distinctRates}
            accounts={accounts}
            orphanIds={new Set(orphanActivities.map((a) => a.activityId))}
            contestedAccounts={contestedAccounts}
          />
        </>
      )}

      {/*
        The refusals that belong to THIS form. Each one is a band with the operator's next move in it,
        not a raw error key: these land on a screen whose figures end up on a signed tax form, and
        `saldo_activity_split_required` downstream is the cost of getting the mapping wrong here.
      */}
      {invalidActivity && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.error.invalidActivity')}
        </p>
      )}
      {unknownAccount && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.error.unknownAccount')}
        </p>
      )}
      {generationFiled && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.error.generationFiled')}
        </p>
      )}
      {grantOutOfOrder && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.error.grantOutOfOrder')}
        </p>
      )}

      <div className="form-actions">
        <SaveStatus saving={saving} saved={saved} />
        {canManageVat && (
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving || duplicate || saldoIncomplete || activitiesInvalid}
          >
            {t('vat.save')}
          </button>
        )}
      </div>

      {branchAsk !== null && (
        <ApprovalBranchDialog
          openSince={config.saldoValidFrom}
          busy={saving}
          onCancel={() => setBranchAsk(null)}
          onChoose={(branch) => {
            // A FRESH idempotency key, because this is a different request from the one that was
            // refused: replaying the original key would hand back the stored refusal instead of
            // performing the save the operator just authorised.
            const next: Record<string, unknown> = { ...branchAsk, idempotencyKey: idemKey('vat-cfg') };
            if (branch.kind === 'grant') next.saldoGrant = { validFrom: branch.validFrom };
            else next.saldoCorrection = true;
            void send(next);
          }}
        />
      )}
    </form>
  );
}

/**
 * One option of a binding election: the radio, its short accessible label, its PERMANENT
 * consequence line (G17 layer 1: what this option does to the books, visible with no gesture),
 * and an optional extra layer (the Saldo eligibility comparison, the Ist limitation line). The
 * accessible name stays the short label (aria-label), with the consequence joined through
 * aria-describedby so a screen reader hears it as the description it is.
 */
function ElectionOption({
  name,
  value,
  current,
  label,
  onSelect,
  consequence,
  extra,
}: {
  name: string;
  value: string;
  current: string;
  label: string;
  onSelect: () => void;
  consequence: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const id = useId();
  return (
    <label className="vat-option">
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        onChange={onSelect}
        aria-label={label}
        aria-describedby={`${id}-consequence`}
      />
      <span className="vat-option-body">
        <span className="vat-option-label">{label}</span>
        <span id={`${id}-consequence`} className="vat-option-consequence">
          {consequence}
        </span>
        {extra}
      </span>
    </label>
  );
}

/**
 * The Saldo eligibility comparison (G17 §8b): both Art. 37 Abs. 1 limits, era-scoped and
 * INTERPOLATED (never typed: the no-digit rule is what keeps 5'005'000 from surviving 1.1.2024 in
 * copy), beside the measured taxable turnover of the last full year. A COMPARISON, never a
 * verdict: eligibility turns on EXPECTED turnover (ESTV practice, MWST-Info 12) and a tax-due half
 * computed at a rate the ESTV has not granted yet, so TILL states the figures and stops.
 *
 * Three honest states for the figure, and no fourth: measured, no-turnover-yet, and failed with a
 * retry. NEVER a fabricated zero, and the limits render regardless: they are constants and a
 * failed read must not take the law down with it.
 */
function SaldoEligibility({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const { tRich } = useI18n();
  const client = useClient();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'measured'; year: string; turnoverMinor: number }
    | { kind: 'none' }
    | { kind: 'failed' }
  >({ kind: 'loading' });

  const measure = useCallback(async () => {
    setState({ kind: 'loading' });
    const resp = await client.call('vat_saldo_eligibility', { workspaceId });
    if (isErr(resp.body)) {
      setState({ kind: 'failed' });
      return;
    }
    const body = resp.body as Record<string, unknown>;
    const measured = body.measured as { turnoverMinor?: number; empty?: boolean } | null;
    if (measured === null || measured === undefined) {
      // The engine could not measure (Ist timing, straddled year, no config): the comparison is
      // unavailable, the limits stand. Rendered as the failed state with its retry.
      setState({ kind: 'failed' });
      return;
    }
    if (measured.empty === true) {
      setState({ kind: 'none' });
      return;
    }
    setState({
      kind: 'measured',
      year: String(body.year ?? ''),
      turnoverMinor: typeof measured.turnoverMinor === 'number' ? measured.turnoverMinor : 0,
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void measure();
  }, [measure]);

  const limits = saldoEligibilityOn(new Date().toISOString().slice(0, 10));
  if (limits === null) return null; // unreachable while the clock is past 2023; stated, not assumed.

  return (
    <span className="vat-eligibility">
      <span className="vat-eligibility-limits">
        {tRich('vat.eligibility.limits', {
          turnoverLimit: <span className="t-money">{formatMoney(limits.turnoverLimitMinor, 'CHF')}</span>,
          taxLimit: <span className="t-money">{formatMoney(limits.taxDueLimitMinor, 'CHF')}</span>,
        })}
      </span>
      {state.kind === 'loading' && <span className="vat-eligibility-figure vat-eligibility-pending" aria-hidden="true" />}
      {state.kind === 'measured' && (
        <span className="vat-eligibility-figure">
          {tRich('vat.eligibility.measured', {
            year: state.year,
            amount: <span className="t-money">{formatMoney(state.turnoverMinor, 'CHF')}</span>,
          })}
        </span>
      )}
      {state.kind === 'none' && <span className="vat-eligibility-figure">{t('vat.eligibility.none')}</span>}
      {state.kind === 'failed' && (
        <span className="vat-eligibility-figure">
          {t('vat.eligibility.failed')}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void measure()}>
            {t('vat.eligibility.retry')}
          </button>
        </span>
      )}
    </span>
  );
}

interface RadioOption {
  value: string;
  label: string;
}

/** A keyboard-operable radio group (native inputs) with a visible focus ring via CSS. */
function RadioRow({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string;
  options: RadioOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="vat-radio-row">
      {options.map((opt) => (
        <label key={opt.value} className="vat-radio">
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The ordered, add/removable Saldosteuersatz list. Each row picks a rate from the ESTV ladder and
 *  shows the Ziffer for its position; a 3rd+ rate shows the neutral by-activity note, not an error. */
function SaldoEditor({
  rates,
  setRates,
  duplicate,
  engineError,
}: {
  rates: number[];
  setRates: (next: number[]) => void;
  duplicate: boolean;
  engineError: boolean;
}) {
  const t = useT();

  function updateRate(index: number, rateBp: number) {
    setRates(rates.map((r, i) => (i === index ? rateBp : r)));
  }
  function removeRate(index: number) {
    setRates(rates.filter((_, i) => i !== index));
  }
  function addRate() {
    setRates([...rates, 0]);
  }

  return (
    <section className="vat-saldo" aria-labelledby="vat-saldo-title">
      <h2 id="vat-saldo-title" className="vat-subtitle">
        {t('vat.saldo.title')}
      </h2>
      <p className="field-hint">{t('vat.saldo.hint')}</p>

      {rates.length === 0 ? (
        <p className="field-hint">{t('vat.saldo.empty')}</p>
      ) : (
        <ul className="vat-saldo-list">
          {rates.map((rateBp, index) => {
            const position = index + 1;
            const ziffer = saldoZifferForPosition(position);
            // A rate that duplicates an earlier chosen rate is flagged on the offending later row.
            const isDup =
              rateBp > 0 && rates.slice(0, index).includes(rateBp);
            return (
              <li key={index} className="vat-saldo-row">
                <Select
                  ariaLabel={t('vat.saldo.position', { n: position })}
                  value={rateBp === 0 ? '' : String(rateBp)}
                  onChange={(value) => updateRate(index, value === '' ? 0 : Number(value))}
                  options={[
                    { value: '', label: t('vat.saldo.choose') },
                    ...ESTV_SALDO_LADDER.map((bp) => ({ value: String(bp), label: formatRatePct(bp) })),
                  ]}
                />
                <span className="vat-saldo-ziffer">
                  {t('vat.saldo.ziffer', { ziffer })}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={t('vat.saldo.remove', { n: position })}
                  onClick={() => removeRate(index)}
                >
                  {t('vat.saldo.remove', { n: position })}
                </button>
                {isDup && (
                  <p className="field-error" role="alert">
                    <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
                    {t('vat.saldo.duplicate')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button type="button" className="btn btn--secondary btn--sm vat-add-rate" onClick={addRate}>
        {t('vat.saldo.add')}
      </button>

      {engineError && !duplicate && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.error.invalidSaldoRate')}
        </p>
      )}

      {/* The article lives in the STRUCTURED citation field, never inline in the sentence (G17
          §4b: an inline article is invisible to any structured-citation check and is what the next
          author copies). */}
      <p className="field-hint vat-saldo-note">
        {t('vat.saldo.noInputDeduction')}{' '}
        <cite className="vat-binding-cite">{t('vat.saldo.noInputDeductionCite')}</cite>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// F11: the Tätigkeiten, the branch dialog, the election, and the Bewilligungsverlauf.
// ---------------------------------------------------------------------------------------------

/**
 * The Tätigkeiten and their Ertragskonten: MWSTV Art. 84 Abs. 3, made operable.
 *
 * A person holding several Saldosteuersätze has to book the Erträge separately per rate, and under
 * Saldo nothing on a journal line says which activity it belonged to. So the mapping IS the
 * separation, and this editor is the only place it can be stated. Get it wrong and `vat_return`
 * refuses the whole period with `saldo_activity_split_required` rather than guessing, which is the
 * right refusal and a poor first encounter: hence the inline checks below, which catch the two
 * mistakes that refusal exists for BEFORE the operator reaches their filing deadline.
 *
 * A rate may be shared. Art. 86 Abs. 3 and Abs. 4 both speak of several Tätigkeiten at one
 * Saldosteuersatz, so the rate picker deliberately does not disable a rate another row already uses.
 */
function ActivityEditor({
  activities,
  setActivities,
  approvedRates,
  accounts,
  orphanIds,
  contestedAccounts,
}: {
  activities: ActivityDraft[];
  setActivities: (next: ActivityDraft[]) => void;
  approvedRates: number[];
  accounts: RevenueAccount[];
  orphanIds: Set<string>;
  contestedAccounts: Set<string>;
}) {
  const t = useT();

  function patch(index: number, change: Partial<ActivityDraft>) {
    setActivities(activities.map((a, i) => (i === index ? { ...a, ...change } : a)));
  }

  function add() {
    setActivities([
      ...activities,
      {
        // Minted once and never derived from the name or the position, so renaming a Tätigkeit or
        // reordering the list cannot re-point its Ertragskonten onto another rate.
        activityId: idemKey('act'),
        name: '',
        rateBp: approvedRates[0] ?? 0,
        accountNumbers: [],
      },
    ]);
  }

  function toggleAccount(index: number, number: string) {
    const row = activities[index];
    if (row === undefined) return;
    const has = row.accountNumbers.includes(number);
    patch(index, {
      accountNumbers: has
        ? row.accountNumbers.filter((n) => n !== number)
        : [...row.accountNumbers, number],
    });
  }

  // One rate and no Tätigkeit is a lawful, complete configuration: Art. 84 Abs. 3 binds a person
  // "denen mehrere Saldosteuersätze bewilligt wurden". So the section explains itself rather than
  // nagging, and only becomes a requirement once a second rate is approved.
  const required = approvedRates.length > 1;

  return (
    <section className="vat-activities" aria-labelledby="vat-activities-title">
      <h2 id="vat-activities-title" className="vat-subtitle">
        {t('vat.activity.title')}
      </h2>
      <p className="field-hint">
        {required ? (
          <>
            {t('vat.activity.hintRequired')}{' '}
            <cite className="vat-binding-cite">{t('vat.activity.hintRequiredCite')}</cite>
          </>
        ) : (
          t('vat.activity.hintOptional')
        )}
      </p>

      {activities.length === 0 ? (
        <p className="field-hint">{t('vat.activity.empty')}</p>
      ) : (
        <ul className="vat-activity-list">
          {activities.map((a, index) => {
            const orphan = orphanIds.has(a.activityId);
            // An activity whose rate is no longer approved has NO position, so it has no Ziffer to
            // show. That state is already called out by `orphan` below; asking for position 0 here
            // would be asking a question the form has no answer to.
            const ratePosition = approvedRates.indexOf(a.rateBp) + 1;
            const ziffer = ratePosition >= 1 ? saldoZifferForPosition(ratePosition) : null;
            return (
              <li key={a.activityId} className="vat-activity-row">
                <div className="vat-activity-head">
                  <input
                    className="field vat-activity-name"
                    value={a.name}
                    onChange={(e) => patch(index, { name: e.target.value })}
                    placeholder={t('vat.activity.namePlaceholder')}
                    aria-label={t('vat.activity.nameLabel', { n: index + 1 })}
                    aria-invalid={a.name.trim() === '' || undefined}
                  />
                  <Select
                    value={a.rateBp === 0 ? '' : String(a.rateBp)}
                    onChange={(value) => patch(index, { rateBp: Number(value) })}
                    options={[
                      { value: '', label: t('vat.saldo.choose') },
                      ...approvedRates.map((bp) => ({ value: String(bp), label: formatRatePct(bp) })),
                    ]}
                    ariaLabel={t('vat.activity.rateLabel', { name: a.name || String(index + 1) })}
                    invalid={orphan}
                  />
                  {ziffer !== null && (
                    <span className="vat-saldo-ziffer">{t('vat.saldo.ziffer', { ziffer })}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-label={t('vat.activity.remove', { name: a.name || String(index + 1) })}
                    onClick={() => setActivities(activities.filter((_, i) => i !== index))}
                  >
                    {t('vat.activity.removeShort')}
                  </button>
                </div>

                {orphan && (
                  <p className="field-error" role="alert">
                    <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
                    {t('vat.activity.orphan')}
                  </p>
                )}

                <fieldset className="vat-activity-accounts">
                  <legend>{t('vat.activity.accounts')}</legend>
                  {accounts.length === 0 ? (
                    <p className="field-hint">{t('vat.activity.noAccounts')}</p>
                  ) : (
                    <div className="vat-account-grid">
                      {accounts.map((acc) => {
                        const checked = a.accountNumbers.includes(acc.number);
                        const contested = checked && contestedAccounts.has(acc.number);
                        return (
                          <label
                            key={acc.accountId}
                            className={contested ? 'vat-account vat-account--contested' : 'vat-account'}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAccount(index, acc.number)}
                            />
                            <span>{`${acc.number} ${acc.name}`}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}

      {contestedAccounts.size > 0 && (
        <p className="field-error" role="alert">
          <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
          {t('vat.activity.contested', { accounts: [...contestedAccounts].sort().join(', ') })}
        </p>
      )}

      <button type="button" className="btn btn--secondary btn--sm" onClick={add} disabled={approvedRates.length === 0}>
        {t('vat.activity.add')}
      </button>
    </section>
  );
}

type ApprovalBranch = { kind: 'grant'; validFrom: string } | { kind: 'correction' };

/**
 * The save-time question, and the sentence that makes it answerable (D44 R3).
 *
 * The engine refuses `saldo_generation_change_unstated` because both defaults are wrong in a way
 * nobody would notice: guessing "correction" silently moves a figure the books already hold, and
 * guessing "new grant" silently leaves a period filed at a rate the operator believes they replaced.
 * So the two radios ARE the engine's two branches, one for one.
 *
 * The teaching device is the predecessor's NEW LAST DAY, computed from the date the operator typed
 * and shown before they commit. "Past periods are unaffected" only asks to be believed; "gilt neu bis
 * 30.06.2026" is a fact they can check against their own filings.
 */
function ApprovalBranchDialog({
  openSince,
  busy,
  onCancel,
  onChoose,
}: {
  openSince: string | null;
  busy: boolean;
  onCancel: () => void;
  onChoose: (branch: ApprovalBranch) => void;
}) {
  const t = useT();
  const ids = { date: useId() };
  const [kind, setKind] = useState<'grant' | 'correction'>('grant');
  const [validFrom, setValidFrom] = useState('');

  const dateReady = /^\d{4}-\d{2}-\d{2}$/.test(validFrom);
  const newLastDay = dateReady ? previousDayIso(validFrom) : null;
  const ready = kind === 'correction' || dateReady;

  // The shared Modal primitive traps focus, closes on Escape, and returns focus to the opener.
  // Closing keeps the pending edits (onCancel discards nothing), so the operator can reopen and
  // answer the question without retyping the config.
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('vat.branch.title')}
      closeLabel={t('vat.branch.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            {t('vat.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !ready}
            onClick={() =>
              onChoose(kind === 'grant' ? { kind: 'grant', validFrom } : { kind: 'correction' })
            }
          >
            {t('vat.save')}
          </button>
        </>
      }
    >
      <p className="field-hint">{t('vat.branch.why')}</p>

      <fieldset className="vat-choice">
        <legend>{t('vat.branch.legend')}</legend>
        <RadioRow
          name="vat-branch"
          value={kind}
          options={[
            { value: 'grant', label: t('vat.branch.grant') },
            { value: 'correction', label: t('vat.branch.correction') },
          ]}
          onChange={(v) => setKind(v === 'correction' ? 'correction' : 'grant')}
        />
      </fieldset>

      {kind === 'grant' ? (
        <div className="form-row">
          <label htmlFor={ids.date}>{t('vat.branch.validFrom')}</label>
          <input
            className="field"
            id={ids.date}
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
          <p className="field-hint">
            {newLastDay === null
              ? t('vat.branch.validFromHint')
              : t('vat.branch.newLastDay', {
                  from: formatDate(openSince ?? ''),
                  until: formatDate(newLastDay),
                })}
          </p>
        </div>
      ) : (
        <p className="field-hint">{t('vat.branch.correctionHint')}</p>
      )}
    </Modal>
  );
}

/**
 * The MWSTV Art. 88 Abs. 6 election, per Steuerperiode.
 *
 * "Die steuerpflichtige Person kann den gesamten Umsatz aus steuerbaren Leistungen freiwillig zum
 * höchsten bewilligten Saldosteuersatz abrechnen." It is VOLUNTARY and it usually costs the filer
 * money, so it is a control they operate and never something the engine applies for them. It is also
 * the lawful way out of a third approved rate the current ESTV form has no Ziffer for.
 */
function DeclarationBasisPanel({
  workspaceId,
  config,
  onChanged,
}: {
  workspaceId: string;
  config: VatConfig;
  onChanged: () => void;
}) {
  const t = useT();
  const client = useClient();
  // THE PADLOCK (A24, F5): the engine declares ['manage_vat_config', 'vat_file'] on
  // `vat_saldo_declaration_basis`, because the election moves a figure declared to the ESTV (the
  // F11 finding). The courtesy gate demands BOTH, exactly as the boundary will. Both hooks are
  // called unconditionally and combined after (F5-N1): `&&` between two hook calls short-circuits
  // the second, which violates the hooks rule the day `useCan` allocates a slot.
  const holdsVatConfig = useCan(CAP.manageVatConfig);
  const holdsVatFile = useCan(CAP.vatFile);
  const canElect = holdsVatConfig && holdsVatFile;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const taxPeriod = config.saldoDeclarationTaxPeriod;
  const basis: SaldoDeclarationBasis = config.saldoDeclarationBasis ?? 'per_activity';

  async function choose(next: SaldoDeclarationBasis) {
    if (taxPeriod === null) return;
    setBusy(true);
    setError(null);
    const resp = await client.call('vat_saldo_declaration_basis', {
      workspaceId,
      taxPeriod,
      basis: next,
      idempotencyKey: idemKey('vat-basis'),
    });
    setBusy(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    onChanged();
  }

  if (taxPeriod === null) return null;

  return (
    <section className="panel vat-panel" aria-labelledby="vat-basis-title">
      <h2 id="vat-basis-title" className="vat-subtitle">
        {t('vat.basis.title', { period: taxPeriod })}
      </h2>
      <p className="field-hint">{t('vat.basis.hint')}</p>
      {/* The election writes only when BOTH capabilities are held; without them the panel still
          STATES the basis in force, because knowing what governs a period is a read. */}
      <fieldset className="vat-choice" disabled={!canElect}>
        <legend>{t('vat.basis.legend')}</legend>
        <RadioRow
          name="vat-basis"
          value={basis}
          options={[
            { value: 'per_activity', label: t('vat.basis.perActivity') },
            { value: 'highest_rate', label: t('vat.basis.highestRate') },
          ]}
          onChange={(v) => {
            if (!canElect) return;
            void choose(v === 'highest_rate' ? 'highest_rate' : 'per_activity');
          }}
        />
      </fieldset>
      <p className="field-hint">{t('vat.basis.notCarried')}</p>
      {busy && <p className="vat-status">{t('vat.saving')}</p>}
      {error !== null && <ErrorBanner error={error} />}
    </section>
  );
}

/**
 * The Bewilligungsverlauf, read-only (D44 R3).
 *
 * The hard teaching problem on this surface is that changing a rate today does not rewrite last
 * quarter. A reassurance saying so only asks to be believed. A list with an end date on every
 * superseded approval is a fact the operator can check against their own filings, and under Saldo it
 * is also the only evidence there is: no rate is ever stamped on a journal line, so this history is
 * what says what a filed period was computed with.
 */
function ApprovalHistory({ generations }: { generations: SaldoGeneration[] }) {
  const t = useT();
  if (generations.length === 0) return null;

  // Newest first: the approval in force is the one an operator is looking for.
  const ordered = [...generations].sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  return (
    <section className="panel vat-panel" aria-labelledby="vat-history-title">
      <h2 id="vat-history-title" className="vat-subtitle">
        {t('vat.history.title')}
      </h2>
      <p className="field-hint">{t('vat.history.hint')}</p>
      <ul className="vat-history-list">
        {ordered.map((g) => (
          <li key={g.validFrom} className="vat-history-row">
            <p className="vat-history-span">
              {g.validTo === null
                ? t('vat.history.open', { from: formatDate(g.validFrom) })
                : t('vat.history.closed', {
                    from: formatDate(g.validFrom),
                    until: formatDate(g.validTo),
                  })}
            </p>
            {/*
              NO ZIFFER HERE. `r.formLine` is the PRE-2025 Ziffer for that rate's position, and since
              01.01.2025 the Ziffer is a property of the period being FILED rather than of the
              approval: every approved rate declares on 323 and the split lives in the Beiblatt
              (A07 §3.1a). Printing the stored value put "Ziff. 333" on a modern workspace's approval
              history, naming a box the current form does not have. What the Bewilligungsverlauf is
              for is which rates the ESTV granted and when, and that is what it now shows.
            */}
            <p className="vat-history-rates">{g.rates.map((r) => formatRatePct(r.rateBp)).join(', ')}</p>
            {g.activities.length > 0 && (
              <ul className="vat-history-activities">
                {g.activities.map((a: SaldoActivity) => (
                  <li key={a.activityId}>
                    {`${a.name}: ${formatRatePct(a.rateBp)}`}
                    {a.accounts.length > 0 && ` (${a.accounts.map((x) => x.number).join(', ')})`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Read-only method + timing badge, kept neutral (never recoloured by accent). */
function VatSummary({ method, timing }: { method: VatMethod; timing: VatTiming }) {
  const t = useT();
  return (
    <div className="vat-badges">
      <span className="vat-badge">{`${t('vat.method.label')}: ${t(`vat.method.${method}`)}`}</span>
      <span className="vat-badge">{`${t('vat.timing.label')}: ${t(`vat.timing.${timing}`)}`}</span>
    </div>
  );
}

/** Inline save status: glyph plus text, never colour alone. */
function SaveStatus({ saving, saved }: { saving: boolean; saved: boolean }) {
  const t = useT();
  if (saving) {
    return (
      <p className="vat-status" role="status">
        {t('vat.saving')}
      </p>
    );
  }
  if (saved) {
    return (
      <p className="vat-status vat-status-ok" role="status">
        <CheckCircleGlyph className="vat-glyph vat-glyph-ok" size={16} />
        {t('vat.saved')}
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The tax-code register (effektiv): seed / list with Ziffern / archive.
// ---------------------------------------------------------------------------------------------

function TaxCodeRegister({
  workspaceId,
  codes,
  onChanged,
}: {
  workspaceId: string;
  codes: TaxCode[];
  onChanged: () => void;
}) {
  const t = useT();
  const client = useClient();
  const headingId = useId();
  // THE PADLOCK (A24, F5): seed, upsert, deactivate and reactivate are all `manage_vat_config`. The
  // register itself still renders, because reading the codes is `read_vat`.
  const canManageVat = useCan(CAP.manageVatConfig);
  const [rowError, setRowError] = useState<Err | null>(null);
  const [adding, setAdding] = useState(false);
  // Archiving hides a code from new documents; it is REVERSIBLE via `vat_code_reactivate` (the mirror
  // of `vat_code_deactivate`), so an archived row shows a Reactivate control. Archiving is still a
  // deliberate config change, so the active -> archived direction stays confirm-gated; reactivating is
  // the safe restorative direction and needs no confirm. The pending archive code sits here until
  // confirmed.
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  // The register is the shared DataTable (D118 B2): the frame, the sticky header and the density
  // token come from the primitive, so the per-surface `<table>` and its CSS are gone. The status dot
  // and the archived-row tint stay surface-specific (DataTable ships no state colour), wired through
  // a cell renderer and `rowClassName`.
  const columns: DataTableColumn<TaxCode>[] = [
    {
      key: 'code',
      header: t('vat.code.code'),
      numeric: true,
      align: 'start',
      render: (c) => (
        <>
          {c.code}
          {c.validFrom !== undefined && (
            <span className="vat-code-since"> ({formatDate(c.validFrom)})</span>
          )}
        </>
      ),
    },
    {
      key: 'kind',
      header: t('vat.code.kindLabel'),
      render: (c) => t(`vat.code.kind.${kindKeySegment(c.kind)}`),
    },
    {
      key: 'rate',
      header: t('vat.code.rate'),
      numeric: true,
      render: (c) => (c.rateBp > 0 ? formatRatePct(c.rateBp) : '-'),
    },
    {
      key: 'formLine',
      header: t('vat.code.formLine'),
      numeric: true,
      render: (c) => (c.formLine === '' ? '-' : c.formLine),
    },
    {
      key: 'status',
      header: t('vat.code.statusLabel'),
      render: (c) => {
        const archived = c.archived === true;
        return (
          <>
            <span
              className={`vat-dot ${archived ? 'vat-dot-archived' : 'vat-dot-active'}`}
              aria-hidden="true"
            />
            {archived ? t('vat.code.status.archived') : t('vat.code.status.active')}
          </>
        );
      },
    },
  ];

  // K-21: the row verb sits behind the one quiet overflow, never as a text button in every row.
  // Archiving asks first (the confirm below); reactivating is a plain undo and needs no question.
  const codeActions = (c: TaxCode): OverflowMenuItem[] => {
    if (!canManageVat) return [];
    return c.archived === true
      ? [{ key: 'reactivate', label: t('vat.code.reactivate'), onSelect: () => void reactivate(c.code) }]
      : [{ key: 'archive', label: t('vat.code.archive'), onSelect: () => setConfirmArchive(c.code), danger: true }];
  };

  async function seed() {
    setRowError(null);
    const resp = await client.call('vat_seed_defaults', {
      workspaceId,
      idempotencyKey: idemKey('vat-seed'),
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else onChanged();
  }

  async function archive(code: string) {
    setConfirmArchive(null);
    setRowError(null);
    const resp = await client.call('vat_code_deactivate', {
      workspaceId,
      code,
      idempotencyKey: idemKey('vat-arch'),
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else onChanged();
  }

  // The restorative mirror of `archive`. Reactivating is not consequential (it just brings the code
  // back onto new documents and is itself reversible by archiving again), so no confirm dialog.
  async function reactivate(code: string) {
    setRowError(null);
    const resp = await client.call('vat_code_reactivate', {
      workspaceId,
      code,
      idempotencyKey: idemKey('vat-react'),
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else onChanged();
  }

  return (
    <section className="panel vat-panel" aria-labelledby={headingId}>
      <div className="vat-register-head">
        <h2 id={headingId} className="vat-subtitle">
          {t('vat.codes.title')}
        </h2>
        {canManageVat && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdding((v) => !v)}>
            {t('vat.codes.add')}
          </button>
        )}
      </div>

      {rowError !== null && <ErrorBanner error={rowError} />}

      {adding && (
        <AddCodeForm
          workspaceId={workspaceId}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
          onError={setRowError}
        />
      )}

      <DataTable
        columns={columns}
        rows={codes}
        rowKey={(c) => c.code}
        caption={t('vat.codes.title')}
        rowClassName={(c) => (c.archived === true ? 'vat-code-row--archived' : undefined)}
        {...(canManageVat
          ? {
              rowActions: codeActions,
              rowActionsLabel: (c: TaxCode) => t('vat.code.rowActionsFor', { code: c.code }),
            }
          : {})}
        emptyState={
          <EmptyState
            title={t('vat.codes.empty')}
            {...(canManageVat ? { action: { label: t('vat.codes.seed'), onClick: () => void seed() } } : {})}
          />
        }
      />

      {confirmArchive !== null && (
        <Modal
          open
          // Archiving is one-way, so it is a consequential confirm: an alertdialog (no dismiss on a
          // stray scrim click). The role passes through the constant, never a literal attribute, so
          // the modal-role guard reads it on Modal's own div, not on the `Modal` element name.
          role={ALERT_DIALOG}
          title={t('vat.code.confirmArchiveTitle')}
          onClose={() => setConfirmArchive(null)}
          closeLabel={t('vat.code.confirmArchiveClose')}
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmArchive(null)}>
                {t('vat.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void archive(confirmArchive)}>
                {t('vat.code.archive')}
              </button>
            </>
          }
        >
          <p className="vat-confirm-message">{t('vat.code.confirmArchive', { code: confirmArchive })}</p>
        </Modal>
      )}
    </section>
  );
}

/** A compact inline form to add or edit a code via `vat_code_upsert`. */
function AddCodeForm({
  workspaceId,
  onAdded,
  onError,
}: {
  workspaceId: string;
  onAdded: () => void;
  onError: (err: Err) => void;
}) {
  const t = useT();
  const client = useClient();
  const ids = { code: useId(), kind: useId(), rate: useId(), formLine: useId(), label: useId() };
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<TaxKind>('output');
  const [rateBp, setRateBp] = useState('');
  const [formLine, setFormLine] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  // The field stores BASIS POINTS (810 = 8.1%), not percent. Mirror the server check
  // (src/core/vat/taxCodes.ts): an integer in 0..10000. Empty means 0 (a zero-rated code).
  const rateTrimmed = rateBp.trim();
  const rateNum = rateTrimmed === '' ? 0 : Number(rateTrimmed);
  const rateInvalid = rateTrimmed !== '' && (!Number.isInteger(rateNum) || rateNum < 0 || rateNum > 10000);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (rateInvalid) return;
    setBusy(true);
    const resp = await client.call('vat_code_upsert', {
      workspaceId,
      code: code.trim(),
      kind,
      rateBp: rateNum,
      formLine: formLine.trim(),
      label: label.trim() === '' ? undefined : label.trim(),
      idempotencyKey: idemKey('vat-upsert'),
    });
    setBusy(false);
    if (isErr(resp.body)) {
      onError(resp.body);
      return;
    }
    onAdded();
  }

  return (
    <form className="vat-add-code form-stack" onSubmit={onSubmit}>
      <div className="form-row">
        <label htmlFor={ids.code}>{t('vat.code.code')}</label>
        <input className="field" id={ids.code} value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div className="form-row">
        <label htmlFor={ids.kind}>{t('vat.code.kindLabel')}</label>
        <Select
          id={ids.kind}
          value={kind}
          onChange={(value) => setKind(value as TaxKind)}
          options={TAX_KINDS.map((k) => ({ value: k, label: t(`vat.code.kind.${kindKeySegment(k)}`) }))}
          ariaLabel={t('vat.code.kindLabel')}
        />
      </div>
      <div className="form-row">
        <label htmlFor={ids.rate}>{t('vat.code.rateBpLabel')}</label>
        <input
          className="field"
          id={ids.rate}
          value={rateBp}
          onChange={(e) => setRateBp(e.target.value)}
          inputMode="numeric"
          placeholder="810"
          aria-invalid={rateInvalid || undefined}
          aria-describedby={rateInvalid ? `${ids.rate}-hint ${ids.rate}-err` : `${ids.rate}-hint`}
        />
        <p id={`${ids.rate}-hint`} className="field-hint">
          {t('vat.code.rateBpHint')}
        </p>
        {rateInvalid && (
          <p id={`${ids.rate}-err`} className="field-error" role="alert">
            <AlertGlyph className="vat-glyph vat-glyph-error" size={16} />
            {t('vat.error.rateUnit')}
          </p>
        )}
      </div>
      <div className="form-row">
        <label htmlFor={ids.formLine}>{t('vat.code.formLine')}</label>
        <input className="field" id={ids.formLine} value={formLine} onChange={(e) => setFormLine(e.target.value)} placeholder="303" />
      </div>
      <div className="form-row">
        <label htmlFor={ids.label}>{t('vat.code.label')}</label>
        <input className="field" id={ids.label} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn--secondary" disabled={busy || rateInvalid}>
          {t('vat.save')}
        </button>
      </div>
    </form>
  );
}
