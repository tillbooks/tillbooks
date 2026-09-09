/**
 * K-13, the first-hour setup card. Three facts the card must uphold: it appears on a fresh,
 * data-less workspace with a link to every setup step; it stays hidden once the workspace carries
 * real data; and a dismissal persists per viewer, so it does not come back on the next render.
 *
 * The card reads the workspace's freshness from the SAME tiles the overview already loaded, so
 * these tests hand it tile arrays directly rather than driving the whole surface. The dismissal
 * store is `localStorage`, cleared between tests so one test's dismissal never leaks into the next.
 */
import { useEffect, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse } from '../../lib/client';
import { SetupCard, readSetupCardDismissed, setupDoneFrom, workspaceHasData } from './SetupCard';
import type { DashboardTileView } from './Uebersicht';

/** The one read the card makes (F-09): `get_company_profile`, answered per test. */
function makeClient(profile: Record<string, unknown> | null): TillClient {
  return new TillClient(async (action): Promise<RestResponse> => {
    if (action === 'get_company_profile' && profile !== null) return { status: 200, body: { ok: true, profile } };
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  });
}

/** A workspace straight from the create door: no legal form, no MWST method, no IBAN yet. */
const BARE_PROFILE = { workspaceId: 'ws_test', name: 'Bergblick AG', legalForm: null, vatMethod: null, creditorIban: null };
/** A fresh, all-false second mandate: nothing is configured. */
const FRESH_MANDATE = { workspaceId: 'ws_fresh', name: 'Talblick GmbH', legalForm: null, vatMethod: null, creditorIban: null };
/** After the one-panel save (F-09): legal form, MWST method and IBAN stored. */
const ANSWERED_PROFILE = { workspaceId: 'ws_test', name: 'Bergblick AG', legalForm: 'ag', vatMethod: 'effektiv', creditorIban: 'CH9300762011623852957' };

/** A fresh workspace: every tile rendered (`ok`) but at a zero or absent figure, exactly what the
 *  engine answers for an empty ledger (zero-state tiles, degraded modules). */
const FRESH_TILES: DashboardTileView[] = [
  { tile: 'revenue', ok: true, valueRappen: 0, currency: 'CHF', trendBp: null },
  { tile: 'cash', ok: true, valueRappen: 0, currency: 'CHF' },
  { tile: 'utilisation', ok: true, valueBp: null, currency: 'CHF' },
  { tile: 'stock_value', ok: false, error: 'needs_stock_items' },
];

/** An established workspace: at least one tile carries a real, non-zero figure. */
const ESTABLISHED_TILES: DashboardTileView[] = [
  { tile: 'revenue', ok: true, valueRappen: 3000000, currency: 'CHF', trendBp: 250 },
  { tile: 'cash', ok: true, valueRappen: 0, currency: 'CHF' },
];

