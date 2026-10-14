/**
 * CRITIC PROBES, round 2 (D59, non-author) for claude/cl-no-autoselect at 660e3aa0: the F1/F2/F3
 * fixes. Each probe asserts the behaviour the critic expects; one that documents a defect still
 * standing is written as `it.fails` (it passes while the defect exists and turns red once fixed).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { I18nProvider } from '../i18n';
import { WorkspaceProvider, useWorkspace } from '../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../lib/capabilities';
import GoodsReceipt from './GoodsReceipt';
import Dunning from './Dunning';
import accountsFixture from './Accounts/list-accounts.fixture.json';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;
type Asked = Array<{ action: string; input: Record<string, unknown> }>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const notFound = (): RestResponse => ({ status: 404, body: { ok: false, error: 'not_found' } });

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

let go: ((to: string | number) => void) | null = null;
let switchTo: ((id: string) => void) | null = null;
let where = '';
function Harness() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setWorkspaceId } = useWorkspace();
  go = (to) => (typeof to === 'number' ? navigate(to) : navigate(to));
  switchTo = (id) => setWorkspaceId(id);
  where = `${location.pathname}${location.search}`;
  return null;
}

function mount(surface: ReactElement, canned: Canned, asked: Asked, entries: string[], held: readonly string[]) {
  return render(
    <CapabilitiesContext.Provider value={caps(held)}>
      <TillClientProvider client={new TillClient(transport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
              <Harness />
              {surface}
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

// ---------------------------------------------------------------- dunning

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
const SUMMARY = (runId: string, runDate: string, status = 'proposed') => ({
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
const RUN = (runId: string, runDate: string, status = 'proposed') => ({
  ...SUMMARY(runId, runDate, status),
  createdAt: `${runDate}T00:00:00.000Z`,
  items: [],
  debtors: [],
});

/**
 * Two tenants. `run_a` lives in ws_a only (16.07.2026); `run_b` in ws_b only (16.06.2026). Every read
 * is scoped by workspace exactly as the engine's `readRun` is (`WHERE workspace_id = ? AND id = ?`).
 */
function twoTenants(state: { created: boolean }): Canned {
  return {
    get_dunning_config: ok({ levels: LEVELS, configured: true, interestFloorBp: 500 }),
    list_saved_views: ok({ savedViews: [] }),
    list_accounts: ok(accountsFixture),
    list_dunning_runs: (i) =>
      ok({
        runs: i.workspaceId === 'ws_a' ? (state.created ? [SUMMARY('run_a', '2026-07-16')] : []) : [SUMMARY('run_b', '2026-06-16', 'issued')],
        truncated: false,
      }),
    get_dunning_run: (i) =>
      i.workspaceId === 'ws_a' && i.runId === 'run_a'
        ? ok(RUN('run_a', '2026-07-16'))
        : i.workspaceId === 'ws_b' && i.runId === 'run_b'
          ? ok(RUN('run_b', '2026-06-16', 'issued'))
          : notFound(),
    propose_dunning_run: (i) => {
      if (i.workspaceId !== 'ws_a') return ok({ runId: null });
      state.created = true;
      return ok(RUN('run_a', '2026-07-16'));
    },
    issue_dunning_run: (i) => (i.workspaceId === 'ws_a' && i.runId === 'run_a' ? ok(RUN('run_a', '2026-07-16', 'issued')) : notFound()),
  };
}

