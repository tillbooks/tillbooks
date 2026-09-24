/**
 * The Automatisierungen surface: the human face of the only subsystem that writes unattended.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT, because this surface has two specific ways of being wrong that a
 * render test usually cannot see.
 *
 * FIRST, `useCapabilities()` FAILS OPEN by design (`src/lib/capabilities.ts`): with no provider in
 * the tree, or before `whoami` answers, `can()` returns true and every control renders enabled. That
 * default is right for the product and it is a trap for a test, because a component test that forgets
 * the provider measures the permissive default and calls it a permission test. So every block below
 * that makes a claim about a GATE mounts a real `CapabilitiesProvider` over a transport that answers
 * `whoami`, and `withCapabilities` is the only render helper used for those.
 *
 * SECOND, AND SPECIFIC TO G01: STOPPEN IS THE ONE CONTROL THAT MUST NEVER BE DISABLED. The engine
 * leaves `disable_automation_rule` ungated on the argument that a stop button requiring a permission
 * is not a stop button, and a `viewer` is exactly the person watching a rule misbehave. If this
 * screen greys it out, the engine's decision is undone in the only place a person can act on it, and
 * nothing else in the build would notice. That claim is asserted from a real viewer, against a real
 * provider, alongside the controls that MUST be disabled for the same person: an assertion that only
 * checked the stop button would pass over a screen that disables nothing at all.
 *
 * COPY IS ASSERTED THROUGH THE CATALOGUE, never as a literal typed here. A literal is a second copy
 * of a string that then drifts from the shipped one, and the de-CH register conversion to `du` (D56,
 * which reverses D49) has just rewritten them again.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Automations from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

/** The catalogue `list_automation_rules` rides with the list, read off the live registries. */
const CATALOGUE = {
  events: [
    { event: 'invoice.issued', entityKind: 'document', emittedBy: 'issue_invoice', schedule: false },
    { event: 'journal.posted', entityKind: 'journal_entry', emittedBy: 'post_entry', schedule: false },
    { event: 'schedule.monthly', entityKind: null, emittedBy: null, schedule: true },
  ],
  actions: ['create_document', 'post_entry', 'send_invoice'],
  ops: ['eq', 'ne', 'gt', 'in', 'exists'],
};

const RULE = (over: Record<string, unknown> = {}) => ({
  ruleId: 'arule_1',
  name: 'Mahnung buchen',
  trigger: { event: 'invoice.issued', entityKind: 'document', schedule: false },
  condition: null,
  action: { tool: 'post_entry', inputTemplate: {} },
  enabled: true,
  archived: false,
  createdBy: 'studio',
  lastFiredAt: '2026-03-02T00:00:00.000Z',
  ...over,
});

const RUN = (over: Record<string, unknown> = {}) => ({
  runId: 'arun_1',
  ruleId: 'arule_1',
  ruleName: 'Mahnung buchen',
  event: 'invoice.issued',
  status: 'ok',
  actionTool: 'post_entry',
  errorCode: null,
  actor: 'studio',
  startedAt: '2026-03-02T00:00:00.000Z',
  ...over,
});

const ALL_CAPABILITIES = [
  'post',
  'pay',
  'issue',
  'send',
  'read_books',
  'read_sales',
  'read_master_data',
  'read_automations',
  'manage_automations',
];

const whoamiOwner = ok({
  actor: 'studio',
  role: 'owner',
  isMember: true,
  provisioned: true,
  capabilities: ALL_CAPABILITIES,
});

/**
 * A REAL viewer: every read domain but `read_members`, and no write at all.
 *
 * `read_automations` is present deliberately. G01 leaves the stop button ungated so whoever is
 * watching can halt a rule, and a rule can only be halted by its id, whose only source is
 * `list_automation_rules`. A viewer without that read would hold a stop button it could never aim.
 */
const whoamiViewer = ok({
  actor: 'agent',
  role: 'viewer',
  isMember: true,
  provisioned: true,
  capabilities: ['read_books', 'read_sales', 'read_master_data', 'read_vat', 'read_automations'],
});

const baseCanned = (): Canned => ({
  whoami: whoamiOwner,
  list_automation_rules: ok({ rules: [RULE()], catalogue: CATALOGUE }),
  list_automation_runs: ok({ runs: [RUN()] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Automations />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

/** Render WITHOUT a capabilities provider: only for states where permissions are not the subject. */
const renderAutomations = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, false));

/** Render WITH the real provider, so `can()` answers from the canned `whoami` and not the default. */
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, true));

