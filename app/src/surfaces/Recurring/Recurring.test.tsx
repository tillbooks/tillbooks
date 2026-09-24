/**
 * The Serien surface: A12's human face over the recurring engine.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT, copied deliberately from the Automatisierungen suite because the
 * traps are identical. `useCapabilities()` FAILS OPEN by design, so every block that makes a claim
 * about a GATE mounts a real `CapabilitiesProvider` over a transport that answers `whoami`; a test
 * without the provider measures the permissive default and calls it a permission test. And a loading
 * assertion waits for the read to have STARTED before believing a skeleton, because every surface
 * initialises loading to true and the skeleton alone is the default, not evidence.
 *
 * COPY IS ASSERTED THROUGH THE CATALOGUE, never as a literal typed here, so the D56 du-register
 * conversion and every future rewording keep this suite green without edits.
 *
 * MONEY ON THE WIRE IS ASSERTED EXACTLY: the editor parses CHF decimals into integer Rappen and
 * quantities into thousandths, and the create test reads the actual `create_recurring_schedule`
 * input off the fake transport rather than trusting the form to have meant well (P2).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import { allowConsole } from '../../test-console';
import Recurring from './index';
import { parsePriceMinor, parseQuantityMilli } from './RecurringEditor';
import de from './messages.de-CH.json';
import en from './messages.en.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/**
 * Open a migrated shared <Select> combobox by its accessible name and click the option carrying
 * `value`. The listbox is portaled to <body>, so the option is read from `screen` by its data-value.
 */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  comboName: string,
  value: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: comboName }));
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === value);
  if (option === undefined) throw new Error(`no option with data-value ${value}`);
  await user.click(option);
}

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const SCHEDULE = (over: Record<string, unknown> = {}) => ({
  id: 'rsched_1',
  name: 'Beratung Muster AG',
  contactId: 'contact_1',
  contactName: 'Muster AG',
  lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 200000 }],
  currency: null,
  notes: null,
  dueDays: 30,
  interval: 'monthly',
  customDays: null,
  anchorDate: '2026-08-01',
  nextRunDate: '2026-09-01',
  endDate: null,
  maxOccurrences: null,
  occurrencesDone: 1,
  autoIssue: false,
  status: 'active',
  lastOutcome: 'drafted',
  lastError: null,
  ...over,
});

/** The active codes the editor's per-line picker offers (C15), as `vat_codes` returns them. */
const TAX_CODES = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true },
  { code: 'UST26', kind: 'output', rateBp: 260, formLine: '312', label: 'Umsatzsteuer 2.6%', active: true },
];

const RUN = (over: Record<string, unknown> = {}) => ({
  id: 'rrun_1',
  periodKey: '2026-08-01',
  documentId: 'doc_1',
  documentNumber: 'RE-2026-0001',
  documentStatus: 'issued',
  outcome: 'issued',
  error: null,
  ranAt: '2026-08-01T06:00:00.000Z',
  ...over,
});

const whoamiOwner = ok({
  actor: 'studio',
  role: 'owner',
  isMember: true,
  provisioned: true,
  capabilities: ['post', 'pay', 'issue', 'send', 'read_books', 'read_sales', 'read_master_data'],
});

/** A REAL viewer: the read domains and no write, so every A12 control must be pre-disabled. */
const whoamiViewer = ok({
  actor: 'agent',
  role: 'viewer',
  isMember: true,
  provisioned: true,
  capabilities: ['read_books', 'read_sales', 'read_master_data'],
});

