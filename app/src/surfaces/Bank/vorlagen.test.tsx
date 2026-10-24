/**
 * D176 (A39 §15.4): Vorlagen, "Nicht buchen" and the next step on /bank, against a fake engine at the
 * transport boundary the other Bank suites mock.
 *
 * What is asserted:
 *   - a `rule_ignore` proposal reads "Nicht buchen: <Grund>" with the ★, its button is the secondary
 *     "Nicht buchen" (never the accent money commit), and it calls `ignore_bank_line` with the rule's
 *     reason, note and id, never `book_bank_line`;
 *   - under `bank.buchungsregel_ignore_mode` = `bulk` (a `sure` ignore proposal) the bulk button ignores the
 *     line the same way;
 *   - a complete rule that names a next step is booked as its RULE target, so the decision keeps the rule;
 *   - a decided line whose rule names a next step links "Nächster Schritt: «Vorlage»" to the composer;
 *   - the rules sheet groups "Bankzeilen" and "Vorlagen"; "Neue Vorlage" saves a manual Vorlage (sides,
 *     the rest, "gleicher Betrag wie") with no bank line; Bearbeiten saves "Nicht buchen" with its reason
 *     and a "Nächster Schritt", by the rule's id.
 *
 * Every name and figure is invented for this file.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
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

function recording(canned: Canned): { transport: Transport; calls: { action: string; input: Record<string, unknown> }[] } {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    transport: async (action, input) => {
      calls.push({ action, input });
      const entry = canned[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    },
  };
}

function account(number: string) {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}

const BANK_LEDGER = account('1020');
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };
const TAX = [{ code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz', formLine: '303', active: true }];
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
  bankBalanceMinor: 510_000,
  ledgerBalanceMinor: 500_000,
  openCount: 1,
  openSumMinor: 10_000,
  differenceMinor: 0,
};

function line(id: string, over: Record<string, unknown>) {
  return {
    attention: 'needs',
    receiptCount: 0,
    needsReceipt: false,
    bankTxnId: id,
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-10-14',
    valueDate: '2026-10-14',
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    amountMinor: -4_300,
    counterparty: { name: 'Fernmeldedienst Beispiel AG', iban: null },
    remittance: { text: 'RECHNUNG 10/2026', referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    standardId: null,
    ruleIds: [],
    followUp: null,
    ...over,
  };
}

/** A "Nicht buchen" rule for the telecom provider: the card statement books it elsewhere. */
const RULE_IGNORE = {
  id: 'br_ig',
  scope: 'bank',
  outcome: 'ignore',
  counterpartyKey: 'name:fernmeldedienst beispiel',
  counterpartyLabel: 'Fernmeldedienst Beispiel AG',
  direction: 'out',
  label: 'Telefon über Karte',
  matchText: null,
  viaAccountId: null,
  viaAccountNumber: null,
  viaAccountName: null,
  legs: [],
  invalidReason: null,
  ignoreReason: 'booked_elsewhere',
  ignoreNote: 'läuft über die Kreditkarte',
  followUpStandardId: null,
  followUpLabel: null,
  accountId: null,
  accountNumber: null,
  accountName: null,
  taxCode: null,
  setBy: 'studio',
  setAt: '2026-10-01T08:00:00Z',
};
/** A manual Vorlage: the month entry of an invented course platform. */
const VORLAGE = {
  ...RULE_IGNORE,
  id: 'br_v',
  scope: 'manual',
  outcome: 'legs',
  counterpartyKey: null,
  counterpartyLabel: null,
  direction: null,
  label: 'Monatsumsatz',
  ignoreReason: null,
  ignoreNote: null,
  legs: [
    { accountId: account('1060'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Bruttoumsatz' }, accountNumber: '1060', accountName: '' },
    { accountId: account('3400'), taxCode: 'UST81', side: 'credit', amount: { kind: 'same', legIndex: 0 }, accountNumber: '3400', accountName: '' },
    { accountId: account('4400'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Coach-Anteil' }, accountNumber: '4400', accountName: '' },
    { accountId: account('1060'), taxCode: null, side: 'credit', amount: { kind: 'rest' }, accountNumber: '1060', accountName: '' },
  ],
  accountId: account('1060'),
};
/** A complete bank rule for the course platform's payout, naming the Vorlage as its next step. */
const RULE_NEXT = {
  ...RULE_IGNORE,
  id: 'br_n',
  outcome: 'legs',
  counterpartyKey: 'name:kursplattform beispiel',
  counterpartyLabel: 'Kursplattform Beispiel Ltd',
  direction: 'in',
  label: 'Kursplattform',
  ignoreReason: null,
  ignoreNote: null,
  legs: [{ accountId: account('1060'), taxCode: null, amount: { kind: 'rest' }, accountNumber: '1060', accountName: '' }],
  followUpStandardId: 'br_v',
  followUpLabel: 'Monatsumsatz',
  accountId: account('1060'),
};

const IGNORING = line('bt_ig', {
  standardId: 'br_ig',
  ruleIds: ['br_ig'],
  proposal: {
    target: { kind: 'ignore', reason: 'booked_elsewhere', note: 'läuft über die Kreditkarte', standardId: 'br_ig' },
    certainty: 'check',
    reasonCode: 'rule_ignore',
    reasonParams: { standardId: 'br_ig', reason: 'booked_elsewhere', note: 'läuft über die Kreditkarte' },
    vatCode: null,
  },
});

const PAYOUT = line('bt_pay', {
  creditDebit: 'CRDT',
  amountMinor: 3_000,
  counterparty: { name: 'Kursplattform Beispiel Ltd', iban: null },
  remittance: { text: 'AUSZAHLUNG 10/2026', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  standardId: 'br_n',
  ruleIds: ['br_n'],
  attention: 'sure',
  proposal: {
    target: { kind: 'accounts', legs: [{ accountId: account('1060'), amountMinor: 3_000 }] },
    certainty: 'sure',
    reasonCode: 'standard',
    reasonParams: { standardId: 'br_n', accountId: account('1060'), taxCode: null },
    vatCode: null,
  },
});

function inboxFor(lines: unknown[]): Handler {
  return (input) => {
    const mine = lines.filter((l) => (l as { state: string }).state === input.status);
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
  };
}

function happy(extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inboxFor([IGNORING]),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: TAX }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [RULE_IGNORE, VORLAGE, RULE_NEXT] }),
    compose_entry: composeEngine(),
    ...extra,
  };
}

function renderBank(transport: Transport, path = '/bank') {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[path]}>
            <Bank />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

async function findRow(name: RegExp): Promise<HTMLElement> {
  await screen.findAllByRole('row', { name });
  const row = screen.getAllByRole('row', { name }).find((r) => r.classList.contains('bank-row'));
  if (row === undefined) throw new Error(`no bank row named ${String(name)}`);
  return row;
}

describe('D176: the "Nicht buchen" proposal on a bank row', () => {
  it('reads "Nicht buchen: <Grund>", its button is the secondary "Nicht buchen", and it calls ignore_bank_line with the rule', async () => {
    const { transport, calls } = recording(happy({ ignore_bank_line: ok({ bankTxnId: 'bt_ig', state: 'ignored', linkId: 'lk_1', reason: 'booked_elsewhere', alreadyIgnored: false }) }));
    renderBank(transport);
    const row = await findRow(/Fernmeldedienst Beispiel AG/);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Buchen auf, Fernmeldedienst Beispiel AG/ })).toHaveTextContent('Nicht buchen: Wird anderswo gebucht'));
    const act = within(row).getByRole('button', { name: 'Nicht buchen' });
    expect(act).not.toHaveAttribute('data-money-commit');
    expect(act.className).toContain('btn--secondary');
    await userEvent.click(act);
    await waitFor(() => expect(calls.some((c) => c.action === 'ignore_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'ignore_bank_line')?.input).toMatchObject({
      workspaceId: 'ws_test',
      bankTxnId: 'bt_ig',
      reason: 'booked_elsewhere',
      note: 'läuft über die Kreditkarte',
      standardId: 'br_ig',
    });
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });

  it('under the bulk setting (a sure ignore proposal) the bulk button ignores the line with the rule, it books nothing', async () => {
    const sure = { ...IGNORING, attention: 'sure', proposal: { ...(IGNORING.proposal as unknown as Record<string, unknown>), certainty: 'sure' } };
    const second = { ...sure, bankTxnId: 'bt_ig2', amountMinor: -2_150 };
    const { transport, calls } = recording(
      happy({ list_bank_inbox: inboxFor([sure, second]), ignore_bank_line: (input) => ok({ bankTxnId: input.bankTxnId, state: 'ignored', linkId: 'lk_1', reason: 'booked_elsewhere', alreadyIgnored: false }) }),
    );
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: /Alle vorgeschlagenen buchen \(2\)/ }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'ignore_bank_line')).toHaveLength(2));
    for (const id of ['bt_ig', 'bt_ig2']) {
      expect(calls.find((c) => c.action === 'ignore_bank_line' && c.input.bankTxnId === id)?.input).toMatchObject({ reason: 'booked_elsewhere', note: 'läuft über die Kreditkarte', standardId: 'br_ig' });
    }
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });
});

