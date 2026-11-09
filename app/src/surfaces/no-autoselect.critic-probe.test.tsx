/**
 * CRITIC PROBES (D59, non-author) for branch claude/cl-no-autoselect, D152 rule 5.
 *
 * These probe the money-path edges the branch could have moved: which receipt Buchen acts on once a
 * selection can be CLOSED, what a bad or stale deep link does, and whether a deep link lands when the
 * surface is already mounted. A probe written as `it.fails` documents a behaviour the critic judged
 * wrong: it passes while the defect exists and turns red the day it is fixed.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { I18nProvider } from '../i18n';
import { WorkspaceProvider } from '../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../lib/capabilities';
import GoodsReceipt from './GoodsReceipt';
import Dunning from './Dunning';
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

/** A tiny in-app link: navigates the SAME router while the surface stays mounted. */
let go: ((to: string) => void) | null = null;
function Nav() {
  const navigate = useNavigate();
  go = (to: string) => navigate(to);
  return null;
}

function mount(surface: ReactElement, canned: Canned, asked: Asked, path: string, held: readonly string[]) {
  return render(
    <CapabilitiesContext.Provider value={caps(held)}>
      <TillClientProvider client={new TillClient(transport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={[path]}>
              <Nav />
              {surface}
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

// ---------------------------------------------------------------- goods receipts

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
  goodsReceipt: {
    id,
    number,
    status: 'draft',
    poId: 'po_1',
    receivedAt: '2026-03-04',
    note: null,
    hasOverReceipt: false,
    lines: [],
    events: [],
  },
});
const PREVIEW = { valueRappen: 40000, postable: true, issues: [], lines: [] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('critic probe: /goods-receipts Buchen targets', () => {
  it('a receipt that leaves the list on a re-read closes: no Buchen survives for it', async () => {
    const asked: Asked = [];
    let rows = [ROW('gr_1', 'GR-1'), ROW('gr_2', 'GR-2')];
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: () => ok({ goodsReceipts: rows }),
        goods_receipt_get: (i) => ok(DETAIL(String(i.grId), i.grId === 'gr_1' ? 'GR-1' : 'GR-2')),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [{ id: 'po_1', number: 'PO-2026-0001', status: 'sent' }] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
        goods_receipt_post: () => {
          // The post makes gr_1 vanish from the next list read (a saved view, another session).
          rows = [ROW('gr_2', 'GR-2')];
          return ok({});
        },
      },
      asked,
      '/goods-receipts',
      ['read_master_data', 'manage_master_data'],
    );
    await userEvent.click(await screen.findByRole('row', { name: /GR-1/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'GR-1' })).toBeNull());
    // Nothing else was opened in its place, so no Buchen is on screen at all.
    expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(screen.getByRole('row', { name: /GR-2/ })).not.toHaveAttribute('aria-current');
    const posts = asked.filter((a) => a.action === 'goods_receipt_post');
    expect(posts).toHaveLength(1);
    expect(posts[0].input).toMatchObject({ grId: 'gr_1', workspaceId: 'ws_test' });
    expect(typeof posts[0].input.idempotencyKey).toBe('string');
  });

  it('a nonexistent ?focus opens nothing and leaves no Buchen', async () => {
    const asked: Asked = [];
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: ok({ goodsReceipts: [ROW('gr_1', 'GR-1')] }),
        goods_receipt_get: (i) => (i.grId === 'gr_1' ? ok(DETAIL('gr_1', 'GR-1')) : { status: 404, body: { ok: false, error: 'not_found' } }),
        goods_receipt_preview: (i) => (i.grId === 'gr_1' ? ok(PREVIEW) : { status: 404, body: { ok: false, error: 'not_found' } }),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
      },
      asked,
      '/goods-receipts?focus=gr_from_another_workspace',
      ['read_master_data', 'manage_master_data'],
    );
    await screen.findByRole('row', { name: /GR-1/ });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Wareneingang im Detail' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(screen.getByRole('row', { name: /GR-1/ })).not.toHaveAttribute('aria-current');
  });

  /**
   * FINDING (low, PRE-EXISTING class, now reachable through the new close gesture): `loadDetail` has
   * no stale-response guard. Close a receipt while its read is in flight, the late answer lands in
   * `detail` anyway, and the next receipt the person opens shows THE PREVIOUS receipt's header and
   * Buchen under the new row's selection pill until its own read returns. Buchen there posts the
   * receipt whose number is on screen (detail.id), so the target is not wrong, but the row pill and
   * the pane disagree.
   */
  // FIXED (A6 follow-up): `loadDetail` numbers its reads and drops any a close or newer selection
  // overtook, and a changed selection clears the pane. Flipped from `it.fails`.
  it('after a close mid-read, opening another receipt never shows the previous receipt', async () => {
    const asked: Asked = [];
    const slow1 = deferred<RestResponse>();
    const slow2 = deferred<RestResponse>();
    mount(
      <GoodsReceipt />,
      {
        goods_receipt_list: ok({ goodsReceipts: [ROW('gr_1', 'GR-1'), ROW('gr_2', 'GR-2')] }),
        goods_receipt_get: (i) => (i.grId === 'gr_1' ? slow1.promise : slow2.promise),
        goods_receipt_preview: ok(PREVIEW),
        po_list: ok({ pos: [] }),
        po_get: ok({ lines: [] }),
        list_items: ok({ items: [] }),
      },
      asked,
      '/goods-receipts',
      ['read_master_data', 'manage_master_data'],
    );
    const r1 = await screen.findByRole('row', { name: /GR-1/ });
    await userEvent.click(r1); // open gr_1, read in flight
    await userEvent.click(r1); // close it again before the read returns
    await act(async () => {
      slow1.resolve(ok(DETAIL('gr_1', 'GR-1')));
      await slow1.promise;
    });
    await userEvent.click(screen.getByRole('row', { name: /GR-2/ })); // open gr_2, its read in flight
    expect(screen.getByRole('row', { name: /GR-2/ })).toHaveAttribute('aria-current', 'true');
    // The pane must not show GR-1 under GR-2's selection.
    expect(screen.queryByRole('heading', { name: 'GR-1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull();
    // Inside act now that the probe passes: the answer lands while the test is still running.
    await act(async () => {
      slow2.resolve(ok(DETAIL('gr_2', 'GR-2')));
      await slow2.promise;
    });
    expect(await screen.findByRole('heading', { name: 'GR-2' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'GR-1' })).toBeNull();
  });

  /**
   * FINDING (low): the deep link is read ONCE, in the `useState` initialiser. A `?focus=` that
   * arrives while the surface is already mounted (the K-10 `/w/:ws/goods-receipts?focus=` handover
   * redirects into the same element) does not open the receipt it names.
   */
  // FIXED (A6 follow-up): the surfaces sync the deep-link param into the selection while mounted,
  // and a close retires the param. Flipped from `it.fails`.
  it('a ?focus that arrives while the surface is mounted opens that receipt', async () => {
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
      },
      asked,
      '/goods-receipts',
      ['read_master_data', 'manage_master_data'],
    );
    await screen.findByRole('row', { name: /GR-2/ });
    act(() => go?.('/goods-receipts?focus=gr_2'));
    expect(await screen.findByRole('heading', { name: 'GR-2' }, { timeout: 500 })).toBeInTheDocument();
  });
});

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
const dunningBase = (_asked: Asked, runs: () => unknown[]): Canned => ({
  get_dunning_config: ok({ levels: LEVELS, configured: true, interestFloorBp: 500 }),
  list_dunning_runs: () => ok({ runs: runs(), truncated: false }),
  list_saved_views: ok({ savedViews: [] }),
  list_accounts: ok(accountsFixture),
  get_dunning_run: (i) =>
    i.runId === 'run_a'
      ? ok(RUN('run_a', '2026-07-16'))
      : i.runId === 'run_b'
        ? ok(RUN('run_b', '2026-06-16', 'issued'))
        : { status: 404, body: { ok: false, error: 'not_found' } },
  issue_dunning_run: (i) => ok(RUN(String(i.runId), '2026-07-16', 'issued')),
});

