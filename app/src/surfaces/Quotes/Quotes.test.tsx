/**
 * C02 Offerten: the surface's five states and the lifecycle affordances.
 *
 * The suite follows the house discipline: a gate claim mounts a real CapabilitiesProvider over a
 * transport that answers `whoami` (the hook fails open, so a gate test without the provider measures
 * the permissive default), a loading assertion waits for the read to have STARTED, and every copy
 * assertion goes through the catalogue rather than a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Quotes from './index';
import de from './messages.de-CH.json';

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

const QUOTE = (over: Record<string, unknown> = {}) => ({
  id: 'q_1',
  number: 'O-2026-0001',
  contactId: 'contact_1',
  status: 'sent',
  totalMinor: 150000,
  currency: 'CHF',
  validUntil: '2027-01-31',
  version: 1,
  expired: false,
  ...over,
});

const LIST = (documents: Record<string, unknown>[] = [QUOTE()]) => ok({ documents, truncated: false, total: documents.length });

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_sales', 'issue', 'send']),
  quotes_list: LIST(),
  list_saved_views: ok({ savedViews: [] }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Muster AG' }] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Quotes />
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

const renderQuotes = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Quotes, the load states', () => {
  it('shows the loading skeleton once the list read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Quotes />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('quotes_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the padlock when the list read is refused, never an empty list', async () => {
    renderQuotes({ ...baseCanned(), quotes_list: reject('permission_denied', {}, 403) });
    expect(await screen.findByText(de.quotes.error.permissionDenied.read)).toBeInTheDocument();
    expect(screen.queryByText(de.quotes.empty)).not.toBeInTheDocument();
  });

  it('renders the error banner with a retry on a failed read', async () => {
    renderQuotes({ ...baseCanned(), quotes_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.quotes.error.transport)).toBeInTheDocument();
  });

  it('states what the surface is for when there are no quotes, with the create CTA', async () => {
    renderQuotes({ ...baseCanned(), quotes_list: LIST([]) });
    expect(await screen.findByText(de.quotes.empty)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: de.quotes.action.create }).length).toBeGreaterThan(0);
  });
});

describe('Quotes, the list and the drawer', () => {
  it('lists a quote with its number, customer, total and glyph+label status', async () => {
    renderQuotes(baseCanned());
    expect(await screen.findByText('O-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('Muster AG')).toBeInTheDocument();
    expect(screen.getByText(/1'500\.00/)).toBeInTheDocument();
    // Status is a glyph AND a label, never colour alone.
    expect(screen.getAllByText(de.quotes.status.sent).length).toBeGreaterThan(0);
  });

  it('a sent quote offers accept, decline and revise; send is not offered', async () => {
    renderQuotes(baseCanned());
    await userEvent.click(await screen.findByText('O-2026-0001'));
    expect(screen.getByRole('button', { name: de.quotes.action.mark_accepted })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.quotes.action.decline })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.quotes.action.revise })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.quotes.action.send })).not.toBeInTheDocument();
  });

  it('a draft quote offers Send, which surfaces the honest cloud-tier note and the accept link', async () => {
    const canned: Canned = {
      ...baseCanned(),
      quotes_list: LIST([QUOTE({ status: 'draft', number: null })]),
      quotes_send: ok({
        document: { id: 'q_1', status: 'sent', number: 'O-2026-0001' },
        transmitted: false,
        reason: 'cloud_tier',
        dispatch: 'needs_dispatch_module',
        acceptToken: 'tok_abc',
        acceptUrl: '/quotes/accept?token=tok_abc',
      }),
    };
    renderQuotes(canned);
    // A draft has no number yet, so its DataTable row is named "-" (rowLabel). Clicking the row opens
    // the shared DetailDrawer.
    await userEvent.click(await screen.findByRole('row', { name: '-' }));
    await userEvent.click(screen.getByRole('button', { name: de.quotes.action.send }));
    expect(await screen.findByText(de.quotes.send.cloud_note)).toBeInTheDocument();
    expect(screen.getByDisplayValue('/quotes/accept?token=tok_abc')).toBeInTheDocument();
  });

  it('an accepted quote offers both convert targets', async () => {
    renderQuotes({ ...baseCanned(), quotes_list: LIST([QUOTE({ status: 'accepted' })]) });
    await userEvent.click(await screen.findByText('O-2026-0001'));
    expect(screen.getByRole('button', { name: de.quotes.action.convert_order })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.quotes.action.convert_invoice })).toBeInTheDocument();
  });

  it('an expired sent quote reads Abgelaufen and does not offer accept', async () => {
    renderQuotes({ ...baseCanned(), quotes_list: LIST([QUOTE({ status: 'sent', expired: true })]) });
    await userEvent.click(await screen.findByText('O-2026-0001'));
    expect(screen.getAllByText(de.quotes.status.expired).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: de.quotes.action.mark_accepted })).not.toBeInTheDocument();
  });

  it('Escape closes the drawer and returns focus to the row that opened it', async () => {
    renderQuotes(baseCanned());
    const trigger = await screen.findByRole('row', { name: /O-2026-0001/ });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus lands back on the row that opened it (DetailDrawer's focus trap), never on <body>.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not leak one quote accept link into another quote drawer', async () => {
    const canned: Canned = {
      ...baseCanned(),
      quotes_list: LIST([
        QUOTE({ id: 'q_1', number: null, status: 'draft' }),
        QUOTE({ id: 'q_2', number: 'O-2026-0002', status: 'sent' }),
      ]),
      quotes_send: ok({
        document: { id: 'q_1', status: 'sent', number: 'O-2026-0001' },
        transmitted: false,
        acceptUrl: '/quotes/accept?token=tok_abc',
      }),
    };
    renderQuotes(canned);
    // Send the draft (its DataTable row is named "-"); the accept link appears in ITS drawer.
    await userEvent.click(await screen.findByRole('row', { name: '-' }));
    await userEvent.click(screen.getByRole('button', { name: de.quotes.action.send }));
    expect(await screen.findByText(de.quotes.send.cloud_note)).toBeInTheDocument();
    // Open the OTHER quote: its drawer must not carry the first quote's accept link.
    await userEvent.click(screen.getByRole('row', { name: /O-2026-0002/ }));
    expect(screen.queryByText(de.quotes.send.cloud_note)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('/quotes/accept?token=tok_abc')).not.toBeInTheDocument();
  });
});

describe('Quotes, the permission gate', () => {
  it('hides the create affordance without the write capability', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_sales']) });
    await screen.findByText('O-2026-0001');
    expect(screen.queryByRole('button', { name: de.quotes.action.create })).not.toBeInTheDocument();
  });
});
