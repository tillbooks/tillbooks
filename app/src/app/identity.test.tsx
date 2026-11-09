/**
 * M01 identity chrome: the chip and the two served-access resolver pages.
 *
 * Every case drives the components off a `Capabilities` context value shaped exactly like the one the
 * `CapabilitiesProvider` publishes from `whoami`, because that is the single source these components
 * read (see `../lib/capabilities`). The load-bearing assertions are the two the spec turns on: the
 * chip is ABSENT in local mode (a laptop user has no login and must not be shown a fake one), and it
 * is PRESENT in served mode; and the resolver gate renders a proper page with a heading rather than
 * an empty ledger or a crash.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ReactNode } from 'react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { CapabilitiesContext, type Capabilities, type Whoami } from '../lib/capabilities';
import { CapabilitiesProvider } from '../lib/CapabilitiesProvider';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { WorkspaceProvider, useWorkspaceId } from './workspace';
import { ThemeProvider } from './theme';
import { DensityProvider } from './density';
import { Shell } from './Shell';
import { Placeholder } from './Placeholder';
import { NAV_ITEMS } from './nav';
import {
  captureInviteDeepLink,
  extractInviteToken,
  IdentityChip,
  IdentityGate,
  NotAMemberPage,
  SignInRequiredPage,
} from './identity';
import deCatalog from '../i18n/de-CH.json';

/** A `whoami` answer with sensible defaults; each test overrides only what it exercises. */
function whoami(overrides: Partial<Whoami> = {}): Whoami {
  return {
    actor: 'member:u_1',
    provisioned: true,
    isMember: true,
    memberId: 'm_1',
    userId: 'u_1',
    role: 'bookkeeper',
    capabilities: ['read_master_data'],
    identitySource: 'served_subject',
    subject: 'dominic@example.ch',
    ...overrides,
  };
}

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

/**
 * Wrap a subtree in the i18n, client and workspace providers plus a Capabilities context carrying
 * `value`. The client and workspace providers exist because the M03-extended NotAMemberPage calls
 * `accept_invite` through the client and selects the granted workspace on success; components that
 * never call either simply ignore them.
 */