const baseCanned = (): Canned => ({
  whoami: whoamiOwner,
  list_recurring_schedules: ok({ schedules: [SCHEDULE()] }),
  list_saved_views: ok({ savedViews: [] }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Muster AG' }] }),
  vat_codes: ok({ taxCodes: TAX_CODES }),
  get_recurring_schedule: ok({ schedule: SCHEDULE(), runs: [RUN()] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Recurring />
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
const renderRecurring = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, false));

/** Render WITH the real provider, so `can()` answers from the canned `whoami` and not the default. */
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, true));

// --- The five states ---------------------------------------------------------------------------

describe('Recurring, the load states', () => {
  it('shows loading skeletons while the schedule list is in flight, and only once it started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Recurring />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_recurring_schedules');
    const skeletons = screen.getAllByRole('status');
    expect(skeletons.length).toBeGreaterThan(1);
    for (const node of skeletons) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the error banner when the schedule list is refused', async () => {
    renderRecurring({ ...baseCanned(), list_recurring_schedules: reject('permission_denied') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('guides to a workspace when none is open', async () => {
    renderRecurring(baseCanned(), null);
    expect(await screen.findByText(de.recurring.noWorkspaceHint)).toBeInTheDocument();
  });

  it('states what the surface is for when there are no schedules, with the CTA enabled', async () => {
    renderRecurring({ ...baseCanned(), list_recurring_schedules: ok({ schedules: [] }) });
    expect(await screen.findByText(de.recurring.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.recurring.empty.hint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.recurring.new })).toBeEnabled();
  });

  it('renders a schedule row with its status as glyph AND text, the cadence, and the amount', async () => {
    renderRecurring(baseCanned());
    expect(await screen.findByText('Beratung Muster AG')).toBeInTheDocument();
    expect(screen.getByText('Muster AG')).toBeInTheDocument();
    expect(screen.getByText(de.recurring.interval.monthly)).toBeInTheDocument();
    expect(screen.getByText(de.recurring.status.active)).toBeInTheDocument();
    // The template total, formatted by the house formatter: 1 x CHF 2'000.00.
    expect(screen.getByText("CHF 2'000.00")).toBeInTheDocument();
    // The next-run date renders de-CH.
    expect(screen.getByText('01.09.2026')).toBeInTheDocument();
  });

  it('has no obvious accessibility violations on the populated list', async () => {
    const { container } = renderRecurring(baseCanned());
    await screen.findByText('Beratung Muster AG');
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- Permission gating (A24, the F5 padlock idiom) ---------------------------------------------

describe('Recurring, the permission gate', () => {
  it('pre-disables every write control for a viewer and states the reason beside them', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });
    await screen.findByText('Beratung Muster AG');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: de.recurring.new })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: de.recurring.tick.now })).toBeDisabled();
    expect(screen.getByRole('button', { name: de.recurring.action.edit })).toBeDisabled();
    expect(screen.getByRole('button', { name: de.recurring.action.pause })).toBeDisabled();
    expect(screen.getByRole('button', { name: de.recurring.action.end })).toBeDisabled();
    // The reason is stated in prose beside the controls, never hung on a hover-only title.
    expect(screen.getByText(de.recurring.needsPermission)).toBeInTheDocument();
  });

  it('leaves the controls enabled for an owner holding issue', async () => {
    withCapabilities(baseCanned());
    await screen.findByText('Beratung Muster AG');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: de.recurring.new })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: de.recurring.action.pause })).toBeEnabled();
    expect(screen.queryByText(de.recurring.needsPermission)).not.toBeInTheDocument();
  });
});

// --- The editor and the exact wire shape --------------------------------------------------------

