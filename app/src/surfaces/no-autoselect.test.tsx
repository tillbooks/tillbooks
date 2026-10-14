/**
 * The guard for DESIGN.md D152 rule 5, "a list never opens itself", over the eight list surfaces that
 * used to break it (the cognitive-load audit of 02.10.2026): each one selected its first row on load,
 * marked it `aria-current` and opened its detail, so a person landed on a receipt with Buchen showing,
 * a 551px Mahnlauf card above the run list, or a committed Inventur with greyed-out buttons, none of
 * which they had chosen.
 *
 * THE RULE, AS ASSERTED HERE. Each surface is mounted on its bare route with TWO rows in its list and
 * the test waits until both are on screen. Then:
 *   1. nothing inside the surface is `aria-current="true"` or `aria-selected="true"`, and
 *   2. no detail read went over the wire: the verb that loads ONE row's detail (a receipt, a run, a
 *      warehouse's locations, a session report, an item's lots, valuation or ledger) was never called,
 *      which is the behavioural proof that nothing was opened, not just that nothing was tinted.
 *
 * Each surface's own suite proves the other half (a deep link opens its row, a click opens the same
 * actions as before). This file holds the line across all eight, so a ninth refactor that brings back
 * `rows[0]?.id ?? null` as the default selection fails here by route name.
 *
 * `/creditor-payments` (the audit's money-path finding, 04.10.2026) is a TICK list, not a
 * master-detail, so it has its own block at the end: on load no payable is ticked, current, selected
 * or tinted, even with a bill due, and no run is created; a deep link marks its row current and
 * ticks nothing; a switch leaves no tick behind.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { I18nProvider } from '../i18n';
import { WorkspaceProvider, useWorkspace } from '../app/workspace';

import GoodsReceipt from './GoodsReceipt';
import Dunning from './Dunning';
import Warehouses from './Warehouses';
import CycleCounts from './CycleCounts';
import LotSerial from './LotSerial';
import InventoryValuation from './InventoryValuation';
import InventoryMovements from './InventoryMovements';
import Attention from './Attention';
import accountsFixture from './Accounts/list-accounts.fixture.json';
import CreditorPayments from './CreditorPayments';

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const ITEMS = ok({
  items: [
    { id: 'it_1', name: 'Erster Artikel', trackStock: true, trackingMode: 'lot' },
    { id: 'it_2', name: 'Zweiter Artikel', trackStock: true, trackingMode: 'lot' },
  ],
});

const LEVEL = (level: number) => ({
  level,
  daysOverdue: level * 10,
  minIntervalDays: 10,
  feeMinor: 0,
  bookFee: false,
  feeIncomeAccountId: null,
  taxCode: null,
  showInterest: false,
  interestBp: 500,
  templateKey: 'standard',
});

const RUN = (runId: string, runDate: string) => ({
  runId,
  runDate,
  status: 'proposed',
  itemCount: 1,
  debtorCount: 1,
  maxLevel: 1,
  feeEntryId: null,
  feeSkippedReason: null,
});

const RECEIPT = (id: string, number: string) => ({
  id,
  number,
  status: 'draft',
  poId: 'po_1',
  poNumber: 'PO-2026-0001',
  supplierName: 'Lieferant GmbH',
  receivedAt: '2026-03-04',
  lineCount: 1,
  valueRappen: 40000,
  overReceiptQty: 0,
});

const WAREHOUSE = (id: string, code: string) => ({
  id,
  code,
  name: `Lager ${code}`,
  description: null,
  city: null,
  isDefault: id === 'wh_1',
  active: true,
});

const SESSION = (id: string, type: string) => ({
  id,
  type,
  status: 'open',
  freezeAt: '2026-04-01',
  blindCount: false,
  progressPct: 0,
  totalLines: 1,
  countedLines: 0,
  reviewRequiredLines: 0,
});

const PENDENZ = (queueId: string, entityId: string, titleKey: string) => ({
  queueId,
  entityKind: queueId,
  entityId,
  titleKey,
  titleParams: {},
  since: '2026-08-01',
  urgency: 'open',
  deepLink: { route: '/dunning', params: { runId: entityId } },
});

interface Case {
  route: string;
  surface: () => ReactElement;
  canned: Record<string, RestResponse>;
  /** Text of the SECOND row: once it is on screen the whole list has rendered. */
  ready: string;
  /** The verbs that read ONE row's detail. None may run before the person opens a row. */
  detailReads: (call: { action: string; input: Record<string, unknown> }) => boolean;
  /** The deep link to the SECOND row (absent on the hub, whose rows navigate away). */
  deepLink?: string;
  /** Detail answers the deep-link cases need (the surfaces read the opened row). */
  details?: Record<string, RestResponse>;
}

