/**
 * The Datenübernahme surface, the one new route in the migration family (G09 §6), wired at
 * `/migration`. A plan is a long-lived object with its own multi-week lifecycle, several actors and a
 * state none of the other routed surfaces model, which is what earns it a route of its own.
 *
 * WHAT THIS SURFACE IS CAREFUL ABOUT (per D46 the deep UX polish is a later pass; the WORKING states
 * are here):
 *   - The plan leads with the STEPS and their states, never a config grid (canon: config never stacks
 *     on the content it configures).
 *   - Every step row names WHO ACTS NEXT (du / ein Agent / das System), because that is where the
 *     user is looking, not only in the readiness card.
 *   - A money-path step awaiting approval renders an actionable card, never a bare "waiting".
 *   - `diverged` renders ONE real recovery control (reverse) and names restore-from-backup as the
 *     second route with a link to the Daten & Sicherung panel on /setup, because it is the most
 *     consequential failure in the family and a dead button would be worse than advice.
 *   - A passing state gets NO colour (brand law): only attention spends ink.
 *   - Permission-denied renders A24's padlock naming the missing right, not a blank screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { OpeningCheck } from './OpeningCheck';
import { TestmandantPanel } from './TestmandantPanel';
import { SourceIntake } from './SourceIntake';
import { ExtractionChecklist } from './ExtractionChecklist';
import { MappingEditor } from './MappingEditor';
import { ControlTotals } from './ControlTotals';
import { OpenItems } from './OpenItems';
import { ReadinessCard } from './ReadinessCard';
import { ImplementationProject } from './ImplementationProject';
import './Migration.css';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Select } from '../../components/Select';
import { ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

interface StepDto {
  stepId: string;
  dataClass: string;
  state: string;
  counts: { willConflict?: number } | null;
  lastCheckId: string | null;
}
interface PlanDto {
  planId: string;
  state: string;
  // K-30: the engine's authoritative journey placement for this plan state (a `journey[]` phase name,
  // or null when the plan is off the journey e.g. `abandoned`). `phaseFor` reads this instead of
  // reconstructing the plan-state placement itself (the K-23 workaround it retired).
  planPhase: string | null;
  sourceSystem: string | null;
  cutoverDate: string | null;
  // F-09: true while the Übernahmestichtag is still ahead (the engine compares on its own clock). The
  // plan is then "vorbereitet": everything up to the check runs, the promotion waits for the date.
  cutoverPending?: boolean;
}
interface NextAction {
  stepId: string;
  dataClass: string;
  state: string;
  verb: string;
}

type View =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; plans: PlanDto[]; plan: PlanDto; steps: StepDto[]; nextAction: NextAction | null; ownerByStep: Record<string, string> };

// G19 §6: the journey strip gains "Export" as its opening position, the first mile of a migration
// (getting data OUT of the old system) that precedes discovery of the uploaded files.
const JOURNEY = ['export', 'discover', 'map', 'trial', 'check', 'golive', 'verified'] as const;

/** Engine step states are snake_case; the catalogue keys are camelCase. */
const STEP_STATE_KEY: Record<string, string> = {
  pending: 'pending',
  mapped: 'mapped',
  previewed: 'previewed',
  trial_loaded: 'trialLoaded',
  checked: 'checked',
  committed: 'committed',
  verified: 'verified',
  diverged: 'diverged',
  failed: 'failed',
  rolled_back: 'rolledBack',
  skipped: 'skipped',
};

/** A step that only attention should mark: the passing states render neutral (brand law). */
const ATTENTION_STATES = new Set(['diverged', 'failed']);

/** The engine returns the actor as its literal German value; map it to the locale key for en/de. */
const OWNER_KEY: Record<string, string> = {
  du: 'you',
  'ein Agent': 'agent',
  'das System': 'system',
};

/** A data-class label, falling back to a humanised id when a class has no catalogue key yet. */
function classLabel(t: (key: string) => string, dataClass: string): string {
  const key = `migration.dataClass.${dataClass}`;
  const hit = t(key);
  return hit === key ? dataClass : hit;
}

