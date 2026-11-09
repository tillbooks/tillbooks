/**
 * "Zahlung erfassen" asks only what it cannot infer (D152, the cognitive-load pass, brief B7).
 *
 * Measured before (1280x800, the rich demo ledger): 26 inputs at rest, because every one of the 20
 * open items carried a Zuweisen field and a "+ Skonto" link; "Zahlung buchen" disabled; the Konto
 * defaulting to 1000 Kassenbestand. Each assertion below pins one half of the fix:
 *
 *  1. AT REST the Werkbank is the money and one quiet line. No candidate read, no row, no field.
 *  2. The KONTO comes from the Bankkonten, never from the chart's first cash account; several
 *     Bankkonten TILL cannot tell apart ask with nothing preselected, and the confirm is ABSENT
 *     (never disabled beside its unlocker) until one is chosen.
 *  3. The EXACT match is pre-assigned VISIBLY, undoable, and posts byte-for-byte what a person
 *     assigning it by hand posts. A tie pre-assigns nothing.
 *  4. Rows: suggestions carry the field; every other open item waits behind one disclosure; Skonto
 *     lives in the editor of a row that carries an allocation; a long label is one clipped line.
 *  5. The wave B-2 lessons: a stale read is dropped, and a workspace switch leaves nothing behind.
 *  6. ALLOCATION MODE (`?allocate=<paymentId>`) can post at all. It could not: the Betrag stayed
 *     empty, no preview ran, and the confirm never enabled. The money side is now read from the
 *     payment and the `allocate_payment` payload is pinned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { setConfirmPostSuppressed } from './confirm-preference';
import {
  confirmMayPost,
  enginePreAssignment,
  inferBankLedgerAccount,
  type BankAccountLink,
  type Candidate,
} from './model';
import Payments from './index';

import listPayments from './list-payments.fixture.json';
import suggestMatches from './suggest-matches.fixture.json';
import previewPayment from './preview-payment.fixture.json';
import previewRemainder from './preview-remainder.fixture.json';
import recordPayment from './record-payment.fixture.json';
import getPayment from './get-payment.fixture.json';
import needsFxRate from './needs-fx-rate.fixture.json';
import listAccounts from './list-accounts.fixture.json';
// Pinned to the live engine by `test/banking/studio-bank-accounts-fixture.test.mjs`. Both of its
// Bankkonten book on acc_2 (1020 Bankkonto).
import listBankAccounts from '../BankAccounts/list-bank-accounts.fixture.json';
// The books' base currency, which the Konto default needs (critic F2): the Setup recording, pinned to the
// live engine by `test/setup/profile-fixture.test.mjs`.
import companyProfile from '../Setup/company-profile.fixture.json';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Canned = Record<string, Handler>;
type Asked = Array<{ action: string; input: Record<string, unknown> }>;

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, asked: Asked = []): Transport {
  return async (action, input) => {
    asked.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const CONTACTS = ok({
  contacts: [
    { id: 'contact_1', name: 'Muster AG' },
    { id: 'contact_2', name: 'Beispiel GmbH' },
  ],
});

const HAPPY: Canned = {
  list_payments: ok(listPayments),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(previewPayment),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: CONTACTS,
  list_bank_accounts: ok(listBankAccounts),
  get_company_profile: ok(companyProfile),
};

let switchTo: (id: string) => void = () => undefined;
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = (id: string) => setWorkspaceId(id);
  return null;
}

function renderAt(route: string, canned: Canned = HAPPY, asked: Asked = []) {
  const client = new TillClient(fakeTransport(canned, asked));
  return render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={client}>
            <Switcher />
            <Routes>
              <Route path="/payments/*" element={<Payments />} />
            </Routes>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Open the Werkbank and wait until its own reads (accounts, contacts, Bankkonten) have answered. */
