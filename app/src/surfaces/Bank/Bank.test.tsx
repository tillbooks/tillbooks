/**
 * A2, the bank inbox at /bank, in B2 "Eine Zeile Kontext" (the owner's pick of 01.10.2026, spec A39
 * §6.1): the surface against a fake engine.
 *
 * What is asserted, and why each one:
 *   - the load is a real read in flight (watchReads), never the default skeleton;
 *   - first run leads: no Bankkonto says so and links to creating one; no statement makes the import
 *     the primary action and gives it a drop zone;
 *   - NOTHING OPENS BY ITSELF: no row is selected on load; `?line=` selects exactly that line;
 *   - each row says who acts next: Buchen only where a target exists (no greyed Buchen), "Worauf
 *     buchen?" where none does, "Prüfen" where an agent Vorschlag waits; the C4 sentence is Buchen's
 *     real tooltip (`aria-describedby`);
 *   - the context strip says the reason, the model's disclosure in words (D144) and the VAT split;
 *   - the balance line is one line, its card holds bank = books + open lines (L4) in the engine's
 *     figures, and a difference with its hint;
 *   - the keyboard path books: target picker, type, Enter, the VAT picker follows, Enter, Buchen, and
 *     the write is the agent's verb (`book_bank_line`) with its idempotency key;
 *   - a refusal answers what, why and the fix on the line, and never offers another date (L5);
 *   - an ignored line comes back only through `reopen_bank_line`, with a reason, from its strip;
 *     the Gebucht strip offers Stornieren;
 *   - a facet chip is hidden when it would change nothing (0, or every line);
 *   - a file dropped on a row is attached to THAT line: `files_upload`, then `files_link`, `bank_txn`;
 *   - every action the surface had before B2 is still reachable, and behind the same A24 gates;
 *   - axe finds nothing on the settled surface, in both themes, with a strip and a card open.
 *
 * `compose_entry` (the strip's MWST split, the split editor's Soll/Haben table) is answered by the REAL
 * engine (`app/test-support/composeEngine.ts`), so every VAT figure asserted here is the engine's.
 *
 * Every name, IBAN and figure is invented for this file.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { ThemeProvider, type Theme } from '../../app/theme';
import { hang, watchReads } from '../../test-transport';
import { recordedOk } from '../../lib/test-support';
import Bank from './index';
/**
 * The chart is the engine's own `list_accounts` answer (A01's pinned recording), never hand-typed:
 * `test/accounts/studio-list-accounts-fixture.test.mjs` holds every suite that reads `list_accounts` to it.
 */
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';
import { consequenceSentence } from '../../lib/approval-tiers';

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

/** A transport that also records every call, in order. */
function recording(canned: Canned): { transport: Transport; calls: { action: string; input: Record<string, unknown> }[] } {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const inner = fakeTransport(canned);
  return {
    calls,
    transport: async (action, input) => {
      calls.push({ action, input });
      return inner(action, input);
    },
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
  { code: 'VST-I', kind: 'input', rateBp: 0, label: 'Vorsteuer Investitionen und übriger Betriebsaufwand', active: true },
  { code: 'IMPORT', kind: 'import', rateBp: 0, label: 'Einfuhrsteuer (Art. 50)', active: true },
];

/** The engine's attention for a fixture line with no Vorschlag (A39 §11): sure, learned, else needs. */
function attentionFor(over: Record<string, unknown>): string | null {
  if ((over.state ?? 'open') !== 'open') return null;
  const certainty = (over.proposal as { certainty?: string } | null | undefined)?.certainty;
  return certainty === 'sure' || certainty === 'learned' ? certainty : 'needs';
}

function line(id: string, over: Record<string, unknown>) {
  return {
    attention: attentionFor(over),
    receiptCount: 0,
    needsReceipt: false,
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

/** A line booked to 6500 with Vorsteuer last month: the history rung, with a taxed leg. */
const DRUCK = line('bt_druck', {
  bookingDate: '2026-09-22',
  valueDate: '2026-09-22',
  amountMinor: -8_990,
  counterparty: { name: 'Druckerei Talweg', iban: null },
  remittance: { text: 'Visitenkarten', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  proposal: {
    target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_990, taxCode: 'VST-M' }] },
    certainty: 'learned',
    reasonCode: 'history',
    reasonParams: { accountId: account('6500'), taxCode: 'VST-M', lastDate: '2026-08-21', count: 3 },
    vatCode: 'VST-M',
  },
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
    // The MWST split and the Soll/Haben table are the REAL engine's composition (D152 amendment): never a
    // stand-in, which would be the Studio-side copy of the VAT derivation again, only in the test tree.
    compose_entry: composeEngine(),
    ...extra,
  };
}

/** A seat holding exactly these capabilities (the A24 gate the surface reads). */
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  } as Capabilities;
}
const EVERY_RIGHT = [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles, CAP.readMasterData, CAP.readFileContent, 'manage_agent_dial'];

function renderBank(transport: Transport, path = '/bank', opts: { held?: readonly string[]; theme?: Theme } = {}) {
  const client = new TillClient(transport);
  const tree = (
    <TillClientProvider client={client}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[path]}>
            <Bank />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  const withCaps = opts.held === undefined ? tree : <CapabilitiesContext.Provider value={caps(opts.held)}>{tree}</CapabilitiesContext.Provider>;
  return render(opts.theme === undefined ? withCaps : <ThemeProvider initialTheme={opts.theme}>{withCaps}</ThemeProvider>);
}

/** A bank line's own row (never its context strip, which may name the same party). */
function rowOf(name: RegExp): HTMLElement {
  const row = screen.getAllByRole('row', { name }).find((r) => r.classList.contains('bank-row'));
  if (row === undefined) throw new Error(`no bank row named ${String(name)}`);
  return row;
}
async function findRow(name: RegExp): Promise<HTMLElement> {
  await screen.findAllByRole('row', { name });
  return rowOf(name);
}
/** The context strip under a line, or null. */
function stripOf(bankTxnId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`tr.bank-strip[data-strip-for="${bankTxnId}"]`);
}
function selectedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('tr.bank-row[aria-current="true"]'));
}
/** Click a row's body (its date cell), the person's act that selects it. */
async function clickRow(row: HTMLElement) {
  await userEvent.click(within(row).getAllByRole('cell')[1] as HTMLElement);
}

/**
 * The lines and the option reads (chart, codes, open items, Vorschläge) land independently. The
 * Café line's "Prüfen" needs the Vorschläge, so once it shows, every option read has answered and a
 * row names its target from the lookups, not from a half-loaded state.
 */
async function settledRows() {
  await screen.findAllByRole('row', { name: /Café Seeblick/ });
  await waitFor(() => expect(within(rowOf(/Café Seeblick/)).getByRole('button', { name: 'Prüfen' })).toBeInTheDocument());
}

async function openHeaderMenu(name: string) {
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('menu');
}

