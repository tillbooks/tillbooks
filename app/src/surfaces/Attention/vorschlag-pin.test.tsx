/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1) on the attention hub. The hub approves an agent's
 * Vorschlag from its row, so it carries the same three things the Vorschlag card does: the figures the
 * engine froze at the proposal, the approve exits withheld when the record changed since (with the
 * sentence saying it can no longer be approved, rejecting still possible), and the `vorschlag_stale`
 * refusal named in the hub's ONE stale wording (the design judge). The date ends the meta line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { groupedOf } from './testing';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** The grouped answer for these rows (D178: the page reads the whole list in sections). */
function summaryOf(top: Record<string, unknown>[]) {
  return groupedOf(top, { computedAt: '2026-10-11T08:00:00.000Z', visibleQueues: 1 });
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
    if (action === 'attention_list') return ok(summary);
    if (action === 'approve_drafted_action' && approve !== undefined) return approve;
    return ok();
  };

beforeEach(() => {
  window.localStorage.clear();
});

describe('the hub row of a pinned Vorschlag', () => {
  it('shows the figures frozen at the proposal: the key figure on the line, every figure in Details', async () => {
    const { container } = renderHub(canned(summaryOf([issueRow()])));
    await screen.findByRole('button', { name: 'Freigeben' });
    // D162 point 1 on the face, WITHOUT opening Details: the pinned counterparty, recipient and total.
    expect(container.querySelector('.vorschlag-readback')).toBeNull();
    // D197, the shared row: the signed total in its cell, the pinned counterparty and recipient beside the subject.
    expect(container.querySelector('.pl-amount')?.textContent).toBe("CHF 1'081.00");
    expect(container.querySelector('[data-figure="key"]')?.textContent).toBe('Muster AG · an buchhaltung@muster.example');
    expect(container.querySelector('.pl-date')?.textContent).toBe('11.10.2026');
    // Every pinned figure is one click away, as label and value.
    // D201: Details open in place from the row's chevron (the title is words, the fresh-eyes judge, N4 M4).
    fireEvent.click(screen.getByRole('button', { name: /^Rechnung ausstellen/ }));
    // The Details rows render now; the payload and dial reads settle before the assertions.
    // D208: the open line says the values in one line, without labels (their names are the row's own words).
    const readback = await waitFor(() => {
      const el = container.querySelector('.pl-readback');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(container.querySelector('.pl-open dt, .pl-open label')).toBeNull();
    expect(readback.textContent ?? '').toContain('Muster AG');
    expect(readback.textContent ?? '').toContain('buchhaltung@muster.example');
  });

  it('a posting Vorschlag names its accounts in words and the total on the line, before any Details', async () => {
    const actionId = 'act_p';
    const row = issueRow({ entityId: actionId, subtitleParams: { tool: 'post_entry' }, consequenceKey: 'agent.consequence.post', figures: null, deepLink: { route: '/agent', params: { actionId } } });
    const transport: Transport = async (action) => {
      if (action === 'attention_list') return ok(summaryOf([row]));
      if (action === 'list_drafted_actions') {
        return ok({
          actions: [
            {
              actionId,
              actor: 'agent',
              dialCapability: 'post',
              actionTool: 'post_entry',
              payload: { workspaceId: 'ws_test', date: '2026-10-10', source: 'manual', idempotencyKey: 'kp', lines: [{ account: 'acc_50', debit: 4850 }, { account: 'acc_2', credit: 4850 }] },
              status: 'pending',
              createdAt: '2026-10-10T09:00:00.000Z',
            },
          ],
        });
      }
      // The PINNED recording (acc_50 is 6500, acc_2 is 1020), never hand-typed accounts.
      if (action === 'list_accounts') return ok({ accounts: listAccountsFixture.accounts });
      return ok();
    };
    const { container } = renderHub(transport);
    await screen.findByRole('button', { name: 'Freigeben' });
    await waitFor(() => expect(container.querySelector('[data-figure="key"]')?.textContent).toBe('6500 Verwaltungs- und Bürokosten an 1020 Bankkonto'));
    expect(container.querySelector('.pl-amount')?.textContent).toBe('CHF 48.50');
    expect(container.querySelector('.vorschlag-readback')).toBeNull();
    // D167 polish 11: the tooltip with the full text is there only when the ellipsis cuts it; here it fits.
    const figure = container.querySelector('[data-figure="key"]') as HTMLElement;
    expect(figure).not.toHaveAttribute('aria-describedby');
  });

  it('a record changed since the proposal: no approve exit, the sentence says why, reject stays', async () => {
    renderHub(canned(summaryOf([issueRow({ changedSinceProposal: true })])));
    // L1 (N4): the row says the short words; the long sentence is the refusal banner's.
    expect(await screen.findByText('Geändert')).toBeInTheDocument();
    // D197: Freigeben stays in place, disabled, its reason on the tooltip; the way on beside it.
    expect(screen.getByRole('button', { name: 'Freigeben' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Mehr zu: Rechnung ausstellen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Freigeben und als Regel speichern' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeEnabled();
  });

  it('a vorschlag_stale refusal renders its own sentence, not the generic one', async () => {
    const stale: RestResponse = { status: 409, body: { ok: false, error: 'vorschlag_stale', actionId: 'act_1', actionTool: 'issue_invoice' } };
    renderHub(canned(summaryOf([issueRow()]), stale));
    fireEvent.click(await screen.findByRole('button', { name: 'Freigeben' }));
    const said = await screen.findByText('Seit dem Vorschlag geändert, nicht mehr freizugeben');
    expect(said.closest('.action-feedback')).not.toBeNull();
    expect(screen.queryByText(/Das hat nicht geklappt/)).toBeNull();
  });
});