async function settled(route = '/payments/new', canned: Canned = HAPPY, asked: Asked = []) {
  renderAt(route, canned, asked);
  const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

async function pickCounterparty(dialog: HTMLElement, name: string) {
  await userEvent.click(within(dialog).getByLabelText('Gegenpartei'));
  await userEvent.click(await screen.findByRole('option', { name }));
}

/** Every control a person can type into or choose with, as the audit counted them. */
function inputsIn(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea, [role="combobox"]')];
}

const CSS = readFileSync(join(process.cwd(), 'src/surfaces/Payments/Payments.css'), 'utf8');

beforeEach(() => {
  installMemoryStorage();
});

describe('1. at rest: the money and one quiet line', () => {
  it('asks for no candidates, shows no row, and holds six inputs (was 26)', async () => {
    const asked: Asked = [];
    const dialog = await settled('/payments/new', HAPPY, asked);

    expect(within(dialog).getByText('Betrag oder Gegenpartei eingeben, dann schlägt TILL passende Posten vor.')).toBeInTheDocument();
    expect(asked.some((a) => a.action === 'suggest_payment_matches')).toBe(false);
    expect(within(dialog).queryAllByLabelText('Zuweisen')).toHaveLength(0);
    expect(within(dialog).queryByRole('button', { name: /Skonto/ })).not.toBeInTheDocument();
    expect(inputsIn(dialog).map((el) => el.getAttribute('aria-label') ?? el.closest('label')?.textContent)).toHaveLength(6);
  });

  it('shows NO Zahlung buchen at rest, and no disabled control at all', async () => {
    const dialog = await settled();
    expect(within(dialog).queryByRole('button', { name: 'Zahlung buchen' })).not.toBeInTheDocument();
    const disabled = [...dialog.querySelectorAll<HTMLElement>('button, input, [role="combobox"]')].filter(
      (el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
    );
    expect(disabled).toEqual([]);
  });

  it('a Gegenpartei alone asks for the list, and names the Betrag as the next step', async () => {
    const asked: Asked = [];
    const dialog = await settled('/payments/new', HAPPY, asked);
    await pickCounterparty(dialog, 'Beispiel GmbH');
    await waitFor(() => expect(asked.some((a) => a.action === 'suggest_payment_matches')).toBe(true));
    expect(await within(dialog).findByText('Gib den Betrag ein.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Zahlung buchen' })).not.toBeInTheDocument();
    // The chosen Gegenpartei's own item is a suggestion and carries its field; Muster AG's does not.
    expect(within(dialog).getAllByLabelText('Zuweisen')).toHaveLength(1);
  });
});

describe('2. the Konto comes from the Bankkonto, never Kasse by default', () => {
  it('defaults to the ledger account the Bankkonten book on (1020), shown before anything posts', async () => {
    const posts: Record<string, unknown>[] = [];
    setConfirmPostSuppressed('ws_test', true);
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const konto = within(dialog).getByLabelText('Konto');
    await waitFor(() => expect(konto).toHaveTextContent('1020 Bankkonto'));
    expect(konto).not.toHaveTextContent('Kassenbestand');

    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].bankAccountId).toBe('acc_2');
  });

  // Two Bankkonten on two ledger accounts. The recorded chart's bank-and-cash range is 1000 and 1020
  // only, so the EUR one books on 1000: odd, but legal (an asset account), and it is exactly the
  // case the old code got wrong, since 1000 sorts first.
  const TWO_BANKS = ok({
    bankAccounts: [
      listBankAccounts.bankAccounts[0],
      { ...listBankAccounts.bankAccounts[1], ledgerAccountId: 'acc_1', ledgerAccountNumber: '1000' },
    ],
  });

  it('base currency unknown: asks with NO preselection, and the confirm waits', async () => {
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      list_bank_accounts: TWO_BANKS,
      get_company_profile: { status: 403, body: { ok: false, error: 'forbidden' } },
    });
    const konto = within(dialog).getByLabelText('Konto');
    expect(konto).toHaveTextContent('Konto wählen');

    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    // Absent, not disabled, while the Konto beside it is what unlocks it; the step is said instead.
    expect(await within(dialog).findByText('Wähl das Konto, über das die Zahlung lief.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Zahlung buchen' })).not.toBeInTheDocument();

    await userEvent.click(konto);
    await userEvent.click(await screen.findByRole('option', { name: '1020 Bankkonto' }));
    expect(await within(dialog).findByRole('button', { name: 'Zahlung buchen' })).toBeEnabled();
    expect(within(dialog).queryByText('Wähl das Konto, über das die Zahlung lief.')).not.toBeInTheDocument();
  });

  it('several Bankkonten, one in the base currency: that one is the default', async () => {
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      list_bank_accounts: TWO_BANKS,
      get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
    });
    await waitFor(() => expect(within(dialog).getByLabelText('Konto')).toHaveTextContent('1020 Bankkonto'));
  });

  it('the Konto the payment came through (?bankAccount=) wins over the default', async () => {
    const dialog = await settled('/payments/new?bankAccount=acc_1');
    await waitFor(() => expect(within(dialog).getByLabelText('Konto')).toHaveTextContent('1000 Kassenbestand'));
  });

  it('a refused Bankkonten read asks rather than falling back to Kasse', async () => {
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      list_bank_accounts: { status: 403, body: { ok: false, error: 'forbidden' } },
    });
    expect(within(dialog).getByLabelText('Konto')).toHaveTextContent('Konto wählen');
  });
});

