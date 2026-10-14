/**
 * The A1 "Buchungssatz" composer (A02 §6, owner pick 01.10.2026), story by story.
 *
 * Each `describe` is one row of the prototype's "Alle Fälle, die die neue Buchung können muss" list. The
 * money path is proven against the REAL engine in `test/vat/composer-payload.test.mjs` and
 * `test/vat/compose-entry.test.mjs`. Here the drawer is held to what it SENDS and what it SHOWS: the intent
 * it hands `compose_entry`, the lines it then hands `post_entry` / `save_draft` (verbatim, the engine's),
 * the one-line caption, what is hidden, and the five states.
 *
 * `compose_entry` is answered by the REAL engine (`app/test-support/composeEngine.ts`, D152 amendment):
 * no stand-in derives a VAT figure anywhere in this suite. Every account, figure and file name is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { EntryDrawer } from './EntryDrawer';
import type { DrawerMode } from './types';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { ALLOW_ALL, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { cannedOk, recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { composeEngine } from '../../../test-support/composeEngine';
import { consequenceSentence } from '../../lib/approval-tiers';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

/** The recorded chart, with the defaults a bookkeeper would set: 6500 Vorsteuer, 3400 Umsatzsteuer, 1500 Investitionen. */
const DEFAULTS: Record<string, string> = { '6500': 'VST-M', '3400': 'UST81', '1500': 'VST-I' };
const CHART = listAccountsFixture.accounts.map((a) => ({ ...a, vatCodeDefault: DEFAULTS[a.number] ?? a.vatCodeDefault }));
const id = (number: string): string => {
  const row = CHART.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
};

const CODES = [
  { code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material, Waren, Dienstleistungen', active: true },
  { code: 'VST-I', kind: 'input', rateBp: 0, formLine: '405', label: 'Vorsteuer Investitionen', active: true },
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, formLine: '383', label: 'Bezugsteuer', active: true },
  { code: 'IMPORT', kind: 'import', rateBp: 0, formLine: '400', label: 'Einfuhrsteuer', active: true },
  { code: 'AUSGENOMMEN', kind: 'exempt', rateBp: 0, formLine: '230', label: 'Ausgenommen', active: true },
];

const READS: Handlers = {
  list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: CHART }) },
  vat_codes: { status: 200, body: { ok: true, taxCodes: CODES } },
  list_cost_centers: { status: 200, body: { ok: true, costCenters: [{ id: 'cc_1', code: 'K1', name: 'Vertrieb' }] } },
  get_company_profile: { status: 200, body: { ok: true, profile: { baseCurrency: 'CHF' } } },
  compose_entry: composeEngine(),
};

interface Rendered {
  dialog: HTMLElement;
  calls: { action: string; input: Record<string, unknown> }[];
  onClose: ReturnType<typeof vi.fn>;
  onWritten: ReturnType<typeof vi.fn>;
}

async function openDrawer(
  extra: Handlers = {},
  opts: { mode?: DrawerMode; entryId?: string; caps?: Capabilities; locale?: 'en' | 'de-CH' } = {},
): Promise<Rendered> {
  const handlers = { ...READS, ...extra };
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = handlers[action];
    if (h === undefined && action === 'files_list_linked') return { status: 200, body: { ok: true, files: [] } };
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const onClose = vi.fn();
  const onWritten = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <CapabilitiesContext.Provider value={opts.caps ?? ALLOW_ALL}>
        <I18nProvider initialLocale={opts.locale ?? 'en'}>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <EntryDrawer mode={opts.mode ?? 'create'} entryId={opts.entryId} canPost onClose={onClose} onWritten={onWritten} />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </CapabilitiesContext.Provider>
    </TillClientProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  return { dialog, calls, onClose, onWritten };
}

async function pickAccount(field: HTMLElement, number: string) {
  await userEvent.clear(field);
  await userEvent.type(field, number);
  await userEvent.keyboard('{Enter}');
}

async function satz(dialog: HTMLElement, debit: string, credit: string, amount: string) {
  await pickAccount(await within(dialog).findByLabelText('Debit'), debit);
  await pickAccount(within(dialog).getByLabelText('Credit'), credit);
  await userEvent.type(within(dialog).getByLabelText('Amount'), amount);
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

const postButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Post' });

/** The payload of the one recorded call to `action`. */
function sent(calls: Rendered['calls'], action: string): Record<string, unknown> {
  const found = calls.filter((c) => c.action === action);
  expect(found).toHaveLength(1);
  return (found[0] as { input: Record<string, unknown> }).input;
}

const POST_OK: Handlers = { post_entry: () => cannedOk('post_entry', { ok: true, entryId: 'je_new' }) };

describe('A1: Ausgabe mit MWST (6500 an 1020, 107.70, Vorsteuer from the account)', () => {
  it('pre-fills the code, names the derived leg in one line, and posts net + Vorsteuer + gross', async () => {
    const { dialog, calls, onClose, onWritten } = await openDrawer(POST_OK);
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Druckerpapier');
    await satz(dialog, '6500', '1020', '107.70');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('VST-M');
    expect(await within(dialog).findByText("of which VAT CHF 8.07 to 1170 · net CHF 99.63")).toBeInTheDocument();
    // The drawer sends INTENT (A1's gross Betrag, the code, the entry date), never a figure of its own.
    const asked = calls.filter((c) => c.action === 'compose_entry').at(-1)?.input;
    expect(asked).toMatchObject({
      mode: 'expand',
      lines: [
        { account: id('6500'), side: 'debit', amount: 10770, gross: true, taxCode: 'VST-M' },
        { account: id('1020'), side: 'credit', amount: 10770, gross: true },
      ],
    });
    expect(JSON.stringify(asked)).not.toMatch(/taxBase|taxAmount/);

    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.source).toBe('manual');
    expect(input.description).toBe('Druckerpapier');
    expect(typeof input.idempotencyKey).toBe('string');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: input.date },
      { account: id('1170'), debit: 807 },
      { account: id('1020'), credit: 10770 },
    ]);
    expect(onWritten).toHaveBeenCalledWith('je_new');
  });
});

describe('A1: Ausgabe ohne MWST', () => {
  it('can always be set to Without VAT, which sends no code and shows no caption', async () => {
    const { dialog, calls } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '107.70');
    await within(dialog).findByText(/of which VAT/);
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), '');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
    await waitFor(() => expect(dialog.querySelector('.journal-caption')).toBeNull());
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expect(sent(calls, 'post_entry').lines).toEqual([
      { account: id('6500'), debit: 10770 },
      { account: id('1020'), credit: 10770 },
    ]);
  });

  it('an expense with no default code stays empty (6900 an 1020)', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6900', '1020', '12.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
  });
});

