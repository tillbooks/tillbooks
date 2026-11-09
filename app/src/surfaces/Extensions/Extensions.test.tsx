/**
 * G02 Erweiterungen component tests.
 *
 * The five states are all asserted, plus the two load-bearing UI properties a critic will look for:
 * the permission-review dialog renders every requested scope as a checkbox and installs with only the
 * checked ones (the intersection-not-superset grant made visible), and the plugin Studio screen mounts
 * in an iframe with `sandbox="allow-scripts"` and NO `allow-same-origin`. English asserted through
 * `messages.en.json` under `<I18nProvider initialLocale="en">`, never string literals.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Extensions from './index';
import en from './messages.en.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const ALL_CAPS = ['read_master_data', 'manage_plugins'];
const READ_ONLY_CAPS = ['read_master_data'];

const whoami = (capabilities: readonly string[]): RestResponse =>
  ok({ actor: 'studio', role: 'owner', isMember: true, provisioned: true, capabilities });

const PLUGIN = (over: Record<string, unknown> = {}) => ({
  id: 'plg_1',
  name: 'Acme Reporter',
  version: '1.2.0',
  source: 'local',
  status: 'installed',
  compatRange: '^1.0.0',
  coreVersion: '1.0.0',
  compatible: true,
  sha256: 'abc',
  installedBy: 'studio',
  registryRef: null,
  requested: [],
  granted: [],
  capabilities: [],
  capabilityCount: 0,
  lastCompatCheckAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const baseCanned = (caps: readonly string[] = ALL_CAPS): Canned => ({
  whoami: whoami(caps),
  list_plugins: ok({ plugins: [] }),
});

function tree(canned: Canned) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Extensions />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Extensions', () => {
  it('shows a loading skeleton while the plugin list is in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Extensions />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_plugins');
    const skeletons = screen.getAllByRole('status');
    expect(skeletons.length).toBeGreaterThan(0);
    for (const node of skeletons) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the honest empty state when nothing is installed', async () => {
    render(tree(baseCanned()));
    expect(await screen.findByText(en.plugin.empty)).toBeInTheDocument();
  });

  it('renders the error banner when the list is refused', async () => {
    render(tree({ ...baseCanned(), list_plugins: reject('permission_denied') }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders an installed plugin card with a status glyph + label', async () => {
    render(tree({ ...baseCanned(), list_plugins: ok({ plugins: [PLUGIN({ capabilityCount: 2 })] }) }));
    await screen.findByText('Acme Reporter');
    const card = screen.getByRole('listitem');
    expect(within(card).getByText(en.plugin.status.installed)).toBeInTheDocument();
    expect(within(card).getByText('2 capabilities')).toBeInTheDocument();
  });

  it('shows the incompatible reason with the real range/version interpolated', async () => {
    render(
      tree({
        ...baseCanned(),
        list_plugins: ok({ plugins: [PLUGIN({ status: 'incompatible', compatible: false, compatRange: '^2.0.0' })] }),
      }),
    );
    expect(await screen.findByText('Requires core version ^2.0.0, installed is 1.0.0.')).toBeInTheDocument();
  });

  it('pre-disables Install and shows the lock note for a role lacking manage_plugins', async () => {
    render(tree(baseCanned(READ_ONLY_CAPS)));
    expect(await screen.findByText(en.plugin.needsPermission)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.plugin.action.install })).toBeDisabled();
  });

  it('reviews an install and grants only the checked scopes (intersection, not superset)', async () => {
    const calls: Record<string, unknown>[] = [];
    const bundle = {
      manifest: {
        name: 'Acme Reporter',
        version: '1.2.0',
        compat_range: '^1.0.0',
        sha256: 'abc',
        capabilities: [{ kind: 'report_source', name: 'acme_sales' }],
        permissions: { requested: ['mcp_tool:list_invoices', 'network:acme.example'] },
      },
      payload: 'x',
    };
    render(
      tree({
        ...baseCanned(),
        preview_plugin_install: ok({
          name: 'Acme Reporter',
          version: '1.2.0',
          capabilities: bundle.manifest.capabilities,
          requested: bundle.manifest.permissions.requested,
          compatible: true,
          compatRange: '^1.0.0',
          coreVersion: '1.0.0',
        }),
        install_plugin: (input) => {
          calls.push(input);
          return ok({ plugin: PLUGIN() });
        },
      }),
    );
    await screen.findByText(en.plugin.empty);

    // Drive the hidden file input with the bundle as a .tillplugin JSON file.
    const file = new File([JSON.stringify(bundle)], 'acme.tillplugin', { type: 'application/json' });
    const input = screen.getByLabelText(en.plugin.action.install, { selector: 'input[type="file"]' }) as HTMLInputElement;
    await userEvent.upload(input, file);

    // The review dialog renders both requested scopes as checkboxes, defaulted on.
    const dialog = await screen.findByRole('dialog');
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(within(dialog).getByText('mcp_tool:list_invoices')).toBeInTheDocument();

    // Uncheck the network scope, then confirm: only the checked scope is granted.
    await userEvent.click(boxes[1] as HTMLElement);
    await userEvent.click(within(dialog).getByRole('button', { name: en.plugin.review.confirm }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ source: 'local', grantedScopes: ['mcp_tool:list_invoices'] });
  });

  it('mounts a plugin Studio screen in a sandboxed iframe (allow-scripts, never allow-same-origin)', async () => {
    render(
      tree({
        ...baseCanned(),
        list_plugins: ok({
          plugins: [PLUGIN({ capabilities: [{ kind: 'studio_screen', name: 'acme_panel' }], capabilityCount: 1 })],
        }),
      }),
    );
    await screen.findByText('Acme Reporter');
    await userEvent.click(screen.getByRole('button', { name: en.plugin.action.viewScreen }));
    const frame = (await screen.findByTitle('Acme Reporter panel')) as HTMLIFrameElement;
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('shows the no-registry empty state on the Browse tab', async () => {
    render(tree({ ...baseCanned(), search_plugin_registry: reject('needs_registry') }));
    await screen.findByText(en.plugin.empty);
    await userEvent.click(screen.getByRole('tab', { name: en.plugin.tab.browse }));
    await userEvent.click(screen.getByRole('button', { name: en.plugin.registry.search }));
    expect(await screen.findByText(en.plugin.registry.empty)).toBeInTheDocument();
  });
});