/** `ar_control` -> `arControl`, so a snake_case engine id resolves the camelCase catalogue key. */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** A snake_case id as a readable fallback: `plan_not_live` -> `Plan not live`. */
function humanizeId(id: string): string {
  const spaced = id.replace(/_/g, ' ').trim();
  return spaced === '' ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A G11 control kind (snake) as its check.kind label, humanised if the kind has no key yet. */
function controlKindLabel(t: (key: string) => string, kind: string): string {
  const key = `check.kind.${snakeToCamel(kind)}`;
  const hit = t(key);
  return hit === key ? humanizeId(kind) : hit;
}

/** A plan or step state id as its label, humanised if it matches neither state catalogue. */
function stateLabel(t: (key: string) => string, state: string): string {
  const planKey = `migration.plan.state.${state}`;
  const planHit = t(planKey);
  if (planHit !== planKey) return planHit;
  const stepKey = `migration.step.state.${STEP_STATE_KEY[state] ?? state}`;
  const stepHit = t(stepKey);
  return stepHit === stepKey ? humanizeId(state) : stepHit;
}

/**
 * f18: turn a close-plan refusal into a human name. The engine names the first blocker as a raw id (a
 * control kind, a step's data class, an opaque step id, or a plan state); map each through its own
 * catalogue, preferring the data class over the opaque step id, and humanise anything unmapped.
 */
function humanizeBlocker(
  t: (key: string) => string,
  res: { control?: unknown; dataClass?: unknown; step?: unknown; state?: unknown; error?: string },
): string {
  if (typeof res.control === 'string') return controlKindLabel(t, res.control);
  if (typeof res.dataClass === 'string') return classLabel(t, res.dataClass);
  if (typeof res.step === 'string') {
    const label = classLabel(t, res.step);
    return label === res.step ? humanizeId(res.step) : label;
  }
  if (typeof res.state === 'string') return stateLabel(t, res.state);
  return res.error ?? 'unknown';
}

/** An ISO date as the house-style DD.MM.YYYY; anything not an ISO date passes through unchanged. */
function formatDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;
}

/**
 * K-18: the plan IDENTITY line (source system + Stichtag). A plan used to render unnamed; when a
 * workspace holds several, they were indistinguishable. Degrades gracefully when either half is null.
 */
function planIdentity(
  t: (key: string, params?: Record<string, string | number>) => string,
  plan: { sourceSystem: string | null; cutoverDate: string | null; cutoverPending?: boolean },
): string {
  const source = plan.sourceSystem;
  const date = plan.cutoverDate === null ? null : formatDate(plan.cutoverDate);
  let identity: string;
  if (source !== null && date !== null) identity = t('migration.plan.identity', { source, date });
  else if (source !== null) identity = t('migration.plan.identityNoDate', { source });
  else if (date !== null) identity = t('migration.plan.identityNoSource', { date });
  else identity = t('migration.plan.identityUnknown');
  // F-09: a plan ahead of its Stichtag says so on the identity line ("vorbereitet, produktiv ab ...").
  if (plan.cutoverPending === true && date !== null) return t('migration.plan.prepared', { identity, date });
  return identity;
}

