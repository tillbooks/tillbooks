/**
 * E07 Vertrauen panel component test (spec §8): the indicator renders all three states; the limits
 * list renders IN FULL (each key snapshot-asserted, so a future tidy cannot quietly drop the iCloud
 * one); "Jetzt prüfen" reports passed and violated honestly; a refused status shows the padlock; and
 * NO banned superlative ("bulletproof", "unbreakable", "impossible", "military-grade") appears in the
 * rendered copy, because this panel's whole value is that it underclaims.
 *
 * Rendered in de-CH (the I18nProvider default), so the assertions read the de-CH catalogue directly.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Trust, SETUP_DOORS } from './Trust';
import { SyncHosting } from './SyncHosting';
import { SyncSignalProvider } from './sync-signal';
import de from './messages.de-CH.json';
import en from './messages.en.json';
import shell from '../../i18n/de-CH.json';

// M02: the sync line's copy lives in the shell locale (i18n/de-CH.json), not the Setup fragment.
const syncTrust = (shell as { sync: { trust: { publishing: string } } }).sync.trust.publishing;

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
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const whoami = (caps: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities: caps });

const baseCanned = (): Canned => ({
  whoami: whoami(['egress.read']),
  egress_status: ok({ state: 'local', socketsOpened: 0, since: '2026-08-06T00:00:00.000Z' }),
  // M03 (V2): the data-location line reads delivery_status for the opened file's path.
  delivery_status: ok({ mode: 'up', version: '0.0.0', schemaGeneration: 6, dbPath: '/Users/x/.till/till.db' }),
});

function tree(canned: Canned) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Trust />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Trust (E07 Vertrauen panel)', () => {
  it('INDICATOR local: renders the local state glyph + label from egress_status', async () => {
    render(tree(baseCanned()));
    expect(await screen.findByText(de.egress.indicator.local)).toBeInTheDocument();
  });

  it('INDICATOR unknown: an unverified process renders unknown, never an optimistic local', async () => {
    render(tree({ ...baseCanned(), egress_status: ok({ state: 'unknown', socketsOpened: 0, since: null }) }));
    expect(await screen.findByText(de.egress.indicator.unknown)).toBeInTheDocument();
    expect(screen.queryByText(de.egress.indicator.local)).not.toBeInTheDocument();
  });

  it('INDICATOR violated: an observed socket renders the violated state', async () => {
    render(
      tree({
        ...baseCanned(),
        egress_status: ok({
          state: 'violated',
          socketsOpened: 1,
          since: '2026-08-06T00:00:00.000Z',
          offenders: [{ kind: 'tcp_connect', host: '203.0.113.9', target: '203.0.113.9:443' }],
        }),
      }),
    );
    // The indicator label appears (the header status); at least one instance.
    expect((await screen.findAllByText(de.egress.indicator.violated)).length).toBeGreaterThan(0);
  });

  it('LIMITS: the honest limits list renders IN FULL, iCloud/backup included (snapshot per key)', async () => {
    render(tree(baseCanned()));
    await screen.findByText(de.egress.indicator.local);
    expect(screen.getByText(de.egress.limits.title)).toBeInTheDocument();
    // Each limit key present: a future tidy cannot quietly drop one (spec §8).
    expect(screen.getByText(de.egress.limits.os)).toBeInTheDocument();
    expect(screen.getByText(de.egress.limits.machine)).toBeInTheDocument();
    expect(screen.getByText(de.egress.limits.disk)).toBeInTheDocument();
    // D96: the standing indicator's network-socket-only scope, named out loud (the on-demand
    // self-test is what covers subprocess and higher-layer vectors).
    expect(screen.getByText(de.egress.limits.sockets)).toBeInTheDocument();
    expect(screen.getByText(de.egress.limits.trust_us)).toBeInTheDocument();
    // The one deliberate network event, named out loud.
    expect(screen.getByText(de.egress.model_download.note)).toBeInTheDocument();
    // And the scope note, first (this is about TILL, not the Mac).
    expect(screen.getByText(de.egress.scope.note)).toBeInTheDocument();
  });

  it('CHECK PASSED: pressing Jetzt prüfen on a clean run reports the draft was written wifi-off', async () => {
    render(
      tree({
        ...baseCanned(),
        egress_self_test: ok({ passed: true, state: 'local', socketsOpened: 0, offenders: [], draftId: 'maildrf_1', steps: [] }),
      }),
    );
    await screen.findByText(de.egress.indicator.local);
    await userEvent.click(screen.getByRole('button', { name: de.egress.action.run }));
    expect(await screen.findByText(de.egress.setup.passed)).toBeInTheDocument();
  });

  it('CHECK VIOLATED: a dial-out flips the panel to violated and names the offender + report path', async () => {
    render(
      tree({
        ...baseCanned(),
        egress_self_test: reject(
          'egress_violated',
          { state: 'violated', passed: false, socketsOpened: 1, offenders: [{ kind: 'tcp_connect', host: '203.0.113.9', target: '203.0.113.9:443' }] },
          422,
        ),
      }),
    );
    await screen.findByText(de.egress.indicator.local);
    await userEvent.click(screen.getByRole('button', { name: de.egress.action.run }));
    expect(await screen.findByText(de.egress.violated.report)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.9/)).toBeInTheDocument();
  });

  it('PERMISSION-DENIED: a refused status renders the padlock, not a crash', async () => {
    render(tree({ ...baseCanned(), whoami: whoami([]), egress_status: reject('permission_denied', {}, 403) }));
    expect(await screen.findByText(de.egress.permissionDenied)).toBeInTheDocument();
  });

  it('NO BANNED SUPERLATIVE: the panel underclaims, so the forbidden words never appear', async () => {
    const { container } = render(tree(baseCanned()));
    await screen.findByText(de.egress.indicator.local);
    const text = container.textContent ?? '';
    for (const banned of ['bulletproof', 'unbreakable', 'impossible', 'military-grade']) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it('A11Y: the panel has no axe violations', async () => {
    const { container } = render(tree(baseCanned()));
    await screen.findByText(de.egress.indicator.local);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('M02 SYNC LINE ON: the availability line shows when the ledger stream is published', async () => {
    render(tree({ ...baseCanned(), get_sync_contract: ok({ publishing: true, contractVersion: 'till-sync/1' }) }));
    expect(await screen.findByText(syncTrust)).toBeInTheDocument();
  });

  it('M02 SYNC LINE OFF: the line disappears entirely when publishing is off', async () => {
    render(tree({ ...baseCanned(), get_sync_contract: ok({ publishing: false }) }));
    await screen.findByText(de.egress.indicator.local);
    expect(screen.queryByText(syncTrust)).not.toBeInTheDocument();
  });

  it('M02 SYNC LINE ERROR-SILENT: a failed sync read renders nothing extra, the panel is unchanged', async () => {
    // No get_sync_contract handler: the read 404s, fails silent, and the line never appears.
    render(tree(baseCanned()));
    await screen.findByText(de.egress.indicator.local);
    expect(screen.queryByText(syncTrust)).not.toBeInTheDocument();
  });
});

describe('Trust data-location line (M03 V2)', () => {
  const J = (de as unknown as { journey: { location: Record<string, string> } }).journey.location;

  it('LOCAL: names the database path off delivery_status, with the backup and hosting links', async () => {
    render(tree(baseCanned()));
    expect(
      await screen.findByText(J.local.replace('{path}', '/Users/x/.till/till.db')),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: J.backupLink })).toHaveAttribute('href', '#data-title');
    expect(screen.getByRole('link', { name: J.hostingLink })).toHaveAttribute('href', '#sync-title');
  });

  it('UNKNOWN: a failed delivery_status read renders the explicit unknown with retry, never a guessed path', async () => {
    render(tree({ ...baseCanned(), delivery_status: reject('unexpected_error', {}, 500) }));
    expect(await screen.findByText(J.unknown)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: J.retry })).toBeInTheDocument();
    expect(screen.queryByText(/till\.db/)).not.toBeInTheDocument();
  });

  it('SERVED: states the instance posture instead of a local path, second link at the exit box (S5.1)', async () => {
    render(
      tree({
        ...baseCanned(),
        whoami: ok({
          actor: 'studio',
          role: 'owner',
          isMember: true,
          provisioned: true,
          memberId: 'm1',
          userId: 'u1',
          capabilities: ['egress.read'],
          subject: 'a@b.ch',
          identitySource: 'served_subject',
        }),
      }),
    );
    expect(await screen.findByText(J.served)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: J.exitLink })).toHaveAttribute('href', '#sync-exit');
    expect(screen.queryByText(/till\.db/)).not.toBeInTheDocument();
  });
});

describe('Trust + SyncHosting live coupling (M02 dial flip, no reload)', () => {
  // Both panels read the SAME get_sync_contract. This shared transport lets a flip on the SyncHosting
  // dial mutate the contract, so we can assert the Trust line reflects it without remounting: the
  // proof the SyncSignalProvider actually re-reads Trust, not just that each panel reads at mount.
  function coupledTree() {
    let publishing = false;
    const canned: Canned = {
      whoami: whoami(['egress.read', 'manage_sync']),
      egress_status: ok({ state: 'local', socketsOpened: 0, since: '2026-08-06T00:00:00.000Z' }),
      // M03: the Trust location line and the Hosting journey block read these on mount.
      delivery_status: ok({ mode: 'up', version: '0.0.0', schemaGeneration: 6, dbPath: '/Users/x/.till/till.db' }),
      get_move_state: ok({ move: null }),
      get_workspace: ok({
        workspace: { workspaceId: 'ws_1', name: 'Echt GmbH', legalForm: 'gmbh', baseCurrency: 'CHF', fiscalYearStart: '01-01', archived: false, createdAt: '2026-01-01' },
      }),
      get_sync_contract: () =>
        ok({ contractVersion: 'till-sync/1', publishing, epoch: publishing ? 'ep_1' : null, headSeq: publishing ? 1 : 0 }),
      sync_publish_enable: () => {
        publishing = true;
        return ok({ publishing: true });
      },
      sync_publish_disable: () => {
        publishing = false;
        return ok({ publishing: false });
      },
    };
    return (
      <TillClientProvider client={new TillClient(fakeTransport(canned))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <CapabilitiesProvider>
              <MemoryRouter>
                <SyncSignalProvider>
                  <Trust />
                  <SyncHosting />
                </SyncSignalProvider>
              </MemoryRouter>
            </CapabilitiesProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    );
  }

  it('FLIP ON: enabling the dial makes the Trust availability line appear live, no reload', async () => {
    render(coupledTree());
    // Both panels have read the OFF contract: the Trust line is absent to start.
    await screen.findByText(de.egress.indicator.local);
    expect(screen.queryByText(syncTrust)).not.toBeInTheDocument();
    // Flip the dial on. The switch enables once whoami (manage_sync) has loaded.
    const dial = await screen.findByRole('switch');
    await waitFor(() => expect(dial).toBeEnabled());
    await userEvent.click(dial);
    // The Trust line now reflects the flip, purely from the shared signal re-reading the contract.
    expect(await screen.findByText(syncTrust)).toBeInTheDocument();
  });

  it('FLIP OFF: disabling the dial removes the Trust availability line live, no reload', async () => {
    render(coupledTree());
    const dial = await screen.findByRole('switch');
    await waitFor(() => expect(dial).toBeEnabled());
    // On first, so the line is present.
    await userEvent.click(dial);
    expect(await screen.findByText(syncTrust)).toBeInTheDocument();
    // Off again: the line disappears without a remount.
    await userEvent.click(dial);
    await waitFor(() => expect(screen.queryByText(syncTrust)).not.toBeInTheDocument());
  });
});

/**
 * F-10 (J7.6): the self-test's setup refusal names each missing piece in words and links the surface
 * where it is set up; no raw engine key reaches the screen.
 */
