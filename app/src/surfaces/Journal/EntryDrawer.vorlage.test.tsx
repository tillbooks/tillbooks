/**
 * D176 (A39 §15.4): the composer's Vorlagen.
 *
 *   - the quiet "Template" picker above the lines lists the workspace's Vorlagen (`list_bank_standards
 *     { scope: 'manual' }`); picking one replaces the Buchungssatz with its asked amounts, each a labelled
 *     input;
 *   - the preview is `compose_entry` with the TEMPLATE (the engine expands it; the drawer adds no figure);
 *     Post sends `post_entry { template }`, never lines;
 *   - a template refusal (`rest_changes_side`) is said under the amounts and Post holds;
 *   - `initialVorlageId` and `initialDate` (the bank row's "Next step", `?vorlage=`) open it prefilled;
 *   - ☆ "Save as template" on a composed entry opens the Buchungsregel form in manual scope with the
 *     entry's lines, and saves `set_bank_standard { scope: 'manual' }`.
 *
 * Every account, figure and name is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { EntryDrawer } from './EntryDrawer';
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

const CHART = listAccountsFixture.accounts;
const id = (number: string): string => {
  const row = CHART.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
};

const CODES = [{ code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true }];

/** The month entry of an invented course platform: 1060 Soll asked, 3400 Haben the same, 4400 Soll asked, 1060 Haben the rest. */
const VORLAGE = {
  id: 'br_v',
  scope: 'manual',
  outcome: 'legs',
  counterpartyKey: null,
  counterpartyLabel: null,
  direction: null,
  label: 'Monatsumsatz',
  matchText: null,
  viaAccountId: null,
  viaAccountNumber: null,
  viaAccountName: null,
  legs: [
    { accountId: id('1060'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Bruttoumsatz' }, accountNumber: '1060', accountName: '' },
    { accountId: id('3400'), taxCode: 'UST81', side: 'credit', amount: { kind: 'same', legIndex: 0 }, accountNumber: '3400', accountName: '' },
    { accountId: id('4400'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Coach-Anteil' }, accountNumber: '4400', accountName: '' },
    { accountId: id('1060'), taxCode: null, side: 'credit', amount: { kind: 'rest' }, accountNumber: '1060', accountName: '' },
  ],
  invalidReason: null,
  ignoreReason: null,
  ignoreNote: null,
  followUpStandardId: null,
  followUpLabel: null,
  accountId: id('1060'),
  accountNumber: '1060',
  accountName: '',
  taxCode: null,
  setBy: 'studio',
  setAt: '2026-10-01T08:00:00Z',
};

/** What the engine composes for 216.20 gross and 186.20 coach share (the D176 worked example). */
const COMPOSED = {
  ok: true,
  mode: 'expand',
  composed: true,
  stamped: true,
  lines: [
    { account: id('1060'), debit: 21_620 },
    { account: id('3400'), credit: 20_000, taxCode: 'UST81', taxBase: 20_000, taxAmount: 1_620 },
    { account: id('2200'), credit: 1_620 },
    { account: id('4400'), debit: 18_620 },
    { account: id('1060'), credit: 18_620 },
  ],
  captions: [],
  verdict: { ok: true },
  template: { standardId: 'br_v', label: 'Monatsumsatz', amounts: [] },
};

function reads(extra: Handlers = {}): Handlers {
  const engine = composeEngine();
  return {
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: { status: 200, body: { ok: true, taxCodes: CODES } },
    list_cost_centers: { status: 200, body: { ok: true, costCenters: [] } },
    get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
    list_bank_standards: { status: 200, body: { ok: true, standards: [VORLAGE] } },
    // A template request gets the canned answer (the engine's own expansion is proven in the root suite);
    // typed lines go to the real composer.
    compose_entry: (input) => (input.template !== undefined ? ({ status: 200, body: COMPOSED } as unknown as RestResponse) : engine(input)),
    ...extra,
  };
}

async function openDrawer(handlers: Handlers, props: { initialVorlageId?: string; initialDate?: string } = {}) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const onWritten = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <CapabilitiesContext.Provider value={ALLOW_ALL}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <EntryDrawer mode="create" canPost onClose={vi.fn()} onWritten={onWritten} {...props} />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </CapabilitiesContext.Provider>
    </TillClientProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  return { dialog, calls, onWritten };
}

async function pickVorlage(dialog: HTMLElement, name: string) {
  await userEvent.click(await within(dialog).findByRole('combobox', { name: 'Template' }));
  await userEvent.click(await screen.findByRole('option', { name }));
}

describe('D176: a Vorlage in the composer', () => {
  it('the picker replaces the Buchungssatz with the asked amounts; the preview is compose_entry with the template; Post sends post_entry { template }', async () => {
    const { dialog, calls, onWritten } = await openDrawer(reads({ post_entry: () => cannedOk('post_entry', { ok: true, entryId: 'je_v' }) }));
    await pickVorlage(dialog, 'Monatsumsatz');
    expect(within(dialog).queryByLabelText('Debit')).toBeNull();
    const post = within(dialog).getByRole('button', { name: 'Post' });
    expect(post).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Bruttoumsatz' }), '216.20');
    expect(post).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Coach-Anteil' }), '186.20');
    const preview = await within(dialog).findByRole('table', { name: 'What gets booked' });
    expect(within(preview).getAllByRole('row')).toHaveLength(6);
    const composeCall = calls.filter((c) => c.action === 'compose_entry' && c.input.template !== undefined).at(-1);
    expect(composeCall?.input).toMatchObject({ mode: 'expand', template: { standardId: 'br_v', asks: { 0: 21_620, 2: 18_620 } } });
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.click(post);
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const sent = calls.find((c) => c.action === 'post_entry')?.input ?? {};
    expect(sent).toMatchObject({ workspaceId: 'ws_test', source: 'manual', template: { standardId: 'br_v', asks: { 0: 21_620, 2: 18_620 } } });
    expect(sent).not.toHaveProperty('lines');
    expect(typeof sent.idempotencyKey).toBe('string');
    await waitFor(() => expect(onWritten).toHaveBeenCalledWith('je_v'));
  });

  it('a template refusal (rest_changes_side) is said under the amounts, every typed value stays, and Post holds', async () => {
    const refused = { ...COMPOSED, composed: false, stamped: false, lines: [], verdict: { ok: false, error: 'rest_changes_side' } };
    const { dialog } = await openDrawer(reads({ compose_entry: (input) => (input.template !== undefined ? ({ status: 200, body: refused } as unknown as RestResponse) : composeEngine()(input)) }));
    await pickVorlage(dialog, 'Monatsumsatz');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Bruttoumsatz' }), '100.00');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Coach-Anteil' }), '50.00');
    expect(await within(dialog).findByText('With these amounts the rest would land on the other side. Check the amounts.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Post' })).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'Bruttoumsatz' })).toHaveValue('100.00');
  });

  it('the bank row\'s next step opens the composer with the Vorlage picked and the line\'s date', async () => {
    const { dialog } = await openDrawer(reads(), { initialVorlageId: 'br_v', initialDate: '2026-10-14' });
    expect(await within(dialog).findByRole('textbox', { name: 'Bruttoumsatz' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Template' })).toHaveTextContent('Monatsumsatz');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-14');
  });

  it('critic D176-C1: an invalid Vorlage is listed with its reason in words and cannot be picked, not even through ?vorlage=', async () => {
    const quiet = { ...VORLAGE, id: 'br_q', label: 'Sparen', invalidReason: 'account_not_bookable' };
    const { dialog, calls } = await openDrawer(reads({ list_bank_standards: { status: 200, body: { ok: true, standards: [VORLAGE, quiet] } } }), { initialVorlageId: 'br_q' });
    await userEvent.click(await within(dialog).findByRole('combobox', { name: 'Template' }));
    const option = await screen.findByRole('option', { name: 'Sparen: blocked, a template may no longer book to one of its accounts' });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(option);
    expect(within(dialog).queryByRole('textbox', { name: 'Bruttoumsatz' })).toBeNull();
    expect(await within(dialog).findByLabelText('Debit')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'compose_entry' && c.input.template !== undefined)).toBe(false);
  });

  it('without a Vorlage in the book the picker stays away and the Buchungssatz is as before', async () => {
    const { dialog } = await openDrawer(reads({ list_bank_standards: { status: 200, body: { ok: true, standards: [] } } }));
    expect(await within(dialog).findByLabelText('Debit')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: 'Template' })).toBeNull();
  });
});

