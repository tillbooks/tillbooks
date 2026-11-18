/**
 * D195 (owner, mockup v12 of 12.11.2026): THE ROW IS THE EDITOR, the default layout (`bank.detail_position =
 * inline`).
 *
 *   - every open row: pick box, date, counterparty with its bank text, "Buchen auf" (a quiet account control and
 *     the editable Buchungstext), MWST (the shared Select), the signed amount, the check (Buchen) and Mehr;
 *   - a click on anything not editable opens the strip under the row; the controls never do;
 *   - Mehr holds exactly Ignorieren, Als Regel speichern, Mit Buchung abgleichen, Beleg anhängen, Agent fragen;
 *     Ignorieren is one click with the workspace's `bank.ignore_default_reason` (D196);
 *   - the account picker: Vorlage für Umsatz (a settlement template, money in), the counterparty's rules, the
 *     accounts, Offene Rechnung zuordnen (n), Aufteilen; a preset shows its name and MWST fixed words;
 *   - MWST is chosen in the row and books with the check; it is orange when the receipt's VAT differs;
 *   - the strip: the bank's text and Valuta, Soll/Haben directly at two lines, behind "Soll und Haben (n)" when
 *     longer, the receipt with "Beleg lesen" when unread, "Beleg anhängen" without one;
 *   - a payout's composition renders nothing until `settlement_payout_for_bank_line` answers one match.
 *
 * SYNTHETIC DATA ONLY: every name, IBAN, file and figure here is invented.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Bank from './index';
import { payoutMatchOf } from './PayoutComposition';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function account(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}
const BANK_LEDGER = account('1020');
const CLEARING = account('1060');
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };
const TAX = [
  { code: 'VST-I', kind: 'input', rateBp: 810, label: 'Vorsteuer Investitionen und übriger Betriebsaufwand', formLine: '405', active: true },
  { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz', formLine: '303', active: true },
];

function line(id: string, over: Record<string, unknown> = {}) {
  return {
    attention: 'needs',
    receiptCount: 0,
    needsReceipt: false,
    bankTxnId: id,
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-10-14',
    valueDate: '2026-10-13',
    amountMinor: -4_210,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: `Probe ${id}`, iban: null },
    remittance: { text: `Text ${id}`, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: 'ZR-0001',
    creditId: null,
    decision: null,
    proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    belegCandidates: [],
    ...over,
  };
}

/** Wolkenhaus: a learned booking to 6500 with VST-I. */
const CLOUD = line('bt_cloud', {
  attention: 'learned',
  counterparty: { name: 'Wolkenhaus Hosting AG', iban: null },
  remittance: { text: 'Hosting Oktober', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  proposal: {
    target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 4_210, taxCode: 'VST-I' }] },
    certainty: 'learned',
    reasonCode: 'history',
    reasonParams: { accountId: account('6500'), taxCode: 'VST-I', lastDate: '2026-09-14', count: 4 },
    vatCode: 'VST-I',
  },
});
/** A payout coming in from a processor. */
const PAYOUT = line('bt_payout', {
  amountMinor: 2_375,
  creditDebit: 'CRDT',
  counterparty: { name: 'Zahlhaus Payments', iban: null },
  remittance: { text: 'ZAHLHAUS PAYOUT 41', referenceKind: 'NON', referenceValue: null, endToEndId: null },
});
/** A line TILL has nothing for. */
const OPEN = line('bt_open', { counterparty: { name: 'Unbekannt Muster', iban: null } });

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

/** The engine's composition of a one-account booking with VAT: net and Vorsteuer against the bank. */
const COMPOSED = ok({
  mode: 'expand',
  composed: true,
  stamped: false,
  lines: [
    { account: account('6500'), debit: 3_895, credit: 0 },
    { account: account('1171'), debit: 315, credit: 0 },
    { account: BANK_LEDGER, debit: 0, credit: 4_210 },
  ],
  captions: [{ kind: 'vat', account: account('1171') }],
  verdict: { ok: true },
});

