/**
 * D178 N2 (A39 §18): the /bank shell against a fake engine. The detail area closes by × and Escape and gives
 * the focus back to the row; Escape in an open menu closes only the menu; the dock control and a header drag
 * write `bank.detail_position`; the divider's keys resize within the bounds and write once they rest;
 * automatic decides ONCE on entry (bottom at 8 or fewer open lines, right above, never moved mid-work); the
 * facts card shows the develop fields and every optional statement fact; and a row carries at most one text
 * button, every icon control named and with its tooltip, the ignore reasons one click each in Mehr.
 *
 * Every name, IBAN, reference and figure in this file is invented.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { FactsCard } from './FactsCard';
import { EMPTY_LOOKUPS } from './lookups';
import type { BankInboxLine } from './model';
import {
  SIZE_WRITE_DELAY_MS,
  clampSize,
  decideAutomatic,
  dropEdgeAt,
  sizeBounds,
  sizeDef,
  sizeForKey,
} from './useDetailLayout';

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
    amountMinor: -1_250,
    currency: 'CHF',
    creditDebit: 'DBIT',
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

/** The inbox over a list the test may change between reads (the count moving mid-work). */
function inboxOver(lines: () => unknown[]): Handler {
  return (input) => {
    const status = input.status as string;
    const mine = lines().filter((l) => (l as { state: string }).state === status || status === 'all');
    return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY] });
  };
}

function canned(lines: () => unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: inboxOver(lines),
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [{ code: 'VST-M', kind: 'input', rateBp: 810, label: 'Vorsteuer Material', formLine: '400', active: true }] }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    compose_entry: ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: true } }),
    ignore_bank_line: ok({ state: 'ignored', warnings: [] }),
    reopen_bank_line: ok({ state: 'open', warnings: [] }),
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
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  } as Capabilities;
}

/** A person's preferences, held in a detached store the test reads back. */
function prefs(seed: Record<string, string | number> = {}): PrefsStore {
  const store = new PrefsStore(null, null, { useCache: false });
  for (const [k, v] of Object.entries(seed)) store.seed(k, v);
  return store;
}

