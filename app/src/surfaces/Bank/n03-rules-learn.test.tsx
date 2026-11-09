/**
 * N03 (D183): Buchungsregeln that learn, on /bank, against a fake engine at the transport boundary.
 *
 *   - the rules sheet says each bank rule's track record (`bank_rule_stats`): "12× verwendet, zuletzt …,
 *     1× geändert", "Noch nie verwendet", a dash while it loads; "Regel anpassen?" opens the rule's form;
 *   - the form's "Testen" runs `backtest_bank_rule` with the rule as the form holds it and says the answer;
 *   - opened on a booked line, the sheet prefills a new rule from the booking (the backtest's recipe) and
 *     saves it with `fromBankTxnId`.
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
import { RulesSheet, type BookedLineRef } from './RulesSheet';
import { buildLookups } from './lookups';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Bank from './index';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function recording(canned: Record<string, RestResponse | Handler>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { calls, transport };
}

const CHART = [
  { id: 'acc_6570', number: '6570', name: 'Informatik, Software und Lizenzen', vatCodeDefault: null, type: 'expense' },
  { id: 'acc_6500', number: '6500', name: 'Verwaltungs- und Bürokosten', vatCodeDefault: null, type: 'expense' },
];
const LOOKUPS = buildLookups({ chart: CHART, taxCodes: [], invoices: [], bills: [], bankAccounts: [], vorschlaege: [], dial: null });

/** A complete one-leg bank rule for an invented telecom supplier. */
const RULE = {
  id: 'br_tel',
  scope: 'bank',
  outcome: 'legs',
  counterpartyKey: 'iban:CH4431999123000889012',
  counterpartyLabel: 'Fernmeldewerk Beispiel AG',
  direction: 'out',
  label: 'Telefon',
  matchText: null,
  viaAccountId: null,
  viaAccountNumber: null,
  viaAccountName: null,
  legs: [{ accountId: 'acc_6570', taxCode: null, amount: { kind: 'rest' }, accountNumber: '6570', accountName: 'Informatik, Software und Lizenzen' }],
  invalidReason: null,
  ignoreReason: null,
  ignoreNote: null,
  followUpStandardId: null,
  followUpLabel: null,
  accountId: 'acc_6570',
  accountNumber: '6570',
  accountName: 'Informatik, Software und Lizenzen',
  taxCode: null,
  setBy: 'studio',
  setAt: '2026-10-01T08:00:00Z',
};
const NEW_RULE = { ...RULE, id: 'br_new', label: 'Neue Regel', counterpartyLabel: 'Druckhaus Muster GmbH' };

const STATS = (over: Record<string, unknown> = {}) => ({
  standardId: 'br_tel',
  versionIds: ['br_tel'],
  uses: 12,
  lastUsedAt: '2026-10-28T09:00:00.000Z',
  changed: 1,
  lastFive: { uses: 5, changed: 0 },
  currentVersion: { uses: 12, changed: 1 },
  health: 'ok',
  ...over,
});

