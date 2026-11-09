/**
 * The A1 "Buchungssatz" composer (A02 §6, owner pick 01.10.2026), story by story.
 *
 * Each `describe` is one row of the prototype's "Alle Fälle, die die neue Buchung können muss" list. The
 * money path is proven against the REAL engine in `test/vat/composer-payload.test.mjs` (the payload this
 * drawer posts goes through `postEntry` there, over every code kind and a Rappen sweep). Here the drawer
 * is held to what it SENDS and what it SHOWS: the payload handed to `post_entry` / `save_draft`, the
 * one-line caption, what is hidden, and the five states.
 *
 * D152 amendment (02.10.2026): after the third FAIL the composer's VAT step was rebuilt in the engine.
 * `compose_entry` is answered here by the REAL engine (`app/test-support/composeEngine.ts`), never by a
 * stand-in that derives a figure, and every finding below stays an acceptance test of the rebuilt drawer.
 * Every account, figure and file name is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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

// ======================================================================================================
// CRITIC PROBES (non-author). Each `it` asserts what a correct composer must do; a FAIL is a finding.
// ======================================================================================================

const draftEntry = (over: Record<string, unknown> = {}) => ({
  id: 'je_d', date: '2026-09-30', ref: null, description: 'Vorschlag', status: 'draft', source: 'agent', reversesEntryId: null, ...over,
});

describe('CRITIC: hidden values never post', () => {
  it('C1 an agent Vorschlag carrying a cost centre on an account that allows none: the satz hides it, so it must not post silently', async () => {
    const chart = CHART.map((a) => (a.number === '6500' ? { ...a, costCenterAllowed: false } : a));
    const lines = [
      { id: 'l1', account: id('6500'), debit: 10770, credit: null, costCenter: 'cc_1' },
      { id: 'l2', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls } = await openDrawer(
      {
        list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: chart }) },
        get_entry: { status: 200, body: { ok: true, entry: draftEntry(), lines } },
        ...POST_OK,
      },
      { mode: 'edit', entryId: 'je_d' },
    );
    expect(await within(dialog).findByLabelText('Amount')).toHaveValue('107.70');
    const visible = within(dialog).queryByText(/K1/) !== null;
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    const carries = posted.some((l) => l.costCenter === 'cc_1');
    // Either the cost centre is on screen, or it does not post.
    expect({ visible, carries }).not.toEqual({ visible: false, carries: true });
  });

  it('C2 (r2) a Kostenstelle chosen before the code turns into a deductible Einfuhrsteuer is taken off ON SCREEN, and the post carries none', async () => {
    const { dialog, calls, onClose } = await openDrawer(POST_OK);
    await satz(dialog, '6500', '1020', '50.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cost centre' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Cost centre' }));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'cc_1') as HTMLElement);
    await pickVat(within(dialog).getByRole('button', { name: /^VAT(,|$)/ }), 'IMPORT');
    await waitFor(() => expect(within(dialog).queryByRole('combobox', { name: 'Cost centre' })).toBeNull());
    expect(within(dialog).queryByRole('button', { name: 'Cost centre' })).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const posted = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    expect(posted.some((l) => l.costCenter !== undefined)).toBe(false);
  });
});

describe('CRITIC: stale previews', () => {
  it('C3 a draft saved while the preview for a NEW date is in flight must not store figures priced at the OLD date under the new supply date', async () => {
    // 2023 is the 7.7% era: VST-M on a 107.70 gross splits 7.70 tax / 100.00 net there, 8.07 / 99.63 in 2026.
    const base = composeEngine();
    let oldEraAsked = 0;
    const { dialog, calls, onClose } = await openDrawer({
      compose_entry: (input) => {
        if (String(input.date).startsWith('2023')) {
          oldEraAsked += 1;
          return new Promise<RestResponse>(() => undefined);
        }
        return base(input);
      },
      save_draft: () => cannedOk('save_draft', { ok: true, entryId: 'je_d' }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    await within(dialog).findByText(/of which VAT CHF 8.07/);
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2023-06-30' } });
    // Adopted: the 2023 preview really went out and is held open (the loading-state convention's proof).
    await waitFor(() => expect(oldEraAsked).toBeGreaterThan(0));
    await waitFor(() => expect(postButton(dialog)).toBeDisabled());
    // Round 2: Save draft must hold while the 2023 preview is in flight. If it is enabled, click it.
    const save = within(dialog).getByRole('button', { name: 'Save draft' });
    if (!(save as HTMLButtonElement).disabled) {
      await userEvent.click(save);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    } else {
      expect(calls.some((c) => c.action === 'save_draft')).toBe(false);
      return;
    }
    const draft = sent(calls, 'save_draft');
    const lines = draft.lines as Record<string, unknown>[];
    const vatLeg = lines.find((l) => l.account === id('1170'));
    // Correct: either the undetermined gross shape (no leg yet) or a leg priced for 2023 (770). Never 807 for 2023.
    expect({ date: draft.date, leg: vatLeg?.debit ?? null }).not.toEqual({ date: '2023-06-30', leg: 807 });
  });
});

describe('CRITIC: a stored draft is never re-priced without a touch', () => {
  it('C4 an agent Vorschlag of two coded lines (gross on the revenue, no 2200 leg) must not post a different revenue than stored without the person changing it', async () => {
    const lines = [
      { id: 'l1', account: id('1100'), debit: 10000, credit: null },
      { id: 'l2', account: id('3400'), debit: null, credit: 10000, taxCode: 'UST81' },
    ];
    const { dialog, calls } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: draftEntry(), lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    await within(dialog).findByLabelText('Account 1');
    // Rebuilt (D152 amendment): the stored lines go to the engine VERBATIM, so the revenue it judges is the
    // stored 100.00; the engine reads it as the net base, finds no 2200 leg for its 8.10 and refuses, in
    // place. Nothing posts, and nothing posts a different revenue.
    await waitFor(() => expect(within(dialog).getByText(/The VAT does not reconcile/)).toBeInTheDocument());
    const asked = calls.filter((c) => c.action === 'compose_entry' && c.input.mode === 'expand').at(-1)?.input.lines as Record<string, unknown>[];
    expect(asked.find((l) => l.account === id('3400'))?.credit).toBe(10000);
    expect(postButton(dialog)).toBeDisabled();
    expect(calls.some((c) => c.action === 'post_entry')).toBe(false);
  });
});

describe('CRITIC: writes', () => {
  it('C5 a double click on Post sends ONE post_entry', async () => {
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

  it('C6 view mode of a posted derived entry lists every stored line, VAT leg included, and Reverse posts reverse_entry', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 9963, credit: null, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807 },
      { id: 'l2', account: id('1170'), debit: 807, credit: null },
      { id: 'l3', account: id('1020'), debit: null, credit: 10770 },
    ];
    const { dialog, calls, onClose } = await openDrawer(
      {
        get_entry: { status: 200, body: { ok: true, entry: draftEntry({ status: 'posted', source: 'manual', createdAt: '2026-09-30T10:00:00Z' }), lines } },
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

describe('CRITIC: retry after a lost answer', () => {
  it('C7 a post whose answer is lost (transport_error) and is retried with Post must not book twice', async () => {
    // The "server": it commits every post it receives and replays by idempotency key, as postEntry does.
    const committed = new Map<string, string>();
    let received = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: (input) => {
        received += 1;
        const key = String(input.idempotencyKey);
        if (!committed.has(key)) committed.set(key, `je_${committed.size + 1}`);
        // The first answer is lost on the way back: the entry IS booked, the Studio hears a transport error.
        if (received === 1) {
          return { status: 0, body: { ok: false, error: 'transport_error', detail: 'TypeError: Failed to fetch' } };
        }
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
    // Two distinct keys means two booked entries for one intent.
    expect(committed.size).toBe(1);
  });
});

describe('CRITIC: drafts keep what was typed', () => {
  it('C9 a grid line with an account but no amount yet survives Save draft (the engine keeps incomplete drafts)', async () => {
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
    expect(lines.map((l) => l.account)).toContain(id('6570'));
  });
});

describe('CRITIC: reachability', () => {
  it('C8 an asset purchase with Vorsteuer (1500 an 1020, VST-I) on a chart with no default code offers an MWST control', async () => {
    const chart = listAccountsFixture.accounts; // the recorded chart, as list_accounts sends it: no defaults
    const { dialog } = await openDrawer({ list_accounts: { status: 200, body: recordedOk({ ...listAccountsFixture, accounts: chart }) } });
    await satz(dialog, '1500', '1020', '2162.00');
    const satzControl = within(dialog).queryByRole('button', { name: /^VAT(,|$)/ });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    const gridControl = within(dialog).queryByRole('button', { name: /^VAT 1(,|$)/ });
    expect({ satz: satzControl !== null, grid: gridControl !== null }).not.toEqual({ satz: false, grid: false });
  });
});

// ====================================================================================================
// CRITIC ROUND 2
// ====================================================================================================

describe('CRITIC r2: C7 keys never collide across different content', () => {
  it('K1 a lost post of content A, then an edit to B: B gets a NEW key (else the engine would replay A for B)', async () => {
    let received = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: () => {
        received += 1;
        if (received === 1) return { status: 0, body: { ok: false, error: 'transport_error', detail: 'lost' } };
        return cannedOk('post_entry', { ok: true, entryId: 'je_b' });
      },
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1));
    await userEvent.type(within(dialog).getByLabelText('Description'), 'B');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.action === 'post_entry').map((c) => c.input.idempotencyKey);
    expect(a).not.toBe(b);
  });

  it('K2 a refused post (period_locked) of A, then the date moved: the retry is new content and a new key', async () => {
    let received = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: () => {
        received += 1;
        if (received === 1) return { status: 409, body: { ok: false, error: 'period_locked', period: '2026-10' } };
        return cannedOk('post_entry', { ok: true, entryId: 'je_b' });
      },
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await userEvent.click(await within(dialog).findByRole('button', { name: /date/i }));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.action === 'post_entry');
    expect(a?.input.date).not.toBe(b?.input.date);
    expect(a?.input.idempotencyKey).not.toBe(b?.input.idempotencyKey);
  });

  it('K3 lost post of A, click on B (also lost), back to A and Post: A must not be booked a second time', async () => {
    const committed = new Map<string, string>();
    let received = 0;
    const { dialog, calls } = await openDrawer({
      post_entry: (input) => {
        received += 1;
        const key = String(input.idempotencyKey);
        if (!committed.has(key)) committed.set(key, JSON.stringify(input.lines) + String(input.description ?? ''));
        if (received <= 2) return { status: 0, body: { ok: false, error: 'transport_error', detail: 'lost' } };
        return cannedOk('post_entry', { ok: true, entryId: 'je_x' });
      },
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1));
    await userEvent.type(within(dialog).getByLabelText('Description'), 'B');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    await userEvent.clear(within(dialog).getByLabelText('Description'));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(3));
    const contents = [...committed.values()];
    expect(new Set(contents).size).toBe(contents.length);
  });
});

describe('CRITIC r2: C4 manual path', () => {
  it('M1 a reopened Aufteilen draft (gross-split trace, 1170 = 0.07 on a 1.00 gross) re-sends the stored trace, not a net-forward one the engine refuses', async () => {
    // A1 derived 6500 VST-M at gross 1.00: tax 0.07 (gross split), net 0.93. Net-forward on 0.93 is 0.08.
    const lines = [
      { id: 'l1', account: id('6500'), debit: 93, credit: null, taxCode: 'VST-M', taxBase: 93, taxAmount: 7, supplyDate: '2026-09-30' },
      { id: 'l2', account: id('1170'), debit: 7, credit: null },
      { id: 'l3', account: id('6570'), debit: 1000, credit: null },
      { id: 'l4', account: id('1020'), debit: null, credit: 1100 },
    ];
    const { dialog, calls } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: draftEntry({ source: 'manual' }), lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    // Rebuilt (D152 amendment): the engine decomposes the draft (it round-trips), so it reopens as the
    // DERIVED grid, its 1170 leg folded back into the 1.00 gross line: three rows, not four.
    await within(dialog).findByLabelText('Account 3');
    expect(within(dialog).queryByLabelText('Account 4')).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    const tagged = posted.filter((l) => l.taxCode !== undefined);
    expect(tagged).toHaveLength(1);
    // postEntry recomputes 0.08 from the 0.93 base and accepts 0.07 only as the hint: anything but 7 is refused.
    expect(tagged[0]?.taxAmount).toBe(7);
  });

  it('M2 a satz draft saved before its amount was typed (6500 with its code, no amount) still derives once the amount is typed', async () => {
    const lines = [{ id: 'l1', account: id('6500'), debit: null, credit: null, taxCode: 'VST-M' }];
    const { dialog, calls } = await openDrawer(
      { get_entry: { status: 200, body: { ok: true, entry: draftEntry({ source: 'manual' }), lines } }, ...POST_OK },
      { mode: 'edit', entryId: 'je_d' },
    );
    await userEvent.type(await within(dialog).findByLabelText('Debit 1'), '107.70');
    await pickAccount(within(dialog).getByLabelText('Account 2'), '1020');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.some((c) => c.action === 'post_entry')).toBe(true));
    const posted = sent(calls, 'post_entry').lines as Record<string, unknown>[];
    // The A1 grid is gross: 6500 99.63 + 1170 8.07 against 1020 107.70. On the manual path 107.70 is read as
    // net with no 1170 leg, which the engine refuses.
    expect(posted.some((l) => l.account === id('1170'))).toBe(true);
  });
});

// ====================================================================================================
// CRITIC ROUND 3
// ====================================================================================================

describe('CRITIC r3: the M1 residual', () => {
  it('R3a a reopened Aufteilen draft refused for a locked period, moved by "Change the booking date" (same 8.1% era), re-sends the stored 0.07', async () => {
    const lines = [
      { id: 'l1', account: id('6500'), debit: 93, credit: null, taxCode: 'VST-M', taxBase: 93, taxAmount: 7, supplyDate: '2026-09-30' },
      { id: 'l2', account: id('1170'), debit: 7, credit: null },
      { id: 'l3', account: id('6570'), debit: 1000, credit: null },
      { id: 'l4', account: id('1020'), debit: null, credit: 1100 },
    ];
    let received = 0;
    const { dialog, calls } = await openDrawer(
      {
        get_entry: { status: 200, body: { ok: true, entry: draftEntry({ source: 'manual' }), lines } },
        post_entry: () => {
          received += 1;
          if (received === 1) return { status: 409, body: { ok: false, error: 'period_locked', period: '2026-09' } };
          return cannedOk('post_entry', { ok: true, entryId: 'je_d' });
        },
      },
      { mode: 'edit', entryId: 'je_d' },
    );
    // Rebuilt (D152 amendment): the engine decomposes the draft (it round-trips), so it reopens as the
    // DERIVED grid, its 1170 leg folded back into the 1.00 gross line: three rows, not four.
    await within(dialog).findByLabelText('Account 3');
    expect(within(dialog).queryByLabelText('Account 4')).toBeNull();
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Change the booking date' }));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    const second = calls.filter((c) => c.action === 'post_entry')[1]?.input as Record<string, unknown>;
    expect(second.date).toBe('2026-10-01');
    const tagged = (second.lines as Record<string, unknown>[]).filter((l) => l.taxCode !== undefined);
    // 1170 still books 0.07: the engine accepts 7 as the gross-split hint at 8.1%, and refuses 8.
    expect(tagged[0]?.taxAmount).toBe(7);
  });
});

describe('CRITIC r3: K3 keys by content', () => {
  it('K4 a lost post of A, then the Referenz changed: a new key; the Referenz removed again: A\'s key', async () => {
    const { dialog, calls } = await openDrawer({
      post_entry: () => ({ status: 0, body: { ok: false, error: 'transport_error', detail: 'lost' } }),
    });
    await satz(dialog, '6500', '1020', '107.70');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(1));
    await userEvent.click(within(dialog).getByRole('button', { name: /Reference/ }));
    await userEvent.type(within(dialog).getByLabelText('Reference'), 'R-1');
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(2));
    await userEvent.clear(within(dialog).getByLabelText('Reference'));
    await waitFor(() => expect(postButton(dialog)).toBeEnabled());
    await userEvent.click(postButton(dialog));
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_entry')).toHaveLength(3));
    const keys = calls.filter((c) => c.action === 'post_entry').map((c) => c.input.idempotencyKey);
    const refs = calls.filter((c) => c.action === 'post_entry').map((c) => c.input.ref ?? null);
    expect(refs).toEqual([null, 'R-1', null]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });
});
