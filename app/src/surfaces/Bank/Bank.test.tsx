/**
 * A2, the bank inbox at /bank: the surface against a fake engine.
 *
 * What is asserted, and why each one:
 *   - the load is a real read in flight (watchReads), never the default skeleton;
 *   - first run leads: no Bankkonto says so and links to creating one; no statement makes the import
 *     the primary action and gives it a drop zone;
 *   - each row says who acts next: a reference-proven line is ready to book, an unknown one asks
 *     where to book, and the agent's pending Vorschlag is ON its row ("Prüfen", the agent's target);
 *   - the balance line prints bank = books + open lines (L4) with the engine's own figures, and a
 *     difference with its hint;
 *   - the keyboard path books: target picker, type, Enter, the VAT picker follows, Enter, Buchen,
 *     and the write is the agent's verb (`book_bank_line`) with its idempotency key;
 *   - a refusal answers what, why and the fix on the line, and never offers another date (L5): a
 *     soft lock points to Perioden, a sealed period to ignoring the line;
 *   - an ignored line comes back only through `reopen_bank_line`, with a reason;
 *   - a refusal only the shared catalogue may word renders through the shared banner;
 *   - an import's warning (`not_day_end_statement`) is said in words;
 *   - panel modes switch and come back;
 *   - axe finds nothing on the settled surface.
 *
 * Every name, IBAN and figure is invented for this file.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { hang, watchReads } from '../../test-transport';
import { recordedOk } from '../../lib/test-support';
import Bank from './index';
/**
 * The chart is the engine's own `list_accounts` answer (A01's pinned recording), never hand-typed:
 * `test/accounts/studio-list-accounts-fixture.test.mjs` holds every suite that reads `list_accounts` to it.
 */
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

/** An account of the recorded chart, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}

/** The Bankkonto's ledger account: 1020 Bankkonto of the recorded chart. */
const BANK_LEDGER = account('1020');

