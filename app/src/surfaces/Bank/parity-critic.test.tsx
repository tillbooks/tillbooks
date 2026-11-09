/**
 * D178 N3 money critic (non-author), round 1: probes against a fake engine. Each `it.fails` asserts the
 * CORRECT behaviour and fails today on the defect named in docs/critique/bank-parity-n3-critic.md; a fix
 * flips it to `it`. The plain `it` probes pass and pin what held.
 *
 * Every name, IBAN, reference and figure in this file is invented.
 */
import { describe, expect, it } from 'vitest';
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

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function account(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}
const has = (n: string) => listAccountsFixture.accounts.some((a) => a.number === n);
const BANK_LEDGER = account('1020');
const EXPENSE = account(has('6500') ? '6500' : '6000');
const ACCOUNT = { id: 'ba_1', name: 'Probe Konto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };
const SUMMARY = { bankAccountId: 'ba_1', name: 'Probe Konto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, judgeable: false, reason: 'no_statement', statementId: 'st_1', statementDate: '2026-10-14', bankBalanceMinor: null, ledgerBalanceMinor: null, openCount: 0, openSumMinor: 0, differenceMinor: null };

function line(id: string, over: Record<string, unknown> = {}) {
  return {
    attention: 'needs', receiptCount: 0, needsReceipt: false, bankTxnId: id, bankAccountId: 'ba_1', statementId: 'st_1', state: 'open',
    bookingDate: '2026-10-14', valueDate: '2026-10-15', amountMinor: 30_000, currency: 'CHF', creditDebit: 'CRDT', reversal: false,
    counterparty: { name: `Probe ${id}`, iban: null }, remittance: { text: `Text ${id}`, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null, creditId: null, decision: null,
    proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
    standardId: null, ruleIds: [], followUp: null, vorschlagActionId: null,
    ...over,
  };
}

const booking = (bookable: boolean, over: Record<string, unknown> = {}) => ({
  mode: 'expand', composed: bookable, stamped: false, lines: [], captions: [], verdict: bookable ? { ok: true } : { ok: false, error: 'x' },
  booking: {
    targetKind: 'x', bookable, blockedBy: bookable ? null : 'x', verdict: { ok: bookable },
    deviationMinor: 0, remainder: null, remainderOptions: [], documents: [], contact: null, claims: [], fx: null,
    entries: [], warnings: [], consequences: [], acknowledgementsRequired: [],
    ...over,
  },
});

function canned(all: () => unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: (input) => {
      const mine = all().filter((l) => (l as { state: string }).state === input.status);
      return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, directionCounts: { in: mine.length, out: 0 }, summary: [SUMMARY] });
    },
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({
      items: [
        { kind: 'document', documentId: 'doc_1', number: 'RE-9101', customerId: 'c_1', customerName: 'Probe Kunde AG', openMinor: 20_000, currency: 'CHF' },
        { kind: 'document', documentId: 'doc_2', number: 'RE-9102', customerId: 'c_1', customerName: 'Probe Kunde AG', openMinor: 5_000, currency: 'CHF' },
      ],
    }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    list_payment_batches: ok({ batches: [] }),
    settings_get: ok({ setting: { key: 'bank.fx_mode', value: 'propose_split' } }),
    list_contacts: ok({ contacts: [{ id: 'c_1', name: 'Probe Kunde AG', partyRole: 'customer' }] }),
    expense_claim_list: ok({ claims: [{ id: 'cl_1', employeeName: 'Probe Person', title: 'Probe Reise', status: 'approved', currency: 'CHF', totalBaseMinor: 12_000, approvedAt: '2026-10-10' }] }),
    compose_entry: ok(booking(true)),
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

const ALL_RIGHTS = ['read_sales', 'post', 'pay', 'manage_files', 'read_master_data', 'read_file_content', 'manage_agent_dial', 'read_books', 'read_vat', 'hr.read', 'spesen.approve'];
function capsWith(rights: string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: rights },
    can: (c: string) => rights.includes(c),
    refresh: () => undefined,
  } as unknown as Capabilities;
}

function renderBank(transport: Transport, opts: { rights?: string[]; path?: string; prefs?: Record<string, string> } = {}) {
  const store = new PrefsStore(null, null, { useCache: false });
  for (const [k, v] of Object.entries(opts.prefs ?? {})) store.seed(k, v);
  return render(
    <CapabilitiesContext.Provider value={capsWith(opts.rights ?? ALL_RIGHTS)}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={store}>
              <MemoryRouter initialEntries={[opts.path ?? '/bank']}>
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
const rowBuchen = (id: string) => document.querySelector<HTMLButtonElement>(`tr.bank-row[data-line="${id}"] .bank-row__book`);
const books = (calls: { action: string; input: Record<string, unknown> }[]) => calls.filter((c) => c.action === 'book_bank_line');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fxLine = () =>
  line('bt_fx', {
    amountMinor: -9_237,
    creditDebit: 'DBIT',
    proposal: { target: { kind: 'accounts', legs: [{ accountId: EXPENSE, amountMinor: 9_237 }] }, certainty: 'check', reasonCode: 'history', reasonParams: {}, vatCode: null },
    facts: { bankCode: null, bankText: null, additionalInfo: null, entryInfo: null, refs: {}, instructed: { amountMinor: 10_000, currency: 'USD' }, exchange: { rate: '0.9237', effectiveRate: null, sourceCurrency: 'USD', targetCurrency: 'CHF' }, chargesTotal: null, fee: null },
  });
const FX_SENTENCE = 'Probe: die Gegenbuchung läuft in USD.';

describe('N3 critic probes', () => {
  // N3-C1: a seat without read_vat (a custom role with post + pay) never gets the preview, so the engine's
  // fx_counter_leg sentence never shows; yet the acknowledgement box is offered and Buchen books acknowledgeFx.
  it('N3-C1: acknowledgeFx is never sent unless the fx_counter_leg sentence was on screen (preview denied)', async () => {
    const all = [fxLine()];
    const { transport, calls } = recording(canned(() => all, { settings_get: ok({ setting: { key: 'bank.fx_mode', value: 'transaction_currency' } }) }));
    renderBank(transport, { rights: ALL_RIGHTS.filter((r) => r !== 'read_vat') });
    await open('bt_fx');
    await userEvent.click(await within(area()).findByRole('checkbox', { name: /Gegenbuchung in USD 100.00/ }));
    await pause(400);
    const sawSentence = within(area()).queryByText(FX_SENTENCE) !== null;
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(false);
    const ack = within(area()).queryByRole('checkbox', { name: 'Ich habe die Folgen gelesen.' });
    if (ack !== null) await userEvent.click(ack);
    if (buchen().getAttribute('aria-disabled') !== 'true') await userEvent.click(buchen());
    await pause(50);
    const acked = books(calls).some((c) => (c.input.target as { acknowledgeFx?: boolean }).acknowledgeFx === true);
    // Correct: an acknowledgement reaches book_bank_line only after the engine's sentence was on screen.
    expect(acked && !sawSentence).toBe(false);
  });

  // N3-C2: the ROW's Buchen ignores a refused preview: the pane says the engine would not book, the row's
  // accent commit stays live and sends the target.
  it('N3-C2: the row Buchen is held while the preview says the target would not book (Spesen amount_mismatch)', async () => {
    const all = [line('bt_sp', { amountMinor: -15_000, creditDebit: 'DBIT' })];
    const { transport, calls } = recording(canned(() => all, { compose_entry: ok(booking(false, { deviationMinor: 3_000, verdict: { ok: false, error: 'amount_mismatch', sentence: { en: 'mismatch', 'de-CH': 'Probe: Betrag stimmt nicht.' } } })) }));
    renderBank(transport);
    await open('bt_sp');
    await userEvent.click(within(within(area()).getByRole('radiogroup', { name: 'Buchungsart' })).getByRole('radio', { name: 'Spesen' }));
    await userEvent.click(await within(area()).findByRole('checkbox', { name: /Probe Reise/ }));
    await waitFor(() => expect(buchen()).toHaveAttribute('aria-disabled', 'true'));
    const row = rowBuchen('bt_sp');
    expect(row).not.toBeNull();
    await userEvent.click(row as HTMLButtonElement);
    await pause(50);
    expect(books(calls)).toHaveLength(0);
  });

  // N3-C3: Zuordnen keeps a typed amount per document across target changes: after the one-field search
  // re-picks the invoice (open_item, the whole document), the field still shows the old typed figure.
  it('N3-C3: the amount field shows what the draft sends after the target changes under the pane', async () => {
    const all = [line('bt_z')];
    const { transport } = recording(canned(() => all));
    renderBank(transport, { prefs: { 'bank.booking_view': 'smart' } });
    await open('bt_z');
    const pickInvoice = async () => {
      await waitFor(() => expect(within(area()).getByRole('button', { name: /^Worauf buchen\?/ })).not.toBeDisabled());
      await userEvent.click(within(area()).getByRole('button', { name: /^Worauf buchen\?/ }));
      await userEvent.click(await screen.findByRole('option', { name: /RE-9101/ }));
    };
    await pickInvoice();
    const field = await within(area()).findByRole('textbox', { name: /RE-9101/ });
    await userEvent.clear(field);
    await userEvent.type(field, '150.00');
    await pickInvoice();
    // The draft is now open_item doc_1 (the whole open 200.00); the field must not say 150.00.
    await waitFor(() => expect((within(area()).getByRole('textbox', { name: /RE-9101/ }) as HTMLInputElement).value).toBe('200.00'));
  });

  // N3-C4: Gebucht pages two statuses with the same offset; the range label counts one status's offset.
  it('N3-C4: Gebucht paging: page 2 starts after every line page 1 showed', async () => {
    const mk = (prefix: string, n: number, state: string) => Array.from({ length: n }, (_, i) => line(`${prefix}${i}`, { state }));
    const booked = mk('b', 300, 'booked');
    const matched = mk('m', 250, 'matched');
    const { transport } = recording(
      canned(() => [], {
        list_bank_inbox: (input) => {
          const src = input.status === 'booked' ? booked : input.status === 'matched' ? matched : [];
          const off = (input.offset as number | undefined) ?? 0;
          const lim = input.limit as number;
          const page = src.slice(off, off + lim);
          return ok({ lines: page, nextCursor: off + lim < src.length ? 'c' : null, total: src.length, directionCounts: { in: src.length, out: 0 }, summary: [SUMMARY] });
        },
      }),
    );
    renderBank(transport, { path: '/bank?tab=booked' });
    await waitFor(() => expect(screen.getByText(/von 550/)).toBeInTheDocument());
    const first = screen.getByText(/von 550/).textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.getByText(/von 550/).textContent).not.toBe(first));
    // Page 1 showed 400 lines (200 + 200), so page 2 is 401 to 550.
    expect(screen.getByText(/von 550/).textContent).toBe('401 bis 550 von 550');
  }, 30_000);

  // Held: a double click on the panel's Buchen sends one idempotency key.
  it('double Buchen sends one idempotency key', async () => {
    const all = [line('bt_d')];
    const { transport, calls } = recording(canned(() => all));
    renderBank(transport);
    await open('bt_d');
    await userEvent.click(within(within(area()).getByRole('radiogroup', { name: 'Buchungsart' })).getByRole('radio', { name: 'Kontakt' }));
    await waitFor(() => expect(within(area()).getByRole('button', { name: /^Kontakt/ })).not.toBeDisabled());
    await userEvent.click(within(area()).getByRole('button', { name: /^Kontakt/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Probe Kunde AG/ }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
    const b = buchen();
    await userEvent.dblClick(b);
    await waitFor(() => expect(books(calls).length).toBeGreaterThan(0));
    expect(new Set(books(calls).map((c) => c.input.idempotencyKey)).size).toBe(1);
    expect(books(calls)[0]?.input.target).toEqual({ kind: 'contact', contactId: 'c_1' });
  });

  // Held: a mode switch keeps each mode's draft for the line and Buchen sends the mode in view.
  it('a mode switch never books the other mode draft', async () => {
    const all = [line('bt_m', { proposal: { target: { kind: 'accounts', legs: [{ accountId: EXPENSE, amountMinor: 30_000 }] }, certainty: 'check', reasonCode: 'history', reasonParams: {}, vatCode: null } })];
    const { transport, calls } = recording(canned(() => all));
    renderBank(transport);
    await open('bt_m');
    const modes = () => within(area()).getByRole('radiogroup', { name: 'Buchungsart' });
    await userEvent.click(within(modes()).getByRole('radio', { name: 'Kontakt' }));
    await waitFor(() => expect(within(area()).getByRole('button', { name: /^Kontakt/ })).not.toBeDisabled());
    await userEvent.click(within(area()).getByRole('button', { name: /^Kontakt/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Probe Kunde AG/ }));
    await userEvent.click(within(modes()).getByRole('radio', { name: 'Konto' }));
    await waitFor(() => expect(buchen()).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(buchen());
    await waitFor(() => expect(books(calls)).toHaveLength(1));
    expect(books(calls)[0]?.input.target).toMatchObject({ kind: 'accounts', legs: [{ accountId: EXPENSE, amountMinor: 30_000 }] });
  });
});
