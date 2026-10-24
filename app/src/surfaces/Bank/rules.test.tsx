/**
 * D175 (A39 §14.5, §14.6): Buchungsregeln on /bank, against a fake engine at the transport boundary the
 * other Bank suites mock.
 *
 * What is asserted, and which story row of §14.6 it carries:
 *   - 3: a rule that asks shows a labelled money field; Buchen books only once the ask is a positive
 *     number, with the RULE target, and the preview is `compose_entry` for that same target;
 *   - 3e: the engine's `rest_is_zero` is said on the row, Buchen waits, the typed amount stays;
 *   - 4, 12: `several_rules` shows the chooser (the matching rules by name and "Anders buchen", nothing
 *     else); picking a rule turns the row into the one-candidate case; "Anders buchen" opens the list;
 *   - 1, 1e: ☆ on a split draft opens the rule form; Speichern waits, with its reason, until a rest is
 *     chosen; the write is `set_bank_standard` with the recipe, the name and the text;
 *   - 1f: the Durchlaufkonto picker offers balance accounts only (no bank, VAT, control, income or
 *     expense account) and the route rides on the rule;
 *   - a failed save keeps every input and says why in words;
 *   - 5, 8: the "Buchungsregeln" sheet: empty state, the list with its route and an invalid rule's
 *     reason in words, Bearbeiten (supersede), Entfernen behind a confirm, and its loading skeleton.
 *
 * Every name, IBAN and figure is invented for this file.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import { recordedOk } from '../../lib/test-support';
import Bank from './index';
import { PrefsProvider } from '../../lib/prefs';
import { dockedRight } from './test-prefs';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';

/**
 * UX judge round 2, item 12: a line's Buchen. One per line on screen: the row's, or, while the Details
 * panel beside the table shows the line, the panel's (the row's steps aside).
 */
function bookOf(row: HTMLElement): HTMLElement {
  const own = within(row).queryByRole('button', { name: 'Buchen' });
  if (own !== null) return own;
  const id = row.dataset.line;
  const body = Array.from(document.querySelectorAll<HTMLElement>('[data-panel-for]')).find((b) => id !== undefined && b.dataset.panelFor === id);
  return within(body ?? row).getByRole('button', { name: 'Buchen' });
}

/**
 * UX judge round 2, item 5: the field carries no clear ×; "Auswahl entfernen" in its own list takes the
 * line back to "Worauf buchen?".
 */
async function clearTarget(row: HTMLElement, party: string): Promise<void> {
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(`^Buchen auf, ${party}`) }));
  await userEvent.click(await screen.findByRole('option', { name: /Auswahl entfernen/ }));
}

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

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
const TAX = [
  { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz', formLine: '303', active: true },
  { code: 'VST-M', kind: 'input', rateBp: 810, label: 'Vorsteuer Material, Waren, Dienstleistungen', formLine: '400', active: true },
];
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
    creditDebit: 'CRDT',
    reversal: false,
    amountMinor: 10_000,
    counterparty: { name: 'Seeblick Akademie AG', iban: null },
    remittance: { text: 'KURSE AUSZAHLUNG 2026-10', referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    standardId: null,
    ruleIds: [],
    ...over,
  };
}

/** A rule routed through 1060 that asks for the gross revenue and leaves the fee as the rest. */
const RULE_ASK = {
  id: 'br_1',
  counterpartyKey: 'name:seeblick akademie ag',
  counterpartyLabel: 'Seeblick Akademie AG',
  direction: 'in',
  label: 'Seeblick Kurse',
  matchText: 'KURSE',
  viaAccountId: account('1060'),
  viaAccountNumber: '1060',
  viaAccountName: 'Kurzfristig gehaltene Wertpapiere',
  legs: [
    { accountId: account('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' }, accountNumber: '3400', accountName: 'Erlöse aus Dienstleistungen' },
    { accountId: account('4400'), taxCode: null, amount: { kind: 'rest' }, accountNumber: '4400', accountName: 'Bezogene Fremdleistungen' },
  ],
  invalidReason: null,
  accountId: account('4400'),
  accountNumber: '4400',
  accountName: 'Bezogene Fremdleistungen',
  taxCode: null,
  setBy: 'studio',
  setAt: '2026-10-01T08:00:00Z',
};
/** A complete one-leg rule for the same payer, a different text. */
const RULE_SHOP = {
  ...RULE_ASK,
  id: 'br_2',
  label: 'Seeblick Shop',
  matchText: 'SHOP',
  viaAccountId: null,
  viaAccountNumber: null,
  legs: [{ accountId: account('3200'), taxCode: null, amount: { kind: 'rest' }, accountNumber: '3200', accountName: 'Erlöse aus Handelswaren' }],
  accountId: account('3200'),
  accountNumber: '3200',
  accountName: 'Erlöse aus Handelswaren',
};
/** A rule gone quiet: its account is archived. */
const RULE_QUIET = {
  ...RULE_SHOP,
  id: 'br_3',
  counterpartyKey: 'name:hafenbuero gmbh',
  counterpartyLabel: 'Hafenbüro GmbH',
  direction: 'out',
  label: null,
  matchText: null,
  legs: [{ accountId: account('6500'), taxCode: null, amount: { kind: 'rest' }, accountNumber: '6500', accountName: 'Verwaltungs- und Bürokosten' }],
  accountId: account('6500'),
  accountNumber: '6500',
  invalidReason: 'account_archived',
};