describe('A1: Erlös mit Umsatzsteuer (1100 an 3400)', () => {
  it('takes UST81 from the revenue account and books net revenue + 2200 against the gross debtor', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '1100', '3400', '1081.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('UST81');
    expect(await within(dialog).findByText("of which VAT CHF 81.00 to 2200 · net CHF 1'000.00")).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('1100'), debit: 108100 },
      { account: id('3400'), credit: 100000, taxCode: 'UST81', taxBase: 100000, taxAmount: 8100, supplyDate: input.date },
      { account: id('2200'), credit: 8100 },
    ]);
  });
});

describe('A1: Umbuchung zwischen Bilanzkonten', () => {
  it('shows no MWST control on 1060 an 1020, and a code chosen for an expense never rides along', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '500.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('VST-M');
    // The Soll side becomes a balance-sheet account: the control goes, and so does its value.
    await pickAccount(within(dialog).getByLabelText('Debit'), '1060');
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).toBeNull();
    expect(dialog.querySelector('.journal-caption')).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'post_entry').lines).toEqual([
      { account: id('1060'), debit: 50000 },
      { account: id('1020'), credit: 50000 },
    ]);
  });
});

describe('A1: Sammelbuchung via Aufteilen', () => {
  it('carries the satz into the grid, balances the last line itself, and posts each taxed line derived', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '107.70');
    await within(dialog).findByText(/of which VAT/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    // Everything typed is carried over: the account, the amount, the code; Haben balances itself.
    expect(within(dialog).getByLabelText('Debit 1')).toHaveValue('107.70');
    expect(within(dialog).getByRole('button', { name: /^VAT 1(,|$)/ })).toHaveTextContent('VST-M');
    expect(within(dialog).getByLabelText('Credit 2')).toHaveAttribute('placeholder', '107.70');
    // Focus lands on "+ Line", the next act.
    expect(within(dialog).getByRole('button', { name: 'Line' })).toHaveFocus();
    expect(within(dialog).getByText('Amounts include VAT')).toBeInTheDocument();
    expect(within(dialog).getByText('Balanced')).toBeInTheDocument();

    // A second expense on line 2, and the bank as line 3, which balances itself to 157.70.
    await pickAccount(within(dialog).getByLabelText('Account 2'), '6570');
    await userEvent.type(within(dialog).getByLabelText('Debit 2'), '50.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Line' }));
    await pickAccount(within(dialog).getByLabelText('Account 3'), '1020');
    expect(within(dialog).getByLabelText('Credit 3')).toHaveAttribute('placeholder', '157.70');
    // The MWST cell sits only on Erfolgskonten: lines 1 and 2, never the bank line.
    expect(within(dialog).getByRole('button', { name: /^VAT 2(,|$)/ })).toHaveTextContent('Without VAT');
    expect(within(dialog).queryByRole('button', { name: /^VAT 3(,|$)/ })).toBeNull();
    // The heads share the rows' grid, one per column.
    const head = dialog.querySelector('.journal-grid-head') as HTMLElement;
    expect(head.children).toHaveLength(5);

    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: input.date },
      { account: id('1170'), debit: 807 },
      { account: id('6570'), debit: 5000 },
      { account: id('1020'), credit: 15770 },
    ]);
  });

  it('removes a line from its overflow, and names the signed difference while it does not balance', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6900', '1020', '10.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    await userEvent.type(within(dialog).getByLabelText('Debit 2'), '4.00');
    expect(dialog.querySelector('.journal-balance--off')).toHaveTextContent('Difference CHF 14.00');
    expect(postButton(dialog)).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Line' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'More for line 3' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove line' }));
    expect(within(dialog).queryByLabelText('Account 3')).toBeNull();
  });
});

describe('A1: Kostenstelle', () => {
  it('offers + Cost centre only where the account allows one, and the cost centre rides that line alone', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '1060', '1020', '10.00');
    expect(within(dialog).queryByRole('button', { name: 'Cost centre' })).toBeNull();
    await pickAccount(within(dialog).getByLabelText('Debit'), '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cost centre' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Cost centre' }));
    const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'cc_1');
    if (option === undefined) throw new Error('no cost centre option');
    await userEvent.click(option);
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const lines = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    expect(lines.find((l) => l.account === id('6500'))?.costCenter).toBe('cc_1');
    expect(lines.filter((l) => l.costCenter !== undefined)).toHaveLength(1);
  });

  it('clears a cost centre when its account changes, so a hidden picker never carries one', async () => {
    const { dialog, calls } = await openDrawer({ save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }) });
    await satz(dialog, '6500', '1020', '10.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cost centre' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Cost centre' }));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'cc_1') as HTMLElement);
    await pickAccount(within(dialog).getByLabelText('Debit'), '6570');
    expect(within(dialog).queryByRole('combobox', { name: 'Cost centre' })).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'save_draft')).toBe(true));
    const lines = sent(calls, 'save_draft').lines as Record<string, unknown>[];
    expect(lines.every((l) => l.costCenter === undefined)).toBe(true);
  });

  it('in the grid: set from the row overflow, shown as a dim caption, removed from the same menu', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6500', '1020', '10.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'More for line 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Cost centre K1 Vertrieb' }));
    expect(within(dialog).getByText('Cost centre K1 Vertrieb')).toHaveClass('journal-grid-cc');
    // The bank line allows none, so its overflow has nothing about cost centres.
    await userEvent.click(within(dialog).getByRole('button', { name: 'More for line 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove cost centre' }));
    expect(within(dialog).queryByText('Cost centre K1 Vertrieb')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'More for line 2' })).toBeNull();
  });
});

