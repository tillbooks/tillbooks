/**
 * D207 (owner, 16.11.2026): Pendenzen in three sections, rows that open in place, and "Freigeben und künftig
 * automatisch" in one click. Rendered from canned engine answers; every assertion is about what the page shows
 * and which verbs it sends, in which order.
 *
 *  - the filters narrow the WHOLE page: a Bank filter leaves the bank rows only, and the Ereignisse zone (which
 *    has no area to match) steps away while a filter is set (the owner's "the Bank filter keeps everything");
 *  - three sections with their glyph and count; a row click (and Enter) opens the details below, which are
 *    inert while closed; the chevron is named "Details"; three icons, one word each; no overflow menu;
 *  - the one click: approve first, and only once it landed `set_bank_standard { fromBankTxnId }`; Rückgängig
 *    sends `clear_bank_standard` for exactly that rule and never reverses the booking; a refused rule is said in
 *    the Bankbuchungen section with its retry; an approval that refuses saves no rule;
 *  - `attention.auto_rule_confirm = always`: the rule shows in the opened row first, the second click runs it;
 *  - every Vorschlag row keeps the actions column, so date and amount stay on one edge.
 *
 * SYNTHETIC BY CONSTRUCTION: invented counterparties; the accounts are the pinned `list_accounts` recording.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { resetPrefsModuleForTests } from '../../lib/prefs';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { Attention } from './index';
import { bankVorschlag, draftedBankLine, groupedOf, linesRow } from './testing';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;
type Call = { action: string; input: Record<string, unknown> };

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderHub(canned: Canned, caps?: Capabilities) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? await entry((input ?? {}) as Record<string, unknown>) : entry;
  };
  const tree = (
    <MemoryRouter initialEntries={['/attention']}>
      <Routes>
        <Route path="/attention" element={<Attention />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">{caps !== undefined ? <CapabilitiesContext.Provider value={caps}>{tree}</CapabilitiesContext.Provider> : tree}</WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls };
}

/** A VAT Vorschlag of the System queue (not a bank decision): "Weitere Vorschläge". */
function vatVorschlag(actionId: string): Record<string, unknown> {
  return bankVorschlag(actionId, {
    queueId: 'agent_action',
    subtitleParams: { tool: 'vat_mark_filed' },
    amountMinor: undefined,
    currency: undefined,
    batchable: false,
    posts: false,
  });
}

/** The engine after one approval: the approved row is gone from the next read. */
function afterApproval(rows: Record<string, unknown>[], approved: { id: string | null }): Handler {
  return () => ok(groupedOf(rows.filter((r) => r.entityId !== approved.id), { grouping: 'by_kind' }));
}

const BANK_LINE = draftedBankLine('a1', 'Lastschrift BEISPIEL HOSTING 07.11', -4275);
// The line's counterparty, as the engine sends it on the row.
const A1 = bankVorschlag('a1', { subtitleParams: { tool: 'book_bank_line', date: '2026-11-07', target: '6570 Informatik, Software und Lizenzen', targetKind: 'accounts', counterparty: 'Beispiel Hosting AG' }, amountMinor: -4275 });

function bookingWorld(over: Canned = {}): { canned: Canned; approved: { id: string | null } } {
  const approved = { id: null as string | null };
  const canned: Canned = {
    attention_list: afterApproval([A1], approved),
    list_drafted_actions: ok({ actions: [BANK_LINE] }),
    list_accounts: ok({ accounts: listAccountsFixture.accounts }),
    approve_drafted_action: (input) => {
      approved.id = String(input.actionId);
      return ok({ executed: true });
    },
    set_bank_standard: ok({ standard: { id: 'std_1' }, supersededId: null, unchanged: false }),
    clear_bank_standard: ok({ standardId: 'std_1' }),
    settings_get: ok({ setting: { key: 'attention.auto_rule_confirm', value: 'never' } }),
    // The slot the rule fills is empty unless a test says otherwise.
    list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: [] }] }),
    list_bank_standards: ok({ standards: [] }),
    ...over,
  };
  return { canned, approved };
}

