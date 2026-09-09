/**
 * D01, the Inventory (Lager) surface. The suite proves the five states and the design-law
 * remediations from the D46 UX pass, not just "the page renders":
 *
 *   - loading  the skeleton is a load in flight, PROVEN with `watchReads` against `stock_on_hand`
 *              (loading-state-convention), never a bare role="status" over a read nobody watched.
 *   - empty    no stock-tracked items names the surface AND links out to items (D00), never a dead end.
 *   - error    a non-permission failure renders the retryable ErrorBanner, and the retry re-reads.
 *   - denied   `stock_on_hand` refused renders the padlock, not a broken grid.
 *   - ready    the grid renders on-hand and the low-stock badge is a glyph AND a label (WCAG 2.2 AA).
 *
 * Plus the remediations: the padlock hides "Bewegung erfassen" without manage_master_data (A24), the
 * valuation method select is labelled "Methode" and NOT "Grund" (the mislabelled-select bug), the
 * movement dialog is a focus-trapping role=dialog, and the Inventur freeze date is labelled correctly.
 * Every string it looks for is read from the de-CH fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { watchReads, neverSettles } from '../../test-transport';
import Inventory from './index';
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

const ROW = { itemId: 'it_1', itemName: 'Schraube M4', locationId: 'loc_1', locationName: 'Hauptlager', onHand: 3 };
const LOCATIONS = [{ id: 'loc_1', name: 'Hauptlager', type: null, archived: false }];
const ITEMS = [{ id: 'it_1', name: 'Schraube M4' }];

function baseCanned(): Canned {
  return {
    stock_on_hand: ok({ rows: [ROW], locations: LOCATIONS, items: ITEMS }),
    stock_low_stock: ok({ items: [{ itemId: 'it_1', itemName: 'Schraube M4', onHand: 3, reorderPoint: 10 }] }),
    get_company_profile: ok({ baseCurrency: 'CHF' }),
    stock_valuation_report: ok({ totalValueMinor: 4500, perItem: [], unpostedDeltaMinor: 0, methodChanged: false }),
    stock_stocktake_open: ok({ session: { id: 'st_1' } }),
    stock_stocktake_report: ok({
      lines: [
        {
          lineId: 'ln_1',
          itemId: 'it_1',
          itemName: 'Schraube M4',
          locationId: 'loc_1',
          locationName: 'Hauptlager',
          bookQty: 3,
          countedQty: null,
          diffQty: null,
        },
      ],
    }),
    stock_move: ok({}),
    stock_stocktake_count: ok({}),
    stock_stocktake_commit: ok({}),
  };
}

/** Render the surface. `caps`, when given, drives the A24 padlocks; otherwise the tree is ALLOW_ALL. */
function renderSurface(
  transport: Transport,
  opts: { caps?: string[]; asked?: Array<{ action: string; input: Record<string, unknown> }> } = {},
) {
  const tree = (
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Inventory />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  if (opts.caps === undefined) return render(tree);
  const allowed = new Set(opts.caps);
  const capabilities: Capabilities = { whoami: null, can: (c) => allowed.has(c), refresh: () => undefined };
  return render(<CapabilitiesContext.Provider value={capabilities}>{tree}</CapabilitiesContext.Provider>);
}

describe('Inventory (Lager), the five states and the UX-pass remediations', () => {
  it('LOADING: the skeleton is a read in flight, not a default over an unwatched read', async () => {
    const transport = watchReads(neverSettles);
    renderSurface(transport);
    await transport.started('stock_on_hand');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('EMPTY: no stock-tracked items names the surface and links out to items (D00), never a dead end', async () => {
    const canned = baseCanned();
    canned.stock_on_hand = ok({ rows: [], locations: LOCATIONS, items: [] });
    renderSurface(fakeTransport(canned));
    expect(await screen.findByText(de.stock.empty)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: de.stock.empty_cta });
    expect(link).toHaveAttribute('href', '/items');
  });

  it('ERROR: a non-permission failure shows the retryable banner, and the retry re-reads', async () => {
    let attempt = 0;
    const canned = baseCanned();
    const transport = fakeTransport({
      ...canned,
      stock_on_hand: () => (attempt++ === 0 ? reject('store_busy') : (canned.stock_on_hand as RestResponse)),
    });
    renderSurface(transport);
    const alert = await screen.findByRole('alert');
    // The retry affordance is the first button in the banner (retry precedes "report this error").
    await userEvent.click(within(alert).getAllByRole('button')[0]);
    // After the retry the second read succeeds and the grid replaces the banner.
    expect(await screen.findByText('Hauptlager')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('DENIED: stock_on_hand refused renders the padlock panel, not a broken grid', async () => {
    const canned = baseCanned();
    canned.stock_on_hand = reject('permission_denied', {}, 403);
    renderSurface(fakeTransport(canned));
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.queryByText('Hauptlager')).not.toBeInTheDocument();
  });

  it('READY: the grid renders on-hand and the low-stock badge is a glyph AND a label', async () => {
    const { container } = renderSurface(fakeTransport(baseCanned()));
    expect(await screen.findByText('Schraube M4')).toBeInTheDocument();
    expect(screen.getByText('Hauptlager')).toBeInTheDocument();
    // The badge carries the ⚠ glyph AND the "Bestand niedrig" text, and an aria-label, never colour alone.
    const badge = container.querySelector('.inventory__badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('⚠');
    expect(badge?.textContent).toContain(de.stock.badge.low);
    expect(badge?.getAttribute('aria-label')).toBe(de.stock.badge.low);
  });

  it('PADLOCK: "Bewegung erfassen" is hidden without manage_master_data, shown with it', async () => {
    renderSurface(fakeTransport(baseCanned()), { caps: ['read_master_data'] });
    expect(await screen.findByText('Schraube M4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.stock.action.record_movement })).not.toBeInTheDocument();

    renderSurface(fakeTransport(baseCanned()), { caps: ['read_master_data', 'manage_master_data'] });
    expect(await screen.findAllByRole('button', { name: de.stock.action.record_movement })).not.toHaveLength(0);
  });

  it('PADLOCK: "Bewertung ausführen" is hidden without the post right', async () => {
    renderSurface(fakeTransport(baseCanned()), { caps: ['read_master_data', 'manage_master_data'] });
    await screen.findByText('Schraube M4');
    expect(screen.queryByRole('button', { name: de.stock.action.run_valuation })).not.toBeInTheDocument();
  });

  it('the valuation method select is labelled "Methode", not "Grund" (the mislabelled-select fix)', async () => {
    renderSurface(fakeTransport(baseCanned()));
    await screen.findByText('Schraube M4');
    const method = screen.getByLabelText(de.stock.method.label);
    expect(method.tagName).toBe('SELECT');
    // With the dialog closed there is no "Grund" (reason) control on the surface.
    expect(screen.queryByLabelText(de.stock.movement.reason_label)).not.toBeInTheDocument();
  });

  it('the movement dialog is a focus-trapping role=dialog with a correctly labelled reason select', async () => {
    renderSurface(fakeTransport(baseCanned()));
    await userEvent.click(await screen.findByRole('button', { name: de.stock.action.record_movement }));
    const dialog = await screen.findByRole('dialog', { name: de.stock.action.record_movement });
    // useFocusTrap lands focus INSIDE the dialog on open, never stranded on the body behind the scrim.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Inside the dialog the reason select IS labelled "Grund".
    expect(within(dialog).getByLabelText(de.stock.movement.reason_label).tagName).toBe('SELECT');
    // Escape closes it (the trap's onEscape).
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the Inventur freeze date is labelled with its own key, not "Buchbestand"', async () => {
    renderSurface(fakeTransport(baseCanned()));
    await screen.findByText('Schraube M4');
    const asOfInputs = screen.getAllByLabelText(de.stock.valuation.as_of);
    // The stocktake panel's own date picker is the last "Stichtag" field on the surface.
    await userEvent.type(asOfInputs[asOfInputs.length - 1], '2026-12-31');
    await userEvent.click(screen.getByRole('button', { name: de.stock.stocktake.open }));
    // The frozen line reads "Eingefroren am: ...", never "Buchbestand: <date>".
    expect(await screen.findByText(new RegExp(`^${de.stock.stocktake.frozen_at}:`))).toBeInTheDocument();
  });

  it('the Inventur commit waits for a synchronous confirm before stock_stocktake_commit fires (C4)', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    // A counted variance line, so the consequence sentence reports a real adjustment count.
    canned.stock_stocktake_report = ok({
      lines: [
        { lineId: 'ln_1', itemId: 'it_1', itemName: 'Schraube M4', locationId: 'loc_1', locationName: 'Hauptlager', bookQty: 3, countedQty: 2, diffQty: -1 },
      ],
    });
    renderSurface(fakeTransport(canned, asked));

    await screen.findByText('Schraube M4');
    const asOfInputs = screen.getAllByLabelText(de.stock.valuation.as_of);
    await userEvent.type(asOfInputs[asOfInputs.length - 1], '2026-12-31');
    await userEvent.click(screen.getByRole('button', { name: de.stock.stocktake.open }));
    await screen.findByText(new RegExp(`^${de.stock.stocktake.frozen_at}:`));

    // First click on "Differenzen buchen" opens the confirm and posts NOTHING.
    await userEvent.click(screen.getByRole('button', { name: de.stock.stocktake.commit }));
    expect(await screen.findByText(de.stock.stocktake.confirmTitle)).toBeInTheDocument();
    // The dialog carries the statutory consequence sentence (files the Inventar, OR 958c).
    expect(screen.getByText(/Bestandesnachweis nach OR 958c/)).toBeInTheDocument();
    expect(asked.some((a) => a.action === 'stock_stocktake_commit')).toBe(false);

    // Confirm in the dialog: now, and only now, the commit fires.
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: de.stock.stocktake.commit }));
    await waitFor(() => expect(asked.some((a) => a.action === 'stock_stocktake_commit')).toBe(true));
    const call = asked.find((a) => a.action === 'stock_stocktake_commit');
    expect(call?.input.sessionId).toBe('st_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });
});