describe('A1: Beleg anhängen', () => {
  const PDF = () => new File(['%PDF-1.4 synthetic'], 'beleg-muster.pdf', { type: 'application/pdf' });
  const uploadOk: Handler = () => ({ status: 200, body: { ok: true, file: { id: 'file_1' } } });

  it('files on pick, links after the post answers with the entry id, then closes', async () => {
    const { dialog, calls, onClose } = await openDrawer({ ...POST_OK, files_upload: uploadOk, files_link: { status: 200, body: { ok: true } } });
    const clip = within(dialog).getByRole('button', { name: 'Attach a receipt' });
    // A real tooltip, never `title`.
    expect(clip.hasAttribute('title')).toBe(false);
    expect(document.getElementById(clip.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Attach a receipt or drop a file here');
    await userEvent.upload(within(dialog).getByTestId('journal-beleg-input'), PDF());
    expect(await within(dialog).findByText('beleg-muster.pdf')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.action === 'files_upload')).toBe(true));
    expect(sent(calls, 'files_upload')).toMatchObject({ filename: 'beleg-muster.pdf', mime: 'application/pdf' });

    await satz(dialog, '6900', '1020', '12.00');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'files_link')).toMatchObject({ fileId: 'file_1', entityKind: 'journal_entry', entityId: 'je_new' });
    // The link comes AFTER the post: a new entry has no id before it.
    const order = calls.map((c) => c.action).filter((a) => a === 'post_entry' || a === 'files_link');
    expect(order).toEqual(['post_entry', 'files_link']);
  });

  it('a link that fails after the post leaves the post standing, says so, and retries the same link', async () => {
    let linkTries = 0;
    const { dialog, calls, onClose, onWritten } = await openDrawer({
      ...POST_OK,
      files_upload: uploadOk,
      files_link: () => {
        linkTries += 1;
        return linkTries === 1 ? { status: 503, body: { ok: false, error: 'store_busy' } } : { status: 200, body: { ok: true } };
      },
    });
    await userEvent.upload(within(dialog).getByTestId('journal-beleg-input'), PDF());
    await satz(dialog, '6900', '1020', '12.00');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    expect(await within(dialog).findByText('Posted. The receipt beleg-muster.pdf is filed, but not linked to the entry yet.')).toBeInTheDocument();
    // The list learns of the entry now; nothing is posted twice and Post is gone.
    expect(onWritten).toHaveBeenCalledWith('je_new');
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('button', { name: 'Post' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const links = calls.filter((c) => c.action === 'files_link');
    expect(links).toHaveLength(2);
    expect(links[0]?.input.idempotencyKey).toBe(links[1]?.input.idempotencyKey);
    expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1);
  });

  it('holds Post while the upload failed, and retries it', async () => {
    let tries = 0;
    const { dialog } = await openDrawer({
      ...POST_OK,
      files_upload: () => {
        tries += 1;
        return tries === 1 ? { status: 503, body: { ok: false, error: 'store_busy' } } : { status: 200, body: { ok: true, file: { id: 'file_2' } } };
      },
    });
    await satz(dialog, '6900', '1020', '12.00');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.upload(within(dialog).getByTestId('journal-beleg-input'), PDF());
    await within(dialog).findByRole('button', { name: 'Try again' });
    expect(postButton(dialog)).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
  });

  it('links after a draft save too, and a file dropped on the drawer is the Beleg', async () => {
    const { dialog, calls, onClose } = await openDrawer({
      save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }),
      files_upload: uploadOk,
      files_link: { status: 200, body: { ok: true } },
    });
    fireEvent.drop(dialog.querySelector('.journal-drawer-body-spacing') as HTMLElement, { dataTransfer: { files: [PDF()] } });
    expect(await within(dialog).findByText('beleg-muster.pdf')).toBeInTheDocument();
    await pickAccount(await within(dialog).findByLabelText('Debit'), '6900');
    await waitFor(() => expect(calls.some((c) => c.action === 'files_upload')).toBe(true));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'files_link')).toMatchObject({ entityId: 'je_d', entityKind: 'journal_entry' });
  });

  it('hides the paperclip when the actor may not file or may not edit the entry (D62 / F8)', async () => {
    const { dialog } = await openDrawer({}, { caps: { ...ALLOW_ALL, can: (c) => c !== 'manage_files' } });
    await within(dialog).findByLabelText('Debit');
    expect(within(dialog).queryByRole('button', { name: 'Attach a receipt' })).toBeNull();
  });
});

describe('A1: Referenz', () => {
  it('sits behind + Reference, focuses on open, and still maps to ref', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6900', '1020', '12.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reference' }));
    const field = within(dialog).getByLabelText('Reference');
    expect(field).toHaveFocus();
    await userEvent.type(field, 'RE-4471');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'post_entry').ref).toBe('RE-4471');
  });
});

describe('A1: Bezugsteuer, Einfuhrsteuer, Vorsteuer Investitionen, Saldosteuersatz', () => {
  it('Bezugsteuer books the paired 2200/1170 legs on the paid base', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '1000.00');
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'BEZUG');
    expect(await within(dialog).findByText('Reverse-charge VAT CHF 81.00 to 2200 and 1170')).toBeInTheDocument();
    // The Betrag goes out as typed; the ENGINE knows Bezugsteuer prices on the paid base.
    expect(calls.filter((c) => c.action === 'compose_entry').at(-1)?.input).toMatchObject({ lines: [{ amount: 100000, gross: true, taxCode: 'BEZUG' }, { amount: 100000 }] });
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 100000, taxCode: 'BEZUG', taxBase: 100000, taxAmount: 8100, supplyDate: input.date },
      { account: id('2200'), credit: 8100 },
      { account: id('1170'), debit: 8100 },
      { account: id('1020'), credit: 100000 },
    ]);
  });

  it('Einfuhrsteuer: the assessed tax is the 1170 line itself', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '50.00');
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'IMPORT');
    expect(await within(dialog).findByText('Import VAT CHF 50.00 as input tax')).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('1170'), debit: 5000, taxCode: 'IMPORT', taxBase: 0, taxAmount: 5000, supplyDate: input.date },
      { account: id('1020'), credit: 5000 },
    ]);
  });

  it('Vorsteuer Investitionen on an Anlagekonto with a default code books to 1171', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '1500', '1020', '2162.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('VST-I');
    expect(await within(dialog).findByText("of which VAT CHF 162.00 to 1171 · net CHF 2'000.00")).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((sent(calls, 'post_entry').lines as Record<string, unknown>[])[1]).toEqual({ account: id('1171'), debit: 16200 });
  });

  it('Saldosteuersatz: the Vorsteuer is not deductible, so there is no separate leg', async () => {
    const { dialog, calls, onClose } = await openDrawer({ ...POST_OK, compose_entry: composeEngine({ method: 'saldo' }) });
    await satz(dialog, '6500', '1020', '107.70');
    expect(await within(dialog).findByText('of which VAT CHF 8.07, not deductible')).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 10770, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: input.date },
      { account: id('1020'), credit: 10770 },
    ]);
  });

  it('holds Post and says why when the chart has no VAT account for the leg', async () => {
    const chart = CHART.filter((a) => a.number !== '1170');
    const { dialog } = await openDrawer({
      list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: chart }) },
      compose_entry: composeEngine({ withoutAccounts: ['1170'] }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    expect(await within(dialog).findByText(/A VAT account \(1170, 1171 or 2200\) is missing/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open the chart of accounts' })).toHaveAttribute('href', '/accounts');
    expect(postButton(dialog)).toBeDisabled();
  });
});

