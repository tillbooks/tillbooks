/**
 * D177 (A39 §16): the /bank row rebuilt for clarity, against a fake engine. One test (or more) per row of
 * the §16.3 story matrix, plus the guards §16.4 names: the row and the Details panel print no hint prose
 * at rest; the row's × is reachable by keyboard and shown on touch; the split's position rows; a disabled
 * Buchen always says why. And the owner's three amendments: the Buchungstext field, icon-first panel
 * actions, and Woher in one line.
 *
 * `compose_entry` for a rule target is answered here (the engine's rule expansion needs a bank line in a
 * book, which the shared compose harness does not seed); its lines are synthetic and balanced. Every name,
 * IBAN and figure is invented for this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';
import Bank from './index';
import { PrefsProvider } from '../../lib/prefs';
import { dockedRight } from './test-prefs';
import { DEFAULT_COLUMN_WIDTHS } from './columns';

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
const TAX = [
  { code: 'VST-M', kind: 'input', rateBp: 810, label: 'Vorsteuer Material, Waren, Dienstleistungen', formLine: '400', active: true },
  { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz', formLine: '303', active: true },
];

function line(id: string, over: Record<string, unknown>) {
  const certainty = (over.proposal as { certainty?: string } | null | undefined)?.certainty;
  return {
    attention: certainty === 'sure' ? 'sure' : 'needs',
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
    counterparty: { name: null, iban: null },
    remittance: { text: null, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    ...over,
  };
}

/** Two rules for one payer: a computed one (Bondigoo) and one that asks (Shopify). */
const RULE_BOND = {
  id: 'bs_bond',
  scope: 'bank',
  outcome: 'legs',
  counterpartyKey: 'name:fernpay plattform',
  counterpartyLabel: 'Fernpay Plattform AG',
  direction: 'in',
  label: 'Bondigoo',
  matchText: 'BONDIGOO',
  viaAccountId: null,
  legs: [
    { accountId: account('3400'), accountNumber: '3400', accountName: 'Erlöse aus Dienstleistungen', taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
    { accountId: account('6700'), accountNumber: '6700', accountName: 'Übriger betrieblicher Aufwand', taxCode: null, amount: { kind: 'rest' } },
  ],
  invalidReason: null,
  accountId: account('6700'),
  accountNumber: '6700',
  accountName: 'Übriger betrieblicher Aufwand',
  taxCode: null,
};
const RULE_SHOP = {
  ...RULE_BOND,
  id: 'bs_shop',
  label: 'Shopify',
  matchText: 'SHOPIFY',
  legs: [
    { accountId: account('3200'), accountNumber: '3200', accountName: 'Erlöse aus Handelswaren', taxCode: 'UST81', amount: { kind: 'ask', label: 'Umsatz' } },
    { accountId: account('6700'), accountNumber: '6700', accountName: 'Übriger betrieblicher Aufwand', taxCode: null, amount: { kind: 'rest' } },
  ],
};

const LONG_TEXT = 'BONDIGOO AUSZAHLUNG OKTOBER 2026 SITZUNGEN 14 BIS 27 REFERENZ BG-2026-10-4711 ABZUEGLICH PLATTFORMGEBUEHR UND MWST GEMAESS VERTRAG VOM 1.3.2026';

const BOND = line('bt_bond', {
  amountMinor: 1_512,
  counterparty: { name: 'Fernpay Plattform AG', iban: 'CH9300762011623852957' },
  remittance: { text: LONG_TEXT, referenceKind: 'NON', referenceValue: null, endToEndId: null },
  standardId: 'bs_bond',
  ruleIds: ['bs_bond', 'bs_shop'],
  proposal: {
    target: { kind: 'rule', standardId: 'bs_bond', asks: {} },
    certainty: 'check',
    reasonCode: 'rule_computed',
    reasonParams: { standardId: 'bs_bond', computed: [{ legIndex: 0, label: 'Bruttoumsatz', amountMinor: 9_080, explain: { vatBp: 810, feeBp: 990 } }] },
    vatCode: null,
  },
});

const SHOP = line('bt_shop', {
  bookingDate: '2026-10-13',
  valueDate: '2026-10-13',
  amountMinor: 8_990,
  counterparty: { name: 'Fernpay Plattform AG', iban: null },
  remittance: { text: 'SHOPIFY PAYOUT', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  standardId: 'bs_shop',
  ruleIds: ['bs_bond', 'bs_shop'],
  proposal: {
    target: { kind: 'rule', standardId: 'bs_shop', asks: {} },
    certainty: 'check',
    reasonCode: 'rule_needs_amount',
    reasonParams: { standardId: 'bs_shop', asks: [{ legIndex: 0, label: 'Umsatz' }] },
    vatCode: null,
  },
});

const FEE = line('bt_fee', {
  bookingDate: '2026-10-12',
  valueDate: '2026-10-12',
  amountMinor: -500,
  creditDebit: 'DBIT',
  counterparty: { name: 'Kontoführung Seebank', iban: null },
  remittance: { text: 'Paketgebühr Oktober', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
});

/** An overpaid invoice: 50.00 in, 42.42 open. */
const OVER = line('bt_over', {
  bookingDate: '2026-10-11',
  valueDate: '2026-10-11',
  amountMinor: 5_000,
  counterparty: { name: 'Coworking Kafi AG', iban: null },
  remittance: { text: 'Zahlung R-2026-0034', referenceKind: 'QRR', referenceValue: '000000000000000000002026003', endToEndId: null },
  proposal: {
    target: { kind: 'open_item', documentId: 'doc_34' },
    certainty: 'sure',
    reasonCode: 'qr_reference_exact',
    reasonParams: { documentId: 'doc_34', documentNumber: 'R-2026-0034', openMinor: 4_242 },
    vatCode: null,
  },
});

/** A short payment: 30.00 in, 42.42 open. */
const SHORT = line('bt_short', { ...OVER, bankTxnId: 'bt_short', amountMinor: 3_000 });

const SUMMARY = {
  bankAccountId: 'ba_1',
  name: 'Seeufer Geschäftskonto',
  iban: 'CH5604835012345678009',
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

function inboxFor(lines: unknown[]): Handler {
  return (input) => {
    const status = input.status as string;
    const mine = lines.filter((l) => (l as { state: string }).state === status || status === 'all');
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
  };
}

/** Seven balanced lines for a computed Bondigoo payout of 15.12 (gross 90.80). */
const BOND_LINES = [
  { account: BANK_LEDGER, debit: 1_512, credit: 0 },
  { account: account('6700'), debit: 7_568, credit: 0 },
  { account: account('3400'), debit: 0, credit: 8_400 },
  { account: account('2200'), debit: 0, credit: 680 },
  { account: account('6700'), debit: 0, credit: 0 },
  { account: account('6700'), debit: 0, credit: 0 },
  { account: account('6700'), debit: 0, credit: 0 },
];

/** compose_entry: a rule target answered here; a typed leg list by the real engine. */
function compose(): Handler {
  const engine = composeEngine();
  return (input) => {
    const target = input.target as { kind?: string; asks?: Record<string, number>; legs?: { accountId: string; amountMinor: number }[] } | undefined;
    // The rule without its rest leg (a rest of 0, D177 final judge FAIL 1): the engine's lines for 15.12 gross.
    if (target?.kind === 'accounts' && input.bankTxnId === 'bt_bond' && target.legs?.length === 1 && target.legs[0]?.amountMinor === 1_512) {
      return ok({
        mode: 'expand',
        composed: true,
        stamped: true,
        lines: [
          { account: BANK_LEDGER, debit: 1_512 },
          { account: account('3400'), credit: 1_399 },
          { account: account('2200'), credit: 113 },
        ],
        captions: [],
        verdict: { ok: true },
      });
    }
    if (target?.kind !== 'rule') return engine(input);
    const asks = target.asks ?? {};
    if (asks['0'] === 1_512) {
      return ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: false, error: 'rest_is_zero' } });
    }
    return ok({ mode: 'expand', composed: true, stamped: true, lines: BOND_LINES, captions: [], verdict: { ok: true } });
  };
}

function canned(lines: unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inboxFor(lines),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: TAX }),
    list_open_items: ok({ items: [{ kind: 'document', documentId: 'doc_34', number: 'R-2026-0034', customerName: 'Coworking Kafi AG', openMinor: 4_242, currency: 'CHF' }] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [RULE_BOND, RULE_SHOP] }),
    compose_entry: compose(),
    book_bank_line: ok({ state: 'booked', remainder: { kind: 'none' }, warnings: [] }),
    ignore_bank_line: ok({ state: 'ignored', warnings: [] }),
    reopen_bank_line: ok({ state: 'open', warnings: [] }),
    set_bank_standard: ok({ standardId: 'bs_new' }),
    ...extra,
  };
}

