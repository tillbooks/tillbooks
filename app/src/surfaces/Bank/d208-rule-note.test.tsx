/**
 * D208 point 8: the comment to the agent on a Buchungsregel, edited in Bank's rule sheet. A comment typed in the
 * RuleEditor is sent as `note` on `set_bank_standard`, and it is there again when the sheet is opened anew
 * (read back from `list_bank_standards`). An untouched comment is never sent.
 *
 * SYNTHETIC BY CONSTRUCTION: an invented counterparty; the accounts are the pinned `list_accounts` recording.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { PrefsProvider } from '../../lib/prefs';
import { legacyLayout } from './test-prefs';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { recordedOk } from '../../lib/test-support';
import Bank from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function account(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}

const BANK_LEDGER = account('1020');
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };
const SUMMARY = {
  bankAccountId: 'ba_1',
  name: 'Seeufer Geschäftskonto',
  iban: 'CH5604835012345678009',
  currency: 'CHF',
  ledgerAccountId: BANK_LEDGER,
  judgeable: true,
  reason: null,
  statementId: 'st_1',
  statementDate: '2026-10-14',
  bankBalanceMinor: 0,
  ledgerBalanceMinor: 0,
  openCount: 0,
  openSumMinor: 0,
  differenceMinor: 0,
};

/** A bank rule of an invented stationer, its comment as the engine stores it. */
function ruleWith(note: string | null) {
  return {
    id: 'br_p',
    scope: 'bank',
    outcome: 'legs',
    counterpartyKey: 'name:papeterie sonnhalde',
    counterpartyLabel: 'Papeterie Sonnhalde GmbH',
    direction: 'out',
    label: 'Papeterie',
    matchText: null,
    viaAccountId: null,
    viaAccountNumber: null,
    viaAccountName: null,
    legs: [{ accountId: account('6500'), taxCode: null, amount: { kind: 'rest' }, accountNumber: '6500', accountName: '' }],
    invalidReason: null,
    ignoreReason: null,
    ignoreNote: null,
    followUpStandardId: null,
    followUpLabel: null,
    accountId: account('6500'),
    accountNumber: '6500',
    accountName: '',
    taxCode: null,
    setBy: 'studio',
    setAt: '2026-10-01T08:00:00Z',
    note,
    noteSetBy: note === null ? null : 'studio',
    noteSetAt: note === null ? null : '2026-11-18T08:00:00Z',
    noteHistory: [],
  };
}

function world() {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  // The engine as a store: a save with a note is what the next read answers.
  let stored: string | null = null;
  const canned: Canned = {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: ok({ lines: [], nextCursor: null, total: 0, summary: [SUMMARY] }),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask' } }),
    list_bank_standards: () => ok({ standards: [ruleWith(stored)] }),
    set_bank_standard: (input) => {
      if (typeof input.note === 'string') stored = input.note;
      if (input.note === null) stored = null;
      return ok({ standard: ruleWith(stored), supersededId: null, unchanged: true, noteChanged: input.note !== undefined });
    },
    compose_entry: composeEngine(),
  };
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { transport, calls };
}

function renderBank(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <PrefsProvider store={legacyLayout()}>
            <MemoryRouter initialEntries={['/bank']}>
              <Bank />
            </MemoryRouter>
          </PrefsProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

async function openRuleForm(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
  const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
  const item = (await within(sheet).findByText('Papeterie')).closest('li') as HTMLElement;
  await userEvent.click(within(item).getByRole('button', { name: 'Bearbeiten' }));
  return within(item).getByRole('form', { name: 'Buchungsregel bearbeiten' });
}

describe('D208: the comment to the agent in the rule sheet', () => {
  it('a comment typed in the RuleEditor is sent as note and is there again when the sheet opens anew', async () => {
    const { transport, calls } = world();
    renderBank(transport);
    let form = await openRuleForm();
    const field = within(form).getByRole('textbox', { name: 'Kommentar an den Agenten' });
    expect(field).toHaveValue('');
    await userEvent.type(field, 'Nur Büromaterial.');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).toMatchObject({ standardId: 'br_p', note: 'Nur Büromaterial.' });
    // Close the sheet and open it again: the comment is read back from the engine.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Buchungsregeln' })).toBeNull());
    form = await openRuleForm();
    expect(within(form).getByRole('textbox', { name: 'Kommentar an den Agenten' })).toHaveValue('Nur Büromaterial.');
  });

  it('an untouched comment is never sent', async () => {
    const { transport, calls } = world();
    renderBank(transport);
    const form = await openRuleForm();
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).not.toHaveProperty('note');
  });
});
