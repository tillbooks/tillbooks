/**
 * A38, the accrual and provision editor: the five states, the live lines, the reason picker, the
 * posting list and the permission padlock, against a recorded transport.
 *
 * The engine is never imported here (the browser bundle cannot load it); the transport answers the
 * verbs with the shapes `accrual_list` / `provision_list` / `accrual_create` really send (the field
 * names are the ones `src/core/accruals/accrual.ts` declares), and every write is asserted by the
 * input the component actually sent: integer Rappen, the account ID the picker chose, the period end.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { AccrualEditor } from './AccrualEditor';
import { ACCRUAL_KINDS, ACCRUAL_KIND_RULES, bookingLineOf, parseAmountToMinor, previewAccrualLines, previewProvisionLines, type AccrualKind, type PreviewLine } from './accrual-model';
import { formatDate, formatMoney } from '../../i18n';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { watchReads } from '../../test-transport';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

/** The chart is the PINNED recording of `list_accounts` (never a literal), and ids resolve by number. */
const ACCOUNTS: RestResponse = { status: 200, body: { ...listAccountsFixture, ok: true as const } };
function idOf(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}

/**
 * Open a migrated shared <Select> combobox and click the option carrying `value`. The listbox is
 * portaled to <body>, so the option is read from `screen` by its data-value, not from the trigger.
 */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  combo: HTMLElement,
  value: string,
): Promise<void> {
  await user.click(combo);
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === value);
  if (option === undefined) throw new Error(`no option with data-value ${value}`);
  await user.click(option);
}

const NO_ACCRUALS: RestResponse = { status: 200, body: { ok: true, accruals: [], totalMinor: 0, baseCurrency: 'CHF' } };
const NO_PROVISIONS: RestResponse = { status: 200, body: { ok: true, provisions: [], openTotalMinor: 0 } };

function accrualRow(over: Record<string, unknown> = {}) {
  return {
    id: 'accrual_1',
    kind: 'accrued_expense',
    periodEnd: '2026-06-30',
    reversalDate: '2026-07-01',
    amountMinor: 180000,
    contraAccountNumber: '6500',
    contraAccountName: 'Verwaltungs- und Bürokosten',
    balanceAccountNumber: '2300',
    description: 'Strom Juni',
    status: 'draft',
    entryId: null,
    reversalEntryId: null,
    stornoEntryId: null,
    ...over,
  };
}

function renderEditor(handlers: Handlers, opts: { canPost?: boolean } = {}) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const merged: Handlers = {
    list_accounts: ACCOUNTS,
    accrual_list: NO_ACCRUALS,
    provision_list: NO_PROVISIONS,
    ...handlers,
  };
  const base: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = merged[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const transport = watchReads(base);
  const client = new TillClient(transport);
  const utils = render(
    <TillClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter>
          <AccrualEditor workspaceId="ws_test" periodEnd="2026-06-30" {...(opts.canPost !== undefined ? { canPost: opts.canPost } : {})} />
        </MemoryRouter>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, calls, transport };
}

describe('AccrualEditor, the model', () => {
  it('parses francs to integer Rappen exactly and refuses what is not money', () => {
    expect(parseAmountToMinor('1800')).toBe(180000);
    expect(parseAmountToMinor("1'800.50")).toBe(180050);
    expect(parseAmountToMinor('1 800,05')).toBe(180005);
    expect(parseAmountToMinor('0.1')).toBe(10);
    expect(parseAmountToMinor('0')).toBeNull();
    expect(parseAmountToMinor('-5')).toBeNull();
    expect(parseAmountToMinor('1.234')).toBeNull();
    expect(parseAmountToMinor('abc')).toBeNull();
  });

  it('previews the four kinds on their statutory accounts and mirrors them the day after', () => {
    const recorded = (number: string) => {
      const row = listAccountsFixture.accounts.find((a) => a.number === number);
      if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
      return row;
    };
    const contra = recorded('6500');
    const balance = recorded('2300');
    const { lines, reversalLines } = previewAccrualLines('accrued_expense', 180000, contra, balance, '2026-06-30');
    expect(lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor, l.date])).toEqual([
      ['6500', 180000, 0, '2026-06-30'],
      ['2300', 0, 180000, '2026-06-30'],
    ]);
    expect(reversalLines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor, l.date])).toEqual([
      ['6500', 0, 180000, '2026-07-01'],
      ['2300', 180000, 0, '2026-07-01'],
    ]);
    const active = previewAccrualLines('prepaid_expense', 500, contra, recorded('1300'), '2026-12-31');
    expect(active.lines[0]?.accountNumber).toBe('1300');
    expect(active.lines[0]?.debitMinor).toBe(500);
    expect(active.reversalLines[0]?.date).toBe('2027-01-01');
  });
});

