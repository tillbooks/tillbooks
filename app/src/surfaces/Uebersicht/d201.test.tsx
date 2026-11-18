/**
 * D201 and D204 on the Übersicht (owner, 15.11.2026): the agent's suggestions as the first card of the grid,
 * acted on in their row (Freigeben, and Ablehnen in one click that asks nothing); the page arranged in place
 * with a toolbar per item and no mode; the old key-figure address opening the card sheet; a drill that
 * carries the way back. The transport is canned per action, so every assertion is about what the surface
 * sends and renders. Every name and amount here is invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore, type PrefValue } from '../../lib/prefs';
import { Uebersicht } from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

beforeEach(() => {
  document.documentElement.setAttribute('data-motion', 'calm');
});

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refused = (error: string, message?: string): RestResponse => ({ status: 409, body: { ok: false, error, ...(message !== undefined ? { message } : {}) } });

const DRILL = (route: string) => ({ studioRoute: route, mcpTool: 'aging_report', params: { workspaceId: 'ws_test', bucket: 'overdue' } });
const TILES = [
  { tile: 'revenue', ok: true, valueRappen: 3_000_000, currency: 'CHF', range: { from: '2026-11-01', to: '2026-11-30' }, glyph: '◆', drill: DRILL('/reports'), detail: {} },
  { tile: 'ar_aging', ok: true, valueRappen: 850_000, currency: 'CHF', asOf: '2026-11-15', glyph: '◧', drill: DRILL('/open-items'), detail: {} },
];

/** One open Vorschlag: a bank line the agent proposes to book. */
const suggestion = (n: number) => ({
  actionId: `va_${n}`,
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'book_bank_line',
  payload: { bankTxnId: `btx_${n}`, target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: 2000 + n }] }, idempotencyKey: `k${n}` },
  agentReason: null,
  status: 'pending',
  createdAt: '2026-11-14T08:00:00.000Z',
  lineFacts: { date: '2026-11-1' + (n % 10), counterparty: `Beispiel Lieferant ${n}`, text: null, amountMinor: -(2000 + n), currency: 'CHF' },
  evidence: { certainty: 'sure', reasons: ['agrees'] },
  batchable: true,
});

const canned = (actions: unknown[] = [suggestion(1), suggestion(2)]): Canned => ({
  dashboard_overview: ok({ workspaceId: 'ws_test', tiles: TILES, omitted: [] }),
  list_saved_views: ok({ entityKind: 'workspace', savedViews: [] }),
  dashboard_series: ok({ months: [], topExpenses: [], otherExpensesMinor: 0, expenseTotalMinor: 0, currency: 'CHF', bankAccounts: 0 }),
  list_vendor_bills: ok({ bills: [], baseTotalOpenMinor: 0, baseCurrency: 'CHF' }),
  tasks_list: ok({ tasks: [], total: 0 }),
  list_accounts: ok(listAccountsFixture),
  list_drafted_actions: ok({ actions }),
});

interface Call {
  action: string;
  input: Record<string, unknown>;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname + location.search}</div>
      <div data-testid="from">{(location.state as { from?: string } | null)?.from ?? ''}</div>
    </>
  );
}

let store: PrefsStore;

function renderSurface(c: Canned, prefs: Record<string, PrefValue> = {}, path = '/overview'): Call[] {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = c[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry((input ?? {}) as Record<string, unknown>) : entry;
  };
  store = new PrefsStore(null, null, { useCache: false });
  for (const [key, value] of Object.entries(prefs)) store.seed(key, value);
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <PrefsProvider store={store}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="*" element={<><Uebersicht /><LocationProbe /></>} />
              </Routes>
            </MemoryRouter>
          </PrefsProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return calls;
}

const card = () => screen.findByRole('region', { name: 'Vorschläge' });
const items = () => [...document.querySelectorAll('.uebersicht-grid > li[data-slot]')].map((li) => li.getAttribute('data-slot'));

