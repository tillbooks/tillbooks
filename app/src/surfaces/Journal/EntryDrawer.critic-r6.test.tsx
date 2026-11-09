/**
 * Critic round 6 probes on the kept Leistungsdatum (owner 02.10.2026; critic R5 L-a, c14c2a42). Every account
 * and figure is synthetic. `compose_entry` is answered by the real engine.
 *
 * R6-S1 (consistency): the SAME visible state, a satz with no code on which the person then sets VST-M, posts
 * at two different Leistungsdaten depending on HOW the code went away. "Ohne MWST" releases the kept date
 * (`withTaxCode('')`); an account change whose new account has no default resets the code to '' and keeps it.
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

const postButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Post' });
type PostedLine = { account: string; debit?: number; credit?: number; taxCode?: string; taxBase?: number; taxAmount?: number; supplyDate?: string };
const postedOf = (calls: { action: string; input: Record<string, unknown> }[]) =>
  calls.filter((c) => c.action === 'post_entry').at(-1)?.input as { date: string; lines: PostedLine[] };

async function pickAccount(field: HTMLElement, number: string) {
  await userEvent.clear(field);
  await userEvent.type(field, number);
  await userEvent.keyboard('{Enter}');
}

async function pickVat(trigger: HTMLElement, code: string) {
  await userEvent.click(trigger);
  const options = await screen.findAllByRole('option');
  const option =
    code === ''
      ? options.find((o) => (o.textContent ?? '').includes('Without VAT'))
      : options.find((o) => o.querySelector('.combobox__code')?.textContent === code);
  if (option === undefined) throw new Error(`no option ${code}`);
  await userEvent.click(option);
}

describe('R6-S1: one visible state, one Leistungsdatum', () => {
  // A December 2023 draft as the composer saved it (supply date stated), December locked.
  const entry = { id: 'je_ld', date: '2023-12-15', ref: null, description: 'Papier', status: 'draft', source: 'manual', reversesEntryId: null };
  const lines = [
    { id: 'l1', account: id('6500'), debit: 10000, credit: null, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
    { id: 'l2', account: id('1170'), debit: 770, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];

  async function runPath(via: 'ohne-mwst' | 'account-without-default') {
    const { dialog, calls } = await openDrawer(
      { compose_entry: composeEngine({ lockedMonths: ['2023-12'] }), get_entry: { status: 200, body: { ok: true, entry, lines } } },
      { mode: 'edit', entryId: 'je_ld' },
    );
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    if (via === 'ohne-mwst') {
      await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), '');
    } else {
      // 1000 Kasse carries no MWST control: the code resets to '', and the line, now untaxed, lets go of its
      // kept date exactly as "Ohne MWST" does (the coordinator's uniform release rule, 02.10.2026).
      await pickAccount(within(dialog).getByLabelText('Debit'), '1000');
      await pickAccount(within(dialog).getByLabelText('Debit'), '6500');
    }
    // The person now (re)chooses Vorsteuer on 6500: visibly the same act on the same screen either way.
    const vat = within(dialog).getByRole('button', { name: /^VAT(,|$)/ });
    if (!(vat.textContent ?? '').includes('VST-M')) await pickVat(vat, 'VST-M');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = postedOf(calls);
    const taxed = posted.lines.find((l) => l.taxCode === 'VST-M') as PostedLine;
    return { priced: taxed.supplyDate ?? posted.date, tax: taxed.taxAmount };
  }

  // Adapted to the coordinator's decision (02.10.2026, one rule for releasing the kept date): a line left with
  // NO code lets go of its Leistungsdatum, by "Ohne MWST" or by an account that carries none. The probe as
  // written expected both paths to keep 15.12.2023; the uniform rule has both release it, so VST-M chosen
  // afterwards is a new fact priced at the booking date the way out set: 01.01.2024, 8.1%, 8.07.
  const released = { priced: '2024-01-01', tax: 807 };

  it('"Ohne MWST" first, then an account without a code: both release the kept date and price at the booking date', async () => {
    const a = await runPath('ohne-mwst');
    expect(a).toEqual(released);
    document.body.innerHTML = '';
    const b = await runPath('account-without-default');
    expect(b).toEqual(a);
  });

  it('an account without a code first, then "Ohne MWST": the same release, the same price', async () => {
    const b = await runPath('account-without-default');
    expect(b).toEqual(released);
    document.body.innerHTML = '';
    const a = await runPath('ohne-mwst');
    expect(a).toEqual(b);
  });
});