describe('Recurring, creating a schedule', () => {
  it('parses money and quantity exactly, never through a float', () => {
    expect(parsePriceMinor("1'234.55")).toBe(123455);
    expect(parsePriceMinor('2000')).toBe(200000);
    expect(parsePriceMinor('0.05')).toBe(5);
    expect(parsePriceMinor('')).toBeNull();
    expect(parsePriceMinor('12,50')).toBeNull();
    expect(parseQuantityMilli('10.5')).toBe(10500);
    expect(parseQuantityMilli('1')).toBe(1000);
    expect(parseQuantityMilli('')).toBeNull();
  });

  it('sends create_recurring_schedule with Rappen, thousandths, the cadence and a key', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [] }),
      create_recurring_schedule: (input) => {
        sent.push(input);
        return ok({ schedule: SCHEDULE() });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.new }));
    await chooseOption(user, de.recurring.form.customer, 'contact_1');
    await user.type(screen.getByLabelText(de.recurring.form.lineDescription), 'Beratung');
    await user.type(screen.getByLabelText(de.recurring.form.linePrice), "2'000.00");
    await user.clear(screen.getByLabelText(de.recurring.form.anchorDate));
    await user.type(screen.getByLabelText(de.recurring.form.anchorDate), '2026-08-01');
    await user.click(screen.getByRole('button', { name: de.recurring.form.save }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const input = sent[0] as Record<string, unknown>;
    expect(input.contactId).toBe('contact_1');
    expect(input.interval).toBe('monthly');
    expect(input.anchorDate).toBe('2026-08-01');
    expect(input.lines).toEqual([{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 200000 }]);
    expect(typeof input.idempotencyKey).toBe('string');
    expect((input.idempotencyKey as string).length).toBeGreaterThan(0);
    // The success is announced politely and the editor closes.
    expect(await screen.findByText(de.recurring.saved)).toBeInTheDocument();
  });

  it('F-03 (J3.8): a new series defaults its first invoice to the next first of month and its position to the name', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [] }),
      create_recurring_schedule: (input) => {
        sent.push(input);
        return ok({ schedule: SCHEDULE() });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.new }));
    const anchor = screen.getByLabelText(de.recurring.form.anchorDate) as HTMLInputElement;
    // Defaulted, not empty: the first of the month after today.
    expect(anchor.value).toMatch(/^\d{4}-\d{2}-01$/);
    expect(anchor.value > new Date().toISOString().slice(0, 10)).toBe(true);
    await user.type(screen.getByLabelText(de.recurring.form.name), 'Retainer Hotel Blaustern');
    await chooseOption(user, de.recurring.form.customer, 'contact_1');
    await user.type(screen.getByLabelText(de.recurring.form.linePrice), '1200');
    await user.click(screen.getByRole('button', { name: de.recurring.form.save }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const input = sent[0] as Record<string, unknown>;
    expect(input.name).toBe('Retainer Hotel Blaustern');
    expect(input.anchorDate).toBe(anchor.value);
    // The description was never typed a second time: the position carries the series name.
    expect(input.lines).toEqual([{ description: 'Retainer Hotel Blaustern', quantityMilli: 1000, unitPriceMinor: 120000 }]);
  });

  it('renders needs_customer inline on the customer field, never as a toast', async () => {
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [] }),
      create_recurring_schedule: reject('needs_customer'),
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.new }));
    await user.type(screen.getByLabelText(de.recurring.form.linePrice), '100');
    await user.clear(screen.getByLabelText(de.recurring.form.anchorDate));
    await user.type(screen.getByLabelText(de.recurring.form.anchorDate), '2026-08-01');
    await user.click(screen.getByRole('button', { name: de.recurring.form.save }));
    expect(await screen.findByText(de.recurring.error.needs_customer)).toBeInTheDocument();
    // The editor stays open for the correction.
    expect(screen.getByRole('button', { name: de.recurring.form.save })).toBeInTheDocument();
  });

  it('offers the A06 tax-code picker per position and sends the chosen code (critic C15)', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [] }),
      create_recurring_schedule: (input) => {
        sent.push(input);
        return ok({ schedule: SCHEDULE() });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.new }));
    await chooseOption(user, de.recurring.form.customer, 'contact_1');
    await user.type(screen.getByLabelText(de.recurring.form.linePrice), '2000');
    // The picker is the SAME A06 control the Belege editor mounts, addressed by its own label.
    await chooseOption(user, `${de.recurring.form.lineVat} 1`, 'UST81');
    await user.clear(screen.getByLabelText(de.recurring.form.anchorDate));
    await user.type(screen.getByLabelText(de.recurring.form.anchorDate), '2026-08-01');
    await user.click(screen.getByRole('button', { name: de.recurring.form.save }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { lines: unknown[] }).lines).toEqual([
      { quantityMilli: 1000, unitPriceMinor: 200000, taxCode: 'UST81' },
    ]);
  });

  it('catches a malformed price on the field before anything reaches the wire', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [] }),
      create_recurring_schedule: (input) => {
        sent.push(input);
        return ok({ schedule: SCHEDULE() });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.new }));
    await chooseOption(user, de.recurring.form.customer, 'contact_1');
    await user.type(screen.getByLabelText(de.recurring.form.linePrice), 'abc');
    await user.clear(screen.getByLabelText(de.recurring.form.anchorDate));
    await user.type(screen.getByLabelText(de.recurring.form.anchorDate), '2026-08-01');
    await user.click(screen.getByRole('button', { name: de.recurring.form.save }));
    expect(await screen.findByText(de.recurring.error.needs_positions)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});

// --- The controls and the history ---------------------------------------------------------------