describe('the bank inbox (B2)', () => {
  it('LOADING: shows the skeleton while the inbox read is really in flight', async () => {
    const transport = watchReads(hang('list_bank_inbox', fakeTransport(happy())));
    renderBank(transport);
    await transport.started('list_bank_inbox');
    expect(screen.getAllByRole('status').some((s) => s.getAttribute('aria-busy') === 'true')).toBe(true);
    // The skeleton has the list's measure: a head strip and rows at the row height (K-34).
    expect(document.querySelector('.bank-skeleton__head')).not.toBeNull();
    expect(document.querySelectorAll('.bank-skeleton__row').length).toBeGreaterThanOrEqual(10);
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
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    // The balance line is the account and its one figure; the full sentence is in its card (critic F10).
    const trust = screen.getByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ });
    expect(within(trust).getByText('Noch kein Kontoauszug')).toBeVisible();
    await userEvent.hover(within(trust).getByRole('button', { name: /Zahlen und Erklärung/ }));
    expect(within(trust).getByText('Kann nicht beurteilt werden: noch kein Kontoauszug.')).toBeVisible();
    expect(document.querySelector('.bank-first input[type="file"]')).not.toBeNull();
  });

  it('NOTHING OPENS BY ITSELF: no row is selected on load and no strip shows', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    expect(selectedRows()).toHaveLength(0);
    expect(document.querySelector('tr.bank-strip')).toBeNull();
    // The person's act selects: a click on the row body, and a second click collapses it again.
    await clickRow(rowOf(/Alpina Telecom AG/));
    expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_alpina']);
    expect(stripOf('bt_alpina')).not.toBeNull();
    await clickRow(rowOf(/Alpina Telecom AG/));
    expect(document.querySelector('tr.bank-strip')).toBeNull();
  });

  it('Enter or Space on a focused row selects it; a control inside the row does not', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);
    // Opening the target picker is not a selection.
    await userEvent.click(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    await userEvent.keyboard('{Escape}');
    expect(selectedRows()).toHaveLength(0);
    alpina.focus();
    await userEvent.keyboard('{Enter}');
    expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_alpina']);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowOf(/Café Seeblick/));
    await userEvent.keyboard(' ');
    expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_cafe']);
  });

  it('?line= selects THAT line and nothing else, with its strip under it', async () => {
    renderBank(fakeTransport(happy()), '/bank?line=bt_alpina');
    await settledRows();
    await waitFor(() => expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_alpina']));
    expect(document.querySelectorAll('tr.bank-strip')).toHaveLength(1);
    // The strip sits right under its row.
    expect(rowOf(/Alpina Telecom AG/).nextElementSibling).toBe(stripOf('bt_alpina'));
  });

  it('Buchen is there only where a target exists; without one the picker asks, with an agent Vorschlag the row says Prüfen', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    const kafi = rowOf(/Coworking Kafi AG/);
    expect(within(kafi).getByRole('button', { name: /Buchen auf, Coworking Kafi AG/ })).toHaveTextContent('R-2026-0034');
    const book = within(kafi).getByRole('button', { name: 'Buchen' });
    expect(book).toBeEnabled();
    expect(book.className).toContain('btn--accent');
    expect(book).toHaveAttribute('data-money-commit', 'book_bank_line');

    const alpina = rowOf(/Alpina Telecom AG/);
    expect(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ })).toHaveTextContent('Worauf buchen?');
    expect(within(alpina).queryByRole('button', { name: 'Buchen' })).toBeNull();

    const cafe = rowOf(/Café Seeblick/);
    expect(within(cafe).getByRole('button', { name: 'Prüfen' })).toBeInTheDocument();
    expect(within(cafe).queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(within(cafe).getByRole('button', { name: /Buchen auf, Café Seeblick/ })).toHaveTextContent('6700');

    // Only the reference-proven line is offered to "Alle sicheren buchen"; the agent's is not. It is the one primary.
    expect(screen.getByRole('button', { name: 'Alle sicheren buchen (1)' }).className).toContain('btn--primary');
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
  });

  it('the C4 consequence sentence is Buchen\'s real tooltip, reachable through aria-describedby', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([KAFI, DRUCK]), list_drafted_actions: ok({ actions: [] }) })));
    const kafi = await findRow(/Coworking Kafi AG/);
    const settle = await within(kafi).findByRole('button', { name: 'Buchen' });
    expect(settle).not.toHaveAttribute('title');
    const tip = document.getElementById(settle.getAttribute('aria-describedby') ?? '');
    expect(tip).toHaveAttribute('role', 'tooltip');
    // D156: `book_bank_line` carries its own engine sentence, so a settlement (`pay`) and a booking to
    // accounts (`post`) read the same words, the ones its Vorschlag card shows.
    const sentence = consequenceSentence('book_bank_line', 'de-CH') as string;
    expect(tip).toHaveTextContent(sentence);
    const post = await within(rowOf(/Druckerei Talweg/)).findByRole('button', { name: 'Buchen' });
    expect(document.getElementById(post.getAttribute('aria-describedby') ?? '')).toHaveTextContent(sentence);
  });

  it('the strip says the reason and the VAT split in one line, and has no second Buchen', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK, ALPINA]), list_drafted_actions: ok({ actions: [] }) })));
    const row = await findRow(/Druckerei Talweg/);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Buchen auf, Druckerei Talweg/ })).toHaveTextContent('6500'));
    // MWST is the code's label as text, on an expense account.
    expect(within(row).getByRole('button', { name: 'MWST, Druckerei Talweg, VST-M Vorsteuer Material, Waren, Dienstleistungen' })).toHaveTextContent('VST-M');
    await clickRow(row);
    const strip = stripOf('bt_druck') as HTMLElement;
    expect(within(strip).getByText('Gelernt')).toBeInTheDocument();
    // The row already names 6500 and the code; the strip says only WHY, in one sentence.
    expect(within(strip).getByText('So gebucht wie zuletzt am 21.08.2026 (3 Mal).')).toBeInTheDocument();
    expect(await within(strip).findByText('davon MWST 6.74 auf 1170 · netto 83.16')).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(within(strip).queryByText(/Nächster Schritt/)).toBeNull();
    // The rare actions are icon buttons with names and real tooltips.
    for (const name of ['Aufteilen', 'Mit Buchung abgleichen', 'Agent fragen', 'Beleg anhängen', 'Ignorieren']) {
      const tool = within(strip).getByRole('button', { name });
      expect(document.getElementById(tool.getAttribute('aria-describedby') ?? '')).toHaveTextContent(name);
    }
  });

  it('MWST is blank where no code can apply: a settlement, and a line without a target', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })));
    const kafi = await findRow(/Coworking Kafi AG/);
    await within(kafi).findByRole('button', { name: 'Buchen' });
    expect(within(kafi).queryByRole('button', { name: /^MWST/ })).toBeNull();
    expect(within(rowOf(/Alpina Telecom AG/)).queryByRole('button', { name: /^MWST/ })).toBeNull();
  });

  it('the balance line is one line; its card holds bank = books + open lines in the engine\'s figures (L4)', async () => {
    renderBank(fakeTransport(happy()));
    const trust = await screen.findByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ });
    expect(within(trust).getByText('Keine Differenz')).toBeVisible();
    const info = within(trust).getByRole('button', { name: 'Abgleich Zürichsee Geschäftskonto: Zahlen und Erklärung' });
    const card = document.getElementById(info.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(card).not.toBeVisible();
    await userEvent.hover(info);
    expect(card).toBeVisible();
    const text = card.textContent ?? '';
    expect(text).toMatch(/10.782\.72/);
    expect(text).toMatch(/10.868\.70/);
    expect(text).toMatch(/85\.98/);
    expect(text).toContain('offene Zeilen');
    expect(text).toContain('Stimmt, bis auf die Zeilen, die noch zu buchen sind.');
    expect(text).toContain('Stand Kontoauszug 24.09.2026');
    expect(text).not.toContain('Differenz');
    await userEvent.keyboard('{Escape}');
    expect(card).not.toBeVisible();
  });

  it('names a difference in one line, and its card says what can cause it', async () => {
    // An entry of -42.00 on the bank ledger that no line backs: bank - books - open = 42.00.
    const differs = { ...SUMMARY, ledgerBalanceMinor: 1_086_870 - 4_200, differenceMinor: 4_200 };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], [differs]) })));
    const trust = await screen.findByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ });
    await waitFor(() => expect(within(trust).getByText('Differenz CHF 42.00')).toBeVisible());
    const info = within(trust).getByRole('button', { name: /Zahlen und Erklärung/ });
    // Keyboard focus opens the card too (a card a pointer alone can open is not one a keyboard can).
    act(() => info.focus());
    const card = document.getElementById(info.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(card).toBeVisible();
    expect(card.textContent ?? '').toContain('Bank und Buchhaltung weichen um CHF 42.00 ab.');
    expect(card.textContent ?? '').toContain('eine Buchung auf dem Bankkonto keine Bankzeile hat');
    // The card's one action: the open lines.
    expect(within(card).getByRole('button', { name: /3 Zeilen offen/ })).toBeInTheDocument();
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
    // Booking a line that was not selected selects nothing; the focus moves to the next ROW, never its action.
    expect(selectedRows()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(rowOf(/Café Seeblick/)));
  });

  it('deciding the SELECTED line moves the selection and the focus to the next line', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_2', remainder: null }));
    renderBank(fakeTransport(happy({ book_bank_line: book })));
    await settledRows();
    const kafi = rowOf(/Coworking Kafi AG/);
    await clickRow(kafi);
    await userEvent.click(within(kafi).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_alpina']));
    await waitFor(() => expect(document.activeElement).toBe(rowOf(/Alpina Telecom AG/)));
  });

  it('a locked period answers what, why and the fix in the strip, and never books on another date (L5)', async () => {
    const spy = vi.fn<Handler>(() => refuse('period_locked', { period: '2026-09', kind: 'soft', reason: null }));
    renderBank(fakeTransport(happy({ book_bank_line: spy })));
    const kafi = await findRow(/Coworking Kafi AG/);
    await userEvent.click(await within(kafi).findByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/September 2026/)).toBeInTheDocument();
    expect(stripOf('bt_kafi')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Zu den Perioden' })).toHaveAttribute('href', '/periods');
    expect(screen.queryByRole('button', { name: /01\.10\.2026/ })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('date');
  });

  it('a sealed period offers to ignore the line as booked elsewhere', async () => {
    renderBank(fakeTransport(happy({ book_bank_line: refuse('period_locked', { period: '2026-09', kind: 'hard', reason: 'vat_filed' }) })));
    const kafi = await findRow(/Coworking Kafi AG/);
    await userEvent.click(await within(kafi).findByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/September 2026 ist abgeschlossen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Zeile ignorieren' }));
    expect(await screen.findByRole('heading', { name: 'Zeile ignorieren' })).toBeInTheDocument();
  });

  it('a refusal only the shared catalogue may word renders through the shared banner', async () => {
    renderBank(fakeTransport(happy({ book_bank_line: refuse('schema_newer_than_runtime', {}) })));
    const kafi = await findRow(/Coworking Kafi AG/);
    await userEvent.click(await within(kafi).findByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/von einem neueren TILL geschrieben/)).toBeInTheDocument();
  });

  it('a sure line carries its checkbox; once a pick is under way every row does, and the bar ignores them, one ignore_bank_line per line', async () => {
    const ignore = vi.fn<Handler>(() => ok({ state: 'ignored' }));
    renderBank(fakeTransport(happy({ ignore_bank_line: ignore })));
    await settledRows();
    expect(within(rowOf(/Alpina Telecom AG/)).queryByRole('checkbox')).toBeNull();
    await userEvent.click(within(rowOf(/Coworking Kafi AG/)).getByRole('checkbox', { name: /Coworking Kafi AG/ }));
    await userEvent.click(within(rowOf(/Alpina Telecom AG/)).getByRole('checkbox', { name: /Alpina Telecom AG/ }));
    await userEvent.click(within(rowOf(/Café Seeblick/)).getByRole('checkbox', { name: /Café Seeblick/ }));
    await userEvent.click(within(rowOf(/Coworking Kafi AG/)).getByRole('checkbox', { name: /Coworking Kafi AG/ }));
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

  it('the Ignoriert strip offers Wieder zu buchen, only through reopen_bank_line, with a reason', async () => {
    const ignored = line('bt_ign', {
      state: 'ignored',
      amountMinor: -1_200,
      counterparty: { name: 'Parkhaus Seeplatz', iban: null },
      decision: { linkId: 'lk_2', targetKind: 'ignore', entryId: null, paymentId: null, ignoreReason: 'duplicate', note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' },
    });
    const reopen = vi.fn<Handler>(() => ok({ bankTxnId: 'bt_ign', previousState: 'ignored', state: 'open', reversedEntryIds: [], reversedPaymentIds: [], warnings: [] }));
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ignored]), list_drafted_actions: ok({ actions: [] }), reopen_bank_line: reopen })), '/bank?tab=ignored');
    const row = await findRow(/Parkhaus Seeplatz/);
    await clickRow(row);
    const strip = stripOf('bt_ign') as HTMLElement;
    expect(within(strip).getByText('Grund: Doppelt geliefert')).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole('button', { name: 'Wieder zu buchen' }));
    const form = await screen.findByRole('form', { name: 'Wieder zu buchen' });
    expect(within(form).getByText(/gebucht wird nichts/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Wieder zu buchen' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(reopen.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_ign', reason: 'Versehentlich ignoriert' });
    expect(typeof reopen.mock.calls[0]?.[0].idempotencyKey).toBe('string');
    expect(await screen.findByText(/Parkhaus Seeplatz ist wieder zu buchen/)).toBeInTheDocument();
  });

  it('the Gebucht strip offers Stornieren (and the Beleg); the row overflow reaches the same form', async () => {
    const decided = { linkId: 'lk_5', targetKind: 'accounts', entryId: 'je_5', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' };
    const booked = line('bt_booked', { state: 'booked', amountMinor: -4_500, counterparty: { name: 'Druckerei Seefeld AG', iban: null }, decision: decided });
    const reopen = vi.fn<Handler>(() => ok({ bankTxnId: 'bt_booked', previousState: 'booked', state: 'open', reversedEntryIds: ['je_5'], reversedPaymentIds: [], warnings: [] }));
    renderBank(
      fakeTransport(happy({ list_bank_inbox: inboxFor([booked]), list_drafted_actions: ok({ actions: [] }), reopen_bank_line: reopen, get_entry: ok({ entry: { id: 'je_5', date: '2026-09-23', description: 'Bank' }, lines: [{ account: account('6500'), debit: 4_500, credit: 0 }, { account: BANK_LEDGER, debit: 0, credit: 4_500 }] }) })),
      '/bank?tab=booked',
    );
    const row = await findRow(/Druckerei Seefeld AG/);
    await clickRow(row);
    const strip = stripOf('bt_booked') as HTMLElement;
    // The posted entry, as one Buchungssatz off its stored lines (critic F2), and the door into the Journal.
    expect(await within(strip).findByText('6500 45.00 an 1020 45.00')).toBeInTheDocument();
    expect(within(strip).getByRole('link', { name: 'Buchung öffnen' })).toHaveAttribute('href', '/journal?entry=je_5');
    expect(within(strip).getByRole('button', { name: 'Beleg anhängen' })).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole('button', { name: 'Stornieren' }));
    const form = await screen.findByRole('form', { name: 'Stornieren' });
    await userEvent.click(within(form).getByRole('button', { name: 'Stornieren' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(reopen.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_booked', reason: 'Falsches Konto' });
  });

  it('shows an agent\'s undecided reopen_bank_line Vorschlag on its DECIDED line, with its decision (critic L7)', async () => {
    const decided = { linkId: 'lk_5', targetKind: 'accounts', entryId: 'je_5', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' };
    const booked = line('bt_booked', { state: 'booked', amountMinor: -4_500, counterparty: { name: 'Druckerei Seefeld AG', iban: null }, decision: decided });
    const reopenVorschlag = { ...VORSCHLAG, actionId: 'act_9', actionTool: 'reopen_bank_line', payload: { workspaceId: 'ws_test', bankTxnId: 'bt_booked', reason: 'falsches Konto' } };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([booked]), list_drafted_actions: ok({ actions: [reopenVorschlag] }), get_entry: ok({ entry: { id: 'je_5', date: '2026-09-23', description: 'Bank' }, lines: [] }) })), '/bank?line=bt_booked&tab=booked');
    await waitFor(() => expect(stripOf('bt_booked')).not.toBeNull());
    const strip = stripOf('bt_booked') as HTMLElement;
    expect(await within(strip).findByText('Vorschlag des Agenten')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Freigeben' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Ablehnen' })).toBeInTheDocument();
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
    const tr = await findRow(/Sparkonto Seefeld/);
    expect(within(tr).queryByRole('button', { name: 'Buchen' })).toBeNull();
    await clickRow(tr);
    expect(await screen.findByText(/in einem anderen Monat als diese Zeile/)).toBeInTheDocument();
    const rr = rowOf(/Sammelauftrag/);
    expect(within(rr).queryByRole('button', { name: 'Buchen' })).toBeNull();
    await clickRow(rr);
    expect(await screen.findByText(/lässt sich nicht mehr verwerfen/)).toBeInTheDocument();
  });

  it('the pick bar books only the checked SURE lines: a line the person gave a target stays (spec §6, critic L6)', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_4', remainder: null }));
    renderBank(fakeTransport(happy({ book_bank_line: book, list_drafted_actions: ok({ actions: [] }) })));
    await findRow(/Alpina Telecom AG/);
    // Give Alpina a target by hand: bookable, but not reference-proven.
    await userEvent.click(within(rowOf(/Alpina Telecom AG/)).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    await userEvent.keyboard('6500{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(rowOf(/Coworking Kafi AG/)).getByRole('checkbox', { name: /Coworking Kafi AG/ }));
    await userEvent.click(within(rowOf(/Alpina Telecom AG/)).getByRole('checkbox', { name: /Alpina Telecom AG/ }));
    const bar = screen.getByRole('region', { name: 'Ausgewählte Zeilen' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Sichere buchen (1)' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0]?.[0]).toMatchObject({ bankTxnId: 'bt_kafi' });
  });

  it("says an import's warning in words: a file that is not the day-end statement", async () => {
    const importCamt = vi.fn<Handler>(() => ok({ statementId: 'st_2', txnCount: 2, duplicate: false, skipped: [], warnings: ['not_day_end_statement'] }));
    renderBank(fakeTransport(happy({ import_camt: importCamt })));
    await settledRows();
    const menu = await openHeaderMenu('Kontoauszug holen');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Datei importieren' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    expect(importCamt.mock.calls[0]?.[0]).not.toHaveProperty('allowDuplicateEntries');
    expect(await screen.findByText(/Das ist kein Tagesendauszug/)).toBeInTheDocument();
  });

  it('the lines an import brings land once with the Commit moment\'s tint, beside the dot that marks them (D122 D-I)', async () => {
    // The import names the statement every fixture line belongs to, so the re-read brings them as fresh.
    const importCamt = vi.fn<Handler>(() => ok({ statementId: 'st_1', txnCount: 2, duplicate: false, skipped: [], warnings: [] }));
    renderBank(fakeTransport(happy({ import_camt: importCamt })));
    await settledRows();
    expect(document.querySelectorAll('tr[data-just-committed]')).toHaveLength(0);
    const menu = await openHeaderMenu('Kontoauszug holen');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Datei importieren' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelectorAll('tr[data-fresh="true"][data-just-committed]').length).toBeGreaterThan(0));
    // Only the fresh lines land, and the stamp lifts once the tint has decayed; the dot stays.
    for (const row of document.querySelectorAll('tr[data-just-committed]')) expect(row).toHaveAttribute('data-fresh', 'true');
    await waitFor(() => expect(document.querySelectorAll('tr[data-just-committed]')).toHaveLength(0), { timeout: 2000 });
    expect(document.querySelectorAll('tr[data-fresh="true"]').length).toBeGreaterThan(0);
  });

  it('A36 under B2: several statement files go through the header menu\'s "Datei importieren", one import_camt_files call, one sentence', async () => {
    const many = vi.fn<Handler>(() =>
      ok({
        statements: [
          { file: 'tag-1.xml', part: 1, number: 1, year: 2026, fromDate: '2026-09-01', outcome: 'imported', txnCount: 3 },
          { file: 'tag-2.xml', part: 1, number: 2, year: 2026, fromDate: '2026-09-02', outcome: 'refused', error: 'invalid_input' },
        ],
      }),
    );
    renderBank(fakeTransport(happy({ import_camt_files: many })));
    await settledRows();
    const menu = await openHeaderMenu('Kontoauszug holen');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Datei importieren' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('multiple');
    const camt = (name: string) => new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], name, { type: 'text/xml' });
    await userEvent.upload(input, [camt('tag-1.xml'), camt('tag-2.xml')]);
    await userEvent.click(await within(dialog).findByRole('button', { name: '2 Dateien importieren' }));
    await waitFor(() => expect(many).toHaveBeenCalledTimes(1));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Fertig' }));
    expect(await screen.findByText('1 von 2 Auszügen importiert.')).toBeInTheDocument();
    // No banner: the drop's outcome is the one ack sentence (the per-file reasons were in the dialog).
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns before the commit when a leg books straight to a control account: the strip opens with it', async () => {
    // The recorded chart carries 2000 Verbindlichkeiten, the payable control account.
    renderBank(fakeTransport(happy()));
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);
    await userEvent.click(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    await userEvent.keyboard('2000{Enter}');
    expect(await within(stripOf('bt_alpina') as HTMLElement).findByText(/Du buchst direkt auf 2000 Verbindlichkeiten/)).toBeInTheDocument();
    // A balance-sheet account books without a code: no MWST picker chains in, Buchen takes the focus.
    expect(within(rowOf(/Alpina Telecom AG/)).queryByRole('button', { name: /^MWST/ })).toBeNull();
    await waitFor(() => expect(within(rowOf(/Alpina Telecom AG/)).getByRole('button', { name: 'Buchen' })).toHaveFocus());
  });

  it('the overflow opens an editor in the strip, and Abbrechen brings the strip back to its one line', async () => {
    renderBank(fakeTransport(happy()));
    const alpina = await findRow(/Alpina Telecom AG/);
    await userEvent.click(within(alpina).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Ignorieren/ }));
    expect(await screen.findByRole('heading', { name: 'Zeile ignorieren' })).toBeInTheDocument();
    expect(stripOf('bt_alpina')).toHaveAttribute('data-mode', 'ignore');
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('heading', { name: 'Zeile ignorieren' })).toBeNull();
    expect(stripOf('bt_alpina')).toHaveAttribute('data-mode', 'details');
  });

  it('Aufteilen in the strip expands into the split editor, with its full Soll/Haben preview', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), list_drafted_actions: ok({ actions: [] }) })));
    const row = await findRow(/Druckerei Talweg/);
    await clickRow(row);
    await userEvent.click(within(stripOf('bt_druck') as HTMLElement).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(within(editor).getByRole('region', { name: 'So wird gebucht' })).toBeInTheDocument();
    expect(await within(editor).findByText(/1170/)).toBeInTheDocument();
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
    renderBank(fakeTransport(happy({ list_bank_inbox: inbox, list_drafted_actions: ok({ actions: [] }), get_entry: ok({ entry: { id: 'je_9', date: '2026-07-01', description: 'Bank' }, lines: [] }) })), '/bank?tab=booked&line=bt_far');
    await findRow(/Alte Zeile GmbH/);
    await waitFor(() => expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_far']));
    expect(stripOf('bt_far')).not.toBeNull();
    expect(stripOf('bt_near')).toBeNull();
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
    expect(selectedRows()).toHaveLength(0);
    expect(document.querySelector('tr.bank-strip')).toBeNull();
  });

  it('A36: with an active EBICS channel, "Kontoauszug holen" offers the fetch, says when it last ran, and drives bank_sync with a fresh key', async () => {
    const channel = { connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: '2026-09-24T18:00:00.000Z' };
    const bankSync = vi.fn<Handler>(() =>
      ok({ connectionId: 'ebconn_1', download: { outcome: 'downloaded' }, statements: [{ outcome: 'imported', final: true }, { outcome: 'already_imported', final: true }] }),
    );
    renderBank(fakeTransport(happy({ bank_channel_status: ok({ channels: [channel] }), bank_sync: bankSync })));
    await settledRows();
    await waitFor(async () => {
      const menu = await openHeaderMenu('Kontoauszug holen');
      expect(within(menu).getByRole('menuitem', { name: 'Von der Bank abrufen' })).toBeInTheDocument();
    });
    expect(screen.getByText('Zuletzt abgerufen: 24.09.2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Von der Bank abrufen' }));
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
    await waitFor(async () => {
      const menu = await openHeaderMenu('Kontoauszug holen');
      expect(within(menu).getByRole('menuitem', { name: 'Von der Bank abrufen' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Von der Bank abrufen' }));
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
    await userEvent.click(within(await openHeaderMenu('Kontoauszug holen')).getByRole('menuitem', { name: 'Datei importieren' }));
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
    await userEvent.click(within(await openHeaderMenu('Kontoauszug holen')).getByRole('menuitem', { name: 'Datei importieren' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'auszug.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(importCamt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nach Auszug 1 kam Auszug 3\. Fehlende Nummern: 2\/2026\./)).toBeInTheDocument();
  });

  it('A36: no active EBICS channel, no fetch item; a fetch refusal renders through the shared banner in words', async () => {
    renderBank(fakeTransport(happy()));
    await settledRows();
    const menu = await openHeaderMenu('Kontoauszug holen');
    expect(within(menu).queryByRole('menuitem', { name: 'Von der Bank abrufen' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Datei importieren' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    const channel = { connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: null };
    const refused = (): RestResponse => refuse('download_refused', { kind: 'not_granted', code: '090003' });
    renderBank(fakeTransport(happy({ bank_channel_status: ok({ channels: [channel] }), bank_sync: refused })));
    await waitFor(async () => {
      const menus = screen.getAllByRole('button', { name: 'Kontoauszug holen' });
      await userEvent.click(menus[menus.length - 1] as HTMLElement);
      expect(screen.getByRole('menuitem', { name: 'Von der Bank abrufen' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Von der Bank abrufen' }));
    expect(await screen.findByText(/gibt den Abruf der Auszüge \(camt\.053 Version 08\) für deinen Vertrag nicht frei \(Code 090003\)/)).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations once settled, with a strip and the balance card open, in the %s theme', async (theme) => {
    const transport = watchReads(fakeTransport(happy({ list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE, DRUCK]) })));
    const { container } = renderBank(transport, '/bank', { theme });
    await transport.started('list_bank_inbox');
    await findRow(/Druckerei Talweg/);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    expect(await axe(container)).toHaveNoViolations();
    await clickRow(rowOf(/Druckerei Talweg/));
    await within(stripOf('bt_druck') as HTMLElement).findByText(/davon MWST/);
    await userEvent.hover(screen.getByRole('button', { name: /Zahlen und Erklärung/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the toolbar: facets, direction, and the Übersicht band\'s doors (D142)', () => {
  const decided = (entryId: string) => ({ linkId: `lk_${entryId}`, targetKind: 'accounts', entryId, paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' });
  const NO_RECEIPT = line('bt_nr', { state: 'booked', amountMinor: -6_450, counterparty: { name: 'Papeterie Seefeld', iban: null }, decision: decided('je_nr'), needsReceipt: true });
  const WITH_RECEIPT = line('bt_wr', { state: 'booked', amountMinor: -2_100, counterparty: { name: 'Post CH', iban: null }, decision: decided('je_wr'), receiptCount: 2 });

  it('/bank?facet=sure opens the open lines on the ENGINE\'s sure facet', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })), '/bank?facet=sure');
    await findRow(/Coworking Kafi AG/);
    expect(screen.queryByRole('row', { name: /Alpina Telecom AG/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Sicher/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('/bank?facet=needs lists the lines the engine marks as needing you', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })), '/bank?facet=needs');
    await findRow(/Alpina Telecom AG/);
    expect(rowOf(/Café Seeblick/)).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Coworking Kafi AG/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Brauchen dich/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the facets carry their counts, and a facet that would change nothing (0, or every line) is hidden', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })));
    await findRow(/Alpina Telecom AG/);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Brauchen dich/ })).toHaveTextContent('2'));
    expect(screen.getByRole('button', { name: /^Sicher/ })).toHaveTextContent('1');
  });

  it('with every line needing the person, neither facet shows: one equals the total, the other is 0', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ALPINA, CAFE]), list_drafted_actions: ok({ actions: [] }) })));
    await findRow(/Alpina Telecom AG/);
    expect(screen.queryByRole('group', { name: 'Zeilen filtern' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Brauchen dich/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sicher/ })).toBeNull();
    // Both lines are money out: the direction toggles would change nothing either.
    expect(screen.queryByRole('button', { name: 'Nur Eingänge' })).toBeNull();
  });

  it('the direction toggles narrow to money in or out, pressed in the URL, and the older ?facet=in still reads', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })));
    await findRow(/Alpina Telecom AG/);
    const inOnly = screen.getByRole('button', { name: 'Nur Eingänge' });
    expect(inOnly).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(inOnly);
    expect(inOnly).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('row', { name: /Alpina Telecom AG/ })).toBeNull();
    expect(rowOf(/Coworking Kafi AG/)).toBeInTheDocument();
  });

  it('the legacy /bank?facet=out link opens the money-out lines', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }) })), '/bank?facet=out');
    await findRow(/Alpina Telecom AG/);
    expect(screen.queryByRole('row', { name: /Coworking Kafi AG/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nur Ausgänge' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a sure proposal the engine marks as needing you (a Vorschlag names it) is not under Sicher', async () => {
    const kafiNeeds = { ...KAFI, attention: 'needs' };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([kafiNeeds, ALPINA, CAFE]), list_drafted_actions: ok({ actions: [] }) })), '/bank?facet=sure');
    await screen.findByText('Keine Zeile passt zu Suche und Filter.');
    expect(screen.queryByRole('row', { name: /Coworking Kafi AG/ })).toBeNull();
  });

  it('/bank?tab=booked&facet=noreceipt shows exactly the lines booked to accounts without a Beleg, marked in words', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([NO_RECEIPT, WITH_RECEIPT]), list_drafted_actions: ok({ actions: [] }), get_entry: ok({ entry: { id: 'je_nr', date: '2026-09-23', description: 'Bank' }, lines: [] }) })), '/bank?tab=booked&facet=noreceipt');
    const row = await findRow(/Papeterie Seefeld/);
    expect(within(row).getByText('Ohne Beleg')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Post CH/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Ohne Beleg/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a row with receipts shows the paperclip with its count; the strip\'s count opens the line\'s Belege', async () => {
    const { transport, calls } = recording(
      happy({ list_bank_inbox: inboxFor([NO_RECEIPT, WITH_RECEIPT]), list_drafted_actions: ok({ actions: [] }), get_entry: ok({ entry: { id: 'je_wr', date: '2026-09-23', description: 'Bank' }, lines: [] }), files_list_linked: ok({ files: [], truncated: false }) }),
    );
    renderBank(transport, '/bank?tab=booked');
    const row = await findRow(/Post CH/);
    expect(within(row).getByText('2 Belege angehängt')).toBeInTheDocument();
    await clickRow(row);
    await userEvent.click(within(stripOf('bt_wr') as HTMLElement).getByRole('button', { name: '2 Belege' }));
    expect(await screen.findByRole('heading', { name: 'Belege' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.action === 'files_list_linked' && c.input.entityKind === 'bank_txn' && c.input.entityId === 'bt_wr')).toBe(true));
  });
});