describe('critic probe: /dunning deep links and Ausstellen targets', () => {
  it('?runId= of a run that is not in this workspace opens nothing and reads no run', async () => {
    const asked: Asked = [];
    mount(<Dunning />, dunningBase(asked, () => [SUMMARY('run_a', '2026-07-16')]), asked, '/dunning?runId=run_foreign', ['read_sales', 'dun', 'post']);
    await screen.findByRole('row', { name: 'Mahnlauf vom 16.07.2026 öffnen' });
    expect(screen.queryByTestId('dunning-current')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ausstellen' })).toBeNull();
    expect(asked.filter((a) => a.action === 'get_dunning_run')).toEqual([]);
  });

  it('the hub link opens run_a, Ausstellen sends run_a; closing and opening run_b sends run_b', async () => {
    const asked: Asked = [];
    mount(
      <Dunning />,
      dunningBase(asked, () => [SUMMARY('run_a', '2026-07-16'), SUMMARY('run_b', '2026-06-16', 'issued')]),
      asked,
      '/dunning?runId=run_a',
      ['read_sales', 'dun', 'post', 'send'],
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(asked.filter((a) => a.action === 'issue_dunning_run')).toHaveLength(1));
    const issued = asked.filter((a) => a.action === 'issue_dunning_run')[0].input;
    expect(issued).toMatchObject({ runId: 'run_a', workspaceId: 'ws_test', confirmed: true });
    expect(typeof issued.idempotencyKey).toBe('string');

    // Close run_a by its row, open run_b: the card follows, and run_a's Ausstellen is gone.
    await userEvent.click(await screen.findByRole('row', { name: 'Mahnlauf vom 16.07.2026 öffnen' }));
    await waitFor(() => expect(screen.queryByTestId('dunning-current')).toBeNull());
    await userEvent.click(await screen.findByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' }));
    await waitFor(() => expect(screen.getByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' })).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByRole('button', { name: 'Ausstellen' })).toBeNull();
  });

  /**
   * FINDING (low): "a propose opens the run it created" does not hold under a saved view (`?view=`)
   * that the new run falls outside. The selection is set, the list re-read excludes the run, and the
   * card stays closed while the propose said nothing. (Develop opened the NEWEST run of the filtered
   * list instead, which was a different run, so this is not a regression on the money path.)
   */
  // FIXED (A6 follow-up): the proposed run opens by id under the saved view, which is kept, and a
  // note says it lies outside the view. Flipped from `it.fails`.
  it('a propose under a saved view that excludes the new run still opens it', async () => {
    const asked: Asked = [];
    let created = false;
    const canned = {
      ...dunningBase(asked, () => [SUMMARY('run_b', '2026-06-16', 'issued')]),
      list_dunning_runs: (i: Record<string, unknown>) =>
        ok({
          // The saved view shows issued runs only; the fresh proposal is outside it.
          runs: i.savedViewId === 'v_issued' ? [SUMMARY('run_b', '2026-06-16', 'issued')] : created ? [SUMMARY('run_a', '2026-07-16'), SUMMARY('run_b', '2026-06-16', 'issued')] : [SUMMARY('run_b', '2026-06-16', 'issued')],
          truncated: false,
        }),
      propose_dunning_run: () => {
        created = true;
        return ok(RUN('run_a', '2026-07-16'));
      },
    } as Canned;
    mount(<Dunning />, canned, asked, '/dunning?view=v_issued', ['read_sales', 'dun', 'post']);
    await screen.findByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' });
    await userEvent.click(screen.getByRole('button', { name: 'Mahnlauf vorschlagen' }));
    expect(await screen.findByTestId('dunning-current', {}, { timeout: 800 })).toBeInTheDocument();
  });
});
