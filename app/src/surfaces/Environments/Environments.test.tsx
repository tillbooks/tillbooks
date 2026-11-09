/**
 * D126 Phase C component tests: the Umgebungen surface, its dialogs and the shell indicator, covering
 * the states in the section 7 blocks (loading, empty, error, at-scale, success) and the matrix error
 * rows (E7/E1c target=main, E1a source unreachable, E8a mandate not found, E9a standard-tier delete,
 * E9b active-env delete). The transport is keyed by verb; a LOADING assertion proves the read started
 * through the shared `watchReads` seam (loading-state-convention.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { watchReads, neverSettles } from '../../test-transport';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Environments } from './Environments';
import { CopyRefreshDialog } from './CopyRefreshDialog';
import { DeleteDialog } from './DeleteDialog';
import { RailStatusMenu } from '../../app/RailStatusMenu';
import { DensityProvider } from '../../app/density';
import type { EnvironmentRow } from './model';

type Body = RestResponse['body'];
const at = (payload: unknown, status = 200): RestResponse => ({ status, body: payload as Body });

function envRow(name: string, o: Partial<EnvironmentRow> = {}): EnvironmentRow {
  return {
    name,
    codeChannel: name,
    dbPath: `/data/${name}/till.db`,
    dataPolicy: 'synthetic',
    sourceEnv: null,
    sanitization: null,
    guardTier: 'open',
    runtimeTarget: 'local',
    tierRank: 100,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastRefreshAt: '2026-09-05T00:00:00.000Z',
    seed: 'seeblick',
    current: false,
    readOnly: false,
    exists: true,
    sizeBytes: 1_048_576,
    ...o,
  };
}

const MAIN = envRow('main', { guardTier: 'protected', runtimeTarget: 'served', readOnly: true, current: true, tierRank: 400, dataPolicy: 'live' });
// D135: a LOCAL main is the real books, writable, protected against env-wide destruction but NOT a
// read-only face. It gets the calm Live chip, never the "nur lesen" wording.
const MAIN_LOCAL = envRow('main', { guardTier: 'protected', runtimeTarget: 'local', readOnly: false, current: true, tierRank: 400, dataPolicy: 'live' });
const TEST = envRow('test', { tierRank: 300, dataPolicy: 'copy', sanitization: 'pseudonymize' });
const DEVELOP = envRow('develop', { tierRank: 200 });

function listOf(rows: EnvironmentRow[], active = 'main'): RestResponse {
  return at({ ok: true, environments: rows, active, count: rows.length });
}

function transportFor(table: Record<string, RestResponse>): Transport {
  return async (action) => table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
}

const STANDARD = listOf([MAIN, TEST, DEVELOP]);

const ALLOW: Capabilities = { whoami: null, can: () => true, refresh: () => undefined };
const READ_ONLY: Capabilities = { whoami: null, can: (c) => c === 'landscape.read', refresh: () => undefined };
const NO_READ: Capabilities = { whoami: null, can: (c) => c !== 'landscape.read', refresh: () => undefined };

function renderSurface(
  transport: Transport,
  opts: { workspaceId?: string | null; capabilities?: Capabilities } = {},
) {
  const { workspaceId = 'ws_1', capabilities = ALLOW } = opts;
  return render(
    <CapabilitiesContext.Provider value={capabilities}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId={workspaceId}>
            <MemoryRouter initialEntries={['/environments']}>
              <Environments />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

function renderNode(node: React.ReactElement, transport: Transport, capabilities: Capabilities = ALLOW) {
  return render(
    <CapabilitiesContext.Provider value={capabilities}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <MemoryRouter>{node}</MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('Environments surface: the states', () => {
  it('shows a skeleton while the env_list read is in flight (loading)', async () => {
    const transport = watchReads(neverSettles);
    const { container } = renderSurface(transport);
    await transport.started('env_list');
    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton).toBeInTheDocument();
  });

  it('lists the three standard tiers, with main pinned, active and padlocked (success + E7)', async () => {
    renderSurface(transportFor({ env_list: STANDARD }));
    // The name cell is the row header (main also carries the Aktiv chip in its accessible name).
    expect(await screen.findByRole('rowheader', { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /test/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /develop/ })).toBeInTheDocument();
    // main carries the padlock affordance with its "Live, geschützt" label (E7).
    expect(screen.getAllByLabelText('Live, geschützt').length).toBeGreaterThan(0);
    // main is the active environment.
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
  });

  it('shows the first-test-environment card when only main exists (empty)', async () => {
    renderSurface(transportFor({ env_list: listOf([MAIN]) }));
    expect(await screen.findByText('Erstelle deine erste Testumgebung')).toBeInTheDocument();
  });

  it('surfaces a read error rather than an empty grid (error)', async () => {
    renderSurface(transportFor({ env_list: at({ ok: false, error: 'landscape_integrity_failed', reason: 'checksum' }, 422) }));
    // DataTable renders the shared error banner with a retry control.
    expect(await screen.findByText('Erneut versuchen')).toBeInTheDocument();
  });

  it('groups named environments with a filter at scale, and filters by name (at-scale E5b)', async () => {
    const named = Array.from({ length: 15 }, (_, i) => envRow(`test-mig-${i}`, { tierRank: 100 + i }));
    renderSurface(transportFor({ env_list: listOf([MAIN, TEST, DEVELOP, ...named]) }));
    const filter = await screen.findByPlaceholderText('Nach Name suchen');
    expect(filter).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'test-mig-7' })).toBeInTheDocument();
    await userEvent.type(filter, 'test-mig-1');
    // test-mig-1, -10..-14 survive; test-mig-7 is filtered out.
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: 'test-mig-7' })).toBeNull());
    expect(screen.getByRole('rowheader', { name: 'test-mig-10' })).toBeInTheDocument();
  });
});

describe('Environments surface: capability gating', () => {
  it('hides the surface behind a padlock without landscape.read', async () => {
    renderSurface(transportFor({ env_list: STANDARD }), { capabilities: NO_READ });
    expect(await screen.findByText('Kein Zugriff')).toBeInTheDocument();
  });

  it('pre-disables the create action without landscape.manage', async () => {
    renderSurface(transportFor({ env_list: STANDARD }), { capabilities: READ_ONLY });
    const create = await screen.findByRole('button', { name: 'Umgebung erstellen' });
    expect(create).toBeDisabled();
  });
});

describe('Copy / refresh dialog: the four phases and the error rows', () => {
  function renderCopy(target: string, transport: Transport, capabilities: Capabilities = ALLOW) {
    return renderNode(
      <CopyRefreshDialog
        target={target}
        environments={[MAIN, TEST, DEVELOP]}
        canRetainSecrets
        onClose={() => undefined}
        onDone={() => undefined}
      />,
      transport,
      capabilities,
    );
  }

  it('leads with the four named phases (snapshot, restore, sanitize, verify)', () => {
    renderCopy('test', transportFor({}));
    expect(screen.getByText('Schnappschuss der Quelle')).toBeInTheDocument();
    expect(screen.getByText('Wiederherstellen ins Ziel')).toBeInTheDocument();
    expect(screen.getByText('Anonymisieren')).toBeInTheDocument();
    expect(screen.getByText('Prüfen')).toBeInTheDocument();
  });

  it('refuses main as a target with a reason (E1c / E7)', () => {
    renderCopy('main', transportFor({}));
    expect(screen.getByText('main ist geschützt und kann kein Ziel sein.')).toBeInTheDocument();
  });

  it('shows the source-unreachable error with a recovering hint (E1a)', async () => {
    renderCopy('test', transportFor({ env_copy: at({ ok: false, error: 'source_unreachable', source: 'main' }, 422) }));
    await userEvent.click(screen.getByRole('button', { name: 'Kopieren und ersetzen' }));
    expect(await screen.findByText(/nicht erreichbar/)).toBeInTheDocument();
  });

  it('shows the mandate-not-found error (E8a)', async () => {
    renderCopy('test', transportFor({ env_copy: at({ ok: false, error: 'mandate_not_found', mandate: 'ws_9' }, 422) }));
    await userEvent.click(screen.getByRole('radio', { name: 'Nur ein Mandant' }));
    await userEvent.type(screen.getByLabelText('Mandant'), 'ws_9');
    await userEvent.click(screen.getByRole('button', { name: 'Kopieren und ersetzen' }));
    expect(await screen.findByText(/Mandant .* wurde in der Quelle nicht gefunden/)).toBeInTheDocument();
  });

  it('marks every phase done and reports the summary on success', async () => {
    renderCopy('test', transportFor({ env_copy: at({ ok: true, summary: { workspacesCopied: 3, piiCellsMasked: 42 } }) }));
    await userEvent.click(screen.getByRole('button', { name: 'Kopieren und ersetzen' }));
    expect(await screen.findByText(/3 Arbeitsbereiche kopiert, 42 Felder anonymisiert/)).toBeInTheDocument();
  });
});

describe('Delete dialog: the guarded refusals', () => {
  function renderDelete(env: EnvironmentRow, transport: Transport) {
    return renderNode(<DeleteDialog env={env} onClose={() => undefined} onDone={() => undefined} />, transport);
  }

  it('surfaces the standard-tier refusal inline (E9a)', async () => {
    renderDelete(DEVELOP, transportFor({ env_delete: at({ ok: false, error: 'standard_tier', name: 'develop' }, 422) }));
    await userEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    expect(await screen.findByText(/feste Stufe/)).toBeInTheDocument();
  });

  it('surfaces the active-env refusal inline (E9b)', async () => {
    renderDelete(envRow('test-mig-1'), transportFor({ env_delete: at({ ok: false, error: 'environment_active', name: 'test-mig-1' }, 422) }));
    await userEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    expect(await screen.findByText(/ist gerade aktiv/)).toBeInTheDocument();
  });
});

/** The rail footer's environment pill (K-01) needs the density context its menu toggles. */
function renderPill(transport: Transport) {
  return renderNode(
    <DensityProvider initialDensity="komfortabel">
      <RailStatusMenu onCollapse={() => undefined} />
    </DensityProvider>,
    transport,
  );
}

