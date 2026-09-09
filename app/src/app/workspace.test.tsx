import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import {
  WorkspaceProvider,
  WorkspaceRoute,
  WorkspaceResolver,
  pickLandingWorkspace,
  useWorkspace,
  tenantResetTarget,
  TenantRouteReset,
} from './workspace';
import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { WORKSPACE_STORAGE_KEY, storeWorkspaceId } from '../lib/workspace-store';
import { installMemoryStorage } from '../lib/test-support';

beforeEach(() => {
  installMemoryStorage();
});

/** Reads the context and exposes a button that selects a workspace, so a test can drive the setter. */
function Probe({ next = 'ws_next' }: { next?: string | null }) {
  const { workspaceId, setWorkspaceId } = useWorkspace();
  return (
    <>
      <p data-testid="current">{workspaceId ?? 'none'}</p>
      <button type="button" onClick={() => setWorkspaceId(next)}>
        select
      </button>
    </>
  );
}

describe('WorkspaceProvider', () => {
  it('an explicit initialId still wins, so surface tests keep working unchanged', () => {
    render(
      <WorkspaceProvider initialId="ws_test">
        <Probe />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('current')).toHaveTextContent('ws_test');
  });

  it('with no explicit id, it restores the stored workspace: the selection survives a reload', () => {
    storeWorkspaceId('ws_reloaded');
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('current')).toHaveTextContent('ws_reloaded');
  });

  it('selecting a workspace persists it, and a remount (the reload) finds it again', async () => {
    const first = render(
      <WorkspaceProvider>
        <Probe next="ws_picked" />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('current')).toHaveTextContent('none');

    await act(async () => {
      screen.getByRole('button', { name: 'select' }).click();
    });
    expect(screen.getByTestId('current')).toHaveTextContent('ws_picked');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_picked');

    first.unmount();
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('current')).toHaveTextContent('ws_picked');
  });

  it('clearing the workspace forgets it, so the next load starts with no tenant', async () => {
    storeWorkspaceId('ws_old');
    render(
      <WorkspaceProvider>
        <Probe next={null} />
      </WorkspaceProvider>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'select' }).click();
    });
    expect(screen.getByTestId('current')).toHaveTextContent('none');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });
});

describe('WorkspaceRoute', () => {
  function routed(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceProvider>
          <Routes>
            <Route path="/w/:workspaceId" element={<WorkspaceRoute />} />
            {/* NAV_ITEMS[0] is /overview (F00, the landing page): where WorkspaceRoute hands over. */}
            <Route path="/overview" element={<Probe />} />
            <Route path="/setup" element={<p data-testid="picker">picker</p>} />
            <Route path="/" element={<Probe />} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  }

  it('a /w/:workspaceId link selects that workspace and redirects into the app', () => {
    routed('/w/ws_deep');
    expect(screen.getByTestId('current')).toHaveTextContent('ws_deep');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_deep');
  });

  it('a malformed /w/:workspaceId does not become a tenant and lands on the picker (US-G16.9)', () => {
    routed('/w/not-an-id');
    expect(screen.getByTestId('picker')).toBeInTheDocument();
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });
});

describe('tenantResetTarget (US-G16.10, the route-layer H-TENANT guard)', () => {
  it('resets a record-highlighted route to its list root', () => {
    expect(tenantResetTarget('/contacts', '?focus=contact_1')).toBe('/contacts');
    expect(tenantResetTarget('/documents/invoices/inv_1', '')).toBe('/documents');
  });

  it('keeps a plain list route untouched', () => {
    expect(tenantResetTarget('/journal', '')).toBeNull();
    expect(tenantResetTarget('/reports', '')).toBeNull();
    expect(tenantResetTarget('/payments/new', '')).toBeNull();
  });
});