describe('Belege on bank lines (D142 in B2)', () => {
  const filing = { files_upload: ok({ file: { id: 'file_1' } }), files_link: ok({ file: { id: 'file_1' }, retentionDerived: false }) };

  it('a file dropped on a row is attached to THAT line: files_upload, then files_link with bank_txn, then the inbox recounts', async () => {
    const { transport, calls } = recording(happy({ list_drafted_actions: ok({ actions: [] }), ...filing }));
    renderBank(transport);
    const row = await findRow(/Alpina Telecom AG/);
    const before = calls.filter((c) => c.action === 'list_bank_inbox').length;
    const file = new File(['synthetischer Beleg'], 'beleg.pdf', { type: 'application/pdf' });
    const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' };
    fireEvent.dragEnter(row, { dataTransfer });
    expect(row).toHaveAttribute('data-drop', 'true');
    fireEvent.drop(row, { dataTransfer });
    await waitFor(() => expect(calls.some((c) => c.action === 'files_link')).toBe(true));
    const upload = calls.findIndex((c) => c.action === 'files_upload');
    const link = calls.findIndex((c) => c.action === 'files_link');
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(upload).toBeLessThan(link);
    expect(calls[upload]?.input).toMatchObject({ workspaceId: 'ws_test', filename: 'beleg.pdf', mime: 'application/pdf' });
    expect(calls[link]?.input).toMatchObject({ workspaceId: 'ws_test', fileId: 'file_1', entityKind: 'bank_txn', entityId: 'bt_alpina' });
    expect(typeof calls[upload]?.input.idempotencyKey).toBe('string');
    expect(typeof calls[link]?.input.idempotencyKey).toBe('string');
    expect(await screen.findByText('Beleg angehängt: beleg.pdf an Alpina Telecom AG.')).toBeInTheDocument();
    // The Commit moment (D122 D-I): the line stays where it is, so ITS row takes the tint, and only it.
    expect(row).toHaveAttribute('data-just-committed');
    expect(document.querySelectorAll('tr[data-just-committed]')).toHaveLength(1);
    await waitFor(() => expect(calls.filter((c) => c.action === 'list_bank_inbox').length).toBeGreaterThan(before));
    // The stamp lifts once the tint has decayed.
    await waitFor(() => expect(row).not.toHaveAttribute('data-just-committed'), { timeout: 2000 });
  });

  it('"Beleg anhängen" in the strip picks a file for that line', async () => {
    const { transport, calls } = recording(happy({ list_drafted_actions: ok({ actions: [] }), ...filing }));
    renderBank(transport);
    const row = await findRow(/Café Seeblick/);
    await clickRow(row);
    await userEvent.click(within(stripOf('bt_cafe') as HTMLElement).getByRole('button', { name: 'Beleg anhängen' }));
    const input = document.querySelector('input[type="file"][aria-label="Beleg anhängen"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['synthetisch'], 'quittung.png', { type: 'image/png' })] } });
    await waitFor(() => expect(calls.some((c) => c.action === 'files_link')).toBe(true));
    expect(calls.find((c) => c.action === 'files_link')?.input).toMatchObject({ entityKind: 'bank_txn', entityId: 'bt_cafe' });
  });

  it('without the filing right there is no drop target, no strip paperclip and no overflow item', async () => {
    renderBank(fakeTransport(happy({ list_drafted_actions: ok({ actions: [] }), ...filing })), '/bank', { held: [CAP.readSales, CAP.post, CAP.pay] });
    const row = await findRow(/Alpina Telecom AG/);
    fireEvent.dragEnter(row, { dataTransfer: { files: [], types: ['Files'] } });
    expect(row).not.toHaveAttribute('data-drop');
    await clickRow(row);
    expect(within(stripOf('bt_alpina') as HTMLElement).queryByRole('button', { name: 'Beleg anhängen' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    expect(screen.queryByRole('menuitem', { name: 'Beleg anhängen' })).toBeNull();
  });
});

describe('D144 (A39 §12): the model rung in the strip', () => {
  const PAPER = line('bt_paper', {
    bookingDate: '2026-09-22',
    valueDate: '2026-09-22',
    amountMinor: -8_450,
    counterparty: { name: 'Papeterie Sonnenberg', iban: null },
    remittance: { text: 'Büromaterial', referenceKind: 'NON', referenceValue: null, endToEndId: null },
    proposal: {
      target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_450 }] },
      certainty: 'check',
      reasonCode: 'model_suggested',
      reasonParams: { accountId: account('6500'), probability: 0.8249, decisionId: 'md_1', modelRef: 'lokal-klein-q4', candidates: 8, ece: 0.042 },
      vatCode: null,
    },
  });

  it('a model suggestion carries the KI tag, and the strip says in words: a model on this device, the percent, the measured ECE, nobody has checked it', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([PAPER, ALPINA, CAFE]) })), '/bank?line=bt_paper');
    const row = await findRow(/Papeterie Sonnenberg/);
    expect(within(row).getByText('Vorschlag eines KI-Modells, ungeprüft')).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf(/Papeterie Sonnenberg/)).getByRole('button', { name: /Buchen auf, Papeterie Sonnenberg/ })).toHaveTextContent('6500'));
    await waitFor(() => expect(stripOf('bt_paper')).not.toBeNull());
    const strip = stripOf('bt_paper') as HTMLElement;
    expect(within(strip).getByText('Bitte prüfen')).toBeInTheDocument();
    expect(
      within(strip).getByText('KI-Modell lokal-klein-q4 auf diesem Gerät: zu 82 % wahrscheinlich, gemessener Fehler 4.2 Prozentpunkte (ECE). Noch von niemandem geprüft.'),
    ).toBeInTheDocument();
    // Never offered to "Alle sicheren buchen": a probability is not a reference.
    expect(screen.queryByRole('button', { name: /Alle sicheren buchen/ })).toBeNull();
  });

  it('a decision recorded without a measured error says so rather than inventing one', async () => {
    const noEce = line('bt_paper', {
      bookingDate: '2026-09-22',
      valueDate: '2026-09-22',
      amountMinor: -8_450,
      counterparty: { name: 'Papeterie Sonnenberg', iban: null },
      proposal: {
        target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_450 }] },
        certainty: 'check',
        reasonCode: 'model_suggested',
        reasonParams: { accountId: account('6500'), probability: 0.8249, decisionId: 'md_1', modelRef: 'lokal-klein-q4', candidates: 8, ece: null },
        vatCode: null,
      },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([noEce]), list_drafted_actions: ok({ actions: [] }) })), '/bank?line=bt_paper');
    await waitFor(() => expect(stripOf('bt_paper')).not.toBeNull());
    expect(within(stripOf('bt_paper') as HTMLElement).getByText(/zu 82 % wahrscheinlich, Fehler nicht gemessen\. Noch von niemandem geprüft\./)).toBeInTheDocument();
  });

  it('once the person changes a model suggestion, the row no longer carries the KI tag', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([PAPER, ALPINA, CAFE]) })));
    const row = await findRow(/Papeterie Sonnenberg/);
    expect(within(row).getByText('KI')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /Buchen auf, Papeterie Sonnenberg/ }));
    await userEvent.keyboard('6570');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(rowOf(/Papeterie Sonnenberg/)).queryByText('KI')).toBeNull());
  });

  it('Konten vorschlagen sits in the header overflow, only with a registered local runtime, and asks suggest_bank_lines, booking nothing', async () => {
    const { transport, calls } = recording(
      happy({
        runtime_status: ok({ registered: true, runtimeId: 'lokal', modelRef: 'lokal-klein-q4', device: 'test', selection: null }),
        suggest_bank_lines: ok({ suggested: 2, remaining: 0, belowFloor: 0, unchanged: 0, considered: 2 }),
      }),
    );
    renderBank(transport);
    await settledRows();
    expect(screen.queryByRole('button', { name: 'Konten vorschlagen' })).toBeNull();
    await waitFor(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen für die Bank' }));
      expect(screen.getByRole('menuitem', { name: 'Konten vorschlagen' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Konten vorschlagen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'suggest_bank_lines')).toBe(true));
    const call = calls.find((c) => c.action === 'suggest_bank_lines');
    // Critic C1: exactly the unplaced lines in view, never "the newest 50 of the account".
    expect(call?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnIds: ['bt_alpina', 'bt_cafe'] });
    expect(typeof call?.input.idempotencyKey).toBe('string');
    expect(await screen.findByText('Vorgeschlagen: 2. Prüfe jede Zeile, bevor du buchst.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });

  it('without a registered runtime there is no Konten vorschlagen', async () => {
    renderBank(fakeTransport(happy({ runtime_status: ok({ registered: false, selection: null }) })));
    await settledRows();
    await userEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen für die Bank' }));
    expect(screen.getByRole('menuitem', { name: 'Bankkonten verwalten' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Konten vorschlagen' })).toBeNull();
  });

  it('a suggest refusal (the model lacks French) is said in words', async () => {
    renderBank(
      fakeTransport(
        happy({
          runtime_status: ok({ registered: true, runtimeId: 'lokal', modelRef: 'lokal-klein-q4', device: 'test', selection: null }),
          suggest_bank_lines: refuse('unsupported_model_language', { need: ['de', 'fr'], have: ['de', 'en'] }),
        }),
      ),
    );
    await settledRows();
    await waitFor(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen für die Bank' }));
      expect(screen.getByRole('menuitem', { name: 'Konten vorschlagen' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Konten vorschlagen' }));
    expect(await screen.findByText('Das installierte Modell liest nicht Deutsch und Französisch. Für Bankzeilen braucht es beides.')).toBeInTheDocument();
  });
});

/**
 * EVERY ACTION THE SURFACE HAD BEFORE B2 IS STILL REACHABLE, AND BEHIND THE SAME A24 GATE. The list is
 * the old panel's and the old header's, action by action: where each now lives, and that a seat without
 * the right sees it disabled or not at all (never shown and then refused).
 */
describe('B2 keeps every action, behind the same gates', () => {
  const runtime = { runtime_status: ok({ registered: true, runtimeId: 'lokal', modelRef: 'm', device: 'test', selection: null }) };
  const channel = { bank_channel_status: ok({ channels: [{ connectionId: 'ebconn_1', channelKind: 'ebics', state: 'active', lastSyncAt: null }] }) };

  async function menuItems(trigger: HTMLElement): Promise<Map<string, HTMLElement>> {
    await userEvent.click(trigger);
    const items = new Map(screen.getAllByRole('menuitem').map((i) => [i.textContent ?? '', i]));
    await userEvent.keyboard('{Escape}');
    return items;
  }

  it('with every right: the row, its overflow, the strip, the picker, the header and its menus offer them all', async () => {
    renderBank(fakeTransport(happy({ ...runtime, ...channel })), '/bank', { held: EVERY_RIGHT });
    await settledRows();
    const alpina = rowOf(/Alpina Telecom AG/);

    // The row overflow: the panel's old commits and the menu's old items.
    const rowMenu = await menuItems(within(alpina).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    expect([...rowMenu.keys()]).toEqual(['Aufteilen oder manuell buchen', 'Mit bestehender Buchung abgleichen', 'Agent fragen', 'Beleg anhängen', 'Ignorieren']);
    expect([...rowMenu.values()].every((i) => i.getAttribute('aria-disabled') === null)).toBe(true);

    // The target picker still offers the match and the split as its "Weitere".
    await userEvent.click(within(alpina).getByRole('button', { name: /Buchen auf, Alpina Telecom AG/ }));
    expect(screen.getByRole('option', { name: /Mit bestehender Buchung abgleichen/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Aufteilen oder manuell buchen/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    // The strip's tools.
    await clickRow(alpina);
    const strip = stripOf('bt_alpina') as HTMLElement;
    for (const name of ['Aufteilen', 'Mit Buchung abgleichen', 'Agent fragen', 'Beleg anhängen', 'Ignorieren']) {
      expect(within(strip).getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
    }

    // The agent's Vorschlag: Freigeben and Ablehnen, on the line it names.
    await userEvent.click(within(rowOf(/Café Seeblick/)).getByRole('button', { name: 'Prüfen' }));
    const cafe = stripOf('bt_cafe') as HTMLElement;
    expect(within(cafe).getByRole('button', { name: 'Freigeben' })).toBeEnabled();
    expect(within(cafe).getByRole('button', { name: 'Ablehnen' })).toBeEnabled();

    // The header: the statement menu, the one primary, the overflow.
    const statement = await menuItems(screen.getByRole('button', { name: 'Kontoauszug holen' }));
    expect([...statement.keys()]).toEqual(['Von der Bank abrufen', 'Datei importieren']);
    expect(screen.getByRole('button', { name: 'Alle sicheren buchen (1)' })).toBeEnabled();
    const header = await menuItems(screen.getByRole('button', { name: 'Weitere Aktionen für die Bank' }));
    expect([...header.keys()]).toEqual(['Bankkonten verwalten', 'Konten vorschlagen']);

    // The balance card's door into the open lines.
    await userEvent.hover(screen.getByRole('button', { name: /Zahlen und Erklärung/ }));
    expect(screen.getByRole('button', { name: /3 Zeilen offen/ })).toBeInTheDocument();
  });

  it('without `post` and `pay`: Buchen, the strip tools, the overflow commits, the header writes are disabled or absent, never live', async () => {
    renderBank(fakeTransport(happy({ ...runtime, ...channel })), '/bank', { held: [CAP.readSales] });
    await findRow(/Alpina Telecom AG/);
    const kafi = rowOf(/Coworking Kafi AG/);
    const book = await within(kafi).findByRole('button', { name: 'Buchen' });
    expect(book).toHaveAttribute('aria-disabled', 'true');
    expect(document.getElementById(book.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Eine Rechnung oder einen Zahlungslauf begleichen braucht das Recht, Zahlungen zu buchen.');

    const alpina = rowOf(/Alpina Telecom AG/);
    const rowMenu = await menuItems(within(alpina).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    for (const name of ['Aufteilen oder manuell buchen', 'Mit bestehender Buchung abgleichen', 'Ignorieren']) expect(rowMenu.get(name)).toHaveAttribute('aria-disabled', 'true');
    expect(rowMenu.has('Beleg anhängen')).toBe(false);

    await clickRow(alpina);
    const strip = stripOf('bt_alpina') as HTMLElement;
    for (const name of ['Aufteilen', 'Mit Buchung abgleichen', 'Ignorieren']) expect(within(strip).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(strip).getByRole('button', { name: 'Ignorieren' }));
    expect(screen.queryByRole('heading', { name: 'Zeile ignorieren' })).toBeNull();

    const statement = await menuItems(screen.getByRole('button', { name: 'Kontoauszug holen' }));
    expect(statement.get('Von der Bank abrufen')).toHaveAttribute('aria-disabled', 'true');
    expect(statement.get('Datei importieren')).toHaveAttribute('aria-disabled', 'true');
    const header = await menuItems(screen.getByRole('button', { name: 'Weitere Aktionen für die Bank' }));
    expect(header.get('Konten vorschlagen')).toHaveAttribute('aria-disabled', 'true');

    // The Gebucht strip's Stornieren needs `post` too.
  });

  it('without `post`, the Gebucht strip\'s Stornieren and the Ignoriert strip\'s undo are disabled', async () => {
    const decided = { linkId: 'lk_5', targetKind: 'accounts', entryId: 'je_5', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' };
    const booked = line('bt_booked', { state: 'booked', amountMinor: -4_500, counterparty: { name: 'Druckerei Seefeld AG', iban: null }, decision: decided });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([booked]), list_drafted_actions: ok({ actions: [] }), get_entry: ok({ entry: { id: 'je_5', date: '2026-09-23', description: 'Bank' }, lines: [] }) })), '/bank?tab=booked', { held: [CAP.readSales] });
    const row = await findRow(/Druckerei Seefeld AG/);
    await clickRow(row);
    expect(within(stripOf('bt_booked') as HTMLElement).getByRole('button', { name: 'Stornieren' })).toBeDisabled();
    const rowMenu = await menuItems(within(row).getByRole('button', { name: /Weitere Aktionen für Druckerei Seefeld AG/ }));
    expect(rowMenu.get('Stornieren')).toHaveAttribute('aria-disabled', 'true');
  });
});

/**
 * The non-author critic's round 1 on B2 (critic/bank-b2, bb3bae2), adopted as regressions: each test
 * below reproduced a finding before its fix. Every name, IBAN and figure is invented for this file.
 */
describe('critic round 1 on B2', () => {
  const noVorschlag = { list_drafted_actions: ok({ actions: [] }) };

  // ---- F1 (C1): an Anlagekonto carries Vorsteuer auf Investitionen from the row ------------------------
  it('F1: a debit proposed to 1520 shows the MWST picker; VST-I books 1520 net, 1171 tax and the bank gross', async () => {
    const LAPTOP = line('bt_laptop', {
      amountMinor: -216_200,
      counterparty: { name: 'Rechnerladen Muster GmbH', iban: null },
      remittance: { text: 'Notebook', referenceKind: 'NON', referenceValue: null, endToEndId: null },
      proposal: {
        target: { kind: 'accounts', legs: [{ accountId: account('1520'), amountMinor: 216_200, taxCode: '' }] },
        certainty: 'learned',
        reasonCode: 'history',
        reasonParams: { accountId: account('1520'), taxCode: '', lastDate: '2026-08-01', count: 1 },
        vatCode: null,
      },
    });
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_l', remainder: null }));
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([LAPTOP]), book_bank_line: book, ...noVorschlag })));
    const row = await findRow(/Rechnerladen Muster GmbH/);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Buchen auf, Rechnerladen/ })).toHaveTextContent('1520'));
    const picker = within(row).getByRole('button', { name: 'MWST, Rechnerladen Muster GmbH' });
    await userEvent.click(picker);
    await userEvent.keyboard('VST-I{Enter}');
    await clickRow(rowOf(/Rechnerladen Muster GmbH/));
    expect(await within(stripOf('bt_laptop') as HTMLElement).findByText(/davon MWST 162\.00 auf 1171 · netto 2.000\.00/)).toBeInTheDocument();
    await userEvent.click(within(rowOf(/Rechnerladen Muster GmbH/)).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0]?.[0]).toMatchObject({ target: { kind: 'accounts', legs: [{ accountId: account('1520'), amountMinor: 216_200, taxCode: 'VST-I' }] } });
  });

  it('Vorräte carry MWST (owner, 04.10.2026: asset accounts 12xx or 14xx to 17xx); receivables (1100) do not', async () => {
    const proposedTo = (id: string, number: string, name: string) =>
      line(id, {
        amountMinor: -10_770,
        counterparty: { name, iban: null },
        proposal: { target: { kind: 'accounts', legs: [{ accountId: account(number), amountMinor: 10_770, taxCode: '' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account(number), taxCode: '', lastDate: '2026-08-01', count: 1 }, vatCode: null },
      });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([proposedTo('bt_stock', '1200', 'Grosshandel Muster AG'), proposedTo('bt_recv', '1100', 'Kunde Muster AG')]), ...noVorschlag })));
    const stock = await findRow(/Grosshandel Muster AG/);
    await waitFor(() => expect(within(stock).getByRole('button', { name: /Buchen auf, Grosshandel/ })).toHaveTextContent('1200'));
    expect(within(stock).getByRole('button', { name: 'MWST, Grosshandel Muster AG' })).toBeInTheDocument();
    const recv = await findRow(/Kunde Muster AG/);
    await waitFor(() => expect(within(recv).getByRole('button', { name: /Buchen auf, Kunde/ })).toHaveTextContent('1100'));
    expect(within(recv).queryByRole('button', { name: /^MWST/ })).toBeNull();
  });

  it('F1: no MWST picker on a VAT account or on another Bankkonto\'s ledger account', async () => {
    const toVat = line('bt_tovat', {
      amountMinor: -50_000,
      counterparty: { name: 'Steuerverwaltung Muster', iban: null },
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('2200'), amountMinor: 50_000, taxCode: '' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('2200'), taxCode: '', lastDate: '2026-08-01', count: 1 }, vatCode: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([toVat]), ...noVorschlag })));
    const row = await findRow(/Steuerverwaltung Muster/);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Buchen auf, Steuerverwaltung/ })).toHaveTextContent('2200'));
    expect(within(row).queryByRole('button', { name: /^MWST/ })).toBeNull();
  });

  // ---- F2 (C9): the Gebucht strip names what was posted, and links the entry ---------------------------
  it('F2: a compound entry is cut to two accounts a side in the strip, the whole Buchungssatz in its tooltip', async () => {
    const decided = { linkId: 'lk_7', targetKind: 'accounts', entryId: 'je_7', paymentId: null, ignoreReason: null, note: null, remainderMode: null, remainderMinor: null, differenceMinor: null, decidedBy: 'studio', decidedAt: '2026-09-24T08:00:00Z' };
    const booked = line('bt_split', { state: 'booked', amountMinor: -12_000, counterparty: { name: 'Sammelrechnung AG', iban: null }, decision: decided });
    const lines = [
      { account: account('6500'), debit: 5_000, credit: 0 },
      { account: account('6570'), debit: 3_000, credit: 0 },
      { account: account('6700'), debit: 3_000, credit: 0 },
      { account: account('1170'), debit: 1_000, credit: 0 },
      { account: BANK_LEDGER, debit: 0, credit: 12_000 },
    ];
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([booked]), ...noVorschlag, get_entry: ok({ entry: { id: 'je_7', date: '2026-09-23', description: 'Bank' }, lines }) })), '/bank?tab=booked');
    await clickRow(await findRow(/Sammelrechnung AG/));
    const strip = stripOf('bt_split') as HTMLElement;
    const satz = await within(strip).findByText('6500 50.00 · 6570 30.00 +2 an 1020 120.00');
    expect(document.getElementById(satz.getAttribute('aria-describedby') ?? '')).toHaveTextContent('6500 50.00 · 6570 30.00 · 6700 30.00 · 1170 10.00 an 1020 120.00');
    expect(within(strip).getByRole('link', { name: 'Buchung öffnen' })).toHaveAttribute('href', '/journal?entry=je_7');
    // Who decided it gives way first to keep the strip one line, so its whole sentence is its tooltip.
    const by = strip.querySelector('.bank-strip__cut') as HTMLElement;
    expect(by).toHaveTextContent(/^Entschieden von .+ am 24\.09\.2026$/);
    expect(document.getElementById(by.getAttribute('aria-describedby') ?? '')).toHaveTextContent(by.textContent ?? '');
  });

  // ---- F3 (C2): the keyboard never books a line nobody chose -----------------------------------------
  const learned = (id: string, name: string, minor: number, date = '2026-09-23') =>
    line(id, {
      bookingDate: date,
      valueDate: date,
      amountMinor: -minor,
      counterparty: { name, iban: null },
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: minor, taxCode: '' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('6500'), taxCode: '', lastDate: '2026-08-01', count: 2 }, vatCode: null },
    });

  it('F3: after Enter books a line from its row, the next Enter lands on the next ROW and books nothing', async () => {
    let lines = [learned('bt_a', 'Erster Lieferant AG', 1_000), learned('bt_b', 'Zweiter Lieferant AG', 2_000, '2026-09-22')];
    const book = vi.fn<Handler>((input) => {
      lines = lines.map((l) => (l.bankTxnId === input.bankTxnId ? { ...l, state: 'booked', attention: null } : l));
      return ok({ state: 'booked', entryId: `je_${String(input.bankTxnId)}`, remainder: null });
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: (input) => inboxFor(lines)(input), book_bank_line: book, ...noVorschlag })));
    const first = await findRow(/Erster Lieferant AG/);
    const buchen = await within(first).findByRole('button', { name: 'Buchen' });
    act(() => buchen.focus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('row', { name: /Erster Lieferant AG/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowOf(/Zweiter Lieferant AG/)));
    await userEvent.keyboard('{Enter}');
    // Wait INSIDE act: the surface still settles in this window. The search box's 250 ms debounce
    // (`Bank.tsx`, the effect that runs `setQuery` "a moment after typing stops") fires on a timer that
    // was armed at mount, and that update is the surface working, not a booking. Waiting outside act made
    // the test a race on whether the earlier steps finished before or after that timer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(book.mock.calls.map((c) => c[0].bankTxnId)).toEqual(['bt_a']);
  });

  it('F3: a held Enter on Buchen (a key repeat) never books', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_r', remainder: null }));
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([learned('bt_r', 'Wiederholung AG', 1_000)]), book_bank_line: book, ...noVorschlag })));
    const button = await within(await findRow(/Wiederholung AG/)).findByRole('button', { name: 'Buchen' });
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    button.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(book).not.toHaveBeenCalled();
  });

  // ---- F4 (C4): Einfuhrsteuer is the payment itself, never owed "on top" -----------------------------
  it('F4: an Einfuhrsteuer payment says the payment is the tax, never "dazu MWST"', async () => {
    const ZOLL = line('bt_zoll', {
      amountMinor: -7_700,
      counterparty: { name: 'Speditionshaus Beispiel AG', iban: null },
      remittance: { text: 'Einfuhrsteuer', referenceKind: 'NON', referenceValue: null, endToEndId: null },
      proposal: {
        target: { kind: 'accounts', legs: [{ accountId: account('4200'), amountMinor: 7_700, taxCode: 'IMPORT' }] },
        certainty: 'learned',
        reasonCode: 'history',
        reasonParams: { accountId: account('4200'), taxCode: 'IMPORT', lastDate: '2026-08-01', count: 2 },
        vatCode: 'IMPORT',
      },
    });
    // The engine composes kind import: the assessed amount IS the tax, booked to 1170.
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ZOLL]), ...noVorschlag })));
    await clickRow(await findRow(/Speditionshaus Beispiel AG/));
    const strip = stripOf('bt_zoll') as HTMLElement;
    expect(await within(strip).findByText('die Zahlung ist die Einfuhrsteuer, auf 1170')).toBeInTheDocument();
    expect(within(strip).queryByText(/dazu|davon/)).toBeNull();
  });

  // ---- F6 (C10): a match posts nothing: secondary, with the match's own sentence ---------------------
  it('F6: "Abgleichen" is a secondary commit whose tooltip says a match posts nothing', async () => {
    const MATCH = line('bt_match', {
      amountMinor: -4_500,
      counterparty: { name: 'Abgleich Test AG', iban: null },
      proposal: { target: { kind: 'existing_entry', entryId: 'je_9' }, certainty: 'sure', reasonCode: 'existing_entry_reference', reasonParams: { entryId: 'je_9', entryDate: '2026-09-22', description: 'Bank' }, vatCode: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([MATCH]), ...noVorschlag, get_entry: ok({ entry: { id: 'je_9', date: '2026-09-22', description: 'Bank' }, lines: [] }) })));
    const button = await within(await findRow(/Abgleich Test AG/)).findByRole('button', { name: 'Abgleichen' });
    expect(button.className).toContain('btn--secondary');
    expect(button.className).not.toContain('btn--accent');
    expect(button).not.toHaveAttribute('data-money-commit');
    const tip = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(tip).toHaveTextContent('Abgleichen verbindet die Zeile mit dieser Buchung. Die Buchung bleibt unverändert und zählt nur einmal.');
    expect(tip?.textContent ?? '').not.toContain(consequenceSentence('book_bank_line', 'de-CH') as string);
  });

  // ---- F7 (C8): a line is told apart by its IBAN and reference ---------------------------------------
  it('F7: a credit with no name shows its IBAN in the row', async () => {
    const ANON = line('bt_anon', { amountMinor: 12_345, creditDebit: 'CRDT', counterparty: { name: null, iban: 'CH9300762011623852957' } });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ANON]), ...noVorschlag })));
    const row = await findRow(/CH93 0076 2011 6238 5295 7/);
    expect(within(row).getByText('CH93 0076 2011 6238 5295 7')).toBeInTheDocument();
  });

  it('F7: the strip names the reference and the IBAN the row does not show, cut, with the whole in a tooltip', async () => {
    const QR = line('bt_qr', {
      amountMinor: 50_000,
      creditDebit: 'CRDT',
      counterparty: { name: 'Kundin Beispiel', iban: 'CH4431999123000889012' },
      remittance: { text: 'Rechnung 77', referenceKind: 'QRR', referenceValue: '210000000003139471430009017', endToEndId: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([QR]), ...noVorschlag })));
    await clickRow(await findRow(/Kundin Beispiel/));
    const strip = stripOf('bt_qr') as HTMLElement;
    const ref = within(strip).getByText('Ref. 21 00000 00003 13947 14300 09017');
    expect(document.getElementById(ref.getAttribute('aria-describedby') ?? '')).toHaveTextContent('21 00000 00003 13947 14300 09017');
    expect(within(strip).getByText('IBAN CH44 3199 9123 0008 8901 2')).toBeInTheDocument();
  });

  it('F7: what the row already shows is not repeated in the strip', async () => {
    const SHOWN = line('bt_shown', {
      amountMinor: -1_500,
      counterparty: { name: null, iban: 'CH9300762011623852957' },
      remittance: { text: null, referenceKind: 'SCOR', referenceValue: 'RF18539007547034', endToEndId: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([SHOWN]), ...noVorschlag })));
    await clickRow(await findRow(/CH93 0076/));
    const strip = stripOf('bt_shown') as HTMLElement;
    // The IBAN leads the row and the reference is its detail: neither is said twice.
    expect(within(strip).queryByText(/^IBAN /)).toBeNull();
    expect(within(strip).queryByText(/^Ref\. /)).toBeNull();
  });

  // ---- F8: a payment run names its bills ----------------------------------------------------------
  it('F8: a line paying a run names its bills compactly, every bill with its amount in the tooltip, and keeps "total differs"', async () => {
    const RUN = line('bt_run', {
      amountMinor: -90_000,
      counterparty: { name: 'Sammelauftrag', iban: null },
      proposal: { target: { kind: 'payment_batch', batchId: 'pb_1' }, certainty: 'sure', reasonCode: 'payment_batch_reference', reasonParams: { batchId: 'pb_1', batchTotalMinor: 90_500 }, vatCode: null },
    });
    const batch = {
      executionDate: '2026-09-22',
      status: 'submitted',
      ctrlSumMinor: 90_500,
      items: [
        { vendorName: 'Muster AG', amountMinor: 40_000, currency: 'CHF' },
        { vendorName: 'Atelier Sonne', amountMinor: 30_000, currency: 'CHF' },
        { vendorName: 'Druckerei Talweg', amountMinor: 20_500, currency: 'CHF' },
      ],
    };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([RUN]), ...noVorschlag, get_payment_batch: ok({ batch }) })));
    await clickRow(await findRow(/Sammelauftrag/));
    const strip = stripOf('bt_run') as HTMLElement;
    const bills = await within(strip).findByText('3 Rechnungen: Muster AG, Atelier Sonne, +1');
    expect(document.getElementById(bills.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Muster AG CHF 400.00, Atelier Sonne CHF 300.00, Druckerei Talweg CHF 205.00');
    expect(within(strip).getByText(/Der Zahlungslauf lautet auf CHF 905\.00, die Bank auf CHF 900\.00/)).toBeInTheDocument();
  });

  // ---- F9a (C6): every dropped file is attached ---------------------------------------------------------
  it('F9a: two files dropped on a row are both uploaded and linked to it, and the ack counts them', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([line('bt_drop', { amountMinor: -500, counterparty: { name: 'Belegtest GmbH', iban: null } })]), ...noVorschlag, files_upload: ok({ file: { id: 'file_1' } }), files_link: ok({ file: { id: 'file_1' }, retentionDerived: false }) }));
    renderBank(transport);
    const row = await findRow(/Belegtest GmbH/);
    const files = [new File(['a'], 'quittung-1.pdf', { type: 'application/pdf' }), new File(['b'], 'quittung-2.pdf', { type: 'application/pdf' })];
    fireEvent.dragEnter(row, { dataTransfer: { files, types: ['Files'] } });
    fireEvent.drop(row, { dataTransfer: { files, types: ['Files'] } });
    expect(await screen.findByText('2 Belege an Belegtest GmbH angehängt.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'files_upload').map((c) => c.input.filename)).toEqual(['quittung-1.pdf', 'quittung-2.pdf']);
    expect(calls.filter((c) => c.action === 'files_link').every((c) => c.input.entityKind === 'bank_txn' && c.input.entityId === 'bt_drop')).toBe(true);
  });

  it('F9a: a dropped file that is refused is named, while the others land', async () => {
    let n = 0;
    const upload: Handler = () => {
      n += 1;
      return n === 2 ? refuse('file_too_large') : ok({ file: { id: `file_${String(n)}` } });
    };
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([line('bt_drop', { amountMinor: -500, counterparty: { name: 'Belegtest GmbH', iban: null } })]), ...noVorschlag, files_upload: upload, files_link: ok({ file: { id: 'file_1' }, retentionDerived: false }) })));
    const row = await findRow(/Belegtest GmbH/);
    const files = [new File(['a'], 'gut.pdf', { type: 'application/pdf' }), new File(['b'], 'riesig.pdf', { type: 'application/pdf' })];
    fireEvent.drop(row, { dataTransfer: { files, types: ['Files'] } });
    expect(await screen.findByText('Beleg angehängt: gut.pdf an Belegtest GmbH.')).toBeInTheDocument();
    expect(screen.getByText(/riesig\.pdf nicht angehängt/)).toBeInTheDocument();
  });

  it('attach keys are per intent: a retry after a lost answer reuses both keys and files the Beleg ONCE; once attached, the same file again is a new intent', async () => {
    // The "server" files every upload it receives and replays by idempotency key, as the engine does.
    const stored = new Map<string, string>();
    let uploads = 0;
    const upload: Handler = (input) => {
      uploads += 1;
      const key = String(input.idempotencyKey);
      if (!stored.has(key)) stored.set(key, `file_${String(stored.size + 1)}`);
      if (uploads === 1) return { status: 0, body: { ok: false, error: 'transport_error', detail: 'TypeError: Failed to fetch' } };
      return ok({ file: { id: stored.get(key) as string } });
    };
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([line('bt_retry', { amountMinor: -500, counterparty: { name: 'Wiederholung AG', iban: null } })]), ...noVorschlag, files_upload: upload, files_link: ok({ file: { id: 'file_1' }, retentionDerived: false }) }));
    renderBank(transport);
    const row = await findRow(/Wiederholung AG/);
    const file = new File(['beleg'], 'quittung.pdf', { type: 'application/pdf', lastModified: 1_758_000_000_000 });
    fireEvent.drop(row, { dataTransfer: { files: [file], types: ['Files'] } });
    await waitFor(() => expect(calls.filter((c) => c.action === 'files_upload')).toHaveLength(1));
    await screen.findByText(/quittung\.pdf nicht angehängt/);
    // The retry: the same file on the same line.
    fireEvent.drop(row, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(await screen.findByText('Beleg angehängt: quittung.pdf an Wiederholung AG.')).toBeInTheDocument();
    const [first, second] = calls.filter((c) => c.action === 'files_upload');
    expect(second?.input.idempotencyKey).toBe(first?.input.idempotencyKey);
    expect(stored.size).toBe(1);
    // Attached: the same file again is a new intent, with new keys.
    fireEvent.drop(row, { dataTransfer: { files: [file], types: ['Files'] } });
    await waitFor(() => expect(calls.filter((c) => c.action === 'files_link')).toHaveLength(2));
    const links = calls.filter((c) => c.action === 'files_link');
    expect(links[1]?.input.idempotencyKey).not.toBe(links[0]?.input.idempotencyKey);
    expect(stored.size).toBe(2);
  });

  // ---- F9b (C7): a file picked after its line left the list is attached by id, or the refusal is said ----
  it('F9b: "Beleg anhängen", then a tab switch before the file is chosen: the file is linked to that line by its id', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([line('bt_pick', { amountMinor: -500, counterparty: { name: 'Picker GmbH', iban: null } })]), ...noVorschlag, files_upload: ok({ file: { id: 'file_1' } }), files_link: ok({ file: { id: 'file_1' }, retentionDerived: false }) }));
    renderBank(transport);
    await clickRow(await findRow(/Picker GmbH/));
    await userEvent.click(within(stripOf('bt_pick') as HTMLElement).getByRole('button', { name: 'Beleg anhängen' }));
    await userEvent.click(screen.getByRole('tab', { name: /Ignoriert/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /Picker GmbH/ })).toBeNull());
    const input = document.querySelector('input[type="file"][aria-label="Beleg anhängen"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'spaet.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(calls.some((c) => c.action === 'files_link' && c.input.entityId === 'bt_pick')).toBe(true));
    expect(await screen.findByText('Beleg angehängt: spaet.pdf an Picker GmbH.')).toBeInTheDocument();
  });

  it('F9b: when that line no longer exists, a banner names the file and the reason', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([line('bt_pick', { amountMinor: -500, counterparty: { name: 'Picker GmbH', iban: null } })]), ...noVorschlag, files_upload: ok({ file: { id: 'file_1' } }), files_link: refuse('entity_not_found') })));
    await clickRow(await findRow(/Picker GmbH/));
    await userEvent.click(within(stripOf('bt_pick') as HTMLElement).getByRole('button', { name: 'Beleg anhängen' }));
    await userEvent.click(screen.getByRole('tab', { name: /Ignoriert/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /Picker GmbH/ })).toBeNull());
    const input = document.querySelector('input[type="file"][aria-label="Beleg anhängen"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'spaet.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText('spaet.pdf nicht angehängt: Diese Bankzeile gibt es nicht mehr.')).toBeInTheDocument();
  });

  // ---- F9c (C3): a write's late answer never overrides the person's newer selection ---------------------
  it('F9c: selecting another line while the selected line books keeps the person\'s new selection AND their focus', async () => {
    let release: (() => void) | null = null;
    const lines = ['bt_1', 'bt_2', 'bt_3'].map((id, i) => learned(id, `Partei ${String(i + 1)} AG`, (i + 1) * 1_000, `2026-09-2${String(5 - i)}`));
    const inner = fakeTransport(happy({ list_bank_inbox: inboxFor(lines), ...noVorschlag }));
    const transport: Transport = async (action, input) => {
      if (action === 'book_bank_line') {
        await new Promise<void>((r) => {
          release = r;
        });
        return ok({ state: 'booked', entryId: 'je_x', remainder: null });
      }
      return inner(action, input);
    };
    renderBank(transport);
    const one = await findRow(/Partei 1 AG/);
    await clickRow(one);
    await userEvent.click(within(one).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(release).not.toBeNull());
    await clickRow(rowOf(/Partei 3 AG/));
    expect(rowOf(/Partei 3 AG/)).toHaveAttribute('aria-current', 'true');
    act(() => (release as unknown as () => void)());
    await screen.findByText(/Gebucht: Partei 1 AG/);
    // Critic round 2: the focus stays where the person put it, on Partei 3, never pulled to "the next row".
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(rowOf(/Partei 3 AG/));
    expect(selectedRows().map((r) => r.dataset.line)).toEqual(['bt_3']);
  });

  // ---- F9d: the attach gate bites on BOTH halves (manage_files AND the line's edit right, pay) --------
  it('F9d: with the filing right but without `pay` (a bank line\'s edit right) there is no drop, no paperclip, no menu item', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ALPINA]), ...noVorschlag })), '/bank', { held: [CAP.readSales, CAP.post, CAP.manageFiles] });
    const row = await findRow(/Alpina Telecom AG/);
    fireEvent.dragEnter(row, { dataTransfer: { files: [], types: ['Files'] } });
    expect(row).not.toHaveAttribute('data-drop');
    await clickRow(row);
    expect(within(stripOf('bt_alpina') as HTMLElement).queryByRole('button', { name: 'Beleg anhängen' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /Weitere Aktionen für Alpina Telecom AG/ }));
    expect(screen.queryByRole('menuitem', { name: 'Beleg anhängen' })).toBeNull();
  });

  it('F9d: with both halves of the gate the drop target and the paperclip are there', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ALPINA]), ...noVorschlag })), '/bank', { held: [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles] });
    const row = await findRow(/Alpina Telecom AG/);
    fireEvent.dragEnter(row, { dataTransfer: { files: [], types: ['Files'] } });
    expect(row).toHaveAttribute('data-drop', 'true');
    await clickRow(row);
    expect(within(stripOf('bt_alpina') as HTMLElement).getByRole('button', { name: 'Beleg anhängen' })).toBeInTheDocument();
  });

  // ---- F9e: a file let go OFF a row never sends the browser away from the Studio ------------------------
  it('F9e: a file dragged over or dropped on the surface off a row is held: the browser does not open it, nothing is attached', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([ALPINA]), ...noVorschlag, files_upload: ok({ file: { id: 'file_1' } }) }));
    renderBank(transport);
    await findRow(/Alpina Telecom AG/);
    const toolbar = document.querySelector('.bank-toolbar') as HTMLElement;
    const dataTransfer = { files: [new File(['x'], 'daneben.pdf', { type: 'application/pdf' })], types: ['Files'], dropEffect: 'copy' };
    // fireEvent answers false when the event's default was prevented.
    expect(fireEvent.dragOver(toolbar, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(toolbar, { dataTransfer })).toBe(false);
    expect(calls.some((c) => c.action === 'files_upload')).toBe(false);
  });

  it('F9e: a file let go on the shell or rail, outside the Bank surface, is held too, and the guard goes with /bank', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([ALPINA]), ...noVorschlag, files_upload: ok({ file: { id: 'file_1' } }) }));
    const { unmount } = renderBank(transport);
    await findRow(/Alpina Telecom AG/);
    // A stand-in for the shell's rail: outside the surface's section, under the same document.
    const rail = document.createElement('nav');
    document.body.appendChild(rail);
    const dataTransfer = { files: [new File(['x'], 'daneben.pdf', { type: 'application/pdf' })], types: ['Files'], dropEffect: 'copy' };
    expect(fireEvent.dragOver(rail, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(rail, { dataTransfer })).toBe(false);
    expect(calls.some((c) => c.action === 'files_upload')).toBe(false);
    // A drag that is not files is none of the guard's business.
    expect(fireEvent.dragOver(rail, { dataTransfer: { files: [], types: ['text/plain'] } })).toBe(true);
    unmount();
    expect(fireEvent.drop(rail, { dataTransfer })).toBe(true);
    rail.remove();
  });

  // ---- F9f: with several Bankkonten in view, each row names its own ------------------------------------
  it('F9f: in the multi-account view each row names its Bankkonto; filtered to one account, it does not', async () => {
    const SECOND = { id: 'ba_2', name: 'Sparkonto Seefeld', iban: 'CH4431999123000889012', currency: 'CHF', ledgerAccountId: account('1000'), archived: false };
    const other = line('bt_other', { bankAccountId: 'ba_2', amountMinor: 2_500, creditDebit: 'CRDT', counterparty: { name: 'Zinsgutschrift', iban: null } });
    const canned = happy({ list_bank_accounts: ok({ bankAccounts: [ACCOUNT, SECOND] }), list_bank_inbox: inboxFor([ALPINA, other]), ...noVorschlag });
    const { unmount } = renderBank(fakeTransport(canned));
    expect(within(await findRow(/Zinsgutschrift/)).getByText('Sparkonto Seefeld')).toBeInTheDocument();
    expect(within(rowOf(/Alpina Telecom AG/)).getByText('Zürichsee Geschäftskonto')).toBeInTheDocument();
    // The counterparty wins the width: the tag comes AFTER the name and its detail, the first thing cut.
    const cell = rowOf(/Alpina Telecom AG/).querySelector('.bank-party-line') as HTMLElement;
    expect(Array.from(cell.children).map((c) => c.className)).toEqual(['bank-party', 'bank-detail', 'bank-account-tag']);
    unmount();
    renderBank(fakeTransport(canned), '/bank?account=ba_1');
    const row = await findRow(/Alpina Telecom AG/);
    expect(row.querySelector('.bank-account-tag')).toBeNull();
  });

  // ---- The MWST cell shows the code, as the composer's trigger does -------------------------------------
  it('the MWST cell shows the code; its full label is in the picker\'s name and a real tooltip; "Ohne MWST" keeps its words', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag })));
    const row = await findRow(/Druckerei Talweg/);
    const picker = await within(row).findByRole('button', { name: 'MWST, Druckerei Talweg, VST-M Vorsteuer Material, Waren, Dienstleistungen' });
    expect(picker.querySelector('.picker-trigger__code')).toHaveTextContent('VST-M');
    const tip = picker.closest('.tooltip-wrap')?.querySelector('[role="tooltip"]');
    expect(tip).toHaveTextContent('VST-M Vorsteuer Material, Waren, Dienstleistungen');
    // Choosing no code: the cell says "Ohne MWST" in words, under the plain name.
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole('option', { name: /Ohne MWST/ }));
    const none = await within(row).findByRole('button', { name: 'MWST, Druckerei Talweg' });
    expect(none).toHaveTextContent('Ohne MWST');
    expect(none.querySelector('.picker-trigger__code')).toBeNull();
  });

  // ---- R2-2: a leg that carries a code never books it invisibly -------------------------------------------
  const ODD = line('bt_odd', {
    amountMinor: -1_000,
    counterparty: { name: 'Steuerkonto Test AG', iban: null },
    proposal: { target: { kind: 'accounts', legs: [{ accountId: account('1170'), amountMinor: 1_000, taxCode: 'VST-M' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('1170'), taxCode: 'VST-M', lastDate: '2026-08-01', count: 1 }, vatCode: 'VST-M' },
  });

  it('R2-2: a leg on a VAT account that carries a code shows it in the row, and "Ohne MWST" clears it before Buchen', async () => {
    const book = vi.fn<Handler>(() => ok({ state: 'booked', entryId: 'je_odd', remainder: null }));
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ODD]), book_bank_line: book, ...noVorschlag })));
    const row = await findRow(/Steuerkonto Test AG/);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Buchen auf, Steuerkonto/ })).toHaveTextContent('1170'));
    const picker = within(row).getByRole('button', { name: /^MWST, Steuerkonto Test AG, VST-M/ });
    expect(picker).toHaveTextContent('VST-M');
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole('option', { name: /Ohne MWST/ }));
    // Cleared on a VAT account: nothing is left to show, and nothing hidden is sent.
    await waitFor(() => expect(within(row).queryByRole('button', { name: /^MWST/ })).toBeNull());
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    const sent = (book.mock.calls[0]?.[0].target as { legs: { taxCode: string }[] }).legs[0]?.taxCode;
    expect(sent ?? '').toBe(''); // an empty code is left out of the payload
  });

  it('R2-2: the split editor shows a carried code on a VAT account too', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([ODD]), ...noVorschlag })));
    const row = await findRow(/Steuerkonto Test AG/);
    await clickRow(row);
    await userEvent.click(within(stripOf('bt_odd') as HTMLElement).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(within(editor).getByRole('button', { name: /^MWST der Position 1/ })).toHaveTextContent('VST-M');
  });
});

