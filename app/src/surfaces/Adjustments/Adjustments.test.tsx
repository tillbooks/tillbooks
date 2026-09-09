/**
 * J05, the Inventory -> Adjustments / Bestandeskorrekturen surface. The suite follows the Studio
 * discipline: a transport answers `whoami`, the adjustment list, the active reason list and the item /
 * location pickers, and copy is read from the message fragment, never typed here. The money-path claim
 * the UI must not break is that a post goes through `inventory_adjust` and a reverse through
 * `inventory_adjust_reverse`, each carrying a reason and an idempotency key.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import Adjustments from './index';
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

const ADJ = (over: Record<string, unknown> = {}) => ({
  id: 'adj_1',
  batchId: null,
  itemId: 'it_1',
  itemName: 'Widget',
  locationId: 'loc_a',
  locationName: 'Lager A',
  qtyDelta: -7,
  reasonCode: 'SCHWUND',
  reasonName: 'Schwund',
  reasonCategory: 'shrinkage',
  note: null,
  unitCostMinor: null,
  effectiveDate: '2026-03-05',
  reversesAdjustmentId: null,
  reversedByAdjustmentId: null,
  ...over,
});

const REASON = (over: Record<string, unknown> = {}) => ({
  id: 'rsn_1',
  code: 'SCHWUND',
  name: 'Schwund',
  requiresNote: false,
  isActive: true,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  inventory_adjust_list: ok({ items: [ADJ()], total: 1, limit: 200, offset: 0 }),
  inventory_reason_list: ok({ reasons: [REASON()] }),
  list_items: ok({ items: [{ id: 'it_1', name: 'Widget' }] }),
  location_list: ok({ locations: [{ id: 'loc_a', name: 'Lager A' }] }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Adjustments />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Adjustments, the reason-coded adjustment ledger', () => {
  it('lists an adjustment with its signed quantity and reason', async () => {
    renderSurface(baseCanned());
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument());
    expect(screen.getByText('-7')).toBeInTheDocument();
    expect(screen.getByText('SCHWUND')).toBeInTheDocument();
  });

  it('posts a new adjustment through inventory_adjust', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_adjust = ok({ adjustment: ADJ({ id: 'adj_2' }), movement: { id: 'mv_1' }, onHandAfter: 5 });
    renderSurface(canned, asked);

    await screen.findByText('Widget');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.new }));
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.item), 'it_1');
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.location), 'loc_a');
    await userEvent.type(screen.getByLabelText(de.adjustments.form.qty), '-7');
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.reason), 'rsn_1');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.post }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_adjust')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_adjust');
    expect(call?.input.itemId).toBe('it_1');
    expect(call?.input.locationId).toBe('loc_a');
    expect(call?.input.qtyDelta).toBe(-7);
    expect(call?.input.reasonCodeId).toBe('rsn_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('reverses an adjustment through inventory_adjust_reverse', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_adjust_reverse = ok({ reversals: [ADJ({ id: 'adj_r', qtyDelta: 7, reversesAdjustmentId: 'adj_1' })], count: 1 });
    renderSurface(canned, asked);

    await screen.findByText('Widget');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.reverse }));
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.reverseForm.reason), 'rsn_1');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.reverseForm.confirm }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_adjust_reverse')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_adjust_reverse');
    expect(call?.input.adjustmentId).toBe('adj_1');
    expect(call?.input.reasonCodeId).toBe('rsn_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('surfaces insufficient_stock with the surface-scoped message', async () => {
    const canned = baseCanned();
    canned.inventory_adjust = reject('insufficient_stock', { available: 3, requested: -7 });
    renderSurface(canned);

    await screen.findByText('Widget');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.new }));
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.item), 'it_1');
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.location), 'loc_a');
    await userEvent.type(screen.getByLabelText(de.adjustments.form.qty), '-7');
    await userEvent.selectOptions(screen.getByLabelText(de.adjustments.form.reason), 'rsn_1');
    await userEvent.click(screen.getByRole('button', { name: de.adjustments.post }));

    expect(await screen.findByText(de.adjustments.errors.insufficient_stock)).toBeInTheDocument();
  });
});