describe('inferBankLedgerAccount (pure)', () => {
  // What the picker offers: the bank-and-cash range (1000, 1020), never 3400 income.
  const offered = listAccounts.accounts.filter((a) => /^10[0-2]/.test(a.number));
  const link = (over: Partial<BankAccountLink>): BankAccountLink => ({
    id: 'b',
    name: 'B',
    currency: 'CHF',
    ledgerAccountId: 'acc_2',
    receiveOnly: false,
    archived: false,
    ...over,
  });

  it('never offers a receive-only QR-IBAN as the default for an outgoing payment', () => {
    const links = [link({ id: 'qr', receiveOnly: true }), link({ id: 'cash', ledgerAccountId: 'acc_1' })];
    expect(inferBankLedgerAccount(offered, links, 'outgoing', 'CHF')).toBe('acc_1');
    // Incoming: both can carry it and they book on two ledger accounts, so it asks.
    expect(inferBankLedgerAccount(offered, links, 'incoming', 'CHF')).toBeNull();
  });

  it('a QR-IBAN on the SAME ledger account as an ordinary Bankkonto changes nothing (critic F2)', () => {
    const links = [link({ id: 'qr', receiveOnly: true }), link({ id: 'main' })];
    expect(inferBankLedgerAccount(offered, links, 'outgoing', 'CHF')).toBe('acc_2');
    expect(inferBankLedgerAccount(offered, links, 'incoming', 'CHF')).toBe('acc_2');
  });

  it('only Bankkonten in the base currency count, under EVERY rule, and an unknown base asks (critic F2)', () => {
    const eur = link({ id: 'eur', currency: 'EUR', ledgerAccountId: 'acc_1' });
    // A lone EUR Bankkonto in CHF books is never the default for a (CHF) payment.
    expect(inferBankLedgerAccount(offered, [eur], 'incoming', 'CHF')).toBeNull();
    // A CHF QR-IBAN plus an EUR account: money going out has no CHF account that can carry it.
    expect(inferBankLedgerAccount(offered, [link({ id: 'qr', receiveOnly: true }), eur], 'outgoing', 'CHF')).toBeNull();
    expect(inferBankLedgerAccount(offered, [link({ id: 'qr', receiveOnly: true }), eur], 'incoming', 'CHF')).toBe('acc_2');
    expect(inferBankLedgerAccount(offered, [link({})], 'incoming', null)).toBeNull();
  });

  it('ignores archived Bankkonten and ledger accounts the picker does not offer', () => {
    expect(inferBankLedgerAccount(offered, [link({ archived: true })], 'incoming', 'CHF')).toBeNull();
    expect(inferBankLedgerAccount(offered, [link({ ledgerAccountId: 'acc_29' })], 'incoming', 'CHF')).toBeNull();
    expect(inferBankLedgerAccount(offered, [], 'incoming', 'CHF')).toBeNull();
  });
});

