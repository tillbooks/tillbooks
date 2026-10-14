/**
 * Critic round 4 (fresh non-author critic of the D152 rebuild), Studio probes.
 *
 * R4-S1: "MWST neu berechnen" replaces EVERY row with the derived grid `decompose` produced at REOPEN time,
 * so an edit the person made on the verbatim (manual) grid before pressing it is silently reverted: an
 * account they changed, an amount they corrected. The button promises to recalculate the VAT from the gross
 * amounts; it also rewrites lines the person did not ask to change, and the gross it uses is the STORED
 * one, not the one on screen.
 *
 * The button is gone (orchestrator, 02.10.2026: after R6-V no real engine state reached it). What these
 * cases still hold is the R4-S1 guarantee that outlives it: after an edit on the verbatim grid, what the
 * engine judges and what posts is exactly what is on screen.
 *
 * `compose_entry` is answered by the real engine (`app/test-support/composeEngine.ts`). Every account and
 * figure is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { EntryDrawer } from './EntryDrawer';
import type { DrawerMode } from './types';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { ALLOW_ALL, CapabilitiesContext } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { cannedOk, recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

const DEFAULTS: Record<string, string> = { '6500': 'VST-M', '3400': 'UST81', '1500': 'VST-I' };
const CHART = listAccountsFixture.accounts.map((a) => ({ ...a, vatCodeDefault: DEFAULTS[a.number] ?? a.vatCodeDefault }));
const id = (number: string): string => {
  const row = CHART.find((a) => a.number === number);
  if (row === undefined) throw new Error(`no account ${number}`);
  return row.id;
};
const CODES = [
  { code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material', active: true },
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true },
];
const READS: Handlers = {
  list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: CHART }) },
  vat_codes: { status: 200, body: { ok: true, taxCodes: CODES } },
  list_cost_centers: { status: 200, body: { ok: true, costCenters: [] } },
  get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
  compose_entry: composeEngine(),
  post_entry: () => cannedOk('post_entry', { ok: true, entryId: 'je_d' }),
};

async function openDrawer(extra: Handlers, opts: { mode: DrawerMode; entryId: string }) {
  const handlers = { ...READS, ...extra };
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = handlers[action];
    if (h === undefined && action === 'files_list_linked') return { status: 200, body: { ok: true, files: [] } };
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <CapabilitiesContext.Provider value={ALLOW_ALL}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <EntryDrawer mode={opts.mode} entryId={opts.entryId} canPost onClose={vi.fn()} onWritten={vi.fn()} />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </CapabilitiesContext.Provider>
    </TillClientProvider>,
  );
  return { dialog: await screen.findByRole('dialog'), calls };
}

async function pickAccount(field: HTMLElement, number: string) {
  await userEvent.clear(field);
  await userEvent.type(field, number);
  await userEvent.keyboard('{Enter}');
}

const postButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Post' });

describe('R4-S1: an edit on the verbatim grid is what the engine judges and what posts', () => {
  // Once the person has changed anything, the gate's refusal stands over what they typed, and nothing posts
  // that they did not put on screen.
  const entry = { id: 'je_d', date: '2026-09-30', ref: null, description: 'Papier', status: 'draft', source: 'agent', reversesEntryId: null };
  // The author's own non-round-tripping agent three-liner (a coded line without a trace).
  const lines = [
    { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M' },
    { id: 'l2', account: id('1170'), debit: 807, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];
  const unreconciled = /The VAT does not reconcile/;

  // Adjusted for critic R6-V (02.10.2026): the untouched 6500 line now keeps the date that priced it
  // (30.09.2026, the stored entry date) when the booking date moves, so the gate no longer refuses the move.
  // What stays asserted is the R4-S1 guarantee: what posts is what is on screen (1000, never the stored 1020).
  it('the person moves the payment from 1020 to 1000 Kasse and the date into 2023: 1020 is never posted', async () => {
    const { dialog, calls } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines } } }, { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 3');
    // The person pays from the cash box, not the bank: an edit on an untaxed line.
    await pickAccount(within(dialog).getByLabelText('Account 3'), '1000');
    // ...and the booking belongs to 2023. The 6500 line keeps its 8.1% Leistungsdatum, so the gate takes it.
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-06-30' } });
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input;
      expect(asked?.date).toBe('2023-06-30');
    });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    expect(within(dialog).queryByText(unreconciled)).toBeNull();
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    // What is on screen is what posts: 1000, never the stored 1020; the untouched line at its kept date.
    const posted = calls.filter((c) => c.action === 'post_entry').at(-1)?.input.lines as { account: string; credit?: number; taxCode?: string; supplyDate?: string; taxAmount?: number }[];
    expect(posted.find((l) => (l.credit ?? 0) > 0)?.account).toBe(id('1000'));
    expect(posted.some((l) => l.account === id('1020'))).toBe(false);
    expect(posted.find((l) => l.taxCode === 'VST-M')).toMatchObject({ supplyDate: '2026-09-30', taxAmount: 807 });
  });

  it('the person corrects the amounts on the verbatim grid: the refusal stands over them, and the corrected amounts stay', async () => {
    const { dialog, calls } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines } } }, { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 3');
    await userEvent.clear(within(dialog).getByLabelText('Debit 1'));
    await userEvent.type(within(dialog).getByLabelText('Debit 1'), '120.00');
    await userEvent.clear(within(dialog).getByLabelText('Credit 3'));
    await userEvent.type(within(dialog).getByLabelText('Credit 3'), '128.07');
    // The gate refuses (8.07 booked against the 9.72 the corrected net prices) and says so; nothing falls
    // back to the stored 107.70, and Buchen holds.
    expect(await within(dialog).findByText(unreconciled)).toBeInTheDocument();
    expect(postButton(dialog)).toBeDisabled();
    expect(within(dialog).getByLabelText('Debit 1')).toHaveValue('120.00');
    expect(within(dialog).getByLabelText('Credit 3')).toHaveValue('128.07');
    expect(calls.some((c) => c.action === 'post_entry')).toBe(false);
  });

  // Adjusted for critic R6-V (02.10.2026): the date move no longer re-prices the untouched 6500 line, so the
  // gate takes it. The R4-S1 guarantee stands: the undone edit is still an edit, and the re-typed row posts
  // as it is shown.
  it('an edit undone by hand is still an edit: the row is sent as it is shown', async () => {
    const { dialog, calls } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines } } }, { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 3');
    await pickAccount(within(dialog).getByLabelText('Account 3'), '1000');
    await pickAccount(within(dialog).getByLabelText('Account 3'), '1020');
    // On its own date the gate takes it: the untouched 6500 line still goes back verbatim, the re-typed
    // 1020 line as shown (it carries no trace either way).
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-06-30' } });
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input;
      expect(asked?.date).toBe('2023-06-30');
    });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = calls.filter((c) => c.action === 'post_entry').at(-1)?.input.lines as Record<string, unknown>[];
    expect(posted.find((l) => l.account === id('1020'))).toEqual({ account: id('1020'), credit: 10770 });
    expect(posted.find((l) => l.taxCode === 'VST-M')).toMatchObject({ supplyDate: '2026-09-30', taxAmount: 807 });
  });

});

describe('R4-S2: out-of-order compose_entry answers never enable Buchen for other content', () => {
  async function satz(dialog: HTMLElement, debit: string, credit: string, amount: string) {
    await pickAccount(await within(dialog).findByLabelText('Debit'), debit);
    await pickAccount(within(dialog).getByLabelText('Credit'), credit);
    await userEvent.type(within(dialog).getByLabelText('Amount'), amount);
  }

  for (const order of ['older answer arrives LAST', 'older answer arrives FIRST'] as const) {
    it(`${order}: the post carries the lines composed for what is on screen`, async () => {
      const engine = composeEngine();
      const pending: { input: Record<string, unknown>; release: () => void }[] = [];
      const { dialog, calls } = await openDrawer(
        {
          compose_entry: (input) =>
            new Promise<RestResponse>((resolve) => {
              pending.push({ input, release: () => resolve(engine(input)) });
            }),
        },
        { mode: 'create', entryId: undefined as unknown as string },
      );
      const amountOf = (p: { input: Record<string, unknown> }) => (p.input.lines as { amount?: number }[])[0]?.amount;
      await satz(dialog, '6500', '1020', '10.00');
      await waitFor(() => expect(pending.some((p) => amountOf(p) === 1000)).toBe(true));
      await userEvent.clear(within(dialog).getByLabelText('Amount'));
      await userEvent.type(within(dialog).getByLabelText('Amount'), '20.00');
      await waitFor(() => expect(pending.some((p) => amountOf(p) === 2000)).toBe(true));
      const older = pending.find((p) => amountOf(p) === 1000) as (typeof pending)[number];
      const newer = pending.find((p) => amountOf(p) === 2000) as (typeof pending)[number];
      if (order === 'older answer arrives FIRST') {
        older.release();
        await new Promise((r) => setTimeout(r, 50));
        expect(postButton(dialog)).toBeDisabled();
        newer.release();
      } else {
        newer.release();
        await waitFor(() => expect(postButton(dialog)).toBeEnabled());
        older.release();
        await new Promise((r) => setTimeout(r, 50));
      }
      await waitFor(() => expect(postButton(dialog)).toBeEnabled());
      await userEvent.click(postButton(dialog));
      await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
      const posted = calls.filter((c) => c.action === 'post_entry').at(-1)?.input as { lines: { debit?: number; credit?: number }[] };
      expect(posted.lines.reduce((s, l) => s + (l.debit ?? 0), 0)).toBe(2000);
    });
  }
});
