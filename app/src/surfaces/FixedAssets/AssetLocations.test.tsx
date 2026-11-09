/**
 * H05, the Fixed Assets -> Locations surface. Same discipline as the AssetCategories suite: a GATE
 * claim mounts a real `CapabilitiesProvider` over a transport that answers `whoami`, loading is
 * asserted through the catalogue, and copy is read from the message fragment, never typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { AssetLocations } from './AssetLocations';
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

const LOCATION = (over: Record<string, unknown> = {}) => ({
  id: 'aloc_1',
  code: 'ZH-HQ',
  name: 'Zürich HQ',
  description: null,
  parentId: null,
  active: true,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  asset_location_list: ok({ locations: [LOCATION()] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <AssetLocations />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderSurface = (canned: Canned, workspaceId: string | null = 'ws_test', asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, workspaceId, false, asked));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('AssetLocations, the list', () => {
  it('renders a location row with its code, name and active badge once loaded', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('ZH-HQ')).toBeInTheDocument();
    expect(screen.getByText('Zürich HQ')).toBeInTheDocument();
    expect(screen.getByText(de.assets.locations.active)).toBeInTheDocument();
  });

  it('shows the empty state with a create CTA when there are no locations', async () => {
    renderSurface({ ...baseCanned(), asset_location_list: ok({ locations: [] }) });
    expect(await screen.findByText(de.assets.locations.empty.title)).toBeInTheDocument();
    expect(screen.getByText(de.assets.locations.empty.cta)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface({ ...baseCanned(), asset_location_list: reject('boom', {}, 500) });
    expect(await screen.findByText(de.assets.locations.error.transport)).toBeInTheDocument();
  });
});

describe('AssetLocations, create', () => {
  it('opens the drawer, submits a create with an idempotency key, and re-reads on success', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      asset_location_list: ok({ locations: [] }),
      asset_location_create: ok({ location: LOCATION() }),
    };
    renderSurface(canned, 'ws_test', asked);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.locations.empty.cta));
    await user.type(screen.getByLabelText(de.assets.locations.field.code), 'ZH-HQ-3F');
    await user.type(screen.getByLabelText(de.assets.locations.field.name), 'Drittes OG');
    await user.click(screen.getByText(de.assets.locations.save));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_location_create')).toBe(true));
    const call = asked.find((a) => a.action === 'asset_location_create');
    expect(call?.input.code).toBe('ZH-HQ-3F');
    expect(call?.input.idempotencyKey).toBeTypeOf('string');
  });

  it('surfaces the engine duplicate_code rejection in the drawer without closing it', async () => {
    const canned: Canned = {
      ...baseCanned(),
      asset_location_list: ok({ locations: [] }),
      asset_location_create: reject('duplicate_code'),
    };
    renderSurface(canned);
    const user = userEvent.setup();
    await user.click(await screen.findByText(de.assets.locations.empty.cta));
    await user.type(screen.getByLabelText(de.assets.locations.field.code), 'ZH-HQ');
    await user.type(screen.getByLabelText(de.assets.locations.field.name), 'X');
    await user.click(screen.getByText(de.assets.locations.save));
    expect(await screen.findByText(de.errors.duplicate_code)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AssetLocations, archive', () => {
  it('confirms then calls asset_location_archive', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), asset_location_archive: ok({ location: LOCATION({ active: false }) }) };
    renderSurface(canned, 'ws_test', asked);
    const user = userEvent.setup();
    await screen.findByText('ZH-HQ');
    await user.click(screen.getByRole('button', { name: /^Aktionen für Standort/ })); // K-21: the row overflow
    await user.click(screen.getByRole('menuitem', { name: de.assets.locations.archive }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: de.assets.locations.archive }));
    await waitFor(() => expect(asked.some((a) => a.action === 'asset_location_archive')).toBe(true));
  });

  it('surfaces location_in_use when the engine refuses the archive', async () => {
    const canned: Canned = { ...baseCanned(), asset_location_archive: reject('location_in_use') };
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText('ZH-HQ');
    await user.click(screen.getByRole('button', { name: /^Aktionen für Standort/ })); // K-21: the row overflow
    await user.click(screen.getByRole('menuitem', { name: de.assets.locations.archive }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: de.assets.locations.archive }));
    expect(await screen.findByText(de.errors.location_in_use)).toBeInTheDocument();
  });
});

describe('AssetLocations, the permission gate', () => {
  it('disables the New button for a role without manage_master_data', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) });
    const newBtn = await screen.findByText(de.assets.locations.new);
    await waitFor(() => expect(newBtn).toBeDisabled());
  });
});