describe('Shell environment pill (D135 face marking, K-01 one footer row)', () => {
  it('marks a writable local main with the calm Live pill, never the read-only wording', async () => {
    const { container } = renderPill(transportFor({ env_list: listOf([MAIN_LOCAL, TEST, DEVELOP], 'main') }));
    const pill = await screen.findByRole('button', { name: /Umgebung: Live, main/ });
    // Calm, not loud: the Live pill is neutral, never the orange test marking.
    expect(pill).toHaveAttribute('data-face', 'live');
    expect(container.querySelector('[data-face="loud"]')).toBeNull();
    expect(pill.textContent).toContain('Live');
    expect(pill.textContent).toContain('main');
    expect(screen.queryByText(/nur lesen/)).toBeNull();
  });

  it('marks a served main as a genuinely read-only (hosted) face, said in words in the menu', async () => {
    // STANDARD's main is served + protected and active: a hosted face, so it says read-only.
    renderPill(transportFor({ env_list: STANDARD }));
    const pill = await screen.findByRole('button', { name: /Umgebung: Gehostet, main/ });
    expect(pill).toHaveAttribute('data-face', 'served');
    await userEvent.click(pill);
    expect(screen.getByText(/nur lesen \(gehostet\)/)).toBeInTheDocument();
  });

  it('marks a test / sandbox environment with the loud orange pill, never the Live one', async () => {
    renderPill(transportFor({ env_list: listOf([MAIN, TEST, DEVELOP], 'test') }));
    const pill = await screen.findByRole('button', { name: /Umgebung: Test, test/ });
    expect(pill).toHaveAttribute('data-face', 'loud');
    expect(screen.queryByText(/nur lesen/)).toBeNull();
  });

  it('carries the egress state in words, never the dot alone', async () => {
    renderPill(transportFor({ env_list: listOf([MAIN_LOCAL, TEST, DEVELOP], 'main') }));
    const pill = await screen.findByRole('button', { name: /Lokal, keine Verbindung/ });
    await userEvent.click(pill);
    // The menu opens on the same dot with its words beside it.
    expect(screen.getByText('Lokal, keine Verbindung')).toBeInTheDocument();
  });

  it('shows the egress word alone when the landscape is unavailable, and the menu stays reachable', async () => {
    renderPill(transportFor({}));
    const pill = await screen.findByRole('button', { name: /Lokal, keine Verbindung/ });
    expect(pill).toHaveAttribute('data-face', 'none');
    expect(pill.textContent).toContain('Lokal');
    await userEvent.click(pill);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Kompakte Ansicht' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Navigation einklappen' })).toBeInTheDocument();
  });

  it('opens a menu with "Umgebungen verwalten" first, the environments as radio items, then the view items', async () => {
    renderPill(transportFor({ env_list: listOf([MAIN_LOCAL, TEST, DEVELOP], 'main') }));
    await userEvent.click(await screen.findByRole('button', { name: /Umgebung: Live, main/ }));
    const menu = screen.getByRole('menu');
    const items = [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);
    expect(items).toEqual(['Umgebungen verwalten', 'main', 'test', 'develop', 'Kompakte Ansicht', 'Navigation einklappen']);
    expect(screen.getByRole('menuitemradio', { name: 'main' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'test' })).toHaveAttribute('aria-checked', 'false');
    // Focus lands on the first item, and Escape hands it back to the pill.
    expect(screen.getByRole('menuitem', { name: 'Umgebungen verwalten' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: /Umgebung: Live, main/ })).toHaveFocus();
  });

  it('toggles the density from its checkbox item', async () => {
    renderPill(transportFor({ env_list: listOf([MAIN_LOCAL, TEST, DEVELOP], 'main') }));
    await userEvent.click(await screen.findByRole('button', { name: /Umgebung: Live, main/ }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Kompakte Ansicht' });
    expect(item).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(item);
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
    await userEvent.click(screen.getByRole('button', { name: /Umgebung: Live, main/ }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Kompakte Ansicht' })).toHaveAttribute('aria-checked', 'true');
  });

  it('names the engine fallback when the active environment is missing, and says why in the menu', async () => {
    renderPill(transportFor({ env_list: listOf([MAIN, TEST], 'gone') }));
    const pill = await screen.findByRole('button', { name: /Umgebung: develop/ });
    await userEvent.click(pill);
    expect(screen.getByText(/Umgebung nicht gefunden/)).toBeInTheDocument();
  });
});