/** The rule proposal of story 3: one candidate, one asked amount, not bookable until it is typed. */
const ASKING = line('bt_ask', {
  standardId: 'br_1',
  ruleIds: ['br_1', 'br_2'],
  proposal: {
    target: { kind: 'rule', standardId: 'br_1', asks: {} },
    certainty: 'check',
    reasonCode: 'rule_needs_amount',
    reasonParams: { standardId: 'br_1', asks: [{ legIndex: 0, label: 'Bruttoumsatz' }] },
    vatCode: null,
  },
});

/** Story 4: two rules for one payer, and the text decides nothing. */
const CHOOSING = line('bt_choose', {
  remittance: { text: 'GUTSCHRIFT 2026-10', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  standardId: 'br_1',
  ruleIds: ['br_1', 'br_2'],
  proposal: { target: null, certainty: 'check', reasonCode: 'several_rules', reasonParams: { standardIds: ['br_1', 'br_2'] }, vatCode: null },
});

/** A split an agent drafted (3400 gross, 4400 against the line): the row's draft has two legs. */
const SPLIT = line('bt_split', {
  proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
});
const SPLIT_VORSCHLAG = {
  actionId: 'act_9',
  status: 'pending',
  actor: 'till-cli',
  actionTool: 'book_bank_line',
  dialCapability: 'post',
  createdAt: '2026-10-14T09:00:00Z',
  payload: {
    workspaceId: 'ws_test',
    bankTxnId: 'bt_split',
    target: {
      kind: 'accounts',
      legs: [
        { accountId: account('3400'), amountMinor: 12_000, taxCode: 'UST81' },
        { accountId: account('4400'), amountMinor: -2_000 },
      ],
    },
  },
};

function inboxFor(lines: unknown[]): Handler {
  return (input) => {
    const mine = lines.filter((l) => (l as { state: string }).state === input.status);
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
  };
}

/**
 * `compose_entry`: a request with a TARGET (a rule, a via route) gets a synthetic answer, balanced and
 * routed through 1060 in and out; an intent request (the strip's plain MWST split) goes to the real engine.
 */
function composeFake(onTarget: Handler = () => ok(VIA_ANSWER)): Handler {
  const engine = composeEngine();
  return (input) => (input.target !== undefined ? onTarget(input) : engine(input));
}
const VIA_ANSWER = {
  mode: 'expand',
  composed: true,
  stamped: true,
  lines: [
    { account: BANK_LEDGER, debit: 10_000 },
    { account: account('1060'), credit: 10_000 },
    { account: account('1060'), debit: 12_000 },
    { account: account('3400'), credit: 11_101 },
    { account: account('2200'), credit: 899 },
    { account: account('4400'), debit: 2_000 },
    { account: account('1060'), credit: 2_000 },
  ],
  captions: [],
  verdict: { ok: true },
};

function happy(extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inboxFor([ASKING]),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: TAX }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [RULE_ASK, RULE_SHOP] }),
    compose_entry: composeFake(),
    ...extra,
  };
}