/** Open the Verlauf tab, which is where every run assertion lives. */
async function openVerlauf(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: de.automation.runs.title }));
}

/**
 * The VISIBLE tab panel. The shared `Tabs` primitive keeps both panels mounted and marks the
 * inactive one `hidden`, so a role query (which drops hidden nodes from the tree) returns exactly the
 * active panel. Scoping name lookups to it is why "Mahnung buchen", which is both a rule name and its
 * run's `ruleName`, resolves to the row the assertion is about rather than matching in both tables.
 */
const activePanel = () => screen.getByRole('tabpanel');

/** Wait for the loaded surface, then return the "Mahnung buchen" row inside the active tab panel. */
async function findMahnungRow(): Promise<HTMLElement> {
  const panel = await screen.findByRole('tabpanel');
  const cell = await within(panel).findByText('Mahnung buchen');
  const row = cell.closest('tr');
  if (row === null) throw new Error('no row for Mahnung buchen');
  return row;
}

describe('Automations, the load states', () => {
  it('shows a loading skeleton while the rule list is in flight', async () => {
    // The wait goes BEFORE the assertion: every surface initialises `loading` to true, so a skeleton
    // is the DEFAULT and not evidence that a read started.
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Automations />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_automation_rules');
    // K-34: ONE shared skeleton region in the rows' height, announcing itself as busy.
    const skeletons = screen.getAllByRole('status');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
    for (const node of skeletons) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the error banner when the rule list is refused', async () => {
    renderAutomations({ ...baseCanned(), list_automation_rules: reject('permission_denied') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('offers the empty state with no workspace open', async () => {
    renderAutomations(baseCanned(), null);
    expect(await screen.findByText(de.automation.noWorkspaceHint)).toBeInTheDocument();
  });

  it('offers the empty state when the workspace has no rules at all', async () => {
    renderAutomations({ ...baseCanned(), list_automation_rules: ok({ rules: [], catalogue: CATALOGUE }) });
    expect(await screen.findByText(de.automation.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.automation.empty.hint)).toBeInTheDocument();
  });
});

describe('Automations, the rule list', () => {
  it('renders a rule with its trigger, its action and its state', async () => {
    renderAutomations(baseCanned());
    const row = await findMahnungRow();
    // K-38: the trigger and the verb read as words, never the raw engine key.
    expect(within(row).getByText('Invoice issued')).toBeInTheDocument();
    expect(within(row).getByText('Buchung erfassen')).toBeInTheDocument();
    expect(within(row).queryByText('post_entry')).toBeNull();
    expect(within(row).getByText(de.automation.status.enabled, { exact: false })).toBeInTheDocument();
  });

  it('says so in words when a rule has never fired', async () => {
    renderAutomations({
      ...baseCanned(),
      list_automation_rules: ok({ rules: [RULE({ lastFiredAt: null })], catalogue: CATALOGUE }),
    });
    expect(await screen.findByText(de.automation.neverFired)).toBeInTheDocument();
  });

  it('keeps an ARCHIVED rule visible, so its run history has a name', async () => {
    // A run row survives its rule's archival (§H-AUDIT). A screen that hid the rule would leave the
    // Verlauf tab full of ids nobody can resolve.
    renderAutomations({
      ...baseCanned(),
      list_automation_rules: ok({
        rules: [RULE({ ruleId: 'arule_2', name: 'Alte Regel', enabled: false, archived: true })],
        catalogue: CATALOGUE,
      }),
    });
    const row = (await screen.findByText('Alte Regel')).closest('tr');
    expect(within(row!).getByText(de.automation.status.archived, { exact: false })).toBeInTheDocument();
    // An archived rule offers no controls at all: it cannot be enabled, stopped or archived again.
    expect(within(row!).queryByRole('button')).toBeNull();
  });

  it('asks for archived rules explicitly, which is the only way that row can appear', async () => {
    let asked: Record<string, unknown> | null = null;
    renderAutomations({
      ...baseCanned(),
      list_automation_rules: (input) => {
        asked = input;
        return ok({ rules: [RULE()], catalogue: CATALOGUE });
      },
    });
    await findMahnungRow();
    expect(asked).not.toBeNull();
    expect(asked!.includeArchived).toBe(true);
  });
});

describe('Automations, the pickers are fed by the ENGINE', () => {
  it('offers exactly the trigger events and action verbs the catalogue carried', async () => {
    // A hand-copied list in the Studio would drift the first time a capability registers an event,
    // and the drift shows up as a rejection the operator cannot explain.
    const user = userEvent.setup();
    withCapabilities(baseCanned());
    await user.click(await screen.findByRole('button', { name: de.automation.rules.create }));

    // Options portal to <body> and carry their value on `data-value`; open each picker to read them.
    // Opening the second picker closes the first (its outside-pointer handler fires on the click).
    await user.click(screen.getByLabelText(de.automation.form.trigger));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual(
      CATALOGUE.events.map((e) => e.event),
    );

    await user.click(screen.getByLabelText(de.automation.form.action));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual([...CATALOGUE.actions]);
  });

  it('renders the engine own rejection code on the form that owns the input', async () => {
    const user = userEvent.setup();
    withCapabilities({ ...baseCanned(), create_automation_rule: reject('self_triggering') });
    await user.click(await screen.findByRole('button', { name: de.automation.rules.create }));
    await user.type(screen.getByLabelText(de.automation.form.name), 'Schleife');
    await user.click(screen.getByRole('button', { name: de.automation.form.save }));

    // The MAPPING from an engine code to its sentence, asserted through the catalogue.
    expect(await screen.findByText(de.automation.error.self_triggering)).toBeInTheDocument();
  });

  it('catches a template that is not JSON in the form, without asking the engine', async () => {
    const user = userEvent.setup();
    let asked = 0;
    withCapabilities({
      ...baseCanned(),
      create_automation_rule: () => {
        asked += 1;
        return ok({ rule: RULE() });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.automation.rules.create }));
    await user.type(screen.getByLabelText(de.automation.form.name), 'Kaputt');
    await user.clear(screen.getByLabelText(de.automation.form.template));
    await user.type(screen.getByLabelText(de.automation.form.template), '{{nicht json');
    await user.click(screen.getByRole('button', { name: de.automation.form.save }));

    expect(await screen.findByText(de.automation.error.invalid_action_input)).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

/** Open the Mahnung row's one overflow (K-21) and return the named item. */
async function openRowMenu(item: string, user = userEvent.setup()): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: de.automation.rowActions.replace('{name}', 'Mahnung buchen') });
  await user.click(trigger);
  return screen.findByRole('menuitem', { name: item });
}

describe('Automations, the off switch', () => {
  it('NEVER disables Stoppen for a viewer, and disables every other write control', async () => {
    // The load-bearing one. Both halves are here on purpose: an assertion that only checked the stop
    // button would pass over a screen that disables nothing at all.
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });

    await waitFor(() => expect(screen.getByRole('button', { name: de.automation.rules.create })).toBeDisabled());
    const stop = await openRowMenu(de.automation.action.disable);
    expect(stop).not.toHaveAttribute('aria-disabled', 'true');
    // A menu item is disabled the ARIA way (it stays focusable in the menu, never a dead stop).
    expect(screen.getByRole('menuitem', { name: de.automation.action.archive })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: de.automation.tick.now })).toBeDisabled();
  });

  it('disables Aktivieren for a viewer while Stoppen stays live on a STOPPED rule', async () => {
    // The asymmetry, on the row where both controls could appear: anyone may stop, only
    // `manage_automations` may start.
    withCapabilities({
      ...baseCanned(),
      whoami: whoamiViewer,
      list_automation_rules: ok({ rules: [RULE({ enabled: false })], catalogue: CATALOGUE }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: de.automation.rules.create })).toBeDisabled());
    const enable = await openRowMenu(de.automation.action.enable);
    expect(enable).toHaveAttribute('aria-disabled', 'true');
    // And the stop item is correctly absent on an already-stopped rule rather than merely enabled.
    expect(screen.queryByRole('menuitem', { name: de.automation.action.disable })).toBeNull();
  });

  it('enables every control for an owner, so the gate above is measuring the ROLE', async () => {
    withCapabilities(baseCanned());
    await waitFor(() => expect(screen.getByRole('button', { name: de.automation.rules.create })).toBeEnabled());
    const stop = await openRowMenu(de.automation.action.disable);
    expect(stop).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: de.automation.action.archive })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('really calls disable_automation_rule with the rule id, and reloads afterwards', async () => {
    const user = userEvent.setup();
    const calls: Record<string, unknown>[] = [];
    withCapabilities({
      ...baseCanned(),
      whoami: whoamiViewer,
      disable_automation_rule: (input) => {
        calls.push(input);
        return ok({ rule: RULE({ enabled: false }) });
      },
    });
    await findMahnungRow();
    const stop = await openRowMenu(de.automation.action.disable, user);
    await user.click(stop);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ workspaceId: 'ws_test', ruleId: 'arule_1' });
    expect(await screen.findByText(de.automation.rules.toggled)).toBeInTheDocument();
  });
});