describe('A1: Entwurf speichern und wieder öffnen; Vorschlag vom Agenten', () => {
  const draftEntry = (over: Record<string, unknown> = {}) => ({
    id: 'je_d', date: '2026-09-30', ref: null, description: 'Druckerpapier', status: 'draft', source: 'manual', reversesEntryId: null, ...over,
  });
  const getEntry = (lines: Record<string, unknown>[], over: Record<string, unknown> = {}): Handlers => ({
    get_entry: { status: 200, body: { ok: true, entry: draftEntry(over), lines } },
  });
  const A1_LINES = () => [
    { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807 },
    { id: 'l2', account: id('1170'), debit: 807, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];

  it('saves the derived lines, and a draft of that exact shape reopens as a Buchungssatz', async () => {
    const saved = await openDrawer({ save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }) });
    await satz(saved.dialog, '6500', '1020', '107.70');
    await within(saved.dialog).findByText(/of which VAT/);
    await userEvent.click(within(saved.dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saved.onClose).toHaveBeenCalled());
    const draftLines = sent(saved.calls, 'save_draft').lines as Record<string, unknown>[];
    expect(draftLines.map((l) => [l.account, l.debit ?? 0, l.credit ?? 0])).toEqual([
      [id('6500'), 9963, 0],
      [id('1170'), 807, 0],
      [id('1020'), 0, 10770],
    ]);
  });

  it('reopens the A1 shape as a satz, with the gross back in the Betrag', async () => {
    const { dialog } = await openDrawer(getEntry(A1_LINES()), { mode: 'edit', entryId: 'je_d' });
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('VST-M');
    expect(within(dialog).queryByLabelText('Account 1')).toBeNull();
  });

  it('opens an agent-drafted entry (Vorschlag) the same way: by its lines', async () => {
    const { dialog } = await openDrawer(getEntry(A1_LINES(), { source: 'agent' }), { mode: 'edit', entryId: 'je_d' });
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
  });

  it('opens a draft no satz can say (two counters) in the grid, exactly as stored, on the manual path', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M' },
      { id: 'l2', account: id('1170'), debit: 807, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 5000 },
      { id: 'l4', account: id('1000'), debit: null, credit: 5770 },
    ];
    const { dialog, calls } = await openDrawer({ ...getEntry(lines), ...POST_OK }, { mode: 'edit', entryId: 'je_d' });
    expect(await within(dialog).findByLabelText('Account 4')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Debit 1')).toHaveValue('99.63');
    expect(within(dialog).getByText('VAT line typed by hand: TILL adds no VAT')).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const input = sent(calls, 'post_entry');
    expect(input.entryId).toBe('je_d');
    expect((input.lines as Record<string, unknown>[]).map((l) => [l.account, l.debit ?? 0, l.credit ?? 0, l.taxCode ?? ''])).toEqual([
      [id('6500'), 9963, 0, 'VST-M'],
      [id('1170'), 807, 0, ''],
      [id('1020'), 0, 5000, ''],
      [id('1000'), 0, 5770, ''],
    ]);
  });

  it('C4: holds Save draft while the engine\'s answer is in flight, then saves the derived lines, never a coded gross line', async () => {
    let previewsAsked = 0;
    // Every answer is held until released. A slow machine can let the debounce send one more request after
    // the first release, so the release takes every answer asked so far, and again on each retry: holding
    // only the LAST resolver left an earlier or later request unanswered and Save draft held forever.
    const pending: (() => void)[] = [];
    const releaseAll = () => {
      for (const release of pending.splice(0)) release();
    };
    const base = composeEngine();
    const { dialog, calls, onClose } = await openDrawer({
      compose_entry: (input) => {
        previewsAsked += 1;
        return new Promise<RestResponse>((resolve) => {
          pending.push(() => resolve(base(input)));
        });
      },
      save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    // The request really went out and has not answered: both writes hold on it.
    await waitFor(() => expect(previewsAsked).toBeGreaterThan(0));
    expect(postButton(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await waitFor(() => {
      releaseAll();
      expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled();
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const draft = sent(calls, 'save_draft');
    expect(draft.lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: draft.date },
      { account: id('1170'), debit: 807 },
      { account: id('1020'), credit: 10770 },
    ]);
  });

  it('C4: a half-typed satz (no Haben yet) saves its side DERIVED, not as a coded gross amount', async () => {
    const { dialog, calls, onClose } = await openDrawer({ save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }) });
    await pickAccount(await within(dialog).findByLabelText('Debit'), '6500');
    await userEvent.type(within(dialog).getByLabelText('Amount'), '107.70');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const draft = sent(calls, 'save_draft');
    expect(draft.lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: draft.date },
      { account: id('1170'), debit: 807 },
    ]);
  });

  it('C4: an agent Vorschlag of two coded lines with no 2200 leg opens on the MANUAL path and posts the revenue as stored', async () => {
    // A tagged amount with no VAT leg is a NET base to the engine, to an MCP agent and to the pre-A1
    // composer. Re-deriving it as gross would book 3400 92.51 + 2200 7.49 on a draft nobody touched.
    const lines = [
      { id: 'l1', account: id('1100'), debit: 10000, credit: null },
      { id: 'l2', account: id('3400'), debit: null, credit: 10000, taxCode: 'UST81' },
    ];
    const { dialog, calls } = await openDrawer(
      { ...getEntry(lines, { source: 'agent' }), ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    await within(dialog).findByLabelText('Account 1');
    expect(within(dialog).getByText('VAT line typed by hand: TILL adds no VAT')).toBeInTheDocument();
    // The stored lines go to the engine exactly as stored: nothing re-priced as gross in the Studio.
    await waitFor(() => expect(calls.some((c) => c.action === 'compose_entry' && c.input.mode === 'expand')).toBe(true));
    expect(calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input.lines).toEqual([
      { account: id('1100'), debit: 10000 },
      { account: id('3400'), credit: 10000, taxCode: 'UST81' },
    ]);
    // The engine reads the tagged 100.00 as the NET base (tax 8.10) and refuses: no 2200 leg books it. It
    // says so in place, and Buchen holds, rather than a post the engine would refuse anyway.
    expect(await within(dialog).findByText('The VAT does not reconcile: the tagged lines add up to CHF 8.10, but the VAT accounts book CHF 0.00.')).toBeInTheDocument();
    // The readout beside the line is the engine's net-forward reading of it: VAT 8.10, gross 108.10.
    expect(await within(dialog).findByText(/VAT CHF 8\.10/)).toBeInTheDocument();
    expect(postButton(dialog)).toBeDisabled();
    expect(calls.some((c) => c.action === 'post_entry')).toBe(false);
  });
});

describe('A1: gebuchte Buchung ansehen', () => {
  it('shows every stored line read-only, with its MWST code and cost centre', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', costCenter: 'cc_1', currency: 'CHF' },
      { id: 'l2', account: id('1170'), debit: 807, credit: null, currency: 'CHF' },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770, currency: 'CHF' },
    ];
    const { dialog } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: { id: 'je_1', date: '2026-09-30', ref: 'RE-1', description: 'Papier', status: 'posted', source: 'manual', reversesEntryId: null }, lines } } },
      { mode: 'view', entryId: 'je_1' },
    );
    const table = await within(dialog).findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('VST-M')).toBeInTheDocument();
    expect(within(table).getByText('CHF 8.07')).toBeInTheDocument();
    expect(within(table).getByText('Cost centre K1 Vertrieb')).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Reverse' })).toBeInTheDocument();
  });
});