const CASES: Case[] = [
  {
    route: '/goods-receipts',
    surface: () => <GoodsReceipt />,
    canned: {
      goods_receipt_list: ok({ goodsReceipts: [RECEIPT('gr_1', 'GR-2026-0001'), RECEIPT('gr_2', 'GR-2026-0002')] }),
      po_list: ok({ pos: [] }),
      list_items: ITEMS,
    },
    ready: 'GR-2026-0002',
    deepLink: 'focus=gr_2',
    detailReads: (c) => ['goods_receipt_get', 'goods_receipt_preview', 'po_get'].includes(c.action),
  },
  {
    route: '/dunning',
    surface: () => <Dunning />,
    canned: {
      get_dunning_config: ok({ levels: [1, 2, 3].map(LEVEL), configured: true, interestFloorBp: 500 }),
      list_dunning_runs: ok({ runs: [RUN('run_2', '2026-08-01'), RUN('run_1', '2026-07-16')], truncated: false }),
      list_saved_views: ok({ savedViews: [] }),
      list_accounts: ok(accountsFixture),
    },
    ready: '16.07.2026',
    deepLink: 'runId=run_1',
    details: {
      get_dunning_run: ok({ ...RUN('run_1', '2026-07-16'), createdAt: '2026-07-16T00:00:00.000Z', items: [], debtors: [] }),
    },
    detailReads: (c) => c.action === 'get_dunning_run' || c.action === 'get_dunning_pdf',
  },
  {
    route: '/warehouses',
    surface: () => <Warehouses />,
    canned: { warehouse_list: ok({ warehouses: [WAREHOUSE('wh_1', 'ZH-01'), WAREHOUSE('wh_2', 'BE-01')] }) },
    ready: 'BE-01',
    deepLink: 'focus=wh_2',
    detailReads: (c) => c.action === 'location_tree' || c.action === 'inventory_balance_by_location',
  },
  {
    route: '/cycle-counts',
    surface: () => <CycleCounts />,
    canned: { inventory_stocktake_list: ok({ sessions: [SESSION('cyc_1', 'full'), SESSION('cyc_2', 'cycle')], legacy: [] }) },
    ready: 'Zykluszählung',
    deepLink: 'focus=cyc_2',
    detailReads: (c) => c.action === 'inventory_stocktake_report',
  },
  {
    route: '/lot-serial-tracking',
    surface: () => <LotSerial />,
    canned: { list_items: ITEMS },
    ready: 'Zweiter Artikel',
    deepLink: 'focus=it_2',
    detailReads: (c) => c.action === 'lot_list' || c.action === 'serial_list',
  },
  {
    route: '/inventory-valuation',
    surface: () => <InventoryValuation />,
    canned: {
      list_items: ITEMS,
      inventory_valuation_methods: ok({ methods: [], defaultMethod: 'fifo', defaultEffectiveFrom: null }),
      inventory_valuation_method_history: ok({ assignments: [], total: 0 }),
      inventory_valuation_preview: ok({ items: [], totalValueMinor: 0, totalWriteDownMinor: 0 }),
    },
    ready: 'Zweiter Artikel',
    deepLink: 'focus=it_2',
    // The workspace roll-up is the same verb without `itemIds`; only a per-item read is a detail.
    detailReads: (c) => c.action === 'inventory_valuation_preview' && Array.isArray(c.input.itemIds),
  },
  {
    route: '/inventory-movements',
    surface: () => <InventoryMovements />,
    canned: {
      list_items: ITEMS,
      stock_on_hand: ok({ locations: [], rows: [], items: [] }),
      inventory_get_config: ok({ allowNegativeStock: false }),
    },
    ready: 'Zweiter Artikel',
    deepLink: 'focus=it_2',
    detailReads: (c) => c.action === 'inventory_movement_list' || c.action === 'inventory_balance',
  },
  {
    route: '/attention',
    surface: () => <Attention />,
    canned: {
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 2,
        incomplete: false,
        queues: [{ queueId: 'dunning_run', area: 'sales', count: 2, topUrgency: 'open' }],
        top: [
          PENDENZ('dunning_run', 'run_1', 'attention.item.dunningRun.title'),
          { ...PENDENZ('dunning_run', 'run_2', 'attention.item.dunningRun.title'), urgency: 'due' },
        ],
        failed: [],
      }),
    },
    ready: 'fällig',
    // The hub reads no per-row detail; opening a row navigates. Its proof is the aria-current check.
    detailReads: () => false,
  },
];

