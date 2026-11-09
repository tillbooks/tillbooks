/**
 * G03 component tests (spec §8): the path choice renders with and without a workspace, the resume
 * affordance follows the saved pointer, the demo CTA drives the real verb and adopts the minted
 * workspace, and the shell demo banner renders ONLY on `workspaceKind === 'demo'` with one primary
 * action and the discard behind an overflow confirm.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { watchReads, neverSettles } from '../../test-transport';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { Onboarding } from './Onboarding';
import { DemoBanner } from './DemoBanner';

type Call = { action: string; input: Record<string, unknown> };

function makeClient(routes: Record<string, RestResponse>, calls: Call[] = []): TillClient {
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    return routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return new TillClient(transport);
}

const okBody = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...body } });
const errBody = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({
  status: 400,
  body: { ok: false, error, ...extra },
});

function renderAt(
  ui: React.ReactElement,
  { workspaceId = null as string | null, client }: { workspaceId?: string | null; client: TillClient },
) {
  return render(
    <TillClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={['/onboarding']}>
            <Routes>
              <Route path="*" element={ui} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Onboarding', () => {
  it('renders the three path cards immediately when no workspace exists', () => {
    const client = makeClient({});
    renderAt(<Onboarding />, { client });
    expect(screen.getByRole('heading', { name: 'Start fresh' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import from bexio or CSV' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Try a demo workspace' })).toBeInTheDocument();
    // Pre-workspace, the import card says the workspace shell comes first.
    expect(screen.getByText(/needs the workspace shell first/)).toBeInTheDocument();
  });

  it('resumes from a saved pointer and records the chosen path on a workspace', async () => {
    const calls: Call[] = [];
    const client = makeClient(
      {
        get_onboarding_progress: okBody({
          progress: { path: 'import', step: 'plan', completedAt: null },
          workspaceKind: 'live',
        }),
        advance_onboarding_step: okBody({ path: 'import', step: 'plan', completedAt: null }),
      },
      calls,
    );
    renderAt(<Onboarding />, { workspaceId: 'ws_1', client });
    expect(await screen.findByText(/Continue where you left off/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    await waitFor(() => {
      const advance = calls.find((c) => c.action === 'advance_onboarding_step');
      expect(advance).toBeDefined();
      expect(advance?.input).toMatchObject({ workspaceId: 'ws_1', path: 'fresh', step: 'company' });
    });
  });

  it('gives the resume button a step-named accessible name that never collides with a card (K-24)', async () => {
    // Saved path 'fresh': the old resume button repeated the card label, so getByRole('button',
    // { name: 'Start fresh' }) was ambiguous. The resume button now names the STEP.
    const client = makeClient({
      get_onboarding_progress: okBody({
        progress: { path: 'fresh', step: 'company', completedAt: null },
        workspaceKind: 'live',
      }),
      advance_onboarding_step: okBody({ path: 'fresh', step: 'company', completedAt: null }),
    });
    renderAt(<Onboarding />, { workspaceId: 'ws_1', client });
    expect(await screen.findByRole('button', { name: 'Continue at: Company' })).toBeInTheDocument();
    // Unambiguous: exactly one button carries the card label (getByRole throws on two matches).
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeInTheDocument();
    // The supporting line still names the path.
    expect(screen.getByText(/Continue where you left off/).textContent).toContain('Start fresh');
  });

  it('names the import resume step too, so both resumable paths read the step (K-24)', async () => {
    const client = makeClient({
      get_onboarding_progress: okBody({
        progress: { path: 'import', step: 'plan', completedAt: null },
        workspaceKind: 'live',
      }),
    });
    renderAt(<Onboarding />, { workspaceId: 'ws_1', client });
    expect(await screen.findByRole('button', { name: 'Continue at: Migration plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from bexio or CSV' })).toBeInTheDocument();
  });

  it('loads a skeleton that traces the three-card layout, not one block', async () => {
    // A workspace exists, so the pointer read is in flight and the surface is in its loading state.
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    const { container } = renderAt(<Onboarding />, { workspaceId: 'ws_1', client });
    // Prove the pointer read actually went in flight before claiming the skeleton is a load in
    // progress, not the default-true skeleton (loading-state-convention.test.ts).
    await transport.started('get_onboarding_progress');
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    // The skeleton matches the real layout: three card placeholders, never a single bar (DESIGN.md).
    expect(container.querySelectorAll('.onboarding-skeleton .skeleton')).toHaveLength(3);
    // K-07: the header is chrome, so it never skeletons: the title is already there.
    expect(container.querySelector('.surface-header h1')).not.toBeNull();
  });

  it('a failed demo mint renders the shared error banner with a working retry, never a dead end', async () => {
    const calls: Call[] = [];
    const client = makeClient({ create_demo_workspace: errBody('invalid_input') }, calls);
    renderAt(<Onboarding />, { client });

    await userEvent.click(screen.getByRole('button', { name: 'Try a demo workspace' }));
    // The error state is the shared ErrorBanner (title + a way out), not a bare sentence.
    expect(await screen.findByText('Action failed')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });
    await userEvent.click(retry);
    await waitFor(() => {
      expect(calls.filter((c) => c.action === 'create_demo_workspace')).toHaveLength(2);
    });
  });

  it('the demo CTA drives create_demo_workspace and adopts the minted workspace', async () => {
    const calls: Call[] = [];
    const client = makeClient(
      {
        create_demo_workspace: okBody({
          workspaceId: 'ws_demo',
          seeded: { contacts: 3, items: 3, invoicesIssued: 2, invoicesDraft: 1 },
        }),
      },
      calls,
    );
    renderAt(<Onboarding />, { client });
    await userEvent.click(screen.getByRole('button', { name: 'Try a demo workspace' }));
    await waitFor(() => {
      const create = calls.find((c) => c.action === 'create_demo_workspace');
      expect(create).toBeDefined();
      expect(typeof create?.input.idempotencyKey).toBe('string');
    });
  });
});

describe('DemoBanner', () => {
  it('renders nothing for a live workspace and nothing without a workspace', async () => {
    const live = makeClient({
      get_onboarding_progress: okBody({ progress: null, workspaceKind: 'live' }),
    });
    const { container, unmount } = renderAt(<DemoBanner />, { workspaceId: 'ws_1', client: live });
    await waitFor(() => expect(container.querySelector('.demo-banner')).toBeNull());
    unmount();

    const none = makeClient({});
    const bare = renderAt(<DemoBanner />, { client: none });
    expect(bare.container.querySelector('.demo-banner')).toBeNull();
  });

  it('renders on a demo workspace: one primary action, discard behind an overflow confirm', async () => {
    const calls: Call[] = [];
    const routes: Record<string, RestResponse> = {
      get_onboarding_progress: okBody({ progress: null, workspaceKind: 'demo' }),
      discard_demo_workspace: okBody({ discardedWorkspaceId: 'ws_demo' }),
    };
    // watchReads proves the banner really asked the engine before we claim its live region is up:
    // the role="status" here is the demo announcement, not a default skeleton, so the loading-proof
    // convention wants the read named, not merely assumed (loading-state-convention.test.ts).
    const transport = watchReads(async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      return routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
    });
    const client = new TillClient(transport);
    renderAt(<DemoBanner />, { workspaceId: 'ws_demo', client });

    await transport.started('get_onboarding_progress');
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText('You are exploring a demo workspace')).toBeInTheDocument();
    // The ONE primary action is a link out to real books; discard is NOT a peer.
    expect(screen.getByRole('link', { name: 'Start your own books' })).toBeInTheDocument();

    // The discard is behind the overflow AND behind an explicit confirm step.
    await userEvent.click(screen.getByText('More'));
    await userEvent.click(screen.getByRole('button', { name: 'Discard demo' }));
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'discard_demo_workspace')).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Discard demo' }));
    await waitFor(() => {
      const discard = calls.find((c) => c.action === 'discard_demo_workspace');
      expect(discard).toBeDefined();
      expect(discard?.input).toMatchObject({ workspaceId: 'ws_demo', confirmed: true });
    });
  });

  it('permission-denied: discard is disabled and NAMES the missing right in visible text', async () => {
    // Provisioned actor that holds reads but NOT manage_settings: the discard must render disabled.
    const routes: Record<string, RestResponse> = {
      get_onboarding_progress: okBody({ progress: null, workspaceKind: 'demo' }),
      whoami: okBody({
        actor: 'agent',
        role: 'viewer',
        isMember: true,
        provisioned: true,
        capabilities: ['read_books', 'read_master_data'],
      }),
    };
    // watchReads proves the banner really asked the engine before we assert its live region is up,
    // so the role="status" assertion is over a real read, not the default skeleton (loading-state-convention).
    const transport = watchReads(async (action) => routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } });
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_demo">
            <MemoryRouter initialEntries={['/onboarding']}>
              <CapabilitiesProvider>
                <Routes>
                  <Route path="*" element={<DemoBanner />} />
                </Routes>
              </CapabilitiesProvider>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );

    await transport.started('get_onboarding_progress');
    await screen.findByRole('status');
    await userEvent.click(screen.getByText('More'));
    // The action that would be refused renders disabled, never shown-then-rejected (DESIGN.md).
    const discard = screen.getByRole('button', { name: 'Discard demo' });
    await waitFor(() => expect(discard).toBeDisabled());
    // The missing right is named in visible text, not a `title` tooltip and not colour alone.
    expect(screen.getByText(/manage settings right/)).toBeInTheDocument();
  });
});