describe('A1: nur Tastatur', () => {
  it('tabs Date, Description, Beleg, Debit, Credit, Amount, VAT, then on to Post and its (i)', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6500', '1020', '10.00');
    const date = within(dialog).getByLabelText('Date');
    date.focus();
    const seen: string[] = [];
    for (let i = 0; i < 16 && seen.at(-1) !== 'What posting does'; i += 1) {
      const el = document.activeElement as HTMLElement;
      seen.push(el.getAttribute('aria-label') ?? el.textContent ?? '');
      await userEvent.tab();
    }
    const order = ['Date', 'Description', 'Attach a receipt', 'Debit', 'Credit', 'Amount', 'VAT, VST-M Vorsteuer Material, Waren, Dienstleistungen', 'Post', 'What posting does'];
    const positions = order.map((name) => seen.indexOf(name));
    expect(positions.every((p) => p >= 0), `tab sequence was ${seen.join(' > ')}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('A1: the C4 sentence behind the (i) beside Post', () => {
  it('is a real tooltip on the (i), and Post is described by the same words', async () => {
    const { dialog } = await openDrawer();
    const info = await within(dialog).findByRole('button', { name: 'What posting does' });
    const tip = document.getElementById(info.getAttribute('aria-describedby') ?? '');
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveTextContent(consequenceSentence('post_entry', 'en') as string);
    const described = document.getElementById(postButton(dialog).getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(tip?.textContent);
    expect(info.hasAttribute('title')).toBe(false);
  });
});

describe('A1: de-CH', () => {
  it('reads Datum, Text, Beleg, Soll an Haben, Betrag, MWST and the caption in Swiss German', async () => {
    const { dialog } = await openDrawer({}, { locale: 'de-CH' });
    await pickAccount(await within(dialog).findByLabelText('Soll'), '6500');
    await pickAccount(within(dialog).getByLabelText('Haben'), '1020');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '107.70');
    for (const name of ['Datum', 'Text']) expect(within(dialog).getByLabelText(name)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Beleg anhängen' })).toBeInTheDocument();
    expect(await within(dialog).findByText('davon MWST CHF 8.07 auf 1170 · netto CHF 99.63')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Aufteilen' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Was Buchen bewirkt' })).toBeInTheDocument();
  });
});

describe('A1: accessibility (jest-axe, both themes)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`the Buchungssatz and the grid have no axe violations (${theme})`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      try {
        const { dialog } = await openDrawer();
        await satz(dialog, '6500', '1020', '107.70');
        await within(dialog).findByText(/of which VAT/);
        expect(await axe(dialog)).toHaveNoViolations();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
        await within(dialog).findByLabelText('Account 1');
        expect(await axe(dialog)).toHaveNoViolations();
      } finally {
        document.documentElement.removeAttribute('data-theme');
      }
    });
  }
});

// ======================================================================================================
// Regressions adopted from the non-author critic's probes (branch critic/composer-a1, 35aad20). Each one
// failed against the first A1 build (or pins a write it probed); the name says which finding it pins.
// ======================================================================================================

describe('critic regressions: writes', () => {
  it('C7: a post whose answer is lost (transport_error) and is retried books ONE entry (one key per intent)', async () => {
    // The "server" commits every post it receives and replays by idempotency key, as postEntry does.
    const committed = new Map<string, string>();
    let received = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: (input) => {
        received += 1;
        const key = String(input.idempotencyKey);
        if (!committed.has(key)) committed.set(key, `je_${committed.size + 1}`);
        if (received === 1) return { status: 0, body: { ok: false, error: 'transport_error', detail: 'TypeError: Failed to fetch' } };
        return cannedOk('post_entry', { ok: true, entryId: committed.get(key) as string });
      },
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    expect(committed.size).toBe(1);
  });

  it('C7: a changed content after a refusal is a new intent with a new key', async () => {
    let n = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: () => {
        n += 1;
        return n === 1 ? { status: 422, body: { ok: false, error: 'period_locked', period: '2026-03' } } : cannedOk('post_entry', { ok: true, entryId: 'je_new' });
      },
    });
    await satz(dialog, '6900', '1020', '10.00');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await within(dialog).findByText(/nearest open period/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change the booking date' }));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.action === 'post_entry');
    expect(first?.input.idempotencyKey).not.toBe(second?.input.idempotencyKey);
  });

  it('C7: a draft save whose answer is lost and is retried saves ONE draft', async () => {
    const keys: string[] = [];
    const { dialog } = await openDrawer({
      save_draft: (input) => {
        keys.push(String(input.idempotencyKey));
        return keys.length === 1 ? { status: 0, body: { ok: false, error: 'transport_error' } } : cannedOk('save_draft', { ok: true, entryId: 'je_d' });
      },
    });
    await satz(dialog, '6900', '1020', '10.00');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
  });

  it('C5: a double click on Post sends ONE post_entry', async () => {
    let release: (r: RestResponse) => void = () => undefined;
    const { dialog, calls } = await openDrawer({
      post_entry: () =>
        new Promise<RestResponse>((r) => {
          release = r;
        }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.dblClick(postButton(dialog));
    release(cannedOk('post_entry', { ok: true, entryId: 'je_new' }) as RestResponse);
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry').length).toBeGreaterThan(0));
    expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1);
  });

  it('C6: a posted derived entry lists every stored line, VAT leg included, and Reverse posts reverse_entry', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807 },
      { id: 'l2', account: id('1170'), debit: 807, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
    ];
    const entry = { id: 'je_d', date: '2026-09-30', ref: null, description: 'x', status: 'posted', source: 'manual', reversesEntryId: null, createdAt: '2026-09-30T10:00:00Z' };
    const { dialog, calls, onClose } = await openDrawer(
      {
        get_entry: { status: 200, body: { ok: true, entry, lines } },
        list_agent_sessions: { status: 200, body: { ok: true, sessions: [] } },
        reverse_entry: () => cannedOk('reverse_entry', { ok: true, reversalId: 'je_r' }),
      },
      { mode: 'view', entryId: 'je_d' },
    );
    const table = await within(dialog).findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText(/^1170/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Post reversal' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'reverse_entry')).toMatchObject({ entryId: 'je_d' });
  });
});

describe('critic regressions: drafts keep what was typed', () => {
  it('C9: a grid line with an account but no amount yet survives Save draft (the engine keeps incomplete drafts)', async () => {
    const { dialog, calls, onClose } = await openDrawer({ save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }) });
    await satz(dialog, '6900', '1020', '100.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    // Line 2 balances itself; type its figure so the third line is not the auto line.
    await userEvent.type(within(dialog).getByLabelText('Credit 2'), '100.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Line' }));
    await pickAccount(within(dialog).getByLabelText('Account 3'), '6570');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const lines = sent(calls, 'save_draft').lines as Record<string, unknown>[];
    expect(lines).toContainEqual({ account: id('6570') });
    expect(lines).toHaveLength(3);
  });

  it('C9: a satz with both accounts and no amount yet saves both accounts, with no amount key', async () => {
    const { dialog, calls, onClose } = await openDrawer({ save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }) });
    await pickAccount(await within(dialog).findByLabelText('Debit'), '6500');
    await pickAccount(within(dialog).getByLabelText('Credit'), '1020');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(calls, 'save_draft').lines).toEqual([{ account: id('6500'), taxCode: 'VST-M' }, { account: id('1020') }]);
  });
});

describe('critic regressions: stale answers', () => {
  it('C3: after a date change, lines composed for the OLD date are never saved or posted under the NEW one', async () => {
    const base = composeEngine();
    let release2023: (() => void) | null = null;
    const { dialog, calls, onClose } = await openDrawer({
      compose_entry: (input) => {
        if (String(input.date).startsWith('2023')) {
          return new Promise<RestResponse>((resolve) => {
            release2023 = () => resolve(base(input));
          });
        }
        return base(input);
      },
      save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    await within(dialog).findByText(/of which VAT CHF 8.07/);
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-06-30' } });
    // The 2026 answer is still in hand, but it was composed for another date: no caption, no writes.
    await waitFor(() => expect(within(dialog).queryByText(/of which VAT CHF 8.07/)).toBeNull());
    expect(postButton(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await waitFor(() => expect(release2023).not.toBeNull());
    (release2023 as unknown as () => void)();
    expect(await within(dialog).findByText(/of which VAT CHF 7.70/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const draft = sent(calls, 'save_draft');
    expect(draft.date).toBe('2023-06-30');
    expect((draft.lines as Record<string, unknown>[]).find((l) => l.account === id('1170'))).toEqual({ account: id('1170'), debit: 770 });
  });
});

describe('critic regressions: hidden values never post', () => {
  const noCcOn6500 = CHART.map((a) => (a.number === '6500' ? { ...a, costCenterAllowed: false } : a));
  const vorschlag = (lines: Record<string, unknown>[]): Handlers => ({
    list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: noCcOn6500 }) },
    get_entry: {
      status: 200,
      body: { ok: true, entry: { id: 'je_d', date: '2026-09-30', ref: null, description: 'Vorschlag', status: 'draft', source: 'agent', reversesEntryId: null }, lines },
    },
    ...POST_OK,
  });

  it('C1: a Vorschlag with a cost centre on an account that allows none reopens as a satz WITH the centre on screen', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10770, credit: null, costCenter: 'cc_1' },
      { id: 'l2', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(vorschlag(lines), { mode: 'edit', entryId: 'je_d' });
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    // Visible and removable, though "+ Cost centre" itself is not offered on this account.
    const picker = within(dialog).getByRole('combobox', { name: 'Cost centre' });
    expect(picker).toHaveTextContent('K1 Vertrieb');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    // It posts because it is visible; the person saw it and kept it.
    expect((sent(calls, 'post_entry').lines as Record<string, unknown>[]).find((l) => l.account === id('6500'))?.costCenter).toBe('cc_1');
  });

  it('C1: taken off on screen, it does not post', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10770, credit: null, costCenter: 'cc_1' },
      { id: 'l2', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(vorschlag(lines), { mode: 'edit', entryId: 'je_d' });
    await userEvent.click(await within(dialog).findByRole('combobox', { name: 'Cost centre' }));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === '') as HTMLElement);
    expect(within(dialog).queryByRole('combobox', { name: 'Cost centre' })).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expect((sent(calls, 'post_entry').lines as Record<string, unknown>[]).every((l) => l.costCenter === undefined)).toBe(true);
  });

  it('C1: a cost centre on the counter side cannot be a satz, so it reopens in the grid with the centre captioned', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10770, credit: null },
      { id: 'l2', account: id('1020'), debit: null, credit: 10770, costCenter: 'cc_1' },
    ];
    const { dialog } = await openDrawer(vorschlag(lines), { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 2');
    expect(within(dialog).getByText('Cost centre K1 Vertrieb')).toHaveClass('journal-grid-cc');
    // And it can be taken off from that line's overflow.
    await userEvent.click(within(dialog).getByRole('button', { name: 'More for line 2' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove cost centre' })).toBeInTheDocument();
  });
});

describe('critic regressions: nothing visible is dropped', () => {
  it('C2: an Einfuhrsteuer satz books nothing on the expense, so no cost centre is offered there', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6500', '1020', '50.00');
    expect(within(dialog).getByRole('button', { name: 'Cost centre' })).toBeInTheDocument();
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'IMPORT');
    await within(dialog).findByText('Import VAT CHF 50.00 as input tax');
    expect(within(dialog).queryByRole('button', { name: 'Cost centre' })).toBeNull();
  });

  it('C2: a centre chosen before the code became Einfuhrsteuer is cleared on screen, and the post carries none', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '50.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cost centre' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Cost centre' }));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'cc_1') as HTMLElement);
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'IMPORT');
    await waitFor(() => expect(within(dialog).queryByRole('combobox', { name: 'Cost centre' })).toBeNull());
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const posted = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    expect(posted.every((l) => l.costCenter === undefined)).toBe(true);
  });
});

describe('critic regressions: the Beleg as it stands', () => {
  it('a Beleg removed while the post is in flight is NOT linked to the entry the post answers with', async () => {
    let release: (r: RestResponse) => void = () => undefined;
    let postsAsked = 0;
    const { dialog, calls, onClose } = await openDrawer({
      post_entry: () => {
        postsAsked += 1;
        return new Promise<RestResponse>((r) => {
          release = r;
        });
      },
      files_upload: () => ({ status: 200, body: { ok: true, file: { id: 'file_1' } } }),
      files_link: { status: 200, body: { ok: true } },
    });
    await userEvent.upload(within(dialog).getByTestId('journal-beleg-input'), new File(['%PDF synthetic'], 'beleg-muster.pdf', { type: 'application/pdf' }));
    await satz(dialog, '6900', '1020', '12.00');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    // The post really went out and has not answered yet.
    await waitFor(() => expect(postsAsked).toBe(1));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove receipt beleg-muster.pdf' }));
    release(cannedOk('post_entry', { ok: true, entryId: 'je_new' }) as RestResponse);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((c) => c.action === 'files_link')).toBe(false);
  });
});

describe('C8 (owner, 01.10.2026): Anlagevermögen carries MWST', () => {
  /** The recorded chart exactly as list_accounts sends it: no default codes anywhere. */
  const RECORDED: Handlers = { list_accounts: { status: 200, body: recordedOk(listAccountsFixture) } };

  it('1500 an 1020, 10\'810.00, VST-I: the control is there (empty), and posts 1500 10\'000.00 + 1171 810.00 against 1020', async () => {
    const { dialog, calls, onClose } = await openDrawer({ ...RECORDED, ...POST_OK });
    await satz(dialog, '1500', '1020', "10'810.00");
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'VST-I');
    expect(await within(dialog).findByText("of which VAT CHF 810.00 to 1171 · net CHF 10'000.00")).toBeInTheDocument();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = sent(calls, 'post_entry');
    expect(input.lines).toEqual([
      { account: id('1500'), debit: 1000000, taxCode: 'VST-I', taxBase: 1000000, taxAmount: 81000, supplyDate: input.date },
      { account: id('1171'), debit: 81000 },
      { account: id('1020'), credit: 1081000 },
    ]);
  });

  it('the grid offers the MWST cell on an Anlagekonto too (the critic C8 probe)', async () => {
    const { dialog } = await openDrawer(RECORDED);
    await satz(dialog, '1500', '1020', '2162.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    expect(within(dialog).getByRole('button', { name: /^VAT 1(,|$)/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^VAT 2(,|$)/ })).toBeNull();
  });

  it('a depreciation (6800 an 1510) leaves MWST empty', async () => {
    const { dialog } = await openDrawer(RECORDED);
    await satz(dialog, '6800', '1510', '1200.00');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
    expect(dialog.querySelector('.journal-caption')).toBeNull();
  });

  it('Vorräte carry MWST too (owner, 04.10.2026: asset accounts 12xx or 14xx to 17xx): 1200 an 1020 offers the control', async () => {
    const { dialog } = await openDrawer(RECORDED);
    await satz(dialog, '1200', '1020', '107.70');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toHaveTextContent('Without VAT');
  });

  it('receivables and liquid funds stay without MWST (1100 an 1020)', async () => {
    const { dialog } = await openDrawer(RECORDED);
    await satz(dialog, '1100', '1020', '10.00');
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).toBeNull();
  });

  it('critic L2: a Bankkonto linked to 1500 in a custom chart never offers MWST there; 1510 still does', async () => {
    const BANKS: Handlers = {
      list_bank_accounts: { status: 200, body: { ok: true, bankAccounts: [{ id: 'ba_1', name: 'Konto', ledgerAccountId: id('1500'), archived: false }] } },
    };
    const { dialog } = await openDrawer({ ...RECORDED, ...BANKS });
    await satz(dialog, '1500', '1020', '107.70');
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).toBeNull();
    await satz(dialog, '1510', '1020', '107.70');
    expect(within(dialog).getByRole('button', { name: /^VAT(,|$)/ })).toBeInTheDocument();
  });

  it('Aktive Rechnungsabgrenzung stays without MWST (1300 an 1020: accruals, owner 04.10.2026)', async () => {
    const { dialog } = await openDrawer(RECORDED);
    await satz(dialog, '1300', '1020', '10.00');
    expect(within(dialog).queryByRole('button', { name: /^VAT(,|$)/ })).toBeNull();
  });
});

describe('the MWST trigger shows the code; the label is in its name and its tooltip', () => {
  it('names the code and its label, and the tooltip holds the full label', async () => {
    const { dialog } = await openDrawer();
    await satz(dialog, '6500', '1020', '107.70');
    const trigger = within(dialog).getByRole('button', { name: 'VAT, VST-M Vorsteuer Material, Waren, Dienstleistungen' });
    const wrap = trigger.closest('.journal-tax-tip') as HTMLElement;
    expect(document.getElementById(wrap.getAttribute('aria-describedby') ?? '')).toHaveTextContent('VST-M Vorsteuer Material, Waren, Dienstleistungen');
    // "Ohne MWST" keeps its words and needs no tooltip.
    await pickVat(trigger, '');
    expect(within(dialog).getByRole('button', { name: 'VAT' }).closest('.journal-tax-tip')).toBeNull();
  });
});

describe('critic regressions: a stored Leistungsdatum survives reopen and post', () => {
  it('C10: a straddle draft (supply date 15.12.2023, entry 10.01.2024) reopens and posts at the stored Leistungsdatum and its 7.7% figures', async () => {
    const lines = [
      { id: 'l1', account: id('1100'), debit: 10770, credit: null, supplyDate: null },
      { id: 'l2', account: id('3400'), debit: null, credit: 10000, taxCode: 'UST81', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
      { id: 'l3', account: id('2200'), debit: null, credit: 770, supplyDate: null },
    ];
    const entry = { id: 'je_d', date: '2024-01-10', ref: null, description: 'Dezember-Leistung', status: 'draft', source: 'manual', reversesEntryId: null };
    const { dialog, calls } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry, lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    // It is the satz it was saved as, priced at ITS era, and the Leistungsdatum is on screen.
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    expect(within(dialog).getByText('Supply date 15.12.2023')).toBeInTheDocument();
    expect(await within(dialog).findByText("of which VAT CHF 7.70 to 2200 · net CHF 100.00")).toBeInTheDocument();
    // Every request names the stored Leistungsdatum on the taxed line, so the ENGINE prices it at that era.
    const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => (c.input.lines as Record<string, unknown>[]).find((l) => l.taxCode === 'UST81')?.supplyDate === '2023-12-15')).toBe(true);
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const input = sent(calls, 'post_entry');
    expect(input.date).toBe('2024-01-10');
    expect(input.lines).toEqual([
      { account: id('1100'), debit: 10770 },
      { account: id('3400'), credit: 10000, taxCode: 'UST81', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' },
      { account: id('2200'), credit: 770 },
    ]);
  });

  it('C10: a supply date equal to the entry date is no override and shows nothing', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2026-09-30' },
      { id: 'l2', account: id('1170'), debit: 807, credit: null, supplyDate: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770, supplyDate: null },
    ];
    const entry = { id: 'je_d', date: '2026-09-30', ref: null, description: 'x', status: 'draft', source: 'manual', reversesEntryId: null };
    const { dialog } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines } } }, { mode: 'edit', entryId: 'je_d' });
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    expect(within(dialog).queryByText(/Supply date/)).toBeNull();
  });
});

describe('critic M2: a coded line still waiting for its amount does not lock the manual path', () => {
  const draft = { id: 'je_d', date: '2026-09-30', ref: null, description: 'Büromaterial', status: 'draft', source: 'manual', reversesEntryId: null };

  it('M2: a draft of 6500 VST-M with no amount, completed with 107.70 against 1020, posts the derived 1170 leg', async () => {
    const lines = [{ id: 'l1', account: id('6500'), debit: null, credit: null, taxCode: 'VST-M' }];
    const { dialog, calls } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: draft, lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    await userEvent.type(await within(dialog).findByLabelText('Debit 1'), '107.70');
    await pickAccount(within(dialog).getByLabelText('Account 2'), '1020');
    expect(within(dialog).queryByText('VAT line typed by hand: TILL adds no VAT')).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    expect(sent(calls, 'post_entry').lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2026-09-30' },
      { account: id('1170'), debit: 807 },
      { account: id('1020'), credit: 10770 },
    ]);
  });

  it('M2: a coded line WITH an amount still locks the manual path, even beside one waiting for its amount', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807 },
      { id: 'l2', account: id('6570'), debit: null, credit: null, taxCode: 'VST-M' },
      { id: 'l3', account: id('1020'), debit: null, credit: 9963 },
    ];
    const { dialog } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: draft, lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    expect(await within(dialog).findByText('VAT line typed by hand: TILL adds no VAT')).toBeInTheDocument();
  });
});

describe('critic K3: every content keeps its key for the life of the drawer', () => {
  it('K3: post A lost, B lost, back to A: A goes out under A\'s first key, B under its own', async () => {
    const keys: string[] = [];
    const { dialog } = await openDrawer({
      post_entry: (input) => {
        keys.push(String(input.idempotencyKey));
        return keys.length <= 2 ? { status: 0, body: { ok: false, error: 'transport_error' } } : cannedOk('post_entry', { ok: true, entryId: 'je_a' });
      },
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(keys).toHaveLength(1));
    await userEvent.type(within(dialog).getByLabelText('Description'), 'B');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(keys).toHaveLength(2));
    await userEvent.clear(within(dialog).getByLabelText('Description'));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  it('K3: save_draft A lost, B lost, back to A: A reuses its key, B had its own', async () => {
    const keys: string[] = [];
    const { dialog } = await openDrawer({
      save_draft: (input) => {
        keys.push(String(input.idempotencyKey));
        return keys.length <= 2 ? { status: 0, body: { ok: false, error: 'transport_error' } } : cannedOk('save_draft', { ok: true, entryId: 'je_d' });
      },
    });
    const saveButton = () => within(dialog).getByRole('button', { name: 'Save draft' });
    await satz(dialog, '6900', '1020', '10.00');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await userEvent.click(saveButton());
    await waitFor(() => expect(keys).toHaveLength(1));
    await userEvent.type(within(dialog).getByLabelText('Description'), 'B');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await userEvent.click(saveButton());
    await waitFor(() => expect(keys).toHaveLength(2));
    await userEvent.clear(within(dialog).getByLabelText('Description'));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await userEvent.click(saveButton());
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys.slice(0, 2)).size).toBe(2);
    expect(keys[2]).toBe(keys[0]);
  });
});

describe('D152 amendment: a verbatim reopen whose booking date moves keeps its Leistungsdatum (R6-V)', () => {
  const entry = { id: 'je_d', date: '2026-09-30', ref: null, description: 'Papier', status: 'draft', source: 'agent', reversesEntryId: null };
  // An agent's three-liner whose coded line carries no trace: it does not round-trip (the engine would stamp
  // a trace it lacks), so it reopens VERBATIM; the engine still pairs its 1170 leg, at the gross 107.70.
  const lines = [
    { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M' },
    { id: 'l2', account: id('1170'), debit: 807, credit: null },
    { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
  ];

  // Adjusted for critic R5-S1 and then R6-V (owner, 02.10.2026: keep the stored Leistungsdatum). This test
  // asserted the retired rule, that a moved booking date re-prices the Vorschlag at 7.7%, which the gate
  // refused and "MWST neu berechnen" re-composed. The line stated no supply date, so its stored entry date
  // 30.09.2026 priced it, and that is the date it keeps on the verbatim path too (R6-V): the move is not
  // refused, and the stored lines post with 30.09.2026 stated at 8.1%. (The recompute action is gone,
  // orchestrator 02.10.2026.)
  it('a date moved into the 7.7% era keeps the Vorschlag\'s Leistungsdatum: no refusal, it posts as stored at 8.1%', async () => {
    const { dialog, calls } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines } }, ...POST_OK }, { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 3');
    expect(within(dialog).getByText('VAT line typed by hand: TILL adds no VAT')).toBeInTheDocument();
    // Untouched and on its own date, the stored lines go to the gate verbatim and it takes them.
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());

    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-06-30' } });
    await waitFor(() => {
      const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input;
      expect(asked?.date).toBe('2023-06-30');
    });
    // The stored 8.07 is still right: the line is priced on 30.09.2026, which the row now names.
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    expect(within(dialog).queryByText(/The VAT does not reconcile/)).toBeNull();
    expect(within(dialog).getByLabelText('Account 3')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Supply date 30\.09\.2026$/)).toBeInTheDocument();
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const input = sent(calls, 'post_entry');
    expect(input.date).toBe('2023-06-30');
    expect(input.entryId).toBe('je_d');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2026-09-30' },
      { account: id('1170'), debit: 807 },
      { account: id('1020'), credit: 10770 },
    ]);
  });

  // Orchestrator, 02.10.2026: there is no recompute action. When the gate refuses an untouched verbatim
  // reopen, for whatever reason, the drawer shows the engine's refusal in place and offers nothing special;
  // the person edits the lines, and the engine judges what is then on screen. The reopen stays on the manual
  // path, so the person corrects the amounts as booked.
  it('a refused verbatim reopen shows the refusal in place with no action; editing the taxed line then composes and posts', async () => {
    // An agent booked a 100.03 gross purchase net (92.53, no trace) with the gross split's 7.50 on 1170. Read
    // net-forward, 92.53 prices 7.49 at 8.1%: the gate refuses it on its own date.
    const refusedLines = [
      { id: 'l1', account: id('6500'), debit: 9253, credit: null, taxCode: 'VST-M' },
      { id: 'l2', account: id('1170'), debit: 750, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10003 },
    ];
    const { dialog, calls } = await openDrawer({ get_entry: { status: 200, body: { ok: true, entry, lines: refusedLines } }, ...POST_OK }, { mode: 'edit', entryId: 'je_d' });
    await within(dialog).findByLabelText('Account 3');
    const refusal = await within(dialog).findByText('The VAT does not reconcile: the tagged lines add up to CHF 7.49, but the VAT accounts book CHF 7.50.');
    // In place, and nothing to press inside it: the person edits the lines.
    expect(within(refusal.closest('[role="alert"]') as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(postButton(dialog)).toBeDisabled();
    // The person corrects the taxed line to the net that 7.50 belongs to, and the payment with it.
    await userEvent.clear(within(dialog).getByLabelText('Debit 1'));
    await userEvent.type(within(dialog).getByLabelText('Debit 1'), '92.54');
    await userEvent.clear(within(dialog).getByLabelText('Credit 3'));
    await userEvent.type(within(dialog).getByLabelText('Credit 3'), '100.04');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    expect(within(dialog).queryByText(/The VAT does not reconcile/)).toBeNull();
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const input = sent(calls, 'post_entry');
    expect(input.entryId).toBe('je_d');
    expect(input.lines).toEqual([
      { account: id('6500'), debit: 9254, taxCode: 'VST-M', taxBase: 9254, taxAmount: 750 },
      { account: id('1170'), debit: 750 },
      { account: id('1020'), credit: 10004 },
    ]);
  });
});