describe('Recurring, controls and provenance', () => {
  it('pauses a schedule and announces the new state', async () => {
    const user = userEvent.setup();
    const called: string[] = [];
    renderRecurring({
      ...baseCanned(),
      pause_recurring_schedule: (input) => {
        called.push(String(input.scheduleId));
        return ok({ schedule: SCHEDULE({ status: 'paused' }) });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.action.pause }));
    await waitFor(() => expect(called).toEqual(['rsched_1']));
    expect(await screen.findByText(de.recurring.paused)).toBeInTheDocument();
  });

  it('never puts a raw contact id on screen when the customer is gone', async () => {
    // `contactName` is null once the contact is removed or anonymised. The id underneath it is a
    // machine string an operator can neither read nor act on, and it used to be the fallback in two
    // places: the row's name and the customer column.
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({ schedules: [SCHEDULE({ name: null, contactName: null })] }),
    });
    expect(await screen.findAllByText(de.recurring.customerGone)).toHaveLength(2);
    expect(screen.queryByText(/^ct_/)).toBeNull();
  });

  it('runs the tick and reports how many invoices were generated', async () => {
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      run_due_recurring: ok({ asOf: '2026-09-01', generated: 2, results: [] }),
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.tick.now }));
    expect(await screen.findByText(de.recurring.tick.done.replace('{n}', '2'))).toBeInTheDocument();
  });

  it('reports ONE generated invoice without the plural sentence a {n} template would produce', async () => {
    // `t()` has no plural rule, and one is by far the commonest count: the old copy read
    // "Erstellt wurden 1 Rechnungen" on the single most frequent outcome of this button.
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      run_due_recurring: ok({ asOf: '2026-09-01', generated: 1, results: [] }),
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.tick.now }));
    const feedback = await screen.findByText(de.recurring.tick.done.replace('{n}', '1'));
    expect(feedback).toBeInTheDocument();
    expect(feedback.textContent).not.toMatch(/1 Rechnungen/);
  });

  it('answers the question that was asked when nothing was due, rather than reporting a zero', async () => {
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      run_due_recurring: ok({ asOf: '2026-09-01', generated: 0, results: [] }),
    });
    await user.click(await screen.findByRole('button', { name: de.recurring.tick.now }));
    expect(await screen.findByText(de.recurring.tick.nothingDue)).toBeInTheDocument();
  });

  it('opens the run history from the schedule name and links the generated document', async () => {
    const user = userEvent.setup();
    renderRecurring(baseCanned());
    await user.click(await screen.findByRole('button', { name: 'Beratung Muster AG' }));
    const detail = await screen.findByRole('region', { name: de.recurring.history.title });
    expect(within(detail).getByText('01.08.2026')).toBeInTheDocument();
    expect(within(detail).getByText(de.recurring.outcome.issued)).toBeInTheDocument();
    const link = within(detail).getByRole('link', { name: 'RE-2026-0001' });
    expect(link).toHaveAttribute('href', '/documents/doc_1');
  });

  it('shows a schedule whose last run failed AS failing on the list, with the reason (critic C5)', async () => {
    // The reason chain probes A12's own catalogue FIRST and falls through to the shared errors.*
    // one; the first probe's miss is by design (permission_denied is a shared code, not an A12 one).
    allowConsole(/missing translation for "recurring\.error\.permission_denied"/);
    renderRecurring({
      ...baseCanned(),
      list_recurring_schedules: ok({
        schedules: [SCHEDULE({ lastOutcome: 'failed', lastError: 'permission_denied' })],
      }),
    });
    await screen.findByText('Beratung Muster AG');
    // The row itself says the last run failed: the fact does not hide in the per-schedule history.
    expect(screen.getByText(new RegExp(de.recurring.outcome.failed))).toBeInTheDocument();
  });

  it('renders a failed run with the shared error vocabulary, never a raw dot-path', async () => {
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      get_recurring_schedule: ok({
        schedule: SCHEDULE(),
        runs: [RUN({ outcome: 'skipped_locked', error: 'period_locked', documentNumber: null, documentStatus: 'draft' })],
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Beratung Muster AG' }));
    const detail = await screen.findByRole('region', { name: de.recurring.history.title });
    expect(within(detail).getByText(de.recurring.outcome.skipped_locked)).toBeInTheDocument();
    expect(within(detail).getByText(de.recurring.error.period_locked)).toBeInTheDocument();
    // Spec 4b, where the operator acts: both responses to a waiting draft are legal, and the
    // history says so instead of leaving the operator to guess what a cancel would do.
    expect(within(detail).getByText(de.recurring.history.skippedHint)).toBeInTheDocument();
  });

  it('renders a discarded period as its own outcome, not as an error', async () => {
    const user = userEvent.setup();
    renderRecurring({
      ...baseCanned(),
      get_recurring_schedule: ok({
        schedule: SCHEDULE(),
        runs: [RUN({ outcome: 'discarded', documentId: null, documentNumber: null, documentStatus: null })],
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Beratung Muster AG' }));
    const detail = await screen.findByRole('region', { name: de.recurring.history.title });
    expect(within(detail).getByText(de.recurring.outcome.discarded)).toBeInTheDocument();
    expect(within(detail).queryByRole('link')).not.toBeInTheDocument();
  });
});

// --- i18n completeness --------------------------------------------------------------------------

describe('Recurring, the catalogues', () => {
  it('carries the identical key set in de-CH and en', () => {
    const flatten = (tree: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      );
    expect(flatten(de as Record<string, unknown>).sort()).toEqual(flatten(en as Record<string, unknown>).sort());
  });

  it('labels every interval, status and outcome the engine enums admit, discarded included', async () => {
    const { RECURRING_INTERVALS, RECURRING_STATUSES, RUN_OUTCOMES } = await import(
      '../../../../src/core/recurring/enums'
    );
    const catalogue = de.recurring as unknown as Record<string, Record<string, string>>;
    for (const interval of RECURRING_INTERVALS) expect(catalogue.interval?.[interval]).toBeTruthy();
    for (const status of RECURRING_STATUSES) expect(catalogue.status?.[status]).toBeTruthy();
    for (const outcome of RUN_OUTCOMES) expect(catalogue.outcome?.[outcome]).toBeTruthy();
  });
});