// ======================================================================================================
// D152 (owner, 02.10.2026): with two or more Bankkonten in view, ONE summary trust line, every account in
// its (i) card; one account in view keeps its own line.
// ======================================================================================================
describe('the balance line with several accounts in view (D152)', () => {
  const noVorschlag = { list_drafted_actions: ok({ actions: [] }) };
  const HAUPT = { id: 'ba_2', name: 'Hauptkonto CHF', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: account('1060'), archived: false };
  const EUR = { id: 'ba_3', name: 'Fremdwährungskonto EUR', iban: 'CH5800791123000889012', currency: 'EUR', ledgerAccountId: account('1000'), archived: false };
  // Zürichsee: an entry of -42.00 no line backs. Hauptkonto: 10.00 off, no open lines. EUR: no statement yet.
  const ZUERICH_OFF = { ...SUMMARY, ledgerBalanceMinor: 1_086_870 - 4_200, differenceMinor: 4_200 };
  const HAUPT_OFF = { ...SUMMARY, bankAccountId: 'ba_2', name: 'Hauptkonto CHF', iban: HAUPT.iban, ledgerAccountId: HAUPT.ledgerAccountId, statementId: 'st_2', statementDate: '2026-09-20', bankBalanceMinor: 501_000, ledgerBalanceMinor: 500_000, openCount: 0, openSumMinor: 0, differenceMinor: 1_000 };
  const HAUPT_OK = { ...HAUPT_OFF, ledgerBalanceMinor: 501_000, differenceMinor: 0 };
  const EUR_NONE = { ...SUMMARY, bankAccountId: 'ba_3', name: 'Fremdwährungskonto EUR', iban: EUR.iban, currency: 'EUR', ledgerAccountId: EUR.ledgerAccountId, judgeable: false, reason: 'no_statement', statementId: null, statementDate: null, bankBalanceMinor: null, ledgerBalanceMinor: null, openCount: 0, openSumMinor: 0, differenceMinor: null };
  const three = (summary: unknown[]) => happy({ list_bank_accounts: ok({ bankAccounts: [ACCOUNT, HAUPT, EUR] }), list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], summary), ...noVorschlag });
  const openSummaryCard = async () => {
    const trust = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    const info = within(trust).getByRole('button', { name: 'Abgleich aller Bankkonten: je Konto' });
    await userEvent.hover(info);
    const card = document.getElementById(info.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(card).toBeVisible();
    return { trust, card };
  };

  it('three accounts: ONE line with the counts, and its card lists all three with their figures', async () => {
    renderBank(fakeTransport(three([ZUERICH_OFF, HAUPT_OFF, EUR_NONE])));
    const trust = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    expect(within(trust).getByText('2 Konten mit Differenz · 1 ohne Kontoauszug')).toBeVisible();
    expect(trust).toHaveAttribute('data-tone', 'difference');
    // No line per account any more.
    expect(screen.queryByRole('region', { name: /Abgleich Zürichsee Geschäftskonto/ })).toBeNull();
    expect(document.querySelectorAll('section.bank-trust')).toHaveLength(1);
    const { card } = await openSummaryCard();
    const rows = within(card).getAllByRole('listitem');
    // Each row says the account and its figure; its own words wait behind it, closed.
    expect(rows.map((r) => r.querySelector('.bank-trust-sum__fact')?.textContent)).toEqual([
      'Zürichsee GeschäftskontoDifferenz CHF 42.00',
      'Hauptkonto CHFDifferenz CHF 10.00',
      'Fremdwährungskonto EURNoch kein Kontoauszug',
    ]);
    for (const row of rows) expect(row.querySelector('.bank-trust-sum__details')).not.toBeVisible();
  });

  it('the counts take real plurals: one account with a difference', async () => {
    renderBank(fakeTransport(three([ZUERICH_OFF, HAUPT_OK, EUR_NONE])));
    const trust = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    expect(within(trust).getByText('1 Konto mit Differenz · 1 ohne Kontoauszug')).toBeVisible();
  });

  it('every account balanced: the calm success form', async () => {
    renderBank(fakeTransport(happy({ list_bank_accounts: ok({ bankAccounts: [ACCOUNT, HAUPT] }), list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], [SUMMARY, HAUPT_OK]), ...noVorschlag })));
    const trust = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    expect(within(trust).getByText('Alle Konten abgestimmt')).toBeVisible();
    expect(trust).toHaveAttribute('data-tone', 'ok');
    expect(trust.querySelector('.bank-trust__glyph--ok')).not.toBeNull();
  });

  it('one account in view (the account filter, or a book with one account) keeps its own line, unchanged', async () => {
    const { unmount } = renderBank(fakeTransport(three([ZUERICH_OFF, HAUPT_OFF, EUR_NONE])), '/bank?account=ba_1');
    const own = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    expect(within(own).getByText('Differenz CHF 42.00')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Abgleich aller Bankkonten' })).toBeNull();
    unmount();
    renderBank(fakeTransport(happy()));
    expect(await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Abgleich aller Bankkonten' })).toBeNull();
  });

  it('every per-account fact stays reachable from the card: the equation, the why, the date, the open lines', async () => {
    renderBank(fakeTransport(three([ZUERICH_OFF, HAUPT_OFF, EUR_NONE])));
    const { card } = await openSummaryCard();
    // Each row is a disclosure, closed at first: the card is a list of short facts.
    const zuerich = within(card).getByRole('button', { name: 'Zürichsee Geschäftskonto: Differenz CHF 42.00. Zahlen und Erklärung' });
    expect(zuerich).toHaveAttribute('aria-expanded', 'false');
    const details = document.getElementById(zuerich.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(details).not.toBeVisible();
    await userEvent.click(zuerich);
    expect(zuerich).toHaveAttribute('aria-expanded', 'true');
    expect(details).toBeVisible();
    const text = details.textContent ?? '';
    expect(text).toContain('Bank und Buchhaltung weichen um CHF 42.00 ab.');
    expect(text).toMatch(/10.782\.72/);
    expect(text).toContain('eine Buchung auf dem Bankkonto keine Bankzeile hat');
    expect(text).toContain('Stand Kontoauszug 24.09.2026');
    // The account that cannot be judged says why, in full.
    const eur = within(card).getByRole('button', { name: /^Fremdwährungskonto EUR: Noch kein Kontoauszug/ });
    await userEvent.click(eur);
    expect(document.getElementById(eur.getAttribute('aria-controls') ?? '')).toHaveTextContent('Kann nicht beurteilt werden: noch kein Kontoauszug.');
    // The open lines still lead into the list, narrowed to that account.
    await userEvent.click(within(details).getByRole('button', { name: /3 Zeilen offen/ }));
    expect(await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Abgleich aller Bankkonten' })).toBeNull();
  });

  it.each(['light', 'dark'] as const)('has no axe violations with the summary card open and one account opened, in the %s theme', async (theme) => {
    const { container } = renderBank(fakeTransport(three([ZUERICH_OFF, HAUPT_OFF, EUR_NONE])), '/bank', { theme });
    await findRow(/Alpina Telecom AG/);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    const { card } = await openSummaryCard();
    await userEvent.click(within(card).getByRole('button', { name: /^Zürichsee Geschäftskonto: Differenz/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('a missing statement in the balance line\'s card (A36 §4.7 on /bank, D152 words on demand)', () => {
  // Every number, date and id is invented: statement 2 of 2026 is missing between 1 and 3.
  const gapOf = (bankAccountId: string, gapId: string, over: Record<string, unknown> = {}) => ({
    gapId,
    bankAccountId,
    source: 'book',
    after: { statementRowId: `${gapId}_after`, documentId: null, number: 1, year: 2026, fromDate: '2026-09-20', toDate: '2026-09-20' },
    before: { statementRowId: `${gapId}_before`, documentId: null, number: 3, year: 2026, fromDate: '2026-09-23', toDate: '2026-09-23' },
    missing: [{ year: 2026, from: 2, to: 2 }],
    oldYearTailUnknown: false,
    missingDates: { from: '2026-09-21', to: '2026-09-22' },
    chains: true,
    differenceMinor: 0,
    currency: 'CHF',
    confirmable: true,
    refused: [],
    ...over,
  });
  const GAP = gapOf('ba_1', 'gap_zuerich');
  const TITLE = 'Auszug 2 fehlt (21.09.2026 bis 22.09.2026)';
  /** The `bank_inbox` tile, as the Übersicht band and the repair dialog read it. */
  const tileWith = (gaps: unknown[]): RestResponse => ok({ tile: { tile: 'bank_inbox', ok: true, statementGaps: gaps } });
  const noVorschlag = { list_drafted_actions: ok({ actions: [] }) };
  const HAUPT = { id: 'ba_2', name: 'Hauptkonto CHF', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: account('1060'), archived: false };
  const HAUPT_OK = { ...SUMMARY, bankAccountId: 'ba_2', name: 'Hauptkonto CHF', iban: HAUPT.iban, ledgerAccountId: HAUPT.ledgerAccountId, statementId: 'st_2', statementDate: '2026-09-20', bankBalanceMinor: 501_000, ledgerBalanceMinor: 501_000, openCount: 0, openSumMinor: 0, differenceMinor: 0 };
  const two = (gaps: unknown[]) => happy({ list_bank_accounts: ok({ bankAccounts: [ACCOUNT, HAUPT] }), list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], [SUMMARY, HAUPT_OK]), dashboard_tile: tileWith(gaps), ...noVorschlag });

  /** Where the repair link lands: the path and the query, as the router reads them. */
  function Landed() {
    const at = useLocation();
    return <p data-testid="landed">{`${at.pathname}${at.search}`}</p>;
  }
  function renderRouted(transport: Transport, path = '/bank', theme?: Theme) {
    const tree = (
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/bank" element={<Bank />} />
                <Route path="/bank-accounts" element={<Landed />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    );
    return render(theme === undefined ? tree : <ThemeProvider initialTheme={theme}>{tree}</ThemeProvider>);
  }
  /** The line's own words: what the resting surface says, the card excluded. */
  const headlineOf = (region: HTMLElement) => region.querySelector('.bank-trust__headline')?.textContent ?? null;
  async function openCard(region: HTMLElement) {
    const info = within(region).getAllByRole('button', { name: /Zahlen und Erklärung|je Konto/ })[0] as HTMLElement;
    await userEvent.hover(info);
    const card = document.getElementById(info.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(card).toBeVisible();
    return card;
  }

  /** The status glyphs of a line or a summary row (the caret of a disclosure is not one). */
  const statusGlyphs = (el: Element) => Array.from(el.querySelectorAll('.bank-trust__glyph'));

  it('one account: the card names the gap in A36\'s words and links to its repair; the line\'s ONE glyph turns warn, its words unchanged', async () => {
    const { transport, calls } = recording(happy({ dashboard_tile: tileWith([GAP]) }));
    renderRouted(transport);
    const trust = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    // The read is the Übersicht band's: the `bank_inbox` tile, no new verb.
    await waitFor(() => expect(within(trust).getByRole('img', { name: 'Ein Kontoauszug fehlt' })).toBeInTheDocument());
    expect(calls.filter((c) => c.action === 'dashboard_tile').every((c) => c.input.tile === 'bank_inbox')).toBe(true);
    // ONE status glyph: the warn glyph replaces the check, named for the gap alone, so no fact is heard twice (D152).
    const glyphs = statusGlyphs(trust.querySelector('.bank-trust__headline') as Element);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toHaveClass('bank-trust__glyph--warn');
    expect(glyphs[0]).toHaveAccessibleName('Ein Kontoauszug fehlt');
    expect(trust.querySelector('.bank-trust__glyph--ok')).toBeNull();
    expect(headlineOf(trust)).toBe('Keine Differenz');
    const card = await openCard(trust);
    expect(within(card).getByText(TITLE)).toBeVisible();
    const repair = within(card).getByRole('link', { name: 'Lücke schliessen' });
    expect(repair).toHaveAttribute('href', '/bank-accounts?repair=ba_1&gap=gap_zuerich');
    expect(repair).toHaveAccessibleDescription(TITLE);
    await userEvent.click(repair);
    expect(await screen.findByTestId('landed')).toHaveTextContent('/bank-accounts?repair=ba_1&gap=gap_zuerich');
  });

  it('one account with a difference: the gap is in the card, and the line keeps its ONE warn glyph', async () => {
    const differs = { ...SUMMARY, ledgerBalanceMinor: 1_086_870 - 4_200, differenceMinor: 4_200 };
    const unchained = gapOf('ba_1', 'gap_money', { chains: false, differenceMinor: 4_200, confirmable: false });
    renderRouted(fakeTransport(happy({ list_bank_inbox: inboxFor([KAFI, ALPINA, CAFE], [differs]), dashboard_tile: tileWith([unchained]) })));
    const trust = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    await waitFor(() => expect(within(trust).getByText('Differenz CHF 42.00')).toBeVisible());
    const card = await openCard(trust);
    await waitFor(() => expect(within(card).getByText(TITLE)).toBeVisible());
    expect(within(card).getByRole('link', { name: 'Lücke schliessen' })).toHaveAttribute('href', '/bank-accounts?repair=ba_1&gap=gap_money');
    // The difference keeps its one warn glyph exactly as before: decorative, the words carry it.
    const glyphs = statusGlyphs(trust.querySelector('.bank-trust__headline') as Element);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toHaveClass('bank-trust__glyph--warn');
    expect(glyphs[0]).toHaveAttribute('aria-hidden', 'true');
    expect(within(trust).queryByRole('img')).toBeNull();
    expect(headlineOf(trust)).toBe('Differenz CHF 42.00');
  });

  it('several accounts: the summary line\'s words are unchanged, and the gap sits in that account\'s disclosure with its repair', async () => {
    const HAUPT_GAP = gapOf('ba_2', 'gap_haupt', { after: { ...GAP.after, number: 7 }, before: { ...GAP.before, number: 9 }, missing: [{ year: 2026, from: 8, to: 8 }] });
    renderRouted(fakeTransport(two([HAUPT_GAP])));
    const trust = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    await waitFor(() => expect(within(trust).getByRole('img', { name: 'Ein Kontoauszug fehlt' })).toBeInTheDocument());
    // The summary's ONE glyph turns warn; its words do not change.
    expect(headlineOf(trust)).toBe('Alle Konten abgestimmt');
    const glyphs = statusGlyphs(trust.querySelector('.bank-trust__headline') as Element);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toHaveClass('bank-trust__glyph--warn');
    expect(trust.querySelector('.bank-trust__headline .bank-trust__glyph--ok')).toBeNull();
    const card = await openCard(trust);
    const haupt = within(card).getByRole('button', { name: /^Hauptkonto CHF: Keine Differenz/ });
    const details = document.getElementById(haupt.getAttribute('aria-controls') ?? '') as HTMLElement;
    // Closed until asked: the list never opens itself.
    expect(details).not.toBeVisible();
    // The row carries the mark; the account without a gap does not.
    expect(statusGlyphs(haupt)).toHaveLength(1);
    expect(statusGlyphs(haupt)[0]).toHaveClass('bank-trust__glyph--warn');
    expect(statusGlyphs(haupt)[0]).toHaveAccessibleName('Ein Kontoauszug fehlt');
    const zuerich = within(card).getByRole('button', { name: /^Zürichsee Geschäftskonto: Keine Differenz/ });
    expect(zuerich.querySelector('[role="img"]')).toBeNull();
    expect(statusGlyphs(zuerich)).toHaveLength(1);
    expect(statusGlyphs(zuerich)[0]).toHaveClass('bank-trust__glyph--ok');
    await userEvent.click(haupt);
    expect(within(details).getByText('Auszug 8 fehlt (21.09.2026 bis 22.09.2026)')).toBeVisible();
    const repair = within(details).getByRole('link', { name: 'Lücke schliessen' });
    expect(repair).toHaveAttribute('href', '/bank-accounts?repair=ba_2&gap=gap_haupt');
    await userEvent.click(zuerich);
    const zuerichDetails = document.getElementById(zuerich.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(zuerichDetails).toBeVisible();
    expect(zuerichDetails.textContent ?? '').not.toContain('fehlt');
    expect(within(zuerichDetails).queryByRole('link')).toBeNull();
    await userEvent.click(repair);
    expect(await screen.findByTestId('landed')).toHaveTextContent('/bank-accounts?repair=ba_2&gap=gap_haupt');
  });

  it('an account without a gap shows nothing extra, in both shapes, and neither does a gap elsewhere or a refused read', async () => {
    const { unmount } = renderRouted(fakeTransport(happy({ dashboard_tile: tileWith([]) })));
    const one = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    let card = await openCard(one);
    expect(card.textContent ?? '').not.toContain('fehlt');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(one.querySelector('[role="img"]')).toBeNull();
    expect(one.querySelector('.bank-trust__headline .bank-trust__glyph--ok')).not.toBeNull();
    unmount();
    // A gap of an account not in view says nothing here.
    const { unmount: unmountTwo } = renderRouted(fakeTransport(happy({ dashboard_tile: tileWith([gapOf('ba_9', 'gap_elsewhere')]) })));
    const other = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    card = await openCard(other);
    expect(card.textContent ?? '').not.toContain('fehlt');
    expect(other.querySelector('[role="img"]')).toBeNull();
    unmountTwo();
    const { unmount: unmountThree } = renderRouted(fakeTransport(two([])));
    const sum = await screen.findByRole('region', { name: 'Abgleich aller Bankkonten' });
    card = await openCard(sum);
    expect(sum.querySelector('[role="img"]')).toBeNull();
    expect(sum.querySelector('.bank-trust__headline .bank-trust__glyph--ok')).not.toBeNull();
    for (const row of within(card).getAllByRole('button', { name: /Zahlen und Erklärung/ })) await userEvent.click(row);
    expect(card.textContent ?? '').not.toContain('fehlt');
    expect(within(card).queryByRole('link')).toBeNull();
    unmountThree();
    renderRouted(fakeTransport(happy({ dashboard_tile: refuse('permission_denied') })));
    const refused = await screen.findByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    card = await openCard(refused);
    expect(card.textContent ?? '').not.toContain('fehlt');
    expect(headlineOf(refused)).toBe('Keine Differenz');
  });

  it('the resting surface says no more words with a gap than without one', async () => {
    const wordsAbove = async (gaps: unknown[], canned: (g: unknown[]) => Canned, name: string) => {
      const { unmount } = renderRouted(fakeTransport(canned(gaps)));
      const region = await screen.findByRole('region', { name });
      await findRow(/Alpina Telecom AG/);
      if (gaps.length > 0) await waitFor(() => expect(region.querySelector('.bank-trust__headline [role="img"]')).not.toBeNull());
      const words = headlineOf(region);
      unmount();
      return words;
    };
    const oneShape = (g: unknown[]) => happy({ dashboard_tile: tileWith(g) });
    expect(await wordsAbove([GAP], oneShape, 'Abgleich Zürichsee Geschäftskonto')).toBe(await wordsAbove([], oneShape, 'Abgleich Zürichsee Geschäftskonto'));
    expect(await wordsAbove([GAP], two, 'Abgleich aller Bankkonten')).toBe(await wordsAbove([], two, 'Abgleich aller Bankkonten'));
    expect(await wordsAbove([GAP], two, 'Abgleich aller Bankkonten')).toBe('Alle Konten abgestimmt');
  });

  it.each(['light', 'dark'] as const)('has no axe violations with a gap in the open card, both shapes, in the %s theme', async (theme) => {
    const { container, unmount } = renderRouted(fakeTransport(happy({ dashboard_tile: tileWith([GAP]) })), '/bank', theme);
    await findRow(/Alpina Telecom AG/);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    const one = screen.getByRole('region', { name: 'Abgleich Zürichsee Geschäftskonto' });
    await waitFor(() => expect(one.querySelector('.bank-trust__headline [role="img"]')).not.toBeNull());
    const card = await openCard(one);
    expect(within(card).getByRole('link', { name: 'Lücke schliessen' })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    const { container: several } = renderRouted(fakeTransport(two([GAP])), '/bank', theme);
    await findRow(/Alpina Telecom AG/);
    await waitFor(() => expect(several.querySelector('[aria-busy="true"]')).toBeNull());
    const sum = screen.getByRole('region', { name: 'Abgleich aller Bankkonten' });
    await waitFor(() => expect(sum.querySelector('.bank-trust__headline [role="img"]')).not.toBeNull());
    const sumCard = await openCard(sum);
    await userEvent.click(within(sumCard).getByRole('button', { name: /^Zürichsee Geschäftskonto: Keine Differenz/ }));
    expect(within(sumCard).getByRole('link', { name: 'Lücke schliessen' })).toBeVisible();
    expect(await axe(several)).toHaveNoViolations();
  });
});

/**
 * The bank preview is the ENGINE's composition (`compose_entry`, the follow-up to the D152 amendment): the
 * request the strip sends, only the answer for the request on screen, and the A24 gate. Every name and figure
 * is invented for this file.
 */
describe('the preview reads compose_entry', () => {
  const noVorschlag = { list_drafted_actions: ok({ actions: [] }) };

  it('the strip asks compose_entry for the drafted legs (intent on the booking date, the bank leg plain) and never vat_preview', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag }));
    renderBank(transport);
    await clickRow(await findRow(/Druckerei Talweg/));
    expect(await within(stripOf('bt_druck') as HTMLElement).findByText('davon MWST 6.74 auf 1170 · netto 83.16')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'compose_entry').at(-1)?.input).toEqual({
      workspaceId: 'ws_test',
      mode: 'expand',
      date: '2026-09-22',
      lines: [
        { account: BANK_LEDGER, credit: 8_990 },
        { account: account('6500'), side: 'debit', amount: 8_990, gross: true, taxCode: 'VST-M', supplyDate: '2026-09-22' },
      ],
    });
    expect(calls.some((c) => c.action === 'vat_preview')).toBe(false);
  });

  it('a late answer to an older request never shows: the strip waits for the answer to what is on screen', async () => {
    const engine = composeEngine();
    let releaseOld: () => void = () => undefined;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const base = fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag }));
    const answered: string[] = [];
    const transport: Transport = async (action, input) => {
      if (action !== 'compose_entry') return base(action, input);
      const code = (input.lines as { taxCode?: string }[]).find((l) => l.taxCode !== undefined)?.taxCode ?? '';
      // The first request (VST-M, the proposal) is answered only after the second one (VST-I).
      if (code === 'VST-M') await oldHeld;
      answered.push(code);
      return engine(input);
    };
    renderBank(transport);
    const row = await findRow(/Druckerei Talweg/);
    await clickRow(row);
    const strip = stripOf('bt_druck') as HTMLElement;
    await waitFor(() => expect(within(strip).getByText('So gebucht wie zuletzt am 21.08.2026 (3 Mal).')).toBeInTheDocument());
    // While the answer for the legs on screen is in flight, the strip shows no figure at all.
    expect(within(strip).queryByText(/davon MWST/)).toBeNull();
    await userEvent.click(within(rowOf(/Druckerei Talweg/)).getByRole('button', { name: /^MWST, Druckerei Talweg/ }));
    await userEvent.keyboard('VST-I{Enter}');
    expect(await within(stripOf('bt_druck') as HTMLElement).findByText('davon MWST 6.74 auf 1171 · netto 83.16')).toBeInTheDocument();
    // Now the older answer (VST-M, to 1170) lands. It is not the request on screen, so it never shows.
    act(() => releaseOld());
    await waitFor(() => expect(answered).toEqual(['VST-I', 'VST-M']));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(stripOf('bt_druck') as HTMLElement).queryByText(/auf 1170/)).toBeNull();
    expect(within(stripOf('bt_druck') as HTMLElement).getByText('davon MWST 6.74 auf 1171 · netto 83.16')).toBeInTheDocument();
  });

  it('while the answer to changed legs is in flight, the earlier figure is gone: no stale split is ever shown', async () => {
    const engine = composeEngine();
    let releaseNew: () => void = () => undefined;
    const newHeld = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const base = fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag }));
    const transport = watchReads(async (action, input) => {
      if (action !== 'compose_entry') return base(action, input);
      // The proposal's VST-M answers at once; the changed code's VST-I only when released.
      if ((input.lines as { taxCode?: string }[]).some((l) => l.taxCode === 'VST-I')) await newHeld;
      return engine(input);
    });
    renderBank(transport);
    await clickRow(await findRow(/Druckerei Talweg/));
    expect(await within(stripOf('bt_druck') as HTMLElement).findByText('davon MWST 6.74 auf 1170 · netto 83.16')).toBeInTheDocument();
    await userEvent.click(within(rowOf(/Druckerei Talweg/)).getByRole('button', { name: /^MWST, Druckerei Talweg/ }));
    await userEvent.keyboard('VST-I{Enter}');
    // The second compose_entry (VST-I) really went out and is held: the code on screen is VST-I now, so the
    // VST-M figure (to 1170) is not this booking's, and nothing shows.
    await transport.started('compose_entry', 2);
    expect(transport.asked.filter((a) => a === 'compose_entry')).toHaveLength(2);
    await waitFor(() => expect(within(stripOf('bt_druck') as HTMLElement).queryByText(/davon MWST/)).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(stripOf('bt_druck') as HTMLElement).queryByText(/davon MWST/)).toBeNull();
    act(() => releaseNew());
    expect(await within(stripOf('bt_druck') as HTMLElement).findByText('davon MWST 6.74 auf 1171 · netto 83.16')).toBeInTheDocument();
  });

  // ---- critic F1 (medium): a taxed leg on a foreign-currency line is refused by book_bank_line ----------
  const EUR_LINE = line('bt_eur', {
    amountMinor: -8_990,
    currency: 'EUR',
    counterparty: { name: 'Fournisseur Exemple SA', iban: null },
    proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_990, taxCode: 'VST-M' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('6500'), taxCode: 'VST-M', lastDate: '2026-08-01', count: 2 }, vatCode: 'VST-M' },
  });

  it('F1: a EUR line with a taxed leg in CHF books sends NO compose_entry and says the engine\'s sentence, in the strip and the split editor', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([EUR_LINE]), get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }), ...noVorschlag }));
    renderBank(transport);
    await clickRow(await findRow(/Fournisseur Exemple SA/));
    const strip = stripOf('bt_eur') as HTMLElement;
    expect(await within(strip).findByText('MWST auf einer Zeile in Fremdwährung bucht TILL hier nicht.')).toBeInTheDocument();
    expect(within(strip).queryByText(/davon MWST/)).toBeNull();
    await userEvent.click(within(strip).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(
      await within(editor).findByText('MWST auf einer Zeile in Fremdwährung bucht TILL hier nicht. Buche die Zeile ohne MWST, oder erfass die Buchung im Journal und gleich sie dann ab.'),
    ).toBeInTheDocument();
    expect(within(editor).queryByRole('table')).toBeNull();
    // The base currency was read, and compose_entry was never asked for this booking.
    expect(calls.some((c) => c.action === 'get_company_profile')).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(false);
  });

  it('F1: the same EUR line in books kept in EUR is not foreign: the split shows', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([EUR_LINE]), get_company_profile: ok({ profile: { baseCurrency: 'EUR' } }), ...noVorschlag }));
    renderBank(transport);
    await clickRow(await findRow(/Fournisseur Exemple SA/));
    expect(await within(stripOf('bt_eur') as HTMLElement).findByText('davon MWST 6.74 auf 1170 · netto 83.16')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(true);
  });

  it('F1: an untaxed EUR booking still gets its Soll/Haben table (only VAT is refused on a foreign line)', async () => {
    const plain = line('bt_eur2', {
      amountMinor: -5_000,
      currency: 'EUR',
      counterparty: { name: 'Gebühren Ausland AG', iban: null },
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6900'), amountMinor: 5_000, taxCode: '' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('6900'), taxCode: '', lastDate: '2026-08-01', count: 2 }, vatCode: null },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([plain]), get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }), ...noVorschlag })));
    await clickRow(await findRow(/Gebühren Ausland AG/));
    await userEvent.click(within(stripOf('bt_eur2') as HTMLElement).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(await within(editor).findByRole('table')).toBeInTheDocument();
  });

  // ---- critic L1: a failed read is said, and "wird berechnet" never stays forever -----------------------
  it('L1: a failed compose_entry read says so in one neutral line in the strip, and the split editor never stays on "wird berechnet"', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), compose_entry: { status: 0, body: { ok: false, error: 'transport_error' } }, ...noVorschlag })));
    await clickRow(await findRow(/Druckerei Talweg/));
    const strip = stripOf('bt_druck') as HTMLElement;
    expect(await within(strip).findByText('Die Vorschau ist nicht verfügbar.')).toBeInTheDocument();
    expect(within(strip).queryByText(/davon MWST|MWST liess sich nicht/)).toBeNull();
    await userEvent.click(within(strip).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(await within(editor).findByText('Die Vorschau ist nicht verfügbar.')).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(within(editor).queryByText('Die Buchung wird berechnet.')).toBeNull();
  });

  it('a code the engine cannot price says so in the strip, in words', async () => {
    const NOPE = line('bt_nope', {
      amountMinor: -8_990,
      counterparty: { name: 'Unbekannter Code AG', iban: null },
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6500'), amountMinor: 8_990, taxCode: 'NOPE' }] }, certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('6500'), taxCode: 'NOPE', lastDate: '2026-08-01', count: 1 }, vatCode: 'NOPE' },
    });
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([NOPE]), ...noVorschlag })));
    await clickRow(await findRow(/Unbekannter Code AG/));
    expect(await within(stripOf('bt_nope') as HTMLElement).findByText('MWST liess sich nicht berechnen. Prüf den Code.')).toBeInTheDocument();
  });

  it('without read_books and read_vat the strip shows no split rather than an error, and compose_entry is never asked', async () => {
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag }));
    renderBank(transport, '/bank', { held: [CAP.readSales, CAP.post, CAP.pay, 'read_books'] });
    await clickRow(await findRow(/Druckerei Talweg/));
    const strip = stripOf('bt_druck') as HTMLElement;
    await waitFor(() => expect(within(strip).getByText('So gebucht wie zuletzt am 21.08.2026 (3 Mal).')).toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(strip).queryByText(/davon MWST/)).toBeNull();
    expect(within(strip).queryByText(/MWST liess sich nicht berechnen/)).toBeNull();
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(false);
    // The split editor says why it has no Soll/Haben table.
    await userEvent.click(within(strip).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    expect(within(editor).getByText('Für die Vorschau fehlt dir das Recht, die Buchhaltung und die MWST zu lesen.')).toBeInTheDocument();
  });

  it('the split editor\'s Soll/Haben table is the engine\'s lines: bank, net and Vorsteuer, to the Rappen', async () => {
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([DRUCK]), ...noVorschlag })));
    await clickRow(await findRow(/Druckerei Talweg/));
    await userEvent.click(within(stripOf('bt_druck') as HTMLElement).getByRole('button', { name: 'Aufteilen' }));
    const editor = await screen.findByRole('form', { name: 'Aufteilen oder manuell buchen' });
    const table = await within(within(editor).getByRole('region', { name: 'So wird gebucht' })).findByRole('table');
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      [expect.stringMatching(/^1020/), '', '89.90'],
      [expect.stringMatching(/^6500/), '83.16', ''],
      [expect.stringMatching(/^1170/), '6.74', ''],
    ]);
  });
});