function recording(c: Canned): { transport: Transport; calls: { action: string; input: Record<string, unknown> }[] } {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    transport: async (action, input) => {
      calls.push({ action, input });
      const entry = c[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    },
  };
}

const EVERY_RIGHT = [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles, CAP.readMasterData, CAP.readFileContent, 'manage_agent_dial', 'read_books', 'read_vat'];
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  } as Capabilities;
}

function renderBank(transport: Transport, path = '/bank') {
  return render(
    <CapabilitiesContext.Provider value={caps(EVERY_RIGHT)}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={dockedRight()}>
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

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`tr.bank-row[data-line="${id}"]`);
  if (row === null) throw new Error(`no row ${id}`);
  return row;
}
async function rowReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  return rowOf(id);
}
function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-panel-for]');
  if (el === null) throw new Error('no Details panel');
  return el;
}
async function select(id: string) {
  const row = await rowReady(id);
  await userEvent.click(within(row).getAllByRole('cell')[1] as HTMLElement);
  await waitFor(() => expect(panel()).toHaveAttribute('data-panel-for', id));
  return row;
}
/** An element on screen once it is there (a `waitFor` that never settles on null). */
async function present(selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null) throw new Error(`not yet: ${selector}`);
    return el;
  });
}
/** The text of a tooltip an element is described by. */
function tipOf(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}
/** Wait until the rules are read (the row shows the rule's name). */
async function rulesRead(id: string) {
  await waitFor(() => expect(within(rowOf(id)).getByRole('button', { name: /^Buchen auf, / })).toHaveTextContent(/Bondigoo|Shopify/));
}

/**
 * The visible words of an element: no tooltip bubble, no screen-reader-only text, no field values, and not
 * the bank line's own facts (data, never an explanation).
 */
function visibleProse(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('[role="tooltip"], .visually-hidden, .bank-facts, input, textarea')) el.remove();
  const texts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = (node.textContent ?? '').trim();
      if (v !== '') texts.push(v);
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(clone);
  // A sentence: five words or more ending in a full stop.
  return texts.filter((x) => /\.$/.test(x) && x.split(/\s+/).length >= 5);
}

afterEach(() => window.localStorage.clear());

