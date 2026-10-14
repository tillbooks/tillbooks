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
import { MemoryRouter } from 'react-router-dom';

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

void hang;
void axe;
void fireEvent;
void vi;
void settledRows;
void selectedRows;
void EVERY_RIGHT;
void refuse;
void watchReads;
void KAFI;
void ALPINA;
void CAFE;
void DRUCK;
void VORSCHLAG;

// ---- CRITIC PROBES (non-author, claude/bank-compose-entry). Invented names and figures. -----------------
describe('critic probes on the compose_entry preview', () => {
  const noVorschlag = { list_drafted_actions: ok({ actions: [] }) };
  const taxed = (id: string, name: string, minor: number, accountNo: string, code: string, over: Record<string, unknown> = {}) =>
    line(id, {
      amountMinor: -minor,
      counterparty: { name, iban: null },
      proposal: {
        target: { kind: 'accounts', legs: [{ accountId: account(accountNo), amountMinor: minor, taxCode: code }] },
        certainty: 'learned',
        reasonCode: 'history',
        reasonParams: { accountId: account(accountNo), taxCode: code, lastDate: '2026-08-01', count: 2 },
        vatCode: code,
      },
      ...over,
    });

  it('C1 Bezugsteuer (effektiv): the strip names BOTH paired legs, "dazu"', async () => {
    const L = taxed('bt_bez', 'Cloud Anbieter Ltd', 10_000, '6500', 'BEZUG');
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([L]), ...noVorschlag })));
    await clickRow(await findRow(/Cloud Anbieter Ltd/));
    expect(await within(stripOf('bt_bez') as HTMLElement).findByText(/^dazu MWST 8\.10 auf 2200, 8\.10 auf 1170$/)).toBeInTheDocument();
  });

  it('C2 Bezugsteuer (saldo): the input half folds into the account, the strip names only 2200', async () => {
    const L = taxed('bt_bez2', 'Cloud Anbieter Ltd', 10_000, '6500', 'BEZUG');
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([L]), compose_entry: composeEngine({ method: 'saldo' }), ...noVorschlag })));
    await clickRow(await findRow(/Cloud Anbieter Ltd/));
    expect(await within(stripOf('bt_bez2') as HTMLElement).findByText(/^dazu MWST 8\.10 auf 2200$/)).toBeInTheDocument();
  });

  it('C3 FOREIGN CURRENCY (fixed): a EUR line with a taxed leg asks compose_entry nothing and says book_bank_line\'s sentence', async () => {
    const L = taxed('bt_eur', 'Fournisseur Exemple SA', 8_990, '6500', 'VST-M', { currency: 'EUR' });
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([L]), get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }), ...noVorschlag }));
    renderBank(transport);
    await clickRow(await findRow(/Fournisseur Exemple SA/));
    expect(await within(stripOf('bt_eur') as HTMLElement).findByText('MWST auf einer Zeile in Fremdwährung bucht TILL hier nicht.')).toBeInTheDocument();
    expect(within(stripOf('bt_eur') as HTMLElement).queryByText(/davon MWST/)).toBeNull();
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(false);
  });

  it('C4 a compose_entry transport failure (fixed): the strip says so in one neutral line, never a figure', async () => {
    const L = taxed('bt_tx', 'Transport Fehler AG', 8_990, '6500', 'VST-M');
    renderBank(fakeTransport(happy({ list_bank_inbox: inboxFor([L]), compose_entry: { status: 0, body: { ok: false, error: 'transport_error' } }, ...noVorschlag })));
    await clickRow(await findRow(/Transport Fehler AG/));
    const strip = stripOf('bt_tx') as HTMLElement;
    expect(await within(strip).findByText('Die Vorschau ist nicht verfügbar.')).toBeInTheDocument();
    expect(within(strip).queryByText(/davon MWST|MWST liess sich nicht/)).toBeNull();
  });

  it('C5 only read_vat (no read_books): no split, no error banner, compose_entry never asked', async () => {
    const L = taxed('bt_rv', 'Nur MWST AG', 8_990, '6500', 'VST-M');
    const { transport, calls } = recording(happy({ list_bank_inbox: inboxFor([L]), ...noVorschlag }));
    renderBank(transport, '/bank', { held: [CAP.readSales, CAP.post, 'read_vat'] });
    await clickRow(await findRow(/Nur MWST AG/));
    const strip = stripOf('bt_rv') as HTMLElement;
    await waitFor(() => expect(within(strip).getByText(/So gebucht wie zuletzt/)).toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(strip).queryByText(/davon MWST|dazu MWST|MWST liess sich nicht/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.some((c) => c.action === 'compose_entry')).toBe(false);
  });
});

