/**
 * The Datenübernahme surface (G09 §6/§8). The claims worth the most here are the ones a broken
 * screen would strand a migration on:
 *
 *   A MONEY-PATH STEP AWAITING APPROVAL MUST BE ACTIONABLE, never a bare "waiting": a step the engine
 *   draft-staged is invisible everywhere else, so if this screen does not surface the approval a human
 *   can never bind it and the commit is stranded for ever.
 *
 *   PERMISSION-DENIED RENDERS A24's PADLOCK naming the missing right, not a blank screen: `can()` fails
 *   OPEN by design, so the denied claim mounts a real CapabilitiesProvider over a whoami that lacks
 *   `manage_import`, else it would measure the permissive default and call it a permission test.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Migration from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

// planPhase mirrors the engine's PLAN_PHASE (K-30): the journey placement getPlan/listPlans return for
// each plan state. The surface's phaseFor reads it, so the mocks carry it like the real response does.
const PLAN = { planId: 'migplan_1', state: 'planned', planPhase: 'map', sourceSystem: 'bexio', cutoverDate: '2026-01-01' };
const PLAN2 = { planId: 'migplan_2', state: 'planned', planPhase: 'map', sourceSystem: 'csv', cutoverDate: '2025-06-30' };
const STEP = (over: Record<string, unknown> = {}) => ({
  stepId: 'migstep_1',
  dataClass: 'contacts',
  state: 'mapped',
  counts: null,
  lastCheckId: null,
  ...over,
});

const whoamiOwner = ok({ actor: 'studio', role: 'owner', isMember: true, provisioned: true, capabilities: ['manage_import'] });
const whoamiNoImport = ok({ actor: 'agent', role: 'viewer', isMember: true, provisioned: true, capabilities: ['read_books'] });

function tree(canned: Canned, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Migration />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Migration surface', () => {
  it('renders the shared no-workspace state, not a permanent skeleton, when no workspace is selected', () => {
    // LOADING-PROOF-EXEMPT: workspaceId is null, so load() returns before any transport call; the
    // assertion is that the surface renders the no-workspace state INSTEAD of reading, and there is
    // nothing in flight to prove.
    render(
      <TillClientProvider client={new TillClient(fakeTransport({}))}>
        <I18nProvider>
          <WorkspaceProvider initialId={null}>
            <MemoryRouter>
              <Migration />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The way out is on screen (states.noWorkspace with the migration-specific reason), and the
    // skeleton is NOT: with no workspace `load()` can never run, so 'loading' would be for ever.
    expect(screen.getByText(de.migration.noWorkspaceHint)).toBeTruthy();
    expect(screen.queryByText(de.migration.loading)).toBeNull();
  });

  it('shows a loading skeleton while the plan list is in flight', async () => {
    // The wait proves the read really started: every surface initialises `loading` to true, so a
    // skeleton on screen is the default and not evidence a read went in flight (loading-state convention).
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Migration />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('migration_list_plans');
    expect(screen.getByText(de.migration.loading)).toBeTruthy();
  });

  it('renders the empty state with the source-intake entry when no plan exists yet', async () => {
    render(tree({ migration_list_plans: ok({ plans: [] }), migration_list_source_adapters: ok({ adapters: [] }) }, false));
    expect(await screen.findByText(de.migration.empty.title)).toBeTruthy();
    // The dead CTA is gone: the empty state now mounts the file-drop / discovery entry (SourceIntake).
    expect(screen.getByText(de.migration.intake.drop.hint)).toBeTruthy();
  });

  it('leads with the steps and their states, and names the journey', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: PLAN,
            steps: [STEP()],
            nextAction: { stepId: 'migstep_1', dataClass: 'contacts', state: 'mapped', verb: 'migration_preview_step' },
          }),
        },
        false,
      ),
    );
    // The step and its state lead the surface (the class is humanised, never the raw id: f5).
    expect(await screen.findByText(de.migration.dataClass.contacts)).toBeTruthy();
    expect(screen.getAllByText(de.migration.step.state.mapped).length).toBeGreaterThan(0);
    // The journey strip names every phase.
    expect(screen.getByText(de.migration.journey.discover)).toBeTruthy();
    expect(screen.getByText(de.migration.journey.verified)).toBeTruthy();
  });

  it('names the actor per step from the readiness join and leads the next line with the verb (K-20)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: PLAN,
            steps: [STEP({ state: 'mapped' })],
            nextAction: { stepId: 'migstep_1', dataClass: 'contacts', state: 'mapped', verb: 'migration_preview_step' },
          }),
          // The engine's authority on who must move each open step: a mapped non-money step is an
          // agent-safe advance, so the actor is "ein Agent", never the old hard-coded "du".
          migration_readiness: ok({
            ready: false,
            readyWithWaivers: false,
            blocking: [{ item: 'contacts', step: 'migstep_1', state: 'mapped', owner: 'ein Agent', reason: 'Schritt ist mapped' }],
            warnings: [],
            waivers: [],
            backupOnRecord: false,
          }),
        },
        false,
      ),
    );
    // The step row names the actor joined from readiness, not a hard-coded "du".
    expect(await screen.findByText(de.migration.actor.agent)).toBeTruthy();
    // The next line leads with the VERB the plan is waiting on, not the bare step state.
    expect(screen.getByText(new RegExp(de.migration.verb.migration_preview_step))).toBeTruthy();
  });

  it('renders the step data class humanised, never the raw id (f5)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP({ dataClass: 'opening_balances' })], nextAction: null }),
        },
        false,
      ),
    );
    expect(await screen.findByText(de.migration.dataClass.opening_balances)).toBeTruthy();
    expect(screen.queryByText('opening_balances')).toBeNull();
  });

  it('renders an actionable approval card for a money-path step awaiting approval', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: { ...PLAN, state: 'trial', planPhase: 'trial' },
            steps: [STEP({ dataClass: 'opening_balances', state: 'checked', lastCheckId: 'hash_1' })],
            nextAction: null,
          }),
        },
        false,
      ),
    );
    expect(await screen.findByText(de.migration.approval.pending)).toBeTruthy();
    expect(screen.getByRole('button', { name: de.migration.approval.approve })).toBeTruthy();
  });

  it('marks Probelauf current once a step is trial-loaded (K-23)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP({ state: 'trial_loaded' })], nextAction: null }),
        },
        false,
      ),
    );
    const li = (await screen.findByText(de.migration.journey.trial)).closest('li');
    expect(li?.getAttribute('aria-current')).toBe('step');
  });

  it('marks Prüfen current once every in-scope step is checked or verified (K-23)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: PLAN,
            steps: [STEP({ state: 'checked', lastCheckId: 'hash_1' }), STEP({ stepId: 'migstep_2', dataClass: 'opening_balances', state: 'verified' })],
            nextAction: null,
          }),
        },
        false,
      ),
    );
    const li = (await screen.findByText(de.migration.journey.check)).closest('li');
    expect(li?.getAttribute('aria-current')).toBe('step');
  });

  it('marks Export current while a plan has no steps yet (K-23)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [], nextAction: null }),
          migration_readiness: ok({ ready: false, readyWithWaivers: false, blocking: [], warnings: [], waivers: [], backupOnRecord: false }),
        },
        false,
      ),
    );
    const li = (await screen.findByText(de.migration.journey.export)).closest('li');
    expect(li?.getAttribute('aria-current')).toBe('step');
  });

  it('hides the journey strip on an abandoned plan instead of pretending it is at Erkunden (K-23)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [{ ...PLAN, state: 'abandoned', planPhase: null }] }),
          migration_get_plan: ok({ plan: { ...PLAN, state: 'abandoned', planPhase: null }, steps: [STEP()], nextAction: null }),
        },
        false,
      ),
    );
    expect(await screen.findByText(de.migration.dataClass.contacts)).toBeTruthy();
    expect(screen.queryByText(de.migration.journey.export)).toBeNull();
  });

  it('renders one WIRED reverse control on a diverged step, and restore-from-backup as a link, never an inert button (K-21)', async () => {
    let rolledBack: Record<string, unknown> | null = null;
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: { ...PLAN, state: 'trial', planPhase: 'trial' },
            steps: [STEP({ state: 'diverged' })],
            nextAction: null,
          }),
          migration_rollback_step: (input) => {
            rolledBack = input;
            return ok({});
          },
        },
        false,
      ),
    );
    expect(await screen.findByText(de.migration.diverged.title)).toBeTruthy();
    // The reverse control is real: clicking it reaches the engine.
    fireEvent.click(screen.getByRole('button', { name: de.migration.diverged.reverse }));
    await waitFor(() => expect(rolledBack).not.toBeNull());
    expect((rolledBack as Record<string, unknown> | null)?.stepId).toBe('migstep_1');
    // The second route is named as text with a real link to /setup (Daten & Sicherung), and there is
    // no dead restore button pretending to be a control.
    const link = screen.getByRole('link', { name: de.migration.diverged.restoreLink }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/setup');
    expect(link.parentElement?.textContent).toContain(de.migration.diverged.restoreHint);
    expect(screen.queryByRole('button', { name: de.migration.diverged.restoreLink })).toBeNull();
  });

  it('offers "Übernahme abschliessen" on a live plan and closes it behind a confirm (G18 R4)', async () => {
    let closeInput: Record<string, unknown> | null = null;
    let closed = false;
    const { findByRole, getByRole, findByText } = render(
      tree(
        {
          migration_list_plans: () => ok({ plans: [{ ...PLAN, state: closed ? 'closed' : 'live', planPhase: closed ? 'verified' : 'golive' }] }),
          migration_get_plan: () => ok({ plan: { ...PLAN, state: closed ? 'closed' : 'live', planPhase: closed ? 'verified' : 'golive' }, steps: [STEP({ state: 'verified' })], nextAction: null }),
          migration_close_plan: (input) => {
            closeInput = input;
            closed = true;
            return ok({ plan: { ...PLAN, state: 'closed', planPhase: 'verified' } });
          },
        },
        false,
      ),
    );
    // The close action is offered; clicking it reveals the confirm, not an immediate close.
    fireEvent.click(await findByRole('button', { name: de.migration.plan.close }));
    expect(await findByText(de.migration.plan.closeConfirm)).toBeTruthy();
    // Confirming calls the verb with confirmed:true, and the plan then reads as closed.
    fireEvent.click(getByRole('button', { name: de.migration.plan.close }));
    await findByText(de.migration.plan.state.closed);
    expect((closeInput as unknown as { confirmed: boolean } | null)?.confirmed).toBe(true);
  });

  it('names the blocking step by its humanised data class when a close is refused (G18 R4, P9, f18)', async () => {
    const { findByRole } = render(
      tree(
        {
          migration_list_plans: ok({ plans: [{ ...PLAN, state: 'live', planPhase: 'golive' }] }),
          migration_get_plan: ok({ plan: { ...PLAN, state: 'live', planPhase: 'golive' }, steps: [STEP({ state: 'committed' })], nextAction: null }),
          // The engine names the first offender: an opaque step id plus its data class and state.
          migration_close_plan: { status: 409, body: { ok: false, error: 'step_not_terminal', step: 'migstep_1', dataClass: 'opening_balances', state: 'committed' } },
        },
        false,
      ),
    );
    fireEvent.click(await findByRole('button', { name: de.migration.plan.close }));
    fireEvent.click(await findByRole('button', { name: de.migration.plan.close }));
    // The refusal names the blocker by its human data-class label, never the opaque migstep id.
    await waitFor(() => expect(screen.getByText(new RegExp(de.migration.dataClass.opening_balances))).toBeTruthy());
    expect(screen.queryByText(/migstep_1/)).toBeNull();
  });

  it('names a failed control by its check.kind label when a close is refused (f18)', async () => {
    const { findByRole } = render(
      tree(
        {
          migration_list_plans: ok({ plans: [{ ...PLAN, state: 'live', planPhase: 'golive' }] }),
          migration_get_plan: ok({ plan: { ...PLAN, state: 'live', planPhase: 'golive' }, steps: [STEP({ state: 'verified' })], nextAction: null }),
          migration_close_plan: { status: 409, body: { ok: false, error: 'control_failed', step: 'migstep_1', control: 'ar_control', scope: 'workspace' } },
        },
        false,
      ),
    );
    fireEvent.click(await findByRole('button', { name: de.migration.plan.close }));
    fireEvent.click(await findByRole('button', { name: de.migration.plan.close }));
    // A failed control renders through check.kind (snake -> camel), never the raw 'ar_control'.
    await waitFor(() => expect(screen.getByText(new RegExp(de.check.kind.arControl))).toBeTruthy());
    expect(screen.queryByText(/ar_control/)).toBeNull();
  });

  it('names each plan by its identity and switches between plans (K-18)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN, PLAN2] }),
          migration_get_plan: (input) => {
            const p = input.planId === 'migplan_2' ? PLAN2 : PLAN;
            return ok({ plan: p, steps: [STEP()], nextAction: null });
          },
        },
        false,
      ),
    );
    // The identity line names the active plan (source + Stichtag, DD.MM.YYYY).
    const id1 = de.migration.plan.identity.replace('{source}', PLAN.sourceSystem).replace('{date}', '01.01.2026');
    expect((await screen.findAllByText(id1)).length).toBeGreaterThan(0);
    // With more than one plan a selector is offered; switching to the other loads it by its identity.
    const select = screen.getByLabelText(de.migration.plan.selectorLabel);
    fireEvent.click(select);
    fireEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'migplan_2')!);
    const id2 = de.migration.plan.identity.replace('{source}', PLAN2.sourceSystem).replace('{date}', '30.06.2025');
    await waitFor(() => expect(screen.getAllByText(id2).length).toBeGreaterThan(0));
  });

  it('F-09: a plan ahead of its Stichtag renders as prepared, with the productive date named', async () => {
    const prepared = { ...PLAN, cutoverDate: '2026-10-01', cutoverPending: true };
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [prepared] }),
          migration_get_plan: ok({ plan: prepared, steps: [STEP()], nextAction: null }),
        },
        false,
      ),
    );
    const identity = de.migration.plan.identity.replace('{source}', PLAN.sourceSystem).replace('{date}', '01.10.2026');
    const line = de.migration.plan.prepared.replace('{identity}', identity).replace('{date}', '01.10.2026');
    expect((await screen.findAllByText(line)).length).toBeGreaterThan(0);
  });

  it('abandons a plan behind a confirm, calling the engine with confirmed:true (K-18)', async () => {
    let abandonInput: Record<string, unknown> | null = null;
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP()], nextAction: null }),
          migration_abandon_plan: (input) => {
            abandonInput = input;
            return ok({ testmandantDiscarded: false, belegeRetained: [] });
          },
        },
        false,
      ),
    );
    // Abandon is offered; clicking it reveals the confirm, not an immediate abandon.
    fireEvent.click(await screen.findByRole('button', { name: de.migration.plan.abandon }));
    expect(await screen.findByText(de.migration.plan.abandonConfirm)).toBeTruthy();
    // Confirming reaches the engine with confirmed:true (the destructive discard is gated).
    fireEvent.click(screen.getByRole('button', { name: de.migration.plan.abandon }));
    await waitFor(() => expect(abandonInput).not.toBeNull());
    expect((abandonInput as unknown as { confirmed: boolean } | null)?.confirmed).toBe(true);
  });

  it('f7: a refused abandon NAMES the blocker instead of reloading in silence (role="alert")', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP()], nextAction: null }),
          migration_abandon_plan: { status: 200, body: { ok: false, error: 'already_live' } },
        },
        false,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: de.migration.plan.abandon }));
    await screen.findByText(de.migration.plan.abandonConfirm);
    fireEvent.click(screen.getByRole('button', { name: de.migration.plan.abandon }));
    // The failure is named (the confirm stays open so the operator can retry or cancel).
    expect(await screen.findByText(de.migration.plan.abandonBlocked.replace('{blocker}', 'already_live'))).toBeTruthy();
  });

  it('f7: a refused approval NAMES the failure on the step row instead of reloading in silence', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: { ...PLAN, state: 'trial', planPhase: 'trial' },
            steps: [STEP({ dataClass: 'opening_balances', state: 'checked', lastCheckId: 'hash_1' })],
            nextAction: null,
          }),
          migration_record_approval: { status: 200, body: { ok: false, error: 'stale_check_hash' } },
        },
        false,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: de.migration.approval.approve }));
    expect(await screen.findByText(de.migration.approval.error)).toBeTruthy();
  });

  it('f7: a refused rollback NAMES the failure on the diverged row, so the sole recovery is not a silent dead button', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({
            plan: { ...PLAN, state: 'trial', planPhase: 'trial' },
            steps: [STEP({ state: 'diverged' })],
            nextAction: null,
          }),
          migration_rollback_step: { status: 200, body: { ok: false, error: 'not_reversible' } },
        },
        false,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: de.migration.diverged.reverse }));
    expect(await screen.findByText(de.migration.diverged.reverseError)).toBeTruthy();
  });

  it('does not offer abandon on an already-abandoned plan (K-18)', async () => {
    render(
      tree(
        {
          migration_list_plans: ok({ plans: [{ ...PLAN, state: 'abandoned', planPhase: null }] }),
          migration_get_plan: ok({ plan: { ...PLAN, state: 'abandoned', planPhase: null }, steps: [STEP()], nextAction: null }),
        },
        false,
      ),
    );
    await screen.findByText(de.migration.dataClass.contacts);
    expect(screen.queryByRole('button', { name: de.migration.plan.abandon })).toBeNull();
  });

  it('renders A24 padlock naming the missing right when the actor lacks manage_import', async () => {
    render(
      tree(
        {
          whoami: whoamiNoImport,
          migration_list_plans: ok({ plans: [] }),
        },
        true,
      ),
    );
    expect(await screen.findByText(de.migration.denied)).toBeTruthy();
  });

  it('renders the loaded plan with manage_import granted', async () => {
    render(
      tree(
        {
          whoami: whoamiOwner,
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP()], nextAction: null }),
        },
        true,
      ),
    );
    expect(await screen.findByText(de.migration.dataClass.contacts)).toBeTruthy();
  });

  // G12: the shared WorkspaceModeBanner and the Testmandant card. A verified step makes the check
  // clean, so the primary action is Produktiv setzen behind a type-to-confirm; discard sits in an
  // overflow, never as a peer of the irreversible primary action.
  it('renders the WorkspaceModeBanner with a type-to-confirm and discard in an overflow', async () => {
    render(
      tree(
        {
          whoami: whoamiOwner,
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP({ state: 'verified' })], nextAction: null }),
          migration_get_testmandant: ok({ workspaceId: 'ws_t', kind: 'sandbox' }),
          get_company_profile: ok({ profile: { name: 'Muster GmbH' } }),
        },
        false,
      ),
    );
    // The banner is a role="status" strip naming that these are not the real books.
    expect(await screen.findByText(de.migration.testmandant.banner.title)).toBeTruthy();
    // The type-to-confirm renders its visible persistent label and the irreversible copy.
    expect(screen.getByLabelText(de.migration.testmandant.confirmLabel)).toBeTruthy();
    expect(screen.getByText(de.migration.testmandant.irreversible)).toBeTruthy();
    // Discard is inside the overflow disclosure, not a top-level peer button.
    const overflow = screen.getByText(de.migration.testmandant.more).closest('details');
    expect(overflow).toBeTruthy();
    expect(overflow?.querySelector('.testmandant-discard')).toBeTruthy();
  });

  it('offers to create a Testmandant when none exists yet', async () => {
    render(
      tree(
        {
          whoami: whoamiOwner,
          migration_list_plans: ok({ plans: [PLAN] }),
          migration_get_plan: ok({ plan: PLAN, steps: [STEP()], nextAction: null }),
          migration_get_testmandant: ok({ none: true }),
        },
        false,
      ),
    );
    expect(await screen.findByText(de.migration.testmandant.empty.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: de.migration.testmandant.create })).toBeTruthy();
  });
});