describe('D177 story matrix (A39 §16.3)', () => {
  it('1 Bondigoo payout: 90.80 prefilled and "berechnet", the panel shows the seven lines, one click books the rule as proposed', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz') as HTMLInputElement;
    expect(field.value).toBe('90.80');
    const computed = panel().querySelector('[data-computed="engine"]') as HTMLElement;
    expect(computed).toHaveTextContent('berechnet');
    // In plain words (UX judge round 2, item 11), never the fraction.
    expect(tipOf(computed)).toBe('Bruttoumsatz aus 15.12: MWST 8.1 % und Gebühr 9.9 % vom Netto');
    expect(panel().textContent ?? '').not.toMatch(/1081|× \d/);
    await waitFor(() => expect(panel().querySelectorAll('.bank-legs__table tbody tr')).toHaveLength(7));
    await userEvent.click(bookOf(rowOf('bt_bond')));
    const booked = calls.find((c) => c.action === 'book_bank_line');
    expect(booked?.input.target).toEqual({ kind: 'rule', standardId: 'bs_bond', asks: {} });
    expect(booked?.input).not.toHaveProperty('text');
  });

  it('2 estimate off: typing the figure reads "von dir", the preview asks with the override, "berechnen" takes the engine figure back', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz');
    await userEvent.clear(field);
    await userEvent.type(field, '91.20');
    expect(panel().querySelector('[data-computed="person"]')).toHaveTextContent('von dir');
    await waitFor(() => expect(calls.some((c) => c.action === 'compose_entry' && (c.input.target as { asks?: Record<string, number> } | undefined)?.asks?.['0'] === 9_120)).toBe(true));
    await userEvent.click(within(panel()).getByRole('button', { name: 'berechnen' }));
    expect((within(panel()).getByLabelText('Bruttoumsatz') as HTMLInputElement).value).toBe('90.80');
    expect(panel().querySelector('[data-computed="engine"]')).not.toBeNull();
  });

  it('3 an override that makes the rest 0: one plain reason on Buchen\'s tooltip, Buchen does not book, the input is kept', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, '15.12');
    const book = bookOf(rowOf('bt_bond'));
    await waitFor(() => expect(book).toHaveAttribute('aria-disabled', 'true'));
    expect(tipOf(book)).toBe('Für 6700 bleibt nichts übrig');
    await userEvent.click(book);
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
    expect(field.value).toBe('15.12');
  });

  it('4 the wrong rule by text: the Woher switcher offers the payer\'s other rule, and picking it books by Shopify', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Wechseln' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Shopify' }));
    await waitFor(() => expect(within(rowOf('bt_bond')).getByRole('button', { name: /^Buchen auf, / })).toHaveTextContent('Shopify'));
    expect(within(panel()).getByLabelText('Umsatz')).toHaveValue('');
    expect(tipOf(bookOf(rowOf('bt_bond')))).toBe('Umsatz fehlt');
  });

  it('5 understand or edit a rule: its match and route are the name\'s tooltip, a click opens the rules sheet on that rule', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const name = within(panel()).getByRole('button', { name: 'Regel Bondigoo' });
    expect(tipOf(name)).toMatch(/Text enthält «BONDIGOO»/);
    // The route in words (UX judge, item 9), never the raw fraction.
    expect(tipOf(name)).toMatch(/3400 Erlöse aus Dienstleistungen: berechnet aus MWST 8\.1 % und Gebühr 9\.9 % vom Netto; Rest: 6700 Übriger betrieblicher Aufwand/);
    expect(tipOf(name)).not.toMatch(/1081/);
    await userEvent.click(name);
    await waitFor(() => expect(document.querySelector('.bank-rules__item[data-rule="bs_bond"][data-focused="true"] .bank-rules__editor')).not.toBeNull());
  });

  it('6 ignore a fee line: the row\'s ×, one reason, done; Rückgängig in the status line reopens it', async () => {
    const { transport, calls } = recording(canned([FEE]));
    renderBank(transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für Kontoführung Seebank/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ignorieren: Wird anderswo gebucht' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'ignore_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_fee', reason: 'booked_elsewhere' }));
    const status = await screen.findByText(/Ignoriert: Kontoführung Seebank/);
    await userEvent.click(within(status.closest('.bank-status') as HTMLElement).getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'reopen_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_fee', reason: 'Ignorieren rückgängig gemacht' }));
  });

  it('6b "Anderer Grund" asks for the note in the panel before anything is ignored', async () => {
    const { transport, calls } = recording(canned([FEE]));
    renderBank(transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ignorieren: Anderer Grund' }));
    await waitFor(() => expect(panel()).toHaveAttribute('data-mode', 'ignore'));
    expect(within(panel()).getByRole('radio', { name: /Anderer Grund/ })).toBeChecked();
    expect(calls.some((c) => c.action === 'ignore_bank_line')).toBe(false);
  });

  it('7 split a line: position rows on the table\'s columns, the first holds the amount, "+ Position" the rest, the row\'s Buchen books', async () => {
    const { transport, calls } = recording(canned([FEE]));
    renderBank(transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen/ }));
    const positions = () => Array.from(document.querySelectorAll<HTMLElement>('tr.bank-split-row[data-position]'));
    await waitFor(() => expect(positions()).toHaveLength(1));
    // On the table's own columns: the account under "Buchen auf", the amount under "Betrag".
    expect(positions()[0]?.querySelector('.bank-cell--target .picker-trigger')).not.toBeNull();
    const first = positions()[0]?.querySelector('.bank-cell--amount input') as HTMLInputElement;
    expect(first.value).toBe('5.00');
    await userEvent.clear(first);
    await userEvent.type(first, '3.00');
    // What is left, in a few words under Betrag (UX judge, item 5).
    expect(document.querySelector('.bank-split-row--foot .bank-cell--amount')).toHaveTextContent(/^Noch 2\.00$/);
    // Entfernen is an icon button in the last column, one per position once there are two.
    expect(positions()[0]?.querySelector('.bank-cell--ignore button')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '+ Position' }));
    expect((positions()[1]?.querySelector('.bank-cell--amount input') as HTMLInputElement).value).toBe('2.00');
    expect(within(positions()[1] as HTMLElement).getByRole('button', { name: 'Position entfernen' })).toHaveAttribute('data-icon', 'remove');
    const book = bookOf(rowOf('bt_fee'));
    expect(book).toHaveAttribute('aria-disabled', 'true');
    // A position without an account is Buchen's reason (UX judge round 2, item 3), never printed in the row.
    expect(tipOf(book)).toBe('Konto fehlt');
    expect(document.querySelector('.bank-split-row--foot')?.textContent ?? '').not.toMatch(/Konto fehlt/);
    for (const [i, number] of [[0, '6500'], [1, '6700']] as const) {
      await userEvent.click(within(positions()[i] as HTMLElement).getByRole('button', { name: `Konto der Position ${i + 1}` }));
      await userEvent.keyboard(`${number}{Enter}`);
      // The account's MWST picker follows (an Erfolgskonto); Escape keeps its prefill.
      await userEvent.keyboard('{Escape}');
    }
    await waitFor(() => expect(bookOf(rowOf('bt_fee'))).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(bookOf(rowOf('bt_fee')));
    const booked = calls.find((c) => c.action === 'book_bank_line');
    expect((booked?.input.target as { legs: unknown[] }).legs).toEqual([
      expect.objectContaining({ accountId: account('6500'), amountMinor: 300 }),
      expect.objectContaining({ accountId: account('6700'), amountMinor: 200 }),
    ]);
  }, 60_000);

  it('8 an overpayment is kept "Als Guthaben"; a short payment offers Offen lassen and Als Verlust ausbuchen', async () => {
    const { transport, calls } = recording(canned([OVER, SHORT]));
    renderBank(transport);
    await select('bt_over');
    expect(within(panel()).getByRole('radio', { name: 'Als Guthaben' })).toBeChecked();
    await userEvent.click(within(panel()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.target).toEqual({ kind: 'open_item', documentId: 'doc_34' }));
    // Deciding the selected line moves the selection to the next one.
    await waitFor(() => expect(panel()).toHaveAttribute('data-panel-for', 'bt_short'));
    expect(within(panel()).getByRole('radio', { name: 'Offen lassen' })).toBeChecked();
    await userEvent.click(within(panel()).getByRole('radio', { name: 'Als Verlust ausbuchen' }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'book_bank_line').at(-1)?.input.target).toEqual({ kind: 'open_item', documentId: 'doc_34', remainder: 'write_off' }),
    );
  });

  it('9 an agent that drafted twice: the line shows ONE Vorschlag, the one the engine names', async () => {
    const older = { actionId: 'act_old', status: 'pending', actor: 'till-cli', actionTool: 'book_bank_line', dialCapability: 'post', createdAt: '2026-10-14T08:00:00Z', payload: { bankTxnId: 'bt_fee', target: { kind: 'accounts', legs: [{ accountId: account('6700'), amountMinor: -500, taxCode: '' }] } } };
    const newer = { ...older, actionId: 'act_new', createdAt: '2026-10-14T09:00:00Z', payload: { bankTxnId: 'bt_fee', target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 500, taxCode: '' }] } } };
    renderBank(recording(canned([{ ...FEE, vorschlagActionId: 'act_new' }], { list_drafted_actions: ok({ actions: [older, newer] }) })).transport);
    const row = await rowReady('bt_fee');
    await waitFor(() => expect(row).toHaveAttribute('data-source', 'agent'));
    expect(within(row).getByRole('button', { name: /^Buchen auf, / })).toHaveTextContent('6500');
    await select('bt_fee');
    expect(panel().querySelectorAll('.bank-vorschlag')).toHaveLength(1);
  });

  it('10 a disabled Buchen always names why in a few words (an asked amount, the right to post)', async () => {
    renderBank(recording(canned([SHOP])).transport);
    await rulesRead('bt_shop');
    const book = bookOf(rowOf('bt_shop'));
    expect(book).toHaveAttribute('aria-disabled', 'true');
    expect(tipOf(book)).toBe('Umsatz fehlt');
    // Never the disabled attribute: the reason stays reachable by focus and hover.
    expect(book).not.toBeDisabled();
  });

  it('11 a long booking text is in the panel in full, never cut', async () => {
    renderBank(recording(canned([BOND])).transport);
    await select('bt_bond');
    const fact = panel().querySelector('.bank-facts [data-fact="text"] dd') as HTMLElement;
    expect(fact.textContent).toBe(LONG_TEXT);
    expect(panel().querySelector('[data-fact="iban"] dd')).toHaveTextContent('CH93 0076 2011 6238 5295 7');
  });

  it('12 the table\'s header grips (test ids) resize a column, a double-click resets it', async () => {
    renderBank(recording(canned([FEE])).transport);
    await rowReady('bt_fee');
    const handle = screen.getByTestId('bank-col-grip-amount');
    expect(handle).toHaveAccessibleName('Breite: Betrag');
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });
    expect(document.querySelector('col.bank-col--amount')).toHaveStyle({ width: `${DEFAULT_COLUMN_WIDTHS.amount + 40}px` });
    fireEvent.doubleClick(handle);
    expect(document.querySelector('col.bank-col--amount')).toHaveStyle({ width: `${DEFAULT_COLUMN_WIDTHS.amount}px` });
    // The counterparty flexes (no width) until the person drags it.
    expect(document.querySelector('col.bank-col--party')?.getAttribute('style') ?? '').not.toMatch(/width/);
  });

  it('12b the Details sit beside the table from 1180 px, only while a line is selected; below that a click opens the drawer', async () => {
    const saved = window.matchMedia;
    const setWidth = (px: number) => {
      window.matchMedia = ((query: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
        return { matches: px >= min, media: query, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList;
      }) as typeof window.matchMedia;
    };
    try {
      setWidth(1180);
      const first = renderBank(recording(canned([FEE])).transport);
      await rowReady('bt_fee');
      // At rest no panel: the table takes the full width, with its MWST and paperclip columns.
      expect(document.querySelector('.bank-panel')).toBeNull();
      expect(document.querySelector('col.bank-col--vat')).not.toBeNull();
      await select('bt_fee');
      expect(document.querySelector('.bank-workspace')).toHaveAttribute('data-panel', 'beside');
      // With the panel open the MWST, paperclip and pick columns step aside; date and amount stay whole.
      expect(document.querySelector('col.bank-col--vat')).toBeNull();
      expect(document.querySelector('col.bank-col--clip')).toBeNull();
      expect(document.querySelector('col.bank-col--pick')).toBeNull();
      expect(rowOf('bt_fee').querySelector('.bank-cell--vat')).toBeNull();
      expect(document.querySelector('col.bank-col--date')).toHaveStyle({ width: `${DEFAULT_COLUMN_WIDTHS.date}px` });
      first.unmount();
      setWidth(1179);
      renderBank(recording(canned([FEE])).transport);
      const row = await rowReady('bt_fee');
      expect(document.querySelector('.bank-panel')).toBeNull();
      await userEvent.click(within(row).getAllByRole('cell')[1] as HTMLElement);
      const drawer = await screen.findByRole('dialog', { name: 'Kontoführung Seebank' });
      expect(within(drawer).getByLabelText('Buchungstext')).toBeInTheDocument();
    } finally {
      window.matchMedia = saved;
    }
  });

  it('13 fifteen lines: every row is one line, and no row prints prose', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ...(i % 2 === 0 ? FEE : BOND), bankTxnId: `bt_${i}` }));
    renderBank(recording(canned(many)).transport);
    await rowReady('bt_14');
    expect(document.querySelectorAll('tr.bank-row')).toHaveLength(15);
    for (const row of document.querySelectorAll<HTMLElement>('tr.bank-row')) {
      expect(row.querySelector('p')).toBeNull();
      expect(visibleProse(row)).toEqual([]);
    }
  });

  it('14 the bulk button never takes a computed, asked or several-rules line', async () => {
    renderBank(recording(canned([BOND, SHOP, OVER, { ...OVER, bankTxnId: 'bt_over2' }])).transport);
    await rulesRead('bt_bond');
    await waitFor(() => expect(screen.getByRole('button', { name: /Alle vorgeschlagenen buchen/ })).toHaveTextContent('(2)'));
  });
});

