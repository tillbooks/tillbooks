/**
 * N00 (US-N00.4): the bank line Details show the house rule of the line's counterparty, asked of the engine
 * with the line's name and IBAN; nothing shows without a match, on a refusal, or without the read right.
 * Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { recordedOk } from '../../lib/test-support';
import { HouseRuleLine } from './HouseRuleLine';
import type { BankInboxLine } from './model';

const LINE = {
  bankTxnId: 'txn_1',
  counterparty: { name: 'Papeterie Lindengrund AG', iban: 'CH5604835012345678009' },
} as unknown as BankInboxLine;

function renderLine(answer: RestResponse, caps: Capabilities = ALLOW_ALL, line: BankInboxLine = LINE) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    return answer;
  };
  render(
    <MemoryRouter>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <CapabilitiesContext.Provider value={caps}>
            <HouseRuleLine line={line} workspaceId="ws_test" />
          </CapabilitiesContext.Provider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>,
  );
  return calls;
}

const notes = (texts: string[]): RestResponse => ({
  status: 200,
  body: recordedOk({ ok: true, notes: texts.map((text, i) => ({ id: `hbn_${i}`, text })), withheld: 0 }),
});

describe('HouseRuleLine (N00)', () => {
  it('shows the counterparty\'s note under "Hausregel", asked with the line\'s name and IBAN', async () => {
    const calls = renderLine(notes(['Lastschrift monatlich, Konto 6500.']));
    expect(await screen.findByRole('heading', { name: 'Hausregel' })).toBeInTheDocument();
    expect(screen.getByText('Lastschrift monatlich, Konto 6500.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Im Hausbuch öffnen' })).toHaveAttribute('href', '/hausbuch');
    expect(calls[0]).toEqual({
      action: 'hausbuch_notes',
      input: { workspaceId: 'ws_test', counterparty: { name: 'Papeterie Lindengrund AG', iban: 'CH5604835012345678009' } },
    });
  });

  it('shows nothing when no note matches, or the read is refused', async () => {
    const none = renderLine(notes([]));
    await waitFor(() => expect(none).toHaveLength(1));
    expect(screen.queryByRole('heading', { name: 'Hausregel' })).toBeNull();
  });

  it('a refusal shows nothing', async () => {
    const calls = renderLine({ status: 200, body: { ok: false, error: 'permission_denied', capability: 'read_sales' } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('heading', { name: 'Hausregel' })).toBeNull();
  });

  it('D188: a line the bank names nobody on asks by the line, so the engine keys its derived counterparty', async () => {
    const card = { bankTxnId: 'txn_9', counterparty: { name: null, iban: null }, derivedCounterparty: { kind: 'card', label: 'RENDER.COM' } } as unknown as BankInboxLine;
    const calls = renderLine(notes(['Hosting: 6570.']), ALLOW_ALL, card);
    expect(await screen.findByText('Hosting: 6570.')).toBeInTheDocument();
    expect(calls[0]).toEqual({ action: 'hausbuch_notes', input: { workspaceId: 'ws_test', counterparty: { bankTxnId: 'txn_9' } } });
  });

  it('without read_master_data it does not ask', async () => {
    const calls = renderLine(notes(['Nie sichtbar.']), { ...ALLOW_ALL, can: (c) => c !== 'read_master_data' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
    expect(screen.queryByText('Nie sichtbar.')).toBeNull();
  });
});