describe('Automations, the Verlauf', () => {
  it('renders a firing with its rule, its outcome and the identity it ran as', async () => {
    const user = userEvent.setup();
    renderAutomations(baseCanned());
    await findMahnungRow();
    await openVerlauf(user);

    const row = within(activePanel()).getByText('Mahnung buchen').closest('tr');
    expect(within(row!).getByText(de.automation.runStatus.ok, { exact: false })).toBeInTheDocument();
    // WHOSE rights it ran with is the question this whole screen exists to answer, named as a seat
    // (K-38), never the raw id.
    expect(within(row!).getByText('Studio auf diesem Gerät')).toBeInTheDocument();
  });

  it("translates the TARGET verb's own rejection code, not an automation-flavoured message", async () => {
    const user = userEvent.setup();
    renderAutomations({
      ...baseCanned(),
      list_automation_runs: ok({ runs: [RUN({ status: 'failed', errorCode: 'permission_denied' })] }),
    });
    await findMahnungRow();
    await openVerlauf(user);

    expect(screen.getByText(de.automation.runStatus.failed, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(de.automation.error.permission_denied, { exact: false })).toBeInTheDocument();
  });

  it('says a SUPPRESSED firing was a loop guard, and never calls it a failure', async () => {
    // An operator who reads "Fehlgeschlagen" on a suppression goes looking for a bug in their rule
    // that is not there. The two statuses are a different fact and must read as one.
    const user = userEvent.setup();
    renderAutomations({
      ...baseCanned(),
      list_automation_runs: ok({
        runs: [
          RUN({ runId: 'arun_1', status: 'suppressed_loop' }),
          RUN({ runId: 'arun_2', status: 'suppressed_depth' }),
        ],
      }),
    });
    await findMahnungRow();
    await openVerlauf(user);

    expect(screen.getByText(de.automation.runStatus.suppressed_loop, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(de.automation.runStatus.suppressed_depth, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(de.automation.runStatus.failed, { exact: false })).toBeNull();
    // And the three are genuinely different sentences, or the assertion above proves nothing.
    expect(
      new Set([
        de.automation.runStatus.suppressed_loop,
        de.automation.runStatus.suppressed_depth,
        de.automation.runStatus.failed,
      ]).size,
    ).toBe(3);
  });

  it('offers the Verlauf to a VIEWER, because it is the half you reach for after something went wrong', async () => {
    // Gating the history behind the capability that caused the problem would be exactly backwards.
    const user = userEvent.setup();
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });
    await findMahnungRow();
    await openVerlauf(user);
    // Scoped to the run ROW. A bare substring match on "Ausgeführt" also hits the column heading
    // "Ausgeführt als", which is the probe over-matching rather than a second run appearing.
    const row = within(activePanel()).getByText('Mahnung buchen').closest('tr');
    expect(within(row!).getByText(de.automation.runStatus.ok, { exact: false })).toBeInTheDocument();
  });

  it('offers its own empty state rather than the rule one', async () => {
    const user = userEvent.setup();
    renderAutomations({ ...baseCanned(), list_automation_runs: ok({ runs: [] }) });
    await screen.findByText('Mahnung buchen');
    await openVerlauf(user);
    expect(screen.getByText(de.automation.emptyRuns.title)).toBeInTheDocument();
  });
});

describe('Automations, accessibility', () => {
  it('has no axe violations on the rule list', async () => {
    const { container } = withCapabilities(baseCanned());
    await findMahnungRow();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Verlauf', async () => {
    const user = userEvent.setup();
    const { container } = withCapabilities(baseCanned());
    await findMahnungRow();
    await openVerlauf(user);
    expect(await axe(container)).toHaveNoViolations();
  });
});