export function Migration(): React.ReactElement {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();
  const t = useT();
  const [view, setView] = useState<View>({ status: 'loading' });
  const [currency, setCurrency] = useState('CHF');
  // G18 R4: closing a finished übernahme is a human judgment behind a confirm; a refusal names the
  // first blocking step or control (P9) so the disabled path always carries its reason as text.
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // K-18: which plan the surface shows when a workspace holds more than one, and the confirm sub-state
  // that gates the destructive abandon control (shaped like closeConfirm).
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [abandonConfirm, setAbandonConfirm] = useState(false);
  // f7: three write actions used to reload in SILENCE on an engine refusal. Each now names its
  // failure as text (role="alert"). The per-step actions (approve, the diverged rollback) key their
  // error to the step so it renders on the row it belongs to; abandon carries its own, like closeError.
  const [stepError, setStepError] = useState<{ stepId: string; kind: 'approve' | 'rollback' } | null>(null);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  const canManageImport = caps.can(CAP.manageImport);

  // The one page header, defined once and reused across every state branch (B2), so the title and its
  // inline help stop being copy-pasted into the loading, denied, error, empty and loaded returns.
  const header = (
    <SurfaceHeader
      title={t('migration.title')}
      titleId="migration-title"
      help={<SurfaceHelp surface="Migration" />}
    />
  );

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setView({ status: 'loading' });
    const plans = (await client.call('migration_list_plans', { workspaceId })).body;
    if (isErr(plans)) {
      setView({ status: plans.error === 'permission_denied' || plans.error === 'forbidden' ? 'denied' : 'error' });
      return;
    }
    const list = ((plans.plans ?? []) as PlanDto[]);
    if (list.length === 0) {
      setView({ status: 'empty' });
      return;
    }
    // K-18: show the selected plan when it is still in the list, else the first. A workspace can hold
    // more than one plan, and the surface used to show only list[0] with no way to reach the others.
    const planId = selectedPlanId !== null && list.some((p) => p.planId === selectedPlanId) ? selectedPlanId : list[0].planId;
    const full = (await client.call('migration_get_plan', { workspaceId, planId })).body;
    if (isErr(full)) {
      setView({ status: full.error === 'permission_denied' || full.error === 'forbidden' ? 'denied' : 'error' });
      return;
    }
    // K-20: the actor per step row (du / ein Agent / das System, G09 §6) is a SURFACE JOIN onto
    // migration_readiness, the engine's authority on who must move each open step. A step with no
    // readiness entry is terminal (done) and names no next actor. If the read is unavailable the join
    // is empty and the row simply shows no actor, never the wrong hard-coded "du".
    const ownerByStep: Record<string, string> = {};
    const ready = (await client.call('migration_readiness', { workspaceId, planId })).body;
    if (!isErr(ready)) {
      for (const b of (ready.blocking ?? []) as Array<{ step?: string; owner?: string }>) {
        if (typeof b.step === 'string' && typeof b.owner === 'string' && ownerByStep[b.step] === undefined) {
          ownerByStep[b.step] = b.owner;
        }
      }
    }
    setView({
      status: 'loaded',
      plans: list,
      plan: full.plan as PlanDto,
      steps: (full.steps ?? []) as StepDto[],
      nextAction: (full.nextAction ?? null) as NextAction | null,
      ownerByStep,
    });
  }, [client, workspaceId, selectedPlanId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The base currency for the money figures the mapping editor renders (P11); defaults to CHF until
  // the company profile answers, exactly as the Eröffnungsprüfung panel resolves it.
  useEffect(() => {
    if (workspaceId === null) return;
    void (async () => {
      const p = (await client.call('get_company_profile', { workspaceId })).body;
      if (!isErr(p)) {
        const base = (p.profile as { baseCurrency?: string } | undefined)?.baseCurrency;
        if (typeof base === 'string' && base !== '') setCurrency(base);
      }
    })();
  }, [client, workspaceId]);

  async function approve(step: StepDto): Promise<void> {
    if (view.status !== 'loaded' || step.lastCheckId === null) return;
    setStepError(null);
    const res = (
      await client.call('migration_record_approval', {
        workspaceId,
        planId: view.plan.planId,
        stepId: step.stepId,
        checkHash: step.lastCheckId,
        idempotencyKey: newIdempotencyKey(),
      })
    ).body;
    if (isErr(res)) {
      setStepError({ stepId: step.stepId, kind: 'approve' });
      return;
    }
    await load();
  }

  // The rollback is the SOLE recovery from a diverged money-path load: a refusal that reloaded in
  // silence left the operator with a dead "reverse" button and no idea it had failed. It now says so.
  async function rollback(step: StepDto): Promise<void> {
    if (view.status !== 'loaded') return;
    setStepError(null);
    const res = (
      await client.call('migration_rollback_step', {
        workspaceId,
        planId: view.plan.planId,
        stepId: step.stepId,
        confirmed: true,
        idempotencyKey: newIdempotencyKey(),
      })
    ).body;
    if (isErr(res)) {
      setStepError({ stepId: step.stepId, kind: 'rollback' });
      return;
    }
    await load();
  }

  async function closePlan(): Promise<void> {
    if (view.status !== 'loaded') return;
    setCloseError(null);
    const res = (
      await client.call('migration_close_plan', {
        workspaceId,
        planId: view.plan.planId,
        confirmed: true,
        idempotencyKey: newIdempotencyKey(),
      })
    ).body;
    if (isErr(res)) {
      // Name the blocker: a non-terminal step, a failed control, or a plan not yet live. The engine
      // returns the first offender as a raw id; f18 humanises it (control kind -> check.kind, data
      // class -> its label) rather than showing 'ar_control' or an opaque step id to the operator.
      setCloseError(humanizeBlocker(t, res as { control?: unknown; dataClass?: unknown; step?: unknown; state?: unknown; error?: string }));
      setCloseConfirm(false);
      return;
    }
    setCloseConfirm(false);
    await load();
  }

  // K-18: abandon a plan (US-G09.6). Destructive and money-path-adjacent: it discards the Testmandant,
  // so it is gated behind the confirm sub-state above and calls the engine with confirmed:true. Belege
  // for any step that reached live are retained by the engine, never deleted. After abandoning, fall
  // back to the first remaining plan.
  async function abandon(): Promise<void> {
    if (view.status !== 'loaded') return;
    setAbandonError(null);
    const res = (
      await client.call('migration_abandon_plan', {
        workspaceId,
        planId: view.plan.planId,
        confirmed: true,
        idempotencyKey: newIdempotencyKey(),
      })
    ).body;
    if (isErr(res)) {
      // f7: a refused abandon used to show nothing and reflect only on the next reload. Name it as
      // text, exactly like closeError, and keep the confirm open so the operator can retry or cancel.
      setAbandonError(humanizeBlocker(t, res as { control?: unknown; dataClass?: unknown; step?: unknown; state?: unknown; error?: string }));
      return;
    }
    setAbandonConfirm(false);
    setSelectedPlanId(null);
    await load();
  }

  // With no workspace `load()` can never run, so the loading skeleton would stand for ever. Render
  // the shared way out instead, exactly as every sibling surface does (Journal, Forecast, ...).
  if (workspaceId === null) {
    return (
      <section className="migration" aria-labelledby="migration-title">
        {header}
        <NoWorkspaceState body={t('migration.noWorkspaceHint')} />
      </section>
    );
  }

  if (view.status === 'loading') {
    return (
      <section className="migration" aria-labelledby="migration-title" aria-busy="true">
        {header}
        {/* K-34: the shared skeleton in the steps' own measure; its label is for screen readers only. */}
        <Skeleton rows={3} height={48} labelKey="migration.loading" />
      </section>
    );
  }

  if (view.status === 'denied' || !canManageImport) {
    return (
      <section className="migration" aria-labelledby="migration-title">
        {header}
        <PermissionDenied body={t('migration.denied')} />
      </section>
    );
  }

  if (view.status === 'error') {
    return (
      <section className="migration" aria-labelledby="migration-title">
        {header}
        {/* K-35: a failed READ in the shared banner, with its way back. */}
        <ErrorBanner message={t('migration.error')} context="read" onRetry={() => void load()} />
      </section>
    );
  }

  if (view.status === 'empty') {
    return (
      <section className="migration" aria-labelledby="migration-title">
        {header}
        {/* G20 §6: an empty surface (no plan) offers to create an Einführungsprojekt above the plan
            intake; a workspace with plans but no project renders nothing here (no project tax). */}
        {workspaceId !== null && <ImplementationProject workspaceId={workspaceId} offerCreateWhenAbsent onChanged={() => void load()} />}
        <div className="migration-empty">
          <h2>{t('migration.empty.title')}</h2>
          <p>{t('migration.empty.body')}</p>
        </div>
        {workspaceId !== null && <SourceIntake workspaceId={workspaceId} onCreated={() => void load()} />}
      </section>
    );
  }

  const { plans, plan, steps, nextAction, ownerByStep } = view;
  const currentPhase = phaseFor(plan, steps);

  return (
    <section className="migration" aria-labelledby="migration-title">
      {header}

      {/* G20 §6: when a workspace has an open implementation project, the surface LEADS with it; the
          plan(s) below nest as the Übernahme phase's content. Renders nothing when no project is open. */}
      {workspaceId !== null && <ImplementationProject workspaceId={workspaceId} onChanged={() => void load()} />}

      {/* K-18: the plan IDENTITY (source system + Stichtag), a SELECTOR when a workspace holds more
          than one plan, and the confirm-gated ABANDON control. Abandon discards the Testmandant, so it
          is destructive: it hides behind a confirm sub-state, exactly like the close control below. */}
      <div className="migration-plan-identity">
        <p className="migration-plan-id">{planIdentity(t, plan)}</p>

        {plans.length > 1 && (
          <div className="migration-plan-select">
            {t('migration.plan.selectorLabel')}
            <Select
              value={plan.planId}
              onChange={(val) => {
                setAbandonConfirm(false);
                setSelectedPlanId(val);
              }}
              options={plans.map((p) => ({ value: p.planId, label: planIdentity(t, p) }))}
              ariaLabel={t('migration.plan.selectorLabel')}
            />
          </div>
        )}

        {canManageImport && plan.state !== 'closed' && plan.state !== 'abandoned' && (
          !abandonConfirm ? (
            <button type="button" className="btn btn--secondary migration-abandon-open" onClick={() => setAbandonConfirm(true)}>
              {t('migration.plan.abandon')}
            </button>
          ) : (
            <div className="migration-abandon-confirm" role="group" aria-label={t('migration.plan.abandon')}>
              <p>{t('migration.plan.abandonConfirm')}</p>
              <button type="button" className="btn btn--danger" onClick={() => void abandon()}>
                {t('migration.plan.abandon')}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => { setAbandonConfirm(false); setAbandonError(null); }}>
                {t('migration.intake.back')}
              </button>
              {abandonError !== null && (
                <p className="migration-abandon-error" role="alert">
                  {t('migration.plan.abandonBlocked', { blocker: abandonError })}
                </p>
              )}
            </div>
          )
        )}
      </div>

      {/* K-23: an abandoned plan is not ON the journey; a strip claiming a current phase would lie.
          The smallest honest render is no strip at all (the plan state still shows below). */}
      {plan.state !== 'abandoned' && (
        <ol className="migration-journey" aria-label={t('migration.title')}>
          {JOURNEY.map((phase, i) => (
            <li key={phase} className={i === currentPhase ? 'is-current' : undefined} aria-current={i === currentPhase ? 'step' : undefined}>
              {t(`migration.journey.${phase}`)}
            </li>
          ))}
        </ol>
      )}

      {/* K-20: the next line leads with the ACTION VERB the plan is waiting on (G09 §6), not the bare
          step STATE it used to name. The verb comes from the engine's nextAction; the surface localises
          the verb id, falling back to the id when a verb has no label yet. */}
      {nextAction !== null && (
        <p className="migration-next">
          {t('migration.next')}: {t(`migration.verb.${nextAction.verb}`)} ({classLabel(t, nextAction.dataClass)})
        </p>
      )}

      {/* G19 §6: the extraction checklist, the opening phase (getting data OUT of the old system).
          Renders one row per manifest item merged from the shipped guide, the deletion clock and the
          Datenherausgabe letter. Self-handles its own empty/error/loading states. */}
      {workspaceId !== null && (
        <ExtractionChecklist
          workspaceId={workspaceId}
          planId={plan.planId}
          sourceSystem={plan.sourceSystem}
          canManageImport={canManageImport}
        />
      )}

      <ul className="migration-steps">
        {steps.map((step) => {
          const stateKey = STEP_STATE_KEY[step.state] ?? step.state;
          const attention = ATTENTION_STATES.has(step.state);
          // K-20: the actor is joined from migration_readiness, not the old hard-coded "du". A terminal
          // (done) step has no readiness entry and names no next actor. f5: the class is humanised, not
          // rendered as the raw 'opening_balances' id.
          const owner = ownerByStep[step.stepId];
          return (
            <li key={step.stepId} className="migration-step" data-attention={attention ? 'true' : undefined}>
              <span className="migration-step-class">{classLabel(t, step.dataClass)}</span>
              <span className="migration-step-state">{t(`migration.step.state.${stateKey}`)}</span>
              {owner !== undefined && OWNER_KEY[owner] !== undefined && (
                <span className="migration-step-actor">{t(`migration.actor.${OWNER_KEY[owner]}`)}</span>
              )}

              {step.state === 'checked' && (
                <div className="migration-approval" role="group" aria-label={t('migration.approval.pending')}>
                  <span>{t('migration.approval.pending')}</span>
                  <button type="button" className="btn btn--secondary" onClick={() => void approve(step)}>
                    {t('migration.approval.approve')}
                  </button>
                  {stepError !== null && stepError.stepId === step.stepId && stepError.kind === 'approve' && (
                    <p className="migration-step-error" role="alert">{t('migration.approval.error')}</p>
                  )}
                </div>
              )}

              {step.state === 'diverged' && (
                <div className="migration-diverged" role="group" aria-label={t('migration.diverged.title')}>
                  <p>{t('migration.diverged.title')}</p>
                  <button type="button" className="btn btn--secondary" onClick={() => void rollback(step)}>
                    {t('migration.diverged.reverse')}
                  </button>
                  {/* K-21: restore-from-backup is a real second route, but it lives on /setup
                      (Daten & Sicherung). Name it as text with a link, never as a dead button. */}
                  <p className="migration-diverged-restore">
                    {t('migration.diverged.restoreHint')} <Link className="link-inline" to="/setup">{t('migration.diverged.restoreLink')}</Link>.
                  </p>
                  {stepError !== null && stepError.stepId === step.stepId && stepError.kind === 'rollback' && (
                    <p className="migration-step-error" role="alert">{t('migration.diverged.reverseError')}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* G10: the source-to-target mapping editor (column / chart / tax), and the G11 control-total
          declaration the Eröffnungsprüfung gates on. Both operate on the plan, never a new route. */}
      {workspaceId !== null && steps.length > 0 && (
        <MappingEditor workspaceId={workspaceId} planId={plan.planId} currency={currency} />
      )}

      {workspaceId !== null && steps.length > 0 && (
        <ControlTotals workspaceId={workspaceId} planId={plan.planId} />
      )}

      {workspaceId !== null && (
        <OpeningCheck
          workspaceId={workspaceId}
          planId={plan.planId}
          stepId={checkStepFor(steps)}
        />
      )}

      {/* G21: the Offene-Posten step, AFTER the opening-balance step (spec §6). It carries open
          Debitoren/Kreditoren across as origin=migrated items that post nothing; once imported they
          appear in the ordinary Debitoren/Kreditoren lists with no origin badge. The mapped rows come
          from the upstream mapping step; the panels render empty until they are loaded. */}
      {workspaceId !== null && steps.length > 0 && (
        <OpenItems workspaceId={workspaceId} planId={plan.planId} baseCurrency={currency} />
      )}

      {/* G09 §7: the go-live readiness checklist, naming who must move each open item. */}
      {workspaceId !== null && (
        <ReadinessCard workspaceId={workspaceId} planId={plan.planId} />
      )}

      {/* G18 R4: closing a finished übernahme. Offered once a plan is live; behind a confirm, because a
          close is a human judgment that the migration is done (it is denylisted from automation). A
          refusal names the blocking step or control as text (WCAG 2.2 AA: the reason is never colour). */}
      {canManageImport && (plan.state === 'live' || plan.state === 'closed') && (
        <div className="migration-close">
          {plan.state === 'closed' ? (
            <p className="migration-close-state" role="status">{t('migration.plan.state.closed')}</p>
          ) : !closeConfirm ? (
            <button type="button" className="btn btn--secondary migration-close-open" onClick={() => setCloseConfirm(true)}>
              {t('migration.plan.close')}
            </button>
          ) : (
            <div className="migration-close-confirm" role="group" aria-label={t('migration.plan.close')}>
              <p>{t('migration.plan.closeConfirm')}</p>
              <button type="button" className="btn btn--primary" onClick={() => void closePlan()}>
                {t('migration.plan.close')}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => setCloseConfirm(false)}>
                {t('migration.intake.back')}
              </button>
            </div>
          )}
          {closeError !== null && (
            <p className="migration-close-error" role="alert">
              {t('migration.plan.closeBlocked', { blocker: closeError })}
            </p>
          )}
        </div>
      )}

      {/* G12: the Testmandant card (create / diff / go-productive, discard in the overflow) and the
          shared WorkspaceModeBanner. The check being clean is a proxy of every included step having
          passed its Eröffnungsprüfung (verified / checked); the engine re-runs the WHOLE check and is
          the real gate. */}
      {workspaceId !== null && (
        <TestmandantPanel
          workspaceId={workspaceId}
          planId={plan.planId}
          planState={plan.state}
          checkClean={steps.length > 0 && steps.every((s) => ['verified', 'checked', 'skipped'].includes(s.state))}
          cutoverPending={plan.cutoverPending === true}
          cutoverDate={plan.cutoverDate}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}

/**
 * The step the Eröffnungsprüfung panel runs its check on: the opening position when it is in scope
 * (the money-path class the check exists for, G11 §1), else the first step, else none.
 */
function checkStepFor(steps: readonly StepDto[]): string | null {
  const opening = steps.find((s) => s.dataClass === 'opening_balances');
  if (opening !== undefined) return opening.stepId;
  return steps[0]?.stepId ?? null;
}

/**
 * The surface JOURNEY index for each engine `journey[]` phase name (`plan.planPhase`, K-30). The engine
 * journey has no 'export' opening (index 0): that first mile is the surface's own position, placed from
 * the steps below, so this map starts at 'discover' (index 1).
 */
const PHASE_INDEX: Readonly<Record<string, number>> = {
  discover: 1,
  map: 2,
  trial: 3,
  check: 4,
  golive: 5,
  verified: 6,
};

/**
 * The journey index a plan sits at, so the strip shows the current position.
 *
 * The base placement is the ENGINE's `plan.planPhase` (K-30), the single authoritative mapping from a
 * plan state to a journey phase. This retired the K-23 workaround, a local `switch (planState)` that
 * reconstructed that same placement here and could drift from the engine. What the surface still owns,
 * because the engine's PLAN_PHASE doc delegates it, is two refinements the plan STATE cannot express:
 *   - 'export' (index 0): before any step exists, the operator is still getting data OUT of the old
 *     system, a position that precedes the engine's 'discover'.
 *   - the trial/check MIDDLE: a written 'trial' plan state does not say how far the trial got, so the
 *     steps place it at Probelauf (index 3) or, once every in-scope step is checked/verified, Prüfen
 *     (index 4). A finished plan (golive/verified) sits at its plan-state placement regardless.
 * 'abandoned' never reaches this function (planPhase null; the caller hides the strip for it).
 */
function phaseFor(plan: { planPhase: string | null }, steps: readonly StepDto[]): number {
  const phase = plan.planPhase;
  // A finished plan sits at its authoritative placement, ahead of any step-based refinement.
  if (phase === 'golive') return 5;
  if (phase === 'verified') return 6;
  // The surface's own opening position: no step exists yet, so the export (extraction) is under way.
  if (steps.length === 0) return 0;
  // The trial/check middle the engine delegates to the steps.
  const inScope = steps.filter((s) => s.state !== 'skipped');
  if (inScope.length > 0 && inScope.every((s) => s.state === 'checked' || s.state === 'verified')) return 4;
  if (steps.some((s) => s.state === 'trial_loaded' || s.state === 'checked')) return 3;
  // Otherwise the engine's plan-state placement (discover/map/trial), mapped onto the surface strip.
  return phase === null ? 1 : (PHASE_INDEX[phase] ?? 1);
}

export default Migration;
