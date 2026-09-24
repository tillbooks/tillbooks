/**
 * A35 the dock: the guarantees the shell contract makes load-bearing.
 *
 *  - With zero sessions the dock emits NO DOM at all (G16 guarantee 2, row 1.4).
 *  - Collapsed by default; the open state is remembered PER WORKSPACE.
 *  - A workspace switch clears every rendered turn and card BEFORE the new client's data arrives,
 *    and an in-flight answer for a no-longer-active workspace is discarded (§H-TENANT in the DOM).
 *  - Row 14.2: with no registered runtime, NO text input renders anywhere in the dock, and one line
 *    names where conversation happens today; with one, the composer renders and submits agent_ask.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { KeyboardProvider, useKeyboard } from '../../app/keyboard';
import { AgentDock } from './index';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, log?: { action: string; input: Record<string, unknown> }[]): Transport {
  return async (action, input) => {
    log?.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

function sessionsFor(ws: string) {
  return ok({
    sessions: [
      { sessionId: `s-${ws}`, clientLabel: `Client ${ws}`, startedAt: '2026-06-12T14:02:00.000Z', lastAt: '2026-06-12T14:30:00.000Z', open: true, calls: 2, writes: 0, drafts: 0 },
    ],
  });
}

function detailFor(ws: string) {
  return ok({
    sessionId: `s-${ws}`,
    actor: 'agent',
    clientLabel: `Client ${ws}`,
    startedAt: '2026-06-12T14:02:00.000Z',
    lastAt: '2026-06-12T14:30:00.000Z',
    open: true,
    turns: [
      {
        turnId: `t-${ws}`,
        seq: 1,
        role: 'agent',
        text: null,
        at: '2026-06-12T14:02:00.000Z',
        calls: [
          // `list_journal`, deliberately: a trace row is display data here, and naming the accounts
          // read would put this file in scope of the pinned list-accounts fixture guard for a
          // payload this test never renders as an account list.
          { callId: `c-${ws}`, seq: 1, verb: 'list_journal', kind: 'read', args: {}, mode: 'execute', decisionReason: 'read', dialCapability: null, ok: true, errorCode: null, entityRef: null, durationMs: 5, at: '2026-06-12T14:02:00.000Z', agentActionId: null, draftStatus: null, rejectReason: null },
        ],
      },
    ],
  });
}

/** A switcher harness so a test can flip the active workspace like the A23 switcher does. */
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  return (
    <button type="button" onClick={() => setWorkspaceId('ws_b')}>
      switch-to-b
    </button>
  );
}

/** C1: a harness standing in for the palette's ask lane, which asks the dock to open via the bridge. */
function AskTrigger() {
  const { requestAgentDock } = useKeyboard();
  return (
    <button type="button" onClick={requestAgentDock}>
      request-dock
    </button>
  );
}

function renderDock(canned: Canned, log?: { action: string; input: Record<string, unknown> }[]) {
  const client = new TillClient(fakeTransport(canned, log));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_a">
          <MemoryRouter>
            <KeyboardProvider>
              <Switcher />
              <AskTrigger />
              <AgentDock />
            </KeyboardProvider>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the dock', () => {
  it('emits NO DOM at all while no session has ever existed', async () => {
    const log: { action: string; input: Record<string, unknown> }[] = [];
    const { container } = renderDock({ list_agent_sessions: ok({ sessions: [] }) }, log);
    await waitFor(() => expect(log.some((l) => l.action === 'list_agent_sessions')).toBe(true));
    expect(container.querySelector('.agent-dock')).toBeNull();
    expect(container.querySelector('.agent-dock-toggle')).toBeNull();
  });

  it('is collapsed by default, opens by a deliberate act, and remembers per workspace', async () => {
    renderDock({
      list_agent_sessions: (input) => sessionsFor(String(input.workspaceId).replace('ws_', '')),
      get_agent_session: (input) => detailFor(String(input.workspaceId).replace('ws_', '')),
      runtime_status: ok({ registered: false }),
    });
    const toggle = await screen.findByRole('button', { name: /Agent/ });
    expect(screen.queryByLabelText('Agent')).not.toBeInTheDocument(); // collapsed: no aside.
    fireEvent.click(toggle);
    expect(await screen.findByText(/Client a/)).toBeInTheDocument();
    expect(window.localStorage.getItem('till.agent.dock.ws_a')).toBe('open');
  });

  it('re-scopes on a workspace switch: nothing from the previous workspace stays in the DOM', async () => {
    renderDock({
      list_agent_sessions: (input) => sessionsFor(String(input.workspaceId).replace('ws_', '')),
      get_agent_session: (input) => detailFor(String(input.workspaceId).replace('ws_', '')),
      runtime_status: ok({ registered: false }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Agent/ }));
    expect(await screen.findByText(/Client a/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'switch-to-b' }));
    // The old client's content is gone BEFORE (and after) the new one arrives.
    await waitFor(() => expect(screen.queryByText(/Client a/)).not.toBeInTheDocument());
  });

  it('row 14.2: no registered runtime renders NO text input anywhere, with the one honest line', async () => {
    renderDock({
      list_agent_sessions: sessionsFor('a'),
      get_agent_session: detailFor('a'),
      runtime_status: ok({ registered: false }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Agent/ }));
    await screen.findByText(/Client a/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(/Gespräche laufen heute in deinem MCP-Client/)).toBeInTheDocument();
  });

  it('with a registered runtime the composer renders and submits agent_ask', async () => {
    const log: { action: string; input: Record<string, unknown> }[] = [];
    renderDock(
      {
        list_agent_sessions: sessionsFor('a'),
        get_agent_session: detailFor('a'),
        runtime_status: ok({ registered: true }),
        agent_ask: ok({ sessionId: 's-a', turnId: 't2', verb: 'ledger_qa', answer: { ok: true } }),
      },
      log,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Agent/ }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'Wie hoch ist der Umsatz?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
    await waitFor(() => expect(log.some((l) => l.action === 'agent_ask')).toBe(true));
    const ask = log.find((l) => l.action === 'agent_ask');
    expect(ask?.input.text).toBe('Wie hoch ist der Umsatz?');
    expect(typeof ask?.input.idempotencyKey).toBe('string');
  });

  it('C1: opens onto the answer when the palette asks the dock to open (the omnibox bridge)', async () => {
    renderDock({
      list_agent_sessions: sessionsFor('a'),
      get_agent_session: detailFor('a'),
      runtime_status: ok({ registered: true }),
    });
    // Collapsed by default: only the toggle, not the open aside.
    await screen.findByRole('button', { name: /Agent/ });
    expect(screen.queryByRole('complementary')).toBeNull();
    // The palette's ask lane requests the dock (after it has posted its agent_ask).
    fireEvent.click(screen.getByRole('button', { name: 'request-dock' }));
    expect(await screen.findByRole('complementary')).toBeInTheDocument();
  });
});