function renderBank(transport: Transport, store: PrefsStore) {
  return render(
    <CapabilitiesContext.Provider value={caps(EVERY_RIGHT)}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={store}>
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

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`tr.bank-row[data-line="${id}"]`);
  if (row === null) throw new Error(`no row ${id}`);
  return row;
}
async function rowReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  return rowOf(id);
}
async function open(id: string): Promise<HTMLElement> {
  const row = await rowReady(id);
  await userEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement);
  await waitFor(() => expect(document.querySelector(`[data-area-for="${id}"]`)).not.toBeNull());
  return document.querySelector(`[data-area-for="${id}"]`) as HTMLElement;
}
const workspace = () => document.querySelector('.bank-workspace') as HTMLElement;
const lines = (n: number) => Array.from({ length: n }, (_, i) => line(`bt_${i + 1}`, { bookingDate: `2026-10-${String(20 - i).padStart(2, '0')}` }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- the pure layout rules ----------------------------------------------------------------------------

describe('the layout rules (A39 §18.2)', () => {
  it('automatic: bottom at the threshold or fewer, right above, right without a count', () => {
    expect(decideAutomatic(0, 8)).toBe('bottom');
    expect(decideAutomatic(8, 8)).toBe('bottom');
    expect(decideAutomatic(9, 8)).toBe('right');
    expect(decideAutomatic(3, 2)).toBe('right');
    expect(decideAutomatic(null, 8)).toBe('right');
  });

  it('the size bounds are the registry\'s, inside the room the list keeps', () => {
    expect(sizeDef('right')).toEqual({ min: 320, max: 960, default: 360 });
    expect(sizeDef('bottom')).toEqual({ min: 200, max: 800, default: 320 });
    expect(sizeBounds('right', null)).toEqual({ min: 320, max: 960 });
    // 1000 px of workspace: the list keeps 240, the divider 8, so the area may take 752.
    expect(sizeBounds('right', { width: 1000, height: 600 })).toEqual({ min: 320, max: 752 });
    // A room too small for both: the area keeps its minimum.
    expect(sizeBounds('bottom', { width: 1000, height: 300 })).toEqual({ min: 200, max: 200 });
    expect(clampSize('right', 9999, { width: 1000, height: 600 })).toBe(752);
    expect(clampSize('right', 10, null)).toBe(320);
    expect(clampSize('bottom', 333.4, null)).toBe(333);
  });

  it('a header drag docks only in the other edge\'s half', () => {
    const rect = { left: 0, top: 0, width: 1000, height: 600 };
    expect(dropEdgeAt('right', { x: 500, y: 500 }, rect)).toBe('bottom');
    expect(dropEdgeAt('right', { x: 500, y: 100 }, rect)).toBeNull();
    expect(dropEdgeAt('bottom', { x: 900, y: 100 }, rect)).toBe('right');
    expect(dropEdgeAt('bottom', { x: 100, y: 100 }, rect)).toBeNull();
    expect(dropEdgeAt('right', { x: 1200, y: 500 }, rect)).toBeNull();
  });

  it('the divider\'s keys follow the edge: toward the list grows the area, Home and End go to the bounds', () => {
    const b = { min: 320, max: 700 };
    expect(sizeForKey('right', 'ArrowLeft', false, 400, b)).toBe(416);
    expect(sizeForKey('right', 'ArrowRight', true, 400, b)).toBe(336);
    expect(sizeForKey('bottom', 'ArrowUp', false, 400, b)).toBe(416);
    expect(sizeForKey('bottom', 'ArrowDown', false, 330, b)).toBe(320);
    expect(sizeForKey('right', 'Home', false, 400, b)).toBe(320);
    expect(sizeForKey('right', 'End', false, 400, b)).toBe(700);
    expect(sizeForKey('right', 'ArrowUp', false, 400, b)).toBeNull();
  });
});

// --- the detail area ----------------------------------------------------------------------------------

describe('the detail area (A39 §18.1, §18.2)', () => {
  it('automatic decides ON ENTRY: 3 open lines dock it at the bottom, and it stays there when the count grows', async () => {
    let list = lines(3);
    const { transport } = recording(canned(() => list));
    renderBank(transport, prefs());
    await open('bt_1');
    expect(workspace()).toHaveAttribute('data-dock', 'bottom');
    // Docked at the bottom the table keeps every column (the D177 compact table is the right dock's).
    expect(document.querySelector('col.bank-col--vat')).not.toBeNull();
    // Twelve open lines arrive (a fetch, an import) and the person ignores the line: the re-read brings
    // them, the selection moves on to the next line, and the area stays where it was decided.
    list = lines(12);
    await userEvent.click(within(rowOf('bt_1')).getByRole('button', { name: /^Weitere Aktionen für Probe bt_1/ }));
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Ignorieren: Doppelt geliefert' }));
    await rowReady('bt_12');
    await waitFor(() => expect(document.querySelector('[data-area-for]')).not.toBeNull());
    expect(workspace()).toHaveAttribute('data-dock', 'bottom');
  });

  it('automatic with more than 8 open lines docks it right, the table compact beside it', async () => {
    const { transport } = recording(canned(() => lines(9)));
    renderBank(transport, prefs());
    await open('bt_1');
    expect(workspace()).toHaveAttribute('data-dock', 'right');
    expect(document.querySelector('col.bank-col--vat')).toBeNull();
  });

  it('the threshold is the person\'s: at 2, three open lines dock right', async () => {
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, prefs({ 'bank.detail_auto_threshold': 2 }));
    await open('bt_1');
    expect(workspace()).toHaveAttribute('data-dock', 'right');
  });

  it('× closes it and the focus goes back to the line\'s row; selecting a row opens it again', async () => {
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, prefs());
    const area = await open('bt_2');
    expect(area).toHaveAccessibleName(/Probe bt_2/);
    await userEvent.click(within(area).getByRole('button', { name: 'Schliessen' }));
    await waitFor(() => expect(document.querySelector('[data-area-for]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowOf('bt_2')));
    // The keyboard reopens it from the focused row.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.querySelector('[data-area-for="bt_2"]')).not.toBeNull());
  });

  it('Escape inside the area closes it; Escape in an open menu closes only the menu first', async () => {
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, prefs());
    const area = await open('bt_3');
    // The footer's Mehr (the rare "Agent fragen") is a menu: its Escape is its own.
    const more = within(area).getByRole('button', { name: 'Mehr zu Probe bt_3' });
    await userEvent.click(more);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('[data-area-for="bt_3"]')).not.toBeNull();
    expect(document.activeElement).toBe(more);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[data-area-for]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowOf('bt_3')));
  });

  it('the dock control is the keyboard\'s way: "Unten" docks it at the bottom and writes the person\'s preference', async () => {
    const store = prefs({ 'bank.detail_position': 'right' });
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, store);
    const area = await open('bt_1');
    expect(workspace()).toHaveAttribute('data-dock', 'right');
    const dock = within(area).getByRole('radiogroup', { name: 'Position der Details' });
    expect(within(dock).getByRole('radio', { name: 'Rechts' })).toBeChecked();
    await userEvent.click(within(dock).getByRole('radio', { name: 'Unten' }));
    await waitFor(() => expect(workspace()).toHaveAttribute('data-dock', 'bottom'));
    expect(store.value('bank.detail_position')).toBe('bottom');
  });

  it('the divider resizes by its keys within the bounds and writes the size once the keys rest', async () => {
    const store = prefs({ 'bank.detail_position': 'right' });
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, store);
    await open('bt_1');
    const divider = screen.getByRole('separator', { name: 'Grösse der Details' });
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    expect(divider).toHaveAttribute('aria-valuenow', '360');
    expect(divider).toHaveAttribute('aria-controls', (document.querySelector('[data-area-for]') as HTMLElement).id);
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    fireEvent.keyDown(divider, { key: 'ArrowLeft', shiftKey: true });
    expect(divider).toHaveAttribute('aria-valuenow', String(360 + 16 + 64));
    expect(workspace().style.getPropertyValue('--bank-area-size')).toBe('440px');
    // Written once the keys rest, to the right dock's width.
    expect(store.value('bank.detail_width')).toBe(360);
    await waitFor(() => expect(store.value('bank.detail_width')).toBe(440), { timeout: SIZE_WRITE_DELAY_MS + 1000 });
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider).toHaveAttribute('aria-valuenow', '320');
    // A double-click returns the default.
    fireEvent.doubleClick(divider);
    await waitFor(() => expect(divider).toHaveAttribute('aria-valuenow', '360'));
  });

  it('a header drag into the lower half docks it at the bottom; anywhere else changes nothing', async () => {
    const store = prefs({ 'bank.detail_position': 'right' });
    const { transport } = recording(canned(() => lines(3)));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('bank-workspace') ? { left: 0, top: 100, width: 1000, height: 600 } : { left: 0, top: 0, width: 0, height: 0 };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
    });
    renderBank(transport, store);
    const area = await open('bt_1');
    const head = area.querySelector('.bank-area__head') as HTMLElement;
    // A drag that ends in the upper half: nothing changes.
    fireEvent.pointerDown(head, { button: 0, clientX: 800, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 700, clientY: 200, pointerId: 1 });
    expect(store.value('bank.detail_position')).toBe('right');
    // Into the lower 40 percent: the preview shows there, and letting go docks it at the bottom.
    fireEvent.pointerDown(head, { button: 0, clientX: 800, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 600, pointerId: 1 });
    expect(document.querySelector('.bank-dock-preview')).toHaveAttribute('data-edge', 'bottom');
    fireEvent.pointerUp(window, { clientX: 500, clientY: 600, pointerId: 1 });
    await waitFor(() => expect(workspace()).toHaveAttribute('data-dock', 'bottom'));
    expect(store.value('bank.detail_position')).toBe('bottom');
    expect(document.querySelector('.bank-dock-preview')).toBeNull();
  });

  it('a press on a control in the header starts no drag', async () => {
    const store = prefs({ 'bank.detail_position': 'right' });
    const { transport } = recording(canned(() => lines(3)));
    renderBank(transport, store);
    const area = await open('bt_1');
    const close = within(area).getByRole('button', { name: 'Schliessen' });
    fireEvent.pointerDown(close, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 900, pointerId: 1 });
    expect(area).not.toHaveAttribute('data-dragging');
    fireEvent.pointerUp(window, { pointerId: 1 });
  });
});