function withCaps(node: ReactNode, value: Whoami | null, canned: Canned = {}, refresh: () => void = () => undefined) {
  const caps: Capabilities = { whoami: value, can: () => true, refresh };
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_current">
          <CapabilitiesContext.Provider value={caps}>{node}</CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('M01 IdentityChip: served vs local (the spec-load-bearing case)', () => {
  it('is ABSENT in local mode: a laptop user has no login and must not be shown a fake one', () => {
    withCaps(<IdentityChip />, whoami({ identitySource: 'local_client', subject: null }));
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
  });

  it('is ABSENT when identitySource is omitted (an older payload reads as a laptop)', () => {
    withCaps(<IdentityChip />, whoami({ identitySource: undefined, subject: null }));
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
  });

  it('is ABSENT while whoami is still loading (null), never a placeholder identity', () => {
    // LOADING-PROOF-EXEMPT: IdentityChip reads whoami from CapabilitiesProvider context, and this test injects whoami=null directly through withCaps, so there is no transport and nothing in flight to prove.
    withCaps(<IdentityChip />, null);
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
  });

  it('is ABSENT in served mode with no subject (nothing to name), never a blank chip', () => {
    withCaps(<IdentityChip />, whoami({ subject: null }));
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
  });

  it('is PRESENT in served mode, naming the subject and the role, both verbatim from whoami', () => {
    withCaps(<IdentityChip />, whoami());
    const chip = screen.getByRole('button', { name: 'Angemeldet als dominic@example.ch' });
    expect(chip).toHaveTextContent('dominic@example.ch');
    expect(chip).toHaveTextContent('Buchhaltung');
  });

  it('opens the details whoami returns, and Esc closes it and restores focus to the chip', async () => {
    withCaps(<IdentityChip />, whoami());
    const chip = screen.getByRole('button', { name: 'Angemeldet als dominic@example.ch' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('dialog', { name: 'Sitzungsdetails' });
    expect(details).toHaveTextContent('dominic@example.ch');
    expect(details).toHaveTextContent('bookkeeper');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Sitzungsdetails' })).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('has no axe violations with the details open', async () => {
    const { container } = withCaps(<IdentityChip />, whoami());
    await userEvent.click(screen.getByRole('button', { name: 'Angemeldet als dominic@example.ch' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M01 NotAMemberPage: a proper page with a heading, not a toast', () => {
  it('renders a heading and a body naming the subject with the operator hint', () => {
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami());
    expect(
      screen.getByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' }),
    ).toBeInTheDocument();
    const body = screen.getByText(/bob@treuhand\.ch/);
    expect(body).toHaveTextContent('bob@treuhand.ch');
    expect(body).toHaveTextContent('Einladung');
  });

  it('has no axe violations', async () => {
    const { container } = withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami());
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M01 SignInRequiredPage: the 401-shape renders a page, never a crash', () => {
  it('renders a heading and the missing-subject explanation', () => {
    withCaps(<SignInRequiredPage />, null);
    expect(screen.getByRole('heading', { name: 'Anmeldung erforderlich' })).toBeInTheDocument();
    expect(screen.getByText(/ohne bestätigte Identität/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = withCaps(<SignInRequiredPage />, null);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M01 IdentityGate: which face a request meets', () => {
  const surface = <div data-testid="surface">the ledger</div>;

  it('renders the surface in local mode (a header nobody vouches for grants nothing)', () => {
    withCaps(<IdentityGate>{surface}</IdentityGate>, whoami({ identitySource: 'local_client', subject: null }));
    expect(screen.getByTestId('surface')).toBeInTheDocument();
  });

  it('renders the surface while whoami is loading (null), never blanking a working ledger', () => {
    // LOADING-PROOF-EXEMPT: IdentityGate reads whoami from CapabilitiesProvider context, and this test injects whoami=null directly through withCaps, so there is no transport and nothing in flight to prove.
    withCaps(<IdentityGate>{surface}</IdentityGate>, null);
    expect(screen.getByTestId('surface')).toBeInTheDocument();
  });

  it('renders the surface for a resolved served member', () => {
    withCaps(<IdentityGate>{surface}</IdentityGate>, whoami({ isMember: true }));
    expect(screen.getByTestId('surface')).toBeInTheDocument();
  });

  it('renders the not-a-member page for a served subject who is not a member', () => {
    withCaps(<IdentityGate>{surface}</IdentityGate>, whoami({ isMember: false, subject: 'stranger@x.ch' }));
    expect(screen.queryByTestId('surface')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/stranger@x\.ch/)).toBeInTheDocument();
  });

  it('renders the sign-in-required page for served mode with no subject (the 401-shape)', () => {
    withCaps(<IdentityGate>{surface}</IdentityGate>, whoami({ isMember: false, subject: null }));
    expect(screen.queryByTestId('surface')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Anmeldung erforderlich' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// M03 invite (N4b): the invite redemption on the not-a-member page (spec M03 §2 S4.3/S7.6, §4 V6).
// Copy is asserted through the catalogue (`deCatalog`), never as a literal typed here, so this
// suite tests the mapping from an engine refusal to its sentence and stays silent about wording.
// ---------------------------------------------------------------------------------------------

const REDEEM = deCatalog.identity.redeem;

const acceptOk = (workspaceId = 'ws_granted'): RestResponse => ({
  status: 200,
  body: { ok: true, workspaceId, role: 'bookkeeper', memberId: 'm_9' },
});

const acceptErr = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

/** A sibling probe so a test can observe which workspace the redemption selected. */
function WorkspaceProbe() {
  return <output data-testid="ws-probe">{useWorkspaceId() ?? 'none'}</output>;
}

describe('M03 NotAMemberPage: the invite redemption control', () => {
  it('renders the redemption field and keeps the action disabled while the field is empty', () => {
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }));
    expect(screen.getByLabelText(REDEEM.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REDEEM.action })).toBeDisabled();
  });

  it('redeems a pasted token through accept_invite, selects the granted workspace and refreshes whoami', async () => {
    const calls: Record<string, unknown>[] = [];
    const refresh = vi.fn();
    withCaps(
      <>
        <NotAMemberPage subject="bob@treuhand.ch" />
        <WorkspaceProbe />
      </>,
      whoami({ isMember: false, subject: 'bob@treuhand.ch' }),
      {
        accept_invite: (input) => {
          calls.push(input);
          return acceptOk('ws_granted');
        },
      },
      refresh,
    );
    await userEvent.type(screen.getByLabelText(REDEEM.label), 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    await waitFor(() => expect(calls).toEqual([{ token: 'invite_7' }]));
    expect(screen.getByTestId('ws-probe')).toHaveTextContent('ws_granted');
    expect(refresh).toHaveBeenCalled();
  });

  it('extracts the token client-side when a FULL invite link is pasted', async () => {
    const calls: Record<string, unknown>[] = [];
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }), {
      accept_invite: (input) => {
        calls.push(input);
        return acceptOk();
      },
    });
    await userEvent.click(screen.getByLabelText(REDEEM.label));
    await userEvent.paste('https://till.example.ch/?invite=invite_42');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    await waitFor(() => expect(calls).toEqual([{ token: 'invite_42' }]));
  });

  it('renders invite_expired INLINE with the ask-the-owner sentence, field value retained', async () => {
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }), {
      accept_invite: acceptErr('invite_expired'),
    });
    const field = screen.getByLabelText(REDEEM.label);
    await userEvent.type(field, 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    expect(await screen.findByRole('alert')).toHaveTextContent(REDEEM.error.invite_expired);
    expect(field).toHaveValue('invite_7');
  });

  it('renders invite_subject_mismatch naming THIS page subject verbatim, field value retained', async () => {
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false, subject: 'bob@treuhand.ch' }), {
      accept_invite: acceptErr('invite_subject_mismatch'),
    });
    const field = screen.getByLabelText(REDEEM.label);
    await userEvent.type(field, 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      REDEEM.error.invite_subject_mismatch.replace('{subject}', 'bob@treuhand.ch'),
    );
    expect(field).toHaveValue('invite_7');
  });

  it('renders an unknown token as the invalid-code sentence, field value retained', async () => {
    withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }), {
      accept_invite: acceptErr('invite_not_found'),
    });
    const field = screen.getByLabelText(REDEEM.label);
    await userEvent.type(field, 'garbled');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    expect(await screen.findByRole('alert')).toHaveTextContent(REDEEM.error.invalid);
    expect(field).toHaveValue('garbled');
  });

  it('PREFILLS from the bootstrap stash, STRIPS the token from the URL, and NEVER auto-redeems', async () => {
    // The capture is what main.tsx runs before the router renders: it stashes the token and strips
    // the parameter in the same breath (token hygiene: a bearer-shaped token must not linger in
    // browser history). The page then prefills from the stash, never from the location.
    const calls: Record<string, unknown>[] = [];
    window.history.replaceState({}, '', '/?invite=invite_deep&x=1');
    try {
      captureInviteDeepLink();
      expect(window.location.search).toBe('?x=1');
      withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }), {
        accept_invite: (input) => {
          calls.push(input);
          return acceptOk();
        },
      });
      const field = screen.getByLabelText(REDEEM.label);
      expect(field).toHaveValue('invite_deep');
      await waitFor(() => expect(screen.getByRole('button', { name: REDEEM.action })).toHaveFocus());
      // The deliberate press is the ONLY thing that redeems (a forwarded link is not a capability URL).
      expect(calls).toEqual([]);
      await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
      await waitFor(() => expect(calls).toEqual([{ token: 'invite_deep' }]));
    } finally {
      window.history.replaceState({}, '', '/');
      captureInviteDeepLink(); // Clears the stash: the next test starts clean.
    }
  });

  it('keeps the workspace selection untouched when a malformed ok body carries no workspaceId', async () => {
    // F3: the success path GUARDS the payload instead of trusting a cast. The refresh still runs
    // (the gate flips for the already-selected workspace); the store never receives a non-string.
    const refresh = vi.fn();
    withCaps(
      <>
        <NotAMemberPage subject="bob@treuhand.ch" />
        <WorkspaceProbe />
      </>,
      whoami({ isMember: false }),
      { accept_invite: { status: 200, body: { ok: true } } },
      refresh,
    );
    await userEvent.type(screen.getByLabelText(REDEEM.label), 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByTestId('ws-probe')).toHaveTextContent('ws_current');
  });

  it('has no axe violations with the redemption form and an inline refusal shown', async () => {
    const { container } = withCaps(<NotAMemberPage subject="bob@treuhand.ch" />, whoami({ isMember: false }), {
      accept_invite: acceptErr('invite_expired'),
    });
    await userEvent.type(screen.getByLabelText(REDEEM.label), 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    await screen.findByRole('alert');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M03 S4.3: a successful redemption flips into the workspace shell without a restart', () => {
  it('renders the surface after Einlösen once whoami reports membership', async () => {
    // The REAL CapabilitiesProvider over a stateful transport: whoami answers "served stranger"
    // until accept_invite succeeds, then "member". The IdentityGate must swap the not-a-member page
    // for the surface purely off the refreshed read: no reload, no restart.
    let accepted = false;
    const transport: Transport = async (action, input) => {
      if (action === 'whoami') {
        return {
          status: 200,
          body: {
            ok: true,
            ...whoami({ isMember: !accepted ? false : true, subject: 'bob@treuhand.ch' }),
          },
        };
      }
      if (action === 'accept_invite') {
        accepted = true;
        expect(input).toMatchObject({ token: 'invite_7' });
        return acceptOk('ws_current');
      }
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_current">
            <CapabilitiesProvider>
              <IdentityGate>
                <div data-testid="surface">the ledger</div>
              </IdentityGate>
            </CapabilitiesProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' });
    await userEvent.type(screen.getByLabelText(REDEEM.label), 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    expect(await screen.findByTestId('surface')).toBeInTheDocument();
  });

  it('flips against the PINNED-session behaviour: whoami on the old session keeps answering stranger', async () => {
    // The real served MCP face pins the resolved identity at session OPEN (src/api/mcp-http.ts,
    // M01's contract): after accept_invite the OLD session's whoami still answers stranger, and
    // only a NEW session resolves the membership. This fake reproduces that pin: each session
    // snapshots the membership at its open, and `resetSession` (the client fix) is the ONLY way
    // whoami starts answering member. The stateless fake above would have stayed green with no
    // reset at all, which is exactly how the defect shipped.
    let accepted = false;
    let sessionMembershipAtOpen = false; // session 0 opened before the acceptance
    const transport: Transport = async (action, input) => {
      if (action === 'whoami') {
        return {
          status: 200,
          body: {
            ok: true,
            ...whoami({ isMember: sessionMembershipAtOpen, subject: 'bob@treuhand.ch' }),
          },
        };
      }
      if (action === 'accept_invite') {
        accepted = true; // commits engine-side; the pinned session does NOT see it
        expect(input).toMatchObject({ token: 'invite_7' });
        return acceptOk('ws_current');
      }
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    transport.resetSession = () => {
      sessionMembershipAtOpen = accepted; // the fresh session resolves the CURRENT membership
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_current">
            <CapabilitiesProvider>
              <IdentityGate>
                <div data-testid="surface">the ledger</div>
              </IdentityGate>
            </CapabilitiesProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' });
    await userEvent.type(screen.getByLabelText(REDEEM.label), 'invite_7');
    await userEvent.click(screen.getByRole('button', { name: REDEEM.action }));
    expect(await screen.findByTestId('surface')).toBeInTheDocument();
  });
});

describe('M03 F1: the deep link survives the REAL index redirect via the bootstrap stash', () => {
  it('deep link -> index redirect -> gate -> NotAMemberPage prefilled and focused, never auto-redeemed', async () => {
    // The full journey a forwarded link takes: the app boots at `/?invite=<token>`, main.tsx's
    // capture stashes the token and strips the URL, THEN the router renders and its index route
    // redirects `/` to the first rail surface with a string `to` and `replace`, which drops any
    // query string. The page must prefill from the stash, because the URL is provably empty by the
    // time it mounts. The route tree below reproduces the real router's index redirect line
    // verbatim (router.tsx); the real Shell carries the real IdentityGate and CapabilitiesProvider.
    // (Plain MemoryRouter, not the createBrowserRouter singleton: the data router builds a fetch
    // Request per navigation and explodes on jsdom's AbortSignal, per Shell.test.tsx.)
    const calls: Record<string, unknown>[] = [];
    window.history.replaceState({}, '', '/?invite=invite_deep');
    try {
      captureInviteDeepLink(); // What main.tsx runs before the router renders.
      expect(window.location.search).toBe(''); // F2: the token never lingers in the URL.
      const transport: Transport = async (action, input) => {
        if (action === 'whoami') {
          return {
            status: 200,
            body: { ok: true, ...whoami({ isMember: false, subject: 'bob@treuhand.ch' }) },
          };
        }
        if (action === 'accept_invite') {
          calls.push(input);
          return acceptOk('ws_current');
        }
        return { status: 404, body: { ok: false, error: 'unknown_action' } };
      };
      render(
        <ThemeProvider initialTheme="light">
          <DensityProvider initialDensity="komfortabel">
            <TillClientProvider client={new TillClient(transport)}>
              <I18nProvider>
                <WorkspaceProvider initialId="ws_current">
                  <MemoryRouter initialEntries={['/?invite=invite_deep']}>
                    <Routes>
                      <Route path="/" element={<Shell />}>
                        <Route index element={<Navigate to={NAV_ITEMS[0].path} replace />} />
                        {NAV_ITEMS.map((item) => (
                          <Route
                            key={item.path}
                            path={item.path.replace(/^\//, '')}
                            element={<Placeholder titleKey={item.labelKey} />}
                          />
                        ))}
                      </Route>
                    </Routes>
                  </MemoryRouter>
                </WorkspaceProvider>
              </I18nProvider>
            </TillClientProvider>
          </DensityProvider>
        </ThemeProvider>,
      );
      // The redirect has fired and the gate has answered: the not-a-member page is on screen...
      await screen.findByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' });
      // ...with the token still in hand, because the stash survived what the URL did not.
      expect(screen.getByLabelText(REDEEM.label)).toHaveValue('invite_deep');
      await waitFor(() => expect(screen.getByRole('button', { name: REDEEM.action })).toHaveFocus());
      // Prefill and focus is ALL the deep link does: nothing auto-redeemed.
      expect(calls).toEqual([]);
    } finally {
      window.history.replaceState({}, '', '/');
      captureInviteDeepLink(); // Clears the stash: the next test starts clean.
    }
  });
});

describe('M03 extractInviteToken: the client-side token extraction', () => {
  it('passes a bare token through trimmed', () => {
    expect(extractInviteToken('  invite_7  ')).toBe('invite_7');
  });
  it('pulls the invite parameter out of a full link', () => {
    expect(extractInviteToken('https://till.example.ch/some/path?invite=invite_9&x=1')).toBe('invite_9');
  });
  it('falls back to the raw value for a URL without an invite parameter', () => {
    expect(extractInviteToken('https://till.example.ch/')).toBe('https://till.example.ch/');
  });
  it('reads empty input as no token', () => {
    expect(extractInviteToken('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// F-11 (friction ledger, Phase 2c): the served-login states are FULL pages, and the 401-shape has
// one action out.
// ---------------------------------------------------------------------------------------------

/** The real Shell over a canned `whoami`, on the real router shape (Shell.test.tsx's MemoryRouter). */
function renderShellWith(answer: Whoami, extra: Canned = {}) {
  const transport = fakeTransport({
    whoami: { status: 200, body: { ok: true, ...answer } },
    list_workspaces: { status: 200, body: { ok: true, workspaces: [{ workspaceId: 'ws_current', name: 'Seeblick' }] } },
    ...extra,
  });
  return render(
    <ThemeProvider initialTheme="light">
      <DensityProvider initialDensity="komfortabel">
        <TillClientProvider client={new TillClient(transport)}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_current">
              <MemoryRouter initialEntries={['/overview']}>
                <Routes>
                  <Route path="/" element={<Shell />}>
                    {NAV_ITEMS.map((item) => (
                      <Route key={item.path} path={item.path.replace(/^\//, '')} element={<Placeholder titleKey={item.labelKey} />} />
                    ))}
                  </Route>
                </Routes>
              </MemoryRouter>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
}

describe('F-11 / J6.4: a served stranger meets a FULL page, never the workspace chrome', () => {
  it('renders the not-a-member page with NO rail tree, NO workspace switcher and NO palette trigger; the redeem control stays', async () => {
    const { container } = renderShellWith(whoami({ isMember: false, subject: 'stranger@example.ch' }));
    await screen.findByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' });
    expect(screen.getByText(/stranger@example\.ch/)).toBeInTheDocument();
    expect(container.querySelector('[role="tree"]')).toBeNull();
    expect(container.querySelector('#studio-rail')).toBeNull();
    expect(container.querySelector('.ws-switcher-trigger')).toBeNull();
    expect(screen.queryByRole('button', { name: /Suchen/ })).toBeNull();
    expect(screen.getByLabelText(REDEEM.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REDEEM.action })).toBeInTheDocument();
    // The page still has its own theme control and the app's name: a page, not a bare panel.
    expect(screen.getByText('TILL Studio')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the workspace frame for a resolved served member (the rail, the switcher, the chip)', async () => {
    const { container } = renderShellWith(whoami({ isMember: true, subject: 'mara@seeblick.example', role: 'owner' }));
    await screen.findByRole('button', { name: 'Angemeldet als mara@seeblick.example' });
    expect(container.querySelector('#studio-rail')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Du bist angemeldet, aber hier kein Mitglied' })).toBeNull();
  });

  it('renders the workspace frame in local mode, with no identity page and no chip', async () => {
    const { container } = renderShellWith(whoami({ identitySource: 'local_client', subject: null }));
    await waitFor(() => expect(container.querySelector('#studio-rail')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Anmeldung erforderlich' })).toBeNull();
  });
});

describe('F-11 / J8.4: the 401-shape page has ONE action out, "Erneut versuchen"', () => {
  it('renders the retry control as a full page with no rail, and the control reloads', async () => {
    const reload = vi.fn();
    const { container } = renderShellWith(whoami({ isMember: false, subject: null }));
    await screen.findByRole('heading', { name: 'Anmeldung erforderlich' });
    expect(container.querySelector('#studio-rail')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Erneut versuchen' });
    expect(screen.getByText(/Melde dich beim Proxy/)).toBeInTheDocument();
    // jsdom's reload is not implemented: swap it for a spy on the page's own retry path.
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      await userEvent.click(retry);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('the standalone page takes an onRetry override and has no axe violations', async () => {
    const onRetry = vi.fn();
    const { container } = withCaps(<SignInRequiredPage onRetry={onRetry} />, null);
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M01 IdentityChip: the role in words, the raw id in the details', () => {
  it('names a built-in role in words on the chip and keeps the raw id beside it in the details', async () => {
    withCaps(<IdentityChip />, whoami({ role: 'treuhaender' }));
    const chip = screen.getByRole('button', { name: 'Angemeldet als dominic@example.ch' });
    expect(chip).toHaveTextContent('Treuhänder');
    expect(chip).not.toHaveTextContent('treuhaender');
    await userEvent.click(chip);
    const details = screen.getByRole('dialog', { name: 'Sitzungsdetails' });
    expect(details).toHaveTextContent('Treuhänder');
    expect(details).toHaveTextContent('treuhaender');
  });

  it('shows a custom role by its own id, because it has no global word', () => {
    withCaps(<IdentityChip />, whoami({ role: 'role_spesen' }));
    expect(screen.getByRole('button', { name: 'Angemeldet als dominic@example.ch' })).toHaveTextContent('role_spesen');
  });
});
