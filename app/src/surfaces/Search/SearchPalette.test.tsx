/**
 * G16, the command palette: one ranked overlay for navigation, records and verbs.
 *
 * Held here: the overlay opens on the shell shortcut with focus in its input; the browse state lists
 * navigation and surface-scoped actions; a query ranks records (G07) and verbs together; a verb the
 * actor cannot run is SHOWN disabled with its required capability (never hidden, D90 D-4); a handoff
 * verb routes to its owning surface (asserted against the real router, never a mock); the footer
 * carries the active row's verb name as a token; and Esc closes. The direct-run path calls the same
 * client the surfaces use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { KeyboardProvider } from '../../app/keyboard';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { SearchPalette } from './SearchPalette';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const RESULTS = ok({
  q: 'Muster',
  results: [
    { entityKind: 'contact', entityId: 'contact_1', title: 'Muster AG', matchedVia: 'field', route: '/contacts' },
  ],
  total: 1,
  hasMore: false,
  failedKinds: [],
});

function transportOf(routes: Record<string, RestResponse>): Transport {
  return async (action) => routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

function WhereAmI() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function tree(transport: Transport, caps: Capabilities = ALLOW_ALL) {
  return (
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={caps}>
            <MemoryRouter initialEntries={['/overview']}>
              <KeyboardProvider>
                <SearchPalette />
                <Routes>
                  <Route path="*" element={<WhereAmI />} />
                </Routes>
              </KeyboardProvider>
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

async function openPalette() {
  await userEvent.keyboard('{Control>}k{/Control}');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the command palette', () => {
  it('opens on Ctrl+K with focus in the input, and closes on Esc', async () => {
    render(tree(transportOf({})));
    expect(screen.queryByRole('dialog')).toBeNull();
    await openPalette();
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('browses navigation with no query', async () => {
    render(tree(transportOf({})));
    await openPalette();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('ranks a navigation destination to the top when its name is typed', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Journal');
    expect(await screen.findByRole('option', { name: /^Journal$/ })).toBeInTheDocument();
  });

  it('ranks a record and a verb together for a query', async () => {
    render(tree(transportOf({ search_global: RESULTS })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Muster');
    await waitFor(() => expect(screen.getByText(/Muster AG/)).toBeInTheDocument());
  });

  it('routes a handoff verb to its owning surface and closes', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Zahlung erfassen');
    const row = await screen.findByRole('option', { name: /^Zahlung erfassen/ });
    await userEvent.click(row);
    expect(screen.getByTestId('location').textContent).toBe('/payments');
  });

  it('shows a denied verb DISABLED with its required capability, never hidden', async () => {
    const caps: Capabilities = {
      whoami: { actor: 'a', provisioned: true, isMember: true, memberId: 'm', userId: 'u', role: 'viewer', capabilities: [] },
      can: () => false,
      refresh: () => undefined,
    };
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) }), caps));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Buchung erfassen');
    const row = await screen.findByRole('option', { name: /^Buchung erfassen/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row.textContent).toContain('Benötigt');
  });

  it('shows the active row verb name as a footer token', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Zahlung erfassen');
    await screen.findByRole('option', { name: /^Zahlung erfassen/ });
    expect(screen.getByText('record_payment')).toBeInTheDocument();
  });

  it('G17: a query surfaces the Begriffe group after the other groups, and Enter opens the centred panel over the same route', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Saldosteuersatz');
    expect(await screen.findByText('Begriffe')).toBeInTheDocument();
    const row = await screen.findByRole('option', { name: /^Saldosteuersatz$/ });
    await userEvent.click(row);
    // The palette overlay is gone; ONE dialog remains: the centred concept panel, focused.
    const panel = await screen.findByRole('dialog', { name: 'Saldosteuersatz' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(panel).toHaveFocus();
    // No route change and no engine write: opening a concept is free (row 2.1).
    expect(screen.getByTestId('location').textContent).toBe('/overview');
    // Esc closes the panel; the corpus body renders while open.
    expect(panel.textContent).toContain('Saldosteuersatz');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('G17: a question-shaped query still surfaces the definition through its token', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'soll ich saldo');
    expect(await screen.findByText('Begriffe')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Saldosteuersatz$/ })).toBeInTheDocument();
  });

  it('G17: no concept match renders NO Begriffe group at all (absence, not an empty group)', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Journal');
    await screen.findByRole('option', { name: /^Journal$/ });
    expect(screen.queryByText('Begriffe')).toBeNull();
  });

  it('G17: a concept lookup writes nothing to shell persistence', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Vorsteuer');
    const row = await screen.findByRole('option', { name: /^Vorsteuer$/ });
    await userEvent.click(row);
    await screen.findByRole('dialog', { name: 'Vorsteuer' });
    // G16's recents are the ONLY shell persistence, and a concept lookup leaves no trace at all.
    expect(window.localStorage.length).toBe(0);
  });

  it('traps focus: the empty-state escape control is reachable by Tab and focus never leaves the dialog', async () => {
    // A query that matches no screen, verb, record or concept lands the empty state, whose one
    // control is "In allen Daten suchen". The old palette killed Tab outright, so that control was
    // keyboard-UNREACHABLE (a WCAG 2.1.1 failure hiding inside a focus fix). The real trap makes it
    // reachable AND keeps focus inside the modal.
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'zzzznichts');
    const escapeControl = await screen.findByRole('button', { name: 'In allen Daten suchen' });
    const dialog = screen.getByRole('dialog');
    screen.getByRole('combobox').focus();
    await userEvent.tab();
    expect(escapeControl).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Shift+Tab from the input wraps back INTO the dialog (to the last control), never out to <body>.
    screen.getByRole('combobox').focus();
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Esc closes from a palette control, not only from the input', async () => {
    // With the trap making buttons reachable, Esc must dismiss from wherever focus rests, or a
    // keyboard user who tabbed to a control would be stranded. Esc lives on the dialog for exactly
    // this reason.
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'zzzznichts');
    const escapeControl = await screen.findByRole('button', { name: 'In allen Daten suchen' });
    escapeControl.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('announces the result count, the no-visible-label input exception the design leans on', async () => {
    // The palette input carries no visible label (a named §6 exception) justified by "aria-label +
    // the announced count + the footer legend". This is the announced-count leg: a polite status
    // region that reports how many rows the query surfaced.
    render(tree(transportOf({})));
    await openPalette();
    const options = screen.getAllByRole('option');
    const status = await screen.findByText(new RegExp(`Ergebnisse: ${options.length}`));
    expect(status).toHaveAttribute('role', 'status');
  });

  it('runs a direct-run verb inline through the client', async () => {
    const called: string[] = [];
    const transport: Transport = async (action) => {
      called.push(action);
      return ok({ egress: 'local' });
    };
    render(tree(transport));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Verbindungstest');
    const row = await screen.findByRole('option', { name: /^Verbindungstest/ });
    await userEvent.click(row);
    // Typing also fires a debounced `search_global`; assert the direct-run verb was ISSUED, not
    // that it was the LAST call, so a late-firing search cannot race this assertion red under load.
    await waitFor(() => expect(called).toContain('egress_self_test'));
    // The palette stays open on a direct-run and renders its result region.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('C1: offers a "Frag den Agenten" tail row for the free text', async () => {
    render(tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'wie hoch ist der umsatz');
    expect(await screen.findByRole('option', { name: /Frag den Agenten/ })).toBeInTheDocument();
  });

  it('C1: routes the free text to agent_ask and closes on success', async () => {
    const log: { action: string; input: Record<string, unknown> }[] = [];
    const transport: Transport = async (action, input) => {
      log.push({ action, input });
      if (action === 'agent_ask') return ok({ sessionId: 's1', turnId: 't1' });
      return { status: 200, body: { ok: true, results: [], total: 0, hasMore: false, failedKinds: [] } };
    };
    render(tree(transport));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Umsatz Q3');
    await userEvent.click(await screen.findByRole('option', { name: /Frag den Agenten/ }));
    await waitFor(() => expect(log.some((l) => l.action === 'agent_ask')).toBe(true));
    const ask = log.find((l) => l.action === 'agent_ask');
    expect(ask?.input.text).toBe('Umsatz Q3');
    expect(typeof ask?.input.idempotencyKey).toBe('string');
    // On success the palette closes (the answer opens in the dock, which lives outside this tree).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('C1: keeps the palette open and explains when no local runtime is configured', async () => {
    const transport: Transport = async (action) => {
      if (action === 'agent_ask') return { status: 400, body: { ok: false, error: 'needs_local_runtime' } };
      return { status: 200, body: { ok: true, results: [], total: 0, hasMore: false, failedKinds: [] } };
    };
    render(tree(transport));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Umsatz Q3');
    await userEvent.click(await screen.findByRole('option', { name: /Frag den Agenten/ }));
    expect(await screen.findByText(/Keine lokale Agent-Laufzeit konfiguriert/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('the command palette: accessibility', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`C1/C2: the open palette with both lanes has no axe violations (${theme})`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      const { container } = render(
        tree(transportOf({ search_global: ok({ results: [], total: 0, hasMore: false, failedKinds: [] }) })),
      );
      await openPalette();
      // A query that surfaces command rows AND the "Frag den Agenten" ask row: both lanes rendered.
      await userEvent.type(screen.getByRole('combobox'), 'Zahlung');
      await screen.findByRole('option', { name: /Frag den Agenten/ });
      // Let the debounced search_global fire and settle so no state update escapes the assertion.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(await axe(container)).toHaveNoViolations();
    });
  }
});

/**
 * F-13 (friction ledger, Phase 2), J2.6: "type the name, see the open amount, done". A contact hit
 * with open items offers its open amount FIRST and lands on the OP-Liste filtered to that customer;
 * a contact with nothing open, or a refused balance read, keeps only the record row.
 */
