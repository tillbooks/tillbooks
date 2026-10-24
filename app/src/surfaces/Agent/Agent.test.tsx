/**
 * A35 the /agent surface: the states the design makes load-bearing, rendered from canned reads so
 * every assertion is about what the surface shows.
 *
 *  - Gespräche: dash-versus-zero per the §3e rule; a running session is glyph plus TEXT.
 *  - Vorschläge: the empty state shares the list's predicate; the Vorschlag line is the ONE component,
 *    a list spends no accent (every Genehmigen is a secondary), Details are label and value pairs and
 *    never JSON, the Freigabe level is READ from the dial, a bank-line Vorschlag links to its line.
 *  - Berechtigungen: one row per governed capability; zero history is a sentence, never zeroes; the strong-default pair
 *    renders "fragt immer" with the reason; stored-vs-effective render BOTH when they disagree; the
 *    grant is a ceremony (confirm in place); without manage_agent_dial the control column is absent.
 *  - The partial-turn outcome line never implies a rollback.
 *  - axe is clean on the surface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { Agent } from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { Turn } from './TurnList';
import type { AgentTurn } from './model';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const NO_DIAL_RIGHT: Capabilities = { whoami: null, can: (c) => c !== 'manage_agent_dial', refresh: () => undefined };

function trustRows(over: Record<string, Partial<Record<string, unknown>>> = {}) {
  const caps = ['post', 'issue', 'send', 'dun', 'pay', 'vat-file', 'customize', 'plugin-install', 'close-period', 'go-live', 'erase', 'share', 'stock'];
  return caps.map((capability) => ({
    capability,
    stored: 'ask',
    effective: 'ask',
    strongDefault: capability === 'vat-file' || capability === 'plugin-install',
    updatedBy: null,
    updatedAt: null,
    proposed: 0,
    approved: 0,
    rejected: 0,
    autoExecuted: 0,
    lastAt: null,
    suggestGrant: false,
    ...(over[capability] ?? {}),
  }));
}

function renderAgent(canned: Canned, capabilities: Capabilities = ALLOW_ALL, entry = '/agent') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={[entry]}>
              <Agent />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

const SESSIONS = ok({
  sessions: [
    { sessionId: 's1', clientLabel: 'Claude Desktop', startedAt: '2026-06-12T14:02:00.000Z', lastAt: '2026-06-12T14:30:00.000Z', open: true, calls: 3, writes: 0, drafts: 1 },
    { sessionId: 's2', clientLabel: 'Claude Code', startedAt: '2026-06-11T09:00:00.000Z', lastAt: '2026-06-11T09:05:00.000Z', open: false, calls: 2, writes: 0, drafts: 0 },
  ],
});

describe('Gespräche', () => {
  it('renders the dash-versus-zero rule and marks a running session with glyph plus text', async () => {
    renderAgent({ list_agent_sessions: SESSIONS });
    // Scope to the visible Gespräche panel: the Verbindung panel (always mounted) also lists the
    // recent client labels, so an unscoped text query would now match the label twice.
    const panel = within(screen.getByRole('tabpanel'));
    expect(await panel.findByText('Claude Desktop')).toBeInTheDocument();
    // s2 asked two questions and attempted nothing: dashes in Buchungen AND Vorschläge.
    const rows = screen.getAllByRole('row');
    const s2 = rows.find((r) => r.textContent?.includes('Claude Code'));
    expect(s2?.textContent).toContain('-');
    // The running marker is text, never colour alone.
    expect(screen.getByText(/läuft/)).toBeInTheDocument();
  });

  it('F-08 (J5.4): /agent?session=<id> opens that conversation directly, read by id, not by scrolling the month', async () => {
    const opened: Record<string, unknown>[] = [];
    renderAgent(
      {
        list_agent_sessions: SESSIONS,
        get_agent_session: (input) => {
          opened.push(input);
          return ok({ sessionId: 's_42', actor: 'agent', clientLabel: 'Claude Desktop', startedAt: '2026-05-02T09:00:00.000Z', lastAt: '2026-05-02T09:12:00.000Z', open: false, turns: [] });
        },
      },
      ALLOW_ALL,
      '/agent?session=s_42',
    );
    // The detail is on screen without a row click, for a session outside the listed month.
    const detail = await screen.findByText(/Claude Desktop · 02\.05\.2026/);
    expect(detail.closest('.agent-session-detail')).not.toBeNull();
    expect(opened[0]).toMatchObject({ workspaceId: 'ws_test', sessionId: 's_42' });
  });

  it('empty state names the next action, never a bare "Keine Daten"', async () => {
    renderAgent({ list_agent_sessions: ok({ sessions: [] }) });
    expect(await screen.findByText('Noch keine Sitzung')).toBeInTheDocument();
    expect(screen.getByText(/Verbinde einen MCP-Client/)).toBeInTheDocument();
    expect(screen.queryByText(/Keine Daten/)).not.toBeInTheDocument();
  });

  it('axe: the session list is clean', async () => {
    const { container } = renderAgent({ list_agent_sessions: SESSIONS });
    // The Gespräche panel is the visible one; the recent-clients list on the (hidden) Verbindung
    // panel mirrors the same labels, so wait on the label inside the visible panel specifically.
    await within(screen.getByRole('tabpanel')).findByText('Claude Desktop');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Vorschläge (the one line, D167)', () => {
  const twoPending = ok({
    actions: [
      { actionId: 'a1', actor: 'agent', dialCapability: 'post', actionTool: 'post_entry', payload: { date: '2026-06-12' }, status: 'pending', createdAt: '2026-06-10T10:00:00.000Z' },
      { actionId: 'a2', actor: 'agent', dialCapability: 'post', actionTool: 'post_entry', payload: { date: '2026-06-13' }, status: 'pending', createdAt: '2026-06-11T10:00:00.000Z' },
    ],
  });

  it('a list spends no accent: one line per proposal, every Genehmigen a secondary, the verb in words', async () => {
    const { container } = renderAgent({ list_agent_sessions: SESSIONS, list_drafted_actions: twoPending });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    const lines = await screen.findAllByRole('article');
    expect(lines).toHaveLength(2);
    const approve = screen.getAllByRole('button', { name: 'Genehmigen' });
    expect(approve).toHaveLength(2);
    for (const button of approve) {
      expect(button.className).toContain('btn--secondary');
      expect(button.className).not.toMatch(/btn--(primary|accent)/);
    }
    expect(container.querySelector('.vorschlag-line .btn--primary, .vorschlag-line .btn--accent')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Buchung erfassen' })).toHaveLength(2);
    expect(screen.queryByText('post_entry')).toBeNull();
  });

  it('Details are label and value pairs, never JSON and never a raw payload key', async () => {
    const { container } = renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: ok({
        actions: [
          {
            actionId: 'a7',
            actor: 'agent',
            dialCapability: 'vat-file',
            actionTool: 'vat_mark_filed',
            payload: { workspaceId: 'ws_test', period: '2026-Q1', idempotencyKey: 'k7', confirmed: true },
            status: 'pending',
            createdAt: '2026-10-13T08:00:00.000Z',
          },
        ],
      }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    // The face: the verb in words and the period as its one key figure.
    expect(screen.getByRole('button', { name: 'MWST-Abrechnung als eingereicht markieren' })).toBeInTheDocument();
    expect(container.querySelector('[data-figure="key"]')?.textContent).toBe('2026-Q1 (Jan. bis März)');
    fireEvent.click(screen.getByRole('button', { name: /^Mehr zu:/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const details = container.querySelector('.vorschlag-readback') as HTMLElement;
    const text = details.textContent ?? '';
    expect(text).toContain('Periode');
    expect(text).toContain('2026-Q1 (Jan. bis März)');
    expect(text).toContain('am 13.10.2026 von Agent');
    for (const raw of ['{', '"', 'workspaceId', 'idempotencyKey', 'confirmed', 'vat_mark_filed', 'ws_test', 'k7']) {
      expect(text).not.toContain(raw);
    }
    expect(container.querySelector('.vorschlag-line pre, .vorschlag-line code')).toBeNull();
  });

  it('the Freigabe level is read from the dial, never hard-coded', async () => {
    const pending = ok({
      actions: [
        { actionId: 'a1', actor: 'agent', dialCapability: 'post', actionTool: 'post_entry', payload: { date: '2026-06-12' }, status: 'pending', createdAt: '2026-06-10T10:00:00.000Z' },
        { actionId: 'a2', actor: 'agent', dialCapability: 'vat-file', actionTool: 'vat_mark_filed', payload: { period: '2026-Q2' }, status: 'pending', createdAt: '2026-06-11T10:00:00.000Z' },
      ],
    });
    const dialCalls: Record<string, unknown>[] = [];
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: pending,
      get_agent_dial: (input) => {
        dialCalls.push(input);
        return ok({
          levels: { post: 'auto', 'vat-file': 'ask' },
          rows: [
            { capability: 'post', stored: 'auto', effective: 'auto', strongDefault: false },
            { capability: 'vat-file', stored: 'ask', effective: 'ask', strongDefault: true },
          ],
        });
      },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    await waitFor(() => expect(dialCalls.length).toBeGreaterThan(0));
    for (const title of screen.getAllByRole('button', { name: /^(Buchung erfassen|MWST-Abrechnung als eingereicht markieren)$/ })) {
      fireEvent.click(title);
    }
    const levelOf = (actionId: string) => {
      const line = document.querySelector(`[data-action-id="${actionId}"]`) as HTMLElement;
      const row = [...line.querySelectorAll('.vorschlag-readback-row')].find((r) => r.querySelector('dt')?.textContent === 'Freigabe');
      return row?.querySelector('dd')?.textContent ?? null;
    };
    // D167 polish 11: the level in words, then "einstellbar" as a link to the agent's Berechtigungen.
    await waitFor(() => expect(levelOf('a1')).toBe('Künftig automatisch\u00a0·\u00a0einstellbar'));
    expect(levelOf('a2')).toBe('Fragt immer\u00a0·\u00a0einstellbar');
    const link = within(document.querySelector('[data-action-id="a1"]') as HTMLElement).getByRole('link', { name: 'einstellbar' });
    expect(link).toHaveAttribute('href', '/agent?tab=berechtigungen');
  });

  it('an unreadable dial leaves the Freigabe row out rather than guessing a level', async () => {
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: twoPending,
      get_agent_dial: { status: 500, body: { ok: false, error: 'internal' } },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getAllByRole('button', { name: 'Buchung erfassen' })[0]);
    expect(await screen.findByText('Vorgeschlagen')).toBeInTheDocument();
    expect(screen.queryByText('Freigabe')).toBeNull();
    expect(screen.queryByText(/Stufe/)).toBeNull();
  });

  it('a bank-line Vorschlag links to its line on /bank', async () => {
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: ok({
        actions: [
          {
            actionId: 'a5',
            actor: 'agent',
            dialCapability: 'pay',
            actionTool: 'book_bank_line',
            payload: { bankTxnId: 'btx_42', target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: -1654, taxCode: 'VST-81' }] }, idempotencyKey: 'k5' },
            status: 'pending',
            createdAt: '2026-10-13T08:00:00.000Z',
          },
        ],
      }),
      // D167: the chart names the leg's account; Details never print its id. The PINNED recording
      // (`list-accounts.fixture.json`, acc_51 is 6570), never hand-typed accounts.
      list_accounts: ok({ accounts: listAccountsFixture.accounts }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    const link = screen.getByRole('link', { name: 'Zur Bankzeile' });
    expect(link.getAttribute('href')).toBe('/bank?line=btx_42');
    expect(document.querySelector('[data-figure="key"]')?.textContent).toContain('16.54');
    fireEvent.click(screen.getByRole('button', { name: 'Bankzeile buchen' }));
    const text = document.querySelector('.vorschlag-readback')?.textContent ?? '';
    expect(text).toContain('Auf Konten buchen');
    await waitFor(() => expect(document.querySelector('.vorschlag-readback')?.textContent ?? '').toContain('6570 Informatik, Software und Lizenzen'));
    expect(document.querySelector('.vorschlag-readback')?.textContent ?? '').not.toContain('acc_51');
    expect(text).toContain('VST-81');
    expect(text).not.toContain('btx_42');
    expect(text).not.toContain('legs');
  });

  it('no single control on the card face rejects: Ablehnen lives in the overflow and confirms in place', async () => {
    renderAgent({ list_agent_sessions: SESSIONS, list_drafted_actions: twoPending });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    // Nothing on the face rejects.
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).not.toBeInTheDocument();
    // Open the first card's overflow, choose Ablehnen: a confirm appears IN PLACE, naming finality.
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ablehnen' }));
    expect(await screen.findByText(/Der Vorschlag ist danach erledigt/)).toBeInTheDocument();
  });

  it('the empty state is evaluated against the same predicate as the list', async () => {
    renderAgent({ list_agent_sessions: SESSIONS, list_drafted_actions: ok({ actions: [] }) });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    expect(await screen.findByText('Nichts zu genehmigen.')).toBeInTheDocument();
  });

  it('without manage_agent_dial the line names the missing right in place of Genehmigen, and offers no reject', async () => {
    renderAgent({ list_agent_sessions: SESSIONS, list_drafted_actions: twoPending }, NO_DIAL_RIGHT);
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Benötigt: Agent-Freigabe/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    expect(await screen.findByRole('menuitem', { name: 'Details' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Ablehnen' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
  });

  it('"Genehmigen und künftig automatisch" confirms in place with the grant sentence, then sends allowFuture once', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: twoPending,
      approve_drafted_action: (input) => {
        sent.push(input);
        return ok({ actionId: 'a1', status: 'executed' });
      },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Genehmigen und künftig automatisch' }));
    expect(await screen.findByText(/bleibt jederzeit widerrufbar/)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen und erlauben' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ workspaceId: 'ws_test', actionId: 'a1', allowFuture: true });
  });
});

describe('Berechtigungen', () => {
  it('one row per governed capability; zero history is a sentence, never zeroes; the window is stated', async () => {
    renderAgent({
      list_agent_sessions: SESSIONS,
      agent_trust_summary: ok({ window: { from: '2026-05-19T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' }, rows: trustRows() }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    expect(await screen.findByText('Buchen')).toBeInTheDocument();
    expect(screen.getAllByText('Noch nichts vorgeschlagen')).toHaveLength(13);
    // D156: the two new families render with their de-CH labels, never their raw ids.
    expect(screen.getAllByText('Löschen').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Freigeben').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('erase')).toBeNull();
    expect(screen.queryByText('share')).toBeNull();
    // D161: the stock family renders in the Geld group with its de-CH label.
    expect(screen.getAllByText('Lager').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('stock')).toBeNull();
    expect(screen.getByText(/Fenster: 19.05.2026 bis 17.08.2026/)).toBeInTheDocument();
    // The strong-default pair reads "fragt immer" with the reason in place.
    expect(screen.getAllByText('fragt immer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/nach aussen unumkehrbar/).length).toBeGreaterThanOrEqual(1);
  });

  it('stored and effective render BOTH when they disagree (row 8.3)', async () => {
    renderAgent({
      list_agent_sessions: SESSIONS,
      agent_trust_summary: ok({
        window: { from: '2026-05-19T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' },
        rows: trustRows({ 'vat-file': { stored: 'auto', effective: 'ask' } }),
      }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    await screen.findByText('Buchen');
    expect(screen.getByText(/gespeichert: automatisch, wirksam: fragt immer/)).toBeInTheDocument();
  });

  it('the grant is a ceremony: the control confirms in place and calls set_agent_dial once', async () => {
    const dialCalls: Record<string, unknown>[] = [];
    renderAgent({
      list_agent_sessions: SESSIONS,
      agent_trust_summary: ok({ window: { from: '2026-05-19T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' }, rows: trustRows() }),
      set_agent_dial: (input) => {
        dialCalls.push(input);
        return ok({ capability: input.capability, level: input.level });
      },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    await screen.findByText('Buchen');
    fireEvent.click(screen.getAllByRole('button', { name: 'Automatisch erlauben' })[0]);
    expect(await screen.findByText(/ohne Nachfrage ausführen/)).toBeInTheDocument();
    expect(dialCalls).toHaveLength(0); // nothing written before the confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Ja, erlauben' }));
    await waitFor(() => expect(dialCalls).toHaveLength(1));
    expect(dialCalls[0]).toMatchObject({ capability: 'post', level: 'auto' });
  });

  it('D-3: the suggestion appears past the threshold, and a dismissal never nags again', async () => {
    const summary = ok({
      window: { from: '2026-05-19T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' },
      rows: trustRows({ post: { proposed: 24, approved: 24, rejected: 0, suggestGrant: true } }),
    });
    const first = renderAgent({ list_agent_sessions: SESSIONS, agent_trust_summary: summary });
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    expect(await screen.findByText(/24 von 24 Vorschlägen genehmigt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nein, weiter fragen' }));
    expect(screen.queryByText(/24 von 24 Vorschlägen genehmigt/)).not.toBeInTheDocument();
    first.unmount();
    // A fresh render (same workspace) honours the stored dismissal: it never returns.
    renderAgent({ list_agent_sessions: SESSIONS, agent_trust_summary: summary });
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    await screen.findByText('Buchen');
    expect(screen.queryByText(/24 von 24 Vorschlägen genehmigt/)).not.toBeInTheDocument();
  });

  it('without manage_agent_dial the control column is ABSENT, the evidence still renders', async () => {
    renderAgent(
      {
        list_agent_sessions: SESSIONS,
        agent_trust_summary: ok({ window: { from: '2026-05-19T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' }, rows: trustRows() }),
      },
      NO_DIAL_RIGHT,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    await screen.findByText('Buchen');
    expect(screen.queryByRole('button', { name: 'Automatisch erlauben' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wieder fragen' })).not.toBeInTheDocument();
  });
});

describe('the partial turn (design row 3.3)', () => {
  const partial: AgentTurn = {
    turnId: 't1',
    seq: 1,
    role: 'agent',
    text: null,
    at: '2026-06-12T14:02:00.000Z',
    calls: [
      { callId: 'c1', seq: 1, verb: 'post_entry', kind: 'write', args: {}, mode: 'execute', decisionReason: 'dial_auto', dialCapability: 'post', ok: true, errorCode: null, entityRef: 'e1', durationMs: 12, at: '', agentActionId: null, draftStatus: null, rejectReason: null },
      { callId: 'c2', seq: 2, verb: 'post_entry', kind: 'write', args: {}, mode: 'execute', decisionReason: 'dial_auto', dialCapability: 'post', ok: true, errorCode: null, entityRef: 'e2', durationMs: 9, at: '', agentActionId: null, draftStatus: null, rejectReason: null },
      { callId: 'c3', seq: 3, verb: 'post_entry', kind: 'write', args: {}, mode: 'execute', decisionReason: 'dial_auto', dialCapability: 'post', ok: false, errorCode: 'period_locked', entityRef: null, durationMs: 4, at: '', agentActionId: null, draftStatus: null, rejectReason: null },
    ],
  };

  it('NAMES each completed write as in the books and never implies a rollback (critic F5 wording)', () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <Turn turn={partial} />
        </MemoryRouter>
      </I18nProvider>,
    );
    const outcome = screen.getByText(/In den Büchern/);
    // Each executed write is named INDIVIDUALLY: two posts, by their labels.
    expect(outcome.textContent).toContain('In den Büchern: Buchung erfassen, Buchung erfassen');
    expect(outcome.textContent).toContain('1 fehlgeschlagen');
    // No measured-looking figure nothing measured (critic F5), and no rollback implication.
    expect(outcome.textContent).not.toContain('nicht gestartet');
    expect(screen.queryByText(/rückgängig|zurückgerollt|storniert/i)).not.toBeInTheDocument();
  });
});

describe('"No, and tell it why" (F-08, J5.6): the reject reason', () => {
  const onePending = ok({
    actions: [
      { actionId: 'a9', actor: 'agent', dialCapability: 'post', actionTool: 'post_entry', payload: { date: '2026-09-02' }, status: 'pending', createdAt: '2026-09-02T10:00:00.000Z' },
    ],
  });

  it('the reject confirm carries an optional reason field and sends the trimmed sentence with reject_drafted_action', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: onePending,
      reject_drafted_action: (input) => {
        sent.push(input);
        return ok({ actionId: 'a9', status: 'rejected', reason: 'Falscher Lieferant' });
      },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ablehnen' }));
    // The field is optional and labelled; the placeholder says where the sentence goes.
    const field = await screen.findByLabelText('Begründung (optional)');
    fireEvent.change(field, { target: { value: '  Falscher Lieferant  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ja, ablehnen' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ workspaceId: 'ws_test', actionId: 'a9', reason: 'Falscher Lieferant' });
  });

  it('an empty reason is not sent at all: the engine gets no invented sentence', async () => {
    const sent: Record<string, unknown>[] = [];
    renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: onePending,
      reject_drafted_action: (input) => {
        sent.push(input);
        return ok({ actionId: 'a9', status: 'rejected' });
      },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ablehnen' }));
    await screen.findByLabelText('Begründung (optional)');
    fireEvent.click(screen.getByRole('button', { name: 'Ja, ablehnen' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect('reason' in sent[0]).toBe(false);
  });

  it('the trace names the rejection and its reason beside the drafting call, and an approval beside its own', () => {
    const turn: AgentTurn = {
      turnId: 't9',
      seq: 1,
      role: 'agent',
      text: null,
      at: '2026-09-02T14:02:00.000Z',
      calls: [
        { callId: 'r1', seq: 1, verb: 'post_entry', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask', dialCapability: 'post', ok: true, errorCode: null, entityRef: null, durationMs: 12, at: '', agentActionId: 'a9', draftStatus: 'rejected', rejectReason: 'Falscher Lieferant' },
        { callId: 'r2', seq: 2, verb: 'post_entry', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask', dialCapability: 'post', ok: true, errorCode: null, entityRef: 'e2', durationMs: 9, at: '', agentActionId: 'a10', draftStatus: 'executed', rejectReason: null },
        { callId: 'r3', seq: 3, verb: 'post_entry', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask', dialCapability: 'post', ok: true, errorCode: null, entityRef: null, durationMs: 9, at: '', agentActionId: 'a11', draftStatus: 'pending', rejectReason: null },
      ],
    };
    render(
      <I18nProvider>
        <MemoryRouter>
          <Turn turn={turn} />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText('Abgelehnt: Falscher Lieferant')).toBeInTheDocument();
    expect(screen.getByText('Genehmigt')).toBeInTheDocument();
    // A pending draft carries no decision word: nothing is claimed that has not happened.
    expect(screen.getAllByText(/Abgelehnt|Genehmigt/)).toHaveLength(2);
  });
});

describe('Verbindung (the MCP-first onboarding)', () => {
  const DELIVERY_SERVE = ok({
    mode: 'serve',
    version: '0.1.0',
    host: 'localhost',
    port: 4123,
    studioServed: true,
    dbPath: '/Users/beispiel/Buchhaltung/beispiel.db',
    scheduler: { enabled: false, lastTickAt: null, nextTickAt: null },
  });

  it('shows the served endpoint URL, a copy-paste client config, and the recent client labels', async () => {
    const { container } = renderAgent({ list_agent_sessions: SESSIONS, delivery_status: DELIVERY_SERVE });
    fireEvent.click(await screen.findByRole('tab', { name: 'Verbindung' }));
    // The endpoint reads host+port from delivery_status and builds http://<host>:<port>/mcp.
    expect(await screen.findByText('http://localhost:4123/mcp')).toBeInTheDocument();
    // P0.5a: the copy-paste config is GENERATED from the running instance: the docs' form (the
    // `tillbooks` key, `npx -y ... mcp`) with TILL_DB_PATH set to the ledger THIS process opened, so the
    // agent cannot open a different book than the Studio shows.
    const config = JSON.parse(container.querySelector('.agent-connect-code')?.textContent ?? '{}');
    expect(Object.keys(config.mcpServers)).toEqual(['tillbooks']);
    expect(config.mcpServers.tillbooks.command).toBe('npx');
    expect(config.mcpServers.tillbooks.args[0]).toBe('-y');
    expect(config.mcpServers.tillbooks.args[1]).toMatch(/^tillbooks(@.+)?$/);
    expect(config.mcpServers.tillbooks.args[2]).toBe('mcp');
    expect(config.mcpServers.tillbooks.env).toEqual({ TILL_DB_PATH: '/Users/beispiel/Buchhaltung/beispiel.db' });
    // The path is also said in words, and so is where a human approves what the agent drafts.
    expect(screen.getByText(/dasselbe Hauptbuch wie dieses Studio/)).toBeInTheDocument();
    expect(screen.getByText(/entscheidest du in den Pendenzen/)).toBeInTheDocument();
    // The recent client labels come from list_agent_sessions, the read the Gespräche tab uses.
    await waitFor(() =>
      expect(container.querySelector('.agent-connect-clients')?.textContent ?? '').toContain('Claude Desktop'),
    );
    expect(container.querySelector('.agent-connect-clients')?.textContent ?? '').toContain('Claude Code');
    // Honest copy: TILL cannot write the client's config file, so this is copy-into-your-client.
    expect(screen.getByText(/kann die Konfiguration deines Clients nicht selbst schreiben/)).toBeInTheDocument();
  });

  it('P0.5a: an in-memory ledger gets no stdio block (no second process can open it), only the endpoint', async () => {
    const { container } = renderAgent({
      list_agent_sessions: ok({ sessions: [] }),
      delivery_status: ok({ mode: 'up', version: '0.1.0', host: '127.0.0.1', port: 8788, studioServed: true, dbPath: ':memory:', scheduler: { enabled: true, lastTickAt: null, nextTickAt: null } }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Verbindung' }));
    expect(await screen.findByText('http://127.0.0.1:8788/mcp')).toBeInTheDocument();
    expect(screen.getByText(/im Arbeitsspeicher/)).toBeInTheDocument();
    expect(container.querySelector('.agent-connect-code')).toBeNull();
  });

  it('explains the stdio start when TILL runs over the command line (mode mcp)', async () => {
    renderAgent({
      list_agent_sessions: ok({ sessions: [] }),
      delivery_status: ok({ mode: 'mcp', version: '0.1.0', host: null, port: null, studioServed: false, scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Verbindung' }));
    expect(await screen.findByText(/till mcp \(stdio\)/)).toBeInTheDocument();
  });
});

describe('Gespräche empty state connects an agent (D135)', () => {
  it('the action deep-links to the Verbindung tab in place, never routing away to /setup', async () => {
    renderAgent({ list_agent_sessions: ok({ sessions: [] }) });
    const connect = await screen.findByRole('button', { name: 'Agent verbinden' });
    // A button (an in-place tab switch), not a link to another surface.
    expect(connect.tagName).toBe('BUTTON');
    fireEvent.click(connect);
    expect(screen.getByRole('tab', { name: 'Verbindung' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the Commit moment on a decision (D122 D-I)', () => {
  const onePending = ok({
    actions: [
      { actionId: 'a9', actor: 'agent', dialCapability: 'post', actionTool: 'post_entry', payload: { date: '2026-09-02' }, status: 'pending', createdAt: '2026-09-02T10:00:00.000Z' },
    ],
  });

  it('an approval lands its banner (data-just-committed) with the outcome in words, since the card leaves the queue', async () => {
    const { container } = renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: onePending,
      approve_drafted_action: ok({ actionId: 'a9', status: 'executed' }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen' }));
    expect(await screen.findByText('Genehmigt und ausgeführt')).toBeInTheDocument();
    const banner = container.querySelector('.action-feedback--success');
    expect(banner?.hasAttribute('data-just-committed')).toBe(true);
  });

  it('§H-TENANT: an approval answered after a workspace switch paints no banner and no old queue on the new workspace', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canned: Canned = {
      list_agent_sessions: SESSIONS,
      list_drafted_actions: (input) =>
        input.workspaceId === 'ws_test' ? onePending : ok({ actions: [] }),
      approve_drafted_action: (() => gate.then(() => ok({ actionId: 'a9', status: 'executed' }))) as unknown as Handler,
    };
    function SwitchToB() {
      const { setWorkspaceId } = useWorkspace();
      return (
        <button type="button" onClick={() => setWorkspaceId('ws_b')}>
          switch-to-b
        </button>
      );
    }
    const { container } = render(
      <TillClientProvider client={new TillClient(fakeTransport(canned))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={ALLOW_ALL}>
              <MemoryRouter initialEntries={['/agent']}>
                <SwitchToB />
                <Agent />
              </MemoryRouter>
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen' }));
    // The approval is in flight; the person switches to workspace B, whose queue is empty.
    fireEvent.click(screen.getByRole('button', { name: 'switch-to-b' }));
    expect(await screen.findByText('Nichts zu genehmigen.')).toBeInTheDocument();
    // Workspace A's answer arrives now.
    await act(async () => {
      (release as unknown as () => void)();
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText('Genehmigt und ausgeführt')).toBeNull();
    expect(container.querySelector('.action-feedback')).toBeNull();
    // ...and A's card never comes back onto B through a stale re-read.
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('a refused approval lands nothing: no banner claims an outcome the engine did not give', async () => {
    const { container } = renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: onePending,
      approve_drafted_action: { status: 409, body: { ok: false, error: 'already_rejected' } },
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Genehmigen' })).not.toBeDisabled());
    expect(container.querySelector('.action-feedback')).toBeNull();
    expect(container.querySelector('[data-just-committed]')).toBeNull();
  });

  it('a rejection names itself in words and does not land the success tint', async () => {
    const { container } = renderAgent({
      list_agent_sessions: SESSIONS,
      list_drafted_actions: onePending,
      reject_drafted_action: ok({ actionId: 'a9', status: 'rejected' }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getAllByRole('button', { name: /^Mehr zu:/ })[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ablehnen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ja, ablehnen' }));
    expect(await screen.findByText('Abgelehnt')).toBeInTheDocument();
    expect(container.querySelector('.action-feedback--info')?.hasAttribute('data-just-committed')).toBe(false);
  });
});
