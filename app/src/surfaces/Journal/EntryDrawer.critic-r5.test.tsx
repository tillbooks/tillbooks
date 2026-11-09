/**
 * Critic round 5 probes on the supply-date rule (owner 02.10.2026, keep the stored Leistungsdatum). Every
 * account and figure is synthetic. `compose_entry` is answered by the real engine.
 *
 * R5-S1: a SAVED taxed line that stored no supply date (an agent Vorschlag) was priced at its stored ENTRY
 * date, which A06 and A07 read as its Leistungsdatum (`supply_date ?? date`). Moving the booking date (the
 * period-lock way out) must not re-price it either: the owner's rule names the Vorschlag explicitly.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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

const DEFAULTS: Record<string, string> = { '6500': 'VST-M' };
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

const postButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Post' });
type PostedLine = { account: string; debit?: number; credit?: number; taxCode?: string; taxBase?: number; taxAmount?: number; supplyDate?: string };
const postedOf = (calls: { action: string; input: Record<string, unknown> }[]) =>
  calls.filter((c) => c.action === 'post_entry').at(-1)?.input as { date: string; lines: PostedLine[] };

describe('R5-S1: a saved Vorschlag line that stored NO supply date keeps the rate of the date that priced it', () => {
  // An agent's December 2023 Vorschlag: 107.70 gross VST-M at 7.7% (net 100.00, tax 7.70), with no supply date,
  // so its stored ENTRY date 15.12.2023 is the date that priced it (and the one A07 reads).
  const entry = { id: 'je_v', date: '2023-12-15', ref: null, description: 'Papier', status: 'draft', source: 'agent', reversesEntryId: null };

  it('traced (round-trips, reopens as the satz): the way out into 2024 must keep 7.70 at 7.7%', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770 },
      { id: 'l2', account: id('1170'), debit: 770, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_v' },
    );
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2024-01-01');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = postedOf(calls);
    const taxed = posted.lines.find((l) => l.taxCode === 'VST-M') as PostedLine;
    // The Leistungsdatum that priced the saved line was 15.12.2023; the rate and the Ziffer follow it.
    expect({ priced: taxed.supplyDate ?? posted.date, tax: taxed.taxAmount }).toEqual({ priced: '2023-12-15', tax: 770 });
  });

  // Adjusted for critic R6-V (02.10.2026): the verbatim line now goes out as stored plus the date that priced
  // it, so the way out no longer makes the gate refuse it and no recompute is needed. The critic's claim is
  // unchanged: it posts 7.70 at 7.7%, priced on 15.12.2023.
  it('untraced (verbatim): the way out keeps 7.70 at 7.7% without a recompute', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M' },
      { id: 'l2', account: id('1170'), debit: 770, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_v' },
    );
    await within(dialog).findByLabelText('Account 3');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2024-01-01');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = postedOf(calls);
    const taxed = posted.lines.find((l) => l.taxCode === 'VST-M') as PostedLine;
    expect({ priced: taxed.supplyDate ?? posted.date, tax: taxed.taxAmount }).toEqual({ priced: '2023-12-15', tax: 770 });
  });
});