function renderSheet(transport: Transport, fromBookedLine: BookedLineRef | null = null) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <MemoryRouter>
          <RulesSheet open workspaceId="ws_test" lookups={LOOKUPS} currency="CHF" canEdit onClose={() => {}} onChanged={() => {}} fromBookedLine={fromBookedLine} />
        </MemoryRouter>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('N03: the rules sheet says each rule\'s track record', () => {
  it('shows uses, the last use and the changes; a dash while the record loads', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { transport } = recording({
      list_bank_standards: ok({ standards: [RULE] }),
      bank_rule_stats: async () => {
        await gate;
        return ok({ stats: [STATS()], healthThreshold: 2 });
      },
    });
    renderSheet(transport);
    const item = await screen.findByText('Telefon');
    const li = item.closest('li') as HTMLElement;
    expect(within(li).getByText('–')).toBeInTheDocument();
    release();
    expect(await within(li).findByText('12× verwendet, zuletzt 28.10.2026, 1× geändert')).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: 'Regel anpassen?' })).toBeNull();
  });

  it('a rule never used says so; a rule changed too often asks "Regel anpassen?", which opens its form', async () => {
    const { transport } = recording({
      list_bank_standards: ok({ standards: [RULE, NEW_RULE] }),
      bank_rule_stats: ok({
        stats: [STATS({ uses: 5, changed: 3, lastFive: { uses: 5, changed: 3 }, health: 'adjust' }), STATS({ standardId: 'br_new', uses: 0, lastUsedAt: null, changed: 0, lastFive: { uses: 0, changed: 0 } })],
        healthThreshold: 2,
      }),
    });
    renderSheet(transport);
    const fresh = (await screen.findByText('Neue Regel')).closest('li') as HTMLElement;
    expect(await within(fresh).findByText('Noch nie verwendet')).toBeInTheDocument();
    const tel = screen.getByText('Telefon').closest('li') as HTMLElement;
    const health = await within(tel).findByRole('button', { name: 'Regel anpassen?' });
    expect(health).toHaveAttribute('title', '3 der letzten 5 Vorschläge dieser Regel hast du vor dem Buchen geändert.');
    await userEvent.click(health);
    expect(await within(tel).findByRole('button', { name: 'Speichern' })).toBeInTheDocument();
  });
});

describe('N03: "Testen" in the rule form', () => {
  it('runs backtest_bank_rule with the rule as the form holds it and says the answer in one line', async () => {
    const { transport, calls } = recording({
      list_bank_standards: ok({ standards: [RULE] }),
      bank_rule_stats: ok({ stats: [STATS()], healthThreshold: 2 }),
      backtest_bank_rule: ok({ since: '2026-01-01', counterpartyKey: RULE.counterpartyKey, direction: 'out', matchText: null, hits: 14, identical: 13, openLines: 2, ignoredLines: 0, lines: [], recipe: { legs: RULE.legs, viaAccountId: null, matchText: null } }),
    });
    renderSheet(transport);
    const tel = (await screen.findByText('Telefon')).closest('li') as HTMLElement;
    await userEvent.click(within(tel).getByRole('button', { name: 'Bearbeiten' }));
    await userEvent.click(await within(tel).findByRole('button', { name: 'Testen' }));
    expect(await within(tel).findByText('Seit 01.01.2026: 14 Zeilen, 13 genau so gebucht')).toBeInTheDocument();
    const test = calls.find((c) => c.action === 'backtest_bank_rule');
    expect(test?.input).toMatchObject({ workspaceId: 'ws_test', recipe: { standardId: 'br_tel', legs: [{ accountId: 'acc_6570', amount: { kind: 'rest' } }], matchText: null, viaAccountId: null } });
    expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(false);
  });

  it('no hits says "Keine Treffer seit …"', async () => {
    const { transport } = recording({
      list_bank_standards: ok({ standards: [RULE] }),
      bank_rule_stats: ok({ stats: [STATS()], healthThreshold: 2 }),
      backtest_bank_rule: ok({ since: '2025-11-02', counterpartyKey: RULE.counterpartyKey, direction: 'out', matchText: null, hits: 0, identical: 0, openLines: 0, ignoredLines: 0, lines: [], recipe: { legs: RULE.legs, viaAccountId: null, matchText: null } }),
    });
    renderSheet(transport);
    const tel = (await screen.findByText('Telefon')).closest('li') as HTMLElement;
    await userEvent.click(within(tel).getByRole('button', { name: 'Bearbeiten' }));
    await userEvent.click(await within(tel).findByRole('button', { name: 'Testen' }));
    expect(await within(tel).findByText('Keine Treffer seit 02.11.2025')).toBeInTheDocument();
  });
});