// --- the facts card -----------------------------------------------------------------------------------

function renderCard(l: BankInboxLine, onReceipts?: () => void) {
  return render(
    <I18nProvider initialLocale="de-CH">
      <FactsCard line={l} lookups={EMPTY_LOOKUPS} titleId="facts-title" showAccount={false} {...(onReceipts !== undefined ? { onReceipts } : {})} />
    </I18nProvider>,
  );
}
const factText = (key: string) => (document.querySelector(`[data-fact="${key}"] dd`) as HTMLElement | null)?.textContent ?? null;

describe('the facts card (A39 §18.4)', () => {
  it('without statement facts: the title, both dates, the IBAN, the bank text and the QR reference, one line each', () => {
    renderCard(
      line('bt_qr', {
        amountMinor: -12_345,
        counterparty: { name: 'Probe Druck AG', iban: 'CH4431999123000889012' },
        remittance: { text: 'Rechnung 2026-117', referenceKind: 'QRR', referenceValue: '210000000003139471430009017', endToEndId: 'E2E-PROBE-7' },
      }) as unknown as BankInboxLine,
    );
    const title = screen.getByRole('heading', { level: 2 });
    expect(title).toHaveTextContent('Probe Druck AG');
    expect(title).toHaveTextContent("−CHF 123.45");
    expect(title.querySelector('.bank-amount__sign')).toHaveTextContent('−');
    expect(factText('date')).toBe('14.10.2026 · Valuta 15.10.2026');
    expect(factText('iban')).toBe('CH44 3199 9123 0008 8901 2');
    expect(factText('text')).toBe('Rechnung 2026-117');
    expect(factText('reference')).toBe('QR-Referenz 21 00000 00003 13947 14300 09017');
    expect(factText('e2e')).toBe('End-to-End E2E-PROBE-7');
    // No statement facts: nothing empty for them.
    for (const key of ['info', 'bankref', 'code', 'fx', 'receipts', 'account']) expect(document.querySelector(`[data-fact="${key}"]`)).toBeNull();
    // Every fact names itself to assistive tech; its glyph is hidden.
    for (const dt of document.querySelectorAll('.bank-facts__row dt')) {
      expect(dt.querySelector('.visually-hidden')?.textContent).not.toBe('');
      expect(dt.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('with the statement facts (D178 points 3 and 4): the bank text and the extra info apart, the bank reference, the code with its label, FX', () => {
    renderCard(
      line('bt_fx', {
        amountMinor: -11_234,
        remittance: { text: 'KARTE 1234 PROBE SHOP NEW YORK', referenceKind: 'NON', referenceValue: null, endToEndId: null },
        facts: {
          source: 'camt053',
          bankCode: { domain: 'PMNT', family: 'CCRD', subFamily: 'POSD', proprietary: null, issuer: null, label: { en: 'Payment with card at POS', 'de-CH': 'Zahlung mit Karte am POS' } },
          bankText: 'PROBE SHOP NEW YORK',
          additionalInfo: 'Kartenzahlung 12.10.2026',
          entryInfo: null,
          refs: { endToEndId: null, accountServicerRef: 'ZKB-2026-PROBE-1', instructionId: null, transactionId: null },
          instructed: { amountMinor: 12_000, currency: 'USD' },
          transactionAmount: null,
          counterValue: null,
          exchange: { sourceCurrency: 'USD', targetCurrency: 'CHF', unitCurrency: 'USD', rate: '0.9212', effectiveRate: '0.936167', origin: 'structured' },
          charges: { totalMinor: 180, currency: 'CHF', records: [], origin: 'structured' },
          fee: { amountMinor: 180, currency: 'CHF', included: true, origin: 'charges' },
        },
      }) as unknown as BankInboxLine,
    );
    expect(factText('text')).toBe('PROBE SHOP NEW YORK');
    expect(factText('info')).toBe('Kartenzahlung 12.10.2026');
    expect(factText('bankref')).toBe('Bankreferenz ZKB-2026-PROBE-1');
    expect(factText('code')).toBe('Zahlung mit Karte am POS (PMNT / CCRD / POSD)');
    expect(factText('fx')).toBe("USD 120.00 · Kurs 0.9212 · effektiv 0.936167 · Gebühr CHF 1.80");
  });

  it('a malformed or absent facts field shows only what the line has', () => {
    renderCard(line('bt_odd', { facts: { bankCode: 'PMNT', refs: null, instructed: { amountMinor: 'x' } } }) as unknown as BankInboxLine);
    expect(document.querySelector('[data-fact="code"]')).toBeNull();
    expect(document.querySelector('[data-fact="fx"]')).toBeNull();
    expect(factText('text')).toBe('Text bt_odd');
  });

  it('the Belege count opens the Belege', async () => {
    const onReceipts = vi.fn();
    renderCard(line('bt_clip', { receiptCount: 2 }) as unknown as BankInboxLine, onReceipts);
    await userEvent.click(screen.getByRole('button', { name: '2 Belege' }));
    expect(onReceipts).toHaveBeenCalledOnce();
  });
});

// --- clear row buttons --------------------------------------------------------------------------------

describe('clear row buttons (A39 §18.5)', () => {
  it('a row carries at most one text button, and every icon control has a name and a tooltip', async () => {
    const { transport } = recording(canned(() => [line('bt_a', { receiptCount: 1 }), line('bt_b')]));
    renderBank(transport, prefs());
    for (const id of ['bt_a', 'bt_b']) {
      const row = await rowReady(id);
      const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.closest('[role="combobox"], .picker-trigger, .picker-field') === null && !b.classList.contains('picker-trigger'));
      const text = buttons.filter((b) => b.querySelector('svg') === null && (b.textContent ?? '').trim() !== '');
      expect(text.map((b) => b.textContent)).toEqual(['Buchen']);
      for (const b of buttons.filter((x) => x.querySelector('svg') !== null)) {
        expect(b).toHaveAccessibleName();
        expect(b.getAttribute('aria-describedby')).not.toBeNull();
      }
    }
    // The paperclip only where it says something: a count.
    expect(rowOf('bt_a').querySelector('.bank-clip')).not.toBeNull();
    expect(rowOf('bt_b').querySelector('.bank-clip')).toBeNull();
    // No star and no cross on the row: their acts are words in Mehr.
    expect(document.querySelector('tr.bank-row .bank-star, tr.bank-row [data-icon="ignore"]')).toBeNull();
  });

  it('Mehr says its acts in words; "Ignorieren: <Grund>" ignores in one click and the status line offers Rückgängig', async () => {
    const { transport, calls } = recording(canned(() => [line('bt_a')]));
    renderBank(transport, prefs());
    const row = await rowReady('bt_a');
    const more = within(row).getByRole('button', { name: /^Weitere Aktionen für Probe bt_a/ });
    expect(more).toHaveAttribute('data-icon', 'more');
    await userEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Beleg anhängen',
      'Ignorieren: Wird anderswo gebucht',
      'Ignorieren: Läuft über ein Durchlaufkonto',
      'Ignorieren: Vor dem Start in TILL',
      'Ignorieren: Doppelt geliefert',
      'Ignorieren: Anderer Grund',
    ]);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Ignorieren: Doppelt geliefert' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'ignore_bank_line' && c.input.reason === 'duplicate' && c.input.bankTxnId === 'bt_a')).toBe(true));
    expect(await screen.findByRole('button', { name: 'Rückgängig' })).toBeInTheDocument();
  });

  it('a one-account booking saves its Buchungsregel from Mehr; a line on a rule opens or removes it there', async () => {
    const STANDARD = {
      id: 'bs_fee',
      scope: 'bank',
      outcome: 'legs',
      counterpartyKey: 'name:probe bt_r',
      counterpartyLabel: 'Probe bt_r',
      direction: 'out',
      label: 'Probe Gebühren',
      matchText: null,
      viaAccountId: null,
      legs: [{ accountId: account('6900'), accountNumber: '6900', accountName: 'Finanzaufwand', taxCode: null, amount: { kind: 'rest' } }],
      invalidReason: null,
      accountId: account('6900'),
      accountNumber: '6900',
      accountName: 'Finanzaufwand',
      taxCode: null,
    };
    const onRule = line('bt_r', {
      standardId: 'bs_fee',
      ruleIds: ['bs_fee'],
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6900'), amountMinor: 1_250, taxCode: '' }] }, certainty: 'sure', reasonCode: 'standard', reasonParams: { standardId: 'bs_fee', accountId: account('6900') }, vatCode: null },
      attention: 'sure',
    });
    const plain = line('bt_p', {
      proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6900'), amountMinor: 1_250, taxCode: '' }] }, certainty: 'learned', reasonCode: 'bank_history', reasonParams: {}, vatCode: null },
    });
    const { transport, calls } = recording(
      canned(() => [onRule, plain], { list_bank_standards: ok({ standards: [STANDARD] }), set_bank_standard: ok({ standardId: 'bs_new' }), clear_bank_standard: ok({ standardId: 'bs_fee' }) }),
    );
    renderBank(transport, prefs());
    const ruleRow = await rowReady('bt_r');
    await userEvent.click(within(ruleRow).getByRole('button', { name: /^Weitere Aktionen für Probe bt_r/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items.slice(0, 2)).toEqual(['Buchungsregel öffnen', 'Buchungsregel entfernen']);
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Buchungsregel entfernen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'clear_bank_standard' && c.input.standardId === 'bs_fee')).toBe(true));

    const plainRow = await rowReady('bt_p');
    await userEvent.click(within(plainRow).getByRole('button', { name: /^Weitere Aktionen für Probe bt_p/ }));
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Als Buchungsregel speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard' && c.input.bankTxnId === 'bt_p')).toBe(true));
  });
});

