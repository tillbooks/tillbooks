/**
 * I01, the Einkauf -> Bestellversionen surface. The suite follows the Studio discipline: copy is read
 * from the message fragment (never typed here), loading is asserted through the list catalogue, and the
 * amend flow asserts the exact OP14 verbs fire with a fresh idempotency key.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import PurchaseVersions from './index';
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

const PO = (over: Record<string, unknown> = {}) => ({ id: 'po_1', number: 'PO-0001', status: 'sent', currency: 'CHF', totalRappen: 60000, ...over });
const LINE = (over: Record<string, unknown> = {}) => ({ id: 'pl_1', description: 'Rohstoff', qty: 6, unitPriceRappen: 10000, receivedQty: 0, openQty: 6, ...over });
const VERSION = (over: Record<string, unknown> = {}) => ({ id: 'ver_1', versionNumber: 1, status: 'active', reason: null, totalRappen: 60000, currency: 'CHF', ...over });

const baseCanned = (): Canned => ({
  po_list: ok({ pos: [PO()] }),
  po_get: ok({ po: PO(), lines: [LINE()], receipts: [], matches: [] }),
  po_version_list: ok({ poId: 'po_1', versions: [VERSION()] }),
});

function tree(canned: Canned, workspaceId: string | null, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <PurchaseVersions />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test', asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, workspaceId, asked));

describe('PurchaseVersions, the list', () => {
  it('renders a purchase-order row with its number, status and total', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('PO-0001')).toBeInTheDocument();
    expect(screen.getByText(de.poVersions.status.sent)).toBeInTheDocument();
    expect(screen.getByText('CHF 600.00')).toBeInTheDocument();
  });

  // rt-f3 (K-71), the material misstatement. The golden PO-0001 is a EUR order (total 900000 minor).
  // The old bespoke `chf()` hardcoded "CHF" and ignored the row's `currency`, so it printed
  // "CHF 9000.00" (wrong currency, ungrouped). Through `formatMoney(minor, currency)` it must read the
  // row's own currency AND group de-CH: "EUR 9'000.00". This test fails on develop and passes after.
  it('renders a EUR purchase order in EUR with de-CH grouping, never hardcoded CHF (rt-f3)', async () => {
    const eurPo = PO({ number: 'PO-0001', currency: 'EUR', totalRappen: 900000 });
    renderSurface({
      ...baseCanned(),
      po_list: ok({ pos: [eurPo] }),
      po_get: ok({ po: eurPo, lines: [LINE()], receipts: [], matches: [] }),
      po_version_list: ok({ poId: 'po_1', versions: [VERSION({ currency: 'EUR', totalRappen: 900000 })] }),
    });
    expect(await screen.findByText('PO-0001')).toBeInTheDocument();
    // The correct rendering: the row's own currency, grouped once by the shared formatter.
    expect(screen.getByText("EUR 9'000.00")).toBeInTheDocument();
    // The exact defect strings must be absent: neither the hardcoded-CHF nor the ungrouped form.
    expect(screen.queryByText('CHF 9000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('CHF 9,000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('EUR 9000.00')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no purchase orders', async () => {
    renderSurface({ ...baseCanned(), po_list: ok({ pos: [] }) });
    expect(await screen.findByText(de.poVersions.empty.title)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), po_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.poVersions.error.transport)).toBeInTheDocument();
  });

  it('shows the permission-denied state when the list is forbidden', async () => {
    renderSurface({ ...baseCanned(), po_list: reject('permission_denied', {}, 403) });
    const panel = await screen.findByRole('note');
    expect(panel).toHaveTextContent(de.poVersions.title);
  });
});

describe('PurchaseVersions, the version timeline', () => {
  it('opens a PO and shows its version-1 timeline', async () => {
    renderSurface(baseCanned());
    await userEvent.setup().click(await screen.findByText('PO-0001'));
    expect(await screen.findByText(de.poVersions.versions.title)).toBeInTheDocument();
    expect(screen.getByText(de.poVersions.vstatus.active)).toBeInTheDocument();
  });
});

describe('PurchaseVersions, the amend flow', () => {
  it('starts an amendment, previews the impact, and applies with the right OP14 verbs', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      po_amendment_start: ok({ amendment: { id: 'amd_1', status: 'draft' } }),
      po_amendment_update_lines: ok({ amendment: { id: 'amd_1' }, changeCount: 1 }),
      po_amendment_preview: ok({
        amendmentId: 'amd_1',
        poId: 'po_1',
        impact: { lines: [{ poLineId: 'pl_1', op: 'change', beforeQty: 6, afterQty: 9, beforeUnitPriceRappen: 10000, afterUnitPriceRappen: 10000, violation: null }], committedValueDeltaRappen: 30000, violations: [], applicable: true },
      }),
      po_amendment_apply: ok({ amendment: { id: 'amd_1', status: 'applied' }, newVersion: { id: 'ver_2', versionNumber: 2, status: 'active' }, transmitted: false }),
    };
    const user = userEvent.setup();
    renderSurface(canned, 'ws_test', asked);
    await user.click(await screen.findByText('PO-0001'));

    await user.click(await screen.findByText(de.poVersions.action.amend));
    await waitFor(() => expect(asked.some((a) => a.action === 'po_amendment_start')).toBe(true));

    const qty = await screen.findByLabelText(`${de.poVersions.amend.qty} 1`);
    await user.clear(qty);
    await user.type(qty, '9');
    await user.click(screen.getByText(de.poVersions.action.preview));
    await waitFor(() => expect(asked.some((a) => a.action === 'po_amendment_preview')).toBe(true));

    // The committed-value delta is shown from the preview.
    expect(await screen.findByText('+CHF 300.00')).toBeInTheDocument();

    // Apply is enabled once the preview says applicable.
    await user.click(screen.getByText(de.poVersions.action.apply));
    await waitFor(() => expect(asked.some((a) => a.action === 'po_amendment_apply')).toBe(true));

    const upd = asked.find((a) => a.action === 'po_amendment_update_lines');
    const changes = upd?.input.changes as Array<Record<string, unknown>>;
    expect(changes[0].op).toBe('change');
    expect(changes[0].qty).toBe(9);
    expect(asked.find((a) => a.action === 'po_amendment_apply')?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('keeps apply disabled and shows the violation when the impact is not applicable', async () => {
    const canned: Canned = {
      ...baseCanned(),
      po_get: ok({ po: PO(), lines: [LINE({ receivedQty: 4, openQty: 2 })], receipts: [], matches: [] }),
      po_amendment_start: ok({ amendment: { id: 'amd_2', status: 'draft' } }),
      po_amendment_update_lines: ok({ amendment: { id: 'amd_2' }, changeCount: 1 }),
      po_amendment_preview: ok({
        amendmentId: 'amd_2',
        poId: 'po_1',
        impact: { lines: [{ poLineId: 'pl_1', op: 'change', beforeQty: 6, afterQty: 3, beforeUnitPriceRappen: 10000, afterUnitPriceRappen: 10000, violation: 'qty_below_received' }], committedValueDeltaRappen: -30000, violations: [{ code: 'qty_below_received', poLineId: 'pl_1' }], applicable: false },
      }),
    };
    const user = userEvent.setup();
    renderSurface(canned);
    await user.click(await screen.findByText('PO-0001'));
    await user.click(await screen.findByText(de.poVersions.action.amend));
    const qty = await screen.findByLabelText(`${de.poVersions.amend.qty} 1`);
    await user.clear(qty);
    await user.type(qty, '3');
    await user.click(screen.getByText(de.poVersions.action.preview));
    expect(await screen.findByText(de.poVersions.violation.qty_below_received)).toBeInTheDocument();
    expect(screen.getByText(de.poVersions.action.apply)).toBeDisabled();
  });
});