describe('D177 picker (A39 §16.2)', () => {
  it('lists the payer\'s Buchungsregeln right after the three actions, and a money-out line its generated payment runs', async () => {
    const batch = { id: 'pb_7', bankAccountId: 'ba_1', executionDate: '2026-10-12', status: 'generated', ctrlSumMinor: 500, nbOfTxs: 2, items: [{}, {}] };
    const { transport, calls } = recording(canned([BOND, FEE], { list_payment_batches: ok({ batches: [batch], total: 1 }) }));
    renderBank(transport);
    await rulesRead('bt_bond');
    await userEvent.click(within(rowOf('bt_bond')).getByRole('button', { name: /^Buchen auf, / }));
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(labels.slice(3, 5).map((x) => x.replace(/über.*|Rest.*|\d{4}.*/, '').trim())).toEqual(['Bondigoo', 'Shopify']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(rowOf('bt_fee')).getByRole('button', { name: /^Buchen auf, / }));
    const run = (await screen.findAllByRole('option')).find((o) => (o.textContent ?? '').includes('Zahlungslauf, 2 Rechnungen'));
    expect(run).toBeDefined();
    await userEvent.click(run as HTMLElement);
    await userEvent.click(bookOf(rowOf('bt_fee')));
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.target).toEqual({ kind: 'payment_batch', batchId: 'pb_7' }));
  });
});

describe('D177 guards (A39 §16.4) and the owner amendments', () => {
  it('no hint prose at rest: not on the row, not in the panel; "Kein Vorschlag" and "Bitte prüfen" are gone', async () => {
    renderBank(recording(canned([BOND, FEE, SHOP])).transport);
    await rulesRead('bt_bond');
    for (const id of ['bt_bond', 'bt_fee', 'bt_shop']) {
      await select(id);
      expect(visibleProse(rowOf(id))).toEqual([]);
      expect(visibleProse(panel())).toEqual([]);
      expect(panel().textContent).not.toMatch(/Kein Vorschlag|Bitte prüfen/);
    }
  });

  it('the Buchungstext is a field from the start, prefilled with the engine\'s default; an edited text is sent with Buchen', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const text = within(panel()).getByLabelText('Buchungstext') as HTMLInputElement;
    expect(text.value).toBe(`Bank: Fernpay Plattform AG, ${LONG_TEXT}`);
    await userEvent.clear(text);
    await userEvent.type(text, 'Bondigoo Oktober');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.text).toBe('Bondigoo Oktober'));
  });

  it('the panel\'s actions are icon buttons with accessible names (Aufteilen and Ignorieren in words since B5); Buchen is the one commit', async () => {
    renderBank(recording(canned([FEE])).transport);
    await select('bt_fee');
    // B5 judge (D178 N3): the two bexio options the owner named carry their words.
    expect(within(panel()).getByRole('button', { name: 'Aufteilen' }).textContent?.trim()).toBe('Aufteilen');
    expect(within(panel()).getByRole('button', { name: 'Ignorieren' }).textContent?.trim()).toBe('Ignorieren');
    for (const name of ['Abgleichen', 'Anhängen']) {
      const button = within(panel()).getByRole('button', { name });
      expect(button).toHaveAttribute('data-icon');
      expect(button.textContent?.trim()).toBe('');
      expect(tipOf(button)).not.toBe('');
    }
    expect(within(panel()).queryByRole('button', { name: /Buchungstext ändern/ })).toBeNull();
  });

  it('Woher is ONE line: the glyph, the rule\'s name and the switcher, no heading, no paragraph', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const woher = panel().querySelector('.bank-woher') as HTMLElement;
    expect(woher.tagName).toBe('DIV');
    expect(woher.querySelector('p, h2, h3, ul')).toBeNull();
    expect(visibleProse(woher)).toEqual([]);
    expect(within(woher).getByRole('button', { name: 'Regel Bondigoo' })).toBeInTheDocument();
    // Each source glyph says what it is (UX judge, item 7).
    const glyph = woher.querySelector('[data-woher-glyph]') as HTMLElement;
    expect(tipOf(glyph)).toBe('Buchungsregel');
  });

  it('the row\'s Mehr (D178 N2, the D177 ×) is reachable by the keyboard and holds the five reasons', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    const trigger = within(row).getByRole('button', { name: /^Weitere Aktionen für / });
    act(() => trigger.focus());
    await userEvent.keyboard('{Enter}');
    expect((await screen.findAllByRole('menuitem')).filter((m) => m.textContent?.startsWith('Ignorieren: '))).toHaveLength(5);
  });

  it('the row\'s Mehr rests hidden only for a hovering pointer, and never with display or visibility', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');
    const block = /@media \(hover: hover\) \{\s*\.bank-row:not\(:hover\):not\(:focus-within\):not\(\[data-selected='true'\]\) \.bank-row-menu \{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/opacity: 0/);
    expect(block?.[1]).not.toMatch(/display|visibility/);
  });

  it('a check glyph draws in ink, never the warn colour', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');
    expect(/\.bank-cert\[data-certainty='check'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').not.toMatch(/--t-warn/);
  });
});