function canned(lines: unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: (input) => {
      const status = input.status as string;
      const mine = lines.filter((l) => (l as { state: string }).state === status || status === 'all');
      return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY], bulkLearnedMin: null });
    },
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: TAX }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    get_settlement_template: ok({ templates: [{ templateId: 'st_tpl_1', system: 'zahlhaus', processor: 'zahlhaus', template: { clearingAccountId: CLEARING, clearingAccountNumber: '1060', kinds: {} } }] }),
    compose_entry: COMPOSED,
    book_bank_line: ok({ state: 'booked', entryId: 'je_1', warnings: [] }),
    ignore_bank_line: ok({ state: 'ignored', warnings: [] }),
    files_list_linked: ok({ files: [] }),
    ...extra,
  };
}

function recording(c: Canned) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const entry = c[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { transport, calls };
}

const EVERY_RIGHT = [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles, CAP.readMasterData, CAP.readFileContent, 'manage_agent_dial', 'read_books', 'read_vat'];
const caps: Capabilities = {
  whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...EVERY_RIGHT] },
  can: (capability) => EVERY_RIGHT.includes(capability),
  refresh: () => undefined,
} as Capabilities;

function renderBank(transport: Transport) {
  return render(
    <CapabilitiesContext.Provider value={caps}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            {/* No preference stored: the default is the row editor. */}
            <PrefsProvider store={new PrefsStore(null, null, { useCache: false })}>
              <MemoryRouter initialEntries={['/bank']}>
                <Bank />
              </MemoryRouter>
            </PrefsProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

async function rowReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  return document.querySelector(`tr.bank-row[data-line="${id}"]`) as HTMLElement;
}
const stripOf = (id: string) => document.querySelector(`tr.bank-strip[data-strip-for="${id}"]`) as HTMLElement | null;
const cell = (row: HTMLElement, name: string) => row.querySelector(`.bank-cell--${name}`) as HTMLElement;

describe('D195 v12: the row is the editor (bank.detail_position = inline, the default)', () => {
  it('every open row carries its controls; no Sicherheit or paperclip column; amounts are signed', async () => {
    renderBank(recording(canned([CLOUD, PAYOUT, OPEN])).transport);
    const row = await rowReady('bt_cloud');
    expect(document.querySelector('table.bank-table')).toHaveAttribute('data-layout', 'inline');
    const heads = Array.from(document.querySelectorAll('table.bank-table thead th')).map((th) => th.textContent?.trim() ?? '');
    expect(heads).not.toContain('Sicherheit');
    expect(document.querySelector('.bank-cell--clip')).toBeNull();
    expect(within(row).getByRole('checkbox')).toBeInTheDocument();
    expect(within(cell(row, 'party')).getByText('Wolkenhaus Hosting AG')).toBeInTheDocument();
    expect(within(cell(row, 'party')).getByText('Hosting Oktober')).toBeInTheDocument();
    const target = within(row).getByRole('button', { name: /Buchen auf, Wolkenhaus Hosting AG/ });
    expect(target).toHaveTextContent('6500');
    expect(within(row).getByRole('textbox', { name: 'Buchungstext, Wolkenhaus Hosting AG' })).toBeInTheDocument();
    expect(within(row).getByRole('combobox', { name: 'MWST, Wolkenhaus Hosting AG' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Buchen' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Weitere Aktionen für Wolkenhaus Hosting AG/ })).toBeInTheDocument();
    expect(cell(await rowReady('bt_payout'), 'amount')).toHaveTextContent('+23.75');
    expect(cell(row, 'amount')).toHaveTextContent('42.10');
    expect(cell(row, 'amount').querySelector('.bank-amount__sign')).toHaveTextContent('\u2212');
  });

  it('a click on the date opens the strip under the row and again closes it; a click on a control never does', async () => {
    renderBank(recording(canned([CLOUD, OPEN])).transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Wolkenhaus Hosting AG/ }));
    expect(stripOf('bt_cloud')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(row).getByRole('textbox', { name: /Buchungstext/ }));
    expect(stripOf('bt_cloud')).toBeNull();
    await userEvent.click(cell(row, 'date'));
    await waitFor(() => expect(stripOf('bt_cloud')).not.toBeNull());
    expect(row).toHaveAttribute('data-selected', 'true');
    await userEvent.click(cell(row, 'date'));
    await waitFor(() => expect(stripOf('bt_cloud')).toBeNull());
  });

  it('Mehr holds exactly the five acts; Ignorieren is one click with the workspace default reason (D196)', async () => {
    const { transport, calls } = recording(
      canned([CLOUD, OPEN], { settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'bank.ignore_default_reason' ? 'duplicate' : null } }) }),
    );
    renderBank(transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für Wolkenhaus Hosting AG/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Ignorieren', 'Als Regel speichern', 'Mit Buchung abgleichen', 'Beleg anhängen', 'Agent fragen']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Ignorieren' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'ignore_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'ignore_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_cloud', reason: 'duplicate' });
  });

  it('the account picker: rules, accounts, Offene Rechnung zuordnen (n), Aufteilen; no Abgleichen or Ignorieren', async () => {
    renderBank(recording(canned([CLOUD, OPEN], { list_vendor_bills: ok({ bills: [{ id: 'vb_1', vendorReference: 'LR-77', vendorId: 'c_1', vendorName: 'Papeterie Bergli', openMinor: 4_210, currency: 'CHF' }] }) })).transport);
    const row = await rowReady('bt_open');
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Unbekannt Muster/ }));
    const groups = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.picker-pop [role="group"]')).map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(groups).toEqual(['Konten', 'Offene Rechnung zuordnen (1)', 'Weiteres']);
    const pop = document.querySelector('.picker-pop') as HTMLElement;
    expect(within(pop).getByRole('option', { name: /Aufteilen/ })).toBeInTheDocument();
    expect(within(pop).queryByRole('option', { name: /Ignorieren/ })).toBeNull();
    expect(within(pop).queryByRole('option', { name: /Abgleichen|Mit Buchung/ })).toBeNull();
  });

  it('money in with a settlement template: "Vorlage für Umsatz"; the preset shows its name, MWST fixed words, and books the clearing account', async () => {
    const { transport, calls } = recording(canned([PAYOUT, OPEN]));
    renderBank(transport);
    const row = await rowReady('bt_payout');
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Zahlhaus Payments/ }));
    const preset = await screen.findByRole('option', { name: /Abrechnung Zahlhaus/ });
    expect(screen.getByRole('option', { name: 'Ohne Vorlage, normal buchen' })).toBeInTheDocument();
    await userEvent.click(preset);
    const control = within(row).getByRole('button', { name: /Buchen auf, Zahlhaus Payments/ });
    expect(control).toHaveTextContent('Abrechnung Zahlhaus');
    expect(cell(row, 'vat')).toHaveTextContent('in der Abrechnung');
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input).toMatchObject({ bankTxnId: 'bt_payout', target: { kind: 'accounts', legs: [{ accountId: CLEARING, amountMinor: 2_375 }] } });
    expect((calls.find((c) => c.action === 'book_bank_line')?.input.target as { legs: { taxCode?: string }[] }).legs[0]?.taxCode).toBeUndefined();
  });

  it('MWST is chosen in the row with the shared Select and books with the check; the typed Buchungstext rides along', async () => {
    const { transport, calls } = recording(canned([CLOUD, OPEN]));
    renderBank(transport);
    const row = await rowReady('bt_cloud');
    const vat = within(row).getByRole('combobox', { name: 'MWST, Wolkenhaus Hosting AG' });
    // The row says the short name; the open list says the full one with its Ziffer.
    expect(vat).toHaveTextContent(/^Vorsteuer 8\.1 %$/);
    await userEvent.click(vat);
    expect(await screen.findByRole('option', { name: /Vorsteuer 8\.1 % \(Betrieb\), Ziffer 405/ })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'Ohne MWST' }));
    const text = within(row).getByRole('textbox', { name: 'Buchungstext, Wolkenhaus Hosting AG' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Hosting Oktober, Server');
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    const sent = calls.find((c) => c.action === 'book_bank_line')?.input as { target: { legs: { taxCode?: string }[] }; text?: string };
    expect(sent.target.legs[0]?.taxCode).toBeUndefined();
    expect(sent.text).toBe('Hosting Oktober, Server');
  });

  it('MWST is orange when the receipt says another VAT (vatCheck differs)', async () => {
    renderBank(recording(canned([{ ...CLOUD, vatCheck: 'differs' }])).transport);
    const row = await rowReady('bt_cloud');
    expect(row.querySelector('.bank-quiet-select--warn')).not.toBeNull();
  });

  it('the strip: the bank text and Valuta, the source, Soll and Haben directly at two lines, "Beleg anhängen" without a receipt', async () => {
    renderBank(recording(canned([CLOUD])).transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(cell(row, 'date'));
    const strip = await waitFor(() => {
      const s = stripOf('bt_cloud');
      expect(s).not.toBeNull();
      return s as HTMLElement;
    });
    // The row already shows the bank text under the counterparty: the strip starts at the Valuta.
    expect(within(strip).queryByText('Hosting Oktober')).toBeNull();
    expect(within(strip).getByText('13.10.2026')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Referenz ZR-0001 kopieren' })).toBeInTheDocument();
    await waitFor(() => expect(within(strip).getByText('6500 / 1020')).toBeInTheDocument());
    expect(within(strip).getByText('1171 / 1020')).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: /Soll und Haben/ })).toBeNull();
    expect(within(strip).getByRole('button', { name: 'Beleg anhängen' })).toBeInTheDocument();
    expect(strip).not.toHaveTextContent(/Betrag stimmt|Zahlen stimmen|vom Agenten gelesen/);
  });

  it('the strip shows the bank text when it says more than the row (a longer statement text)', async () => {
    const longer = { ...CLOUD, facts: { bankText: 'Online-Einkauf Debitkarte, WOLKENHAUS.CH, Hosting Oktober' } };
    renderBank(recording(canned([longer])).transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(cell(row, 'date'));
    expect(await screen.findByText('Online-Einkauf Debitkarte, WOLKENHAUS.CH, Hosting Oktober')).toBeInTheDocument();
  });

  it('the default Buchungstext has no "Bank:" prefix and is what an unedited booking sends', async () => {
    const { transport, calls } = recording(canned([CLOUD]));
    renderBank(transport);
    const row = await rowReady('bt_cloud');
    expect(within(row).getByRole('textbox', { name: 'Buchungstext, Wolkenhaus Hosting AG' })).toHaveValue('Wolkenhaus Hosting AG, Hosting Oktober');
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input.text).toBe('Wolkenhaus Hosting AG, Hosting Oktober');
  });

  it('more than two Soll/Haben lines stay behind "Soll und Haben (n)"', async () => {
    const three = ok({
      mode: 'expand',
      composed: true,
      stamped: false,
      lines: [
        { account: account('6500'), debit: 2_000, credit: 0 },
        { account: account('6900'), debit: 1_895, credit: 0 },
        { account: account('1171'), debit: 315, credit: 0 },
        { account: BANK_LEDGER, debit: 0, credit: 4_210 },
      ],
      captions: [],
      verdict: { ok: true },
    });
    renderBank(recording(canned([CLOUD], { compose_entry: three })).transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(cell(row, 'date'));
    const toggle = await screen.findByRole('button', { name: 'Soll und Haben (3)' });
    expect(screen.queryByText('6900 / 1020')).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText('6900 / 1020')).toBeInTheDocument();
  });

  it('a receipt shows its name and its thumbnail; an unread one offers "Beleg lesen"', async () => {
    const withReceipt = { ...CLOUD, receiptCount: 1, vatCheck: 'unread' };
    renderBank(recording(canned([withReceipt], { files_list_linked: ok({ files: [{ id: 'file_1', filename: 'wolkenhaus-oktober.pdf' }] }) })).transport);
    const row = await rowReady('bt_cloud');
    await userEvent.click(cell(row, 'date'));
    expect(await screen.findByText('wolkenhaus-oktober.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beleg wolkenhaus-oktober.pdf ansehen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beleg lesen' })).toBeInTheDocument();
  });

  it('a preset line shows no composition while the verb does not exist (no figure is made up)', async () => {
    const { transport, calls } = recording(canned([PAYOUT]));
    renderBank(transport);
    const row = await rowReady('bt_payout');
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Zahlhaus Payments/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Abrechnung Zahlhaus/ }));
    await userEvent.click(cell(row, 'date'));
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_payout_for_bank_line')).toBe(true));
    const strip = stripOf('bt_payout') as HTMLElement;
    expect(strip.querySelector('.bank-payout')).toBeNull();
  });

  it('a preset line shows the payout composition the verb answers, each event in plain words', async () => {
    const answer = ok({
      bankTxnId: 'bt_payout',
      direction: 'in',
      amountMinor: 2_375,
      day: '2026-10-14',
      match: 'one',
      matches: [
        {
          system: 'zahlhaus',
          processor: 'zahlhaus',
          clearingAccountId: CLEARING,
          payoutEventId: 'ev_po',
          payoutId: 'po_41',
          day: '2026-10-14',
          amountMinor: -2_375,
          dayDistance: 0,
          composition: {
            basis: 'refs',
            previousPayoutDay: null,
            events: [
              { eventId: 'ev_1', kind: 'sale', day: '2026-10-11', amountMinor: 8_000, netMinor: 7_401, vatMinor: 599, feeWaived: null, test: false, coachVatRegistered: null, invoiceNumber: null },
              { eventId: 'ev_2', kind: 'processing_fee', day: '2026-10-11', amountMinor: -245, netMinor: -245, vatMinor: null, feeWaived: null, test: false, coachVatRegistered: null, invoiceNumber: null },
              { eventId: 'ev_3', kind: 'third_party_payout', day: '2026-10-12', amountMinor: -5_180, netMinor: -5_180, vatMinor: null, feeWaived: null, test: false, coachVatRegistered: null, invoiceNumber: null },
              { eventId: 'ev_4', kind: 'reserve', day: '2026-10-12', amountMinor: -200, netMinor: -200, vatMinor: null, feeWaived: null, test: false, coachVatRegistered: null, invoiceNumber: null },
            ],
            sumMinor: 2_375,
            residualMinor: 0,
            byKind: {},
          },
        },
      ],
    });
    expect(payoutMatchOf((answer.body as Record<string, unknown>))?.events).toHaveLength(4);
    renderBank(recording(canned([PAYOUT], { settlement_payout_for_bank_line: answer })).transport);
    const row = await rowReady('bt_payout');
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Zahlhaus Payments/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Abrechnung Zahlhaus/ }));
    await userEvent.click(cell(row, 'date'));
    const table = await screen.findByRole('table', { name: 'Auszahlung von Zahlhaus' });
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) => tr.textContent);
    expect(rows).toEqual(['Verkauf 11.10.2026, MWST 5.99+80.00', 'Kartengebühr−2.45', 'an Dritte−51.80', 'von Zahlhaus zurückbehalten−2.00', 'diese Auszahlung+23.75']);
  });
});
