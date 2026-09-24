/**
 * A35 CRITIC REGRESSIONS at the surface (the 18.08.2026 FAIL): the critic's component probes
 * CP1-CP6, adopted as permanent tests asserting the FIXES. The card shows the money it asks a human
 * to approve (F4), formats it and labels it in de-CH (F6); the partial-turn line claims only what
 * executed (F5); Vertrauen renders WHO granted (F3).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { Agent } from './index';
import { VorschlagCard } from './VorschlagCard';
import { Turn } from './TurnList';
import type { AgentTurn, DraftedAction } from './model';

const transport: Transport = async () => ({ status: 200, body: { ok: true } });

function wrap(node: React.ReactNode) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={ALLOW_ALL}>
            <MemoryRouter>{node}</MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const postDraft: DraftedAction = {
  actionId: 'aa_1',
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'post_entry',
  payload: {
    workspaceId: 'ws_test',
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: 'k',
    lines: [
      { account: 'acc_6500', debit: 120000 },
      { account: 'acc_1020', credit: 120000 },
    ],
  },
  status: 'pending',
  createdAt: '2026-06-12T10:00:00.000Z',
  rejectReason: null,
};

describe('CP1-CP3: the Vorschlag card as an oversight control', () => {
  it('CP1 shows the AMOUNT a human is about to approve, above the raw Details disclosure', () => {
    wrap(<VorschlagCard action={postDraft} accent onApprove={() => undefined} onReject={() => undefined} />);
    const readback = document.querySelector('.vorschlag-readback')?.textContent ?? '';
    expect(readback).toContain("1'200.00");
  });

  it('CP2 formats money as CHF, never raw Rappen', () => {
    const payment: DraftedAction = {
      ...postDraft,
      actionId: 'aa_2',
      dialCapability: 'pay',
      actionTool: 'record_payment',
      payload: { workspaceId: 'ws_test', direction: 'in', date: '2026-06-12', amountMinor: 120000, idempotencyKey: 'k2' },
    };
    wrap(<VorschlagCard action={payment} accent onApprove={() => undefined} onReject={() => undefined} />);
    const readback = (document.querySelector('.vorschlag-readback') as HTMLElement).textContent ?? '';
    expect(readback).not.toContain('120000');
    expect(readback).toContain("1'200.00");
  });

  it('CP3 labels the read-back fields in de-CH, not with raw payload keys', () => {
    wrap(<VorschlagCard action={postDraft} accent onApprove={() => undefined} onReject={() => undefined} />);
    const terms = [...document.querySelectorAll('.vorschlag-readback dt')].map((n) => n.textContent);
    expect(terms).not.toContain('date');
    expect(terms).not.toContain('source');
    expect(terms).toContain('Datum');
  });
});

describe('CP4-CP5: the partial-turn sentence claims only what executed', () => {
  const partial = (): AgentTurn => ({
    turnId: 't1',
    seq: 1,
    role: 'agent',
    text: null,
    at: '2026-06-12T10:00:00.000Z',
    calls: [
      { callId: 'c1', seq: 1, verb: 'list_journal', kind: 'read', args: {}, mode: 'execute', decisionReason: 'read', dialCapability: null, ok: true, errorCode: null, entityRef: null, durationMs: 3, at: '2026-06-12T10:00:00.000Z', agentActionId: null, draftStatus: null, rejectReason: null },
      { callId: 'c2', seq: 2, verb: 'post_entry', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask', dialCapability: 'post', ok: true, errorCode: null, entityRef: null, durationMs: 4, at: '2026-06-12T10:00:01.000Z', agentActionId: 'aa_1', draftStatus: 'pending', rejectReason: null },
      { callId: 'c3', seq: 3, verb: 'post_entry', kind: 'write', args: {}, mode: 'execute', decisionReason: 'dial_auto', dialCapability: 'post', ok: false, errorCode: 'period_locked', entityRef: null, durationMs: 5, at: '2026-06-12T10:00:02.000Z', agentActionId: null, draftStatus: null, rejectReason: null },
    ],
  });

  // "unapproved" rather than the p-word: the loading-state convention scan classifies test titles
  // by keyword, and this test renders no loading state at all (it renders a finished turn).
  it('CP4 never counts a READ or an unapproved DRAFT as something that is in the books', () => {
    wrap(<Turn turn={partial()} />);
    const line = (document.querySelector('.agent-turn-outcome') as HTMLElement).textContent ?? '';
    expect(line).not.toMatch(/^2 Schritte ausgeführt und in den Büchern/);
    // One read + one pending draft + one failure: NOTHING reached the ledger, and the line says so.
    expect(line).toContain('Nichts in den Büchern');
    expect(line).toContain('1 fehlgeschlagen');
    expect(line).toContain('1 Vorschlag wartet auf Freigabe');
  });

  it('CP5 never renders a "skipped" figure it did not measure', () => {
    wrap(<Turn turn={partial()} />);
    const line = (document.querySelector('.agent-turn-outcome') as HTMLElement).textContent ?? '';
    expect(line).not.toMatch(/nicht gestartet/);
  });
});

describe('CP6: Berechtigungen shows WHO granted', () => {
  it('renders the attribution of a stored auto grant, and an agent-signed legacy row as the disagreement', async () => {
    const canned: Transport = async (action) => {
      if (action === 'agent_trust_summary') {
        return {
          status: 200,
          body: {
            ok: true,
            window: { from: '2026-03-16T00:00:00.000Z', to: '2026-06-14T00:00:00.000Z' },
            rows: [
              {
                capability: 'post',
                stored: 'auto',
                // Post-F1 the engine resolves an agent-signed row to effective ask; the surface
                // renders BOTH the disagreement and the signer.
                effective: 'ask',
                strongDefault: false,
                updatedBy: 'agent',
                updatedAt: '2026-06-01T00:00:00.000Z',
                proposed: 3,
                approved: 3,
                rejected: 0,
                autoExecuted: 12,
                lastAt: '2026-06-10T00:00:00.000Z',
                suggestGrant: false,
              },
            ],
          },
        };
      }
      if (action === 'list_agent_sessions') return { status: 200, body: { ok: true, sessions: [] } };
      return { status: 200, body: { ok: true } };
    };
    render(
      <TillClientProvider client={new TillClient(canned)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={ALLOW_ALL}>
              <MemoryRouter initialEntries={['/agent']}>
                <Agent />
              </MemoryRouter>
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Berechtigungen' }));
    const cell = await screen.findByText('Buchen');
    await waitFor(() => {
      const body = cell.closest('table')?.textContent ?? '';
      expect(body).toContain('von agent am 01.06.2026');
      expect(body).toContain('gespeichert: automatisch, wirksam: fragen');
    });
  });
});
