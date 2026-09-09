/**
 * J03, the Inventory -> Bewertung surface. The suite follows the Studio discipline: a transport
 * answers `whoami` and the reads, loading is asserted through rendered content rather than through a
 * spinner, and every string it looks for is read from the message fragment, never typed here.
 *
 * What it holds beyond "the page renders": the layer table appears only when there are layers, the
 * as-of picker really re-runs the pure read at the date the operator chose, the net-realisable-value
 * field reaches the engine as a per-item map (which is where an OR 960c write-down comes from), a
 * dated default change sends `effectiveFrom` (the field the period lock answers to), and the engine's
 * refusals arrive as readable copy instead of a generic failure.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import InventoryValuation from './index';
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

const ITEM = { id: 'it_1', name: 'Widget', trackStock: true };

const METHODS = ok({
  methods: [
    { method: 'weighted_average', enabled: true, requiresStandardCost: false, isDefault: false },
    { method: 'fifo', enabled: true, requiresStandardCost: false, isDefault: true },
    { method: 'standard_cost', enabled: false, requiresStandardCost: true, isDefault: false },
  ],
  defaultMethod: 'fifo',
  defaultSource: 'workspace',
  defaultEffectiveFrom: '2026-01-01',
});

const ROW = (over: Record<string, unknown> = {}) => ({
  itemId: 'it_1',
  itemName: 'Widget',
  method: 'fifo',
  methodSource: 'workspace',
  methodEffectiveFrom: '2026-01-01',
  qtyOnHand: 70,
  costedQty: 70,
  uncostedQty: 0,
  unitCostMinor: 1200,
  totalValueMinor: 84_000,
  layers: [{ sourceMovementId: 'mv_2', receiptDate: '2026-01-05', originalQty: 80, remainingQty: 70, unitCostMinor: 1200 }],
  lcmApplied: false,
  writeDownMinor: 0,
  varianceMinor: null,
  reason: null,
  warnings: [],
  missingCostMovementIds: [],
  valuationBasis: 'direct',
  ...over,
});

const baseCanned = (): Canned => ({
  whoami: ok({
    actor: 'studio',
    role: null,
    isMember: true,
    provisioned: true,
    memberId: 'm1',
    userId: 'u1',
    capabilities: ['read_master_data', 'manage_master_data'],
  }),
  list_items: ok({ items: [ITEM] }),
  inventory_valuation_methods: METHODS,
  inventory_valuation_method_history: ok({
    assignments: [
      {
        id: 'iv_1',
        scope: 'workspace',
        itemId: null,
        method: 'fifo',
        effectiveFrom: '2026-01-01',
        reason: 'Umstellung per Jahresbeginn',
        forceRevaluation: false,
        createdBy: 'studio',
      },
    ],
    total: 1,
  }),
  inventory_valuation_preview: ok({ asOf: null, items: [ROW()], totalValueMinor: 84_000, totalWriteDownMinor: 0 }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <InventoryValuation />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('InventoryValuation, the balance-sheet figure and the basis behind it', () => {
  it('renders the method registry, the item value and its FIFO layers', async () => {
    renderSurface(baseCanned());
    const widget = await screen.findByRole('button', { name: 'Widget' });

    // The methods come from the engine's own registry read, including the one that is off.
    expect(screen.getByText(de.invValuation.methodDesc.standard_cost)).toBeInTheDocument();
    // The default in force is stated with the date it started: Stetigkeit without opening the
    // history. (The same date also appears in the history table below, hence the scoped query.)
    expect(screen.getByText(/2026-01-01/, { selector: '.iv-muted' })).toHaveTextContent(de.invValuation.method.fifo);
    // The workspace total, formatted as money rather than raw Rappen, shows before any item is opened.
    await waitFor(() => expect(screen.getAllByText('CHF 840.00').length).toBeGreaterThan(0));

    // Opening the item loads its costing detail: the value, formatted as money, and its FIFO layer
    // table (which renders only because the row carried a layer).
    await userEvent.click(widget);
    expect(await screen.findByText(de.invValuation.layers.title)).toBeInTheDocument();
    expect(screen.getByText('2026-01-05')).toBeInTheDocument();
    // The item value, the single layer's value and the workspace total all read CHF 840.00 here.
    expect(screen.getAllByText('CHF 840.00').length).toBeGreaterThan(0);
  });

  it('hides the layer table for a method that has no layers', async () => {
    const canned = baseCanned();
    canned.inventory_valuation_preview = ok({
      items: [ROW({ method: 'weighted_average', layers: [] })],
      totalValueMinor: 84_000,
      totalWriteDownMinor: 0,
    });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });
    await waitFor(() => expect(screen.queryByText(de.invValuation.layers.title)).not.toBeInTheDocument());
  });

  it('re-runs the pure preview at the as-of date the operator picks', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByRole('button', { name: 'Widget' });

    // A date input is committed in one go by a real picker, and `userEvent.type` on one fires a
    // change per character, so each keystroke would re-run the preview. That is not what a user does
    // and it is what made this assertion timing-sensitive under load: one commit, one read.
    fireEvent.change(screen.getByLabelText(de.invValuation.asOf), { target: { value: '2026-06-30' } });

    await waitFor(() => {
      const dated = asked.filter((a) => a.action === 'inventory_valuation_preview' && a.input.asOf === '2026-06-30');
      expect(dated.length).toBeGreaterThan(0);
    });
    const call = asked.filter((a) => a.action === 'inventory_valuation_preview' && a.input.asOf === '2026-06-30').at(-1);
    expect(call?.input.itemIds).toEqual(['it_1']);
  });

  it('sends the net realisable value as a per-item map and shows the write-down', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_valuation_preview = (input) =>
      input.netRealisableValues === undefined
        ? ok({ items: [ROW()], totalValueMinor: 84_000, totalWriteDownMinor: 0 })
        : ok({
            items: [ROW({ lcmApplied: true, unitCostMinor: 900, totalValueMinor: 63_000, writeDownMinor: 21_000 })],
            totalValueMinor: 63_000,
            totalWriteDownMinor: 21_000,
          });
    renderSurface(canned, asked);
    await screen.findByRole('button', { name: 'Widget' });

    // One commit, for the same reason: typing "900" a character at a time would fire three previews
    // and assert against whichever one happened to land first.
    fireEvent.change(screen.getByLabelText(de.invValuation.netRealisableValue), { target: { value: '900' } });

    await waitFor(() => expect(screen.getByText(de.invValuation.lcmApplied)).toBeInTheDocument());
    const withNrv = asked.filter((a) => a.action === 'inventory_valuation_preview' && a.input.netRealisableValues !== undefined).at(-1);
    expect(withNrv?.input.netRealisableValues).toEqual({ it_1: 900 });
    expect(screen.getByText('CHF 210.00')).toBeInTheDocument();
  });

  it('changes the default method with the effectiveFrom the period lock answers to', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_valuation_set_default = ok({ assignment: { id: 'iv_2' } });
    renderSurface(canned, asked);
    await screen.findByRole('button', { name: 'Widget' });

    await userEvent.click(screen.getByRole('button', { name: de.invValuation.changeDefault }));
    await screen.findByRole('dialog', { name: de.invValuation.form.defaultTitle });
    await userEvent.selectOptions(screen.getByLabelText(de.invValuation.col.method), 'weighted_average');
    fireEvent.change(screen.getByLabelText(de.invValuation.effectiveFrom), { target: { value: '2026-07-01' } });
    await userEvent.type(screen.getByLabelText(de.invValuation.history.reason), 'Neue Politik');
    await userEvent.click(screen.getByRole('button', { name: de.invValuation.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_valuation_set_default')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_valuation_set_default');
    expect(call?.input.method).toBe('weighted_average');
    expect(call?.input.effectiveFrom).toBe('2026-07-01');
    expect(call?.input.reason).toBe('Neue Politik');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('surfaces period_locked in the operator vocabulary rather than swallowing it', async () => {
    const canned = baseCanned();
    canned.inventory_valuation_set_default = reject('period_locked', { period: '2025', kind: 'hard' });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });

    await userEvent.click(screen.getByRole('button', { name: de.invValuation.changeDefault }));
    await screen.findByRole('dialog', { name: de.invValuation.form.defaultTitle });
    await userEvent.click(screen.getByRole('button', { name: de.invValuation.save }));

    expect(await screen.findAllByText(de.invValuation.errors.period_locked)).not.toHaveLength(0);
  });

  it('reports a refusal to disable the method that is currently the default', async () => {
    const canned = baseCanned();
    canned.inventory_valuation_method_set_enabled = reject('method_is_default', { method: 'fifo' });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });

    await userEvent.click(screen.getByLabelText(de.invValuation.enableAria.replace('{method}', de.invValuation.method.fifo)));
    expect(await screen.findByText(de.invValuation.errors.method_is_default)).toBeInTheDocument();
  });

  it('marks an allocated figure as a share, and names the uncosted movements', async () => {
    // An allocated weighted-average figure is a share of the item's pooled total, not a valuation of
    // that location's own goods. A reader who does not know that would compare it against that
    // location's purchase invoices and find a gap that is not there.
    const canned = baseCanned();
    canned.inventory_valuation_preview = ok({
      items: [
        ROW({
          method: 'weighted_average',
          layers: [],
          valuationBasis: 'allocated',
          warnings: ['missing_unit_cost'],
          uncostedQty: 12,
          missingCostMovementIds: ['stockmv_7', 'stockmv_9'],
        }),
      ],
      totalValueMinor: 84_000,
      totalWriteDownMinor: 0,
    });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });

    expect(await screen.findByText(de.invValuation.basis.allocated)).toBeInTheDocument();
    // The warning names the rows, which is the diagnostic that makes a light figure explicable.
    expect(screen.getByText('stockmv_7, stockmv_9')).toBeInTheDocument();
  });

  it('explains a zero-quantity valuation instead of showing a bare zero', async () => {
    const canned = baseCanned();
    canned.inventory_valuation_preview = ok({
      items: [ROW({ qtyOnHand: 0, costedQty: 0, totalValueMinor: 0, layers: [], reason: 'zero_quantity' })],
      totalValueMinor: 0,
      totalWriteDownMinor: 0,
    });
    renderSurface(canned);
    await screen.findByRole('button', { name: 'Widget' });
    expect(await screen.findByText(de.invValuation.reason.zero_quantity)).toBeInTheDocument();
  });

  it('shows the permission-denied state when the item read is refused', async () => {
    // The Studio capability gate fails open by design (ALLOW_ALL without a provider), so the real
    // denied path a surface handles is the engine refusing the read.
    const canned = baseCanned();
    canned.list_items = reject('permission_denied', {}, 403);
    renderSurface(canned);
    await waitFor(() => expect(screen.queryByRole('button', { name: de.invValuation.changeDefault })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Widget' })).not.toBeInTheDocument();
  });
});