function renderCard(tiles: DashboardTileView[], profile: Record<string, unknown> | null = BARE_PROFILE) {
  return render(
    <TillClientProvider client={makeClient(profile)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/overview']}>
            <SetupCard tiles={tiles} />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('SetupCard: the first-hour setup guide', () => {
  it('a fresh, data-less workspace shows the card with a link to every setup step', async () => {
    renderCard(FRESH_TILES);
    expect(screen.getByRole('heading', { name: 'Ersteinrichtung' })).toBeInTheDocument();
    // Every entry path is covered, each a real link into the surface that does the step.
    expect(screen.getByRole('link', { name: /Firmenprofil vervollständigen/ })).toHaveAttribute('href', '/setup');
    expect(screen.getByRole('link', { name: /MWST einrichten/ })).toHaveAttribute('href', '/vat');
    expect(screen.getByRole('link', { name: /Kontenplan prüfen/ })).toHaveAttribute('href', '/accounts');
    expect(screen.getByRole('link', { name: /Ersten Kontakt/ })).toHaveAttribute('href', '/contacts');
    expect(screen.getByRole('link', { name: /Ersten Artikel/ })).toHaveAttribute('href', '/items');
    expect(screen.getByRole('link', { name: /Erste Rechnung/ })).toHaveAttribute('href', '/documents');
    // The card reads get_company_profile once and writes its done-state back unconditionally; flush
    // that read so its state update lands inside act rather than after the test returns.
    await act(async () => {});
  });

  it('F-09: steps the profile already answers are marked done, in words, and stay links', async () => {
    renderCard(FRESH_TILES, ANSWERED_PROFILE);
    const profileStep = await screen.findByRole('link', { name: /Firmenprofil vervollständigen/ });
    expect(profileStep).toHaveAccessibleDescription('erledigt');
    expect(profileStep).toHaveAttribute('href', '/setup');
    expect(screen.getByRole('link', { name: /MWST einrichten/ })).toHaveAccessibleDescription('erledigt');
    // The steps the profile cannot answer stay open.
    expect(screen.getByRole('link', { name: /Erste Rechnung/ })).not.toHaveAccessibleDescription('erledigt');
    expect(screen.getAllByText('erledigt')).toHaveLength(2);
  });

  it('F-09: a bare profile (or a failed read) marks nothing done', async () => {
    renderCard(FRESH_TILES, null);
    await screen.findByRole('heading', { name: 'Ersteinrichtung' });
    expect(screen.queryByText('erledigt')).not.toBeInTheDocument();
    expect(setupDoneFrom(BARE_PROFILE)).toEqual({ profile: false, vat: false });
    expect(setupDoneFrom(ANSWERED_PROFILE)).toEqual({ profile: true, vat: true });
    // The IBAN alone is not a complete profile step; the legal form alone is not either.
    expect(setupDoneFrom({ legalForm: 'gmbh', creditorIban: null, vatMethod: 'none' })).toEqual({ profile: false, vat: true });
  });

  it('an established workspace (real data) does NOT render the card', async () => {
    renderCard(ESTABLISHED_TILES);
    expect(screen.queryByRole('heading', { name: 'Ersteinrichtung' })).not.toBeInTheDocument();
    // The card renders null here but the profile read still runs; flush its state update into act.
    await act(async () => {});
  });

  it('dismissing the card hides it and it stays hidden on a re-render (persisted per viewer)', async () => {
    const { unmount } = renderCard(FRESH_TILES);
    expect(screen.getByRole('heading', { name: 'Ersteinrichtung' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ausblenden' }));
    expect(screen.queryByRole('heading', { name: 'Ersteinrichtung' })).not.toBeInTheDocument();

    // A fresh render of the same fresh workspace stays hidden: the dismissal was persisted, not just
    // held in component state.
    unmount();
    renderCard(FRESH_TILES);
    expect(screen.queryByRole('heading', { name: 'Ersteinrichtung' })).not.toBeInTheDocument();
    // Flush the profile read's unconditional done-write so it lands inside act.
    await act(async () => {});
  });

  it('the dismissal is filed per workspace and per user, not globally', async () => {
    renderCard(FRESH_TILES);
    await userEvent.click(screen.getByRole('button', { name: 'Ausblenden' }));
    // The store reads back as dismissed for THIS workspace-and-user scope (ws_test, the default
    // local viewer), and not for a different workspace, so the flag is scoped, not global.
    expect(readSetupCardDismissed('ws_test', null)).toBe(true);
    expect(readSetupCardDismissed('ws_other', null)).toBe(false);
  });

  it('the fresh state has no axe violations', async () => {
    const { container } = renderCard(FRESH_TILES);
    // Flush the profile read's unconditional done-write into act BEFORE the (non-act) axe pass, so
    // the state update cannot land mid-audit and escape act.
    await act(async () => {});
    expect(await axe(container)).toHaveNoViolations();
  });

  it('F-new-1: switching to a fresh all-false mandate resets the stale done (no lingering "erledigt")', async () => {
    // The card is NOT remounted on a workspace change (no key={workspaceId}), so its `done` state
    // survives the switch. When the person moves from a configured mandate to a fresh one, the effect
    // must overwrite that state, or the previous mandate's "erledigt" lingers over an unconfigured
    // step. This drives the SAME mounted card through the switch, changing both the workspace id (via
    // the context setter) and the client, exactly as the app does.
    const configuredRead = vi.fn();
    const freshRead = vi.fn();

    /** Pushes the target workspace id into the context on change, so the card sees a real switch. */
    function WsSync({ target }: { target: string }) {
      const { setWorkspaceId } = useWorkspace();
      useEffect(() => {
        setWorkspaceId(target);
      }, [target, setWorkspaceId]);
      return null;
    }

    function Harness() {
      const [ws, setWs] = useState('ws_configured');
      // A new client per mandate: its identity changes, so the card's [client, workspaceId] effect
      // re-runs and reads the new mandate's profile.
      const client = useMemo(
        () =>
          new TillClient(async (action): Promise<RestResponse> => {
            if (action !== 'get_company_profile') return { status: 404, body: { ok: false, error: 'unknown_action' } };
            if (ws === 'ws_configured') {
              configuredRead();
              return { status: 200, body: { ok: true, profile: ANSWERED_PROFILE } };
            }
            freshRead();
            return { status: 200, body: { ok: true, profile: FRESH_MANDATE } };
          }),
        [ws],
      );
      return (
        <TillClientProvider client={client}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_configured">
              <MemoryRouter initialEntries={['/overview']}>
                <WsSync target={ws} />
                <button type="button" onClick={() => setWs('ws_fresh')}>
                  wechseln
                </button>
                <SetupCard tiles={FRESH_TILES} />
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      );
    }

    render(<Harness />);
    // The configured mandate marks two steps done.
    await waitFor(() => expect(screen.getAllByText('erledigt')).toHaveLength(2));

    // Switch to the fresh, all-false mandate.
    await userEvent.click(screen.getByRole('button', { name: 'wechseln' }));
    await waitFor(() => expect(freshRead).toHaveBeenCalled());
    await act(async () => {});

    // The fresh mandate has nothing configured: the previous mandate's done must not survive.
    expect(screen.queryByText('erledigt')).not.toBeInTheDocument();
  });

  it('F-new-1 (transient): the switch clears done SYNCHRONOUSLY, before the fresh profile read resolves', async () => {
    // F-new-1 made the async write unconditional, but there is still a window between the switch and
    // the fresh read resolving where mandate A's "erledigt" would paint over B. This drives the switch
    // into a mandate whose read STAYS PENDING and asserts the stale done is already gone: the only
    // thing that can have cleared it while the read is unresolved is the synchronous [workspaceId] reset.
    let resolveFresh: () => void = () => {};
    const freshPending = new Promise<void>((resolve) => {
      resolveFresh = resolve;
    });

    function WsSync({ target }: { target: string }) {
      const { setWorkspaceId } = useWorkspace();
      useEffect(() => {
        setWorkspaceId(target);
      }, [target, setWorkspaceId]);
      return null;
    }

    function Harness() {
      const [ws, setWs] = useState('ws_configured');
      const client = useMemo(
        () =>
          new TillClient(async (action): Promise<RestResponse> => {
            if (action !== 'get_company_profile') return { status: 404, body: { ok: false, error: 'unknown_action' } };
            if (ws === 'ws_configured') return { status: 200, body: { ok: true, profile: ANSWERED_PROFILE } };
            await freshPending; // the fresh mandate's read is held open on purpose.
            return { status: 200, body: { ok: true, profile: FRESH_MANDATE } };
          }),
        [ws],
      );
      return (
        <TillClientProvider client={client}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_configured">
              <MemoryRouter initialEntries={['/overview']}>
                <WsSync target={ws} />
                <button type="button" onClick={() => setWs('ws_fresh')}>
                  wechseln
                </button>
                <SetupCard tiles={FRESH_TILES} />
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(screen.getAllByText('erledigt')).toHaveLength(2));

    // Switch. The fresh read is pending, so no async write can clear the done: only the sync reset can.
    await userEvent.click(screen.getByRole('button', { name: 'wechseln' }));
    await waitFor(() => expect(screen.queryByText('erledigt')).not.toBeInTheDocument());

    // Letting the read resolve leaves it clear (the fresh mandate is all-false).
    resolveFresh();
    await act(async () => {});
    expect(screen.queryByText('erledigt')).not.toBeInTheDocument();
  });
});

describe('workspaceHasData: the freshness signal read from the tiles', () => {
  it('is false when every tile is zero, absent or degraded', () => {
    expect(workspaceHasData(FRESH_TILES)).toBe(false);
    expect(workspaceHasData([])).toBe(false);
  });

  it('is true as soon as one rendered tile carries a non-zero figure', () => {
    expect(workspaceHasData(ESTABLISHED_TILES)).toBe(true);
    expect(workspaceHasData([{ tile: 'utilisation', ok: true, valueBp: 8250 }])).toBe(true);
  });

  it('a non-zero figure on a degraded (ok:false) tile does not count as data', () => {
    expect(workspaceHasData([{ tile: 'revenue', ok: false, valueRappen: 999 }])).toBe(false);
  });
});
