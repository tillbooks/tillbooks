/**
 * The Zeit surface: B01's human face over the timesheet, the timer, and the Tarife card.
 *
 * The suite follows the Aufgaben discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami` (the hook fails open, so a test
 * without the provider measures the permissive default and calls it a permission test), a loading
 * assertion waits for the read to have STARTED, and copy is asserted through the catalogue, never
 * as a literal typed here.
 *
 * The B01-specific gate claims: Freigeben/Sperren are HIDDEN (not disabled) without
 * `time.approve` (spec §6: never shown-then-rejected), and a `no_rate_defined` world renders the
 * honest "Bitte zuerst einen Tarif hinterlegen" hint rather than a silent 0-rate entry.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Time from './index';
import de from './messages.de-CH.json';
import shared from '../../i18n/de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const ENTRY = (over: Record<string, unknown> = {}) => ({
  id: 'te_1',
  workspaceId: 'ws_test',
  userId: 'studio',
  projectId: 'proj_1',
  phaseId: null,
  startedAt: '2026-07-10T09:00:00.000Z',
  endedAt: '2026-07-10T10:00:00.000Z',
  minutes: 60,
  billable: true,
  notes: null,
  status: 'open',
  rateMinor: 15000,
  rateCurrency: 'CHF',
  rateScope: 'default',
  rateCardId: 'rc_1',
  submittedAt: null,
  approvedAt: null,
  approvedBy: null,
  lockedAt: null,
  createdAt: '2026-07-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z',
  ...over,
});

const CARD = (over: Record<string, unknown> = {}) => ({
  id: 'rc_1',
  workspaceId: 'ws_test',
  scope: 'default',
  scopeRef: null,
  rateMinor: 15000,
  currency: 'CHF',
  validFrom: '2026-01-01',
  validTo: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'studio', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['time.read', 'time.write', 'time.approve', 'manage_master_data', 'read_master_data', 'billing.read', 'billing.generate']),
  time_list: ok({ entries: [ENTRY()], totalMinutes: 60, billableMinor: 15000 }),
  rate_card_list: ok({ rateCards: [CARD()] }),
  project_list: ok({ projects: [{ id: 'proj_1', code: 'P-0001', name: 'Website Relaunch', contactId: 'c1', status: 'active' }] }),
  list_saved_views: ok({ savedViews: [] }),
  // B02's Unverrechnet panel is mounted on this route (a disjoint child, `Unbilled.tsx`); its reads
  // are canned empty here so the composed surface's B01 assertions are unaffected by it.
  billing_unbilled_preview: ok({ groups: [], totalRappen: 0 }),
  billing_wip_report: ok({ rows: [], totalRappen: 0 }),
  list_contacts: ok({ contacts: [] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Time />
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

const renderTime = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Zeit, the load states', () => {
  it('shows the loading skeleton once the sheet read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Time />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('time_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.some((node) => node.getAttribute('aria-busy') === 'true')).toBe(true);
  });

  it('renders the padlock when the sheet read is refused (the time.read gate)', async () => {
    renderTime({ ...baseCanned(), time_list: reject('permission_denied', { capability: 'time.read' }, 403) });
    expect(await screen.findByText(de.time.error.permissionDenied.read)).toBeInTheDocument();
  });

  it('states what the surface is for when there is no time yet', async () => {
    renderTime({ ...baseCanned(), time_list: ok({ entries: [], totalMinutes: 0, billableMinor: 0 }) });
    expect(await screen.findByText(de.time.empty.title)).toBeInTheDocument();
  });

  it('routes an empty-projects world to B00 rather than offering a timer with nothing to time', async () => {
    renderTime({
      ...baseCanned(),
      time_list: ok({ entries: [], totalMinutes: 0, billableMinor: 0 }),
      project_list: ok({ projects: [] }),
    });
    expect(await screen.findByText(de.time.empty.noProjects.title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: de.time.empty.noProjects.cta })).toBeInTheDocument();
  });
});

describe('Zeit, the sheet', () => {
  it('renders a row with duration, the snapshotted rate, and status as glyph AND label', async () => {
    renderTime(baseCanned());
    expect((await screen.findAllByText(/P-0001 Website Relaunch/)).length).toBeGreaterThan(0);
    // The duration renders in the row AND in the totals strip, both derived from the same payload.
    expect(screen.getAllByText('1:00').length).toBeGreaterThan(1);
    expect(screen.getAllByText("CHF 150.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText(de.time.status.open).length).toBeGreaterThan(0);
  });

  it('offers Stop on a running row and Start otherwise', async () => {
    renderTime({
      ...baseCanned(),
      time_list: ok({ entries: [ENTRY({ endedAt: null, minutes: null })], totalMinutes: 0, billableMinor: 0 }),
    });
    expect((await screen.findAllByRole('button', { name: new RegExp(de.time.timer.stop) })).length).toBeGreaterThan(0);
  });

  it('K-21/K-38: a row carries ONE overflow for its verbs and names its person, never "user_1"', async () => {
    const user = userEvent.setup();
    renderTime({
      ...baseCanned(),
      time_list: ok({ entries: [ENTRY({ userId: 'user_1' })], totalMinutes: 60, billableMinor: 15000 }),
    });
    const row = (await screen.findAllByRole('row')).find((r) => r.textContent?.includes('P-0001')) as HTMLElement;
    // The row names the seat through the shared rule (no roster here: a minted id reads "Person 1").
    expect(within(row).getByText('Person 1')).toBeInTheDocument();
    expect(within(row).queryByText('user_1')).toBeNull();
    // No verb button stands on the row; Bearbeiten and Löschen sit in its one overflow, Löschen last.
    expect(within(row).queryByRole('button', { name: de.time.action.edit })).toBeNull();
    await user.click(within(row).getByRole('button', { name: /^Aktionen für Eintrag vom 10\.07\.2026/ }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual([de.time.action.edit, de.time.action.delete]);
  });

  it('surfaces the engine refusal as the catalogue copy when a submit finds nothing', async () => {
    const canned = { ...baseCanned(), time_submit: reject('nothing_to_submit', { period: '2026-07' }) };
    renderTime(canned);
    await screen.findAllByText(/P-0001/);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(de.time.action.submit) }));
    expect(await screen.findByText(de.time.error.nothing_to_submit)).toBeInTheDocument();
  });

  it('shows the honest no-rate hint when no card exists, never a silent zero', async () => {
    renderTime({ ...baseCanned(), rate_card_list: ok({ rateCards: [] }) });
    expect(await screen.findByText(new RegExp(de.time.error.no_rate_defined))).toBeInTheDocument();
    expect(screen.getByText(de.time.rates.empty)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry that recovers the sheet, never a dead end', async () => {
    // DESIGN.md "no dead ends": a failed read offers a way out. The read fails once, then succeeds,
    // so the banner names what happened and the retry re-reads onto the real rows.
    let calls = 0;
    const canned: Canned = {
      ...baseCanned(),
      time_list: ((): RestResponse => {
        calls += 1;
        return calls === 1
          ? reject('transport')
          : ok({ entries: [ENTRY()], totalMinutes: 60, billableMinor: 15000 });
      }) as CannedHandler,
    };
    renderTime(canned);
    expect(await screen.findByText(de.time.error.transport)).toBeInTheDocument();
    // The Zeit banner's retry is the first in the DOM (the Mandate child mounts its own below it).
    await userEvent.click(screen.getAllByRole('button', { name: shared.states.error.retry })[0]);
    expect((await screen.findAllByText(/P-0001 Website Relaunch/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(de.time.error.transport)).not.toBeInTheDocument();
  });

  it('exposes the billable toggle as a checkbox with an accessible name', async () => {
    // The quick-log billable flag is a REAL native checkbox (D116: styled, not replaced by a div),
    // and its wrapping label gives it the accessible name a screen reader announces.
    renderTime(baseCanned());
    await screen.findAllByText(/P-0001/);
    await userEvent.click(screen.getByRole('button', { name: de.time.action.log }));
    const billable = screen.getByRole('checkbox', { name: de.time.field.billable });
    expect(billable).toBeChecked();
  });
});

describe('Zeit, the gates (a real CapabilitiesProvider, the fail-open default measured out)', () => {
  it('HIDES Freigeben and Sperren without time.approve, never shown-then-rejected', async () => {
    withCapabilities({
      ...baseCanned(),
      whoami: whoamiWith(['time.read', 'time.write']),
    });
    await screen.findAllByText(/P-0001/);
    expect(screen.getByRole('button', { name: new RegExp(de.time.action.submit) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(de.time.action.approve) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(de.time.action.lock) })).not.toBeInTheDocument();
  });

  it('a time.approve holder sees Freigeben and Sperren', async () => {
    withCapabilities(baseCanned());
    await screen.findAllByText(/P-0001/);
    const lockBtn = screen.getByRole('button', { name: new RegExp(de.time.action.lock) });
    expect(lockBtn).toBeInTheDocument();
    // The Sperren button carries the shared SVG padlock glyph, never the padlock emoji marker (DESIGN slop ban).
    expect(lockBtn.querySelector('svg')).not.toBeNull();
    expect(lockBtn.textContent).not.toContain('\u{1F512}');
  });

  it('hides the capture controls and the Tarife form from a read-only holder', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['time.read', 'read_master_data']) });
    await screen.findAllByText(/P-0001/);
    expect(screen.queryByRole('button', { name: de.time.timer.start })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.time.rates.add })).not.toBeInTheDocument();
    // The register itself stays readable: the Tarife table renders for read_master_data.
    expect(screen.getByText(de.time.rates.title)).toBeInTheDocument();
  });
});