const ACCOUNT = { id: 'ba_1', name: 'Zürichsee Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };

const ACCOUNTS: RestResponse = { status: 200, body: recordedOk(listAccountsFixture) };

const TAX = [
  { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Vorsteuer Material, Waren, Dienstleistungen', active: true },
  { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz', active: true },
];

function line(id: string, over: Record<string, unknown>) {
  return {
    bankTxnId: id,
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-09-23',
    valueDate: '2026-09-23',
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: null, iban: null },
    remittance: { text: null, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    ...over,
  };
}

const KAFI = line('bt_kafi', {
  amountMinor: 4_242,
  creditDebit: 'CRDT',
  counterparty: { name: 'Coworking Kafi AG', iban: null },
  remittance: { text: 'Zahlung R-2026-0034', referenceKind: 'QRR', referenceValue: '000000000000000000002026003', endToEndId: null },
  proposal: {
    target: { kind: 'open_item', documentId: 'doc_34' },
    certainty: 'sure',
    reasonCode: 'qr_reference_exact',
    reasonParams: { documentId: 'doc_34', number: 'R-2026-0034', openMinor: 4_242 },
    vatCode: null,
  },
});

const ALPINA = line('bt_alpina', {
  amountMinor: -8_990,
  counterparty: { name: 'Alpina Telecom AG', iban: 'CH2089144975321682466' },
  remittance: { text: 'Rechnung 09/2026', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
});

const CAFE = line('bt_cafe', {
  bookingDate: '2026-09-21',
  valueDate: '2026-09-21',
  amountMinor: -3_850,
  counterparty: { name: 'Café Seeblick', iban: null },
  remittance: { text: 'Kartenzahlung', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
});

const SUMMARY = {
  bankAccountId: 'ba_1',
  name: 'Zürichsee Geschäftskonto',
  iban: 'CH5604835012345678009',
  currency: 'CHF',
  ledgerAccountId: BANK_LEDGER,
  judgeable: true,
  reason: null,
  statementId: 'st_1',
  statementDate: '2026-09-24',
  // The three open lines sum to 42.42 - 89.90 - 38.50 = -85.98, so bank 10'782.72 = books 10'868.70 - 85.98.
  bankBalanceMinor: 1_078_272,
  ledgerBalanceMinor: 1_086_870,
  openCount: 3,
  openSumMinor: -8_598,
  differenceMinor: 0,
};

const VORSCHLAG = {
  actionId: 'act_1',
  status: 'pending',
  actor: 'till-cli',
  actionTool: 'book_bank_line',
  dialCapability: 'post',
  createdAt: '2026-09-25T09:00:00Z',
  payload: { workspaceId: 'ws_test', bankTxnId: 'bt_cafe', target: { kind: 'accounts', legs: [{ accountId: account('6700'), amountMinor: 3_850, taxCode: 'VST-M' }] } },
};

function inboxFor(lines: unknown[], summary: unknown[] = [SUMMARY]): Handler {
  return (input) => {
    const status = input.status as string;
    const mine = lines.filter((l) => (l as { state: string }).state === status);
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary });
  };
}

function happy(extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE]),
    list_accounts: ACCOUNTS,
    vat_codes: ok({ taxCodes: TAX }),
    list_open_items: ok({ items: [{ kind: 'document', documentId: 'doc_34', number: 'R-2026-0034', customerName: 'Coworking Kafi AG', openMinor: 4_242, currency: 'CHF' }] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [VORSCHLAG] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    vat_preview: ok({ netMinor: 8_316, taxMinor: 674, grossMinor: 8_990, kind: 'input', deductible: true, formLine: '400' }),
    ...extra,
  };
}

function renderBank(transport: Transport, path = '/bank') {
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
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

const rowOf = (name: RegExp) => screen.getByRole('row', { name });

/**
 * The lines and the option reads (chart, codes, open items, Vorschläge) land independently. The
 * Café line's "Prüfen" needs the Vorschläge, so once it shows, every option read has answered and a
 * row names its target from the lookups, not from a half-loaded state.
 */
async function settledRows() {
  await screen.findByRole('row', { name: /Café Seeblick/ });
  await waitFor(() => expect(within(rowOf(/Café Seeblick/)).getByRole('button', { name: 'Prüfen' })).toBeInTheDocument());
}

describe('the bank inbox', () => {
  it('LOADING: shows the skeleton while the inbox read is really in flight', async () => {
    const transport = watchReads(hang('list_bank_inbox', fakeTransport(happy())));
    renderBank(transport);
    await transport.started('list_bank_inbox');
    expect(screen.getAllByRole('status').some((s) => s.getAttribute('aria-busy') === 'true')).toBe(true);
  });

  it('first run without a Bankkonto says so and links to creating one', async () => {
    renderBank(fakeTransport(happy({ list_bank_accounts: ok({ bankAccounts: [] }) })));
    expect(await screen.findByText('Noch kein Bankkonto erfasst.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bankkonto erfassen' })).toHaveAttribute('href', '/bank-accounts?new=1');
  });

  it('without a statement, importing is the primary action and there is a drop zone', async () => {
    const empty = { ...SUMMARY, judgeable: false, reason: 'no_statement', statementId: null, statementDate: null, bankBalanceMinor: null, differenceMinor: null, openCount: 0, openSumMinor: 0 };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([], [empty]), list_drafted_actions: ok({ actions: [] }) })));
    expect(await screen.findByText('Noch kein Kontoauszug importiert.')).toBeInTheDocument();
    const importButtons = screen.getAllByRole('button', { name: 'Kontoauszug importieren' });
    expect(importButtons.some((b) => b.className.includes('btn--primary'))).toBe(true);
    expect(screen.getByText(/Kann nicht beurteilt werden: noch kein Kontoauszug/)).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('each row says who acts next, and the agent\'s Vorschlag awaiting approval is on its row', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    const kafi = rowOf(/Coworking Kafi AG/);
    expect(within(kafi).getByRole('button', { name: /Buchen auf, Coworking Kafi AG/ })).toHaveTextContent('R-2026-0034');
    expect(within(kafi).getByRole('button', { name: 'Buchen' })).toBeEnabled();

    const alpina = rowOf(/Alpina Telecom AG/);
    expect(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ })).toHaveTextContent('Worauf buchen?');
    expect(within(alpina).getByRole('button', { name: 'Buchen' })).toBeDisabled();

    const cafe = rowOf(/Café Seeblick/);
    expect(within(cafe).getByRole('button', { name: 'Prüfen' })).toBeInTheDocument();
    expect(within(cafe).getByRole('button', { name: /Buchen auf, Café Seeblick/ })).toHaveTextContent('6700');

    // Only the reference-proven line is offered to "Alle sicheren buchen"; the agent's is not.
    expect(screen.getByRole('button', { name: 'Alle sicheren buchen (1)' })).toBeInTheDocument();
  });

  it('the balance line reads bank = books + open lines in the engine\'s figures (L4)', async () => {
    renderBank(fakeTransport(happy()));
    const trust = await screen.findByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ });
    const text = trust.textContent ?? '';
    expect(text).toMatch(/10.782\.72/);
    expect(text).toMatch(/10.868\.70/);
    expect(text).toMatch(/85\.98/);
    expect(text).toContain('offene Zeilen');
    expect(text).toContain('Stimmt, bis auf die Zeilen, die noch zu buchen sind.');
    expect(text).not.toContain('Differenz');
  });

  it('names a difference in money, with what can cause it', async () => {
    // An entry of -42.00 on the bank ledger that no line backs: bank - books - open = 42.00.
    const differs = { ...SUMMARY, ledgerBalanceMinor: 1_086_870 - 4_200, differenceMinor: 4_200 };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], [differs]) })));
    const trust = await screen.findByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ });
    await waitFor(() => expect(trust.textContent ?? '').toContain('Bank und Buchhaltung weichen um CHF 42.00 ab.'));
    expect(trust.textContent ?? '').toContain('eine Buchung auf dem Bankkonto keine Bankzeile hat');
  });

  it('books from the keyboard: account, then VAT, then Buchen, through book_bank_line', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_1', remainder: null }));
    renderBank(fakeTransport(happy({ book_bank_line: book })));
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);
    await userEvent.click(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    expect(screen.getByRole('combobox')).toHaveFocus();
    await userEvent.keyboard('6500{Enter}');
    // The VAT picker follows on its own, with its search focused.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await userEvent.keyboard('VST-M{Enter}');
    const bookButton = within(rowOf(/Alpina Telecom AG/)).getByRole('button', { name: 'Buchen' });
    await waitFor(() => expect(bookButton).toHaveFocus());
    await userEvent.click(bookButton);
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    const input = book.mock.calls[0]?.[0] ?? {};
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      bankTxnId: 'bt_alpina',
      target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_990, taxCode: 'VST-M' }] },
    });
    expect(typeof input.idempotencyKey).toBe('string');
    expect(await screen.findByText(/Gebucht: Alpina Telecom AG/)).toBeInTheDocument();
  });

  it('a locked period answers what, why and the fix, and never books on another date (L5)', async () => {
    const spy = vi.fn<Handler>(() => refuse('period_locked', { period: '2026-09', kind: 'soft', reason: null }));
    renderBank(fakeTransport(happy({ book_bank_line: spy })));
    const kafi = await screen.findByRole('row', { name: /Coworking Kafi AG/ });
    await userEvent.click(within(kafi).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/September 2026/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zu den Perioden' })).toHaveAttribute('href', '/periods');
    expect(screen.queryByRole('button', { name: /01\.10\.2026/ })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('date');
  });

  it('a sealed period offers to ignore the line as booked elsewhere', async () => {
    renderBank(fakeTransport(happy({ book_bank_line: refuse('period_locked', { period: '2026-09', kind: 'hard', reason: 'vat_filed' }) })));
    const kafi = await screen.findByRole('row', { name: /Coworking Kafi AG/ });
    await userEvent.click(within(kafi).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/September 2026 ist abgeschlossen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Zeile ignorieren' }));
    expect(await screen.findByRole('heading', { name: 'Zeile ignorieren' })).toBeInTheDocument();
  });

  it('a refusal only the shared catalogue may word renders through the shared banner', async () => {
    renderBank(fakeTransport(happy({ book_bank_line: refuse('schema_newer_than_runtime', {}) })));
    const kafi = await screen.findByRole('row', { name: /Coworking Kafi AG/ });
    await userEvent.click(within(kafi).getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/von einem neueren TILL geschrieben/)).toBeInTheDocument();
  });

  it('picks lines and ignores them in one go, one ignore_bank_line per line', async () => {
    const ignore = vi.fn<Handler>(() => ok({ state: 'ignored' }));
    renderBank(fakeTransport(happy({ ignore_bank_line: ignore })));
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);
    await userEvent.click(within(alpina).getByRole('checkbox', { name: /Alpina Telecom AG/ }));
    await userEvent.click(within(rowOf(/Café Seeblick/)).getByRole('checkbox', { name: /Café Seeblick/ }));
    const bar = screen.getByRole('region', { name: 'Ausgewählte Zeilen' });
    expect(within(bar).getByText('2 Zeilen ausgewählt')).toBeInTheDocument();
    // Neither is ready to book: Alpina has no target yet, Café waits on the agent's Vorschlag.
    expect(within(bar).getByRole('button', { name: 'Buchen' })).toBeDisabled();
    await userEvent.click(within(bar).getByRole('button', { name: 'Ignorieren …' }));
    await userEvent.click(within(bar).getByRole('button', { name: '2 Zeilen ignorieren' }));
    await waitFor(() => expect(ignore).toHaveBeenCalledTimes(2));
    expect(ignore.mock.calls.map((c) => c[0].bankTxnId).sort()).toEqual(['bt_alpina', 'bt_cafe']);
    expect(ignore.mock.calls.every((c) => c[0].reason === 'booked_elsewhere' && typeof c[0].idempotencyKey === 'string')).toBe(true);
    expect(await screen.findByText(/2 Zeilen ignoriert/)).toBeInTheDocument();
  });

  it('select-all books only the lines that are ready and says how many stay', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_3', remainder: null }));
    renderBank(fakeTransport(happy({ book_bank_line: book })));
    // The Vorschlag reads must be in, so the Café line counts as waiting on the agent.
    await settledRows();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alle sichtbaren Zeilen auswählen' }));
    const bar = screen.getByRole('region', { name: 'Ausgewählte Zeilen' });
    expect(within(bar).getByText('3 Zeilen ausgewählt')).toBeInTheDocument();
    expect(within(bar).getByText(/2 Zeilen sind nicht durch eine Referenz belegt/)).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Sichere buchen (1)' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_kafi', target: { kind: 'open_item', documentId: 'doc_34' } });
  });

  it('brings an ignored line back only through reopen_bank_line, with a reason', async () => {
    const ignored = line('bt_ign', {
      state: 'ignored',
      amountMinor: -1_200,
      counterparty: { name: 'Parkhaus Seeplatz', iban: null },
      decision: { linkId: 'lk_2', targetKind: 'ignore', entryId: null, paymentId: null, ignoreReason: 'duplicate', note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' },
    });
    const reopen = vi.fn<Handler>(() => ok({ bankTxnId: 'bt_ign', previousState: 'ignored', state: 'open', reversedEntryIds: [], reversedPaymentIds: [], warnings: [] }));
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ignored]), list_drafted_actions: ok({ actions: [] }), reopen_bank_line: reopen })), '/bank?tab=ignored');
    const row = await screen.findByRole('row', { name: /Parkhaus Seeplatz/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Wieder zu buchen' }));
    const form = await screen.findByRole('form', { name: 'Wieder zu buchen' });
    expect(within(form).getByText(/gebucht wird nichts/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Wieder zu buchen' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(reopen.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_ign', reason: 'Versehentlich ignoriert' });
    expect(typeof reopen.mock.calls[0]?.[0].idempotencyKey).toBe('string');
    expect(await screen.findByText(/Parkhaus Seeplatz ist wieder zu buchen/)).toBeInTheDocument();
  });

  it('shows an agent\'s undecided reopen_bank_line Vorschlag on its DECIDED line, with its decision (critic L7)', async () => {
    const decided = { linkId: 'lk_5', targetKind: 'accounts', entryId: 'je_5', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' };
    const booked = line('bt_booked', { state: 'booked', amountMinor: -4_500, counterparty: { name: 'Druckerei Seefeld AG', iban: null }, decision: decided });
    const reopenVorschlag = { ...VORSCHLAG, actionId: 'act_9', actionTool: 'reopen_bank_line', payload: { workspaceId: 'ws_test', bankTxnId: 'bt_booked', reason: 'falsches Konto' } };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([booked]), list_drafted_actions: ok({ actions: [reopenVorschlag] }), get_entry: ok({ entry: { id: 'je_5', date: '2026-09-23', description: 'Bank' }, lines: [] }) })), '/bank?tab=booked');
    const panel = await screen.findByRole('complementary', { name: /Druckerei Seefeld AG/ });
    expect(await within(panel).findByText('Vorschlag des Agenten')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Freigeben' })).toBeInTheDocument();
  });

  it('re-critic L2/L3: a cross-month transfer and a paid run that differs offer nothing to book, and say the way that holds', async () => {
    const transfer = line('bt_tr', {
      amountMinor: 200_000,
      creditDebit: 'CRDT',
      counterparty: { name: 'Sparkonto Seefeld', iban: 'CH4431999123000889012' },
      proposal: { target: null, certainty: 'check', reasonCode: 'own_account_transfer_booked', reasonParams: { otherBankAccountId: 'ba_1', entryId: 'je_1', entryDate: '2026-09-30', daysApart: 1, candidates: 1, crossesMonth: true }, vatCode: null },
    });
    const run = line('bt_run', {
      amountMinor: -60_500,
      counterparty: { name: 'Sammelauftrag', iban: null },
      proposal: { target: null, certainty: 'check', reasonCode: 'payment_batch_total_differs', reasonParams: { batchId: 'pb_1', batchStatus: 'paid', batchTotalMinor: 60_000, lineAmountMinor: 60_500 }, vatCode: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([transfer, run]), list_drafted_actions: ok({ actions: [] }) })));
    const tr = await screen.findByRole('row', { name: /Sparkonto Seefeld/ });
    expect(within(tr).getByRole('button', { name: 'Buchen' })).toBeDisabled();
    await userEvent.click(within(tr).getAllByRole('cell')[2] as HTMLElement);
    expect(await screen.findByText(/in einem anderen Monat als diese Zeile/)).toBeInTheDocument();
    const rr = screen.getByRole('row', { name: /Sammelauftrag/ });
    expect(within(rr).getByRole('button', { name: 'Buchen' })).toBeDisabled();
    await userEvent.click(within(rr).getAllByRole('cell')[2] as HTMLElement);
    expect(await screen.findByText(/lässt sich nicht mehr verwerfen/)).toBeInTheDocument();
  });

  it('the pick bar books only the checked SURE lines: a line the person gave a target stays (spec §6, critic L6)', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_4', remainder: null }));
    renderBank(fakeTransport(happy({ book_bank_line: book, list_drafted_actions: ok({ actions: [] }) })));
    await screen.findByRole('row', { name: /Alpina Telecom AG/ });
    // Give Alpina a target by hand: bookable, but not reference-proven.
    await userEvent.click(within(rowOf(/Alpina Telecom AG/)).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    await userEvent.keyboard('6500{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(rowOf(/Alpina Telecom AG/)).getByRole('checkbox', { name: /Alpina Telecom AG/ }));
    await userEvent.click(within(rowOf(/Coworking Kafi AG/)).getByRole('checkbox', { name: /Coworking Kafi AG/ }));
    const bar = screen.getByRole('region', { name: 'Ausgewählte Zeilen' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Sichere buchen (1)' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_kafi' });
  });

  it("says an import's warning in words: a file that is not the day-end statement", async () => {
    const importCamt = vi.fn<Handler>(() => ok({ statementId: 'st_2', txnCount: 2, duplicate: false, skipped: [], warnings: ['not_day_end_statement'] }));
    renderBank(fakeTransport(happy({ import_camt: importCamt })));
    await settledRows();
    await userEvent.click(screen.getAllByRole('button', { name: 'Kontoauszug importieren' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    expect(importCamt.mock.calls[0]?.[0]).not.toHaveProperty('allowDuplicateEntries');
    expect(await screen.findByText(/Das ist kein Tagesendauszug/)).toBeInTheDocument();
  });

  it('warns before the commit when a leg books straight to a control account', async () => {
    // The recorded chart carries 2000 Verbindlichkeiten, the payable control account.
    renderBank(fakeTransport(happy()));
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);
    await userEvent.click(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    await userEvent.keyboard('2000{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByText(/Du buchst direkt auf 2000 Verbindlichkeiten/)).toBeInTheDocument();
  });

  it('switches the panel into a mode and back', async () => {
    renderBank(fakeTransport(happy()));
    const alpina = await screen.findByRole('row', { name: /Alpina Telecom AG/ });
    await userEvent.click(within(alpina).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Ignorieren/ }));
    expect(await screen.findByRole('heading', { name: 'Zeile ignorieren' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Zurück/ }));
    expect(screen.queryByRole('heading', { name: 'Zeile ignorieren' })).toBeNull();
  });

  it('a deep link to a line beyond the loaded page loads THAT line and selects it, never a substitute (critic M4)', async () => {
    const decided = { linkId: 'lk_9', targetKind: 'accounts', entryId: 'je_9', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-07-01T08:00:00Z' };
    const near = line('bt_near', { state: 'booked', amountMinor: -1_000, bookingDate: '2026-09-22', valueDate: '2026-09-22', counterparty: { name: 'Neuere Zeile AG', iban: null }, decision: decided });
    const far = line('bt_far', { state: 'booked', amountMinor: -2_500, bookingDate: '2026-07-01', valueDate: '2026-07-01', counterparty: { name: 'Alte Zeile GmbH', iban: null }, decision: { ...decided, linkId: 'lk_10' } });
    const inbox: Handler = (input) => {
      if (input.bankTxnId === 'bt_far') return ok({ lines: [far], nextCursor: null, total: 1, summary: [SUMMARY] });
      if (input.bankTxnId !== undefined) return ok({ lines: [], nextCursor: null, total: 0, summary: [SUMMARY] });
      // The loaded page of the booked tab holds only the newer line.
      const mine = input.status === 'booked' ? [near] : [];
      return ok({ lines: mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
    };
    renderBank(fakeTransport(happy({ list_bank_inbox: inbox, list_drafted_actions: ok({ actions: [] }) })), '/bank?tab=booked&line=bt_far');
    const panel = await screen.findByRole('complementary', { name: /Alte Zeile GmbH/ });
    expect(panel).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /Neuere Zeile AG/ })).toBeNull();
  });

  it('a deep link to a line that is not in this book says so and selects nothing (critic M4)', async () => {
    const decided = { linkId: 'lk_9', targetKind: 'accounts', entryId: 'je_9', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-07-01T08:00:00Z' };
    const near = line('bt_near', { state: 'booked', amountMinor: -1_000, counterparty: { name: 'Neuere Zeile AG', iban: null }, decision: decided });
    const inbox: Handler = (input) => {
      if (input.bankTxnId !== undefined) return ok({ lines: [], nextCursor: null, total: 0, summary: [SUMMARY] });
      const mine = input.status === 'booked' ? [near] : [];
      return ok({ lines: mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
    };
    renderBank(fakeTransport(happy({ list_bank_inbox: inbox, list_drafted_actions: ok({ actions: [] }) })), '/bank?tab=booked&line=bt_gone');
    expect(await screen.findByText('Diese Bankzeile gibt es hier nicht.')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /Neuere Zeile AG/ })).toBeNull();
  });

  it('A36: with an active EBICS channel, "Kontoauszüge abrufen" drives bank_sync with a fresh key and says what came in', async () => {
    const channel = { connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: '2026-09-24T18:00:00.000Z' };
    const bankSync = vi.fn<Handler>(() =>
      ok({ connectionId: 'ebconn_1', download: { outcome: 'downloaded' }, statements: [{ outcome: 'imported', final: true }, { outcome: 'already_imported', final: true }] }),
    );
    renderBank(fakeTransport(happy({ bank_channel_status: ok({ channels: [channel] }), bank_sync: bankSync })));
    await settledRows();
    expect(await screen.findByText('Zuletzt abgerufen: 24.09.2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Kontoauszüge abrufen' }));
    await waitFor(() => expect(bankSync).toHaveBeenCalledTimes(1));
    const input = bankSync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ workspaceId: 'ws_test', connectionId: 'ebconn_1' });
    expect(String(input.idempotencyKey)).toMatch(/^a36-press-ebconn_1-\d+$/);
    expect(await screen.findByText('Abgerufen: 1 Auszüge importiert, 0 warten.')).toBeInTheDocument();
  });

  it('A36C-1: a fetch that imported over a number jump says so, naming the skipped numbers', async () => {
    const channel = { connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: null };
    const jump = { after: { number: 1, year: 2026 }, statement: { number: 3, year: 2026 }, skipped: [{ year: 2026, from: 2, to: 2 }] };
    const bankSync = vi.fn<Handler>(() =>
      ok({ connectionId: 'ebconn_1', download: { outcome: 'downloaded' }, statements: [{ outcome: 'imported', final: true, notice: 'statement_number_jump', jump }] }),
    );
    renderBank(fakeTransport(happy({ bank_channel_status: ok({ channels: [channel] }), bank_sync: bankSync })));
    await settledRows();
    await userEvent.click(await screen.findByRole('button', { name: 'Kontoauszüge abrufen' }));
    await waitFor(() => expect(bankSync).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nach Auszug 1 kam Auszug 3\. Fehlende Nummern: 2\/2026\./)).toBeInTheDocument();
  });

  it('A36C-2: a successor-rule refusal at the hand door says the gap sentence and the way to the bank accounts, never "versuche es erneut"', async () => {
    const importCamt = vi.fn<Handler>(() =>
      refuse('gap_refused', {
        bankAccountId: 'ba_1',
        statementId: 'SYN-S',
        statement: { number: 3, year: 2026, fromDate: '2026-10-03', openingBalanceMinor: 100 },
        against: { number: 1, year: 2026, fromDate: '2026-10-01', toDate: '2026-10-01', openingBalanceMinor: 0, closingBalanceMinor: 50 },
        differenceMinor: 50,
        reason: 'balance_does_not_chain',
      }),
    );
    renderBank(fakeTransport(happy({ import_camt: importCamt })));
    await settledRows();
    await userEvent.click(screen.getAllByRole('button', { name: 'Kontoauszug importieren' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText(/Auszug 3 schliesst nicht an Auszug 1 an\./)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Zu den Bankkonten' })).toHaveAttribute('href', '/bank-accounts');
    expect(within(dialog).queryByText(/versuche es erneut/)).toBeNull();
  });

  it('A36C-1: the hand door says a number jump in words, naming the skipped numbers', async () => {
    const importCamt = vi.fn<Handler>(() =>
      ok({
        statementId: 'st_3',
        txnCount: 1,
        duplicate: false,
        skipped: [],
        warnings: ['statement_number_jump'],
        feed: {
          rule: 'successor',
          position: { year: 2026, number: 3 },
          jump: { after: { number: 1, year: 2026, fromDate: '2026-10-01', toDate: '2026-10-01', openingBalanceMinor: 0, closingBalanceMinor: 100 }, skipped: [{ year: 2026, from: 2, to: 2 }] },
        },
      }),
    );
    renderBank(fakeTransport(happy({ import_camt: importCamt })));
    await settledRows();
    await userEvent.click(screen.getAllByRole('button', { name: 'Kontoauszug importieren' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nach Auszug 1 kam Auszug 3\. Fehlende Nummern: 2\/2026\./)).toBeInTheDocument();
  });

  it('A36: no active EBICS channel, no fetch button; a fetch refusal renders through the shared banner in words', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    expect(screen.queryByRole('button', { name: 'Kontoauszüge abrufen' })).toBeNull();

    const channel = { connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: null };
    const refused = (): RestResponse => refuse('download_refused', { kind: 'not_granted', code: '090003' });
    renderBank(fakeTransport(happy({ bank_channel_status: ok({ channels: [channel] }), bank_sync: refused })));
    await userEvent.click(await screen.findByRole('button', { name: 'Kontoauszüge abrufen' }));
    expect(await screen.findByText(/gibt den Abruf der Auszüge \(camt\.053 Version 08\) für deinen Vertrag nicht frei \(Code 090003\)/)).toBeInTheDocument();
  });

  it('has no axe violations once settled', async () => {
    const transport = watchReads(fakeTransport(happy()));
    const { container } = renderBank(transport);
    await transport.started('list_bank_inbox');
    await screen.findByRole('row', { name: /Alpina Telecom AG/ });
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    expect(await axe(container)).toHaveNoViolations();
  });
});