describe('D176: ☆ Save as template on a composed entry', () => {
  it('opens the Buchungsregel form in manual scope with the entry\'s lines, and saves set_bank_standard { scope: manual }', async () => {
    const { dialog, calls } = await openDrawer(reads({ set_bank_standard: { status: 200, body: { ok: true, standard: { id: 'br_new' }, supersededId: null, unchanged: false } } }));
    const pick = async (field: HTMLElement, number: string) => {
      await userEvent.clear(field);
      await userEvent.type(field, number);
      await userEvent.keyboard('{Enter}');
    };
    await pick(await within(dialog).findByLabelText('Debit'), '6500');
    await pick(within(dialog).getByLabelText('Credit'), '1000');
    await userEvent.type(within(dialog).getByLabelText('Amount'), '42.00');
    const save = await within(dialog).findByRole('button', { name: '☆ Save as template' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    const form = within(dialog).getByRole('form', { name: 'Save as template' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Kassenauslage');
    // The last line (1000, Credit) is the rest; the first is asked under its account's name.
    expect(within(within(form).getByRole('radiogroup', { name: 'Debit or credit, line 1' })).getByRole('radio', { name: 'Debit' })).toBeChecked();
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_bank_standard')).toBe(true));
    const sent = calls.find((c) => c.action === 'set_bank_standard')?.input ?? {};
    expect(sent).toMatchObject({
      workspaceId: 'ws_test',
      scope: 'manual',
      label: 'Kassenauslage',
      legs: [
        { accountId: id('6500'), side: 'debit', amount: { kind: 'ask' } },
        { accountId: id('1000'), side: 'credit', amount: { kind: 'rest' } },
      ],
    });
    expect(sent).not.toHaveProperty('bankTxnId');
    expect(await within(dialog).findByText('Template "Kassenauslage" saved. You find it above under "Template".')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'post_entry')).toBe(false);
  });
});
