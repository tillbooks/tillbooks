/**
 * D207 on the Übersicht (owner, 16.11.2026): the suggestions card behaves exactly like Pendenzen. A row click
 * opens its details below; three icons, one word each; no overflow menu; "Freigeben und künftig automatisch"
 * approves, then saves the Buchungsregel from the booked line, with Rückgängig, and a rule that did not save is
 * said with its retry. And the account names resolve with the card sheet open, also for a leg named by its
 * account NUMBER (the owner saw "Konto" there). Every name and amount is invented; the accounts are the pinned
 * `list_accounts` recording.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { Uebersicht } from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

beforeEach(() => {
  document.documentElement.setAttribute('data-motion', 'calm');
});

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refused = (error: string): RestResponse => ({ status: 409, body: { ok: false, error } });

/** A bank booking the agent proposes; `account` is how its leg names the account (an id or a number). */
const suggestion = (n: number, account = 'acc_51') => ({
  actionId: `va_${n}`,
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'book_bank_line',
  payload: { bankTxnId: `btx_${n}`, target: { kind: 'accounts', legs: [{ accountId: account, amountMinor: -(3100 + n) }] }, idempotencyKey: `k${n}` },
  agentReason: null,
  status: 'pending',
  createdAt: '2026-11-14T08:00:00.000Z',
  lineFacts: { date: '2026-11-12', counterparty: `Beispiel Lieferant ${n}`, text: `Lastschrift BEISPIEL ${n}`, amountMinor: -(3100 + n), currency: 'CHF' },
  evidence: { certainty: 'sure', reasons: ['agrees'] },
  batchable: true,
});

const canned = (actions: unknown[]): Canned => ({
  dashboard_overview: ok({
    workspaceId: 'ws_test',
    tiles: [{ tile: 'revenue', ok: true, valueRappen: 1_200_000, currency: 'CHF', range: { from: '2026-11-01', to: '2026-11-30' }, glyph: '◆', drill: { studioRoute: '/reports', mcpTool: 'aging_report', params: {} }, detail: {} }],
    omitted: [],
  }),
  list_saved_views: ok({ entityKind: 'workspace', savedViews: [] }),
  dashboard_series: ok({ months: [], topExpenses: [], otherExpensesMinor: 0, expenseTotalMinor: 0, currency: 'CHF', bankAccounts: 0 }),
  list_vendor_bills: ok({ bills: [], baseTotalOpenMinor: 0, baseCurrency: 'CHF' }),
  tasks_list: ok({ tasks: [], total: 0 }),
  list_accounts: ok(listAccountsFixture),
  list_drafted_actions: ok({ actions }),
  settings_get: ok({ setting: { key: 'attention.auto_rule_confirm', value: 'never' } }),
  list_bank_inbox: ((input: Record<string, unknown>) => ok({ lines: [{ bankTxnId: input.bankTxnId, ruleIds: [] }] })) as Handler,
  list_bank_standards: ok({ standards: [] }),
});

function renderSurface(c: Canned, path = '/overview'): { action: string; input: Record<string, unknown> }[] {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = c[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry((input ?? {}) as Record<string, unknown>) : entry;
  };
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <PrefsProvider store={new PrefsStore(null, null, { useCache: false })}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="*" element={<Uebersicht />} />
              </Routes>
            </MemoryRouter>
          </PrefsProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return calls;
}

const card = () => screen.findByRole('region', { name: 'Vorschläge' });
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

