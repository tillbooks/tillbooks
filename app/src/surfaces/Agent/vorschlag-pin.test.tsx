/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1) at the surface. The card used to show `invoiceId` and
 * nothing else for an `issue_invoice` Vorschlag, so the person could not see that the draft behind it
 * was CHF 99,999 rather than the CHF 1,000 the agent had talked about. The engine now freezes the
 * record's key figures at the proposal; these tests hold that the card leads with them, says when the
 * record changed since (and holds the approve), and that a `vorschlag_stale` refusal is named in words
 * on both decision surfaces instead of landing silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { KeyboardProvider } from '../../app/keyboard';
import { Agent, AgentDock } from './index';
import { VorschlagCard } from './VorschlagCard';
import { Turn } from './TurnList';
import { parseDrafted, type AgentTurn, type DraftedAction } from './model';

const quiet: Transport = async () => ({ status: 200, body: { ok: true } });

function wrap(node: React.ReactNode, transport: Transport = quiet) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={ALLOW_ALL}>
            <MemoryRouter initialEntries={['/agent']}>{node}</MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** A synthetic issue_invoice Vorschlag on a draft: CHF 1,000.00 net, two lines, Muster AG. */
const issueDraft: DraftedAction = {
  actionId: 'act_1',
  actor: 'agent',
  dialCapability: 'issue',
  actionTool: 'issue_invoice',
  payload: { workspaceId: 'ws_test', invoiceId: 'doc_1', idempotencyKey: 'k1' },
  status: 'pending',
  createdAt: '2026-10-11T09:00:00.000Z',
  rejectReason: null,
  figures: {
    number: null,
    numberPending: true,
    counterparty: 'Muster AG',
    recipient: 'buchhaltung@muster.example',
    amountMinor: 100000,
    amountBasis: 'net',
    currency: 'CHF',
    taxMinor: 8100,
    grossMinor: 108100,
    lineCount: 2,
  },
  changedSinceProposal: false,
};

const rows = () =>
  [...document.querySelectorAll('.vorschlag-readback-row')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);

beforeEach(() => {
  window.localStorage.clear();
});

