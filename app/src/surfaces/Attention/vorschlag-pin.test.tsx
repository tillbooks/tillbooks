/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1) on the attention hub. The hub approves an agent's
 * Vorschlag from its row, so it carries the same three things the Vorschlag card does: the figures the
 * engine froze at the proposal, the approve exits withheld when the record changed since (with the
 * sentence saying why, rejecting still possible), and the `vorschlag_stale` refusal named in words.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function summaryOf(top: Record<string, unknown>[]) {
  return {
    computedAt: '2026-10-11T08:00:00.000Z',
    visibleQueues: 1,
    total: top.length,
    incomplete: false,
    queues: [{ queueId: 'agent_action', area: 'system', count: top.length, topUrgency: 'open' }],
    top,
    failed: [],
  };
}

/** A synthetic issue_invoice Vorschlag row: a CHF 1,000.00 net draft for Muster AG, two lines. */
function issueRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const actionId = 'act_1';
  return {
    queueId: 'agent_action',
    entityKind: 'agent_action',
    entityId: actionId,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams: { tool: 'issue_invoice' },
    since: '2026-10-11T07:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/agent', params: { actionId } },
    proposedBy: 'agent',
    decisionOptions: [
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'agent.card.approve', role: 'primary', input: { actionId }, capability: 'manage_agent_dial' },
      { id: 'approve_allow', verb: 'approve_drafted_action', labelKey: 'agent.card.approveAllow', role: 'secondary', input: { actionId, allowFuture: true }, capability: 'manage_agent_dial' },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'agent.card.reject', role: 'danger', input: { actionId }, capability: 'manage_agent_dial', reasonField: true },
    ],
    consequenceKey: 'agent.consequence.issue',
    figures: { number: null, numberPending: true, counterparty: 'Muster AG', recipient: 'buchhaltung@muster.example', amountMinor: 100000, amountBasis: 'net', currency: 'CHF', taxMinor: 8100, grossMinor: 108100, lineCount: 2 },
    changedSinceProposal: false,
    ...over,
  };
}

function renderHub(transport: Transport) {
  const capabilities: Capabilities = { whoami: null, can: () => true, refresh: () => undefined };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/attention']}>
              <Attention />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const canned =
  (summary: Record<string, unknown>, approve?: RestResponse): Transport =>
  async (action) => {
    if (action === 'attention_summary') return ok(summary);
    if (action === 'approve_drafted_action' && approve !== undefined) return approve;
    return ok();
  };

beforeEach(() => {
  window.localStorage.clear();
});

describe('the hub row of a pinned Vorschlag', () => {
  it('shows the figures frozen at the proposal on the row', async () => {
    const { container } = renderHub(canned(summaryOf([issueRow()])));
    await screen.findByRole('button', { name: 'Genehmigen' });
    const line = container.querySelector('[data-figures]')?.textContent ?? '';
    expect(line).toContain('Entwurf, noch ohne Nummer');
    expect(line).toContain('Muster AG');
    expect(line).toContain("Netto CHF 1'000.00");
    expect(line).toContain('2 Positionen');
    expect(line).toContain('An buchhaltung@muster.example');
    expect(line).toContain("MWST CHF 81.00");
    expect(line).toContain("Total CHF 1'081.00");
  });

  it('a record changed since the proposal: no approve exit, the sentence says why, reject stays', async () => {
    renderHub(canned(summaryOf([issueRow({ changedSinceProposal: true })])));
    expect(await screen.findByText(/Seit dem Vorschlag geändert/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Genehmigen und künftig automatisch' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeEnabled();
  });

  it('a vorschlag_stale refusal renders its own sentence, not the generic one', async () => {
    const stale: RestResponse = { status: 409, body: { ok: false, error: 'vorschlag_stale', actionId: 'act_1', actionTool: 'issue_invoice' } };
    renderHub(canned(summaryOf([issueRow()]), stale));
    fireEvent.click(await screen.findByRole('button', { name: 'Genehmigen' }));
    expect(await screen.findByText(/Nicht ausgeführt: Die Daten hinter diesem Vorschlag haben sich geändert/)).toBeInTheDocument();
    expect(screen.queryByText(/Das hat nicht geklappt/)).toBeNull();
  });
});