describe('3. the exact match is pre-assigned visibly, and posts what a hand assignment posts', () => {
  it('pre-assigns the one item of the Gegenpartei whose open amount equals the Betrag, marked and undoable', async () => {
    const dialog = await settled();
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await pickCounterparty(dialog, 'Beispiel GmbH');

    const field = await within(dialog).findByDisplayValue('500.00');
    expect(field).toHaveAccessibleName('Zuweisen');
    expect(within(dialog).getByText('zugewiesen')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Zuweisung an R-2026-0002 rückgängig machen' }));
    expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument();
    expect(within(dialog).getAllByLabelText('Zuweisen')[0]).toHaveValue('');
  });

  it('takes the pre-assignment away the moment the Betrag stops matching', async () => {
    const dialog = await settled();
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await pickCounterparty(dialog, 'Beispiel GmbH');
    await within(dialog).findByText('zugewiesen');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1');
    await waitFor(() => expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument());
    expect(within(dialog).queryByDisplayValue('500.00')).not.toBeInTheDocument();
  });

  it('an UNTOUCHED pre-assignment posts exactly the payload of a person assigning that item by hand', async () => {
    const posts: Record<string, unknown>[] = [];
    const canned: Canned = {
      ...HAPPY,
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    };
    setConfirmPostSuppressed('ws_test', true);

    // A: the inferred defaults, untouched. Betrag and Gegenpartei typed, nothing else.
    let dialog = await settled('/payments/new', canned);
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await pickCounterparty(dialog, 'Beispiel GmbH');
    await within(dialog).findByText('zugewiesen');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    cleanup();

    // B: what a person did on develop, by hand: the Konto picked, the item's amount typed.
    dialog = await settled('/payments/new', canned);
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await pickCounterparty(dialog, 'Beispiel GmbH');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zuweisung an R-2026-0002 rückgängig machen' }));
    await userEvent.click(within(dialog).getByLabelText('Konto'));
    await userEvent.click(await screen.findByRole('option', { name: '1020 Bankkonto' }));
    await userEvent.type(within(dialog).getAllByLabelText('Zuweisen')[0], '500');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(2));

    const strip = ({ idempotencyKey: _key, ...rest }: Record<string, unknown>) => rest;
    expect(strip(posts[0])).toEqual(strip(posts[1]));
    expect(posts[0]).toMatchObject({
      intent: 'post_payment',
      amountMinor: 50000,
      bankAccountId: 'acc_2',
      counterpartyId: 'contact_2',
      allocations: [{ documentId: 'doc_2', amountMinor: 50000 }],
    });
    // Two acts, two keys: the second payment is never a replay of the first.
    expect(posts[0].idempotencyKey).not.toBe(posts[1].idempotencyKey);
  });

  it('a TIE pre-assigns nothing, says so, and lists both', async () => {
    const twin = { ...suggestMatches.candidates[0], targetId: 'doc_4', number: 'R-2026-0004' };
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      suggest_payment_matches: ok({ ...suggestMatches, candidates: [suggestMatches.candidates[0], twin, suggestMatches.candidates[1]] }),
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await pickCounterparty(dialog, 'Beispiel GmbH');

    expect(await within(dialog).findByText('2 Posten passen genau. Wähl den richtigen aus.')).toBeInTheDocument();
    expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument();
    const table = dialog.querySelector('.pay-cand-table') as HTMLElement;
    expect(within(table).getByText('R-2026-0002')).toBeInTheDocument();
    expect(within(table).getByText('R-2026-0004')).toBeInTheDocument();
    for (const field of within(dialog).getAllByLabelText('Zuweisen')) expect(field).toHaveValue('');
  });

  it('enginePreAssignment takes the ENGINE prefill, complete and unambiguous, and nothing else (critic F1)', () => {
    const cands = suggestMatches.candidates as unknown as Candidate[];
    const [b, other] = cands;
    const target = (list: Candidate[], amount: number, party: string) => enginePreAssignment(list, amount, party).target?.targetId ?? null;
    expect(target(cands, 50000, 'contact_2')).toBe('doc_2');
    // No Betrag; a different Betrag; the exact-amount-and-customer tier without a chosen customer.
    expect(target(cands, 0, 'contact_2')).toBeNull();
    expect(target(cands, 50010, 'contact_2')).toBeNull();
    expect(target(cands, 50000, '')).toBeNull();
    // M1: the item of a DIFFERENT Gegenpartei than the chosen one.
    expect(target(cands, 50000, 'contact_1')).toBeNull();
    // No prefill at all: the Studio invents nothing, even where amount and customer agree.
    expect(target([{ ...b, prefillMinor: 0 }, other], 50000, 'contact_2')).toBeNull();
    // A part payment the engine prefilled (the item stays open): the person's call, not a default.
    expect(target([{ ...b, openMinor: 51020 }, other], 50000, 'contact_2')).toBeNull();
    // Settled or disabled.
    expect(target([{ ...b, settled: true }, other], 50000, 'contact_2')).toBeNull();
    expect(target([{ ...b, disabledReason: 'currency_mismatch' }, other], 50000, 'contact_2')).toBeNull();
    // A reference naming ANOTHER item vetoes it, whatever the prefill says.
    const named = { ...other, kind: 'exact_reference' as const, prefillMinor: 0 };
    expect(target([named, b], 50000, 'contact_2')).toBeNull();
    // A reference match the engine prefilled in full IS the pre-assignment, over an amount coincidence.
    const ref = { ...b, targetId: 'doc_a', kind: 'exact_reference' as const };
    expect(target([ref, { ...b, prefillMinor: 0 }], 50000, 'contact_2')).toBe('doc_a');
    // The engine's own tie: two of the top tier pre-assign nothing and are reported as tied.
    const tie = enginePreAssignment([b, { ...b, targetId: 'doc_4' }], 50000, 'contact_2');
    expect(tie.target).toBeNull();
    expect(tie.tied.map((c) => c.targetId)).toEqual(['doc_2', 'doc_4']);
  });

  it("M10: a person's own allocation on another row keeps the pre-assignment away", async () => {
    const dialog = await settled();
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Alle offenen Posten zeigen (1)' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'R-2026-0003 zuweisen' }));
    const table = dialog.querySelector('.pay-cand-table') as HTMLElement;
    const own = within(within(table).getByText('R-2026-0003').closest('tr') as HTMLElement).getByLabelText('Zuweisen');
    await userEvent.clear(own);
    await userEvent.type(own, '100');
    await pickCounterparty(dialog, 'Beispiel GmbH');
    await waitFor(() => expect(within(dialog).getAllByLabelText('Zuweisen')).toHaveLength(2));
    expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument();
    const exactRow = within(table).getByText('R-2026-0002').closest('tr') as HTMLElement;
    expect(within(exactRow).getByLabelText('Zuweisen')).toHaveValue('');
  });

  it('confirmMayPost: only the question that was shown, everything answered, a postable plan (F3, R2-F5)', () => {
    expect(confirmMayPost({ question: 'q' }, 'q', true, true)).toBe(true);
    expect(confirmMayPost({ question: 'q' }, 'q2', true, true)).toBe(false);
    expect(confirmMayPost({ question: 'q' }, 'q', false, true)).toBe(false);
    expect(confirmMayPost({ question: 'q' }, 'q', true, false)).toBe(false);
    expect(confirmMayPost(null, 'q', true, true)).toBe(false);
  });
});

