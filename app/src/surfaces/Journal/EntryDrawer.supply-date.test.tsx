/**
 * Owner, 02.10.2026: KEEP THE STORED LEISTUNGSDATUM. Swiss MWST takes the rate from the supply date, not the
 * booking date. Before the first save a taxed line follows the date the person types; once saved (a draft, a
 * Vorschlag, a reopened posted entry) it keeps its stored Leistungsdatum, and so its rate, when the booking
 * date moves, the period-lock way out included. The row says "Leistungsdatum ..." only while it differs from
 * the booking date.
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

const DEFAULTS: Record<string, string> = { '6500': 'VST-M', '6570': 'VST-M' };
const CHART = listAccountsFixture.accounts.map((a) => ({ ...a, vatCodeDefault: DEFAULTS[a.number] ?? a.vatCodeDefault }));
const id = (number: string): string => {
  const row = CHART.find((a) => a.number === number);
  if (row === undefined) throw new Error(`no account ${number}`);
  return row.id;
};
const CODES = [{ code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material', active: true }];

async function openDrawer(extra: Handlers, opts: { mode: DrawerMode; entryId?: string }) {
  const handlers: Handlers = {
    list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: CHART }) },
    vat_codes: { status: 200, body: { ok: true, taxCodes: CODES } },
    list_cost_centers: { status: 200, body: { ok: true, costCenters: [] } },
    get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
    compose_entry: composeEngine(),
    post_entry: () => cannedOk('post_entry', { ok: true, entryId: 'je_ld' }),
    ...extra,
  };
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
              <EntryDrawer mode={opts.mode} entryId={opts.entryId as string} canPost onClose={vi.fn()} onWritten={vi.fn()} />
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
type PostedLine = { account: string; debit?: number; credit?: number; taxCode?: string; taxBase?: number; taxAmount?: number; supplyDate?: string };
const postedOf = (calls: { action: string; input: Record<string, unknown> }[]) =>
  calls.filter((c) => c.action === 'post_entry').at(-1)?.input as { date: string; lines: PostedLine[] };

describe('a SAVED taxed line keeps its stored Leistungsdatum when the booking date moves', () => {
  // A December 2023 draft as the composer saved it: 107.70 gross VST-M at 7.7%, supply date 15.12.2023.
  const entry = { id: 'je_ld', date: '2023-12-15', ref: null, description: 'Papier', status: 'draft', source: 'manual', reversesEntryId: null };
  const lines = [
    { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
    { id: 'l2', account: id('1170'), debit: 770, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];

  it('moved past a locked December by the way out, it posts with 15.12.2023 and the 7.7% figures, and says so under the row', async () => {
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_ld' },
    );
    // It reopens as the Buchungssatz; on its own date the supply date is not worth a caption.
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    expect(await within(dialog).findByText('This period is locked.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Supply date/)).toBeNull();
    // The way out: the booking date moves to the first open day, the lines are kept.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change the booking date' }));
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2024-01-01');
    expect(await within(dialog).findByText(/^Supply date 15\.12\.2023$/)).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = postedOf(calls);
    expect(posted.date).toBe('2024-01-01');
    expect(posted.lines.find((l) => l.taxCode === 'VST-M')).toEqual({
      account: id('6500'), debit: 10000, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15',
    });
    expect(posted.lines.find((l) => l.account === id('1170'))?.debit).toBe(770);
  });
});

describe('a saved line that stated NO Leistungsdatum keeps the stored entry date that priced it (critic R5-S1)', () => {
  const entry = { id: 'je_v', date: '2023-12-15', ref: null, description: 'Papier', status: 'draft', source: 'agent', reversesEntryId: null };
  const lines = [
    { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770 },
    { id: 'l2', account: id('1170'), debit: 770, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];

  it('on its own date it states none and shows no caption; moved, it says "Supply date 15.12.2023" and posts it', async () => {
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_v' },
    );
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    expect(await within(dialog).findByText('This period is locked.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Supply date/)).toBeNull();
    // On its own date the request is the Vorschlag as stored: no supply date written down.
    const onItsDate = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input.lines as { taxCode?: string; supplyDate?: string }[];
    expect(onItsDate.find((l) => l.taxCode === 'VST-M')?.supplyDate).toBeUndefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change the booking date' }));
    expect(await within(dialog).findByText(/^Supply date 15\.12\.2023$/)).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expect(postedOf(calls).lines.find((l) => l.taxCode === 'VST-M')).toEqual({
      account: id('6500'), debit: 10000, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15',
    });
  });
});

describe('critic R5 L-a: correcting a saved line\'s ACCOUNT keeps its Leistungsdatum', () => {
  const entry = { id: 'je_ld', date: '2023-12-15', ref: null, description: 'Papier', status: 'draft', source: 'manual', reversesEntryId: null };
  const expectKept = (calls: { action: string; input: Record<string, unknown> }[]) =>
    expect(postedOf(calls).lines.find((l) => l.taxCode === 'VST-M')).toEqual({
      account: id('6570'), debit: 10000, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15',
    });

  it('the satz: moved into 2024, then 6500 corrected to 6570, it still posts at 7.7% on 15.12.2023', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
      { id: 'l2', account: id('1170'), debit: 770, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_ld' },
    );
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    await pickAccount(within(dialog).getByLabelText('Debit'), '6570');
    expect(await within(dialog).findByText(/^Supply date 15\.12\.2023$/)).toBeInTheDocument();
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input.lines as { account: string }[];
      expect(asked.some((l) => l.account === id('6570'))).toBe(true);
    });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expectKept(calls);
  });

  it('the grid: an Aufteilen draft moved into 2024, then row 1 corrected to 6570, still posts at 7.7% on 15.12.2023', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
      { id: 'l2', account: id('6000'), debit: 1000, credit: null },
      { id: 'l3', account: id('1170'), debit: 770, credit: null },
      { id: 'l4', account: id('1020'), debit: null, credit: 11770 },
    ];
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_ld' },
    );
    await within(dialog).findByLabelText('Account 3');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    await pickAccount(within(dialog).getByLabelText('Account 1'), '6570');
    expect(await within(dialog).findByText(/^Supply date 15\.12\.2023$/)).toBeInTheDocument();
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input.lines as { account: string }[];
      expect(asked.some((l) => l.account === id('6570'))).toBe(true);
    });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expectKept(calls);
  });
});

describe('an UNSAVED satz follows the date the person types', () => {
  it('typed on 15.12.2023 and moved to 10.01.2024 before saving, it is priced at 8.1% on 10.01.2024', async () => {
    const { dialog, calls } = await openDrawer({}, { mode: 'create' });
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-12-15' } });
    await pickAccount(await within(dialog).findByLabelText('Debit'), '6500');
    await pickAccount(within(dialog).getByLabelText('Credit'), '1020');
    await userEvent.type(within(dialog).getByLabelText('Amount'), '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2024-01-10' } });
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input;
      expect(asked?.date).toBe('2024-01-10');
    });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    expect(within(dialog).queryByText(/^Supply date/)).toBeNull();
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = postedOf(calls);
    expect(posted.date).toBe('2024-01-10');
    expect(posted.lines.find((l) => l.taxCode === 'VST-M')).toEqual({
      account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2024-01-10',
    });
  });
});