describe('critic round 2: /dunning, F3 by-id open and the workspace boundary', () => {
  /**
   * FINDING (F3 regression): the by-id exception (`proposedRef`) survives a workspace switch. The
   * re-read in the new workspace asks for the OLD workspace's run by id, the engine correctly answers
   * not_found, and `load` keeps the previous `current` on an error. The card of ws_a's run stays on
   * screen under ws_b, with the "outside the chosen view" note and a live Ausstellen.
   */
  // FIXED (A6 round 2): a switch resets the selection, the card, the note and the by-id exception,
  // and a failed run read clears the card. Flipped from `it.fails`.
  it('after a propose, switching workspace never leaves the old workspace run on screen', async () => {
    const asked: Asked = [];
    mount(<Dunning />, twoTenants({ created: false }), asked, ['/dunning'], ['read_sales', 'dun', 'post', 'send']);
    await userEvent.click(await screen.findByRole('button', { name: 'Mahnlauf vorschlagen' }));
    expect(await screen.findByTestId('dunning-current')).toHaveTextContent('16.07.2026');

    act(() => switchTo?.('ws_b'));
    // ws_b's own list has rendered: its run is listed.
    await screen.findByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' });
    // ws_a's run must be gone.
    await waitFor(() => expect(screen.queryByTestId('dunning-current')).toBeNull(), { timeout: 1000 });
  });

  it('a hub deep link to another workspace run (?runId=) still opens nothing', async () => {
    const asked: Asked = [];
    mount(<Dunning />, twoTenants({ created: true }), asked, ['/dunning?runId=run_b'], ['read_sales', 'dun', 'post']);
    await screen.findByRole('row', { name: 'Mahnlauf vom 16.07.2026 öffnen' });
    expect(screen.queryByTestId('dunning-current')).toBeNull();
    expect(asked.filter((a) => a.action === 'get_dunning_run')).toEqual([]);
  });

  it('closing a deep-linked run keeps ?view= and every other param, and adds no history entry', async () => {
    const asked: Asked = [];
    mount(
      <Dunning />,
      twoTenants({ created: true }),
      asked,
      ['/attention', '/dunning?view=v_1&runId=run_a&x=keep'],
      ['read_sales', 'dun', 'post'],
    );
    await screen.findByTestId('dunning-current');
    await userEvent.click(screen.getByRole('row', { name: 'Mahnlauf vom 16.07.2026 öffnen' }));
    await waitFor(() => expect(screen.queryByTestId('dunning-current')).toBeNull());
    const search = new URLSearchParams(where.split('?')[1] ?? '');
    expect(search.get('view')).toBe('v_1');
    expect(search.get('x')).toBe('keep');
    expect(search.has('runId')).toBe(false);
    // Replace, not push: one step back is the page the person came from.
    act(() => go?.(-1));
    await waitFor(() => expect(where).toBe('/attention'));
  });
});

// ---------------------------------------------------------------- goods receipts

const ROW = (id: string, number: string, status = 'draft') => ({
  id,
  number,
  status,
  poId: 'po_1',
  poNumber: 'PO-2026-0001',
  supplierName: 'Lieferant GmbH',
  receivedAt: '2026-03-04',
  lineCount: 1,
  valueRappen: 40000,
  overReceiptQty: 0,
});
const DETAIL = (id: string, number: string, status: string) => ({
  goodsReceipt: { id, number, status, poId: 'po_1', receivedAt: '2026-03-04', note: null, hasOverReceipt: false, lines: [], events: [] },
});
const PREVIEW = { valueRappen: 40000, postable: true, issues: [], lines: [] };

describe('critic round 2: /goods-receipts, the read guard and the refresh after a write', () => {
  it('after Buchen the pane shows the POSTED state (the guard does not drop the refresh)', async () => {
    const asked: Asked = [];
    let status = 'draft';
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: () => ok({ goodsReceipts: [ROW('gr_1', 'GR-1', status), ROW('gr_2', 'GR-2')] }),
        goods_receipt_get: (i) => ok(DETAIL(String(i.grId), i.grId === 'gr_1' ? 'GR-1' : 'GR-2', i.grId === 'gr_1' ? status : 'draft')),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
        goods_receipt_post: () => {
          status = 'posted';
          return ok({});
        },
      },
      asked,
      ['/goods-receipts?focus=gr_1'],
      ['read_master_data', 'manage_master_data'],
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    // Posted: Buchen is gone and Stornieren (the reverse) is offered, with its reason field.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull());
    expect(await screen.findByLabelText(/Grund/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'GR-1' })).toBeInTheDocument();
    expect(asked.filter((a) => a.action === 'goods_receipt_post').map((a) => a.input.grId)).toEqual(['gr_1']);
  });

  it('back and forward between two deep links reopen each receipt, and a person close strips only focus', async () => {
    const asked: Asked = [];
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: ok({ goodsReceipts: [ROW('gr_1', 'GR-1'), ROW('gr_2', 'GR-2')] }),
        goods_receipt_get: (i) => ok(DETAIL(String(i.grId), i.grId === 'gr_1' ? 'GR-1' : 'GR-2', 'draft')),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
      },
      asked,
      ['/goods-receipts?focus=gr_1&q=keep'],
      ['read_master_data', 'manage_master_data'],
    );
    expect(await screen.findByRole('heading', { name: 'GR-1' })).toBeInTheDocument();
    act(() => go?.('/goods-receipts?focus=gr_2&q=keep'));
    expect(await screen.findByRole('heading', { name: 'GR-2' })).toBeInTheDocument();
    act(() => go?.(-1));
    expect(await screen.findByRole('heading', { name: 'GR-1' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'GR-2' })).toBeNull();
    // The person closes GR-1: focus goes, q stays.
    await userEvent.click(screen.getByRole('row', { name: /GR-1/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'GR-1' })).toBeNull());
    expect(where).toBe('/goods-receipts?q=keep');
  });
});
