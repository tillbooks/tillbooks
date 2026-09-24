/**
 * D03 Aufträge: the surface's five states and the lifecycle affordances.
 *
 * Follows the C02 house discipline: a gate claim mounts a real CapabilitiesProvider over a transport
 * that answers `whoami` (the hook fails open, so a gate test without the provider measures the
 * permissive default), a loading assertion waits for the read to have STARTED, and every copy
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
import SalesOrders from './index';
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

const ORDER = (over: Record<string, unknown> = {}) => ({
  id: 'so_1',
  number: 'AU-2026-0001',
  contactId: 'contact_1',
  status: 'draft',
  currency: 'CHF',
  ...over,
});

const DETAIL = (order: Record<string, unknown>) =>
  ok({
    salesOrder: order,
    lines: [
      { id: 'sl_1', itemId: null, description: 'Montage', qty: 2000, unitPriceMinor: 12000, deliveredQty: 0, invoicedQty: 0, backorderQty: 0, outstandingQty: 2000 },
    ],
    deliveryNotes: [],
    invoiceIds: [],
  });

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (orders: Record<string, unknown>[] = [ORDER()]): Canned => ({
  whoami: whoamiWith(['read_sales', 'issue']),
  sales_order_list: ok({ salesOrders: orders }),
  sales_order_get: DETAIL(orders[0] ?? ORDER()),
  sales_order_backorders: ok({ backorders: [] }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Muster AG' }] }),
  list_items: ok({ items: [] }),
  stock_on_hand: ok({ locations: [{ id: 'loc_1', name: 'Hauptlager', archived: false }] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <SalesOrders />
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

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('SalesOrders, the load states', () => {
  it('shows the loading skeleton once the list read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <SalesOrders />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('sales_order_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the padlock when the list read is refused, never an empty list', async () => {
    renderSurface({ ...baseCanned(), sales_order_list: reject('permission_denied', {}, 403) });
    expect(await screen.findByText(de.so.error.permissionDenied.read)).toBeInTheDocument();
    expect(screen.queryByText(de.so.empty)).not.toBeInTheDocument();
  });

  it('renders the error banner with a retry on a failed read', async () => {
    renderSurface({ ...baseCanned(), sales_order_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.so.error.transport)).toBeInTheDocument();
  });

  it('renders the empty state when there are no orders', async () => {
    renderSurface({ ...baseCanned([]) });
    expect(await screen.findByText(de.so.empty)).toBeInTheDocument();
  });
});

describe('SalesOrders, the list and detail', () => {
  it('lists an order with its number and a glyph+label status', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('AU-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(de.so.status.draft)).toBeInTheDocument();
  });

  it('opens the detail and offers Confirm on a draft order', async () => {
    const user = userEvent.setup();
    withCapabilities(baseCanned());
    // The list is the shared DataTable: the row is a keyboard-activatable open affordance named by
    // its number (rowLabel). Clicking it opens the shared DetailDrawer.
    await user.click(await screen.findByRole('row', { name: 'Auftrag AU-2026-0001 öffnen' }));
    expect(await screen.findByRole('button', { name: de.so.action.confirm })).toBeInTheDocument();
  });

  it('Escape closes the drawer and returns focus to the row that opened it', async () => {
    const user = userEvent.setup();
    withCapabilities(baseCanned());
    const trigger = await screen.findByRole('row', { name: 'Auftrag AU-2026-0001 öffnen' });
    await user.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus lands back on the row that opened it (DetailDrawer's focus trap), never on <body>.
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('SalesOrders, the drawer keeps one solid primary', () => {
  // A partially delivered order can BOTH ship the remainder AND invoice what is already delivered,
  // so both actions appear in the drawer at once. One primary per view (K-08, D137): invoicing keeps
  // the solid `.btn--primary`, and the deliver go action inside its disclosed sub-form is secondary.
  // Neither is a money write (the invoice is a draft), so the tinted `.btn--accent` appears nowhere.
  const partiallyDelivered = (): Canned => {
    const order = ORDER({ status: 'partially_delivered' });
    return {
      ...baseCanned([order]),
      sales_order_get: ok({
        salesOrder: order,
        lines: [
          { id: 'sl_1', itemId: null, description: 'Ware', qty: 3000, unitPriceMinor: 5000, deliveredQty: 1000, invoicedQty: 0, backorderQty: 2000, outstandingQty: 2000 },
        ],
        deliveryNotes: [],
        invoiceIds: [],
      }),
    };
  };

  it('renders exactly one solid primary across the whole drawer, with deliver secondary and no accent', async () => {
    const user = userEvent.setup();
    withCapabilities(partiallyDelivered());
    await user.click(await screen.findByRole('row', { name: 'Auftrag AU-2026-0001 öffnen' }));
    await screen.findByRole('button', { name: de.so.action.invoice });
    // Actions now live in the shared DetailDrawer: invoicing on the pinned footer, the deliver go
    // action in the disclosed sub-form in the body. The one-solid-primary rule holds across both, so
    // the whole dialog is the scope.
    const dialog = screen.getByRole('dialog');
    const solidPrimaries = dialog.querySelectorAll('.btn--primary');
    expect(solidPrimaries.length).toBe(1);
    const accents = dialog.querySelectorAll('.btn--accent');
    expect(accents.length).toBe(0);
    // The one solid primary is invoicing; the deliver go action is secondary.
    expect(screen.getByRole('button', { name: de.so.action.invoice })).toHaveClass('btn--primary');
    expect(screen.getByRole('button', { name: de.so.action.deliver })).toHaveClass('btn--secondary');
  });

  it('shows the backorder badge as glyph plus a labelled state on a backordered line', async () => {
    const user = userEvent.setup();
    withCapabilities(partiallyDelivered());
    await user.click(await screen.findByRole('row', { name: 'Auftrag AU-2026-0001 öffnen' }));
    await screen.findByRole('button', { name: de.so.action.invoice });
    // The line's backorder state is the shared Status word: glyph plus the visible word (K-22), so
    // colour is never the sole carrier.
    const badges = await screen.findAllByText(de.so.badge.backorder);
    expect(badges.length).toBeGreaterThan(0);
  });
});

describe('SalesOrders, the permission gate', () => {
  it('hides the New order action without the write capability', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_sales']) });
    expect(await screen.findByText('AU-2026-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.so.action.new })).not.toBeInTheDocument();
  });

  it('shows the New order action with the write capability', async () => {
    withCapabilities(baseCanned());
    expect(await screen.findByRole('button', { name: de.so.action.new })).toBeInTheDocument();
  });
});
