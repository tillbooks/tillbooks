/**
 * CRITIC PROBES, round 3 (D59, non-author) for claude/cl-no-autoselect at 76069977: the workspace
 * switch resets. Questions probed: does the render-time reset ever fire WITHOUT a switch, does a write
 * answered after a switch paint anything, and what a multi-step line submit leaves behind when the
 * switch lands between its steps.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { I18nProvider } from '../i18n';
import { WorkspaceProvider, useWorkspace } from '../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../lib/capabilities';
import GoodsReceipt from './GoodsReceipt';
import Dunning from './Dunning';
import Warehouses from './Warehouses';
import accountsFixture from './Accounts/list-accounts.fixture.json';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;
type Asked = Array<{ action: string; input: Record<string, unknown> }>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function transport(canned: Canned, asked: Asked): Transport {
  return async (action, input) => {
    asked.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'custom', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let switchTo: ((id: string) => void) | null = null;
function Harness() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = (id) => setWorkspaceId(id);
  return null;
}

function mount(surface: ReactElement, canned: Canned, asked: Asked, path: string, held: readonly string[]) {
  const tree = (
    <CapabilitiesContext.Provider value={caps(held)}>
      <TillClientProvider client={new TillClient(transport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <MemoryRouter initialEntries={[path]}>
              <Harness />
              {surface}
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>
  );
  return render(tree);
}

const ROW = (id: string, number: string) => ({
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
const DETAIL = (id: string, number: string) => ({
  goodsReceipt: { id, number, status: 'draft', poId: 'po_1', receivedAt: '2026-03-04', note: null, hasOverReceipt: false, lines: [], events: [] },
});
const PREVIEW = { valueRappen: 40000, postable: true, issues: [], lines: [] };

describe('critic round 3: the reset fires on a switch and only on a switch', () => {
  it('re-selecting the SAME workspace and re-renders from writes do not close the open receipt', async () => {
    const asked: Asked = [];
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: ok({ goodsReceipts: [ROW('gr_1', 'GR-1'), ROW('gr_2', 'GR-2')] }),
        goods_receipt_get: (i) => ok(DETAIL(String(i.grId), i.grId === 'gr_1' ? 'GR-1' : 'GR-2')),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
        goods_receipt_cancel: ok({}),
      },
      asked,
      '/goods-receipts',
      ['read_master_data', 'manage_master_data'],
    );
    await userEvent.click(await screen.findByRole('row', { name: /GR-1/ }));
    expect(await screen.findByRole('heading', { name: 'GR-1' })).toBeInTheDocument();
    act(() => switchTo?.('ws_a'));
    // A write and its refresh re-render the surface many times: the row stays open.
    await userEvent.click(screen.getByRole('button', { name: 'Wareneingang verwerfen' }));
    await waitFor(() => expect(asked.filter((a) => a.action === 'goods_receipt_get').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('heading', { name: 'GR-1' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /GR-1/ })).toHaveAttribute('aria-current', 'true');
  });

  it('a warehouse opened in ws_a closes on a switch to ws_b, and the same list in ws_b opens nothing', async () => {
    const asked: Asked = [];
    const WH = (id: string, code: string) => ({ id, code, name: `Lager ${code}`, description: null, city: null, isDefault: false, active: true });
    mount(
      <Warehouses />,
      {
        warehouse_list: (i) => ok({ warehouses: i.workspaceId === 'ws_a' ? [WH('wh_1', 'ZH-01')] : [WH('wh_9', 'BE-09')] }),
        location_tree: ok({ nodes: [] }),
        inventory_balance_by_location: ok({ rows: [] }),
      },
      asked,
      '/warehouses',
      ['read_master_data', 'manage_master_data'],
    );
    await userEvent.click(await screen.findByRole('row', { name: /ZH-01/ }));
    await waitFor(() => expect(asked.some((a) => a.action === 'location_tree')).toBe(true));
    act(() => switchTo?.('ws_b'));
    await screen.findByRole('row', { name: /BE-09/ });
    expect(screen.queryByText('Lager ZH-01')).toBeNull();
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(asked.filter((a) => a.action === 'location_tree' && a.input.workspaceId === 'ws_b')).toEqual([]);
  });
});

describe('critic round 3: answers that return after a switch', () => {
  it('/dunning: an Ausstellen answered after the switch paints nothing and re-reads nothing in ws_a', async () => {
    const asked: Asked = [];
    const slowIssue = deferred<RestResponse>();
    const LEVELS = [1, 2, 3].map((level) => ({
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
    }));
    const SUM = (runId: string, runDate: string, status: string) => ({
      runId,
      runDate,
      status,
      itemCount: 1,
      debtorCount: 1,
      maxLevel: 1,
      feeEntryId: null,
      feeSkippedReason: null,
      issuedAt: null,
      sentAt: null,
    });
    mount(
      <Dunning />,
      {
        get_dunning_config: ok({ levels: LEVELS, configured: true, interestFloorBp: 500 }),
        list_saved_views: ok({ savedViews: [] }),
        list_accounts: ok(accountsFixture),
        list_dunning_runs: (i) => ok({ runs: i.workspaceId === 'ws_a' ? [SUM('run_a', '2026-07-16', 'proposed')] : [SUM('run_b', '2026-06-16', 'issued')], truncated: false }),
        get_dunning_run: (i) =>
          i.workspaceId === 'ws_a' && i.runId === 'run_a'
            ? ok({ ...SUM('run_a', '2026-07-16', 'proposed'), createdAt: '2026-07-16T00:00:00.000Z', items: [], debtors: [] })
            : { status: 404, body: { ok: false, error: 'not_found' } },
        issue_dunning_run: () => slowIssue.promise,
      },
      asked,
      '/dunning?runId=run_a',
      ['read_sales', 'dun', 'post', 'send'],
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(asked.filter((a) => a.action === 'issue_dunning_run')).toHaveLength(1));
    expect(asked.find((a) => a.action === 'issue_dunning_run')?.input).toMatchObject({ workspaceId: 'ws_a', runId: 'run_a' });
    act(() => switchTo?.('ws_b'));
    await screen.findByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' });
    const before = asked.length;
    await act(async () => {
      slowIssue.resolve(ok({ ...SUM('run_a', '2026-07-16', 'issued'), feeSkippedReason: 'period_locked' }));
      await slowIssue.promise;
    });
    // No note from ws_a's answer, no card, and no re-read fired for the workspace just left.
    expect(screen.queryByTestId('dunning-current')).toBeNull();
    expect(screen.queryByRole('row', { name: 'Mahnlauf vom 16.07.2026 öffnen' })).toBeNull();
    expect(asked.slice(before).filter((a) => a.input.workspaceId === 'ws_a')).toEqual([]);
  });

  /**
   * FINDING (LOW, behaviour change, measured): a line submit that mints a lot first, then adds the
   * line, STOPS after the lot when a switch lands between the two steps. The lot exists in ws_a, the
   * line does not, and nothing tells the person. At e0d3db68 the closure carried ws_a, so the add ran
   * in ws_a and the person's act completed. The state left behind is the one the surface already
   * handles on a failed add (the lot is offered in the picker on return), and it carries no movement
   * and no figure, so it is recorded, not failed.
   */
  // FIXED (A6, round 3): the submit is one act in the workspace it was made in. Its remaining steps run
  // under ws_a; only what the person would see is suppressed under ws_b. Adjusted from the measured
  // "the add never runs" to the fixed behaviour.
  it('a switch between the lot mint and the line add: the add still runs in ws_a, and ws_b shows nothing of it', async () => {
    const asked: Asked = [];
    const slowLot = deferred<RestResponse>();
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: (i) => ok({ goodsReceipts: i.workspaceId === 'ws_a' ? [ROW('gr_1', 'GR-1')] : [] }),
        goods_receipt_get: ok(DETAIL('gr_1', 'GR-1')),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [{ id: 'pol_1', itemId: 'it_1', description: 'Rohstoff', openQty: 6 }] }),
        list_items: ok({ items: [{ id: 'it_1', name: 'Rohstoff', trackStock: true }] }),
        lot_list: ok({ lots: [] }),
        serial_list: ok({ serials: [] }),
        lot_create: () => slowLot.promise,
        goods_receipt_upsert_lines: ok({}),
      },
      asked,
      '/goods-receipts?focus=gr_1',
      ['read_master_data', 'manage_master_data'],
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Position hinzufügen' }));
    await userEvent.type(await screen.findByLabelText('Neue Chargennummer'), 'L-100');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(asked.filter((a) => a.action === 'lot_create')).toHaveLength(1));
    expect(asked.find((a) => a.action === 'lot_create')?.input).toMatchObject({ workspaceId: 'ws_a', number: 'L-100' });
    act(() => switchTo?.('ws_b'));
    await act(async () => {
      slowLot.resolve(ok({ lot: { id: 'lot_1', number: 'L-100' } }));
      await slowLot.promise;
    });
    // The person's act completes where it was made: the line add goes out under ws_a, naming the lot.
    await waitFor(() => expect(asked.filter((a) => a.action === 'goods_receipt_upsert_lines')).toHaveLength(1));
    const add = asked.find((a) => a.action === 'goods_receipt_upsert_lines')?.input as Record<string, unknown>;
    expect(add).toMatchObject({ workspaceId: 'ws_a', grId: 'gr_1' });
    expect((add.ops as Array<Record<string, unknown>>)[0]).toMatchObject({ op: 'add', poLineId: 'pol_1', lotId: 'lot_1' });
    await new Promise((r) => setTimeout(r, 50));
    // Nothing of it shows under ws_b: no ws_a re-read after the mint, no banner, the drawer gone.
    const afterMint = asked.slice(asked.findIndex((a) => a.action === 'lot_create') + 1);
    expect(afterMint.filter((a) => a.input.workspaceId === 'ws_a' && a.action !== 'goods_receipt_upsert_lines')).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText('Neue Chargennummer')).toBeNull();
  });
});