describe('D208: the suggestions card has no frame; its tools sit in its heading', () => {
  it('Ausblenden, Grösse ändern and Mehr are square glyphs in the heading (no pill over the card); Ausblenden takes the card off the page', async () => {
    renderSurface(canned([suggestion(1)]));
    const region = await card();
    expect(region).not.toHaveClass('panel');
    const tools = region.querySelector('.uebersicht-sugg__tools') as HTMLElement;
    expect(tools).not.toBeNull();
    expect(tools.closest('header')).not.toBeNull();
    const names = [...tools.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Ausblenden', 'Grösse ändern', 'Mehr zu Vorschläge']);
    // The item's own floating pill is not drawn over the card.
    expect(region.closest('[data-slot="suggestions"]')?.querySelector(':scope > .uebersicht-item__group > .uebersicht-tools')).toBeNull();
    fireEvent.click(within(tools).getByRole('button', { name: 'Ausblenden' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Vorschläge' })).toBeNull());
  });
});

describe('D207: the suggestions card behaves like Pendenzen', () => {
  it('a row click opens its details below; three icons, one word each; no overflow menu', async () => {
    renderSurface(canned([suggestion(1)]));
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    const line = region.querySelector('.pl') as HTMLElement;
    const names = [...line.querySelectorAll('.pl-acts [data-icon]')].map((b) => b.getAttribute('aria-label'));
    // D210: one trio in reading order, the act last.
    expect(names).toEqual(['Ablehnen', 'Freigeben und als Regel speichern', 'Freigeben']);
    for (const b of line.querySelectorAll<HTMLElement>('.pl-acts [data-icon]')) {
      expect(b.closest('.tooltip-wrap')?.querySelector('[role="tooltip"]')?.textContent).toBe(b.getAttribute('aria-label'));
    }
    // No overflow menu on a row (the card's own Mehr sits in its heading, D208).
    expect(region.querySelector('.uebersicht-sugg__list .overflow-menu-trigger')).toBeNull();
    // D208: the click opens ONE line beneath: the booking text, the account and the MWST code, no labels.
    expect(line.querySelector('.pl-open')).toBeNull();
    fireEvent.click(line.querySelector('button.pl-main') as HTMLElement);
    const open = line.querySelector('.pl-open') as HTMLElement;
    expect((within(open).getByRole('textbox', { name: 'Buchungstext' }) as HTMLInputElement).value).toBe('Bank: Beispiel Lieferant 1, Lastschrift BEISPIEL 1');
    await waitFor(() => expect(within(open).getByRole('combobox', { name: 'Konto' }).textContent ?? '').toContain('6570 Informatik, Software und Lizenzen'));
  });

  it('one click: approve, then the rule from the booked line; Rückgängig removes exactly that rule', async () => {
    const c = canned([suggestion(1)]);
    c.approve_drafted_action = ok({ status: 'executed' });
    c.set_bank_standard = ok({ standard: { id: 'std_9' }, supersededId: null, unchanged: false });
    c.clear_bank_standard = ok({});
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    await settle();
    fireEvent.click(within(region).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    expect(await within(region).findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
    const writes = calls.filter((x) => ['approve_drafted_action', 'set_bank_standard'].includes(x.action));
    expect(writes.map((x) => x.action)).toEqual(['approve_drafted_action', 'set_bank_standard']);
    expect(writes[1]?.input).toMatchObject({ workspaceId: 'ws_test', fromBankTxnId: 'btx_1' });
    fireEvent.click(within(region).getByRole('button', { name: 'Rückgängig' }));
    expect(await within(region).findByText('Regel entfernt. Die Buchung bleibt.')).toBeInTheDocument();
    expect(calls.filter((x) => x.action === 'clear_bank_standard').map((x) => x.input.standardId)).toEqual(['std_9']);
    expect(calls.some((x) => x.action === 'reopen_bank_line')).toBe(false);
  });

  it('a rule already in the slot is confirmed by name before anything is booked (critic F3)', async () => {
    const c = canned([suggestion(1)]);
    c.list_bank_inbox = ok({ lines: [{ bankTxnId: 'btx_1', ruleIds: ['std_old'] }] });
    c.list_bank_standards = ok({ standards: [{ id: 'std_old', label: 'Hosting fix', outcome: 'legs', matchText: null, accountNumber: '6570', accountName: 'Informatik', taxCode: null }] });
    c.approve_drafted_action = ok({ status: 'executed' });
    c.set_bank_standard = ok({ standard: { id: 'std_9' }, supersededId: 'std_old', unchanged: false });
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    // D208: the star names the rule it replaces before the click.
    fireEvent.click(await within(region).findByRole('button', { name: 'Freigeben, ersetzt Regel «Hosting fix»' }));
    const confirm = await within(region).findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(confirm.textContent).toContain('Ersetzt die bestehende Regel: Hosting fix.');
    expect(calls.some((x) => x.action === 'approve_drafted_action')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    expect(await within(region).findByText('Gebucht. Die Regel ersetzt die bisherige.')).toBeInTheDocument();
    expect(calls.find((x) => x.action === 'set_bank_standard')?.input.expectSlotStandardId).toBe('std_old');
  });

  it('after rule_slot_changed the retry re-reads the slot and asks to confirm the rule now standing (re-check LOW 1)', async () => {
    let reads = 0;
    let saves = 0;
    const c = canned([suggestion(1)]);
    c.list_bank_inbox = (input) => {
      // D208: the card's own read of the open lines (no bankTxnId) is not the slot read.
      if (input.bankTxnId === undefined) return ok({ lines: [] });
      reads += 1;
      return ok({ lines: [{ bankTxnId: 'btx_1', ruleIds: reads === 1 ? [] : ['std_new'] }] });
    };
    c.list_bank_standards = ok({ standards: [{ id: 'std_new', label: 'Lieferant neu', outcome: 'legs', matchText: null, accountNumber: '6570', accountName: 'Informatik', taxCode: null }] });
    c.approve_drafted_action = ok({ status: 'executed' });
    c.set_bank_standard = () => {
      saves += 1;
      return saves === 1 ? refused('rule_slot_changed') : ok({ standard: { id: 'std_9' }, supersededId: 'std_new', unchanged: false });
    };
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    fireEvent.click(within(region).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    await within(region).findByText(/inzwischen geändert/);
    fireEvent.click(within(region).getByRole('button', { name: 'Erneut versuchen' }));
    const confirm = await within(region).findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(confirm.textContent).toContain('Ersetzt die bestehende Regel: Lieferant neu.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    expect(await within(region).findByText('Gebucht. Die Regel ersetzt die bisherige.')).toBeInTheDocument();
    expect(calls.filter((x) => x.action === 'set_bank_standard').map((x) => x.input.expectSlotStandardId)).toEqual([null, 'std_new']);
  });

  it('a rule that does not save is said with its retry, never pretended', async () => {
    let n = 0;
    const c = canned([suggestion(1)]);
    c.approve_drafted_action = ok({ status: 'executed' });
    c.set_bank_standard = () => {
      n += 1;
      return n === 1 ? refused('not_booked_to_accounts') : ok({ standard: { id: 'std_9' }, supersededId: null, unchanged: false });
    };
    renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    await settle();
    fireEvent.click(within(region).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    expect(await within(region).findByText('Gebucht. Regel nicht gespeichert: Die Zeile ist nicht auf Konten gebucht.')).toBeInTheDocument();
    expect(within(region).queryByText('Gebucht. Regel gespeichert.')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(region).findByText('Gebucht. Regel gespeichert.')).toBeInTheDocument();
  });

  it('the account names resolve with the card sheet open, also for a leg named by its number', async () => {
    renderSurface(canned([suggestion(1, '6570')]), '/overview/kennzahlen');
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    // The row face says the account in words, never the fallback "Konto".
    await waitFor(() => expect(region.querySelector('[data-figure="key"]')?.textContent ?? '').toContain('6570 Informatik, Software und Lizenzen'));
    expect(region.querySelector('[data-figure="key"]')?.textContent ?? '').not.toMatch(/\bKonto\b/);
  });
});

describe('critic D208 MEDIUM-1 on the card: the open line\'s star never replaces a rule the person was not shown', () => {
  it('a rule saved after the card loaded: nothing is booked until the person confirms it by name, then the save is pinned to it', async () => {
    const OLD = { id: 'std_9', label: 'Lieferant alt', counterpartyLabel: 'Beispiel Lieferant 1', matchText: null, setAt: '2026-09-01T08:00:00.000Z', outcome: 'legs', note: null, legs: [{ accountId: 'acc_50', taxCode: null, amount: { kind: 'rest' } }] };
    const c: Canned = {
      ...canned([suggestion(1)]),
      // The card's list read shows an empty slot; the click-time read finds the rule.
      list_bank_inbox: ((input: Record<string, unknown>) => ok({ lines: [{ bankTxnId: 'btx_1', ruleIds: input.bankTxnId !== undefined ? ['std_9'] : [] }] })) as Handler,
      list_bank_standards: ok({ standards: [OLD] }),
      approve_drafted_action: ok({ status: 'executed' }),
      set_bank_standard: ok({ standard: { id: 'std_10' }, supersededId: 'std_9', unchanged: false, noteChanged: false }),
    };
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    fireEvent.click(region.querySelector('.pl button.pl-main') as HTMLElement);
    const open = region.querySelector('.pl-open') as HTMLElement;
    // D210: the open line repeats no star; the row star is the star plus its commit.
    expect(within(open).queryByRole('button', { name: 'Als Regel speichern' })).toBeNull();
    fireEvent.click(within(region.querySelector('.pl .pl-acts') as HTMLElement).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    const ask = await within(region).findByRole('group', { name: 'Freigeben und künftig automatisch' });
    expect(ask.textContent).toContain('Lieferant alt');
    const writes = () => calls.filter((x) => ['approve_drafted_action', 'book_bank_line', 'set_bank_standard'].includes(x.action));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Freigeben und Regel speichern' }));
    await waitFor(() => expect(writes().map((x) => x.action)).toEqual(['approve_drafted_action', 'set_bank_standard']));
    expect(writes()[1]?.input).toMatchObject({ fromBankTxnId: 'btx_1', expectSlotStandardId: 'std_9', label: 'Lieferant alt' });
  });
});

describe('D210 (critic r1 MEDIUM-2 on the card): attention.auto_rule_confirm = always asks before the open row star', () => {
  it('the ask comes first and Abbrechen writes nothing', async () => {
    const c: Canned = {
      ...canned([suggestion(1)]),
      settings_get: ok({ setting: { key: 'attention.auto_rule_confirm', value: 'always' } }),
      approve_drafted_action: ok({ status: 'executed' }),
      set_bank_standard: ok({ standard: { id: 'std_10' }, supersededId: null, unchanged: false, noteChanged: false }),
    };
    const calls = renderSurface(c);
    const region = await card();
    await within(region).findByText('Beispiel Lieferant 1');
    await settle();
    fireEvent.click(region.querySelector('.pl button.pl-main') as HTMLElement);
    fireEvent.click(within(region.querySelector('.pl .pl-acts') as HTMLElement).getByRole('button', { name: 'Freigeben und als Regel speichern' }));
    const ask = await within(region).findByRole('group', { name: 'Freigeben und künftig automatisch' });
    const writes = () => calls.filter((x) => ['approve_drafted_action', 'book_bank_line', 'set_bank_standard'].includes(x.action));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }));
    await settle();
    expect(writes()).toHaveLength(0);
  });
});