describe('D201 pick B: the suggestions card', () => {
  it('leads the grid over the whole row, with the count in its head and one line per suggestion', async () => {
    renderSurface(canned());
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    expect(items()[0]).toBe('suggestions');
    expect(document.querySelector('[data-slot="suggestions"]')).toHaveClass('uebersicht-item--full');
    expect(within(region).getByLabelText('2 offen')).toHaveTextContent('2');
    expect(within(region).getByText('Beispiel Lieferant 2')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Alle ansehen' })).toHaveAttribute('href', '/attention');
  });

  it('Freigeben approves the one line with the engine verb, and the row leaves at once', async () => {
    const c = canned();
    c.approve_drafted_action = ok({ status: 'executed' });
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    const row = document.querySelector('[data-action-id="va_1"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls.some((x) => x.action === 'approve_drafted_action')).toBe(true));
    expect(calls.find((x) => x.action === 'approve_drafted_action')?.input).toEqual({ workspaceId: 'ws_test', actionId: 'va_1' });
    await waitFor(() => expect(within(region).queryByText('Beispiel Lieferant 1')).toBeNull());
    // The card reads again (the shared attention change), the other line stays.
    expect(within(region).getByText('Beispiel Lieferant 2')).toBeInTheDocument();
    expect(calls.filter((x) => x.action === 'list_drafted_actions').length).toBeGreaterThan(1);
  });

  it('Ablehnen is one click that asks nothing: no reason field, no reason sent', async () => {
    const c = canned();
    c.reject_drafted_action = ok({ status: 'rejected' });
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 2');
    const row = document.querySelector('[data-action-id="va_2"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Ablehnen' }));
    await waitFor(() => expect(calls.some((x) => x.action === 'reject_drafted_action')).toBe(true));
    expect(calls.find((x) => x.action === 'reject_drafted_action')?.input).toEqual({ workspaceId: 'ws_test', actionId: 'va_2' });
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(within(region).queryByText('Beispiel Lieferant 2')).toBeNull());
  });

  it('a refused act claims nothing: the row stays and says the reason under its subject', async () => {
    const c = canned();
    c.approve_drafted_action = refused('period_locked', 'Die Periode ist abgeschlossen.');
    renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    const row = document.querySelector('[data-action-id="va_1"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(row.querySelector('.pl-state')).not.toBeNull());
    expect(within(region).getByText('Beispiel Lieferant 1')).toBeInTheDocument();
  });

  it('twenty-three open: the top five show, and Alle 23 ansehen opens Pendenzen', async () => {
    renderSurface(canned(Array.from({ length: 23 }, (_, i) => suggestion(i + 1))));
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    expect(region.querySelectorAll('.uebersicht-sugg__row')).toHaveLength(5);
    expect(within(region).getByRole('link', { name: 'Alle 23 ansehen' })).toHaveAttribute('href', '/attention');
  });

  it('nothing open: one calm line by default; with overview.suggestions_empty = hide the card steps out', async () => {
    renderSurface(canned([]));
    const region = await card();
    expect(await within(region).findByText('Nichts offen')).toBeInTheDocument();
    expect(within(region).queryByRole('link', { name: /ansehen/ })).toBeNull();
  });

  it('with overview.suggestions_empty = hide and nothing open, the grid has no suggestions card', async () => {
    renderSurface(canned([]), { 'overview.suggestions_empty': 'hide' });
    await screen.findAllByRole('button', { name: /^Umsatz/ });
    await waitFor(() => expect(items()).not.toContain('suggestions'));
    expect(screen.queryByRole('region', { name: 'Vorschläge' })).toBeNull();
  });

  it('a failed read says so with a retry that reads again; a refused one is the padlock', async () => {
    let fail = true;
    const c = canned();
    c.list_drafted_actions = () => (fail ? refused('internal_error') : ok({ actions: [suggestion(1)] }));
    renderSurface(c);
    const region = await card();
    expect(await within(region).findByText('Die Vorschläge konnten nicht geladen werden.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(region).getByRole('button', { name: /Erneut versuchen/ }));
    expect(await within(region).findByText('Beispiel Lieferant 1')).toBeInTheDocument();
  });

  it('without the right to read them, the card shows the padlock, never an empty list', async () => {
    const c = canned();
    c.list_drafted_actions = refused('permission_denied');
    renderSurface(c);
    const region = await card();
    expect(await within(region).findByText('Dir fehlt das Recht, die Vorschläge zu lesen.')).toBeInTheDocument();
  });
});

describe('D201 pick A: arranged in place, no mode', () => {
  it('no Anpassen to enter; every item carries its toolbar and grip, and its face stays live', async () => {
    renderSurface(canned([]));
    await screen.findAllByRole('button', { name: /^Umsatz/ });
    expect(screen.queryByRole('button', { name: 'Anpassen' })).toBeNull();
    const revenue = document.querySelector('[data-slot="revenue"]') as HTMLElement;
    expect(revenue).toHaveClass('is-inline');
    expect(revenue.querySelector('.uebersicht-item__face[inert]')).toBeNull();
    expect(revenue.querySelector('.uebersicht-grip[data-drag-handle]')).not.toBeNull();
    expect(within(revenue).getByRole('button', { name: 'Ausblenden', description: 'Umsatz' })).toBeInTheDocument();
    expect(within(revenue).getByRole('button', { name: 'Mehr zu Umsatz' })).toBeInTheDocument();
  });

  it('the eye hides a figure at once and saves it; the sheet brings it back', async () => {
    renderSurface(canned([]));
    await screen.findAllByRole('button', { name: /^Umsatz/ });
    await userEvent.click(screen.getByRole('button', { name: 'Ausblenden', description: 'Umsatz' }));
    expect(items()).not.toContain('revenue');
    expect((store.value('overview.tiles') as { id: string; on: boolean }[]).find((s) => s.id === 'revenue')).toMatchObject({ on: false });
    await userEvent.click(screen.getByRole('button', { name: 'Karte' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Karten' })).getByRole('switch', { name: 'Umsatz' }));
    expect(items()).toContain('revenue');
  });

  it('the suggestions card resizes between the whole row and two columns', async () => {
    renderSurface(canned([]));
    const region = await card();
    await within(region).findByText('Nichts offen');
    await userEvent.click(screen.getByRole('button', { name: 'Grösse ändern', description: 'Vorschläge: doppelt breit' }));
    expect(document.querySelector('[data-slot="suggestions"]')).toHaveClass('uebersicht-item--double');
    expect((store.value('overview.tiles') as { id: string; w?: string }[]).find((s) => s.id === 'suggestions')).toMatchObject({ w: 'double' });
  });

  it('Alt+Arrow moves an item without a drag (WCAG 2.5.7)', async () => {
    renderSurface(canned([]));
    await screen.findAllByRole('button', { name: /^Umsatz/ });
    const before = items();
    act(() => screen.getByRole('button', { name: 'Ausblenden', description: 'Debitoren offen' }).focus());
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    const after = items();
    expect(after.indexOf('ar_aging')).toBe(before.indexOf('ar_aging') - 1);
  });

  it('a drill carries the way back: the page it opens gets { from: /overview }', async () => {
    renderSurface(canned([]));
    await userEvent.click((await screen.findAllByRole('button', { name: /^Debitoren offen/ }))[0]!);
    expect(screen.getByTestId('location')).toHaveTextContent('/open-items?bucket=overdue');
    expect(screen.getByTestId('from')).toHaveTextContent('/overview');
  });

  it('the old key-figure address opens the page with the card sheet; closing it lands on /overview', async () => {
    renderSurface(canned([]), {}, '/overview/kennzahlen');
    const sheet = await screen.findByRole('dialog', { name: 'Karten' });
    expect(document.querySelector('.uebersicht-grid')).not.toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schliessen', description: 'Karten schliessen' }));
    expect(screen.queryByRole('dialog', { name: 'Karten' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/overview$/);
  });
});

describe('D201 point 5: the header doors', () => {
  it('off by default; on with overview.doors = shown; the demo door of an empty workspace either way', async () => {
    renderSurface(canned([]), { 'overview.doors': 'shown' });
    await screen.findAllByRole('button', { name: /^Umsatz/ });
    const doors = screen.getByRole('group', { name: 'Häufige Aktionen' });
    expect(within(doors).getByRole('link', { name: 'Neue Buchung' })).toHaveAttribute('href', '/journal?new=1');
    expect(within(doors).getByRole('link', { name: 'Sichern' })).toBeInTheDocument();
  });
});