describe('4. the rows: suggestions edit, the rest waits behind one disclosure', () => {
  it('shows only suggestions with a field; the rest is one click away and picked with one click', async () => {
    const dialog = await settled('/payments/new', { ...HAPPY, preview_payment: ok(previewRemainder) });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1081');
    await within(dialog).findByText('R-2026-0002');
    expect(within(dialog).queryByText('R-2026-0003')).not.toBeInTheDocument();
    expect(within(dialog).getAllByLabelText('Zuweisen')).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Alle offenen Posten zeigen (1)' }));
    // Not a field: a pick. It turns into the row's field, filled with what is left (engine figures).
    const pick = within(dialog).getByRole('button', { name: 'R-2026-0003 zuweisen' });
    await userEvent.click(pick);
    expect(within(dialog).getAllByLabelText('Zuweisen')).toHaveLength(2);
    expect(within(dialog).getByDisplayValue('250.00')).toBeInTheDocument();
  });

  it('puts "+ Skonto" only in the editor of a row that carries an allocation', async () => {
    const dialog = await settled();
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    const field = await within(dialog).findByLabelText('Zuweisen');
    expect(within(dialog).queryByRole('button', { name: '+ Skonto' })).not.toBeInTheDocument();
    await userEvent.type(field, '500');
    expect(within(dialog).getAllByRole('button', { name: '+ Skonto' })).toHaveLength(1);
  });

  it('keeps a long label on one clipped line, with the whole label as its title', async () => {
    const fee = {
      ...suggestMatches.candidates[0],
      targetKind: 'dunning_fee',
      targetId: 'dun_1',
      number: 'R-2026-0019 Mahngebühr Stufe 2',
    };
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      suggest_payment_matches: ok({ ...suggestMatches, candidates: [fee] }),
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    const cell = (await within(dialog).findByText('R-2026-0019 Mahngebühr Stufe 2')).closest('td');
    expect(cell).toHaveClass('pay-clip');
    expect(cell).toHaveAttribute('title', 'R-2026-0019 Mahngebühr Stufe 2');
    const rule = CSS.match(/\.pay-clip\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(CSS).toMatch(/\.pay-cand-table\s*\{[^}]*table-layout:\s*fixed/);
  });
});

describe('5. stale answers and a workspace switch', () => {
  /** Amount and Gegenpartei from the URL, a settled postable plan, then a reference whose list never answers. */
  async function referenceWhileListIsOut(previewForReference: () => RestResponse) {
    renderAt('/payments/new?amount=500&counterparty=contact_2', {
      ...HAPPY,
      suggest_payment_matches: (input) =>
        input.reference === undefined ? ok(suggestMatches) : new Promise<RestResponse>(() => undefined),
      preview_payment: (input) => (input.reference === undefined ? ok(previewPayment) : previewForReference()),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeEnabled());
    await userEvent.click(within(dialog).getByLabelText('Referenz'));
    await userEvent.paste('RF18539007547034');
    return dialog;
  }

  it('the held line names the read still out: the candidate list, not the preview', async () => {
    const dialog = await referenceWhileListIsOut(() => ok(previewPayment));
    await waitFor(() => expect(dialog.querySelector('.pay-blocked-reason')).toHaveTextContent('Passende Posten werden gesucht.'));
    expect(within(dialog).queryByText('Die Vorschau wird neu berechnet.')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeDisabled();
  });

  it('R8: a preview REFUSAL shows its reason, never a waiting line, even while the list is out', async () => {
    const dialog = await referenceWhileListIsOut(() => ({ status: 422, body: { ...needsFxRate, ok: false } }));
    const sentence = 'Für EUR/CHF fehlt der Kurs vom 20.07.2026.';
    await waitFor(() => expect(dialog.querySelector('.pay-error-message')).toHaveTextContent(sentence));
    // Beside the held confirm, the reason is the refusal itself.
    expect(dialog.querySelector('.pay-blocked-reason')).toHaveTextContent(sentence);
    expect(within(dialog).queryByText('Die Vorschau wird neu berechnet.')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Passende Posten werden gesucht.')).not.toBeInTheDocument();
  });

  it('N7: while the preview for the CURRENT Betrag is out, nothing posts on the previous plan', async () => {
    const posts: Record<string, unknown>[] = [];
    setConfirmPostSuppressed('ws_test', true);
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      // The plan for CHF 500.00 answers; the plan for any other Betrag never does.
      preview_payment: (input) => (input.amountMinor === 50000 ? ok(previewPayment) : new Promise<RestResponse>(() => undefined)),
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeEnabled());
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1');
    // The CHF 500.00 plan is still on screen, and it is not this question's: the confirm is held.
    const button = within(dialog).getByRole('button', { name: 'Zahlung buchen' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(posts).toHaveLength(0);
  });

  it('N11: a Datum changed while the confirm is open refuses the confirm, posts nothing, and says why', async () => {
    const posts: Record<string, unknown>[] = [];
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    const confirm = await screen.findByRole('alertdialog');
    // The Datum behind the dialog changes (as any input could), and its new plan answers at once.
    fireEvent.change(within(dialog).getByLabelText('Datum'), { target: { value: '2026-07-01' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    expect(await within(dialog).findByText(/Die Zuteilung hat sich geändert/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
    // Every value stayed, the new Datum included.
    expect(within(dialog).getByLabelText('Betrag')).toHaveValue('500');
    expect(within(dialog).getByLabelText('Datum')).toHaveValue('2026-07-01');
  });

  it('drops a candidate answer a newer read overtook', async () => {
    const held: Array<(r: RestResponse) => void> = [];
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      suggest_payment_matches: () => new Promise<RestResponse>((resolve) => held.push(resolve)),
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '50');
    await waitFor(() => expect(held.length).toBeGreaterThanOrEqual(2));
    const stale = { ...suggestMatches.candidates[0], targetId: 'doc_x', number: 'R-STALE' };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const last = held.length - 1;
    await act(async () => {
      held[last](ok(suggestMatches));
    });
    const table = await waitFor(() => {
      const node = dialog.querySelector('.pay-cand-table');
      if (node === null) throw new Error('no candidate table yet');
      return node as HTMLElement;
    });
    expect(within(table).getByText('R-2026-0002')).toBeInTheDocument();
    // Every earlier read answers late, with a list nobody asks for any more.
    await act(async () => {
      for (let i = 0; i < last; i += 1) held[i](ok({ ...suggestMatches, candidates: [stale] }));
    });
    expect(within(dialog).queryByText('R-STALE')).not.toBeInTheDocument();
    expect(within(dialog.querySelector('.pay-cand-table') as HTMLElement).getByText('R-2026-0002')).toBeInTheDocument();
  });

  it('drops a preview answer a newer preview overtook, so stale figures never show', async () => {
    const held: Array<(r: RestResponse) => void> = [];
    const dialog = await settled('/payments/new', {
      ...HAPPY,
      preview_payment: () => new Promise<RestResponse>((resolve) => held.push(resolve)),
    });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '50');
    await waitFor(() => expect(held.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const last = held.length - 1;
    await act(async () => {
      held[last](ok(previewPayment));
    });
    await within(dialog).findByText('Vollständig zugewiesen');
    // The earlier previews answer late with an unspent plan: none of it may reach the screen.
    await act(async () => {
      for (let i = 0; i < last; i += 1) held[i](ok(previewRemainder));
    });
    expect(within(dialog).queryByText(/Noch zuzuweisen/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Vollständig zugewiesen')).toBeInTheDocument();
  });

  it('a workspace switch while a read and a write are still unanswered resets the Werkbank and acts on neither', async () => {
    const asked: Asked = [];
    let answerPost: (r: RestResponse) => void = () => undefined;
    let answerSuggest: (r: RestResponse) => void = () => undefined;
    setConfirmPostSuppressed('ws_test', true);
    let suggestCalls = 0;
    const dialog = await settled(
      '/payments/new',
      {
        ...HAPPY,
        suggest_payment_matches: (input) => {
          suggestCalls += 1;
          // The ws_test read after the post is the one held across the switch.
          if (input.workspaceId === 'ws_test' && suggestCalls > 3) {
            return new Promise<RestResponse>((resolve) => {
              answerSuggest = resolve;
            });
          }
          return ok(suggestMatches);
        },
        record_payment: () =>
          new Promise<RestResponse>((resolve) => {
            answerPost = resolve;
          }),
      },
      asked,
    );
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(asked.some((a) => a.action === 'record_payment')).toBe(true));
    expect(asked.find((a) => a.action === 'record_payment')?.input.workspaceId).toBe('ws_test');
    await userEvent.type(within(dialog).getByLabelText('Referenz'), 'X');

    act(() => switchTo('ws_b'));
    const fresh = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await waitFor(() => expect(within(fresh).getByLabelText('Betrag')).toHaveValue(''));
    expect(within(fresh).getByLabelText('Referenz')).toHaveValue('');

    // The old workspace's answers land after the switch: neither closes nor fills the new Werkbank.
    await act(async () => {
      answerSuggest(ok({ ...suggestMatches, candidates: [{ ...suggestMatches.candidates[0], number: 'R-OLD' }] }));
      answerPost(ok(recordPayment));
    });
    expect(screen.getByRole('dialog', { name: 'Zahlung erfassen' })).toBeInTheDocument();
    expect(screen.queryByText('R-OLD')).not.toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Zahlung erfassen' })).getByLabelText('Betrag')).toHaveValue('');
  });
});

describe('6. allocation mode spends a parked Guthaben', () => {
  /** pay_1 (get-payment.fixture.json): CHF 1'100.00 from Muster AG, 1'081.00 allocated, 19.00 parked. */
  const PLAN = {
    ...previewPayment,
    date: '2026-07-19',
    amountMinor: 1900,
    counterparty: { kind: 'customer', id: 'contact_1', name: 'Muster AG' },
    allocatedMinor: 1900,
    onAccountMinor: 0,
    remainderMinor: 0,
    baseAmountMinor: 1900,
    rows: [
      {
        ...previewPayment.rows[0],
        targetId: 'doc_3',
        number: 'R-2026-0003',
        grossMinor: 25000,
        openMinor: 25000,
        allocatedMinor: 1900,
        paymentAmountMinor: 1900,
        settlementMinor: 1900,
        settlementBaseMinor: 1900,
        resultingOpenMinor: 23100,
        resultingStatus: 'partially_paid',
      },
    ],
  };

  function allocateCanned(previews: Record<string, unknown>[], posts: Record<string, unknown>[], payment = getPayment): Canned {
    return {
      ...HAPPY,
      get_payment: ok(payment),
      preview_payment: (input) => {
        previews.push(input);
        return ok(PLAN);
      },
      allocate_payment: (input) => {
        posts.push(input);
        return ok({ paymentId: 'pay_1', entryId: 'entry_4', onAccountMinor: 0, documents: [], vendorBills: [], dunningFees: [] });
      },
    };
  }

  it('reads the money side from the payment, previews the credit, and posts the allocation (payload pinned)', async () => {
    const previews: Record<string, unknown>[] = [];
    const posts: Record<string, unknown>[] = [];
    renderAt('/payments/new?allocate=pay_1', allocateCanned(previews, posts));
    const dialog = await screen.findByRole('dialog', { name: 'Guthaben zuweisen' });
    // The payment's own read has answered once its credit is the Betrag.
    await waitFor(() => expect(within(dialog).getByLabelText('Betrag')).toHaveValue('19.00'));

    // The Betrag is the parked credit, and nothing of the money side is editable.
    expect(within(dialog).getByLabelText('Betrag')).toHaveValue('19.00');
    expect(within(dialog).getByLabelText('Betrag')).toBeDisabled();
    expect(within(dialog).getByLabelText('Konto')).toHaveTextContent('1020 Bankkonto');
    expect(within(dialog).getByLabelText('Gegenpartei')).toHaveTextContent('Muster AG');

    const table = await waitFor(() => {
      const node = dialog.querySelector('.pay-cand-table');
      if (node === null) throw new Error('no candidate table yet');
      return node as HTMLElement;
    });
    const row = within(table).getByText('R-2026-0003').closest('tr') as HTMLElement;
    await userEvent.type(within(row).getByLabelText('Zuweisen'), '19');

    const post = await within(dialog).findByRole('button', { name: 'Zahlung buchen' });
    await waitFor(() => expect(post).toBeEnabled());
    // Allocating books nothing: no legs, no Skonto, no Ausbuchung, no "Als Guthaben parken".
    expect(dialog.querySelector('.pay-legs')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '+ Skonto' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Als Guthaben parken' })).not.toBeInTheDocument();

    // The preview planned the CREDIT as the payment, exactly as allocate_payment replans it.
    // The LAST preview: the field is typed a keystroke at a time, so earlier ones carry 1.00.
    const asked = previews[previews.length - 1];
    expect(asked).toEqual({
      workspaceId: 'ws_test',
      direction: 'incoming',
      date: '2026-07-19',
      currency: 'CHF',
      bankAccountId: 'acc_2',
      counterpartyKind: 'customer',
      counterpartyId: 'contact_1',
      amountMinor: 1900,
      allocations: [{ documentId: 'doc_3', amountMinor: 1900 }],
    });

    await userEvent.click(post);
    const confirm = await screen.findByRole('alertdialog');
    // The confirm names the part of the credit being assigned, the engine's figure.
    expect(within(confirm).getByText(/CHF 19.00/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    const { idempotencyKey, ...rest } = posts[0];
    expect(typeof idempotencyKey).toBe('string');
    expect(rest).toEqual({
      workspaceId: 'ws_test',
      paymentId: 'pay_1',
      allocations: [{ documentId: 'doc_3', amountMinor: 1900 }],
      intent: 'allocate_payment',
    });
    // The Werkbank closes onto the list, as after a recorded payment.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guthaben zuweisen' })).not.toBeInTheDocument());
  });

  it('a reversed payment says so and offers no confirm', async () => {
    const reversed = { ...getPayment, payment: { ...getPayment.payment, status: 'reversed' } };
    renderAt('/payments/new?allocate=pay_1', allocateCanned([], [], reversed));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Diese Zahlung ist bereits storniert.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Zahlung buchen' })).not.toBeInTheDocument();
  });

  it('a payment with no credit left says so and offers no confirm', async () => {
    const spent = { ...getPayment, payment: { ...getPayment.payment, onAccountMinor: 0 } };
    renderAt('/payments/new?allocate=pay_1', allocateCanned([], [], spent));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Diese Zahlung hat kein Guthaben mehr, das sich zuweisen liesse.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Betrag')).toHaveValue('');
    expect(within(dialog).queryByRole('button', { name: 'Zahlung buchen' })).not.toBeInTheDocument();
  });
});
