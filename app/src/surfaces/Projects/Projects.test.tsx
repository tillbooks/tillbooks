/**
 * The Projekte surface (B00 §8): the five canonical states, the nested list, the detail panel with
 * its Budget vs. Ist figures and phases, the draft-only Löschen affordance, and the status menu
 * driving `project_set_status`. The transport is canned per action, so every assertion is about
 * what the surface sends and renders, not about the engine.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import Projects from './index';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

const CONTACTS = [
  { id: 'c1', name: 'Muster AG' },
  { id: 'c2', name: 'Beispiel GmbH' },
];

const DRAFT = {
  id: 'p1',
  code: 'P-0001',
  name: 'Website Relaunch',
  contactId: 'c1',
  status: 'draft',
  currency: 'CHF',
  budgetMinor: 500000,
  budgetHours: 80,
  budgetBaseMinor: null,
  fxRate: null,
  startsOn: '2026-08-01',
  endsOn: '2026-12-31',
  parentId: null,
};

const ACTIVE = {
  id: 'p2',
  code: 'P-0002',
  name: 'Umbau Büro',
  contactId: 'c2',
  status: 'active',
  currency: 'CHF',
  budgetMinor: 1200000,
  budgetHours: 0,
  budgetBaseMinor: null,
  fxRate: null,
  startsOn: null,
  endsOn: null,
  parentId: null,
};

const CHILD = {
  id: 'p3',
  code: 'P-0003',
  name: 'Etappe Erdgeschoss',
  contactId: 'c2',
  status: 'active',
  currency: 'CHF',
  budgetMinor: 0,
  budgetHours: 0,
  budgetBaseMinor: null,
  fxRate: null,
  startsOn: null,
  endsOn: null,
  parentId: 'p2',
};

const PHASES = [
  {
    id: 'ph1',
    projectId: 'p2',
    name: 'Konzept',
    sort: 1,
    budgetMinor: 300000,
    budgetHours: 0,
    milestoneOn: '2026-09-30',
    doneAt: null,
  },
  {
    id: 'ph2',
    projectId: 'p2',
    name: 'Rohbau',
    sort: 2,
    budgetMinor: 400000,
    budgetHours: 0,
    milestoneOn: null,
    doneAt: '2026-10-02',
  },
];

const STANDING = {
  budgetMinor: 1200000,
  budgetHours: 0,
  actualCostMinor: 0,
  actualHours: 0,
  remainingMinor: 1200000,
  remainingHours: 0,
  overBudget: false,
  currency: 'CHF',
  phases: [],
};

const happyCanned = (): Canned => ({
  project_list: ok({ projects: [DRAFT, ACTIVE, CHILD] }),
  list_contacts: ok({ contacts: CONTACTS }),
  get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
  project_get: (input) =>
    ok({
      project:
        input.projectId === 'p2' ? { ...ACTIVE, phases: PHASES } : { ...DRAFT, phases: [] },
    }),
  project_budget_actual: ok(STANDING),
  // B03: the costing layer the surface now mounts (the Marge column and the Projekterfolg panel).
  costing_pl_list: ok({
    currency: 'CHF',
    projects: [
      { projectId: 'p1', code: 'P-0001', name: 'Website Relaunch', status: 'draft', marginMinor: 250000 },
      { projectId: 'p2', code: 'P-0002', name: 'Umbau Büro', status: 'active', marginMinor: -40000 },
    ],
  }),
  costing_project_pl: ok({
    currency: 'CHF',
    basis: 'bill',
    basisDegraded: false,
    revenueMinor: 900000,
    costMinor: 650000,
    costBreakdown: { timeMinor: 650000, expensesMinor: 0, purchasesMinor: 0, accruedPurchasesMinor: 0 },
    committedMinor: 0,
    marginMinor: 250000,
    marginBp: 2778,
    timeMinutes: 2600,
    unattributableComponents: ['expenses', 'purchases', 'accrued_purchases', 'committed'],
  }),
  costing_budget_vs_actual: ok({
    budgeted: true,
    currency: 'CHF',
    budgetMinor: 1200000,
    budgetHours: 0,
    costToDateMinor: 650000,
    hoursToDate: 43.33,
    remainingMinor: 550000,
    consumedBp: 5417,
    overBudget: false,
  }),
  costing_drilldown: ok({ rows: [], totalMinor: 0, nextCursor: null }),
});

function renderProjects(canned: Canned | Transport, workspaceId: string | null = 'ws_test') {
  const transport = typeof canned === 'function' ? canned : fakeTransport(canned);
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Projects />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Projects: the five states', () => {
  it('no workspace: names the surface and asks for a Mandant', () => {
    renderProjects(happyCanned(), null);
    expect(screen.getByRole('heading', { name: 'Projekte' })).toBeInTheDocument();
    expect(screen.getByText(/Wähle zuerst einen Mandanten/)).toBeInTheDocument();
  });

  it('loading: the skeleton is a load in progress, not a default', async () => {
    const transport = watchReads(neverSettles);
    renderProjects(transport);
    await transport.started('project_list');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('permission denied: the padlock panel, never a raw code', async () => {
    renderProjects({ ...happyCanned(), project_list: reject('permission_denied', 403) });
    await waitFor(() => expect(screen.getByText('Kein Zugriff')).toBeInTheDocument());
  });

  it('error: the banner with retry, the mapped sentence and never the raw code', async () => {
    renderProjects({ ...happyCanned(), project_list: reject('project_not_found', 422) });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Dieses Projekt gibt es nicht mehr.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('empty: the CTA and the hint', async () => {
    renderProjects({ ...happyCanned(), project_list: ok({ projects: [] }) });
    await waitFor(() => expect(screen.getByText('Noch keine Projekte.')).toBeInTheDocument());
    // The CTA inside the empty state plus the header button.
    expect(screen.getAllByRole('button', { name: 'Neues Projekt' }).length).toBeGreaterThan(0);
  });
});

describe('Projects: the list', () => {
  it('renders code, name, contact, glyph+label status, and money through formatMoney', async () => {
    renderProjects(happyCanned());
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    // The data rows are the DataTable body rows (the header row carries no data-table-row class).
    const rows = within(list).getAllByRole('row').filter((r) => r.classList.contains('data-table-row'));
    expect(rows).toHaveLength(3);
    const draftRow = within(list).getByRole('row', { name: /^P-0001/ });
    expect(within(draftRow).getByText('P-0001')).toBeInTheDocument();
    expect(within(draftRow).getByText('Website Relaunch')).toBeInTheDocument();
    expect(within(draftRow).getByText('Muster AG')).toBeInTheDocument();
    expect(within(draftRow).getByText('Entwurf')).toBeInTheDocument();
    expect(within(draftRow).getByText("CHF 5'000.00")).toBeInTheDocument();
    // The child renders nested under its parent, marked as such by class.
    const childRow = within(list).getByRole('row', { name: /Etappe Erdgeschoss/ });
    expect(childRow.className).toContain('projects-row--child');
  });

  it('has no basic accessibility violations', async () => {
    const { container } = renderProjects(happyCanned());
    await screen.findByRole('table', { name: 'Projektliste' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('offers Löschen only on a draft row', async () => {
    const user = userEvent.setup();
    renderProjects(happyCanned());
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    const draftRow = within(list).getByRole('row', { name: /Website Relaunch/ });
    const activeRow = within(list).getByRole('row', { name: /Umbau Büro/ });

    await user.click(within(draftRow).getByRole('button', { name: /Aktionen für Website Relaunch/ }));
    expect(await screen.findByRole('menuitem', { name: 'Löschen' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(within(activeRow).getByRole('button', { name: /Aktionen für Umbau Büro/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Löschen' })).not.toBeInTheDocument();
  });

  it('deletes a draft behind a confirm, with the verb called once', async () => {
    const del = vi.fn<CannedHandler>(() => ok({ projectId: 'p1', deleted: true }));
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), project_delete: del });
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    const draftRow = within(list).getByRole('row', { name: /Website Relaunch/ });
    await user.click(within(draftRow).getByRole('button', { name: /Aktionen für Website Relaunch/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    await user.click(await screen.findByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0][0].projectId).toBe('p1');
  });
});

describe('Projects: the detail panel', () => {
  it('shows Budget vs. Ist and the phases with their milestone state', async () => {
    const user = userEvent.setup();
    renderProjects(happyCanned());
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(within(list).getByRole('row', { name: /^P-0002/ }));

    expect(await screen.findByText('Budget vs. Ist')).toBeInTheDocument();
    // The figure appears on the row, as the budget AND as the untouched remaining (actuals are 0).
    expect(screen.getAllByText("CHF 12'000.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Konzept')).toBeInTheDocument();
    expect(screen.getByText(/Erledigt am 02\.10\.2026/)).toBeInTheDocument();
    // The undone phase offers the Erledigt control; the done one does not.
    expect(screen.getByRole('button', { name: 'Phase Konzept als erledigt markieren' })).toBeInTheDocument();
  });

  it('drives the status machine from the header and reports a rejection honestly', async () => {
    const setStatus = vi.fn<CannedHandler>((input) =>
      input.status === 'closed' ? reject('project_has_open_time') : ok({ project: { ...ACTIVE, status: input.status } }),
    );
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), project_set_status: setStatus });
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(within(list).getByRole('row', { name: /^P-0002/ }));

    await user.click(await screen.findByRole('button', { name: 'Abschliessen' }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(setStatus.mock.calls[0][0]).toMatchObject({ projectId: 'p2', status: 'closed' });
    // The close-guard refusal renders as the mapped sentence, never the raw code.
    expect(await screen.findByText('Projekt hat offene Zeiteinträge.')).toBeInTheDocument();
  });

  it('adds a phase and surfaces the envelope warning without blocking', async () => {
    const addPhase = vi.fn<CannedHandler>(() =>
      ok({ phase: { ...PHASES[0], id: 'ph9', name: 'Nachtrag' }, warnings: ['phase_budgets_exceed_project'] }),
    );
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), project_phase_add: addPhase });
    const list = await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(within(list).getByRole('row', { name: /^P-0002/ }));

    await user.click(await screen.findByRole('button', { name: 'Phase hinzufügen' }));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Nachtrag');
    await user.type(screen.getByLabelText('Budget'), '9000.00');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(addPhase).toHaveBeenCalledTimes(1));
    expect(addPhase.mock.calls[0][0]).toMatchObject({ projectId: 'p2', name: 'Nachtrag', budgetMinor: 900000 });
    expect(await screen.findByText('Phasenbudgets übersteigen das Projektbudget.')).toBeInTheDocument();
  });
});

describe('Projects: the unselected detail column (D46 UX pass)', () => {
  it('prompts the operator to pick a project instead of a blank second column', async () => {
    renderProjects(happyCanned());
    await screen.findByRole('table', { name: 'Projektliste' });
    // Nothing is selected on first paint, so the right column invites the next action.
    expect(screen.getByText(/Wähle links ein Projekt/)).toBeInTheDocument();
  });
});

describe('Projects: the editor is a real modal (D46 UX pass)', () => {
  it('traps and returns focus: Escape closes and lands focus back on the opener', async () => {
    const user = userEvent.setup();
    renderProjects(happyCanned());
    await screen.findByRole('table', { name: 'Projektliste' });

    const opener = screen.getByRole('button', { name: 'Neues Projekt' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    // Focus lands inside the trap (the first field), never stranded on the body behind the scrim.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Focus returns to the control that opened the editor.
    expect(document.activeElement).toBe(opener);
  });

  it('deep-links out of the empty contact picker instead of stranding a disabled form', async () => {
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), list_contacts: ok({ contacts: [] }) });
    await screen.findByRole('table', { name: 'Projektliste' });

    await user.click(screen.getByRole('button', { name: 'Neues Projekt' }));
    const dialog = await screen.findByRole('dialog');
    const link = within(dialog).getByRole('link', { name: 'Kontakt anlegen' });
    expect(link).toHaveAttribute('href', '/contacts');
  });
});

describe('Projects: the editor', () => {
  it('creates a project with integer Rappen from the decimal input', async () => {
    const create = vi.fn<CannedHandler>(() => ok({ project: { ...DRAFT, id: 'p9' } }));
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), project_create: create });
    await screen.findByRole('table', { name: 'Projektliste' });

    await user.click(screen.getByRole('button', { name: 'Neues Projekt' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Messeauftritt');
    await user.selectOptions(within(dialog).getByLabelText('Kunde'), 'c2');
    await user.type(within(dialog).getByLabelText(/^Budget \(CHF\)/), "12'500.50");
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'Messeauftritt',
      contactId: 'c2',
      budgetMinor: 1250050,
      currency: 'CHF',
    });
    expect(typeof create.mock.calls[0][0].idempotencyKey).toBe('string');
  });

  it('maps code_taken to the inline sentence', async () => {
    const user = userEvent.setup();
    renderProjects({ ...happyCanned(), project_create: reject('code_taken') });
    await screen.findByRole('table', { name: 'Projektliste' });
    await user.click(screen.getByRole('button', { name: 'Neues Projekt' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Doppelt');
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(await within(dialog).findByText('Projektcode bereits vergeben.')).toBeInTheDocument();
  });
});
