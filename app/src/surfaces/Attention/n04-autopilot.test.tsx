/**
 * N04 (D183): the autopilot in Pendenzen. The offer of a proven Buchungsregel reads "Regel ...: 10×
 * unverändert gebucht. Künftig automatisch buchen?" with its ceiling, and its buttons are "Künftig
 * automatisch" and "Nicht jetzt". The daily digest card "Automatisch gebucht (n)" lists each line with
 * "Rückgängig" (reopen_bank_line) and "Automatik aus" (revoke_rule_autobook), the lines left to a person
 * with their reason, and "Gesehen" (autopilot_mark_seen) closes it. An empty day has no card (the engine
 * lists none). SYNTHETIC DATA ONLY: invented names, ids and amounts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import { groupedOf } from './testing';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const OFFER = 'act_offer';

function offerRow(): Record<string, unknown> {
  return {
    queueId: 'agent_action',
    entityKind: 'agent_action',
    entityId: OFFER,
    titleKey: 'attention.item.agentAction.title',
    titleParams: {},
    subtitleKey: 'attention.item.agentAction.subtitle',
    subtitleParams: { tool: 'grant_rule_autobook', counterparty: 'Fernmeldewerk Beispiel AG' },
    since: '2026-11-02T05:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/agent', params: { actionId: OFFER } },
    proposedBy: 'system',
    decisionOptions: [
      { id: 'approve', verb: 'approve_drafted_action', labelKey: 'attention.autobookOffer.grant', role: 'primary', input: { actionId: OFFER }, capability: 'manage_agent_dial' },
      { id: 'reject', verb: 'reject_drafted_action', labelKey: 'attention.autobookOffer.dismiss', role: 'danger', input: { actionId: OFFER }, capability: 'manage_agent_dial', reasonField: true },
    ],
    consequenceKey: null,
    changedSinceProposal: false,
    batchable: false,
    autobookOffer: { standardId: 'bstd_telco', counterparty: 'Fernmeldewerk Beispiel AG', label: null, cleanUses: 10, ceilingMinor: 13485, currency: 'CHF' },
  };
}

function digestRow(): Record<string, unknown> {
  return {
    queueId: 'autopilot',
    entityKind: 'autobook_digest',
    entityId: '2026-11-02',
    titleKey: 'attention.item.autobookDigest.title',
    titleParams: { count: 2 },
    subtitleKey: 'attention.item.autobookDigest.subtitle',
    subtitleParams: { date: '2026-11-02', notBooked: 1 },
    since: '2026-11-02',
    urgency: 'open',
    deepLink: { route: '/bank', params: {} },
    decisionOptions: [{ id: 'seen', verb: 'autopilot_mark_seen', labelKey: 'attention.act.seen', role: 'secondary', input: { kind: 'digest', ref: '2026-11-02' }, capability: 'read_sales' }],
    reasonCode: null,
    reasonKey: null,
    consequenceKey: null,
    autobookDigest: {
      day: '2026-11-02',
      lines: [
        { bankTxnId: 'bt_1', standardId: 'bstd_telco', counterparty: 'Fernmeldewerk Beispiel AG', ruleLabel: 'Telefon', amountMinor: -8990, currency: 'CHF', lineDate: '2026-10-30', entryId: 'je_1', stands: true, reason: null, grantLive: true },
        { bankTxnId: 'bt_2', standardId: 'bstd_telco', counterparty: 'Fernmeldewerk Beispiel AG', ruleLabel: 'Telefon', amountMinor: -8990, currency: 'CHF', lineDate: '2026-10-31', entryId: 'je_2', stands: false, reason: null, grantLive: true },
        { bankTxnId: 'bt_3', standardId: 'bstd_telco', counterparty: 'Fernmeldewerk Beispiel AG', ruleLabel: 'Telefon', amountMinor: -99000, currency: 'CHF', lineDate: '2026-11-01', entryId: null, stands: false, reason: 'over_ceiling', grantLive: true },
      ],
    },
  };
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
              </Routes>
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

function engine(rows: Record<string, unknown>[], calls: { action: string; input: Record<string, unknown> }[]): Transport {
  return async (action, input) => {
    calls.push({ action, input });
    if (action === 'attention_list') return ok(groupedOf(rows, { computedAt: '2026-11-02T08:00:00.000Z', visibleQueues: 2 }));
    if (action === 'list_drafted_actions') {
      return ok({
        actions: [
          {
            actionId: OFFER,
            actor: 'system',
            dialCapability: null,
            actionTool: 'grant_rule_autobook',
            payload: { workspaceId: 'ws_test', standardId: 'bstd_telco', idempotencyKey: 'agrantk_1' },
            status: 'pending',
            createdAt: '2026-11-02T05:00:00.000Z',
          },
        ],
      });
    }
    return ok();
  };
}

describe('N04: the autopilot in Pendenzen', () => {
  it('the offer says how often the rule booked unchanged, up to which ceiling, and answers "Künftig automatisch"', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    renderHub(engine([offerRow()], calls));
    expect(await screen.findByText('Regel Fernmeldewerk Beispiel AG: 10× unverändert gebucht. Künftig automatisch buchen?')).toBeTruthy();
    expect(screen.getByText(/Bis CHF\s?134\.85 pro Zeile, nur in CHF/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Künftig automatisch' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'approve_drafted_action' && c.input.actionId === OFFER)).toBe(true));
  });

  it('the digest card lists the lines with Rückgängig and Automatik aus, the undone and the left ones in words, and Gesehen closes it', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    renderHub(engine([digestRow()], calls));
    expect(await screen.findByText('Automatisch gebucht (2)')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Automatisch gebucht (2)' });
    const lines = within(list).getAllByRole('listitem');
    expect(lines).toHaveLength(3);
    expect(within(lines[1] as HTMLElement).getByText('Rückgängig gemacht')).toBeTruthy();
    expect(within(lines[2] as HTMLElement).getByText(/Nicht automatisch: über der Obergrenze/)).toBeTruthy();
    expect(within(lines[1] as HTMLElement).queryByRole('button')).toBeNull();

    fireEvent.click(within(lines[0] as HTMLElement).getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'reopen_bank_line')).toBe(true));
    const undo = calls.find((c) => c.action === 'reopen_bank_line');
    expect(undo?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'bt_1', reason: 'Rückgängig', idempotencyKey: 'attention:autobook-undo:bt_1:je_1' });

    await waitFor(() => expect((within(lines[0] as HTMLElement).getByRole('button', { name: 'Automatik aus' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(lines[0] as HTMLElement).getByRole('button', { name: 'Automatik aus' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'revoke_rule_autobook' && c.input.standardId === 'bstd_telco')).toBe(true));

    await waitFor(() => expect((screen.getByRole('button', { name: 'Gesehen' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Gesehen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'autopilot_mark_seen' && c.input.kind === 'digest' && c.input.ref === '2026-11-02')).toBe(true));
  });
});