const automateButton = () => screen.findByRole('button', { name: 'Freigeben und als Regel speichern' });

/** Let the side reads (events, drafted payloads, the dial, the chart, the setting) land. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

/** The third icon once the page's reads (the setting among them) have landed. */
async function readyAutomate(): Promise<HTMLElement> {
  await automateButton();
  await settle();
  return screen.getByRole('button', { name: 'Freigeben und als Regel speichern' });
}

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
});

describe('D207: the filters narrow the whole page (the Bank filter defect)', () => {
  it('a Bank filter leaves only bank rows AND the Ereignisse zone steps away while it is set', async () => {
    renderHub({
      attention_list: ok(groupedOf([A1, vatVorschlag('v1'), linesRow(2)], { grouping: 'by_kind' })),
      notifications_list: ok({ items: [{ id: 'n1', event: 'vat_return_due', summaryI18nKey: '', summaryParams: {}, status: 'unread', day: '2026-11-15' }] }),
    });
    await screen.findByText('2 Bankzeilen zu buchen');
    expect(await screen.findByRole('heading', { name: 'Ereignisse' })).toBeInTheDocument();
    expect(document.querySelectorAll('.att-list > li')).toHaveLength(3);
    await userEvent.click(document.querySelector('.facet-chip-add') as HTMLElement);
    await userEvent.click(screen.getAllByRole('menuitem').find((m) => m.textContent === 'Bank') as HTMLElement);
    // The rows: the bank booking and the bank lines; the VAT Vorschlag is gone.
    expect(document.querySelectorAll('.att-list > li')).toHaveLength(2);
    expect(document.querySelector('[data-section="other"]')).toBeNull();
    // Nothing else stays standing under a Bank filter: the events (no area) step away.
    expect(screen.queryByRole('heading', { name: 'Ereignisse' })).toBeNull();
    expect(screen.queryByText('vat_return_due')).toBeNull();
    // Clearing the filter brings the zone back.
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(await screen.findByRole('heading', { name: 'Ereignisse' })).toBeInTheDocument();
  });
});