describe('TenantRouteReset', () => {
  function Switcher() {
    const { setWorkspaceId } = useWorkspace();
    const loc = useLocation();
    return (
      <>
        <p data-testid="path">{`${loc.pathname}${loc.search}`}</p>
        <button type="button" onClick={() => setWorkspaceId('ws_2')}>
          switch
        </button>
      </>
    );
  }

  function mounted(initialPath: string) {
    return render(
      <WorkspaceProvider initialId="ws_1">
        <MemoryRouter initialEntries={[initialPath]}>
          <TenantRouteReset />
          <Switcher />
        </MemoryRouter>
      </WorkspaceProvider>,
    );
  }

  it('resets a record route on a workspace switch, so A`s id never renders under B', async () => {
    mounted('/contacts?focus=contact_from_A');
    expect(screen.getByTestId('path')).toHaveTextContent('/contacts?focus=contact_from_A');
    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });
    expect(screen.getByTestId('path')).toHaveTextContent('/contacts');
    expect(screen.getByTestId('path').textContent).not.toContain('focus');
  });

  it('keeps a list route on a workspace switch', async () => {
    mounted('/journal');
    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });
    expect(screen.getByTestId('path')).toHaveTextContent('/journal');
  });
});

describe('pickLandingWorkspace (F-02, the Studio-side landing rule)', () => {
  it('takes the first non-archived row of the engine order (created_at DESC = the newest books)', () => {
    expect(
      pickLandingWorkspace([
        { workspaceId: 'ws_old', archived: true },
        { workspaceId: 'ws_new', archived: false },
        { workspaceId: 'ws_older', archived: false },
      ]),
    ).toBe('ws_new');
  });

  it('answers null for an empty ledger, a list of archived books, or junk ids', () => {
    expect(pickLandingWorkspace([])).toBeNull();
    expect(pickLandingWorkspace([{ workspaceId: 'ws_a', archived: true }])).toBeNull();
    expect(pickLandingWorkspace([{ workspaceId: 'not an id' }])).toBeNull();
  });
});

describe('WorkspaceResolver (F-02: the morning starts on the books)', () => {
  function client(workspaces: unknown, status = 200): TillClient {
    const transport: Transport = async (action) =>
      action === 'list_workspaces'
        ? status === 200
          ? { status, body: { ok: true, workspaces } as unknown as RestResponse['body'] }
          : { status, body: { ok: false, error: 'permission_denied' } }
        : { status: 404, body: { ok: false, error: 'unknown_action' } };
    return new TillClient(transport);
  }

  function mount(path: string, c: TillClient, initialId: string | null = null) {
    return render(
      <TillClientProvider client={c}>
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <WorkspaceProvider initialId={initialId}>
              <WorkspaceResolver>
                <Routes>
                  <Route path="/overview" element={<Probe />} />
                  <Route path="/journal" element={<Probe />} />
                  <Route path="/first-run" element={<p data-testid="door">door</p>} />
                </Routes>
              </WorkspaceResolver>
            </WorkspaceProvider>
          </MemoryRouter>
        </I18nProvider>
      </TillClientProvider>,
    );
  }

  it('a cold load with existing books and no memory opens the newest workspace, and remembers it', async () => {
    mount('/overview', client([{ workspaceId: 'ws_new', archived: false }, { workspaceId: 'ws_old', archived: false }]));
    // While the one list read is in flight the loading skeleton stands in for the surface: the
    // no-workspace state never flashes.
    expect(screen.queryByTestId('current')).toBeNull();
    expect(await screen.findByTestId('current')).toHaveTextContent('ws_new');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_new');
  });

  it('with NO workspace at all, the landing route becomes the /first-run door', async () => {
    mount('/overview', client([]));
    expect(await screen.findByTestId('door')).toBeInTheDocument();
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it('with no workspace, a route other than the landing keeps its own state (no redirect)', async () => {
    mount('/journal', client([]));
    expect(await screen.findByTestId('current')).toHaveTextContent('none');
  });

  it('a failed list read falls through to the surface instead of a redirect or a hang', async () => {
    mount('/overview', client(null, 403));
    expect(await screen.findByTestId('current')).toHaveTextContent('none');
  });

  it('a remembered selection renders at once and survives when the list still holds it', async () => {
    mount('/journal', client([{ workspaceId: 'ws_kept', archived: false }]), 'ws_kept');
    expect(screen.getByTestId('current')).toHaveTextContent('ws_kept');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('current')).toHaveTextContent('ws_kept');
  });

  it('a remembered selection the ledger no longer holds is replaced by the newest books', async () => {
    storeWorkspaceId('ws_gone');
    mount('/journal', client([{ workspaceId: 'ws_here', archived: false }]), 'ws_gone');
    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('ws_here'));
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_here');
  });
});