function renderBank(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <PrefsProvider store={dockedRight()}>
            <MemoryRouter initialEntries={['/bank']}>
              <Bank />
            </MemoryRouter>
          </PrefsProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

function rowOf(name: RegExp): HTMLElement {
  const row = screen.getAllByRole('row', { name }).find((r) => r.classList.contains('bank-row'));
  if (row === undefined) throw new Error(`no bank row named ${String(name)}`);
  return row;
}
async function findRow(name: RegExp): Promise<HTMLElement> {
  await screen.findAllByRole('row', { name });
  return rowOf(name);
}
const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '');
/** D177: the selected line's Details panel (the asked amounts moved out of the row into it). */
function panelOf(bankTxnId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-panel-for="${bankTxnId}"]`);
  if (el === null) throw new Error(`no Details panel for ${bankTxnId}`);
  return el;
}
/** D178 N2 (A39 §18.5): "Als Buchungsregel speichern" is an item of the row's Mehr; a split opens the form in the area. */
async function saveRuleFromMenu(row: HTMLElement): Promise<void> {
  await userEvent.click(await within(row).findByRole('button', { name: /^Weitere Aktionen für Seeblick Akademie AG/ }));
  await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Als Buchungsregel speichern' }));
}
async function openPanel(row: HTMLElement, bankTxnId: string): Promise<HTMLElement> {
  await userEvent.click(within(row).getAllByRole('cell')[1] as HTMLElement);
  await waitFor(() => expect(document.querySelector(`[data-panel-for="${bankTxnId}"]`)).not.toBeNull());
  return panelOf(bankTxnId);
}

describe('D175: a rule that asks for an amount (story 3, 3e)', () => {
  it('★ names the rule; Buchen waits for the ask, then books the RULE target; the preview is compose_entry for it', async () => {
    const { transport, calls } = recording(happy({ book_bank_line: ok({ state: 'booked', entryId: 'je_1', remainder: null }) }));
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    // D178 N2 (A39 §18.5): the ★ left the row; the rule's acts are words in Mehr, its name the field's source tooltip.
    await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für Seeblick Akademie AG/ }));
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Buchungsregel öffnen' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(row).toHaveAttribute('data-source', 'standard');
    const trigger = within(row).getByRole('button', { name: /Buchen auf, Seeblick Akademie AG/ });
    expect(trigger).toHaveTextContent('Seeblick Kurse');
    // D177: the source in a few words (the rule's name), never the reason paragraph.
    expect(describedBy(trigger)).toHaveTextContent(/^Regel Seeblick Kurse$/);

    // D177: the asked amount left the row for the Details panel; Buchen says what is missing.
    expect(within(row).queryByRole('textbox')).toBeNull();
    const book = bookOf(row);
    expect(book).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy(book)).toHaveTextContent('Bruttoumsatz fehlt');
    const panel = await openPanel(row, 'bt_ask');
    const ask = within(panel).getByRole('textbox', { name: 'Bruttoumsatz' });
    // 0 is not a positive amount: Buchen still waits (D152: the Studio checks only this).
    await userEvent.type(ask, '0');
    expect(bookOf(rowOf(/Seeblick Akademie AG/))).toHaveAttribute('aria-disabled', 'true');
    await userEvent.clear(ask);
    await userEvent.type(ask, '120.00');
    await waitFor(() => expect(bookOf(rowOf(/Seeblick Akademie AG/))).not.toHaveAttribute('aria-disabled'));
    // The panel shows the ENGINE's lines for the rule target: 1060 in and out.
    await waitFor(() =>
      expect(calls.filter((x) => x.action === 'compose_entry' && x.input.target !== undefined).at(-1)?.input).toMatchObject({
        workspaceId: 'ws_test',
        mode: 'expand',
        bankTxnId: 'bt_ask',
        target: { kind: 'rule', standardId: 'br_1', asks: { '0': 12_000 } },
      }),
    );
    const preview = await screen.findByRole('region', { name: 'So wird gebucht' });
    // Each account once in the table (its tooltip repeats the name): 1060 in and out, three lines.
    await waitFor(() => expect(within(preview).getAllByRole('row').filter((r) => /^1060 /.test(r.textContent ?? ''))).toHaveLength(3));

    await userEvent.click(bookOf(rowOf(/Seeblick Akademie AG/)));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    const booked = calls.find((c) => c.action === 'book_bank_line')?.input ?? {};
    expect(booked).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'bt_ask', target: { kind: 'rule', standardId: 'br_1', asks: { '0': 12_000 } } });
    expect(typeof booked.idempotencyKey).toBe('string');
  });

  it('a rest of zero is the engine\'s answer, said at the field and on Buchen: Buchen waits and the typed amount stays', async () => {
    const { transport, calls } = recording(happy({ compose_entry: composeFake(() => ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: false, error: 'rest_is_zero' }, bankTxnId: 'bt_ask', target: null })) }));
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    const panel = await openPanel(row, 'bt_ask');
    const ask = within(panel).getByRole('textbox', { name: 'Bruttoumsatz' });
    await userEvent.type(ask, '100.00');
    // D177 final judge: one plain reason at the field and on Buchen's tooltip; the typed amount stays.
    // The engine was asked (the refusal is its answer), then the field's note says it.
    await waitFor(() => expect(calls.some((c) => c.action === 'compose_entry' && (c.input.target as { kind?: string } | undefined)?.kind === 'rule')).toBe(true));
    await waitFor(() => expect(panelOf('bt_ask').querySelector('.bank-ask__note')).not.toBeNull());
    expect(panelOf('bt_ask').querySelector('.bank-ask__note')).toHaveTextContent(/^Für 4400 bleibt nichts übrig$/);
    const book = bookOf(rowOf(/Seeblick Akademie AG/));
    await waitFor(() => expect(describedBy(book)).toHaveTextContent(/^Für 4400 bleibt nichts übrig$/));
    expect(book).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(book);
    expect(within(panelOf('bt_ask')).getByRole('textbox', { name: 'Bruttoumsatz' })).toHaveValue('100.00');
    // Said once, quietly (UX judge round 2, item 3): the field is not marked invalid for an engine answer.
    expect(within(panelOf('bt_ask')).getByRole('textbox', { name: 'Bruttoumsatz' })).not.toHaveAttribute('aria-invalid');
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });
});

describe('D175: two rules for one payer (story 4, 12)', () => {
  it('the chooser lists the matching rules by name and "Anders buchen", nothing else; a rule picked books by it', async () => {
    const { transport, calls } = recording(
      happy({
        list_bank_inbox: inboxFor([CHOOSING]),
        list_bank_standards: ok({ standards: [RULE_ASK, RULE_SHOP, RULE_QUIET] }),
        book_bank_line: ok({ state: 'booked', entryId: 'je_2', remainder: null }),
      }),
    );
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    const chooser = await within(row).findByRole('button', { name: /^Welche Buchungsregel, Seeblick Akademie AG/ });
    expect(chooser).toHaveTextContent('Welche Buchungsregel?');
    // One decision on the row: Buchen waits until a rule is picked, and says so (D177, item 10).
    expect(bookOf(row)).toHaveAttribute('aria-disabled', 'true');
    expect(describedBy(bookOf(row))).toHaveTextContent('Regel wählen');
    await userEvent.click(chooser);
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('Seeblick Kurse');
    expect(options[1]).toHaveTextContent('Seeblick Shop');
    expect(options[2]).toHaveTextContent('Anders buchen');
    // A rule of another counterparty never lists (story 12).
    expect(screen.queryByRole('option', { name: /Hafenbüro/ })).toBeNull();
    await userEvent.click(options[1] as HTMLElement);

    // The one-candidate case: the rule on the row, ★, and Buchen (Seeblick Shop asks nothing).
    const picked = rowOf(/Seeblick Akademie AG/);
    await waitFor(() => expect(within(picked).getByRole('button', { name: /Buchen auf, Seeblick Akademie AG/ })).toHaveTextContent('Seeblick Shop'));
    expect(picked).toHaveAttribute('data-source', 'standard');
    await userEvent.click(bookOf(picked));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_choose', target: { kind: 'rule', standardId: 'br_2', asks: {} } });
  });

  it('"Anders buchen" opens the whole "Worauf buchen?" list; a rule that asks turns the row into story 3', async () => {
    renderBank(recording(happy({ list_bank_inbox: inboxFor([CHOOSING]) })).transport);
    const row = await findRow(/Seeblick Akademie AG/);
    await userEvent.click(await within(row).findByRole('button', { name: /^Welche Buchungsregel, Seeblick Akademie AG/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Seeblick Kurse/ }));
    // D177: picking a rule that asks opens the Details on its field; Buchen names what is missing.
    await waitFor(() => expect(document.querySelector('[data-panel-for="bt_choose"]')).not.toBeNull());
    expect(within(panelOf('bt_choose')).getByRole('textbox', { name: 'Bruttoumsatz' })).toBeInTheDocument();
    expect(bookOf(rowOf(/Seeblick Akademie AG/))).toHaveAttribute('aria-disabled', 'true');

    // × goes back to the decision point; "Anders buchen" then opens the full list at once.
    await clearTarget(rowOf(/Seeblick Akademie AG/), 'Seeblick Akademie AG');
    await userEvent.click(within(rowOf(/Seeblick Akademie AG/)).getByRole('button', { name: /^Welche Buchungsregel, Seeblick Akademie AG/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Anders buchen/ }));
    expect(await screen.findByRole('option', { name: /Aufteilen auf mehrere Konten/ })).toBeInTheDocument();
    expect(within(rowOf(/Seeblick Akademie AG/)).getByRole('button', { name: /^Buchen auf, Seeblick Akademie AG/ })).toHaveTextContent('Worauf buchen?');
  });
});

describe('D175: ☆ on a split saves a Buchungsregel (story 1, 1e, 1f)', () => {
  const splitCanned = (extra: Canned = {}) =>
    happy({ list_bank_inbox: inboxFor([SPLIT]), list_bank_standards: ok({ standards: [] }), list_drafted_actions: ok({ actions: [SPLIT_VORSCHLAG] }), ...extra });

  it('the form waits for the rest with its reason, then sends the recipe, the name and the text', async () => {
    const { transport, calls } = recording(splitCanned({ set_bank_standard: ok({ standard: { id: 'br_9' } }) }));
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    await saveRuleFromMenu(row);
    const form = await screen.findByRole('form', { name: 'Als Buchungsregel speichern' });
    expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveValue('Seeblick Akademie AG');
    // The first distinctive word of the remittance, removable (A39 §14.5).
    expect(within(form).getByRole('textbox', { name: 'Nur wenn der Text enthält' })).toHaveValue('KURSE');
    // Story 1e: nothing says which leg is the rest of a split drafted elsewhere, so Speichern waits.
    const save = within(form).getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();
    expect(describedBy(save)).toHaveTextContent('Wähl, welcher Betrag der Rest ist.');
    await userEvent.click(within(form).getByRole('radio', { name: /4400/ }));
    // The other leg is asked each time, under its account's name, editable.
    const askLabel = within(form).getByRole('textbox', { name: 'Bezeichnung für 3400' });
    expect(askLabel).toHaveValue('Erlöse aus Dienstleistungen');
    await userEvent.clear(askLabel);
    await userEvent.type(askLabel, 'Bruttoumsatz');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const sent = calls.find((c) => c.action === 'set_bank_standard')?.input ?? {};
    expect(sent).toMatchObject({
      workspaceId: 'ws_test',
      bankTxnId: 'bt_split',
      label: 'Seeblick Akademie AG',
      matchText: 'KURSE',
      legs: [
        { accountId: account('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
        { accountId: account('4400'), amount: { kind: 'rest' } },
      ],
    });
    expect(sent.viaAccountId).toBeUndefined();
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(await screen.findByText('Buchungsregel «Seeblick Akademie AG» gespeichert.')).toBeInTheDocument();
    // Saving a rule books nothing (D139).
    expect(calls.some((c) => c.action === 'book_bank_line' || c.action === 'approve_drafted_action')).toBe(false);
  });

  it('a refused save says why in words and keeps every input as typed', async () => {
    const { transport } = recording(splitCanned({ set_bank_standard: refuse('invalid_recipe', { detail: 'exactly one rest leg' }) }));
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    await saveRuleFromMenu(row);
    const form = await screen.findByRole('form', { name: 'Als Buchungsregel speichern' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Kurse netto');
    await userEvent.click(within(form).getByRole('radio', { name: /4400/ }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('So lässt sich die Buchungsregel nicht speichern.');
    expect(within(form).queryByText(/exactly one rest leg/)).toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveValue('Kurse netto');
    expect(within(form).getByRole('radio', { name: /4400/ })).toBeChecked();
    expect(within(form).getByRole('textbox', { name: 'Nur wenn der Text enthält' })).toHaveValue('KURSE');
  });

  // D177 (A39 §16.1): a leg that is not the rest is asked each time or COMPUTED. Synthetic line: 100.00.
  const openForm = async () => {
    const row = await findRow(/Seeblick Akademie AG/);
    await saveRuleFromMenu(row);
    const form = await screen.findByRole('form', { name: 'Als Buchungsregel speichern' });
    await userEvent.click(within(form).getByRole('radio', { name: /4400/ }));
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'Betrag für 3400' })).getByRole('radio', { name: 'Berechnen' }));
    return form;
  };

  it('D177: Berechnen with the platform preset sends the exact fraction and its words, and shows what it gives on the line', async () => {
    const { transport, calls } = recording(splitCanned({ set_bank_standard: ok({ standard: { id: 'br_9' } }) }));
    renderBank(transport);
    const form = await openForm();
    // Only the preset's fields show, and Speichern waits for them.
    expect(within(form).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.type(within(form).getByRole('textbox', { name: 'MWST in %' }), '8.1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gebühr in % vom Netto' }), '9.9');
    // 100.00 × 1081/180 = 600.555..., rounded half up to 600.56: said in words (UX judge, item 9), and
    // the fraction nowhere on screen (UX judge round 2, item 11).
    const result = form.querySelector('[data-factor-result]') as HTMLElement;
    expect(result).toHaveTextContent('berechnet aus MWST 8.1 % und Gebühr 9.9 % vom Netto: 100.00 → 600.56');
    expect(result.textContent).not.toMatch(/1081/);
    expect(result).not.toHaveAttribute('aria-describedby');
    // Speichern sits in the form's sticky foot.
    expect(within(form).getByRole('button', { name: 'Speichern' }).closest('.bank-rule-form__foot')).not.toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).toMatchObject({
      legs: [
        { accountId: account('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Erlöse aus Dienstleistungen', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
        { accountId: account('4400'), amount: { kind: 'rest' } },
      ],
    });
  });

  it('D177: Berechnen with a plain factor sends it as an exact fraction; a fraction the engine refuses is said at the field', async () => {
    const { transport, calls } = recording(splitCanned({ set_bank_standard: refuse('invalid_recipe', { detail: 'factor' }) }));
    renderBank(transport);
    const form = await openForm();
    await userEvent.click(within(form).getByRole('combobox', { name: 'Berechnung' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Faktor' }));
    const field = within(form).getByRole('textbox', { name: 'Faktor, z. B. 6.0056 oder 1081/180' });
    await userEvent.type(field, '2.5');
    expect(form.querySelector('[data-factor-result]')).toHaveTextContent('100.00 → 250.00');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect((calls.find((c) => c.action === 'set_bank_standard')?.input.legs as { amount: unknown }[])[0]?.amount).toEqual({ kind: 'factor', label: 'Erlöse aus Dienstleistungen', num: 5, den: 2 });
    expect(await within(form).findByRole('alert')).toHaveTextContent('Dieser Faktor ist zu gross. Nimm einen einfacheren.');
    expect(field).toHaveValue('2.5');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('Aufteilen: the Durchlaufkonto picker offers balance accounts only, and the route rides on the preview and the rule', async () => {
    const { transport, calls } = recording(splitCanned({ set_bank_standard: ok({ standard: { id: 'br_9' } }) }));
    renderBank(transport);
    const row = await findRow(/Seeblick Akademie AG/);
    // The agent's split is on the row once the Vorschläge read answered (◇).
    await waitFor(() => expect(rowOf(/Seeblick Akademie AG/)).toHaveAttribute('data-source', 'agent'));
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, Seeblick Akademie AG/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen auf mehrere Konten/ }));
    // D177: the split is position rows under the row; the agent's two legs, the minus kept.
    await waitFor(() => expect(document.querySelectorAll('tr.bank-split-row[data-position]')).toHaveLength(2));
    expect((document.querySelector('tr.bank-split-row[data-position="2"] .bank-cell--amount input') as HTMLInputElement).value).toBe('-20.00');
    await userEvent.click(screen.getByRole('button', { name: 'Über Durchlaufkonto buchen' }));
    const offered = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    // Story 1f: never the bank ledger, a VAT or control account, an Erfolgskonto, or a leg's own account.
    for (const banned of ['1020', '1100', '1170', '1171', '2000', '2200', '2201', '3400', '4400', '6500']) {
      expect(offered.some((o) => o.startsWith(banned))).toBe(false);
    }
    expect(offered.some((o) => o.startsWith('1060'))).toBe(true);
    await userEvent.click(screen.getByRole('option', { name: /^1060/ }));
    const viaRow = document.querySelector('tr.bank-split-row--via') as HTMLElement;
    expect(within(viaRow).getByRole('button', { name: /^Durchlaufkonto/ })).toHaveTextContent('1060');
    // The preview is the engine's composition of the very target Buchen sends: via 1060.
    await waitFor(() => expect(calls.some((c) => c.action === 'compose_entry' && (c.input.target as { viaAccountId?: string } | undefined)?.viaAccountId === account('1060'))).toBe(true));
    expect(calls.find((c) => c.action === 'compose_entry' && c.input.target !== undefined)?.input).toMatchObject({
      bankTxnId: 'bt_split',
      target: { kind: 'accounts', viaAccountId: account('1060'), legs: [{ accountId: account('3400'), amountMinor: 12_000 }, { accountId: account('4400'), amountMinor: -2_000 }] },
    });

    // D177: "Als Regel speichern" in the Details saves the split with its Durchlaufkonto.
    await userEvent.click(within(panelOf('bt_split')).getByRole('button', { name: 'Als Regel speichern' }));
    const form = await screen.findByRole('form', { name: 'Als Buchungsregel speichern' });
    expect(within(form).getByText(/^Über 1060 /)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('radio', { name: /4400/ }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).toMatchObject({ bankTxnId: 'bt_split', viaAccountId: account('1060'), legs: [{ amount: { kind: 'ask' } }, { amount: { kind: 'rest' } }] });
  });
});

describe('D175: the "Buchungsregeln" sheet (story 5, 8)', () => {
  it('empty: the quiet header link opens the sheet, which says how a rule is made', async () => {
    renderBank(recording(happy({ list_bank_standards: ok({ standards: [] }) })).transport);
    await findRow(/Seeblick Akademie AG/);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    expect(await within(sheet).findByText('Noch keine Buchungsregel. Speichere eine mit ☆, wenn du eine Zeile buchst.')).toBeInTheDocument();
    expect(within(sheet).getByText('Eine Buchungsregel schlägt nur vor. Gebucht wird erst auf deinen Klick.')).toBeInTheDocument();
  });

  it('LOADING: a skeleton of the list while the sheet\'s own read is really in flight', async () => {
    // The inbox's read answers; the sheet's own read (the second) never does.
    let reads = 0;
    const base = recording(happy({ list_bank_standards: ok({ standards: [RULE_ASK] }) })).transport;
    const transport = watchReads((action, input) => {
      if (action === 'list_bank_standards') {
        reads += 1;
        if (reads > 1) return new Promise<RestResponse>(() => {});
      }
      return base(action, input);
    });
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
    await transport.started('list_bank_standards', 2);
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    expect(within(sheet).getAllByRole('status').some((s) => s.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(within(sheet).queryByText('Seeblick Kurse')).toBeNull();
  });

  it('lists each rule with its match and route in words; a quiet rule says why, with Bearbeiten', async () => {
    renderBank(recording(happy({ list_bank_standards: ok({ standards: [RULE_ASK, RULE_SHOP, RULE_QUIET] }) })).transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (3)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const kurse = (await within(sheet).findByText('Seeblick Kurse')).closest('li') as HTMLElement;
    expect(kurse).toHaveTextContent('Seeblick Akademie AG, Geld rein, Text enthält «KURSE»');
    // Account names in plain words (UX judge round 2, item 8), one short line per leg under the
    // recognition line (D177 final judge, LOW d), an asked amount in the voice of a computed one (LOW e).
    expect(Array.from(kurse.querySelectorAll('.bank-rules__route-line')).map((l) => l.textContent)).toEqual([
      'über 1060 Kurzfristig gehaltene Wertpapiere',
      '3400 Erlöse aus Dienstleistungen MWST 8.1 %: Bruttoumsatz gibst du beim Buchen ein',
      'Rest: 4400 Bezogene Fremdleistungen',
    ]);
    const quiet = within(sheet).getByText('Hafenbüro GmbH').closest('li') as HTMLElement;
    expect(quiet).toHaveTextContent('Hafenbüro GmbH, Geld raus');
    expect(quiet).toHaveTextContent('Schlägt nichts vor: Ein Konto dieser Regel ist archiviert, darum schlägt sie nichts mehr vor.');
    expect(within(quiet).queryByText(/account_archived/)).toBeNull();
    expect(within(quiet).getByRole('button', { name: 'Bearbeiten' })).toBeInTheDocument();
  });

  it('Bearbeiten reuses the form and supersedes the rule through set_bank_standard', async () => {
    const { transport, calls } = recording(happy({ list_bank_standards: ok({ standards: [RULE_ASK] }), set_bank_standard: ok({ standard: { id: 'br_10' }, supersededId: 'br_1', unchanged: false }) }));
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const item = (await within(sheet).findByText('Seeblick Kurse')).closest('li') as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Bearbeiten' }));
    const form = within(item).getByRole('form', { name: 'Buchungsregel bearbeiten' });
    expect(within(form).getByRole('radio', { name: /4400/ })).toBeChecked();
    expect(within(form).getByRole('textbox', { name: 'Bezeichnung für 3400' })).toHaveValue('Bruttoumsatz');
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Kurse brutto');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    // D176: the edit names the rule by its id; no bank line is hunted for.
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).not.toHaveProperty('bankTxnId');
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).toMatchObject({
      workspaceId: 'ws_test',
      standardId: 'br_1',
      label: 'Kurse brutto',
      matchText: 'KURSE',
      viaAccountId: account('1060'),
      legs: [
        { accountId: account('3400'), taxCode: 'UST81', amount: { kind: 'ask', label: 'Bruttoumsatz' } },
        { accountId: account('4400'), amount: { kind: 'rest' } },
      ],
    });
    expect(await within(sheet).findByText('Buchungsregel «Kurse brutto» gespeichert.')).toBeInTheDocument();
    // "Ohne MWST" leaves the code out; the same text superseded the rule, so nothing is cleared.
    const sentLegs = (calls.find((c) => c.action === 'set_bank_standard')?.input.legs ?? []) as Record<string, unknown>[];
    expect(sentLegs[1]).not.toHaveProperty('taxCode');
    expect(calls.some((c) => c.action === 'clear_bank_standard')).toBe(false);
  });

  it('D176: an edit that changes the text is ONE edit by id: the engine supersedes the old rule, nothing is cleared after', async () => {
    const { transport, calls } = recording(
      happy({
        list_bank_standards: ok({ standards: [RULE_ASK] }),
        set_bank_standard: ok({ standard: { id: 'br_11' }, supersededId: 'br_1', unchanged: false }),
        clear_bank_standard: ok({ cleared: true }),
      }),
    );
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const item = (await within(sheet).findByText('Seeblick Kurse')).closest('li') as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Bearbeiten' }));
    const form = within(item).getByRole('form', { name: 'Buchungsregel bearbeiten' });
    await userEvent.click(within(form).getByRole('button', { name: 'Bedingung entfernen' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const set = calls.find((c) => c.action === 'set_bank_standard');
    expect(set?.input).toMatchObject({ standardId: 'br_1' });
    expect(set?.input).not.toHaveProperty('matchText');
    expect(await within(sheet).findByText('Buchungsregel «Seeblick Kurse» gespeichert.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'clear_bank_standard')).toBe(false);
  });

  it('D176: with no bank line of the counterparty anywhere, Bearbeiten still saves, by the rule id', async () => {
    const { transport, calls } = recording(
      happy({
        list_bank_inbox: (input) => (input.query !== undefined ? ok({ lines: [], nextCursor: null, total: 0, summary: [SUMMARY] }) : inboxFor([])(input)),
        list_bank_standards: ok({ standards: [RULE_QUIET] }),
      }),
    );
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    const item = (await within(sheet).findByText('Hafenbüro GmbH')).closest('li') as HTMLElement;
    await userEvent.click(within(item).getByRole('button', { name: 'Bearbeiten' }));
    const form = within(item).getByRole('form', { name: 'Buchungsregel bearbeiten' });
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input).toMatchObject({ standardId: 'br_3', legs: [{ accountId: account('6500'), amount: { kind: 'rest' } }] });
    expect(calls.some((c) => c.action === 'list_bank_inbox' && c.input.query !== undefined)).toBe(false);
  });

  it('Entfernen sits under Mehr, behind a confirm, and calls clear_bank_standard', async () => {
    const { transport, calls } = recording(happy({ list_bank_standards: ok({ standards: [RULE_ASK] }), clear_bank_standard: ok({ cleared: true }) }));
    renderBank(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchungsregeln (1)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Buchungsregeln' });
    await within(sheet).findByText('Seeblick Kurse');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Weitere Aktionen für «Seeblick Kurse»' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Entfernen' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Buchungsregel entfernen?' });
    expect(confirm).toHaveTextContent('«Seeblick Kurse» schlägt danach nichts mehr vor.');
    expect(calls.some((c) => c.action === 'clear_bank_standard')).toBe(false);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'clear_bank_standard')).toBe(true));
    expect(calls.find((c) => c.action === 'clear_bank_standard')?.input).toMatchObject({ workspaceId: 'ws_test', standardId: 'br_1' });
    expect(await within(sheet).findByText('Buchungsregel «Seeblick Kurse» entfernt.')).toBeInTheDocument();
  });
});
