/**
 * D178 N3 (A39 §20): the booking modes on /bank against a fake engine. The list bar sends the direction, the
 * Zeitraum and the page to the engine and shows its honest count; the booking view is the person's
 * preference (focus by default, tabs, one field); Kontakt, Zuordnen (several invoices with the remainder)
 * and Spesen set the draft, `compose_entry` previews it, the footer says Betrag / verteilt / Abweichung and
 * Buchen waits with the ENGINE's sentence until the preview says it would book; the fee split applies and
 * dismisses; the FX counter-leg needs its acknowledgement; a decided line names its Belegnummer; focus steps
 * through the lines and can hide the list.
 *
 * Every name, IBAN, reference and figure in this file is invented.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Bank from './index';
import { bookCapability, bookTargetOf, draftTargetOf, isBookable, targetKey, type BankInboxLine, type DraftTarget } from './model';
import { figuresOf, paneOf, panesFor } from './BookingModes';
import { isoDateOrNull, periodInverted } from './ListControls';

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
    valueDate: '2026-10-15',
    amountMinor: 30_000,
    currency: 'CHF',
    creditDebit: 'CRDT',
    reversal: false,
    counterparty: { name: `Probe ${id}`, iban: null },
    remittance: { text: `Text ${id}`, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    ...over,
  };
}

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

function inbox(all: () => unknown[], extra: (input: Record<string, unknown>) => Record<string, unknown> = () => ({})): Handler {
  return (input) => {
    const status = input.status as string;
    const mine = all().filter((l) => (l as { state: string }).state === status || status === 'all');
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, directionCounts: { in: mine.length, out: 0 }, summary: [SUMMARY], ...extra(input) });
  };
}

const NOT_BOOKABLE = (code: string, de: string, over: Record<string, unknown> = {}) => ({
  mode: 'expand',
  composed: false,
  stamped: false,
  lines: [],
  captions: [],
  verdict: { ok: false, error: code },
  booking: {
    targetKind: 'x',
    bookable: false,
    blockedBy: code,
    verdict: { ok: false, error: code, sentence: { en: 'en words', 'de-CH': de } },
    deviationMinor: null,
    remainder: null,
    remainderOptions: [],
    documents: [],
    contact: null,
    claims: [],
    fx: null,
    entries: [],
    warnings: [],
    consequences: [],
    acknowledgementsRequired: [],
    ...over,
  },
});
const BOOKABLE = (over: Record<string, unknown> = {}) => ({
  mode: 'expand',
  composed: true,
  stamped: false,
  lines: [],
  captions: [],
  verdict: { ok: true },
  booking: {
    targetKind: 'x',
    bookable: true,
    blockedBy: null,
    verdict: { ok: true },
    deviationMinor: 0,
    remainder: null,
    remainderOptions: [],
    documents: [],
    contact: null,
    claims: [],
    fx: null,
    entries: [{ currency: 'CHF', lines: [{ account: BANK_LEDGER, debit: 30_000, accountNumber: '1020', currency: 'CHF', fxRate: null, baseDebit: 30_000, baseCredit: 0 }, { account: account('1100'), credit: 30_000, accountNumber: '1100', currency: 'CHF', fxRate: null, baseDebit: 0, baseCredit: 30_000 }] }],
    warnings: [],
    consequences: [],
    acknowledgementsRequired: [],
    ...over,
  },
});

function canned(all: () => unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inbox(all),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({
      items: [
        { kind: 'document', documentId: 'doc_1', number: 'RE-2026-101', customerId: 'c_1', customerName: 'Bergblick Möbel AG', openMinor: 20_000, currency: 'CHF' },
        { kind: 'document', documentId: 'doc_2', number: 'RE-2026-102', customerId: 'c_1', customerName: 'Bergblick Möbel AG', openMinor: 5_000, currency: 'CHF' },
      ],
    }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    list_payment_batches: ok({ batches: [] }),
    settings_get: ok({ setting: { key: 'bank.fx_mode', value: 'propose_split' } }),
    list_contacts: ok({ contacts: [{ id: 'c_1', name: 'Bergblick Möbel AG', partyRole: 'customer' }, { id: 'c_2', name: 'Talweg Druck GmbH', partyRole: 'vendor' }] }),
    expense_claim_list: ok({ claims: [{ id: 'cl_1', employeeName: 'Anna Probe', title: 'Zugreise Chur', status: 'approved', currency: 'CHF', totalBaseMinor: 12_000, approvedAt: '2026-10-10' }] }),
    compose_entry: ok(BOOKABLE()),
    book_bank_line: ok({ state: 'booked', warnings: [] }),
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

const RIGHTS = ['read_sales', 'post', 'pay', 'manage_files', 'read_master_data', 'read_file_content', 'manage_agent_dial', 'read_books', 'read_vat', 'hr.read', 'spesen.approve'];
const caps = {
  whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: RIGHTS },
  can: (c: string) => RIGHTS.includes(c),
  refresh: () => undefined,
} as unknown as Capabilities;

function prefs(seed: Record<string, string | number | boolean> = {}): PrefsStore {
  const store = new PrefsStore(null, null, { useCache: false });
  for (const [k, v] of Object.entries(seed)) store.seed(k, v);
  return store;
}

function renderBank(transport: Transport, store: PrefsStore = prefs(), path = '/bank') {
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

async function open(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  const row = document.querySelector<HTMLElement>(`tr.bank-row[data-line="${id}"]`) as HTMLElement;
  await userEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement);
  await waitFor(() => expect(document.querySelector(`[data-area-for="${id}"]`)).not.toBeNull());
  return document.querySelector(`[data-area-for="${id}"]`) as HTMLElement;
}
const area = () => document.querySelector('.bank-area') as HTMLElement;
const buchen = () => area().querySelector<HTMLButtonElement>('.bank-panel__book') as HTMLButtonElement;
const lastCompose = (calls: { action: string; input: Record<string, unknown> }[]) => [...calls].reverse().find((c) => c.action === 'compose_entry')?.input.target as Record<string, unknown> | undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the pure rules ---------------------------------------------------------------------------------------

describe('the new draft targets (A39 §17)', () => {
  it('send exactly the engine target and read back the same draft', () => {
    const alloc: DraftTarget = { kind: 'allocations', allocations: [{ documentId: 'doc_1', amountMinor: 20_000 }, { documentId: 'doc_2', amountMinor: 5_000 }], remainder: 'on_account' };
    expect(bookTargetOf(alloc)).toEqual({ kind: 'open_item', allocations: [{ documentId: 'doc_1', amountMinor: 20_000 }, { documentId: 'doc_2', amountMinor: 5_000 }], remainder: 'on_account' });
    expect(targetKey(draftTargetOf(bookTargetOf(alloc)))).toBe(targetKey(alloc));
    const contact: DraftTarget = { kind: 'contact', contactId: 'c_1', mode: 'anzahlung', overrideReason: ' Vertrag ' };
    expect(bookTargetOf(contact)).toEqual({ kind: 'contact', contactId: 'c_1', mode: 'anzahlung', overrideReason: 'Vertrag' });
    expect(bookTargetOf({ kind: 'contact', contactId: 'c_1', mode: null, overrideReason: '' })).toEqual({ kind: 'contact', contactId: 'c_1' });
    expect(bookTargetOf({ kind: 'expense_claims', claimIds: ['cl_1'] })).toEqual({ kind: 'expense_claims', claimIds: ['cl_1'] });
    const fx: DraftTarget = { kind: 'accounts', legs: [{ accountId: 'a', amountMinor: 9_237, taxCode: '', fx: { currency: 'USD', amountMinor: 10_000 } }], acknowledgeFx: true };
    expect(bookTargetOf(fx)).toEqual({ kind: 'accounts', legs: [{ accountId: 'a', amountMinor: 9_237, fx: { currency: 'USD', amountMinor: 10_000 } }], acknowledgeFx: true });
    expect(draftTargetOf(bookTargetOf(fx))).toEqual(fx);
    for (const t of [alloc, contact, { kind: 'expense_claims', claimIds: ['cl_1'] } as DraftTarget]) expect(bookCapability(t)).toBe('pay');
  });

  it('a differing contact mode needs its reason; an empty allocation is not bookable', () => {
    const l = line('bt_1') as unknown as BankInboxLine;
    expect(isBookable(l, { kind: 'contact', contactId: 'c_1', mode: 'anzahlung', overrideReason: '' })).toBe(false);
    expect(isBookable(l, { kind: 'contact', contactId: 'c_1', mode: null, overrideReason: '' })).toBe(true);
    expect(isBookable(l, { kind: 'allocations', allocations: [{ documentId: 'doc_1', amountMinor: 0 }], remainder: null })).toBe(false);
  });

  it('each target opens its own mode; Spesen is offered for money out only', () => {
    expect(paneOf({ kind: 'contact', contactId: 'c', mode: null, overrideReason: '' })).toBe('kontakt');
    expect(paneOf({ kind: 'allocations', allocations: [], remainder: null })).toBe('zuordnen');
    expect(paneOf({ kind: 'existing_entry', entryId: 'e', acceptDifference: false })).toBe('zuordnen');
    expect(paneOf({ kind: 'expense_claims', claimIds: ['x'] })).toBe('spesen');
    expect(paneOf(null)).toBeNull();
    expect(panesFor({ amountMinor: 100 })).toEqual(['konto', 'zuordnen', 'kontakt']);
    expect(panesFor({ amountMinor: -100 })).toContain('spesen');
  });

  it('the footer figures: typed legs sum here, a previewed target reads the engine deviation', () => {
    const l = line('bt_1') as unknown as BankInboxLine;
    expect(figuresOf(l, { kind: 'accounts', legs: [{ accountId: 'a', amountMinor: 25_000, taxCode: '' }] }, null)).toEqual({ amount: 30_000, distributed: 25_000, deviation: 5_000 });
    const pending = figuresOf(l, { kind: 'allocations', allocations: [{ documentId: 'doc_1', amountMinor: 20_000 }], remainder: null }, null);
    // Before the preview answers, the draft's own figures (B5 judge: never "…" beside a disabled Buchen).
    expect(pending).toEqual({ amount: 30_000, distributed: 20_000, deviation: 10_000 });
    expect(figuresOf(l, { kind: 'contact', contactId: 'c', mode: null, overrideReason: '' }, null)).toEqual({ amount: 30_000, distributed: 30_000, deviation: 0 });
  });

  it('the Zeitraum takes ISO dates only and knows an inverted range', () => {
    expect(isoDateOrNull('2026-10-01')).toBe('2026-10-01');
    expect(isoDateOrNull('1.10.2026')).toBeNull();
    expect(periodInverted('2026-10-31', '2026-10-01')).toBe(true);
    expect(periodInverted('2026-10-01', null)).toBe(false);
  });
});

// --- the list bar -----------------------------------------------------------------------------------------

describe('the list bar (A39 §20.4)', () => {
  it('sends the direction and the Zeitraum to the engine, counts honestly and pages past 200', async () => {
    const all = Array.from({ length: 437 }, (_, i) => line(`bt_${i}`));
    const { transport, calls } = recording(
      canned(() => all, {
        list_bank_inbox: (input) => {
          const off = (input.offset as number | undefined) ?? 0;
          const lim = input.limit as number;
          return ok({ lines: all.slice(off, off + lim), nextCursor: off + lim < all.length ? 'c' : null, total: all.length, directionCounts: { in: 300, out: 137 }, summary: [SUMMARY] });
        },
      }),
    );
    renderBank(transport, prefs(), '/bank?from=2026-10-01&to=2026-10-31&dir=out');
    await waitFor(() => expect(screen.getByText('1 bis 200 von 437')).toBeInTheDocument());
    const listCall = calls.find((c) => c.action === 'list_bank_inbox' && c.input.limit === 200);
    expect(listCall?.input).toMatchObject({ direction: 'out', from: '2026-10-01', to: '2026-10-31', status: 'open' });
    const group = screen.getByRole('radiogroup', { name: 'Richtung' });
    expect(within(group).getByRole('radio', { name: 'Belastungen (137)' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Gutschriften (300)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'list_bank_inbox' && c.input.offset === 200)).toBe(true));
    await waitFor(() => expect(screen.getByText('201 bis 400 von 437')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.getByText('401 bis 437 von 437')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    await waitFor(() => expect(screen.getByText('201 bis 400 von 437')).toBeInTheDocument());
  }, 30_000);

  it('an inverted Zeitraum says so and asks nothing with it', async () => {
    const all = [line('bt_1')];
    const { transport, calls } = recording(canned(() => all));
    renderBank(transport, prefs(), '/bank?from=2026-10-31&to=2026-10-01');
    await waitFor(() => expect(screen.getByText('«Von» liegt nach «Bis».')).toBeInTheDocument());
    expect(calls.filter((c) => c.action === 'list_bank_inbox').every((c) => c.input.from === undefined)).toBe(true);
  });
});

// --- the booking modes --------------------------------------------------------------------------------------

describe('the booking modes (A39 §20.1 to §20.3)', () => {
  it('Kontakt: picks a contact, previews it, Buchen waits with the engine sentence and books the contact target', async () => {
    const all = [line('bt_1')];
    let bookable = false;
    const { transport, calls } = recording(
      canned(() => all, {
        compose_entry: () =>
          ok(bookable ? BOOKABLE({ contact: { contactId: 'c_1', name: 'Bergblick Möbel AG', counterpartyKind: 'customer', mode: 'guthaben', settingMode: 'guthaben', overridden: false, accountNumber: '1100' } }) : NOT_BOOKABLE('needs_anzahlung_account', 'Das Konto 2030 fehlt. Lege es an.')),
      }),
    );
    renderBank(transport);
    await open('bt_1');
    const modes = within(area()).getByRole('radiogroup', { name: 'Buchungsart' });
    await userEvent.click(within(modes).getByRole('radio', { name: 'Kontakt' }));
    await waitFor(() => expect(within(area()).getByRole('button', { name: /^Kontakt/ })).not.toBeDisabled());
    await userEvent.click(within(area()).getByRole('button', { name: /^Kontakt/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Bergblick Möbel AG/ }));
    await waitFor(() => expect(lastCompose(calls)).toEqual({ kind: 'contact', contactId: 'c_1' }));
    await waitFor(() => expect(buchen()).toHaveAttribute('aria-disabled', 'true'));
    // The footer's figures and the engine's own sentence as Buchen's reason.
    expect(within(area()).getByText('Abweichung')).toBeInTheDocument();
    bookable = true;
    // Choosing Anzahlung (not the setting) asks a reason before it books.
    await userEvent.click(within(area()).getByRole('radio', { name: 'Anzahlung' }));
    await waitFor(() => expect(buchen()).toHaveAttribute('aria-disabled', 'true'));
    await userEvent.type(within(area()).getByRole('textbox', { name: 'Grund für die Abweichung vom Standard' }), 'Vorauszahlung laut Vertrag');
    await waitFor(() => expect(lastCompose(calls)).toEqual({ kind: 'contact', contactId: 'c_1', mode: 'anzahlung', overrideReason: 'Vorauszahlung laut Vertrag' }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(buchen());
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.target).toEqual({ kind: 'contact', contactId: 'c_1', mode: 'anzahlung', overrideReason: 'Vorauszahlung laut Vertrag' }));
  });

  it('Zuordnen: two invoices of one contact, the engine deviation, Buchen waits until a remainder is chosen', async () => {
    const all = [line('bt_1')];
    const { transport, calls } = recording(
      canned(() => all, {
        compose_entry: (input) => {
          const target = input.target as { remainder?: string };
          return target.remainder === 'on_account'
            ? ok(BOOKABLE({ deviationMinor: 5_000, remainderOptions: ['on_account'] }))
            : ok(NOT_BOOKABLE('deviation_needs_remainder', 'Es bleiben 50.00 übrig: wähle, was damit geschieht.', { deviationMinor: 5_000, remainderOptions: ['on_account'] }));
        },
      }),
    );
    renderBank(transport);
    await open('bt_1');
    await userEvent.click(within(within(area()).getByRole('radiogroup', { name: 'Buchungsart' })).getByRole('radio', { name: 'Zuordnen' }));
    await userEvent.click(within(area()).getByRole('checkbox', { name: /RE-2026-101/ }));
    await userEvent.click(within(area()).getByRole('checkbox', { name: /RE-2026-102/ }));
    await waitFor(() => expect(lastCompose(calls)).toEqual({ kind: 'open_item', allocations: [{ documentId: 'doc_1', amountMinor: 20_000 }, { documentId: 'doc_2', amountMinor: 5_000 }] }));
    await waitFor(() => expect(buchen()).toHaveAttribute('aria-disabled', 'true'));
    const deviation = area().querySelector('[data-figure="deviation"] dd') as HTMLElement;
    await waitFor(() => expect(deviation.textContent).toBe('50.00'));
    await userEvent.click(within(area()).getByRole('radio', { name: 'Als Guthaben' }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(buchen());
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.target).toMatchObject({ kind: 'open_item', remainder: 'on_account' }));
  });

  it('Spesen: a debit line settles an approved claim', async () => {
    const all = [line('bt_1', { amountMinor: -12_000, creditDebit: 'DBIT' })];
    const { transport, calls } = recording(canned(() => all, { compose_entry: ok(BOOKABLE()) }));
    renderBank(transport);
    await open('bt_1');
    await userEvent.click(within(within(area()).getByRole('radiogroup', { name: 'Buchungsart' })).getByRole('radio', { name: 'Spesen' }));
    await userEvent.click(await within(area()).findByRole('checkbox', { name: /Zugreise Chur/ }));
    await waitFor(() => expect(lastCompose(calls)).toEqual({ kind: 'expense_claims', claimIds: ['cl_1'] }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(buchen());
    await waitFor(() => expect(calls.find((c) => c.action === 'book_bank_line')?.input.target).toEqual({ kind: 'expense_claims', claimIds: ['cl_1'] }));
  });

  it('a flagged duplicate keeps Buchen disabled whatever the preview says', async () => {
    const all = [line('bt_1', { needsDuplicateDecision: true, possibleDuplicateOf: { bankTxnId: 'bt_0', reason: 'same_date' }, possibleDuplicates: [{ bankTxnId: 'bt_0', reason: 'same_date', format: 'csv', date: '2026-10-14', amountMinor: 30_000, currency: 'CHF' }] })];
    const { transport } = recording(canned(() => all));
    renderBank(transport);
    await open('bt_1');
    await userEvent.click(within(within(area()).getByRole('radiogroup', { name: 'Buchungsart' })).getByRole('radio', { name: 'Kontakt' }));
    await waitFor(() => expect(within(area()).getByRole('button', { name: /^Kontakt/ })).not.toBeDisabled());
    await userEvent.click(within(area()).getByRole('button', { name: /^Kontakt/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Bergblick Möbel AG/ }));
    // The preview answered bookable; the duplicate question still holds Buchen.
    await waitFor(() => expect(area().querySelector('.bank-booking-lines')).not.toBeNull());
    expect(buchen()).toHaveAttribute('aria-disabled', 'true');
  });

  it('the fee split E2 proposes applies to the chosen account and can be dismissed', async () => {
    const fee = account('6940' in Object.fromEntries(listAccountsFixture.accounts.map((a) => [a.number, 1])) ? '6940' : '6900');
    const rest = account('6500' in Object.fromEntries(listAccountsFixture.accounts.map((a) => [a.number, 1])) ? '6500' : '6000');
    const all = [
      line('bt_1', {
        amountMinor: -9_387,
        creditDebit: 'DBIT',
        proposal: {
          target: { kind: 'accounts', legs: [{ accountId: rest, amountMinor: 9_387 }] },
          certainty: 'check',
          reasonCode: 'history',
          reasonParams: {},
          vatCode: null,
          feeSplit: { mode: 'propose_split', feeMinor: 150, restMinor: 9_237, currency: 'CHF', feeAccountId: fee, restAccountId: rest, restTaxCode: null, legs: null, applied: false, origin: 'camt' },
        },
      }),
    ];
    const { transport } = recording(canned(() => all, { compose_entry: ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: true } }) }));
    renderBank(transport);
    await open('bt_1');
    expect(within(area()).getByText(/Gebühr CHF 1.50 abspalten/)).toBeInTheDocument();
    await userEvent.click(within(area()).getByRole('button', { name: 'Abspalten' }));
    await waitFor(() => expect(within(area()).getByText(/Gebühr CHF 1.50 auf .* abgespalten/)).toBeInTheDocument());
    const deviation = area().querySelector('[data-figure="deviation"] dd') as HTMLElement;
    expect(deviation.textContent).toBe('0.00');
    await userEvent.click(within(area()).getByRole('button', { name: 'Zurücknehmen' }));
    await userEvent.click(within(area()).getByRole('button', { name: 'Nein, danke' }));
    expect(within(area()).queryByText(/abspalten/)).toBeNull();
  });

  it('the FX counter-leg (bank.fx_mode transaction_currency) waits for the acknowledgement', async () => {
    const expense = account('6500' in Object.fromEntries(listAccountsFixture.accounts.map((a) => [a.number, 1])) ? '6500' : '6000');
    const all = [
      line('bt_1', {
        amountMinor: -9_237,
        creditDebit: 'DBIT',
        proposal: { target: { kind: 'accounts', legs: [{ accountId: expense, amountMinor: 9_237 }] }, certainty: 'check', reasonCode: 'history', reasonParams: {}, vatCode: null },
        facts: { bankCode: null, bankText: null, additionalInfo: null, entryInfo: null, refs: {}, instructed: { amountMinor: 10_000, currency: 'USD' }, exchange: { rate: '0.9237', effectiveRate: null, sourceCurrency: 'USD', targetCurrency: 'CHF' }, chargesTotal: null, fee: null },
      }),
    ];
    const { transport, calls } = recording(
      canned(() => all, {
        settings_get: ok({ setting: { key: 'bank.fx_mode', value: 'transaction_currency' } }),
        compose_entry: (input) =>
          (input.target as { acknowledgeFx?: boolean }).acknowledgeFx === true
            ? ok(BOOKABLE())
            : ok(NOT_BOOKABLE('fx_ack_required', 'Bestätige zuerst die Folgen.', { consequences: [{ code: 'fx_counter_leg', en: 'en', 'de-CH': 'Die Gegenbuchung läuft in USD zum effektiven Kurs.', reversibility: 'correctable' }], acknowledgementsRequired: ['fx_counter_leg'] })),
      }),
    );
    renderBank(transport);
    await open('bt_1');
    await userEvent.click(await within(area()).findByRole('checkbox', { name: /Gegenbuchung in USD 100.00/ }));
    await waitFor(() => expect(area().querySelector('.bank-fx__sentence')).toHaveTextContent('Die Gegenbuchung läuft in USD zum effektiven Kurs.'));
    // B5 judge: the card's facts beside the tick.
    expect(area().querySelector('[data-fx-facts]')).toHaveTextContent(/USD 100.00 · Kurs 0.9237/);
    expect(buchen()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(area()).getByRole('checkbox', { name: 'Ich habe die Folgen gelesen.' }));
    await waitFor(() => expect(lastCompose(calls)).toMatchObject({ acknowledgeFx: true, legs: [{ fx: { currency: 'USD', amountMinor: 10_000 } }] }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
  });

  it('a decided line names its entry by Belegnummer', async () => {
    const all = [line('bt_1', { state: 'booked', decision: { targetKind: 'accounts', entryId: 'je_1', paymentId: null, decidedBy: 'studio', decidedAt: '2026-10-15T08:00:00Z', note: null, differenceMinor: null, ignoreReason: null } })];
    const { transport } = recording(canned(() => all, { get_entry: ok({ entry: { id: 'je_1', date: '2026-10-14', description: 'Probe', number: '199' }, lines: [] }) }));
    renderBank(transport, prefs(), '/bank?tab=booked');
    await open('bt_1');
    expect(await within(area()).findByRole('link', { name: 'Beleg 199 öffnen' })).toBeInTheDocument();
  });
});

// --- the three views ---------------------------------------------------------------------------------------

describe('the booking views (D178 point 9)', () => {
  it('focus: steps through the lines and hides the list on request', async () => {
    const all = [line('bt_1'), line('bt_2', { bookingDate: '2026-10-13' })];
    const store = prefs();
    const { transport } = recording(canned(() => all));
    renderBank(transport, store);
    await open('bt_1');
    expect(within(area()).getByText('Zeile 1 von 2')).toBeInTheDocument();
    await userEvent.click(within(area()).getByRole('button', { name: 'Nächste' }));
    await waitFor(() => expect(document.querySelector('[data-area-for="bt_2"]')).not.toBeNull());
    await userEvent.click(within(area()).getByRole('checkbox', { name: 'Liste ausblenden' }));
    await waitFor(() => expect(document.querySelector('.bank-workspace')).toHaveAttribute('data-list', 'hidden'));
    expect(store.value('bank.focus_list_hidden')).toBe(true);
  });

  it('tabs: the modes are a tablist, with no focus bar', async () => {
    const { transport } = recording(canned(() => [line('bt_1')]));
    renderBank(transport, prefs({ 'bank.booking_view': 'tabs' }));
    await open('bt_1');
    const tabs = within(area()).getByRole('tablist', { name: 'Buchungsart' });
    expect(within(tabs).getAllByRole('tab').map((x) => x.textContent)).toEqual(['Konto', 'Zuordnen', 'Kontakt']);
    expect(area().querySelector('[data-focusbar]')).toBeNull();
  });

  it('one field: a single search sets the target, and its mode opens under it', async () => {
    const { transport, calls } = recording(canned(() => [line('bt_1')]));
    renderBank(transport, prefs({ 'bank.booking_view': 'smart' }));
    await open('bt_1');
    expect(within(area()).queryByRole('radiogroup', { name: 'Buchungsart' })).toBeNull();
    await waitFor(() => expect(within(area()).getByRole('button', { name: /^Worauf buchen\?/ })).not.toBeDisabled());
    await userEvent.click(within(area()).getByRole('button', { name: /^Worauf buchen\?/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Talweg Druck GmbH/ }));
    await waitFor(() => expect(lastCompose(calls)).toEqual({ kind: 'contact', contactId: 'c_2' }));
    expect(within(area()).getByRole('radiogroup', { name: 'Wie gebucht wird' })).toBeInTheDocument();
  });
});