// --- D178 point 19: a possible duplicate --------------------------------------------------------------

describe('a line flagged as a possible duplicate (D178 point 19, A20 §11.4)', () => {
  const FLAGGED = line('bt_dup', {
    counterparty: { name: 'Probe Kartenzahlung', iban: null },
    needsDuplicateDecision: true,
    possibleDuplicateOf: { bankTxnId: 'bt_old', reason: 'same_movement' },
    possibleDuplicates: [{ bankTxnId: 'bt_old', reason: 'same_movement', format: 'mt940', date: '2026-10-13', amountMinor: -1_250, currency: 'CHF' }],
  });

  it('marks the row, keeps Buchen disabled with its reason, names the candidate, and "Duplikat" answers with it', async () => {
    const { transport, calls } = recording(canned(() => [FLAGGED], { resolve_possible_duplicate: ok({ bankTxnId: 'bt_dup', decision: 'duplicate', state: 'ignored' }) }));
    renderBank(transport, prefs({ 'bank.detail_position': 'right' }));
    const row = await rowReady('bt_dup');
    expect(row).toHaveAttribute('data-duplicate', 'true');
    expect(within(row).getByRole('img', { name: 'Mögliches Duplikat: Entscheid offen' })).toBeInTheDocument();
    const book = within(row).getByRole('button', { name: 'Buchen' });
    expect(book).toHaveAttribute('aria-disabled', 'true');
    expect(document.getElementById(book.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Zuerst entscheiden: Duplikat?');
    const area = await open('bt_dup');
    const check = within(area).getByRole('group', { name: 'Mögliches Duplikat von' });
    expect(check).toHaveTextContent('MT940 · 13.10.2026 · −CHF 12.50');
    expect(check).toHaveTextContent('gleiche Bewegung: Betrag, Datum, Gegenpartei');
    await userEvent.click(within(check).getByRole('button', { name: 'Duplikat' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'resolve_possible_duplicate')).toBe(true));
    expect(calls.find((c) => c.action === 'resolve_possible_duplicate')?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'bt_dup', decision: 'duplicate', otherBankTxnId: 'bt_old' });
    expect(await screen.findByRole('button', { name: 'Rückgängig' })).toBeInTheDocument();
  });

  it('"Kein Duplikat" answers distinct; a new line on a covered day asks the same with its reason', async () => {
    const COVERED = line('bt_cov', { needsDuplicateDecision: true, possibleDuplicateOf: { bankTxnId: null, reason: 'covered_period_new_line' }, possibleDuplicates: [] });
    const { transport, calls } = recording(canned(() => [COVERED], { resolve_possible_duplicate: ok({ bankTxnId: 'bt_cov', decision: 'distinct', state: 'open' }) }));
    renderBank(transport, prefs());
    const area = await open('bt_cov');
    const check = within(area).getByRole('group', { name: 'Mögliches Duplikat' });
    expect(check).toHaveTextContent('Neue Zeile an einem Tag, für den schon ein Auszug in den Büchern steht.');
    await userEvent.click(within(check).getByRole('button', { name: 'Kein Duplikat' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'resolve_possible_duplicate')?.input).toMatchObject({ bankTxnId: 'bt_cov', decision: 'distinct' }));
    expect(calls.find((c) => c.action === 'resolve_possible_duplicate')?.input).not.toHaveProperty('otherBankTxnId');
  });

  it('an unflagged line asks nothing', async () => {
    const { transport } = recording(canned(() => [line('bt_plain')]));
    renderBank(transport, prefs());
    const area = await open('bt_plain');
    expect(area.querySelector('.bank-dup')).toBeNull();
    expect(rowOf('bt_plain')).not.toHaveAttribute('data-duplicate');
  });

  it('an import that matched lines one to one offers "Alle exakten Treffer sind Duplikate" for its delivery', async () => {
    const { transport, calls } = recording(
      canned(() => [line('bt_1')], {
        import_camt: ok({ statementId: 'st_9', txnCount: 3, duplicate: false, skipped: [], warnings: ['overlap_same_movement'] }),
        resolve_possible_duplicate: ok({ statementId: 'st_9', scope: 'one_to_one_matches', decision: 'duplicate', decided: [], count: 2 }),
      }),
    );
    renderBank(transport, prefs());
    await rowReady('bt_1');
    await userEvent.click(screen.getByRole('button', { name: 'Kontoauszug holen' }));
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Datei importieren' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>'], 'probe.xml', { type: 'text/xml' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(/Neue Zeilen gleichen Bewegungen, die schon in den Büchern stehen/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Alle exakten Treffer sind Duplikate' }));
    await waitFor(() =>
      expect(calls.find((c) => c.action === 'resolve_possible_duplicate')?.input).toMatchObject({ statementId: 'st_9', scope: 'one_to_one_matches', decision: 'duplicate' }),
    );
    expect(await screen.findByText('2 Zeilen als Duplikat ignoriert.')).toBeInTheDocument();
  });
});