function transport(canned: Record<string, RestResponse>, asked: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked.push({ action, input: input ?? {} });
    return canned[action] ?? { status: 200, body: { ok: true } };
  };
}

describe('D152 rule 5: a list never opens itself, on every one of the eight list surfaces', () => {
  it('covers exactly the eight routes the audit named', () => {
    expect(CASES.map((c) => c.route)).toEqual([
      '/goods-receipts',
      '/dunning',
      '/warehouses',
      '/cycle-counts',
      '/lot-serial-tracking',
      '/inventory-valuation',
      '/inventory-movements',
      '/attention',
    ]);
  });

  for (const c of CASES) {
    it(`${c.route}: nothing is current or selected on load, and no row's detail is read`, async () => {
      const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
      const { container } = render(
        <TillClientProvider client={new TillClient(transport(c.canned, asked))}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_test">
              <MemoryRouter initialEntries={[c.route]}>{c.surface()}</MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>,
      );
      expect((await screen.findAllByText(c.ready, { exact: false })).length).toBeGreaterThan(0);
      expect(container.querySelector('[aria-current="true"], [aria-selected="true"]')).toBeNull();
      expect(asked.filter(c.detailReads).map((a) => a.action)).toEqual([]);
    });
  }
});

/** Navigates the SAME router while the surface stays mounted, and reports where it is. */
let go: (to: string) => void = () => undefined;
let where = '';
function Nav() {
  const navigate = useNavigate();
  const location = useLocation();
  go = (to: string) => navigate(to);
  where = `${location.pathname}${location.search}`;
  return null;
}

describe('D152 rule 5: a deep link is the person\'s act, also when it arrives while the surface is open (critic F2)', () => {
  for (const c of CASES.filter((x) => x.deepLink !== undefined)) {
    it(`${c.route}: a link that arrives while mounted opens its row; closing retires it; the same link opens it again`, async () => {
      const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
      const { container } = render(
        <TillClientProvider client={new TillClient(transport({ ...c.canned, ...c.details }, asked))}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_test">
              <MemoryRouter initialEntries={[c.route]}>
                <Nav />
                {c.surface()}
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>,
      );
      await screen.findAllByText(c.ready, { exact: false });
      const current = () => container.querySelector<HTMLElement>('[aria-current="true"]');
      expect(current()).toBeNull();

      act(() => go(`${c.route}?${c.deepLink}`));
      await waitFor(() => expect(current()?.textContent ?? '').toContain(c.ready));

      // The person closes it: the link is retired (the URL drops it), and nothing re-opens it.
      await userEvent.click(current() as HTMLElement);
      await waitFor(() => expect(current()).toBeNull());
      expect(where).toBe(c.route);

      // Following the same link again opens the same row again.
      act(() => go(`${c.route}?${c.deepLink}`));
      await waitFor(() => expect(current()?.textContent ?? '').toContain(c.ready));
    });
  }
});

/** Switches the active workspace while the surface stays mounted, as the shell's switcher does. */
let switchTo: (id: string) => void = () => undefined;
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = (id: string) => setWorkspaceId(id);
  return null;
}

describe('§H-TENANT: nothing opened in one workspace survives a switch to the next (critic round 2)', () => {
  for (const c of CASES) {
    it(`${c.route}: the open row, its pane and its reads stay behind when the workspace changes`, async () => {
      const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
      // The SAME ids answer in both workspaces: the hardest case, where a surviving selection would
      // resolve to a different tenant's record of the same id.
      const { container } = render(
        <TillClientProvider client={new TillClient(transport({ ...c.canned, ...c.details }, asked))}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_1">
              <MemoryRouter initialEntries={[c.deepLink === undefined ? c.route : `${c.route}?${c.deepLink}`]}>
                <Switcher />
                {c.surface()}
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>,
      );
      await screen.findAllByText(c.ready, { exact: false });
      const current = () => container.querySelector<HTMLElement>('[aria-current="true"]');
      if (c.deepLink !== undefined) {
        await waitFor(() => expect(current()?.textContent ?? '').toContain(c.ready));
      } else {
        // The hub: the person focuses a row, which makes it current.
        const rows = [...container.querySelectorAll<HTMLButtonElement>('.att-row-open')];
        act(() => rows[1].focus());
        await waitFor(() => expect(current()).not.toBeNull());
      }

      act(() => switchTo('ws_2'));
      await waitFor(() => expect(asked.some((a) => a.input.workspaceId === 'ws_2')).toBe(true));
      await screen.findAllByText(c.ready, { exact: false });
      expect(current()).toBeNull();
      // No row's detail was ever asked for under the new workspace: the old selection never ran there.
      expect(asked.filter((a) => a.input.workspaceId === 'ws_2').filter(c.detailReads).map((a) => a.action)).toEqual([]);
    });
  }
});