describe('Trust: the self-test refusal names its doors (F-10, J7.6)', () => {
  it('needs_setup renders three humanised lines, each a link to its surface', async () => {
    render(
      tree({
        ...baseCanned(),
        egress_self_test: reject('needs_setup', { missing: ['mail_store', 'voice_profile', 'local_runtime'] }, 422),
      }),
    );
    await screen.findByText(de.egress.indicator.local);
    await userEvent.click(screen.getByRole('button', { name: de.egress.action.run }));
    expect(await screen.findByText(de.egress.setup.needsIntro)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ein Postfach verbinden (Korrespondenz)' })).toHaveAttribute('href', '/correspondence');
    expect(screen.getByRole('link', { name: 'Deinen Schreibstil anlernen (Schreibstil)' })).toHaveAttribute('href', '/writing-style');
    expect(screen.getByRole('link', { name: 'Die lokale Entwurfs-Engine installieren (Schreibstil)' })).toHaveAttribute('href', '/writing-style');
    const panel = screen.getByText(de.egress.setup.needsIntro).closest('.trust-note') as HTMLElement;
    expect(panel.textContent).not.toMatch(/mail_store|voice_profile|local_runtime/);
  });

  /**
   * Critic F3 (2026-09-05): the engine pushes a FOURTH key, `draftable_thread`, on exactly the install
   * that has finished its setup and has an empty inbox, and it reached the screen raw. The finished
   * install is the case the flow never measured (the harness has no mail store), so it is pinned here.
   */
  it('the finished install with an empty inbox is told in words where a draftable thread comes from', async () => {
    render(
      tree({
        ...baseCanned(),
        egress_self_test: reject('needs_setup', { missing: ['draftable_thread'] }, 422),
      }),
    );
    await screen.findByText(de.egress.indicator.local);
    await userEvent.click(screen.getByRole('button', { name: de.egress.action.run }));
    expect(await screen.findByText(de.egress.setup.needsIntro)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Eine unbeantwortete Nachricht, auf die TILL antworten kann (Korrespondenz)' })).toHaveAttribute(
      'href',
      '/correspondence',
    );
    const panel = screen.getByText(de.egress.setup.needsIntro).closest('.trust-note') as HTMLElement;
    expect(panel.textContent).not.toMatch(/draftable_thread/);
  });

  /**
   * The drift guard behind the two tests above: EVERY key `egressSelfTest` can push into
   * `needs_setup.missing` has a door in `SETUP_DOORS` and a sentence in both locales. The vocabulary
   * is read off the engine source, so a prerequisite added there without a door here reds this test
   * instead of printing a raw key on `/trust`.
   */
  it('every needs_setup key the engine can push has a door and a sentence in both locales', () => {
    // vitest runs from `app/`; the engine source sits one level up.
    const engine = readFileSync(resolve(process.cwd(), '..', 'src', 'core', 'egress', 'egress.ts'), 'utf8');
    const keys = Array.from(engine.matchAll(/missing\.push\('([a-z_]+)'\)/g), (m) => m[1] as string);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(keys).toContain('draftable_thread');
    for (const key of keys) {
      expect(SETUP_DOORS[key], `door for ${key}`).toMatch(/^\//);
      expect((de.egress.setup.missing as Record<string, string>)[key], `de-CH sentence for ${key}`).toBeTruthy();
      expect((en.egress.setup.missing as Record<string, string>)[key], `en sentence for ${key}`).toBeTruthy();
    }
  });
});