describe('the card shows what is being approved', () => {
  it('leads with the frozen figures: Netto with currency, draft number, counterparty, line count', () => {
    wrap(<VorschlagCard action={issueDraft} accent onApprove={() => undefined} onReject={() => undefined} />);
    const shown = rows();
    expect(shown[0]?.[0]).toBe('Netto');
    expect(shown[0]?.[1]).toContain("1'000.00");
    expect(shown[0]?.[1]).toContain('CHF');
    expect(shown).toContainEqual(['Nummer', 'Entwurf, noch ohne Nummer']);
    expect(shown).toContainEqual(['Gegenpartei', 'Muster AG']);
    expect(shown).toContainEqual(['Positionen', '2']);
    // Critic round 2: the recipient the send goes to, and VAT and gross beside the net.
    expect(shown).toContainEqual(['An', 'buchhaltung@muster.example']);
    expect(shown.find(([term]) => term === 'MWST')?.[1]).toContain('81.00');
    expect(shown.find(([term]) => term === 'Total')?.[1]).toContain("1'081.00");
    // The figure is the lead: it is not repeated by the payload-derived amount row.
    expect(shown.filter(([, value]) => value.includes("1'000.00"))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Genehmigen' })).toBeEnabled();
  });

  it('an issued number, a foreign currency and the plain amount label render as given', () => {
    const run: DraftedAction = {
      ...issueDraft,
      actionTool: 'payment_batch_transmit',
      figures: { number: 'R-2026-0007', numberPending: false, counterparty: null, recipient: null, amountMinor: 250050, amountBasis: 'amount', currency: 'EUR', taxMinor: null, grossMinor: null, lineCount: 3 },
    };
    wrap(<VorschlagCard action={run} accent onApprove={() => undefined} onReject={() => undefined} />);
    const shown = rows();
    expect(shown[0]?.[0]).toBe('Betrag');
    expect(shown[0]?.[1]).toContain('EUR');
    expect(shown[0]?.[1]).toContain("2'500.50");
    expect(shown).toContainEqual(['Nummer', 'R-2026-0007']);
    expect(shown.some(([term]) => term === 'Gegenpartei')).toBe(false);
    expect(shown.some(([term]) => term === 'MWST' || term === 'An')).toBe(false);
  });

  it('a Vorschlag with no frozen figures keeps the payload read-back it always had', () => {
    const plain: DraftedAction = { ...issueDraft, actionTool: 'record_payment', figures: null, payload: { workspaceId: 'ws_test', amountMinor: 120000 } };
    wrap(<VorschlagCard action={plain} accent onApprove={() => undefined} onReject={() => undefined} />);
    expect(rows()[0]?.[1]).toContain("1'200.00");
    expect(rows().some(([term]) => term === 'Nummer')).toBe(false);
  });

  it('when the record changed since the proposal the card says so and holds the approve', () => {
    wrap(<VorschlagCard action={{ ...issueDraft, changedSinceProposal: true }} accent onApprove={() => undefined} onReject={() => undefined} />);
    expect(screen.getByText(/Seit dem Vorschlag geändert/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).toBeNull();
    // Rejecting stays possible, from the overflow.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.queryByRole('menuitem', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Ablehnen' })).toBeEnabled();
  });

  it('parseDrafted reads the figures defensively: a malformed shape is absent, never guessed', () => {
    const [good, bad] = parseDrafted({
      actions: [
        { actionId: 'a', actionTool: 'issue_invoice', figures: { amountMinor: 5000, amountBasis: 'net', currency: 'CHF', numberPending: true }, changedSinceProposal: true },
        { actionId: 'b', actionTool: 'issue_invoice', figures: 'oops' },
      ],
    });
    expect(good?.figures?.amountMinor).toBe(5000);
    expect(good?.figures?.numberPending).toBe(true);
    expect(good?.figures?.counterparty).toBeNull();
    expect(good?.changedSinceProposal).toBe(true);
    expect(bad?.figures).toBeNull();
    expect(bad?.changedSinceProposal).toBe(false);
  });
});

describe('the stale refusal is named in words', () => {
  const STALE: RestResponse = {
    status: 409,
    body: { ok: false, error: 'vorschlag_stale', actionId: 'act_1', actionTool: 'issue_invoice' },
  };

  it('the Vorschläge queue: approving a Vorschlag whose record changed shows that nothing ran', async () => {
    let decided = false;
    const transport: Transport = async (action) => {
      if (action === 'list_agent_sessions') return { status: 200, body: { ok: true, sessions: [] } };
      if (action === 'list_drafted_actions') return { status: 200, body: { ok: true, actions: decided ? [] : [issueDraft] } };
      if (action === 'approve_drafted_action') {
        decided = true;
        return STALE;
      }
      return { status: 200, body: { ok: true } };
    };
    const { container } = wrap(<Agent />, transport);
    fireEvent.click(await screen.findByRole('tab', { name: 'Vorschläge' }));
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Genehmigen' }));
    const banner = await screen.findByText(/Nicht ausgeführt: Die Daten hinter diesem Vorschlag haben sich geändert/);
    expect(banner).toBeInTheDocument();
    expect(container.querySelector('.action-feedback--warn')).not.toBeNull();
    expect(container.querySelector('[data-just-committed]')).toBeNull();
    expect(screen.queryByText('Genehmigt und ausgeführt')).toBeNull();
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0));
  });

  it('the dock: the same refusal lands as the same words, not as an approval', async () => {
    let decided = false;
    const transport: Transport = async (action) => {
      if (action === 'list_agent_sessions') {
        return {
          status: 200,
          body: { ok: true, sessions: [{ sessionId: 's1', clientLabel: 'Client a', startedAt: '2026-10-11T09:00:00.000Z', lastAt: '2026-10-11T09:00:00.000Z', open: true, calls: 1, writes: 0, drafts: 1 }] },
        };
      }
      if (action === 'get_agent_session') {
        return { status: 200, body: { ok: true, sessionId: 's1', actor: 'agent', clientLabel: 'Client a', startedAt: '2026-10-11T09:00:00.000Z', lastAt: '2026-10-11T09:00:00.000Z', open: true, turns: [] } };
      }
      if (action === 'runtime_status') return { status: 200, body: { ok: true, registered: false } };
      if (action === 'list_drafted_actions') return { status: 200, body: { ok: true, actions: decided ? [] : [issueDraft] } };
      if (action === 'approve_drafted_action') {
        decided = true;
        return STALE;
      }
      return { status: 200, body: { ok: true } };
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={ALLOW_ALL}>
              <MemoryRouter>
                <KeyboardProvider>
                  <AgentDock />
                </KeyboardProvider>
              </MemoryRouter>
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Agent/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Genehmigen' }));
    expect(await screen.findByText(/Nicht ausgeführt: Die Daten hinter diesem Vorschlag haben sich geändert/)).toBeInTheDocument();
    expect(screen.queryByText('Genehmigt und ausgeführt')).toBeNull();
  });

  it('the trace names a void proposal beside its drafting call', () => {
    const turn: AgentTurn = {
      turnId: 't1',
      seq: 1,
      role: 'agent',
      text: null,
      at: '2026-10-11T09:00:00.000Z',
      calls: [
        {
          callId: 'c1',
          seq: 1,
          verb: 'issue_invoice',
          kind: 'write',
          args: { invoiceId: 'doc_1' },
          mode: 'draft',
          decisionReason: 'dial_ask',
          dialCapability: 'issue',
          ok: true,
          errorCode: null,
          entityRef: null,
          durationMs: 3,
          at: '2026-10-11T09:00:00.000Z',
          agentActionId: 'act_1',
          draftStatus: 'stale',
          rejectReason: null,
        },
      ],
    };
    wrap(<Turn turn={turn} />);
    const decision = document.querySelector('[data-decision="stale"]');
    expect(decision?.textContent).toBe('Verfallen: nach dem Vorschlag geändert');
    expect(within(document.body).queryByText('Genehmigt')).toBeNull();
  });
});