describe('D207: three sections, rows that open in place', () => {
  it('Bankbuchungen, Weitere Vorschläge, Zu erledigen, each with its glyph and count; a filter acts across all three', async () => {
    renderHub({ attention_list: ok(groupedOf([A1, bankVorschlag('a2'), vatVorschlag('v1'), linesRow(3)], { grouping: 'by_kind' })) });
    await screen.findByText('3 Bankzeilen zu buchen');
    const sections = [...document.querySelectorAll('[data-section]')];
    expect(sections.map((s) => s.getAttribute('data-section'))).toEqual(['bank', 'other', 'todo']);
    expect(sections.map((s) => s.querySelector('h2')?.textContent)).toEqual(['Bankbuchungen2', 'Weitere Vorschläge1', 'Zu erledigen3']);
    // D208: a section is its heading on the page ground, no glyph beside its name.
    for (const s of sections) expect(s.querySelector('.att-section-glyph')).toBeNull();
    // D208: the chip "Erledigen" shows that section alone.
    await userEvent.click(within(screen.getByRole('group', { name: 'Art' })).getByRole('button', { name: /Erledigen/ }));
    expect([...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'))).toEqual(['todo']);
  });

  it('D208: a click on the row opens ONE line beneath (no labels, no Bankzeile/Warum/Von blocks); Enter toggles; Öffnen leads to the line', async () => {
    renderHub({ attention_list: ok(groupedOf([A1], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [BANK_LINE] }), list_accounts: ok({ accounts: listAccountsFixture.accounts }) });
    await screen.findByText('Beispiel Hosting AG');
    await settle();
    const line = document.querySelector('.pl') as HTMLElement;
    const main = line.querySelector('button.pl-main') as HTMLButtonElement;
    expect(main).toHaveAttribute('aria-expanded', 'false');
    expect(line.querySelector('.pl-open')).toBeNull();
    fireEvent.click(main);
    expect(main).toHaveAttribute('aria-expanded', 'true');
    const open = line.querySelector('.pl-open') as HTMLElement;
    const text = within(open).getByRole('textbox', { name: 'Buchungstext' }) as HTMLInputElement;
    expect(text.value).toBe('Lastschrift BEISPIEL HOSTING 07.11');
    expect(within(open).getByRole('combobox', { name: 'Konto' })).toBeInTheDocument();
    expect(within(open).getByRole('combobox', { name: 'MWST-Code' })).toBeInTheDocument();
    // No visible field labels and no wall of text: the names are the tooltips and the accessible names.
    expect(open.querySelector('label, dt, .vorschlag-readback')).toBeNull();
    expect(open.textContent).not.toMatch(/Warum|Bewirkt/);
    // D210: the open line repeats no icon; unchanged, the row's own commit is Freigeben.
    expect(within(open).queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(within(line.querySelector('.pl-acts') as HTMLElement).getByRole('button', { name: 'Freigeben' })).toBeInTheDocument();
    // Enter on the row closes it again (a native button: Enter and Space click it).
    act(() => main.focus());
    await userEvent.keyboard('{Enter}');
    expect(line.querySelector('.pl-open')).toBeNull();
    fireEvent.click(main);
    // D210: the way into Bank is an entry of the account list, never an account.
    fireEvent.click(within(line.querySelector('.pl-open') as HTMLElement).getByRole('combobox', { name: 'Konto' }));
    fireEvent.click(await screen.findByRole('option', { name: 'In Bank öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/bank?line=btx_a1'));
  });

  it('three icons named with one word each on a bank booking, two on any other Vorschlag; no overflow menu anywhere', async () => {
    renderHub({ attention_list: ok(groupedOf([A1, vatVorschlag('v1')], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [BANK_LINE] }) });
    await automateButton();
    const bank = document.querySelector('[data-section="bank"] .pl') as HTMLElement;
    const other = document.querySelector('[data-section="other"] .pl') as HTMLElement;
    const names = (el: HTMLElement) => [...el.querySelectorAll('.pl-acts [data-icon]')].map((b) => b.getAttribute('aria-label'));
    // D210: one trio in reading order, the act last.
    expect(names(bank)).toEqual(['Ablehnen', 'Freigeben und als Regel speichern', 'Freigeben']);
    expect(names(other)).toEqual(['Ablehnen', 'Freigeben']);
    // Each hover says its name and nothing else.
    for (const button of bank.querySelectorAll<HTMLElement>('.pl-acts [data-icon]')) {
      expect(button.closest('.tooltip-wrap')?.querySelector('[role="tooltip"]')?.textContent).toBe(button.getAttribute('aria-label'));
    }
    expect(document.querySelector('.att-list .overflow-menu-trigger')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Zur Bankzeile|Referenz kopieren|Aufgabe erstellen/);
  });

  it('the third icon is a booking-to-accounts only: a line set aside carries two', async () => {
    const ignore = { ...BANK_LINE, actionTool: 'ignore_bank_line', payload: { bankTxnId: 'btx_a1', idempotencyKey: 'k' } };
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('a1', { subtitleParams: { tool: 'ignore_bank_line', date: '2026-11-07', targetKind: 'ignore' } })], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [ignore] }) });
    await screen.findByRole('button', { name: 'Freigeben' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('button', { name: 'Freigeben und als Regel speichern' })).toBeNull();
  });

  it('every Vorschlag row keeps the actions column, decisions or not, so date and amount stay on one edge', async () => {
    const noDecide: Capabilities = { ...ALLOW_ALL, can: (cap: string) => cap !== 'manage_agent_dial' };
    renderHub({ attention_list: ok(groupedOf([A1, bankVorschlag('a2')], { grouping: 'by_kind' })) }, noDecide);
    await screen.findByText('Beispiel Hosting AG');
    const vrows = [...document.querySelectorAll<HTMLElement>('.pl .pl-line')];
    expect(vrows).toHaveLength(2);
    // D208: the actions cell stays (empty of decisions without the right), so date and amount keep one edge.
    for (const r of vrows) expect(r.querySelector(':scope > .pl-acts')).not.toBeNull();
  });
});