describe('AccrualEditor, five states', () => {
  it('LOADING: renders the skeleton while the accrual list is in flight', async () => {
    const { transport } = renderEditor({ accrual_list: () => new Promise<RestResponse>(() => {}) });
    await transport.started('accrual_list');
    const panel = screen.getByRole('region', { name: /Accruals and provisions as of/ });
    expect(within(panel).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('EMPTY: one quiet line under the head, and the head is the only way in (D152 rules 3 and 4)', async () => {
    renderEditor({});
    const line = await screen.findByText('No accrual or provision recorded yet.');
    // One line, one sentence: no title-and-hint empty block, no explainer.
    expect(line.tagName).toBe('P');
    expect(line).toHaveClass('accrual-empty');
    // ONE create per kind: the head's two buttons. The empty state used to add a second "New accrual".
    expect(screen.getAllByRole('button', { name: 'New accrual' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'New provision' })).toHaveLength(1);
    expect(screen.queryByText(/Record an accrual or a provision/)).toBeNull();
  });

  it('ERROR: shows the banner with a retry that asks the engine again', async () => {
    let failures = 0;
    const { calls } = renderEditor({
      accrual_list: () => {
        failures += 1;
        return failures === 1
          ? { status: 500, body: { ok: false, error: 'unexpected_error' } }
          : NO_ACCRUALS;
      },
    });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    expect(await screen.findByText('No accrual or provision recorded yet.')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'accrual_list').length).toBe(2);
  });

  it('PERMISSION-DENIED: without `post` the two entry points are disabled and the reason names the right', async () => {
    renderEditor({}, { canPost: false });
    await screen.findByText('No accrual or provision recorded yet.');
    const newAccrual = screen.getByRole('button', { name: /New accrual/ });
    expect(newAccrual).toBeDisabled();
    expect(screen.getByRole('button', { name: /New provision/ })).toBeDisabled();
    expect(screen.getByText(/needs the “Post” right \(post\)/)).toBeInTheDocument();
    expect(newAccrual).toHaveAccessibleDescription(/needs the “Post” right/);
  });

  it('AT-SCALE: twenty drafts render as twenty rows with one "Post all" naming count and total', async () => {
    const accruals = Array.from({ length: 20 }, (_, i) => accrualRow({ id: `accrual_${i}`, description: `Entwurf ${i}`, amountMinor: 1000 }));
    renderEditor({ accrual_list: { status: 200, body: { ok: true, accruals, totalMinor: 20000 } } });
    const table = await screen.findByRole('table', { name: 'Accruals' });
    expect(within(table).getAllByRole('button', { name: 'Post' })).toHaveLength(20);
    expect(screen.getByRole('button', { name: /Post all \(20, / })).toBeInTheDocument();
  });

  it('has no axe violations in the listed state', async () => {
    const { container } = renderEditor({
      accrual_list: { status: 200, body: { ok: true, accruals: [accrualRow()], totalMinor: 180000 } },
    });
    await screen.findByRole('table', { name: 'Accruals' });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AccrualEditor, the drawer', () => {
  it('renders the lines as you type, then saves a DRAFT with integer Rappen and the picked account', async () => {
    const user = userEvent.setup();
    let listed: RestResponse = NO_ACCRUALS;
    const { calls } = renderEditor({
      accrual_list: () => listed,
      accrual_create: (input) => {
        listed = { status: 200, body: { ok: true, accruals: [accrualRow({ amountMinor: input.amountMinor as number })], totalMinor: input.amountMinor as number } };
        return { status: 200, body: { ok: true, accrual: accrualRow(), lines: [], reversalLines: [] } };
      },
    });
    await screen.findByText('No accrual or provision recorded yet.');
    await user.click(screen.getByRole('button', { name: 'New accrual' }));
    const dialog = await screen.findByRole('dialog', { name: 'New accrual' });

    // The kind picker carries the four kinds, each explainer behind its (i) (D152 rule 4): the
    // sentence is the (i)'s real tooltip and the radio's description, never a visible line.
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    // Two of the four kinds are passive and say so (accrued expense, deferred income).
    const descriptionOf = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(radios.filter((r) => descriptionOf(r).includes('credit 2300'))).toHaveLength(2);
    expect(within(dialog).getByRole('radio', { name: 'Accrued expense' })).toHaveAccessibleDescription(/You consumed, but the bill arrives in the next period \(credit 2300\)\./);
    const info = within(dialog).getByRole('button', { name: 'What does “Prepaid expense” mean?' });
    expect(info).toHaveAccessibleDescription('You paid, but the service belongs to the next period (debit 1300).');
    // At rest no explainer is on screen: the tooltip is closed and the radio's copy is hidden.
    for (const tip of within(dialog).getAllByRole('tooltip', { hidden: true })) expect(tip).not.toHaveClass('is-open');
    await user.hover(info);
    expect(within(dialog).getAllByRole('tooltip', { hidden: true }).filter((tip) => tip.classList.contains('is-open'))).toHaveLength(1);
    await user.unhover(info);
    // The (i) buttons, the hidden copies and the radios they describe pass axe inside the open drawer.
    expect(await axe(dialog)).toHaveNoViolations();

    await user.type(within(dialog).getByLabelText(/Amount/), "1'800.50");
    await waitFor(() => expect(within(dialog).getByLabelText(/Contra account/)).not.toBeDisabled());
    await chooseOption(user, within(dialog).getByLabelText(/Contra account/), idOf('6500'));
    await user.type(within(dialog).getByLabelText('Description'), 'Strom Juni');

    // The live booking, in ONE line (D152 rule 4): no table, the period-end booking and its reversal date.
    const preview = within(dialog).getByTestId('accrual-preview');
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(preview.textContent).toBe("Posts on 30.06.2026: 6500 Verwaltungs- und Bürokosten to 2300 Passive Rechnungsabgrenzung · CHF 1'800.50 · Reversal on 01.07.2026");

    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const create = await waitFor(() => {
      const c = calls.find((x) => x.action === 'accrual_create');
      expect(c).toBeDefined();
      return c as { action: string; input: Record<string, unknown> };
    });
    expect(create.input).toMatchObject({
      workspaceId: 'ws_test',
      kind: 'accrued_expense',
      periodEnd: '2026-06-30',
      amountMinor: 180050,
      contraAccount: idOf('6500'),
      description: 'Strom Juni',
    });
    expect(typeof create.input.idempotencyKey).toBe('string');
    // The draft lands in the list with its Post control; the drawer is gone.
    const table = await screen.findByRole('table', { name: 'Accruals' });
    expect(within(table).getByRole('button', { name: 'Post' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New accrual' })).toBeNull();
  });

  it('shows an invalid_account refusal next to the account field and keeps the values', async () => {
    const user = userEvent.setup();
    renderEditor({
      accrual_create: { status: 200, body: { ok: false, error: 'invalid_account', reason: 'kind_account_type_mismatch' } },
    });
    await screen.findByText('No accrual or provision recorded yet.');
    await user.click(screen.getAllByRole('button', { name: 'New accrual' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New accrual' });
    await user.type(within(dialog).getByLabelText(/Amount/), '100');
    await waitFor(() => expect(within(dialog).getByLabelText(/Contra account/)).not.toBeDisabled());
    await chooseOption(user, within(dialog).getByLabelText(/Contra account/), idOf('6500'));
    await user.type(within(dialog).getByLabelText('Description'), 'Test');
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/does not fit the chosen kind/);
    expect(within(dialog).getByLabelText(/Contra account/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue('100');
  });

  it('the provision drawer offers the eight Art. 960e reasons and saves a provision draft', async () => {
    const user = userEvent.setup();
    const { calls } = renderEditor({
      provision_create: { status: 200, body: { ok: true, provision: {}, lines: [] } },
    });
    await screen.findByText('No accrual or provision recorded yet.');
    await user.click(screen.getByRole('button', { name: /New provision/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New provision' });
    const reason = within(dialog).getByRole('combobox', { name: /Reason/ });
    await user.click(reason);
    expect(within(screen.getByRole('listbox', { name: /Reason/ })).getAllByRole('option')).toHaveLength(8);
    await user.click(screen.getByRole('option', { name: 'Litigation' }));
    // The reason's explainer sits behind its (i) and describes the picker; it is not a visible line.
    expect(within(dialog).getByRole('combobox', { name: /Reason/ })).toHaveAccessibleDescription('Pending proceedings expected to cost money.');
    expect(within(dialog).getByRole('button', { name: 'What does “Litigation” mean?' })).toHaveAccessibleDescription('Pending proceedings expected to cost money.');
    await user.type(within(dialog).getByLabelText(/Amount/), '5000');
    await waitFor(() => expect(within(dialog).getByLabelText(/Expense account/)).not.toBeDisabled());
    await chooseOption(user, within(dialog).getByLabelText(/Expense account/), idOf('6800'));
    await user.type(within(dialog).getByLabelText('Description'), 'Streitfall Lieferant');
    // A provision has no reversal, so its one line carries none.
    expect(within(dialog).getByTestId('accrual-preview')).toHaveTextContent(/^Posts on 30\.06\.2026: 6800 .+ to 2330 .+ · CHF 5'000\.00$/);
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'provision_create')).toBe(true));
    const create = calls.find((c) => c.action === 'provision_create') as { input: Record<string, unknown> };
    expect(create.input).toMatchObject({
      reason: 'prozess',
      periodEnd: '2026-06-30',
      amountMinor: 500000,
      provisionAccount: idOf('2330'),
      expenseAccount: idOf('6800'),
      description: 'Streitfall Lieferant',
    });
  });
});

/**
 * D152 rule 4 (cognitive-load pass B3): the drawer's "Entry at period end" table became ONE line. The
 * line must state EXACTLY what the table stated, so each case below rebuilds the old table's cells
 * from the very source the table rendered (`previewAccrualLines` over the recorded chart, the account
 * cell as "number name" or "Pick an account", money only where the side carries a figure, the date
 * through formatDate, the reversal table captioned "Reversal on {day after}") and derives the sentence
 * from those CELLS, independently of `bookingLineOf`. Then the rendered line has to match it.
 */
describe('AccrualEditor, the one-line booking (D152)', () => {
  const PERIOD_END = '2026-06-30';
  const recorded = (number: string) => {
    const row = listAccountsFixture.accounts.find((a) => a.number === number);
    if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
    return row;
  };
  /** The first contra the drawer's picker offers for a kind: the chart's first live account of the rule's type. */
  const firstContra = (kind: AccrualKind) =>
    [...listAccountsFixture.accounts]
      .filter((a) => a.type === ACCRUAL_KIND_RULES[kind].contraType && a.archived !== true)
      .sort((a, b) => (a.number < b.number ? -1 : 1))[0] as (typeof listAccountsFixture.accounts)[number];

  /** The old table's cells, exactly as `renderLines` printed them. */
  const cells = (lines: PreviewLine[]) =>
    lines.map((l) => ({
      account: l.accountNumber === '' ? 'Pick an account' : `${l.accountNumber} ${l.accountName}`,
      debit: l.debitMinor > 0 ? formatMoney(l.debitMinor, 'CHF') : '',
      credit: l.creditMinor > 0 ? formatMoney(l.creditMinor, 'CHF') : '',
      date: formatDate(l.date),
    }));

  /** The sentence the old table's cells say: the Soll row, the Haben row, the one figure, the reversal date. */
  function sentenceOfTable(kind: AccrualKind, amountMinor: number, contra: { number: string; name: string } | null): string {
    const balanceNumber = ACCRUAL_KIND_RULES[kind].balanceNumber;
    const { lines, reversalLines } = previewAccrualLines(kind, amountMinor, contra === null ? null : { ...recorded(contra.number), archived: false }, { ...recorded(balanceNumber), archived: false }, PERIOD_END);
    const table = cells(lines);
    const reversal = cells(reversalLines);
    // What the table showed: one date, two rows, the same figure once as Soll and once as Haben.
    expect(new Set(table.map((r) => r.date)).size).toBe(1);
    const sollRow = amountMinor > 0 ? table.find((r) => r.debit !== '') : table[0];
    const habenRow = amountMinor > 0 ? table.find((r) => r.credit !== '') : table[1];
    if (sollRow === undefined || habenRow === undefined) throw new Error('the table had no Soll or Haben row');
    expect(sollRow.debit).toBe(habenRow.credit);
    // The reversal table was the mirror, dated the day after: the line says it as "Reversal on {date}".
    expect(reversal.map((r) => [r.account, r.debit, r.credit])).toEqual(table.map((r) => [r.account, r.credit, r.debit]));
    const reversalDate = reversal[0]?.date as string;
    expect(reversal.every((r) => r.date === reversalDate)).toBe(true);
    const figure = sollRow.debit === '' ? '' : ` · ${sollRow.debit}`;
    return `Posts on ${table[0]?.date}: ${sollRow.account} to ${habenRow.account}${figure} · Reversal on ${reversalDate}`;
  }

  for (const kind of ACCRUAL_KINDS) {
    it(`${kind}: the line states exactly what the table stated, before and after the amount and the account`, async () => {
      const user = userEvent.setup();
      renderEditor({});
      await screen.findByText('No accrual or provision recorded yet.');
      await user.click(screen.getByRole('button', { name: 'New accrual' }));
      const dialog = await screen.findByRole('dialog', { name: 'New accrual' });
      await user.click(within(dialog).getAllByRole('radio')[ACCRUAL_KINDS.indexOf(kind)] as HTMLElement);
      const line = within(dialog).getByTestId('accrual-preview');
      // At rest: no amount, no contra. The table showed "Pick an account" and blank money cells.
      expect(line.textContent).toBe(sentenceOfTable(kind, 0, null));
      // Filled: an amount with Rappen and the picker's first contra of the kind's type.
      await user.type(within(dialog).getByLabelText(/Amount/), "1'234.55");
      await waitFor(() => expect(within(dialog).getByLabelText(/Contra account/)).not.toBeDisabled());
      const contra = firstContra(kind);
      await chooseOption(user, within(dialog).getByLabelText(/Contra account/), contra.id);
      const expected = sentenceOfTable(kind, 123455, contra);
      expect(line.textContent).toBe(expected);
      // And the pure helper reads the same lines the same way (Soll, Haben, figure, reversal date).
      const { lines, reversalLines } = previewAccrualLines(kind, 123455, { ...contra, archived: false }, { ...recorded(ACCRUAL_KIND_RULES[kind].balanceNumber), archived: false }, PERIOD_END);
      const b = bookingLineOf(lines, reversalLines);
      expect(b?.amountMinor).toBe(123455);
      expect(b?.date).toBe(PERIOD_END);
      expect(b?.reversalDate).toBe('2026-07-01');
      expect(ACCRUAL_KIND_RULES[kind].balanceSide === 'debit' ? b?.debit.accountNumber : b?.credit.accountNumber).toBe(ACCRUAL_KIND_RULES[kind].balanceNumber);
    });
  }

  it('a provision states its formation booking (Soll expense, Haben provision) with no reversal', () => {
    const expense = { ...recorded('6800'), archived: false };
    const provision = { ...recorded('2330'), archived: false };
    const lines = previewProvisionLines(500000, provision, expense, PERIOD_END);
    const table = cells(lines);
    const b = bookingLineOf(lines, []);
    expect(b).not.toBeNull();
    expect(`${b?.debit.accountNumber} ${b?.debit.accountName}`).toBe(table.find((r) => r.debit !== '')?.account);
    expect(`${b?.credit.accountNumber} ${b?.credit.accountName}`).toBe(table.find((r) => r.credit !== '')?.account);
    expect(formatMoney(b?.amountMinor ?? 0, 'CHF')).toBe(table[0]?.debit);
    expect(b?.reversalDate).toBeNull();
  });
});

describe('AccrualEditor, the list posts', () => {
  it('posts a draft behind the confirm and renders the posted row with both entry ids and the reversal date', async () => {
    const user = userEvent.setup();
    let listed: RestResponse = { status: 200, body: { ok: true, accruals: [accrualRow()], totalMinor: 180000 } };
    const { calls } = renderEditor({
      accrual_list: () => listed,
      accrual_post: () => {
        listed = { status: 200, body: { ok: true, accruals: [accrualRow({ status: 'posted', entryId: 'entry_a', reversalEntryId: 'entry_b' })], totalMinor: 180000 } };
        return { status: 200, body: { ok: true, accrualId: 'accrual_1', entryId: 'entry_a', reversalEntryId: 'entry_b', reversalDate: '2026-07-01', accrual: accrualRow({ status: 'posted' }) } };
      },
    });
    const table = await screen.findByRole('table', { name: 'Accruals' });
    await user.click(within(table).getByRole('button', { name: 'Post' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Post the accrual?' });
    await user.click(within(confirm).getByRole('button', { name: 'Post' }));

    const post = await waitFor(() => {
      const c = calls.find((x) => x.action === 'accrual_post');
      expect(c).toBeDefined();
      return c as { input: Record<string, unknown> };
    });
    expect(post.input).toMatchObject({ workspaceId: 'ws_test', accrualId: 'accrual_1' });
    const success = await screen.findByTestId('accrual-posted');
    expect(success).toHaveTextContent('Posted: entry_a.');
    expect(success).toHaveTextContent('entry_b');
    // The row now reads posted and offers the Storno, not a second post.
    const posted = await screen.findByRole('table', { name: 'Accruals' });
    expect(within(posted).getByRole('button', { name: 'Undo (reversal)' })).toBeInTheDocument();
    expect(within(posted).queryByRole('button', { name: 'Post' })).toBeNull();
  });

  it('an already_posted refusal is a quiet badge on the row, and a locked period is a banner naming the date', async () => {
    const user = userEvent.setup();
    const drafts = [accrualRow({ id: 'a1', description: 'Eins' }), accrualRow({ id: 'a2', description: 'Zwei' })];
    renderEditor({
      accrual_list: { status: 200, body: { ok: true, accruals: drafts, totalMinor: 360000 } },
      accrual_post: (input) =>
        input.accrualId === 'a1'
          ? { status: 200, body: { ok: false, error: 'already_posted', entryId: 'entry_x' } }
          : { status: 200, body: { ok: false, error: 'period_locked', date: '2026-07-01', leg: 'reversal' } },
    });
    const table = await screen.findByRole('table', { name: 'Accruals' });
    const buttons = within(table).getAllByRole('button', { name: 'Post' });
    await user.click(buttons[0] as HTMLElement);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('already posted')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(within(screen.getByRole('table', { name: 'Accruals' })).getAllByRole('button', { name: 'Post' })[1] as HTMLElement);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/is locked, so nothing was posted/);
    expect(banner).toHaveTextContent(/2026/);
  });

  it('"Post all" posts one by one and reports the half-done state when one is refused', async () => {
    const user = userEvent.setup();
    const drafts = ['a1', 'a2', 'a3'].map((id) => accrualRow({ id, description: id, amountMinor: 1000 }));
    const { calls } = renderEditor({
      accrual_list: { status: 200, body: { ok: true, accruals: drafts, totalMinor: 3000 } },
      accrual_post: (input) =>
        input.accrualId === 'a2'
          ? { status: 200, body: { ok: false, error: 'period_locked', date: '2026-06-30' } }
          : { status: 200, body: { ok: true, accrualId: input.accrualId, entryId: 'e', reversalEntryId: 'r', reversalDate: '2026-07-01', accrual: accrualRow() } },
    });
    await screen.findByRole('table', { name: 'Accruals' });
    await user.click(screen.getByRole('button', { name: /Post all \(3, / }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Post 3 drafts?' });
    await user.click(within(confirm).getByRole('button', { name: 'Post all' }));
    const summary = await screen.findByTestId('accrual-batch');
    expect(summary).toHaveTextContent('1 posted, 1 refused, 1 still waiting.');
    expect(summary).toHaveTextContent('period_locked');
    expect(calls.filter((c) => c.action === 'accrual_post')).toHaveLength(2);
  });

  it('"Post all" counts an already_posted draft as done and goes on to the rest; the summary reads the truth', async () => {
    const user = userEvent.setup();
    const drafts = ['a1', 'a2', 'a3'].map((id) => accrualRow({ id, description: id, amountMinor: 1000 }));
    const { calls } = renderEditor({
      accrual_list: { status: 200, body: { ok: true, accruals: drafts, totalMinor: 3000 } },
      accrual_post: (input) =>
        input.accrualId === 'a2'
          ? { status: 200, body: { ok: false, error: 'already_posted', accrualId: 'a2', entryId: 'entry_x' } }
          : { status: 200, body: { ok: true, accrualId: input.accrualId, entryId: 'e', reversalEntryId: 'r', reversalDate: '2026-07-01', accrual: accrualRow() } },
    });
    await screen.findByRole('table', { name: 'Accruals' });
    await user.click(screen.getByRole('button', { name: /Post all \(3, / }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Post 3 drafts?' });
    await user.click(within(confirm).getByRole('button', { name: 'Post all' }));
    const summary = await screen.findByTestId('accrual-batch');
    expect(summary).toHaveTextContent('2 posted, 0 refused, 0 still waiting.');
    expect(summary).toHaveTextContent('1 already posted.');
    expect(summary).not.toHaveTextContent('Refusal');
    expect(calls.filter((c) => c.action === 'accrual_post')).toHaveLength(3);
  });
});

describe('AccrualEditor, the release undo (D129 leg 2)', () => {
  it('lists a provision\'s releases and reverses one through provision_release_reverse behind the confirm', async () => {
    const user = userEvent.setup();
    const released = { id: 'prov_1', reason: 'garantie', periodEnd: '2026-06-30', amountMinor: 500000, provisionAccountNumber: '2330', expenseAccountNumber: '6800', expenseAccountName: 'Garantie', description: 'Garantiefälle', status: 'posted', entryId: 'entry_p', reversalEntryId: null, openBalanceMinor: 300000 };
    const { calls } = renderEditor({
      provision_list: { status: 200, body: { ok: true, provisions: [released], openTotalMinor: 300000, baseCurrency: 'CHF' } },
      provision_get: { status: 200, body: { ok: true, provision: released, lines: [], openBalanceMinor: 300000, releases: [{ id: 'rel_1', provisionId: 'prov_1', date: '2026-07-01', amountMinor: 200000, targetAccountNumber: '6800', entryId: 'entry_r', reversedByEntryId: null, createdBy: 'studio', createdAt: '2026-07-01T00:00:00.000Z' }] } },
      provision_release_reverse: { status: 200, body: { ok: true, releaseId: 'rel_1', reversalEntryId: 'entry_rr' } },
    });
    const table = await screen.findByRole('table', { name: 'Provisions' });
    // K-21: a provision's verbs sit behind its one overflow.
    await user.click(within(table).getByRole('button', { name: 'Actions for Garantiefälle' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Releases' }));
    const dialog = await screen.findByRole('dialog', { name: 'Releases of "Garantiefälle"' });
    expect(within(dialog).getByText(/CHF 2'000\.00/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reverse release' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Reverse the release?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reverse' }));
    const call = await waitFor(() => {
      const c = calls.find((x) => x.action === 'provision_release_reverse');
      expect(c).toBeDefined();
      return c as { input: Record<string, unknown> };
    });
    expect(call.input).toMatchObject({ workspaceId: 'ws_test', releaseId: 'rel_1' });
    expect(typeof call.input.idempotencyKey).toBe('string');
  });
});