describe('N03: a rule saved from a booked line', () => {
  it('prefills the booking\'s legs and saves with fromBankTxnId', async () => {
    const { transport, calls } = recording({
      list_bank_standards: ok({ standards: [] }),
      bank_rule_stats: ok({ stats: [], healthThreshold: 2 }),
      backtest_bank_rule: ok({
        since: '2025-11-02',
        counterpartyKey: 'iban:CH5604835012345678009',
        direction: 'out',
        matchText: null,
        hits: 3,
        identical: 3,
        openLines: 0,
        ignoredLines: 0,
        lines: [],
        recipe: { legs: [{ accountId: 'acc_6570', taxCode: null, amount: { kind: 'rest' } }, { accountId: 'acc_6500', taxCode: null, amount: { kind: 'ask', label: 'Porto' } }], viaAccountId: null, matchText: null },
      }),
      set_bank_standard: ok({ standard: NEW_RULE, supersededId: null, unchanged: false }),
    });
    renderSheet(transport, { bankTxnId: 'bt_booked', party: 'Druckhaus Muster GmbH', direction: 'out', amountMinor: -5405 });
    const group = await screen.findByRole('region', { name: 'Regel aus dieser Buchung' });
    const save = await within(group).findByRole('button', { name: 'Speichern' });
    expect(calls.find((c) => c.action === 'backtest_bank_rule')?.input).toMatchObject({ recipe: { fromBankTxnId: 'bt_booked' } });
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const saved = calls.find((c) => c.action === 'set_bank_standard')?.input ?? {};
    expect(saved).toMatchObject({
      workspaceId: 'ws_test',
      fromBankTxnId: 'bt_booked',
      label: 'Druckhaus Muster GmbH',
      legs: [
        { accountId: 'acc_6570', amount: { kind: 'rest' } },
        { accountId: 'acc_6500', amount: { kind: 'ask', label: 'Porto' } },
      ],
    });
    expect(saved).not.toHaveProperty('bankTxnId');
  });
});

// --- The Details panel of a booked line (the whole /bank, against the same kind of fake engine) -----------

const RIGHTS = ['read_sales', 'post', 'pay', 'manage_files', 'read_master_data', 'read_file_content', 'manage_agent_dial', 'read_books', 'read_vat'];
const caps = {
  whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: RIGHTS },
  can: (c: string) => RIGHTS.includes(c),
  refresh: () => undefined,
} as unknown as Capabilities;
const BANK_LEDGER = (listAccountsFixture.accounts.find((a) => a.number === '1020') as { id: string }).id;
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };
const SUMMARY = {
  bankAccountId: 'ba_1',
  name: ACCOUNT.name,
  iban: ACCOUNT.iban,
  currency: 'CHF',
  ledgerAccountId: BANK_LEDGER,
  judgeable: false,
  reason: 'no_statement',
  statementId: 'st_1',
  statementDate: '2026-10-14',
  bankBalanceMinor: null,
  ledgerBalanceMinor: null,
  openCount: 0,
  openSumMinor: 0,
  differenceMinor: null,
};

function bookedLine(id: string, decision: Record<string, unknown>) {
  return {
    attention: 'needs',
    receiptCount: 0,
    needsReceipt: false,
    bankTxnId: id,
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'booked',
    bookingDate: '2026-10-14',
    valueDate: '2026-10-14',
    amountMinor: -8_990,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: 'Fernmeldewerk Beispiel AG', iban: 'CH4431999123000889012' },
    remittance: { text: 'ABO OKTOBER', referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: {
      linkId: `lk_${id}`,
      targetKind: 'accounts',
      entryId: `je_${id}`,
      paymentId: null,
      ignoreReason: null,
      note: null,
      remainderMode: null,
      remainderMinor: null,
      differenceMinor: null,
      decidedBy: 'studio',
      decidedAt: '2026-10-15T08:00:00Z',
      ruleId: null,
      ...decision,
    },
    proposal: null,
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
  };
}

