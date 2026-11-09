/**
 * I04 Abgleich-Ausnahmen: the surface's load states, the exception list, and the embedded
 * evaluate -> confirm / override flow. House discipline: a gate claim mounts a real
 * CapabilitiesProvider over a transport that answers `whoami`, the loading assertion proves the read
 * went in flight through `watchReads(...).started`, and every copy assertion goes through the
 * catalogue rather than a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import ThreeWayMatch from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({ status, body: { ok: false, error, ...extra } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const EXC = (over: Record<string, unknown> = {}) => ({
  billId: 'vbill_1',
  poId: 'po_1',
  supplierId: 'contact_1',
  status: 'variance',
  valueVarianceRappen: 20000,
  amountAtRiskRappen: 20000,
  ageDays: 3,
  ...over,
});

const LINE = (over: Record<string, unknown> = {}) => ({
  poLineId: 'pl_1',
  itemId: 'item_1',
  description: 'Rohstoff',
  orderedQty: 10,
  receivedQty: 10,
  alreadyBilledQty: 0,
  billedNowQty: 10,
  unitPricePoRappen: 10000,
  extendedPoRappen: 100000,
  qtyVariance: 0,
  lineStatus: 'matched',
  ...over,
});

const EVAL = (over: Record<string, unknown> = {}) => ({
  evaluation: {
    billId: 'vbill_1',
    poId: 'po_1',
    supplierId: 'contact_1',
    status: 'matched',
    billConvertible: true,
    lines: [LINE()],
    totalExpectedRappen: 100000,
    totalBilledRappen: 100000,
    valueVarianceRappen: 0,
    ...over,
  },
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (exceptions: Record<string, unknown>[] = [EXC()]): Canned => ({
  whoami: whoamiWith(['read_master_data', 'purchasing.match', 'purchasing.match_override']),
  match_three_way_exceptions: ok({ exceptions }),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Lieferant GmbH' }] }),
  match_three_way_evaluate: ok(EVAL()),
  match_three_way_create: ok({ match: { id: 'twmatch_1', status: 'matched' } }),
  match_three_way_override: ok({ match: { id: 'twmatch_2', status: 'overridden' } }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <ThreeWayMatch />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>{withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}</WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('ThreeWayMatch, the load states', () => {
  it('shows the loading skeleton once the exceptions read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <ThreeWayMatch />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('match_three_way_exceptions');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders the empty state when there are no exceptions', async () => {
    renderSurface(baseCanned([]));
    expect(await screen.findByText(de.procurement.match.emptyTitle)).toBeInTheDocument();
  });

  it('renders the error banner on a failed read', async () => {
    renderSurface({ ...baseCanned(), match_three_way_exceptions: reject('not_found', {}, 500) });
    // The shared ErrorBanner surfaces the code; the list is not silently empty.
    expect(screen.queryByText(de.procurement.match.emptyTitle)).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('ThreeWayMatch, the exception list and the match panel', () => {
  it('lists an exception with the resolved supplier name and the amount at risk', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('Lieferant GmbH')).toBeInTheDocument();
    expect(screen.getByText(de.procurement.match.status.variance)).toBeInTheDocument();
    expect(screen.getByText("200.00")).toBeInTheDocument();
  });

  it('opens the detail drawer and confirms an in-tolerance match through the alertdialog', async () => {
    const user = userEvent.setup();
    withCapabilities(baseCanned());
    // The row is the clickable open affordance (DataTable); it opens the DetailDrawer hosting the panel.
    await user.click(await screen.findByRole('row', { name: 'Lieferant GmbH' }));
    // The evaluation returns matched, so Confirm is offered; it raises the release alertdialog.
    await user.click(await screen.findByRole('button', { name: de.procurement.match.confirm }));
    await user.click(await screen.findByRole('button', { name: de.procurement.match.releaseConfirm }));
    expect(await screen.findByText(de.procurement.match.done.matched)).toBeInTheDocument();
  });

  it('offers the override alertdialog on a variance and records it with a reason', async () => {
    const user = userEvent.setup();
    withCapabilities({ ...baseCanned(), match_three_way_evaluate: ok(EVAL({ status: 'variance', valueVarianceRappen: 20000, totalBilledRappen: 120000 })) });
    await user.click(await screen.findByRole('row', { name: 'Lieferant GmbH' }));
    await user.click(await screen.findByRole('button', { name: de.procurement.match.override }));
    // The reason lives inside the override alertdialog and is mandatory.
    await user.type(await screen.findByRole('textbox'), 'Preisdifferenz vereinbart');
    await user.click(screen.getByRole('button', { name: de.procurement.match.overrideConfirm }));
    expect(await screen.findByText(de.procurement.match.done.overridden)).toBeInTheDocument();
  });
});