/**
 * The fresh-eyes UX judge on the integrated D177 Studio (screenshots of a real-shaped book copy at 1280 and
 * 1440, both themes), one test or more per finding. Layout itself (widths, ellipses) was re-checked in a
 * browser on a copy of that book; here the structure each fix rests on is held.
 */
describe('D177 UX judge findings', () => {
  const css = () => readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');

  it('1: at rest there is no panel; the counterparty cuts with an ellipsis and its whole name is its tooltip', async () => {
    renderBank(recording(canned([BOND, FEE])).transport);
    const row = await rowReady('bt_bond');
    expect(document.querySelector('.bank-panel')).toBeNull();
    expect(screen.queryByText(/Wähl eine Zeile/)).toBeNull();
    const party = row.querySelector('[data-party-cell]') as HTMLElement;
    expect(tipOf(party)).toBe(`Fernpay Plattform AG · ${LONG_TEXT}`);
    // An account's number never shrinks; its name ends in an ellipsis.
    expect(css()).toMatch(/\.bank-cell--target \.picker-trigger__code \{\s*flex: 0 0 auto;/);
    expect(css()).toMatch(/\.bank-cell--target \.picker-trigger__name,[\s\S]*?text-overflow: ellipsis;/);
  });

  it('2: the panel\'s foot (icon actions and Buchen) sits outside its scrolling middle', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const foot = panel().querySelector('.bank-panel__foot') as HTMLElement;
    expect(foot).not.toBeNull();
    expect(foot.closest('.bank-panel__scroll')).toBeNull();
    expect(within(foot).getByRole('button', { name: 'Buchen' })).toBeInTheDocument();
    expect(panel().querySelector('.bank-panel__scroll .bank-facts')).not.toBeNull();
    expect(css()).toMatch(/\.bank-panel__scroll \{[^}]*overflow-y: auto;/);
    expect(css()).toMatch(/\.bank-panel__foot \{[^}]*flex: 0 0 auto;/);
  });

  it('3: the posting preview keeps one line per account, narrow amount columns, and the Durchlaufkonto quieter, never folded', async () => {
    const via = account('1060');
    const lines = [
      { account: BANK_LEDGER, debit: 1_512, credit: 0 },
      { account: via, debit: 0, credit: 1_512 },
      { account: via, debit: 9_080, credit: 0 },
      { account: account('3400'), debit: 0, credit: 8_400 },
      { account: account('2200'), debit: 0, credit: 680 },
    ];
    const withVia = { ...RULE_BOND, viaAccountId: via, viaAccountNumber: '1060' };
    renderBank(
      recording(
        canned([BOND], {
          list_bank_standards: ok({ standards: [withVia, RULE_SHOP] }),
          compose_entry: () => ok({ mode: 'expand', composed: true, stamped: true, lines, captions: [], verdict: { ok: true } }),
        }),
      ).transport,
    );
    await rulesRead('bt_bond');
    await select('bt_bond');
    await waitFor(() => expect(panel().querySelectorAll('.bank-legs__table tbody tr')).toHaveLength(5));
    expect(panel().querySelectorAll('.bank-legs__table tbody tr[data-transit="true"]')).toHaveLength(2);
    const name = panel().querySelector('.bank-legs__table tbody tr:nth-child(5) .bank-legs__name') as HTMLElement;
    expect(tipOf(name)).toMatch(/^2200 /);
    // UX judge round 2, item 2: a long name wraps to two lines at most, Soll and Haben narrowed first.
    expect(css()).toMatch(/\.bank-legs__name \{[^}]*-webkit-line-clamp: 2;/);
    expect(css()).toMatch(/\.bank-legs__col-num \{\s*width: 56px;/);
    expect(css()).toMatch(/\.bank-legs__table tr\[data-transit='true'\] td \{\s*color: var\(--t-text-dim\);/);
    expect(css()).toMatch(/\.bank-workspace\[data-dock='right'\] \{\s*grid-template-columns: minmax\(0, 1fr\) 8px var\(--bank-area-size/);
  });

  it('4: the row\'s Mehr opens in the overlay layer, its five ignore reasons whole and last, and its tooltip stays shut', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    const trigger = within(row).getByRole('button', { name: /^Weitere Aktionen für / });
    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(row.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Beleg anhängen',
      'Ignorieren: Wird anderswo gebucht',
      'Ignorieren: Läuft über ein Durchlaufkonto',
      'Ignorieren: Vor dem Start in TILL',
      'Ignorieren: Doppelt geliefert',
      'Ignorieren: Anderer Grund',
    ]);
    const tip = document.getElementById(trigger.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tip.closest('.tooltip')?.className ?? tip.className).not.toMatch(/is-open/);
  });

  it('5: a split names what is missing in the preview, never a dead end, and its via link is a quiet link with a tooltip', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen/ }));
    await waitFor(() => expect(document.querySelector('tr.bank-split-row--foot')).not.toBeNull());
    expect(within(panel()).getByRole('region', { name: 'So wird gebucht' })).toHaveTextContent('Konto wählen');
    expect(within(panel()).queryByText('Die Vorschau ist nicht verfügbar.')).toBeNull();
    const via = within(document.querySelector('tr.bank-split-row--foot') as HTMLElement).getByRole('button', { name: 'Über Durchlaufkonto buchen' });
    expect(via).toHaveClass('link-inline');
    expect(tipOf(via)).toMatch(/am Ende auf null/);
    // The split rows sit on the row's own columns: the same cells, in the same order.
    const cells = (tr: Element) => Array.from(tr.children).map((td) => td.className.replace(/bank-cell /, '').split(' ')[0]);
    expect(cells(document.querySelector('tr.bank-split-row[data-position="1"]') as Element)).toEqual(cells(rowOf('bt_fee')));
  });

  it('6: the row\'s Mehr in its own last column (D178 N2, the D177 ignore ×), and the field carries no clear × at all', async () => {
    renderBank(recording(canned([BOND, FEE])).transport);
    await rulesRead('bt_bond');
    const row = await rowReady('bt_fee');
    const last = row.lastElementChild as HTMLElement;
    expect(last).toHaveClass('bank-cell--ignore');
    expect(within(last).getByRole('button', { name: /^Weitere Aktionen für / })).toBeInTheDocument();
    expect(document.querySelector('.bank-table .picker-clear')).toBeNull();
  });

  it('7: Woher says "Regel …" with "Wechseln"; the foot is icons plus Buchen, "Agent fragen" under Mehr', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const woher = panel().querySelector('.bank-woher') as HTMLElement;
    expect(woher).toHaveTextContent(/Regel Bondigoo.*Wechseln/);
    const foot = panel().querySelector('.bank-panel__foot') as HTMLElement;
    const worded = within(foot)
      .getAllByRole('button')
      .filter((b) => (b.textContent ?? '').trim() !== '');
    // B5 judge (D178 N3): Aufteilen and Ignorieren in words beside the icons; Buchen stays the one commit.
    expect(worded.map((b) => b.textContent?.trim())).toEqual(['Aufteilen', 'Ignorieren', 'Buchen']);
    await userEvent.click(within(foot).getByRole('button', { name: /^Mehr zu / }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Agent fragen']);
  });

  it('8: the rule chip draws on the theme\'s soft ground, never an un-themed grey', () => {
    const rule = /\.bank-woher__name\.link-inline,\s*\.bank-woher__name \{([^}]*)\}/.exec(css())?.[1] ?? '';
    expect(rule).toMatch(/background: var\(--t-bg-soft\);/);
    expect(rule).toMatch(/color: var\(--t-text\);/);
  });

  it('10: every open row shows Buchen, disabled with its reason where it cannot book', async () => {
    renderBank(recording(canned([BOND, SHOP, FEE, OVER])).transport);
    await rulesRead('bt_bond');
    for (const id of ['bt_bond', 'bt_shop', 'bt_fee', 'bt_over']) {
      const book = bookOf(rowOf(id));
      if (book.getAttribute('aria-disabled') === 'true') expect(tipOf(book)).not.toBe('');
    }
    expect(tipOf(bookOf(rowOf('bt_fee')))).toBe('Konto wählen');
  });
});