function bankEngine(lines: unknown[], extra: Record<string, RestResponse | Handler> = {}) {
  return recording({
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: (input) => {
      const mine = lines.filter((l) => (l as { state: string }).state === input.status || input.status === 'all');
      return ok({ lines: mine, nextCursor: null, total: mine.length, directionCounts: { in: 0, out: mine.length }, summary: [SUMMARY] });
    },
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [RULE] }),
    list_payment_batches: ok({ batches: [] }),
    get_entry: ok({ entry: { id: 'je_x', date: '2026-10-14', description: 'Abo', number: '12' }, lines: [] }),
    bank_rule_stats: ok({ stats: [], healthThreshold: 2 }),
    backtest_bank_rule: ok({
      since: '2025-11-02',
      counterpartyKey: 'iban:CH4431999123000889012',
      direction: 'out',
      matchText: null,
      hits: 1,
      identical: 1,
      openLines: 0,
      ignoredLines: 0,
      lines: [],
      recipe: { legs: RULE.legs, viaAccountId: null, matchText: null },
    }),
    ...extra,
  });
}

function renderBank(transport: Transport, path = '/bank?tab=booked') {
  const store = new PrefsStore(null, null, { useCache: false });
  return render(
    <CapabilitiesContext.Provider value={caps}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={store}>
              <MemoryRouter initialEntries={[path]}>
                <Bank />
              </MemoryRouter>
            </PrefsProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

async function openLine(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  const row = document.querySelector<HTMLElement>(`tr.bank-row[data-line="${id}"]`) as HTMLElement;
  await userEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement);
  await waitFor(() => expect(document.querySelector(`[data-area-for="${id}"]`)).not.toBeNull());
  return document.querySelector('.bank-area') as HTMLElement;
}

describe('N03: "Als Regel speichern" on a booked line', () => {
  it('a line booked to accounts offers it, and it opens the rules sheet prefilled from the booking', async () => {
    const { transport, calls } = bankEngine([bookedLine('bt_1', {})]);
    renderBank(transport);
    const area = await openLine('bt_1');
    await userEvent.click(await within(area).findByRole('button', { name: 'Als Regel speichern' }));
    expect(await screen.findByRole('region', { name: 'Regel aus dieser Buchung' })).toBeInTheDocument();
    await waitFor(() => expect(calls.find((c) => c.action === 'backtest_bank_rule')?.input).toMatchObject({ recipe: { fromBankTxnId: 'bt_1' } }));
  });

  it('a line booked as its live rule proposed it says "Bereits durch Regel" instead', async () => {
    const { transport } = bankEngine([bookedLine('bt_2', { proposedRuleId: 'br_tel', ruleChanged: false })]);
    renderBank(transport);
    const area = await openLine('bt_2');
    expect(await within(area).findByRole('button', { name: 'Bereits durch Regel «Telefon» gebucht' })).toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: 'Als Regel speichern' })).toBeNull();
  });

  it('a changed booking of the rule offers saving a new rule', async () => {
    const { transport } = bankEngine([bookedLine('bt_3', { proposedRuleId: 'br_tel', ruleChanged: true })]);
    renderBank(transport);
    const area = await openLine('bt_3');
    expect(await within(area).findByRole('button', { name: 'Als Regel speichern' })).toBeInTheDocument();
  });

  it("Pendenzen's Anpassen link (?rule=save) opens the sheet on the line once it is listed", async () => {
    const { transport, calls } = bankEngine([bookedLine('bt_4', {})]);
    renderBank(transport, '/bank?tab=booked&line=bt_4&rule=save');
    expect(await screen.findByRole('region', { name: 'Regel aus dieser Buchung' })).toBeInTheDocument();
    await waitFor(() => expect(calls.find((c) => c.action === 'backtest_bank_rule')?.input).toMatchObject({ recipe: { fromBankTxnId: 'bt_4' } }));
  });
});