describe('F-13 J2.6: the palette lands on the open amount', () => {
  const balance = ok({
    customerId: 'contact_1',
    items: [{ openMinor: 1104215 }],
    baseTotalOpenMinor: 1104215,
    baseCurrency: 'CHF',
  });

  it('offers "Offene Posten von {name}" ahead of the contact record, landing on /open-items filtered to the customer', async () => {
    const calls: string[] = [];
    const transport: Transport = async (action, input) => {
      calls.push(action);
      if (action === 'search_global') return RESULTS;
      if (action === 'customer_balance') return (input as { customerId: string }).customerId === 'contact_1' ? balance : ok({ items: [] });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    render(tree(transport));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Muster');
    const openRow = await screen.findByRole('option', { name: /Offene Posten von Muster AG: CHF 11'042\.15/ });
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    const openIndex = options.findIndex((x) => x.includes('Offene Posten von Muster AG'));
    const recordIndex = options.findIndex((x) => x.includes('Kontakte, Muster AG'));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(openIndex);
    await userEvent.click(openRow);
    expect(screen.getByTestId('location')).toHaveTextContent('/open-items?customer=contact_1');
    expect(calls.filter((c) => c === 'customer_balance')).toHaveLength(1);
  });

  it('keeps only the record row for a contact with nothing open, and when the balance read is refused', async () => {
    const empty: Transport = async (action) => {
      if (action === 'search_global') return RESULTS;
      if (action === 'customer_balance') return ok({ customerId: 'contact_1', items: [], baseTotalOpenMinor: 0, baseCurrency: 'CHF' });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    const { unmount } = render(tree(empty));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Muster');
    await screen.findByRole('option', { name: /Kontakte, Muster AG/ });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('option', { name: /Offene Posten/ })).toBeNull();
    unmount();

    const refused: Transport = async (action) => {
      if (action === 'search_global') return RESULTS;
      if (action === 'customer_balance') return { status: 403, body: { ok: false, error: 'permission_denied', capability: 'read_sales' } };
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    render(tree(refused));
    await openPalette();
    await userEvent.type(screen.getByRole('combobox'), 'Muster');
    await screen.findByRole('option', { name: /Kontakte, Muster AG/ });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('option', { name: /Offene Posten/ })).toBeNull();
  });
});
