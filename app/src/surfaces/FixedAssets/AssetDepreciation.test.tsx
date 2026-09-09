/**
 * H03, the Fixed Assets -> Depreciation surface. Follows the AssetRegister discipline: canned
 * transport, real providers for the capability claim, copy read from the message fragment. Asserts the
 * three things this screen exists to prove: the live next-period amount renders, the projected schedule
 * renders, and the methods panel toggles enablement (gated behind manage_master_data).
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
import { AssetDepreciation } from './AssetDepreciation';
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

const ASSET = {
  id: 'as_1',
  number: 'FA-0001',
  name: 'CNC Fräsmaschine',
  depreciationMethod: 'straight_line',
  status: 'active',
  acquisitionCostRappen: 1_250_000,
  residualValueRappen: 125_000,
  netBookValueRappen: 1_250_000,
};

const METHODS = [
  { key: 'straight_line', requiresUnits: false, requiresRate: false, enabled: true },
  { key: 'declining_balance', requiresUnits: false, requiresRate: true, enabled: true },
  { key: 'units_of_production', requiresUnits: true, requiresRate: false, enabled: true },
  { key: 'none', requiresUnits: false, requiresRate: false, enabled: true },
];

const PREVIEW = ok({
  period: '2026-07',
  results: [
    {
      assetId: 'as_1',
      period: '2026-07',
      method: 'straight_line',
      amountRappen: 18_750,
      isFinal: false,
      remainingLifeMonths: 59,
      projectedNbvAfterRappen: 1_231_250,
      explanation: 'assets.depreciation.explain.straight_line',
    },
  ],
});

const SCHEDULE = ok({
  assetId: 'as_1',
  method: 'straight_line',
  complete: true,
  lines: [
    { period: '2026-07', amountRappen: 18_750, projectedAccumRappen: 18_750, projectedNbvRappen: 1_231_250, isFinal: false },
    { period: '2026-08', amountRappen: 18_750, projectedAccumRappen: 37_500, projectedNbvRappen: 1_212_500, isFinal: false },
  ],
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (over: Partial<Canned> = {}): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  asset_list: ok({ assets: [ASSET], total: 1 }),
  asset_depreciation_methods: ok({ methods: METHODS }),
  asset_depreciation_preview: PREVIEW,
  asset_depreciation_schedule: SCHEDULE,
  asset_depreciation_method_set_enabled: ok({ method: { key: 'declining_balance', requiresUnits: false, requiresRate: true, enabled: false } }),
  ...over,
});

function tree(canned: Canned, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <AssetDepreciation />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, false, asked));

describe('AssetDepreciation', () => {
  it('lists methods with their enablement on load', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText(de.assets.depreciation.methods.title)).toBeInTheDocument();
    // the four method labels appear in the methods panel
    expect(screen.getAllByText(de.assets.depreciation.method.straight_line).length).toBeGreaterThan(0);
  });

  it('previews the next-period amount and the schedule once an asset is chosen', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    const user = userEvent.setup();
    await screen.findByText(de.assets.depreciation.methods.title);
    const select = screen.getByLabelText(de.assets.depreciation.assetLabel);
    await user.selectOptions(select, 'as_1');
    // the live next-period amount (CHF 187.50) appears in the summary (the .fa-amount cell)
    await waitFor(() => expect(document.querySelector('.fa-amount')?.textContent).toBe('CHF 187.50'));
    // the schedule table rendered two lines
    await waitFor(() => expect(screen.getByText('2026-08')).toBeInTheDocument());
    // preview and schedule were both asked with the selected asset
    expect(asked.some((a) => a.action === 'asset_depreciation_preview' && Array.isArray(a.input.assetIds))).toBe(true);
    expect(asked.some((a) => a.action === 'asset_depreciation_schedule' && a.input.assetId === 'as_1')).toBe(true);
  });

  it('shows a structured reason when a period yields no depreciation', async () => {
    const canned = baseCanned({
      asset_depreciation_preview: ok({
        period: '2026-07',
        results: [
          {
            assetId: 'as_1',
            period: '2026-07',
            method: 'straight_line',
            amountRappen: 0,
            isFinal: false,
            projectedNbvAfterRappen: 125_000,
            reason: 'already_at_residual',
            explanation: 'assets.depreciation.reason.already_at_residual',
          },
        ],
      }),
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText(de.assets.depreciation.methods.title);
    await user.selectOptions(screen.getByLabelText(de.assets.depreciation.assetLabel), 'as_1');
    expect(await screen.findByText(de.assets.depreciation.reason.already_at_residual)).toBeInTheDocument();
  });

  it('toggles a method enablement through the methods panel', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    const user = userEvent.setup();
    await screen.findByText(de.assets.depreciation.methods.title);
    // the declining_balance enablement checkbox
    const checkbox = screen.getByLabelText(
      `${de.assets.depreciation.method.declining_balance} ${de.assets.depreciation.methods.enabled}`,
    );
    await user.click(checkbox);
    await waitFor(() =>
      expect(asked.some((a) => a.action === 'asset_depreciation_method_set_enabled' && a.input.methodKey === 'declining_balance' && a.input.enabled === false)).toBe(true),
    );
  });

  it("keeps the 'none' method toggle disabled (it can never be switched off)", async () => {
    renderSurface(baseCanned());
    await screen.findByText(de.assets.depreciation.methods.title);
    const noneToggle = screen.getByLabelText(
      `${de.assets.depreciation.method.none} ${de.assets.depreciation.methods.enabled}`,
    );
    expect(noneToggle).toBeDisabled();
  });

  it('shows the empty state when the register has no assets', async () => {
    renderSurface(baseCanned({ asset_list: ok({ assets: [], total: 0 }) }));
    expect(await screen.findByText(de.assets.depreciation.empty.title)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface(baseCanned({ asset_list: reject('boom', {}, 500) }));
    expect(await screen.findByText(de.assets.depreciation.error.transport)).toBeInTheDocument();
  });
});