/**
 * `/creditor-payments`: the pain.001 run must hold only what the person ticked. The bill below is
 * long due, so the surface's suggestion line names it; that may never tick it.
 */
describe('D152 rule 5 on the money path: /creditor-payments ticks nothing for the person', () => {
  const PAYABLE = (billId: string, vendorName: string, dueDate: string) => ({
    billId,
    vendorId: 'contact_1',
    vendorName,
    currency: 'CHF',
    amountMinor: 48000,
    dueDate,
    vendorReference: null,
    hasCreditorProfile: true,
    creditorIban: 'CH9300762011623852957',
    creditorIbanMasked: '•••• 5295',
    isQrIban: false,
    referenceKind: 'free_text',
    referenceValid: true,
    batchable: true,
    alreadyBatchedInto: null,
  });
  const canned: Record<string, RestResponse> = {
    list_payable: ok({
      items: [PAYABLE('vb_1', 'Stadtwerke Probe', '2026-09-04'), PAYABLE('vb_2', 'Zweiter Kreditor AG', '2026-09-05')],
      total: 2,
      baseCurrency: 'CHF',
    }),
    list_bank_accounts: ok({
      bankAccounts: [{ id: 'ba_1', name: 'Hauptkonto CHF', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', receiveOnly: false, archived: false }],
    }),
  };
  const writes = (a: { action: string }) => a.action === 'create_payment_batch' || a.action === 'generate_pain001';

  function mountAt(entry: string, asked: Array<{ action: string; input: Record<string, unknown> }>) {
    return render(
      <TillClientProvider client={new TillClient(transport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <MemoryRouter initialEntries={[entry]}>
              <Switcher />
              <CreditorPayments />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
  }
  const chosen = (root: HTMLElement) =>
    root.querySelector('tbody [aria-current="true"], tbody [aria-selected="true"], tbody tr[data-selected], tbody input[type="checkbox"]:checked');

  it('/creditor-payments: on load nothing is ticked, current, selected or tinted, and no run is created', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const { container } = mountAt('/creditor-payments', asked);
    await screen.findByText('Zweiter Kreditor AG');
    // The suggestion names the due bills; it is not a tick.
    expect(screen.getByText(/^Vorschlag: 2 Zahlungen fällig/)).toBeTruthy();
    expect(chosen(container)).toBeNull();
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'pain.001 generieren' })).toBeDisabled();
    expect(asked.filter(writes)).toEqual([]);
  });

  it('/creditor-payments: a deep link marks its row current and ticks nothing', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const { container } = mountAt('/creditor-payments?focus=vb_2', asked);
    await screen.findByText('Zweiter Kreditor AG');
    expect(container.querySelector('tr[aria-current="true"]')?.textContent ?? '').toContain('Zweiter Kreditor AG');
    expect(container.querySelector('tbody input[type="checkbox"]:checked')).toBeNull();
    expect(asked.filter(writes)).toEqual([]);
  });

  it('/creditor-payments: a tick made in one workspace is gone after a switch', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const { container } = mountAt('/creditor-payments', asked);
    await screen.findByText('Zweiter Kreditor AG');
    await userEvent.click(screen.getByRole('checkbox', { name: /Zweiter Kreditor AG/ }));
    expect(container.querySelector('tbody input[type="checkbox"]:checked')).not.toBeNull();
    act(() => switchTo('ws_2'));
    await waitFor(() => expect(asked.some((a) => a.input.workspaceId === 'ws_2')).toBe(true));
    await screen.findByText('Zweiter Kreditor AG');
    expect(chosen(container)).toBeNull();
    expect(asked.filter(writes)).toEqual([]);
  });
});