/**
 * The second fresh-eyes UX judge round (FAIL, 13 items), one test or more per item. The judge's screenshots
 * were of a real-shaped book copy; here the structure each fix rests on is held.
 */
describe('D177 UX judge round 2', () => {
  const css = () => readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');

  it('1: an open tooltip and the Wechseln menu sit in the overlay layer, never clipped by the panel', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const computed = panel().querySelector('[data-computed="engine"]') as HTMLElement;
    const tipId = computed.getAttribute('aria-describedby') ?? '';
    // Shut, the bubble stays beside its trigger; open, it moves to the document's body, fixed and placed.
    expect(computed.closest('.tooltip-wrap')?.contains(document.getElementById(tipId))).toBe(true);
    act(() => computed.focus());
    await waitFor(() => expect(document.getElementById(tipId)?.parentElement).toBe(document.body));
    const bubble = document.getElementById(tipId) as HTMLElement;
    expect(bubble).toHaveClass('tooltip--portal');
    expect(bubble.style.position).toBe('fixed');
    expect(panel().contains(bubble)).toBe(false);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Wechseln' }));
    const menu = await screen.findByRole('menu');
    expect(panel().contains(menu)).toBe(false);
    expect(menu.closest('body > *')).not.toBeNull();
    // The placed list takes the focus, so Escape closes it and hands the focus back to "Wechseln".
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Wechseln' })).toHaveFocus();
    expect(css()).toMatch(/\.bank-list \{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/);
  });

  it('2: the Buchungstext is an auto-growing text area that keeps one line of text', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const text = within(panel()).getByRole('textbox', { name: 'Buchungstext' });
    expect(text.tagName).toBe('TEXTAREA');
    expect(text).toHaveAttribute('rows', '1');
    await userEvent.clear(text);
    await userEvent.type(text, 'Bondigoo{Enter} Oktober');
    expect(text).toHaveValue('Bondigoo Oktober');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.text).toBe('Bondigoo Oktober'));
    expect(css()).toMatch(/textarea\.field\.bank-panel__text-input \{[^}]*resize: none;/);
  });

  it('3: a rest of 0 is said once, quietly at the field, in one plain reason; no warn ink', async () => {
    const { transport } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, '15.12');
    await waitFor(() => expect(panel().querySelector('.bank-ask__note')).toHaveTextContent('Für 6700 bleibt nichts übrig'));
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(within(panel()).getByRole('region', { name: 'So wird gebucht' }).textContent ?? '').not.toMatch(/bleibt nichts übrig/);
    // Once on the panel's face (Buchen's tooltip is the second place, behind the hover).
    const face = panel().cloneNode(true) as HTMLElement;
    for (const el of face.querySelectorAll('[role="tooltip"]')) el.remove();
    expect((face.textContent ?? '').match(/bleibt nichts übrig/g)).toHaveLength(1);
    expect(/\.bank-ask__note \{([^}]*)\}/.exec(css())?.[1] ?? '').not.toMatch(/--t-warn/);
    expect(/\.bank-split__rest \{([^}]*)\}/.exec(css())?.[1] ?? '').not.toMatch(/--t-warn/);
  });

  it('4: the split shows its rest figure under Betrag: "Noch 2.00", then "Rest 0.00"', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen/ }));
    const foot = () => document.querySelector('.bank-split-row--foot .bank-cell--amount') as HTMLElement;
    await waitFor(() => expect(foot()).toHaveTextContent(/^Rest 0\.00$/));
    const first = document.querySelector('tr.bank-split-row[data-position="1"] .bank-cell--amount input') as HTMLInputElement;
    await userEvent.clear(first);
    await userEvent.type(first, '0.84');
    expect(foot()).toHaveTextContent(/^Noch 4\.16$/);
    expect(foot().querySelector('[data-over]')).toBeNull();
    await userEvent.clear(first);
    await userEvent.type(first, '6.00');
    expect(foot()).toHaveTextContent(/^Zu viel 1\.00$/);
    expect(foot().querySelector('[data-over="true"]')).not.toBeNull();
  });

  it('5: × is Ignorieren only: clearing is "Auswahl entfernen" in the picker, the split ends in words, a position goes with the Entfernen glyph', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.keyboard('6500{Enter}');
    await waitFor(() => expect(within(row).getByRole('button', { name: /^Buchen auf, / })).toHaveTextContent('6500'));
    await userEvent.keyboard('{Escape}');
    expect(row.querySelector('.picker-clear')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Auswahl entfernen/ }));
    await waitFor(() => expect(within(row).getByRole('button', { name: /^Buchen auf, / })).toHaveTextContent('Worauf buchen?'));
    // The split: no × in its foot; it ends with a labelled quiet button; a position's remove is the ring.
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen/ }));
    const foot = await present('tr.bank-split-row--foot');
    expect(foot.querySelector('[data-icon]')).toBeNull();
    expect(within(foot).getByRole('button', { name: 'Aufteilen beenden' })).toHaveClass('link-inline');
    await userEvent.click(screen.getByRole('button', { name: '+ Position' }));
    const remove = within(document.querySelector('tr.bank-split-row[data-position="2"]') as HTMLElement).getByRole('button', { name: 'Position entfernen' });
    expect(remove).toHaveAttribute('data-icon', 'remove');
    const ignoreGlyphs = Array.from(document.querySelectorAll('.bank-table [data-icon]')).map((b) => b.getAttribute('data-icon'));
    expect(ignoreGlyphs).not.toContain('close');
  });

  it('6 (D178 N2): the rule ★ is the source glyph inside the field, with the panel open too; no star button on the row', async () => {
    renderBank(recording(canned([BOND, FEE])).transport);
    await rulesRead('bt_bond');
    const glyph = () => rowOf('bt_bond').querySelector('.picker-trigger .bank-src[data-source="standard"]');
    expect(glyph()).not.toBeNull();
    expect(rowOf('bt_bond').querySelector('.bank-star')).toBeNull();
    await select('bt_bond');
    expect(glyph()).not.toBeNull();
    // Beside the panel the counterparty column narrows, so the account keeps its number.
    expect((document.querySelector('col.bank-col--party') as HTMLElement).style.width).toBe('128px');
  });

  it('7: a column grip draws only while hovered or focused (keyboard); at rest it draws nothing', () => {
    expect(/\.bank-col-resize::after \{([^}]*)\}/.exec(css())?.[1] ?? '').toMatch(/background: transparent;/);
    expect(css()).toMatch(/\.bank-col-resize:hover::after,\s*\.bank-col-resize:focus-visible::after \{/);
    expect(css()).not.toMatch(/\.bank-col-resize:focus::after/);
  });

  it('8: the rule editor says its route with account names, groups Erkennung and Buchung, a labelled rest radio, details behind a disclosure, no Abbrechen', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Regel Bondigoo' }));
    const editor = await present('.bank-rules__item[data-rule="bs_bond"] .bank-rule-form');
    expect(within(editor).getByRole('group', { name: 'Erkennung' })).toBeInTheDocument();
    const booking = within(editor).getByRole('group', { name: 'Buchung' });
    expect(Array.from(booking.querySelectorAll('.bank-rule-form__choice input')).map((r) => r.getAttribute('aria-label'))).toEqual(['Rest: 3400 Erlöse aus Dienstleistungen', 'Rest: 6700 Übriger betrieblicher Aufwand']);
    expect(within(booking).getAllByText('Bekommt den Rest')).toHaveLength(2);
    expect(editor.querySelector('.bank-rule-form__choice[data-checked="true"] input')).toBeChecked();
    // A leg's details sit behind a disclosure that says them in words; shut at rest.
    const more = editor.querySelectorAll('details.bank-rule-form__leg-more');
    expect(more.length).toBeGreaterThan(0);
    expect((more[0] as HTMLDetailsElement).open).toBe(false);
    expect(more[0]?.querySelector('summary')).toHaveTextContent(/^Berechnet: MWST 8\.1 % und Gebühr 9\.9 % vom Netto$/);
    expect(editor.textContent ?? '').not.toMatch(/UST81/);
    expect(within(editor).queryByRole('button', { name: 'Abbrechen' })).toBeNull();
    expect(within(editor).getByRole('button', { name: 'Schliessen' })).toHaveAttribute('data-icon', 'close');
    expect(css()).toMatch(/\.bank-rule-form__foot \{[^}]*border-top: 1px solid var\(--t-border\);/);
    // The sheet's own line for the rule reads in account names.
    const item = document.querySelector('.bank-rules__item[data-rule="bs_bond"]') as HTMLElement;
    expect(Array.from(item.querySelectorAll('.bank-rules__route-line')).map((l) => l.textContent)).toEqual([
      '3400 Erlöse aus Dienstleistungen: berechnet aus MWST 8.1 % und Gebühr 9.9 % vom Netto',
      'Rest: 6700 Übriger betrieblicher Aufwand',
    ]);
  });

  it('9: "berechnen" is a 32px ghost button', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz');
    await userEvent.clear(field);
    await userEvent.type(field, '91.20');
    const again = within(panel()).getByRole('button', { name: 'berechnen' });
    expect(again).toHaveClass('btn', 'btn--ghost', 'btn--sm');
    expect(again).not.toHaveClass('link-inline');
  });

  it('10: a disabled Buchen stays, plainly unlike an enabled secondary; DESIGN.md states the D177 rule', async () => {
    renderBank(recording(canned([FEE])).transport);
    const book = bookOf(await rowReady('bt_fee'));
    expect(book).toHaveAttribute('aria-disabled', 'true');
    expect(tipOf(book)).toBe('Konto wählen');
    const rule = /\.bank-row__book\[aria-disabled='true'\],[^{]*\{([^}]*)\}/.exec(css())?.[1] ?? '';
    expect(rule).toMatch(/color: var\(--t-text-faint\);/);
    expect(rule).toMatch(/border-style: dashed;/);
    expect(rule).toMatch(/cursor: not-allowed;/);
    const design = readFileSync(resolve(process.cwd(), '../brand/DESIGN.md'), 'utf8');
    expect(design).toMatch(/\*\*Amended by D177:\*\* a\s+commit that cannot act yet stays in its place, DISABLED and saying why/);
    expect(design).not.toMatch(/absent rather than disabled when the control that unlocks it/);
  });

  it('12: the selected row\'s Buchen steps aside while the panel\'s shows; the status line goes by itself', async () => {
    const { transport } = recording(canned([BOND, FEE]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    expect(within(rowOf('bt_bond')).queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Buchen' })).toBeInTheDocument();
    expect(within(rowOf('bt_fee')).getByRole('button', { name: 'Buchen' })).toBeInTheDocument();
    // The status line: gone on the next click outside it.
    await userEvent.click(within(rowOf('bt_fee')).getByRole('button', { name: /^Weitere Aktionen für / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ignorieren: Wird anderswo gebucht' }));
    const status = await screen.findByText(/Ignoriert: Kontoführung Seebank/);
    await userEvent.click(within(rowOf('bt_bond')).getAllByRole('cell')[0] as HTMLElement);
    await waitFor(() => expect(status).not.toBeInTheDocument());
  });

  it('12: the status line goes by itself after a few seconds', async () => {
    const { STATUS_DISMISS_MS } = await import('./Bank');
    expect(STATUS_DISMISS_MS).toBe(6000);
    const { transport } = recording(canned([FEE]));
    renderBank(transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ignorieren: Wird anderswo gebucht' }));
    const status = await screen.findByText(/Ignoriert: Kontoführung Seebank/);
    await waitFor(() => expect(status).not.toBeInTheDocument(), { timeout: STATUS_DISMISS_MS + 2000 });
  }, 15_000);

  it('12: the rules sheet says its intro and what a Vorlage is behind (i), never as printed prose', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await userEvent.click(screen.getByRole('button', { name: /^Buchungsregeln/ }));
    const sheet = await present('.bank-rules__group');
    const drawer = sheet.closest('.drawer-body') ?? document.body;
    expect(visibleProse(drawer as HTMLElement).join(' ')).not.toMatch(/schlägt nur vor|wiederkehrenden Buchungssatz/);
    const infos = Array.from(drawer.querySelectorAll('.bank-rules__head--group [data-icon="info"]'));
    expect(infos.map((b) => tipOf(b))).toEqual(['Eine Buchungsregel schlägt nur vor. Gebucht wird erst auf deinen Klick.', 'Eine Vorlage bucht einen wiederkehrenden Buchungssatz im Journal.']);
  });

  it('13: the bulk button counts sure lines only, never a computed or an asked rule line (none is sure on the judge\'s copy)', async () => {
    renderBank(recording(canned([BOND, SHOP, FEE])).transport);
    await rulesRead('bt_bond');
    expect(screen.queryByRole('button', { name: /Alle vorgeschlagenen buchen/ })).toBeNull();
  });
});

/**
 * The final fresh-eyes judge (FAIL, 3 items and a LOW list), one test or more per item.
 */
describe('D177 final judge', () => {
  it('FAIL 1: a rest of 0 keeps the preview\'s usual lines and sides, the rest as 0.00 on its side, no "?"', async () => {
    const { transport, calls } = recording(canned([BOND]));
    renderBank(transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const field = within(panel()).getByLabelText('Bruttoumsatz') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, '15.12');
    const legs = () => within(panel()).getByRole('region', { name: 'So wird gebucht' });
    await waitFor(() => expect(legs().querySelector('tr[data-zero="true"]')).not.toBeNull());
    // The rule WITHOUT its rest leg went to the engine: one leg, the whole line.
    expect(calls.some((c) => c.action === 'compose_entry' && (c.input.target as { kind?: string }).kind === 'accounts')).toBe(true);
    const rows = Array.from(legs().querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim()));
    expect(rows.map((r) => r[0]?.slice(0, 4))).toEqual(['1020', '3400', '2200', '6700']);
    expect(legs().textContent ?? '').not.toMatch(/\?/);
    // The rest books against the line with the engine's figures (90.80 > 15.12): Soll, as in the valid state.
    expect(rows[3]).toEqual([expect.stringMatching(/^6700/), '0.00', '']);
  });

  it('FAIL 1: the reason matches what the engine refuses: only a rest of exactly 0 (a negative rest books)', async () => {
    const src = readFileSync(resolve(process.cwd(), '../src/core/banking/bankBooking.ts'), 'utf8');
    expect(src).toMatch(/if \(rest === 0\) return \{ error: err\('rest_is_zero'/);
    expect(src).not.toMatch(/rest < 0\) return \{ error/);
  });

  it('FAIL 2: a position goes with a MINUS ("Position entfernen"), never a cross; the Durchlaufkonto goes through its picker', async () => {
    renderBank(recording(canned([FEE])).transport);
    const row = await rowReady('bt_fee');
    await userEvent.click(within(row).getByRole('button', { name: /^Buchen auf, / }));
    await userEvent.click(await screen.findByRole('option', { name: /Aufteilen/ }));
    await waitFor(() => expect(document.querySelector('tr.bank-split-row--foot')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '+ Position' }));
    const remove = within(document.querySelector('tr.bank-split-row[data-position="2"]') as HTMLElement).getByRole('button', { name: 'Position entfernen' });
    expect(tipOf(remove)).toBe('Position 2');
    // The glyph: a ring and ONE horizontal stroke, no diagonal.
    const paths = Array.from(remove.querySelectorAll('path')).map((p) => p.getAttribute('d') ?? '');
    expect(paths).toEqual(['M8.5 12h7']);
    // The Durchlaufkonto row carries no glyph of its own; "Ohne Durchlaufkonto" is in its picker.
    await userEvent.click(screen.getByRole('button', { name: 'Über Durchlaufkonto buchen' }));
    const via = await present('tr.bank-split-row--via');
    expect(via.querySelector('.bank-cell--ignore [data-icon]')).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: /Ohne Durchlaufkonto/ }));
    await waitFor(() => expect(document.querySelector('tr.bank-split-row--via')).toBeNull());
    const design = readFileSync(resolve(process.cwd(), '../brand/DESIGN.md'), 'utf8');
    expect(design).toMatch(/\| minus in a ring \| Position entfernen \|/);
  });

  it('FAIL 3: the panel scroll area fades its bottom edge only while content continues below the foot', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const scroll = panel().querySelector('.bank-panel__scroll') as HTMLElement;
    let top = 0;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => top });
    fireEvent.scroll(scroll);
    await waitFor(() => expect(scroll).toHaveAttribute('data-more', 'true'));
    top = 200;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(scroll).not.toHaveAttribute('data-more'));
    const css = readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');
    expect(/\.bank-panel__scroll\[data-more='true'\] \{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/mask-image: linear-gradient\(to bottom, var\(--t-bg-elev\) calc\(100% - var\(--t-space-4\)\)/);
    // Polish 2: the foot's hairline steps up while there is more, a clear cue without a shadow.
    expect(css).toMatch(/\.bank-panel__body:has\(\.bank-panel__scroll\[data-more='true'\]\) \.bank-panel__foot \{\s*border-top-color: var\(--t-border-strong\);/);
    // The 1280x800 fit: the middle breathes at 8px, a preview row 2px above and below.
    expect(/\.bank-panel__scroll \{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/gap: var\(--t-space-1\);/);
    expect(/\.bank-legs__table td \{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/padding: 2px 0;/);
  });

  it('LOW a, b, polish 1: the formula tooltip opens left of its trigger, and an open bubble keeps 8px off its trigger', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    const computed = panel().querySelector('[data-computed="engine"]') as HTMLElement;
    expect(document.getElementById(computed.getAttribute('aria-describedby') ?? '')).toHaveClass('tooltip-left');
    const tooltip = readFileSync(resolve(process.cwd(), 'src/components/Tooltip.tsx'), 'utf8');
    expect(tooltip).toMatch(/const gap = 8;/);
  });

  it('LOW c: the text condition is removed by a button that says so', async () => {
    renderBank(recording(canned([BOND])).transport);
    await rulesRead('bt_bond');
    await select('bt_bond');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Regel Bondigoo' }));
    const editor = await present('.bank-rules__item[data-rule="bs_bond"] .bank-rule-form');
    expect(within(editor).getByRole('button', { name: 'Bedingung entfernen' })).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Ohne Text' })).toBeNull();
  });

  it('LOW f: the panel scroll area keeps 24px under its last line, so no text sits on the foot hairline', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/surfaces/Bank/Bank.css'), 'utf8');
    expect(/\.bank-panel__scroll \{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/padding-bottom: var\(--t-space-3\);/);
  });

  it('LOW g (B5): the foot says Aufteilen in words; the glyph stays in the vocabulary for the row', async () => {
    renderBank(recording(canned([FEE])).transport);
    await select('bt_fee');
    const split = within(panel().querySelector('.bank-panel__foot') as HTMLElement).getByRole('button', { name: 'Aufteilen' });
    expect(split.textContent?.trim()).toBe('Aufteilen');
    const design = readFileSync(resolve(process.cwd(), '../brand/DESIGN.md'), 'utf8');
    expect(design).toMatch(/\| a line forking in two \| Aufteilen \|/);
  });

  it('polish 3: a row Buchen tip opens below Buchen, its left edge at Buchen, never over another row', async () => {
    renderBank(recording(canned([BOND, FEE])).transport);
    await rulesRead('bt_bond');
    const book = bookOf(await rowReady('bt_fee'));
    expect(tipOf(book)).toBe('Konto wählen');
    const tip = document.getElementById((book.getAttribute('aria-describedby') ?? '').split(' ')[0] ?? '') as HTMLElement;
    expect(tip.closest('[role="tooltip"]') ?? tip).toHaveClass('tooltip-bottom');
  });
});