describe('D176: a "Nicht buchen" rule in the chooser', () => {
  it('picking it from several rules turns the row into its ignore, decided by ignore_bank_line', async () => {
    const booking = { ...RULE_NEXT, id: 'br_b', counterpartyKey: RULE_IGNORE.counterpartyKey, counterpartyLabel: RULE_IGNORE.counterpartyLabel, direction: 'out', label: 'Telefon buchen', followUpStandardId: null, followUpLabel: null };
    const choosing = line('bt_ch', {
      standardId: 'br_ig',
      ruleIds: ['br_ig', 'br_b'],
      proposal: { target: null, certainty: 'check', reasonCode: 'several_rules', reasonParams: { standardIds: ['br_ig', 'br_b'] }, vatCode: null },
    });
    const { transport, calls } = recording(
      happy({
        list_bank_inbox: inboxFor([choosing]),
        list_bank_standards: ok({ standards: [RULE_IGNORE, booking] }),
        ignore_bank_line: ok({ bankTxnId: 'bt_ch', state: 'ignored', linkId: 'lk_2', reason: 'booked_elsewhere', alreadyIgnored: false }),
      }),
    );
    renderBank(transport);
    const row = await findRow(/Fernmeldedienst Beispiel AG/);
    await userEvent.click(await within(row).findByRole('button', { name: /^Welche Buchungsregel, Fernmeldedienst Beispiel AG/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Telefon über Karte/ }));
    const act = await within(await findRow(/Fernmeldedienst Beispiel AG/)).findByRole('button', { name: 'Nicht buchen' });
    await userEvent.click(act);
    await waitFor(() => expect(calls.some((c) => c.action === 'ignore_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'ignore_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_ch', reason: 'booked_elsewhere', standardId: 'br_ig' });
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });
});

describe('D176: the next step', () => {
  it('a complete rule that names a next step is booked as its RULE target, so the decision keeps the rule', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([PAYOUT]), book_bank_line: ok({ state: 'booked', entryId: 'je_1', remainder: null, warnings: [] }) }));
    renderBank(transport);
    await findRow(/Kursplattform Beispiel Ltd/);
    await waitFor(async () => expect(within(await findRow(/Kursplattform Beispiel Ltd/)).getByRole('button', { name: 'Buchen' })).toBeEnabled());
    await userEvent.click(within(await findRow(/Kursplattform Beispiel Ltd/)).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_pay', target: { kind: 'rule', standardId: 'br_n', asks: {} } });
  });

  it('a decided line links "Nächster Schritt: «Monatsumsatz»" to the composer with that Vorlage and the line\'s date', async () => {
    const decision = { linkId: 'lk_7', targetKind: 'accounts', entryId: 'je_7', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-10-14T08:00:00Z', ruleId: 'br_n' };
    const booked = { ...PAYOUT, state: 'booked', attention: null, proposal: null, decision, followUp: { standardId: 'br_v', label: 'Monatsumsatz' } };
    const { transport } = recording(
      happy({
        list_bank_inbox: inboxFor([booked]),
        get_entry: ok({ entry: { id: 'je_7', date: '2026-10-14', description: 'Bank' }, lines: [{ account: BANK_LEDGER, debit: 3_000, credit: 0 }, { account: account('1060'), debit: 0, credit: 3_000 }] }),
      }),
    );
    renderBank(transport, '/bank?tab=booked');
    const row = await findRow(/Kursplattform Beispiel Ltd/);
    const link = await within(row).findByRole('link', { name: 'Nächster Schritt: «Monatsumsatz»' });
    expect(link).toHaveAttribute('href', '/journal?vorlage=br_v&date=2026-10-14');
  });
});

describe('D176: the rules sheet (Bankzeilen, Vorlagen)', () => {
  it('groups the rules, says an ignore rule and a Vorlage in words, and names a rule\'s next step', async () => {
    const { transport } = recording(happy());
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (3)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const bank = await within(sheet).findByRole('list', { name: 'Bankzeilen' });
    const manual = within(sheet).getByRole('list', { name: 'Vorlagen' });
    expect(within(bank).getByText('Telefon über Karte')).toBeInTheDocument();
    expect(within(bank).getByText('Nicht buchen: Wird anderswo gebucht')).toBeInTheDocument();
    expect(within(bank).getByText('Danach: Vorlage «Monatsumsatz»')).toBeInTheDocument();
    expect(within(manual).getByText('Monatsumsatz')).toBeInTheDocument();
    expect(within(manual).getByText('Vorlage für das Journal')).toBeInTheDocument();
    expect(within(manual).getByText(/^Haben 3400 Erlöse aus Dienstleistungen MWST 8.1 %: gleicher Betrag wie 1060 /)).toBeInTheDocument();
  });

  it('"Neue Vorlage" saves a manual Vorlage with its sides, the rest and a same amount, and no bank line', async () => {
    const { transport, calls } = recording(happy({ list_bank_standards: ok({ standards: [] }), set_bank_standard: ok({ standard: { id: 'br_new' }, supersededId: null, unchanged: false }) }));
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: /^Buchungsregeln/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    await userEvent.click(await within(sheet).findByRole('button', { name: 'Neue Vorlage' }));
    const form = within(sheet).getByRole('form', { name: 'Neue Vorlage' });
    const save = within(form).getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();
    expect(within(form).getByText('Gib der Vorlage einen Namen.')).toBeInTheDocument();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Barauslage');
    expect(within(form).getByText('Wähl für jede Position ein Konto.')).toBeInTheDocument();
    // Position 1: 6500 in Soll (asked), position 2: 1000 in Haben (the rest).
    await userEvent.click(within(form).getByRole('button', { name: /^Konto der Position 1/ }));
    await userEvent.keyboard('6500');
    await userEvent.click(await screen.findByRole('option', { name: /^6500/ }));
    await userEvent.click(within(form).getByRole('button', { name: /^Konto der Position 2/ }));
    await userEvent.keyboard('1000');
    await userEvent.click(await screen.findByRole('option', { name: /^1000/ }));
    expect(within(form).getByRole('radiogroup', { name: 'Soll oder Haben, Position 2' })).toBeInTheDocument();
    expect(within(within(form).getByRole('radiogroup', { name: 'Soll oder Haben, Position 2' })).getByRole('radio', { name: 'Haben' })).toBeChecked();
    // A third leg in Haben that takes the SAME amount as position 1.
    await userEvent.click(within(form).getByRole('button', { name: '+ Position' }));
    await userEvent.click(within(form).getByRole('button', { name: /^Konto der Position 3/ }));
    await userEvent.keyboard('1060');
    await userEvent.click(await screen.findByRole('option', { name: /^1060/ }));
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'Soll oder Haben, Position 3' })).getByRole('radio', { name: 'Haben' }));
    await userEvent.click(within(form).getByRole('combobox', { name: 'Gleicher Betrag wie, Position 3' }));
    await userEvent.click(await screen.findByRole('option', { name: /wie Position 1/ }));
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const sent = calls.find((c) => c.action === 'set_bank_standard')?.input ?? {};
    expect(sent).not.toHaveProperty('bankTxnId');
    expect(sent).not.toHaveProperty('standardId');
    expect(sent).toMatchObject({
      workspaceId: 'ws_test',
      scope: 'manual',
      label: 'Barauslage',
      legs: [
        { accountId: account('6500'), side: 'debit', amount: { kind: 'ask' } },
        { accountId: account('1000'), side: 'credit', amount: { kind: 'rest' } },
        { accountId: account('1060'), side: 'credit', amount: { kind: 'same', legIndex: 0 } },
      ],
    });
    expect(await within(sheet).findByText('Vorlage «Barauslage» gespeichert.')).toBeInTheDocument();
  });

  it('critic D176-C2, R2-1: a name another Vorlage holds is said at the name field; "Ersetzen" saves again naming that Vorlage', async () => {
    let sets = 0;
    const { transport, calls } = recording(
      happy({
        set_bank_standard: (input) => {
          sets += 1;
          return input.replaceStandardId === 'br_v'
            ? ok({ standard: { id: 'br_v2' }, supersededId: 'br_v', unchanged: false })
            : { status: 422, body: { ok: false, error: 'label_taken', standardId: 'br_v', label: 'Monatsumsatz' } };
        },
      }),
    );
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (3)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    await userEvent.click(await within(sheet).findByRole('button', { name: 'Neue Vorlage' }));
    const form = within(sheet).getByRole('form', { name: 'Neue Vorlage' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await userEvent.type(name, 'monatsumsatz');
    await userEvent.click(within(form).getByRole('button', { name: /^Konto der Position 1/ }));
    await userEvent.keyboard('6500');
    await userEvent.click(await screen.findByRole('option', { name: /^6500/ }));
    await userEvent.click(within(form).getByRole('button', { name: /^Konto der Position 2/ }));
    await userEvent.keyboard('1000');
    await userEvent.click(await screen.findByRole('option', { name: /^1000/ }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    const warning = await within(form).findByText('Eine Vorlage heisst schon «Monatsumsatz». Ersetzen oder anders nennen?');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name.getAttribute('aria-describedby')).toBe(warning.id);
    expect(name).toHaveValue('monatsumsatz');
    expect(calls.filter((c) => c.action === 'set_bank_standard')[0]?.input).not.toHaveProperty('replaceStandardId');
    await userEvent.click(within(form).getByRole('button', { name: 'Ersetzen' }));
    await waitFor(() => expect(sets).toBe(2));
    expect(calls.filter((c) => c.action === 'set_bank_standard')[1]?.input).toMatchObject({ scope: 'manual', label: 'monatsumsatz', replaceStandardId: 'br_v' });
    expect(await within(sheet).findByText('Vorlage «monatsumsatz» gespeichert.')).toBeInTheDocument();
  });

  it('Bearbeiten saves "Nicht buchen" with its reason and a "Nächster Schritt", by the rule\'s id', async () => {
    const { transport, calls } = recording(happy({ set_bank_standard: ok({ standard: { id: 'br_n2' }, supersededId: 'br_n', unchanged: false }) }));
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (3)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const item = (await within(sheet).findByText('Kursplattform')).closest('li') as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Bearbeiten' }));
    const form = within(item).getByRole('form', { name: 'Buchungsregel bearbeiten' });
    // The stored next step is preselected; switch the outcome to "Nicht buchen".
    expect(within(form).getByRole('combobox', { name: 'Nächster Schritt' })).toHaveTextContent('Monatsumsatz');
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'Was passiert mit diesen Zeilen?' })).getByRole('radio', { name: 'Nicht buchen' }));
    expect(within(form).queryByRole('radio', { name: /1060/ })).toBeNull();
    await userEvent.click(within(form).getByRole('combobox', { name: 'Grund' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Läuft über ein Durchlaufkonto' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Notiz für dich oder den Treuhänder' }), 'gesammelt im Monatsumsatz');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const sent = calls.find((c) => c.action === 'set_bank_standard')?.input ?? {};
    expect(sent).not.toHaveProperty('bankTxnId');
    expect(sent).not.toHaveProperty('legs');
    expect(sent).toMatchObject({
      standardId: 'br_n',
      outcome: 'ignore',
      ignoreReason: 'clearing_account',
      ignoreNote: 'gesammelt im Monatsumsatz',
      followUpStandardId: 'br_v',
    });
  });
});
