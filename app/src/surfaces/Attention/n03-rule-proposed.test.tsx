/**
 * N03 (D183): a mined Buchungsregel's Vorschlag in Pendenzen. The engine carries its facts on the item
 * (`ruleProposal`): the line says "Regel vorschlagen: <Gegenpartei>, 3× gleich gebucht" over its backtest
 * ("Seit 01.01.2026: 14 Zeilen, 13 genau so gebucht"); "Regel anlegen" approves it, "Nicht vorschlagen"
 * rejects it, "Anpassen" (in the ⋯) opens the bank line it was found on with the rule form, and Details lead
 * with the bookings it was found in. There is no "Genehmigen und künftig automatisch": no seat drafted it.
 *
 * Every name and figure is invented for this file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import { groupedOf } from './testing';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const ACTION = 'act_mined';

/** The engine's row for a mined rule (attention/vorschlaege.ts), as `attention_list` answers it. */
function minedRow(): Record<string, unknown> {
  return {
    queueId: 'agent_action_bank',
    entityKind: 'agent_action',
    entityId: ACTION,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams: { tool: 'set_bank_standard', counterparty: 'Fernmeldewerk Beispiel AG' },
    since: '2026-11-02T05:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/agent', params: { actionId: ACTION } },
    proposedBy: 'system',
    decisionOptions: [
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'attention.ruleProposed.create', role: 'primary', input: { actionId: ACTION }, capability: 'manage_agent_dial' },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'attention.ruleProposed.dismiss', role: 'danger', input: { actionId: ACTION }, capability: 'manage_agent_dial', reasonField: true },
    ],
    consequenceKey: null,
    changedSinceProposal: false,
    batchable: false,
    ruleProposal: {
      counterparty: 'Fernmeldewerk Beispiel AG',
      repeats: 3,
      since: '2026-01-01',
      hits: 14,
      identical: 13,
      bankTxnId: 'bt_new',
      evidence: [
        { bankTxnId: 'bt_new', date: '2026-10-28', amountMinor: -8990, currency: 'CHF' },
        { bankTxnId: 'bt_mid', date: '2026-09-28', amountMinor: -8990, currency: 'CHF' },
      ],
    },
  };
}

function Where() {
  const at = useLocation();
  return <p data-testid="where">{`${at.pathname}${at.search}`}</p>;
}

function renderHub(transport: Transport) {
  const capabilities: Capabilities = { whoami: null, can: () => true, refresh: () => undefined };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/attention']}>
              <Routes>
                <Route path="/attention" element={<Attention />} />
                <Route path="*" element={<Where />} />
              </Routes>
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

function engine(calls: { action: string; input: Record<string, unknown> }[]): Transport {
  return async (action, input) => {
    calls.push({ action, input });
    if (action === 'attention_list') return ok(groupedOf([minedRow()], { computedAt: '2026-11-02T08:00:00.000Z', visibleQueues: 1 }));
    if (action === 'list_drafted_actions') {
      return ok({
        actions: [
          {
            actionId: ACTION,
            actor: 'system',
            dialCapability: null,
            actionTool: 'set_bank_standard',
            payload: { workspaceId: 'ws_test', bankTxnId: 'bt_new', legs: [{ accountId: 'acc_6570', taxCode: null, amount: { kind: 'rest' } }], label: 'Fernmeldewerk Beispiel AG', idempotencyKey: 'mine:iban:CH4431999123000889012:abc123abc123' },
            status: 'pending',
            createdAt: '2026-11-02T05:00:00.000Z',
          },
        ],
      });
    }
    return ok();
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('N03: a mined rule in Pendenzen', () => {
  it('says what it proposes and its backtest; Regel anlegen approves it', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const { container } = renderHub(engine(calls));
    const create = await screen.findByRole('button', { name: 'Regel anlegen' });
    expect(screen.getByText('Regel vorschlagen: Fernmeldewerk Beispiel AG, 3× gleich gebucht')).toBeInTheDocument();
    expect(container.querySelector('.vorschlag-line-meta--hub')?.textContent).toBe('Seit 01.01.2026: 14 Zeilen, 13 genau so gebucht');
    expect(screen.queryByRole('button', { name: 'Genehmigen' })).toBeNull();
    fireEvent.click(create);
    await waitFor(() => expect(calls.find((c) => c.action === 'approve_drafted_action')?.input).toMatchObject({ actionId: ACTION }));
  });

  it('the ⋯ offers Anpassen (to the bank line with the rule form) and Nicht vorschlagen, never künftig automatisch; Details list the bookings', async () => {
    const { container } = renderHub(engine([]));
    await screen.findByRole('button', { name: 'Regel anlegen' });
    fireEvent.click(screen.getByRole('button', { name: /^Mehr zu: / }));
    expect(await screen.findByRole('menuitem', { name: 'Nicht vorschlagen' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /künftig automatisch/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Details' }));
    await waitFor(() => expect(container.querySelectorAll('.vorschlag-readback-row').length).toBeGreaterThan(0));
    const rows = [...container.querySelectorAll('.vorschlag-readback-row')].map((r) => [r.querySelector('dt')?.textContent ?? '', r.querySelector('dd')?.textContent ?? '']);
    expect(rows).toContainEqual(['Gleich gebucht', '28.10.2026, CHF 89.90']);
    expect(rows).toContainEqual(['Gleich gebucht', '28.09.2026, CHF 89.90']);
    fireEvent.click(screen.getByRole('button', { name: /^Mehr zu: / }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Anpassen' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/bank?line=bt_new&rule=save');
  });
});