describe('D210 critic r1 LOW: the way into Bank without the right to decide', () => {
  it('the account list is disabled, so the open line keeps Öffnen into the line in Bank', async () => {
    const noDecide: Capabilities = { ...ALLOW_ALL, can: (cap: string) => cap !== 'manage_agent_dial' };
    renderHub({ attention_list: ok(groupedOf([A1], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [BANK_LINE] }) }, noDecide);
    await screen.findByText('Beispiel Hosting AG');
    const line = document.querySelector('.pl') as HTMLElement;
    fireEvent.click(line.querySelector('button.pl-main') as HTMLElement);
    const open = line.querySelector('.pl-open') as HTMLElement;
    const combo = within(open).getByRole('combobox', { name: 'Konto' });
    expect(combo.hasAttribute('disabled') || combo.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(within(open).getByRole('button', { name: 'Öffnen' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/bank?line=btx_a1'));
  });
});

describe('D207: Freigeben und künftig automatisch, one click', () => {
  it('approves first, then saves the rule from the booked line; Rückgängig removes exactly that rule and reverses nothing', async () => {
    const { canned } = bookingWorld();
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    const writes = calls.filter((c) => ['approve_drafted_action', 'set_bank_standard', 'clear_bank_standard', 'reopen_bank_line'].includes(c.action));
    expect(writes.map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']);
    expect(writes[0]?.input).toEqual({ workspaceId: 'ws_test', actionId: 'a1' });
    // Critic F1: the line gives the counterparty; the legs are the APPROVED Vorschlag's, sent explicitly.
    expect(writes[1]?.input).toMatchObject({ workspaceId: 'ws_test', fromBankTxnId: 'btx_a1', legs: [{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' } }] });
    // Critic F3: the slot was read empty before booking, and the save pins that.
    expect(writes[1]?.input.expectSlotStandardId).toBeNull();
    expect(calls.findIndex((c) => c.action === 'list_bank_inbox')).toBeLessThan(calls.findIndex((c) => c.action === 'approve_drafted_action'));
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    expect(await screen.findByText('Regel entfernt. Die Buchung bleibt.')).toBeInTheDocument();
    const after = calls.filter((c) => ['clear_bank_standard', 'reopen_bank_line', 'reverse_entry'].includes(c.action));
    expect(after.map((c) => c.action)).toEqual(['clear_bank_standard']);
    expect(after[0]?.input).toMatchObject({ workspaceId: 'ws_test', standardId: 'std_1' });
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
  });

  it('the approved MWST code is the rule\'s code (critic F1): a coded single leg sends that code, never a re-read', async () => {
    const coded = { ...BANK_LINE, payload: { ...(BANK_LINE.payload as Record<string, unknown>), target: { kind: 'accounts', legs: [{ accountId: 'acc_51', amountMinor: -4275, taxCode: 'VST-M' }] } } };
    const { canned } = bookingWorld({ list_drafted_actions: ok({ actions: [coded] }) });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input.legs).toEqual([{ accountId: 'acc_51', taxCode: 'VST-M', amount: { kind: 'rest' } }]);
  });

  for (const [name, legs] of [
    ['one account under two codes', [{ accountId: 'acc_51', amountMinor: -2565, taxCode: 'VST-M' }, { accountId: 'acc_51', amountMinor: -1710, taxCode: 'VST-M26' }]],
    ['an account with a coded and an uncoded part', [{ accountId: 'acc_51', amountMinor: -1283, taxCode: 'VST-M' }, { accountId: 'acc_51', amountMinor: -2992 }]],
    ['two accounts', [{ accountId: 'acc_51', amountMinor: -2275 }, { accountId: 'acc_50', amountMinor: -2000 }]],
  ] as const) {
    it(`a split (${name}) carries no third icon: Freigeben only (critic F1)`, async () => {
      const split = { ...BANK_LINE, payload: { ...(BANK_LINE.payload as Record<string, unknown>), target: { kind: 'accounts', legs } } };
      renderHub({ attention_list: ok(groupedOf([A1], { grouping: 'by_kind' })), list_drafted_actions: ok({ actions: [split] }) });
      await screen.findByRole('button', { name: 'Freigeben' });
      await settle();
      expect(screen.queryByRole('button', { name: 'Freigeben und als Regel speichern' })).toBeNull();
    });
  }

  it('a retry after a rebooking sends the SAME approved legs, never a bare re-read of the booking (critic F1)', async () => {
    let attempts = 0;
    const { canned } = bookingWorld({
      set_bank_standard: () => {
        attempts += 1;
        return attempts === 1 ? refuse('period_locked') : ok({ standard: { id: 'std_3' }, supersededId: null, unchanged: false });
      },
    });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    const row = (await screen.findByText(/Gebucht\. Regel nicht gespeichert/)).closest('[data-rule-retry]') as HTMLElement;
    // Meanwhile the line is rebooked elsewhere; the retry still saves what the person approved.
    fireEvent.click(within(row).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    const saves = calls.filter((c) => c.action === 'set_bank_standard');
    expect(saves).toHaveLength(2);
    for (const save of saves) expect(save.input.legs).toEqual([{ accountId: 'acc_51', taxCode: null, amount: { kind: 'rest' } }]);
  });

  it('one key per click (critic F5): a save whose answer was lost, retried, answers its real outcome with Rückgängig', async () => {
    let attempts = 0;
    const { canned } = bookingWorld({
      set_bank_standard: () => {
        attempts += 1;
        // The first save ran, but its answer never arrived; the replay under the same key answers it.
        return attempts === 1 ? { status: 0, body: { ok: false, error: 'transport_error' } } : ok({ standard: { id: 'std_1' }, supersededId: null, unchanged: false });
      },
    });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    const row = (await screen.findByText(/Gebucht\. Regel nicht gespeichert/)).closest('[data-rule-retry]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rückgängig' })).toBeInTheDocument();
    const keys = calls.filter((c) => c.action === 'set_bank_standard').map((c) => c.input.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(String(keys[0])).toMatch(/^d207-rule:btx_a1:/);
  });

  it('a rule that does not save is said honestly in Bankbuchungen with its retry; the retry saves it', async () => {
    let attempts = 0;
    const { canned } = bookingWorld({
      set_bank_standard: () => {
        attempts += 1;
        return attempts === 1 ? refuse('no_counterparty') : ok({ standard: { id: 'std_2' }, supersededId: null, unchanged: false });
      },
    });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    const said = await screen.findByText('Gebucht. Regel nicht gespeichert: Die Bankzeile nennt keine Gegenpartei.');
    const row = said.closest('[data-rule-retry]') as HTMLElement;
    expect(row.closest('[data-section="bank"]')).not.toBeNull();
    // Never pretended: no "Regel gespeichert" anywhere.
    expect(screen.queryByText('Gebucht. Regel gespeichert.')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    expect(document.querySelector('[data-rule-retry]')).toBeNull();
    // The booking was approved once; only the rule was tried again.
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'set_bank_standard')).toHaveLength(2);
  });

  it('an approval that refuses saves no rule', async () => {
    const { canned } = bookingWorld({ approve_drafted_action: refuse('period_locked') });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    await waitFor(() => expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls.filter((c) => c.action === 'set_bank_standard')).toHaveLength(0);
    expect(screen.queryByText(/Regel gespeichert|Regel nicht gespeichert/)).toBeNull();
  });

  it('the same rule already there: said so, and no Rückgängig (it would remove a rule this click did not make)', async () => {
    const { canned } = bookingWorld({ set_bank_standard: ok({ standard: { id: 'std_old' }, supersededId: null, unchanged: true }) });
    renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByText('Gebucht. Die Regel gab es schon.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
  });

  it('attention.auto_rule_confirm = always: the rule shows in the opened row first; the second click runs the same path', async () => {
    const { canned } = bookingWorld({ settings_get: ok({ setting: { key: 'attention.auto_rule_confirm', value: 'always' } }) });
    const { calls } = renderHub(canned);
    await screen.findByText('Beispiel Hosting AG');
    await waitFor(() => expect(calls.some((c) => c.action === 'settings_get' && c.input.key === 'attention.auto_rule_confirm')).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.click(await readyAutomate());
    const confirm = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(confirm.textContent).toContain('Regel: Beispiel Hosting AG auf 6570 Informatik, Software und Lizenzen, MWST wie hier');
    expect(confirm.closest('.pl-open')).not.toBeNull();
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action)).map((c) => c.action)).toEqual(['approve_drafted_action', 'set_bank_standard']);
  });

  it('fails closed (critic F2): a click before the setting read lands shows the confirm and books nothing', async () => {
    const { canned } = bookingWorld({ settings_get: () => new Promise<RestResponse>(() => undefined) });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeInTheDocument();
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action))).toHaveLength(0);
  });

  it('fails closed (critic F2): a refused setting read shows the confirm and books nothing', async () => {
    const { canned } = bookingWorld({ settings_get: refuse('permission_denied') });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeInTheDocument();
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action))).toHaveLength(0);
  });

  it('a rule already in the slot is ALWAYS confirmed by name (setting never) and pinned (critic F3)', async () => {
    const { canned } = bookingWorld({
      list_bank_inbox: ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: ['std_text', 'std_old'] }] }),
      list_bank_standards: ok({
        standards: [
          { id: 'std_text', label: null, outcome: 'legs', matchText: 'ABO', accountNumber: '6500', accountName: 'Verwaltung', taxCode: null },
          { id: 'std_old', label: null, outcome: 'ignore', matchText: null, accountNumber: null, accountName: null, taxCode: null },
        ],
      }),
    });
    const { calls } = renderHub(canned);
    // D208: the star names the rule it replaces before the click.
    const star = await screen.findByRole('button', { name: 'Freigeben, ersetzt Regel «Nicht buchen»' });
    await settle();
    fireEvent.click(star);
    const confirm = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(confirm.textContent).toContain('Ersetzt die bestehende Regel: Nicht buchen.');
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action))).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    expect(await screen.findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'set_bank_standard')?.input.expectSlotStandardId).toBe('std_old');
  });

  it('a slot that changed after the person saw it is refused and said so; a slot that cannot be read books nothing (critic F3)', async () => {
    const changed = bookingWorld({ set_bank_standard: refuse('rule_slot_changed') });
    renderHub(changed.canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByText('Gebucht. Regel nicht gespeichert: Die Regel dieser Gegenpartei wurde inzwischen geändert.')).toBeInTheDocument();
  });

  it('after rule_slot_changed, Erneut versuchen reads the slot again and asks to confirm the rule standing there now (re-check LOW 1)', async () => {
    let reads = 0;
    let saves = 0;
    const { canned } = bookingWorld({
      // Empty when the person clicked; a rule appeared before the save ran.
      // D208: the list's own read of the open lines (no bankTxnId) is not the slot read.
      list_bank_inbox: (input) => {
        if (input.bankTxnId === undefined) return ok({ lines: [] });
        reads += 1;
        return ok({ lines: [{ bankTxnId: 'btx_a1', ruleIds: reads === 1 ? [] : ['std_new'] }] });
      },
      list_bank_standards: ok({ standards: [{ id: 'std_new', label: 'Hosting neu', outcome: 'legs', matchText: null, accountNumber: '6570', accountName: 'Informatik', taxCode: null }] }),
      set_bank_standard: () => {
        saves += 1;
        return saves === 1 ? refuse('rule_slot_changed') : ok({ standard: { id: 'std_9' }, supersededId: 'std_new', unchanged: false });
      },
    });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    const row = (await screen.findByText(/inzwischen geändert/)).closest('[data-rule-retry]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Erneut versuchen' }));
    const confirm = await within(row).findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(confirm.textContent).toContain('Ersetzt die bestehende Regel: Hosting neu.');
    // Nothing is saved until the person confirms the rule now in the slot.
    expect(calls.filter((c) => c.action === 'set_bank_standard')).toHaveLength(1);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    expect(await screen.findByText('Gebucht. Die Regel ersetzt die bisherige.')).toBeInTheDocument();
    const sent = calls.filter((c) => c.action === 'set_bank_standard').map((c) => c.input);
    expect(sent.map((x) => x.expectSlotStandardId)).toEqual([null, 'std_new']);
    expect(sent[1]?.legs).toEqual(sent[0]?.legs);
    expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
    // The booking was approved once.
    expect(calls.filter((c) => c.action === 'approve_drafted_action')).toHaveLength(1);
  });

  it('a slot read that fails books nothing (critic F3)', async () => {
    const { canned } = bookingWorld({ list_bank_inbox: refuse('internal_error') });
    const { calls } = renderHub(canned);
    fireEvent.click(await readyAutomate());
    expect(await screen.findByText('Die bestehende Regel liess sich nicht lesen. Gebucht wurde nichts.')).toBeInTheDocument();
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action))).toHaveLength(0);
  });

  it('a rule save still running does not lock the next workspace (critic F4)', async () => {
    let switchTo: (id: string) => void = () => undefined;
    function Switcher() {
      const { setWorkspaceId } = useWorkspace();
      switchTo = (id: string) => setWorkspaceId(id);
      return null;
    }
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { canned } = bookingWorld({
      attention_list: ok(groupedOf([A1], { grouping: 'by_kind' })),
      set_bank_standard: async (input) => {
        if (input.workspaceId === 'ws_a') await gate;
        return ok({ standard: { id: 'std_1' }, supersededId: null, unchanged: false });
      },
    });
    const calls: Call[] = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
      const entry = canned[action];
      if (entry === undefined) return { status: 200, body: { ok: true } };
      return typeof entry === 'function' ? await entry((input ?? {}) as Record<string, unknown>) : entry;
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <MemoryRouter initialEntries={['/attention']}>
              <Switcher />
              <Attention />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    fireEvent.click(await readyAutomate());
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard' && c.input.workspaceId === 'ws_a')).toBe(true));
    act(() => switchTo('ws_b'));
    await waitFor(() => expect(calls.some((c) => c.action === 'attention_list' && c.input.workspaceId === 'ws_b')).toBe(true));
    fireEvent.click(await readyAutomate());
    await waitFor(() => expect(calls.some((c) => c.action === 'list_bank_inbox' && c.input.workspaceId === 'ws_b')).toBe(true));
    await act(async () => {
      release();
      await gate;
    });
  });

  it('Abbrechen on the rule confirm sends nothing', async () => {
    const { canned } = bookingWorld({ settings_get: ok({ setting: { key: 'attention.auto_rule_confirm', value: 'always' } }) });
    const { calls } = renderHub(canned);
    await screen.findByText('Beispiel Hosting AG');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.click(await readyAutomate());
    const confirm = await screen.findByRole('group', { name: 'Freigeben und künftig automatisch' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('group', { name: 'Freigeben und künftig automatisch' })).toBeNull();
    expect(calls.filter((c) => ['approve_drafted_action', 'set_bank_standard'].includes(c.action))).toHaveLength(0);
  });
});
